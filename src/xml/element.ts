/**
 * Namespace-aware, order-preserving XML element model (design §5.3).
 *
 * Elements are immutable. Namespaces are stored as resolved URIs, never as
 * prefixes, so navigation does not depend on which prefixes a server chose.
 */

import { FrozenMap, frozenMap } from '../frozen-map.js';
import { NamespaceScope } from './scope.js';
import { serializeXml } from './serialize.js';

/** A child node: an element or a run of character data. */
export type XmlNode = XmlElement | string;

/** An attribute of an {@link XmlElement}. */
export interface XmlAttribute {
  /** Local name, without prefix. */
  readonly name: string;
  /** Namespace URI, or `undefined` for an unqualified attribute (the usual case). */
  readonly ns: string | undefined;
  /** Preferred prefix when serialising a qualified attribute. Optional hint only. */
  readonly prefix?: string;
  /** The attribute value, unescaped. */
  readonly value: string;
}

/** What an {@link XmlElement} is built from. Usually `x()` builds it for you. */
export interface XmlElementInit {
  /** Local name, without prefix. */
  readonly name: string;
  /**
   * Namespace URI of the element.
   * - A string is the resolved namespace (`''` means "no namespace").
   * - `undefined` means "inherit the parent's default namespace"; only the builder produces it.
   */
  readonly ns?: string | undefined;
  /** Prefix used for this element when serialising. Parsed elements keep their original prefix. */
  readonly prefix?: string | undefined;
  /** The element's attributes, in order. Default: none. */
  readonly attributes?: readonly XmlAttribute[];
  /** Child elements and text, in document order. Default: none. */
  readonly children?: readonly XmlNode[];
  /**
   * Namespace declarations made on this element (prefix → URI; `''` is the default namespace).
   * Kept so that prefixes used inside values, such as YANG identityrefs
   * (`<type>ianaift:ethernetCsmacd</type>`), stay resolvable after a round trip.
   */
  readonly declarations?: ReadonlyMap<string, string>;
  /**
   * Every namespace declaration in scope at the element (prefix → URI; `''`
   * is the default namespace): its own and its ancestors', the nearest
   * winning, as XPath 1.0 §5.4 and the XML Infoset define them. The parser
   * sets it, so a prefix used inside a value resolves however the element
   * was reached. Default: the element's own `declarations`.
   */
  readonly inScope?: ReadonlyMap<string, string>;
}

// Shared by every element without declarations, so it must not be writable.
const EMPTY_MAP: ReadonlyMap<string, string> = new FrozenMap();

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** `scope`, with the element's own declarations winning (shared as is when it already agrees). */
function withOwn(scope: ReadonlyMap<string, string>, own: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  for (const [prefix, uri] of own) {
    if (scope.get(prefix) !== uri) return new FrozenMap([...NamespaceScope.entries(scope), ...own]);
  }
  return scope;
}

/** `util.inspect.custom`, without importing `node:util`. */
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * An immutable, namespace-aware XML element: what a read resolves with by
 * default, what `x()` and parseXml() build, and what an RPC sends. Names and
 * namespaces are resolved URIs, so navigation doesn't depend on the prefixes
 * the server chose. See [Output format](/guide/operations#output-format).
 */
export class XmlElement {
  /** Local name, without prefix. */
  readonly name: string;
  /**
   * Namespace URI (`''` for no namespace). `undefined` only on an element
   * built without one, which takes its parent's default namespace when
   * serialised.
   */
  readonly ns: string | undefined;
  /** The prefix the element had when parsed, or the one to prefer when serialising; a hint only. */
  readonly prefix: string | undefined;
  /** The element's attributes, in order. Namespace declarations aren't attributes; see `declarations`. */
  readonly attributes: readonly XmlAttribute[];
  /** Child elements and text, in document order. */
  readonly children: readonly XmlNode[];
  /** Namespace declarations made on this element itself (prefix → URI; `''` is the default namespace). */
  readonly declarations: ReadonlyMap<string, string>;
  /**
   * Every namespace declaration in scope at this element: its own and, for a
   * parsed element, its ancestors' where it was parsed, the nearest winning.
   * An element built with `x()` has only its own. Prefixes used inside values
   * (identityrefs, instance-identifiers, XPath) resolve against this, as
   * RFC 7950 §9.10.3 and §9.13.2 require, so they keep their meaning after
   * the element is taken out of its document.
   *
   * A parsed element's map shares its ancestors' entries rather than copying
   * them, so read it through its methods. Code that reads a Map's storage
   * without calling them (`structuredClone`, `postMessage`, a
   * `Map.prototype` method called on it) can see it empty; copy it first
   * with `new Map(el.inScope)`.
   */
  readonly inScope: ReadonlyMap<string, string>;

  constructor(init: XmlElementInit) {
    this.name = init.name;
    this.ns = init.ns;
    this.prefix = init.prefix;
    // A frozen array (of frozen attributes) can't change, so it is kept as is
    // rather than copied: the parser builds them that way.
    const attributes = init.attributes ?? [];
    this.attributes =
      Object.isFrozen(attributes) && attributes.every((a) => Object.isFrozen(a))
        ? attributes
        : Object.freeze(attributes.map((a) => (Object.isFrozen(a) ? a : Object.freeze({ ...a }))));
    const children = init.children ?? [];
    this.children = Object.isFrozen(children) ? children : Object.freeze([...children]);
    this.declarations = init.declarations === undefined || init.declarations.size === 0 ? EMPTY_MAP : frozenMap(init.declarations);
    this.inScope = init.inScope === undefined ? this.declarations : withOwn(frozenMap(init.inScope), this.declarations);
    Object.freeze(this);
  }

  /**
   * The namespace a prefix is bound to at this element (`''` for the default
   * namespace), or `undefined` if it isn't bound. The `xml` prefix is always
   * bound. Named after the DOM's `lookupNamespaceURI`.
   */
  lookupNamespace(prefix: string): string | undefined {
    return prefix === 'xml' ? XML_NS : this.inScope.get(prefix);
  }

  /** Child elements, in document order. */
  get elements(): XmlElement[] {
    return this.children.filter((c): c is XmlElement => typeof c !== 'string');
  }

  /**
   * First child element with this local name.
   * @param ns Namespace URI to match. Omit to match any namespace.
   */
  child(name: string, ns?: string): XmlElement | undefined {
    for (const c of this.children) {
      if (typeof c !== 'string' && c.name === name && (ns === undefined || c.ns === ns)) return c;
    }
    return undefined;
  }

  /**
   * All child elements with this local name, in document order.
   * @param ns Namespace URI to match. Omit to match any namespace.
   */
  childrenNamed(name: string, ns?: string): XmlElement[] {
    return this.elements.filter((c) => c.name === name && (ns === undefined || c.ns === ns));
  }

  /**
   * Follow a `/`-separated path of local names, taking the first match at each step.
   * @param ns If given, every step must be in this namespace.
   */
  path(path: string, ns?: string): XmlElement | undefined {
    return path
      .split('/')
      .filter((step) => step !== '')
      .reduce<XmlElement | undefined>((el, step) => el?.child(step, ns), this);
  }

  /**
   * Attribute value.
   * @param ns Namespace of a qualified attribute. Omit for an unqualified attribute.
   */
  attr(name: string, ns?: string): string | undefined {
    return this.attributes.find((a) => a.name === name && a.ns === ns)?.value;
  }

  /** Concatenated character data of the direct children only. */
  text(): string {
    let out = '';
    for (const c of this.children) if (typeof c === 'string') out += c;
    return out;
  }

  /** Concatenated character data of all descendants, in document order. */
  textContent(): string {
    let out = '';
    for (const c of this.children) out += typeof c === 'string' ? c : c.textContent();
    return out;
  }

  /** The element as compact XML, the same as `serializeXml(this)`. */
  toString(): string {
    return serializeXml(this);
  }

  /**
   * How Node's `console.log` and `util.inspect` show the element: indented XML.
   * An element that can't be serialised (an invalid name or character) shows
   * its name and the reason instead of throwing.
   */
  [INSPECT](): string {
    try {
      return serializeXml(this, { indent: 2 });
    } catch (err) {
      return `XmlElement <${this.name}> (not serialisable: ${err instanceof Error ? err.message : String(err)})`;
    }
  }
}
