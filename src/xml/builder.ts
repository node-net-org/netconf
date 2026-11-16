import { XmlError } from '../errors.js';
import { XmlElement, type XmlAttribute, type XmlNode } from './element.js';

/** An attribute in a namespace, such as NETCONF's `nc:operation="delete"` on edit-config content. */
export interface QualifiedAttrValue {
  /** The attribute's namespace URI. */
  readonly ns: string;
  /** The value; numbers, bigints and booleans are written as text. */
  readonly value: string | number | bigint | boolean;
  /** Preferred prefix. A prefix is generated if omitted or unavailable. */
  readonly prefix?: string;
}

/**
 * An attribute value for {@link x}: text, a number or boolean written as text,
 * a {@link QualifiedAttrValue}, or `null`/`undefined` to omit the attribute.
 */
export type AttrValue = string | number | bigint | boolean | QualifiedAttrValue | null | undefined;

/**
 * Attributes for {@link x}. Special keys:
 * - `xmlns` sets the element's namespace (children inherit it unless they set their own).
 * - `xmlns:p` declares prefix `p`, for prefixes used inside values (YANG identityrefs, XPath filters).
 *
 * `null` and `undefined` values are omitted.
 */
export type Attrs = Readonly<Record<string, AttrValue>>;

/** Anything accepted as a child. `null`, `undefined` and booleans are skipped, so `cond && x(...)` works. */
export type Child = XmlNode | number | bigint | boolean | null | undefined | readonly Child[];

/**
 * XML element builder, hyperscript-style (like `h()` in Preact and Vue): the name, optional
 * attributes, then children. The one-letter name keeps nested request bodies readable;
 * import it under another name if you prefer, e.g. `import { x as xmlEl } from '@node-net/netconf'`.
 *
 * ```ts
 * const IF_NS = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
 * x('get-config', { xmlns: NETCONF_NS },
 *   x('source', x('running')),
 *   x('filter', { type: 'subtree' }, x('interfaces', { xmlns: IF_NS })))
 * ```
 *
 * Elements without an `xmlns` inherit the default namespace in scope when serialised.
 */
export function x(name: string, attrsOrChild?: Attrs | Child, ...children: Child[]): XmlElement {
  let attrs: Attrs | undefined;
  const kids: Child[] = [];
  if (isAttrs(attrsOrChild)) attrs = attrsOrChild;
  else kids.push(attrsOrChild);
  kids.push(...children);

  let ns: string | undefined;
  const declarations = new Map<string, string>();
  const attributes: XmlAttribute[] = [];

  if (attrs !== undefined) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined) continue;
      if (key === 'xmlns') {
        if (typeof value !== 'string') throw new XmlError('xmlns must be a string');
        ns = value;
        declarations.set('', value);
      } else if (key.startsWith('xmlns:')) {
        if (typeof value !== 'string') throw new XmlError(`${key} must be a string`);
        declarations.set(key.slice(6), value);
      } else if (typeof value === 'object') {
        attributes.push({
          name: key,
          ns: value.ns,
          value: String(value.value),
          ...(value.prefix !== undefined ? { prefix: value.prefix } : {}),
        });
      } else {
        attributes.push({ name: key, ns: undefined, value: String(value) });
      }
    }
  }

  const flat: XmlNode[] = [];
  flatten(kids, flat);

  return new XmlElement({ name, ns, attributes, children: flat, declarations });
}

function flatten(items: readonly Child[], out: XmlNode[]): void {
  for (const item of items) {
    if (item === null || item === undefined || typeof item === 'boolean') continue;
    if (typeof item === 'string') {
      if (item !== '') out.push(item);
    } else if (typeof item === 'number' || typeof item === 'bigint') {
      out.push(item.toString());
    } else if (item instanceof XmlElement) {
      out.push(item);
    } else {
      // Array.isArray() doesn't narrow readonly arrays, so this is the array case.
      flatten(item, out);
    }
  }
}

function isAttrs(value: unknown): value is Attrs {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof XmlElement) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
