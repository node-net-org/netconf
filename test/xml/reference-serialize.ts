// The serialiser as it was before namespace scopes were shared: a copy of the
// output scope per declaring element, and every element's whole inScope
// read. Kept as the reference its replacement must match byte for byte.

import { XmlError } from '../../src/errors.js';
import { escapeAttr, escapeText, findInvalidChar, isNcName } from '../../src/xml/chars.js';

/**
 * The shape of `XmlElement` the serialiser reads. Structural, so that
 * element.ts can import this module for `toString()` without a cycle.
 */
interface XmlElement {
  readonly name: string;
  readonly ns: string | undefined;
  readonly prefix: string | undefined;
  readonly attributes: readonly { readonly name: string; readonly ns: string | undefined; readonly prefix?: string; readonly value: string }[];
  readonly children: readonly (XmlElement | string)[];
  readonly declarations: ReadonlyMap<string, string>;
  readonly inScope?: ReadonlyMap<string, string>;
}

export const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export interface SerializeOptions {
  /** Prepend `<?xml version="1.0" encoding="UTF-8"?>`. Default `false`. */
  readonly declaration?: boolean;
  /**
   * Pretty-print: put each child element on its own line, indented by this
   * string (or this many spaces) per level. Default: no indentation, no line breaks.
   *
   * Only element content is reformatted. Whitespace-only text between child
   * elements is dropped; an element holding only text stays on one line with
   * its text unchanged; mixed content (text and elements together) is written
   * as it is, so no character data is ever altered.
   */
  readonly indent?: string | number;
}

type Scope = ReadonlyMap<string, string>;

const ROOT_SCOPE: Scope = new Map([
  ['', ''],
  ['xml', XML_NS],
]);

/**
 * Serialise an element tree to a string.
 *
 * Namespace declarations are generated as needed from each element's resolved
 * namespace, so the output is correct whatever prefixes the input used. Text
 * and attribute values are always escaped; the output can never contain the
 * RFC 6242 end-of-message delimiter.
 *
 * @throws XmlError for invalid names or characters XML cannot represent.
 */
export function referenceSerializeXml(element: XmlElement, options: SerializeOptions = {}): string {
  const out: string[] = [];
  if (options.declaration === true) out.push('<?xml version="1.0" encoding="UTF-8"?>');
  const indent = typeof options.indent === 'number' ? ' '.repeat(Math.max(0, options.indent)) : (options.indent ?? '');
  const pretty = indent === '' ? undefined : { indent, depth: 0 };
  if (out.length > 0 && pretty !== undefined) out.push('\n');
  writeElement(element, ROOT_SCOPE, out, pretty);
  return out.join('');
}

interface Pretty {
  readonly indent: string;
  readonly depth: number;
}

/** True when the children are elements separated only by whitespace, so line breaks can't change meaning. */
function isElementContent(children: XmlElement['children']): boolean {
  let hasElement = false;
  for (const c of children) {
    if (typeof c !== 'string') hasElement = true;
    else if (c.trim() !== '') return false;
  }
  return hasElement;
}

function writeElement(el: XmlElement, parentScope: Scope, out: string[], pretty?: Pretty): void {
  checkName(el.name, 'element');

  let scope = parentScope;
  let copied = false;
  const declared = new Map<string, string>();
  const declare = (prefix: string, uri: string): void => {
    if (!copied) {
      scope = new Map(scope);
      copied = true;
    }
    (scope as Map<string, string>).set(prefix, uri);
    declared.set(prefix, uri);
  };

  // The prefixes in scope where the element was parsed, then its own: a value
  // may use any of them (an identityref, an instance-identifier), so an
  // element written apart from its document, or moved into another, still
  // declares them. Inside its own document they are already in scope, so
  // nothing extra is written.
  for (const [prefix, uri] of el.inScope ?? el.declarations) {
    if (prefix === '' || prefix === 'xml' || uri === '') continue; // default handled below; prefixes can't be undeclared in XML 1.0
    checkPrefix(prefix);
    if (scope.get(prefix) !== uri) declare(prefix, uri);
  }

  const ns = el.ns ?? scope.get('') ?? '';
  let qname = el.name;
  if (el.prefix !== undefined && el.prefix !== '' && ns !== '') {
    checkPrefix(el.prefix);
    if (scope.get(el.prefix) !== ns) declare(el.prefix, ns);
    qname = `${el.prefix}:${el.name}`;
  } else if (scope.get('') !== ns) {
    declare('', ns);
  }

  const attrs: string[] = [];
  const seen = new Set<string>();
  for (const a of el.attributes) {
    checkName(a.name, 'attribute');
    const key = `${a.ns ?? ''}\u0000${a.name}`;
    if (seen.has(key)) throw new XmlError(`Duplicate attribute ${JSON.stringify(a.name)} on <${el.name}>`);
    seen.add(key);

    let aname = a.name;
    if (a.ns !== undefined && a.ns !== '') {
      const prefix = choosePrefix(a.ns, a.prefix, scope, declared);
      if (scope.get(prefix) !== a.ns) declare(prefix, a.ns);
      aname = `${prefix}:${a.name}`;
    }
    checkChars(a.value, `attribute ${a.name}`);
    attrs.push(` ${aname}="${escapeAttr(a.value)}"`);
  }

  out.push('<', qname);
  for (const [prefix, uri] of declared) {
    out.push(prefix === '' ? ` xmlns="${escapeAttr(uri)}"` : ` xmlns:${prefix}="${escapeAttr(uri)}"`);
  }
  out.push(...attrs);

  if (el.children.length === 0) {
    out.push('/>');
    return;
  }
  out.push('>');
  if (pretty !== undefined && isElementContent(el.children)) {
    const inner: Pretty = { indent: pretty.indent, depth: pretty.depth + 1 };
    const pad = pretty.indent.repeat(inner.depth);
    for (const child of el.children) {
      if (typeof child === 'string') continue;
      out.push('\n', pad);
      writeElement(child, scope, out, inner);
    }
    out.push('\n', pretty.indent.repeat(pretty.depth), '</', qname, '>');
    return;
  }
  for (const child of el.children) {
    if (typeof child === 'string') {
      checkChars(child, `text in <${el.name}>`);
      out.push(escapeText(child));
    } else {
      writeElement(child, scope, out);
    }
  }
  out.push('</', qname, '>');
}

function choosePrefix(ns: string, hint: string | undefined, scope: Scope, declaredHere: ReadonlyMap<string, string>): string {
  if (hint !== undefined && hint !== '' && hint !== 'xmlns') {
    checkPrefix(hint);
    const bound = scope.get(hint);
    if (bound === ns) return hint;
    // Re-binding the hint is fine unless this element already declared it differently.
    if (!declaredHere.has(hint)) return hint;
  }
  for (const [prefix, uri] of scope) {
    if (prefix !== '' && uri === ns) return prefix;
  }
  for (let i = 0; ; i++) {
    const candidate = `ns${i}`;
    if (!scope.has(candidate)) return candidate;
  }
}

function checkName(name: string, kind: string): void {
  if (!isNcName(name)) throw new XmlError(`Invalid XML ${kind} name ${JSON.stringify(name)}`);
}

function checkPrefix(prefix: string): void {
  if (!isNcName(prefix) || (prefix.toLowerCase().startsWith('xml') && prefix !== 'xml')) {
    throw new XmlError(`Invalid XML namespace prefix ${JSON.stringify(prefix)}`);
  }
}

function checkChars(text: string, where: string): void {
  const i = findInvalidChar(text);
  if (i !== -1) {
    const cp = text.codePointAt(i) ?? 0;
    throw new XmlError(`Character U+${cp.toString(16).toUpperCase().padStart(4, '0')} is not allowed in XML (${where})`);
  }
}
