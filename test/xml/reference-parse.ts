/**
 * The parser @node-net/netconf used before its own single-pass parser: @rgrove/parse-xml's
 * tree, then convert() to XmlElement. Kept, unchanged apart from the limits
 * (the pre-scan isn't part of what is compared), as the reference the
 * single-pass parser in src/xml/parse.ts is held to (parse-differential.test.ts).
 */
import {
  parseXml as parseDocument,
  XmlElement as RawElement,
  XmlText as RawText,
  type XmlNode as RawNode,
} from '@rgrove/parse-xml';
import { XmlError } from '../../src/errors.js';
import { FrozenMap } from '../../src/frozen-map.js';
import { isNcName } from '../../src/xml/chars.js';
import { XmlElement, type XmlAttribute, type XmlNode } from '../../src/xml/element.js';
import { XML_NS } from '../../src/xml/serialize.js';

const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

export function referenceParseXml(text: string, options: { readonly defaultNamespace?: string } = {}): XmlElement {
  if (/<!DOCTYPE/i.test(text)) throw new XmlError('DOCTYPE declarations are not allowed');

  let root: RawElement | null;
  try {
    root = parseDocument(text).root;
  } catch (err) {
    // Includes RangeError (stack overflow) from absurdly deep nesting.
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new XmlError(`Malformed XML: ${detail}`, { cause: err });
  }
  if (root === null) throw new XmlError('No root element');

  const scope =
    options.defaultNamespace === undefined || options.defaultNamespace === ''
      ? ROOT_SCOPE
      : new FrozenMap([...ROOT_SCOPE, ['', options.defaultNamespace]]);
  return convert(root, scope);
}

// Scopes are shared by every element that declares nothing new (its in-scope
// namespaces), so they are frozen.
const ROOT_SCOPE: ReadonlyMap<string, string> = new FrozenMap([
  ['', ''],
  ['xml', XML_NS],
]);

function convert(raw: RawElement, parentScope: ReadonlyMap<string, string>): XmlElement {
  // 1. Namespace declarations on this element. (The attributes object has a null prototype.)
  const attrEntries = Object.entries(raw.attributes);
  let scope = parentScope;
  const declarations = new Map<string, string>();
  for (const [name, uri] of attrEntries) {
    if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue;
    const prefix = name === 'xmlns' ? '' : name.slice(6);
    if (prefix !== '') {
      if (!isNcName(prefix)) throw new XmlError(`Invalid namespace prefix ${JSON.stringify(prefix)}`);
      if (uri === '') throw new XmlError(`Prefix ${JSON.stringify(prefix)} cannot be undeclared`);
      if (prefix === 'xmlns' || (prefix === 'xml') !== (uri === XML_NS)) {
        throw new XmlError(`Reserved namespace prefix or URI misused: xmlns:${prefix}="${uri}"`);
      }
    }
    if (uri === XMLNS_NS) throw new XmlError('The xmlns namespace URI cannot be declared');
    declarations.set(prefix, uri);
  }
  if (declarations.size > 0) {
    const s = new Map(parentScope);
    for (const [p, u] of declarations) s.set(p, u);
    scope = new FrozenMap(s);
  }

  // 2. The element's own name.
  const { prefix, local } = splitQName(raw.name);
  const ns = prefix === undefined ? (scope.get('') ?? '') : resolvePrefix(prefix, scope, raw.name);

  // 3. Attributes. Unprefixed attributes have no namespace (Namespaces in XML §6.2).
  const attributes: XmlAttribute[] = [];
  const seen = new Set<string>();
  for (const [name, value] of attrEntries) {
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    const q = splitQName(name);
    const ans = q.prefix === undefined ? undefined : resolvePrefix(q.prefix, scope, name);
    const key = `${ans ?? ''}\u0000${q.local}`;
    if (seen.has(key)) throw new XmlError(`Duplicate attribute ${JSON.stringify(name)} on <${raw.name}>`);
    seen.add(key);
    attributes.push({ name: q.local, ns: ans, value, ...(q.prefix !== undefined ? { prefix: q.prefix } : {}) });
  }

  // 4. Children. Adjacent text runs merge; comments and processing instructions
  //    are skipped. Whitespace-only text is dropped when the element also has
  //    element children.
  const children: XmlNode[] = [];
  let pending = '';
  let hasElements = false;
  const flush = (): void => {
    if (pending !== '') children.push(pending);
    pending = '';
  };
  for (const node of raw.children as readonly RawNode[]) {
    if (node instanceof RawElement) {
      flush();
      hasElements = true;
      children.push(convert(node, scope));
    } else if (node instanceof RawText) {
      pending += node.text; // XmlCdata extends XmlText
    }
  }
  flush();

  return new XmlElement({
    name: local,
    ns,
    ...(prefix !== undefined ? { prefix } : {}),
    attributes,
    children: hasElements ? children.filter((c) => typeof c !== 'string' || c.trim() !== '') : children,
    declarations,
    inScope: scope,
  });
}

function splitQName(qname: string): { prefix: string | undefined; local: string } {
  const i = qname.indexOf(':');
  const prefix = i === -1 ? undefined : qname.slice(0, i);
  const local = i === -1 ? qname : qname.slice(i + 1);
  if (!isNcName(local) || (prefix !== undefined && !isNcName(prefix))) {
    throw new XmlError(`Invalid qualified name ${JSON.stringify(qname)}`);
  }
  return { prefix, local };
}

function resolvePrefix(prefix: string, scope: ReadonlyMap<string, string>, qname: string): string {
  const uri = scope.get(prefix);
  if (uri === undefined || prefix === '') throw new XmlError(`Unbound namespace prefix in ${JSON.stringify(qname)}`);
  return uri;
}
