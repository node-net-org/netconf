import type { XmlElement } from './element.js';

/** What toObject() makes of an element: its text, an object of its children, or an array for a repeated name. */
export type XmlValue = string | XmlObject | XmlValue[];
/** An element's children from toObject(), keyed by local name. */
export interface XmlObject {
  [key: string]: XmlValue;
}

/** Options for toObject(). */
export interface ToObjectOptions {
  /**
   * - `'auto'` (default): a key holds an array only when the element name repeats.
   * - `'always'`: every child key holds an array, so the shape doesn't depend on the data.
   *   Use this when reading YANG lists that may have one entry.
   */
  readonly arrays?: 'auto' | 'always';
  /** Include attributes under an `'@'` key, and the text under `'#text'`. Default `false`. */
  readonly attributes?: boolean;
}

/**
 * Convert an element's content to a plain object, for convenience.
 *
 * This is lossy by design: namespaces, document order between different
 * names, and mixed content are dropped. Keys are local names. An element with
 * no child elements becomes its text. Navigate {@link XmlElement} directly
 * when any of that matters.
 */
export function toObject(element: XmlElement, options: ToObjectOptions = {}): XmlValue {
  const arrays = options.arrays ?? 'auto';
  const withAttrs = options.attributes ?? false;

  const elements = element.elements;
  const hasAttrs = withAttrs && element.attributes.length > 0;
  if (elements.length === 0 && !hasAttrs) return element.text();

  const out: XmlObject = {};
  if (hasAttrs) {
    const attrs: XmlObject = {};
    for (const a of element.attributes) define(attrs, a.name, a.value);
    define(out, '@', attrs);
    if (elements.length === 0) {
      define(out, '#text', element.text());
      return out;
    }
  }
  for (const child of elements) {
    const value = toObject(child, options);
    const existing = Object.prototype.hasOwnProperty.call(out, child.name) ? out[child.name] : undefined;
    if (existing === undefined) define(out, child.name, arrays === 'always' ? [value] : value);
    // A single element's value is never an array, so an array here is one we built.
    else if (Array.isArray(existing)) existing.push(value);
    else define(out, child.name, [existing, value]);
  }
  return out;
}

/** Assign without invoking setters, so a `__proto__` element name is just a key. */
function define(obj: XmlObject, key: string, value: XmlValue): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}
