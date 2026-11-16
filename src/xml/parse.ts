import { XmlError } from '../errors.js';
import { FrozenMap } from '../frozen-map.js';
import { findInvalidChar, isNcName } from './chars.js';
import { XmlElement, type XmlAttribute, type XmlNode } from './element.js';
import { NamespaceScope } from './scope.js';
import { XML_NS } from './serialize.js';

/**
 * Limits on a parsed document, checked in one linear pass over the text before
 * any of its tree is built. A document over a limit is rejected with an
 * `XmlError` at the cost of reading its text, so the limits bound the memory a
 * hostile or broken peer can make a parse use.
 */
export interface XmlParseLimits {
  /** Maximum element nesting depth. Default 256; at most {@link MAX_PARSE_DEPTH}. */
  readonly maxDepth?: number;
  /**
   * Maximum number of nodes: elements, attributes (namespace declarations
   * included), text runs, comments, processing instructions and CDATA
   * sections. Default 1,000,000.
   *
   * Parsing builds the element tree in one pass, and costs roughly 0.1–0.3 KB
   * of heap per node at its peak (about 7–8 times the size of a large reply's
   * text): up to about 300 MB at the default, or about 330 MB for the worst
   * shape, where every element declares a namespace. A declaration costs the
   * same however many others are in scope. Raise it for very large replies
   * only with the heap to match.
   */
  readonly maxNodes?: number;
}

/** Options for {@link parseXml}: the parse limits, and the namespace context of a fragment. */
export interface XmlParseOptions extends XmlParseLimits {
  /**
   * Default namespace in scope at the root, as if the document were nested in
   * an element declaring it. Default `''` (no namespace).
   */
  readonly defaultNamespace?: string;
}

/** The {@link XmlParseLimits} used when none are given. */
export const DEFAULT_PARSE_LIMITS = {
  /** Maximum element nesting depth: 256. */
  maxDepth: 256,
  /** Maximum number of nodes: 1,000,000. */
  maxNodes: 1_000_000,
} as const;

/** Hard ceiling on maxDepth. */
export const MAX_PARSE_DEPTH = 1024;

const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

/**
 * Parse a complete XML document into an {@link XmlElement}.
 *
 * The text is read once, straight into the element tree. Well-formedness is
 * enforced: a single root, no content outside it, only the predefined
 * entities, and only character references to legal XML characters. XML
 * end-of-line handling and attribute-value normalisation are applied. On top
 * of that (design §5.3):
 * - Any DOCTYPE is rejected, which rules out XXE and entity-expansion attacks.
 * - Namespace prefixes are resolved to URIs; unbound prefixes are errors.
 * - Depth and node-count limits ({@link XmlParseLimits}) are checked before
 *   the document is parsed, so an over-limit document never allocates a tree.
 *
 * @throws XmlError
 */
export function parseXml(text: string, options: XmlParseOptions = {}): XmlElement {
  if (/<!DOCTYPE/i.test(text)) throw new XmlError('DOCTYPE declarations are not allowed');
  const maxDepth = Math.min(limit(options.maxDepth, DEFAULT_PARSE_LIMITS.maxDepth), MAX_PARSE_DEPTH);
  checkLimits(text, maxDepth, limit(options.maxNodes, DEFAULT_PARSE_LIMITS.maxNodes));

  const scope =
    options.defaultNamespace === undefined || options.defaultNamespace === ''
      ? ROOT_SCOPE
      : new NamespaceScope(undefined, new FrozenMap([...ROOT_SCOPE, ['', options.defaultNamespace]]));
  return new Parser(text, maxDepth).parse(scope);
}

/** A limit as given, or its default; NaN refuses everything rather than switching the limit off. */
function limit(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Number.isNaN(value) ? 0 : value;
}

const LT = 0x3c; // <
const GT = 0x3e; // >
const SLASH = 0x2f;
const QUESTION = 0x3f;
const BANG = 0x21;
const EQUALS = 0x3d;
const QUOT = 0x22;
const APOS = 0x27;

/**
 * Count nodes and track depth in one linear pass over the text, recognising
 * markup only, and throw as soon as a limit is passed. This runs before the
 * parser, which builds its whole tree before anything can be counted: an 8 MB
 * string of `<a/>` exhausted a 512 MB heap before the old count ran
 *.
 *
 * It counts each element, attribute, text run inside the root, comment,
 * processing instruction and CDATA section, so its count is never less than
 * the nodes the parser and convert() build. It is not a validator: on
 * well-formed text it agrees with the parser about where markup is, and the
 * parser rejects malformed text having built no more than was counted.
 */
function checkLimits(text: string, maxDepth: number, maxNodes: number): void {
  const end = text.length;
  let nodes = 0;
  let depth = 0;
  let pos = 0;
  const count = (): void => {
    if (++nodes > maxNodes) throw new XmlError(`Document exceeds maxNodes (${maxNodes})`);
  };
  /** Index after the first `close` at or after `from`, or the end of the text. */
  const past = (close: string, from: number): number => {
    const i = text.indexOf(close, from);
    return i === -1 ? end : i + close.length;
  };

  while (pos < end) {
    const lt = text.indexOf('<', pos);
    if (lt === -1) break; // trailing text is outside the root, which the parser rejects
    if (lt > pos && depth > 0) count(); // a text run
    const c = text.charCodeAt(lt + 1);
    if (c === SLASH) {
      depth--;
      pos = past('>', lt + 2);
    } else if (c === QUESTION) {
      // The XML declaration is not a node; any other processing instruction is.
      if (!(lt === 0 && /^<\?xml[\s?]/.test(text.slice(0, 6)))) count();
      pos = past('?>', lt + 2);
    } else if (c === BANG) {
      count();
      if (text.startsWith('!--', lt + 1)) pos = past('-->', lt + 4);
      else if (text.startsWith('![CDATA[', lt + 1)) pos = past(']]>', lt + 9);
      else pos = lt + 2; // not well-formed: the parser rejects it
    } else {
      // A start tag or empty-element tag: find its '>', skipping quoted
      // attribute values (which may contain '>'), and count its attributes.
      count();
      if (++depth > maxDepth) throw new XmlError(`Element nesting exceeds maxDepth (${maxDepth})`);
      let i = lt + 1;
      for (;;) {
        if (i >= end) {
          pos = end;
          break;
        }
        const ch = text.charCodeAt(i);
        if (ch === GT) {
          if (text.charCodeAt(i - 1) === SLASH) depth--; // <a/>
          pos = i + 1;
          break;
        }
        if (ch === QUOT || ch === APOS) {
          const close = text.indexOf(ch === QUOT ? '"' : "'", i + 1);
          i = close === -1 ? end : close + 1;
        } else {
          if (ch === EQUALS) count();
          else if (ch === LT) {
            // Not well-formed; rescan from here so this '<' is still counted.
            pos = i;
            break;
          }
          i++;
        }
      }
    }
  }
}

// --- the parser ---------------------------------------------------------------------------------
//
// One pass over the text, building the frozen XmlElement tree directly
// (there used to be a second, raw tree from @rgrove/parse-xml,
// which set the memory peak at about 20× the text). It accepts exactly the
// documents @rgrove/parse-xml 5.2 accepts, and builds exactly the tree the old
// conversion built from them; test/xml/parse-differential.test.ts holds it to
// that, with the old path as the reference. Its rules (XML 1.0 and Namespaces
// in XML 1.0):
// - An optional BOM, then an optional XML declaration, only at the very start.
// - Comments, processing instructions and whitespace around the root element.
// - Character data may not contain `]]>`. References are the five predefined
//   entities and character references to XML characters; nothing else.
// - End of line: CRLF and CR become LF in text, CDATA and attribute values (in
//   attribute values, then each of CR, LF and TAB becomes a space). Text that
//   came from a reference is never normalised.
// - Namespaces: declarations are checked and applied as each element opens;
//   an unbound prefix, or two attributes that resolve to the same name, are
//   errors.
// - Adjacent text, CDATA and references merge into one string; comments and
//   processing instructions are skipped. Whitespace-only text is dropped from
//   an element that also has element children.
// Recursion-free, so nesting costs heap, not stack.

// Scopes (an element's in-scope namespaces) are shared by every element that
// declares nothing new, so they are frozen. Each declaring element's scope
// links to its parent's (scope.ts), so declarations cost memory once each.
const ROOT_SCOPE = new NamespaceScope(
  undefined,
  new FrozenMap([
    ['', ''],
    ['xml', XML_NS],
  ]),
);

const EMPTY_DECLARATIONS: ReadonlyMap<string, string> = new FrozenMap();
const NO_ATTRIBUTES: readonly XmlAttribute[] = Object.freeze([]);
const NO_CHILDREN: readonly XmlNode[] = Object.freeze([]);

const AMP = 0x26;
const HASH = 0x23;
const SEMI = 0x3b;

const ENTITIES: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' }),
);

interface QName {
  readonly prefix: string | undefined;
  readonly local: string;
}

/** An element whose end tag hasn't been reached yet. */
interface Open {
  readonly rawName: string;
  readonly qname: QName;
  readonly ns: string;
  readonly attributes: readonly XmlAttribute[];
  readonly declarations: ReadonlyMap<string, string>;
  readonly scope: NamespaceScope;
  /** Length of the parser's undo log before this element bound its prefixes. */
  readonly undoFrom: number;
  children: XmlNode[] | undefined;
  /** Text since the last child element. */
  text: string;
  hasElements: boolean;
}

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d;
}

/** XML 1.0 NameStartChar, by code point. */
function isNameStart(cp: number): boolean {
  return (
    (cp >= 0x61 && cp <= 0x7a) ||
    (cp >= 0x41 && cp <= 0x5a) ||
    cp === 0x3a ||
    cp === 0x5f ||
    (cp >= 0xc0 && cp <= 0xd6) ||
    (cp >= 0xd8 && cp <= 0xf6) ||
    (cp >= 0xf8 && cp <= 0x2ff) ||
    (cp >= 0x370 && cp <= 0x37d) ||
    (cp >= 0x37f && cp <= 0x1fff) ||
    cp === 0x200c ||
    cp === 0x200d ||
    (cp >= 0x2070 && cp <= 0x218f) ||
    (cp >= 0x2c00 && cp <= 0x2fef) ||
    (cp >= 0x3001 && cp <= 0xd7ff) ||
    (cp >= 0xf900 && cp <= 0xfdcf) ||
    (cp >= 0xfdf0 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0xeffff)
  );
}

/** XML 1.0 NameChar, by code point. */
function isNameChar(cp: number): boolean {
  return (
    (cp >= 0x61 && cp <= 0x7a) ||
    (cp >= 0x41 && cp <= 0x5a) ||
    (cp >= 0x30 && cp <= 0x39) ||
    cp === 0x2d ||
    cp === 0x2e ||
    cp === 0xb7 ||
    (cp >= 0x300 && cp <= 0x36f) ||
    cp === 0x203f ||
    cp === 0x2040 ||
    isNameStart(cp)
  );
}

function isXmlCodePoint(cp: number): boolean {
  return (
    (cp >= 0x20 && cp <= 0xd7ff) ||
    cp === 0x0a ||
    cp === 0x09 ||
    cp === 0x0d ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

function normalizeEol(s: string): string {
  return s.includes('\r') ? s.replace(/\r\n?/g, '\n') : s;
}

class Parser {
  private pos = 0;
  private readonly end: number;
  /** Next `<`, `&` and `]]>` at or after `pos` (or `end`), found lazily, so finding text runs is linear. */
  private nextLt = -1;
  private nextAmp = -1;
  private nextCdataEnd = -1;
  /** Each distinct qualified name, split and checked once. */
  private readonly qnames = new Map<string, QName>();
  /**
   * The namespaces in scope at the element being read, prefix → URI, updated
   * as elements open and close, so resolving a prefix doesn't walk a scope
   * chain. Prefixes are only ever removed in the reverse of the order they
   * were added, so a prefix's index here is its place in a full iteration of
   * the current scope; `order` keeps that index.
   */
  private readonly bound = new Map<string, string>();
  private readonly order = new Map<string, number>();
  /** Each prefix an open element bound, and what it was bound to before (undefined: nothing). */
  private readonly undoPrefix: string[] = [];
  private readonly undoBefore: (string | undefined)[] = [];

  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
  ) {
    this.end = text.length;
  }

  parse(rootScope: NamespaceScope): XmlElement {
    for (const [prefix, uri] of rootScope) {
      this.order.set(prefix, this.bound.size);
      this.bound.set(prefix, uri);
    }
    const t = this.text;
    // Every character must be one XML allows, wherever it is: outside
    // character data a disallowed one is never well-formed either.
    const bad = findInvalidChar(t);
    if (bad !== -1) {
      this.pos = bad;
      throw this.fail('Invalid character');
    }
    if (t.charCodeAt(0) === 0xfeff) this.pos = 1;
    if (t.startsWith('<?xml', this.pos) && !isNameChar(this.cpAt(this.pos + 5))) this.xmlDeclaration();
    this.misc();
    if (t.charCodeAt(this.pos) !== LT || !isNameStart(this.cpAt(this.pos + 1))) throw this.fail('Root element is missing or invalid');
    const root = this.element(rootScope);
    this.misc();
    if (this.pos < this.end) throw this.fail('Extra content at the end of the document');
    return root;
  }

  /** The code point at `i`, or -1 past the end. */
  private cpAt(i: number): number {
    return i < this.end ? this.text.codePointAt(i)! : -1;
  }

  /** Index after the name starting at `i`, or `i` if there is none. */
  private nameEnd(i: number): number {
    let cp = this.cpAt(i);
    if (!isNameStart(cp)) return i;
    do {
      i += cp > 0xffff ? 2 : 1;
      cp = this.cpAt(i);
    } while (isNameChar(cp));
    return i;
  }

  private skipWs(i: number): number {
    while (i < this.end && isWs(this.text.charCodeAt(i))) i++;
    return i;
  }

  private fail(message: string): XmlError {
    let line = 1;
    let lineStart = 0;
    for (let i = this.text.indexOf('\n'); i !== -1 && i < this.pos; i = this.text.indexOf('\n', i + 1)) {
      line++;
      lineStart = i + 1;
    }
    return new XmlError(`Malformed XML: ${message} (line ${line}, column ${this.pos - lineStart + 1})`);
  }

  /** The XML declaration, `pos` at its `<?xml`. Checked, then ignored. */
  private xmlDeclaration(): void {
    const t = this.text;
    let p = this.pos + 5;
    const ws = this.skipWs(p);
    if (ws === p) throw this.failAt(p, 'Invalid XML declaration');
    p = ws;
    if (!t.startsWith('version', p)) throw this.failAt(p, 'XML version is missing or invalid');
    const [version, afterVersion] = this.literal(this.eq(p + 7), 'XML version is missing or invalid');
    p = afterVersion;
    if (!/^1\.[0-9]+$/.test(version)) throw this.failAt(p, 'Invalid character in version number');
    let q = this.skipWs(p);
    if (q > p && t.startsWith('encoding', q)) {
      const [encoding, afterEncoding] = this.literal(this.eq(q + 8), 'Invalid or unclosed XML declaration');
      p = afterEncoding;
      if (!/^[A-Za-z][\w.-]*$/.test(encoding)) throw this.failAt(p, 'Invalid character in encoding name');
      q = this.skipWs(p);
    }
    if (q > p && t.startsWith('standalone', q)) {
      const [standalone, afterStandalone] = this.literal(this.eq(q + 10), 'Invalid or unclosed XML declaration');
      p = afterStandalone;
      if (standalone !== 'yes' && standalone !== 'no') throw this.failAt(p, 'Only "yes" and "no" are permitted as values of `standalone`');
      q = this.skipWs(p);
    }
    if (!t.startsWith('?>', q)) throw this.failAt(q, 'Invalid or unclosed XML declaration');
    this.pos = q + 2;
  }

  /** After optional whitespace, `=` and optional whitespace; -1 if there's no `=`. */
  private eq(p: number): number {
    p = this.skipWs(p);
    return this.text.charCodeAt(p) === EQUALS ? this.skipWs(p + 1) : -1;
  }

  /** A quoted literal at `p` (no references): its content and the index after it. */
  private literal(p: number, message: string): [string, number] {
    const q = p === -1 ? -1 : this.text.charCodeAt(p);
    if (q !== QUOT && q !== APOS) throw this.failAt(p === -1 ? this.pos : p, message);
    const close = this.text.indexOf(q === QUOT ? '"' : "'", p + 1);
    if (close === -1) throw this.failAt(p, 'Missing end quote');
    return [this.text.slice(p + 1, close), close + 1];
  }

  private failAt(p: number, message: string): XmlError {
    this.pos = p;
    return this.fail(message);
  }

  /** Comments, processing instructions and whitespace, outside the root. */
  private misc(): void {
    const t = this.text;
    for (;;) {
      this.pos = this.skipWs(this.pos);
      if (t.startsWith('<!--', this.pos)) this.comment();
      else if (t.startsWith('<?', this.pos)) this.processingInstruction();
      else return;
    }
  }

  /** `pos` at `<!--`. Its content ends at the first `--`, which must be `-->`. */
  private comment(): void {
    const close = this.text.indexOf('--', this.pos + 4);
    if (close === -1) throw this.fail('Unclosed comment');
    if (this.text.charCodeAt(close + 2) !== GT) throw this.failAt(close, "The string `--` isn't allowed inside a comment");
    this.pos = close + 3;
  }

  /** `pos` at `<?`. */
  private processingInstruction(): void {
    const t = this.text;
    const start = this.pos + 2;
    const nameEnd = this.nameEnd(start);
    if (nameEnd === start) throw this.failAt(start, 'Invalid processing instruction');
    if (t.slice(start, nameEnd).toLowerCase() === 'xml') throw this.fail("XML declaration isn't allowed here");
    const ws = this.skipWs(nameEnd);
    if (ws === nameEnd) {
      if (!t.startsWith('?>', nameEnd)) throw this.failAt(nameEnd, 'Whitespace is required after a processing instruction name');
      this.pos = nameEnd + 2;
      return;
    }
    const close = t.indexOf('?>', ws);
    if (close === -1) throw this.failAt(ws, 'Unterminated processing instruction');
    this.pos = close + 2;
  }

  /** A reference at `p` (its `&`): the text it stands for, and the index after it. */
  private reference(p: number): [string, number] {
    const t = this.text;
    let i = p + 1;
    for (let cp = this.cpAt(i); cp === HASH || isNameChar(cp); cp = this.cpAt(i)) i += cp > 0xffff ? 2 : 1;
    if (t.charCodeAt(i) !== SEMI) throw this.failAt(i, 'Unterminated reference (a reference must end with `;`)');
    const ref = t.slice(p + 1, i);
    if (ref.charCodeAt(0) === HASH) {
      if (!/^#(?:x[0-9A-Fa-f]+|[0-9]+)$/.test(ref)) throw this.failAt(i + 1, 'Invalid character reference');
      const cp = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!isXmlCodePoint(cp)) throw this.failAt(i + 1, 'Character reference resolves to an invalid character');
      return [String.fromCodePoint(cp), i + 1];
    }
    const value = ENTITIES[ref];
    if (value === undefined) throw this.failAt(p, `Named entity isn't defined: &${ref};`);
    return [value, i + 1];
  }

  /** A quoted attribute value at `p`: its normalised value, and the index after it. */
  private attributeValue(p: number): [string, number] {
    const t = this.text;
    const quote = t.charCodeAt(p);
    if (quote !== QUOT && quote !== APOS) throw this.failAt(p, 'Attribute value expected');
    let value = '';
    let i = p + 1;
    for (;;) {
      const from = i;
      let c = t.charCodeAt(i);
      while (i < this.end && c !== quote && c !== AMP && c !== LT) c = t.charCodeAt(++i);
      if (i > from) {
        const run = t.slice(from, i);
        value += /[\t\n\r]/.test(run) ? run.replace(/\r\n|[\n\r\t]/g, ' ') : run;
      }
      if (i >= this.end) throw this.failAt(i, 'Unclosed attribute');
      if (c === quote) return [value, i + 1];
      if (c === LT) throw this.failAt(i, 'Unescaped `<` is not allowed in an attribute value');
      let replacement: string;
      [replacement, i] = this.reference(i);
      value += replacement;
    }
  }

  /** A qualified name, split and checked (once per distinct name). */
  private qname(raw: string): QName {
    let q = this.qnames.get(raw);
    if (q === undefined) {
      const i = raw.indexOf(':');
      const prefix = i === -1 ? undefined : raw.slice(0, i);
      const local = i === -1 ? raw : raw.slice(i + 1);
      if (!isNcName(local) || (prefix !== undefined && !isNcName(prefix))) {
        throw new XmlError(`Invalid qualified name ${JSON.stringify(raw)}`);
      }
      q = { prefix, local };
      this.qnames.set(raw, q);
    }
    return q;
  }

  /**
   * A start tag at `pos` (its `<`, followed by a name), and its namespaces:
   * the element as opened, with `pos` after the tag. `empty` says whether it
   * was an empty-element tag.
   */
  private startTag(parentScope: NamespaceScope): { open: Open; empty: boolean } {
    const t = this.text;
    const nameStart = this.pos + 1;
    const nameEnd = this.nameEnd(nameStart);
    const rawName = t.slice(nameStart, nameEnd);

    // Attributes as written: whitespace before each one, no duplicate names.
    let raw: [string, string][] | undefined;
    let rawNames: Set<string> | undefined; // once there are many
    let p = nameEnd;
    for (;;) {
      const ws = this.skipWs(p);
      if (ws === p) break;
      p = ws;
      const aEnd = this.nameEnd(p);
      if (aEnd === p) break;
      const aName = t.slice(p, aEnd);
      const v = this.eq(aEnd);
      if (v === -1) throw this.failAt(aEnd, 'Attribute value expected');
      let value: string;
      [value, p] = this.attributeValue(v);
      raw ??= [];
      if (rawNames !== undefined ? rawNames.has(aName) : raw.some((a) => a[0] === aName)) {
        throw this.failAt(aEnd, `Duplicate attribute: ${aName}`);
      }
      if (aName === 'xml:space' && value !== 'default' && value !== 'preserve') {
        throw this.failAt(p, 'Value of the `xml:space` attribute must be "default" or "preserve"');
      }
      raw.push([aName, value]);
      if (rawNames !== undefined) rawNames.add(aName);
      else if (raw.length === 16) rawNames = new Set(raw.map((a) => a[0]));
    }
    let empty = false;
    if (t.startsWith('/>', p)) {
      empty = true;
      p += 2;
    } else if (t.charCodeAt(p) === GT) {
      p++;
    } else {
      throw this.failAt(p, `Unclosed start tag for element \`${rawName}\``);
    }
    this.pos = p;

    // 1. Namespace declarations on this element.
    let scope = parentScope;
    let declarations = EMPTY_DECLARATIONS;
    const bound = this.bound;
    const undoFrom = this.undoPrefix.length;
    let others = 0;
    if (raw !== undefined) {
      // Each prefix at most once: a repeated xmlns attribute is a duplicate attribute.
      let own: [string, string][] | undefined;
      for (const [name, uri] of raw) {
        if (name !== 'xmlns' && !name.startsWith('xmlns:')) {
          others++;
          continue;
        }
        const prefix = name === 'xmlns' ? '' : name.slice(6);
        if (prefix !== '') {
          if (!isNcName(prefix)) throw new XmlError(`Invalid namespace prefix ${JSON.stringify(prefix)}`);
          if (uri === '') throw new XmlError(`Prefix ${JSON.stringify(prefix)} cannot be undeclared`);
          if (prefix === 'xmlns' || (prefix === 'xml') !== (uri === XML_NS)) {
            throw new XmlError(`Reserved namespace prefix or URI misused: xmlns:${prefix}="${uri}"`);
          }
        }
        if (uri === XMLNS_NS) throw new XmlError('The xmlns namespace URI cannot be declared');
        (own ??= []).push([prefix, uri]);
      }
      if (own !== undefined) {
        declarations = new FrozenMap(own);
        scope = new NamespaceScope(parentScope, this.fullOrder(declarations));
        for (const [prefix, uri] of own) {
          const before = bound.get(prefix);
          this.undoPrefix.push(prefix);
          this.undoBefore.push(before);
          if (before === undefined) this.order.set(prefix, bound.size);
          bound.set(prefix, uri);
        }
      }
    }

    // 2. The element's own name.
    const qname = this.qname(rawName);
    const ns = qname.prefix === undefined ? (bound.get('') ?? '') : resolvePrefix(qname.prefix, bound, rawName);

    // 3. Attributes. Unprefixed attributes have no namespace (Namespaces in XML §6.2).
    let attributes = NO_ATTRIBUTES;
    if (others > 0) {
      const list: XmlAttribute[] = [];
      // Keyed by a small id per namespace rather than the URI itself, so a
      // long URI shared by many attributes isn't copied into every key.
      const seen = others > 1 ? new Set<string>() : undefined;
      const nsIds = new Map<string | undefined, number>();
      for (const [name, value] of raw!) {
        if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
        const q = this.qname(name);
        const ans = q.prefix === undefined ? undefined : resolvePrefix(q.prefix, bound, name);
        if (seen !== undefined) {
          let id = nsIds.get(ans);
          if (id === undefined) nsIds.set(ans, (id = nsIds.size));
          const key = `${id}\u0000${q.local}`;
          if (seen.has(key)) throw new XmlError(`Duplicate attribute ${JSON.stringify(name)} on <${rawName}>`);
          seen.add(key);
        }
        list.push(Object.freeze(q.prefix !== undefined ? { name: q.local, ns: ans, value, prefix: q.prefix } : { name: q.local, ns: ans, value }));
      }
      attributes = Object.freeze(list.length === 1 ? [list[0]!] : list.slice());
    }

    return {
      open: { rawName, qname, ns, attributes, declarations, scope, undoFrom, children: undefined, text: '', hasElements: false },
      empty,
    };
  }

  /**
   * An element's own declarations (in document order) in the order a full
   * iteration of its scope yields them: prefixes already bound first, in
   * their current order, then new ones in document order. `declarations`
   * itself when that order is the same.
   */
  private fullOrder(declarations: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
    let rebound: [string, number][] | undefined;
    let sorted = true;
    let seenNew = false;
    for (const prefix of declarations.keys()) {
      const at = this.order.get(prefix);
      if (at === undefined) {
        seenNew = true;
        continue;
      }
      if (seenNew || (rebound !== undefined && rebound[rebound.length - 1]![1] > at)) sorted = false;
      (rebound ??= []).push([prefix, at]);
    }
    if (sorted) return declarations;
    rebound!.sort((a, b) => a[1] - b[1]);
    const ordered: [string, string][] = rebound!.map(([prefix]) => [prefix, declarations.get(prefix)!]);
    for (const [prefix, uri] of declarations) if (!this.order.has(prefix)) ordered.push([prefix, uri]);
    return new FrozenMap(ordered);
  }

  private close(open: Open): XmlElement {
    while (this.undoPrefix.length > open.undoFrom) {
      const prefix = this.undoPrefix.pop()!;
      const before = this.undoBefore.pop();
      if (before === undefined) {
        this.bound.delete(prefix);
        this.order.delete(prefix);
      } else {
        this.bound.set(prefix, before);
      }
    }
    let children: readonly XmlNode[] = NO_CHILDREN;
    let list = open.children;
    if (open.text !== '') (list ??= []).push(open.text);
    if (list !== undefined) {
      if (open.hasElements) list = list.filter((c) => typeof c !== 'string' || c.trim() !== '');
      // Copied at its exact size: an array grown by push() keeps spare
      // capacity, which across millions of elements outweighs the copy.
      if (list.length > 0) children = Object.freeze(list.length === 1 ? [list[0]!] : list.slice());
    }
    return new XmlElement({
      name: open.qname.local,
      ns: open.ns,
      prefix: open.qname.prefix,
      attributes: open.attributes,
      children,
      declarations: open.declarations,
      inScope: open.scope,
    });
  }

  /** The element whose start tag is at `pos`, through its end tag. */
  private element(rootScope: NamespaceScope): XmlElement {
    const t = this.text;
    const stack: Open[] = [];
    const first = this.startTag(rootScope);
    let current = first.open;
    if (first.empty) return this.close(current);

    for (;;) {
      // Character data up to the next markup or reference.
      const p = this.pos;
      if (this.nextLt < p) this.nextLt = indexOrEnd(t, '<', p);
      if (this.nextAmp < p) this.nextAmp = indexOrEnd(t, '&', p);
      const stop = Math.min(this.nextLt, this.nextAmp);
      if (stop > p) {
        if (this.nextCdataEnd < p) this.nextCdataEnd = indexOrEnd(t, ']]>', p);
        if (this.nextCdataEnd < stop) throw this.failAt(this.nextCdataEnd, 'Element content may not contain the CDATA section close delimiter `]]>`');
        current.text += normalizeEol(t.slice(p, stop));
        this.pos = stop;
      }
      if (stop >= this.end) throw this.fail(`Missing end tag for element ${current.rawName}`);

      if (t.charCodeAt(stop) === AMP) {
        let replacement: string;
        [replacement, this.pos] = this.reference(stop);
        current.text += replacement;
        continue;
      }

      const c = t.charCodeAt(stop + 1);
      if (c === SLASH) {
        // An end tag: it must close the current element.
        const nameEnd = this.nameEnd(stop + 2);
        if (nameEnd - (stop + 2) !== current.rawName.length || !t.startsWith(current.rawName, stop + 2)) {
          throw this.fail(`Missing end tag for element ${current.rawName}`);
        }
        const gt = this.skipWs(nameEnd);
        if (t.charCodeAt(gt) !== GT) throw this.failAt(gt, `Unclosed end tag for element ${current.rawName}`);
        this.pos = gt + 1;
        const done = this.close(current);
        const parent = stack.pop();
        if (parent === undefined) return done;
        this.append(parent, done);
        current = parent;
      } else if (c === BANG) {
        if (t.startsWith('<!--', stop)) {
          this.comment();
        } else if (t.startsWith('<![CDATA[', stop)) {
          const close = t.indexOf(']]>', stop + 9);
          if (close === -1) throw this.failAt(stop + 9, 'Unclosed CDATA section');
          current.text += normalizeEol(t.slice(stop + 9, close));
          this.pos = close + 3;
        } else {
          throw this.fail(`Missing end tag for element ${current.rawName}`);
        }
      } else if (c === QUESTION) {
        this.processingInstruction();
      } else if (isNameStart(this.cpAt(stop + 1))) {
        if (stack.length + 2 > this.maxDepth) throw new XmlError(`Element nesting exceeds maxDepth (${this.maxDepth})`);
        const next = this.startTag(current.scope);
        if (next.empty) {
          this.append(current, this.close(next.open));
        } else {
          stack.push(current);
          current = next.open;
        }
      } else {
        throw this.fail(`Missing end tag for element ${current.rawName}`);
      }
    }
  }

  private append(parent: Open, child: XmlElement): void {
    const list = (parent.children ??= []);
    if (parent.text !== '') {
      list.push(parent.text);
      parent.text = '';
    }
    list.push(child);
    parent.hasElements = true;
  }
}

function indexOrEnd(text: string, s: string, from: number): number {
  const i = text.indexOf(s, from);
  return i === -1 ? text.length : i;
}

function resolvePrefix(prefix: string, scope: ReadonlyMap<string, string>, qname: string): string {
  const uri = scope.get(prefix);
  if (uri === undefined || prefix === '') throw new XmlError(`Unbound namespace prefix in ${JSON.stringify(qname)}`);
  return uri;
}
