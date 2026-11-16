/**
 * The schema-less JSON projection: what a subtree becomes when no YANG schema
 * describes it and `requireSchema` is off.
 *
 * It follows RFC 7951's naming, but without a schema it can't know types or
 * which nodes are lists, so:
 * - member names are `module:name` where the module differs from the
 *   parent's (always at the top), from the namespace → module map, with the
 *   namespace URI standing in for an unknown module;
 * - repeated sibling elements become an array, and a single one does not;
 * - every leaf value is its text, verbatim (an element with no content is `""`);
 * - attributes become RFC 7952-style annotations (`@` in an object, `@name`
 *   beside a leaf), named the same way.
 */

import type { JsonValue } from '@node-net/yang/core';
import { XmlElement, type XmlAttribute } from '../xml/index.js';

type JsonObject = { [member: string]: JsonValue };

/** Namespace URI → module name, or undefined when unknown. */
export type ModuleOf = (namespace: string) => string | undefined;

/** Project sibling elements (a `<data>` element's children, say) as members of one JSON object. */
export function projectSchemaless(elements: readonly XmlElement[], moduleOf: ModuleOf, parentModule?: string): JsonObject {
  const groups = new Map<string, XmlElement[]>();
  for (const el of elements) {
    const key = memberName(el.name, el.ns, moduleOf, parentModule);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [el]);
    else group.push(el);
  }
  const out: JsonObject = {};
  for (const [key, els] of groups) {
    const values = els.map((e) => valueOf(e, moduleOf));
    out[key] = values.length === 1 ? values[0]! : values;
    // Leaves carry their annotations beside them; inner nodes inside, as "@".
    if (els.every((e) => e.elements.length === 0) && els.some((e) => e.attributes.length > 0)) {
      const notes = els.map((e) => annotations(e, moduleOf) ?? null);
      out[`@${key}`] = notes.length === 1 ? notes[0]! : notes;
    }
  }
  return out;
}

function valueOf(el: XmlElement, moduleOf: ModuleOf): JsonValue {
  if (el.elements.length === 0) return el.textContent();
  const obj = projectSchemaless(el.elements, moduleOf, moduleName(el.ns, moduleOf));
  const notes = annotations(el, moduleOf);
  return notes === undefined ? obj : { '@': notes, ...obj };
}

function annotations(el: XmlElement, moduleOf: ModuleOf): JsonObject | undefined {
  if (el.attributes.length === 0) return undefined;
  const out: JsonObject = {};
  for (const a of el.attributes) out[memberName(a.name, a.ns, moduleOf, undefined)] = a.value;
  return out;
}

function moduleName(ns: string | undefined, moduleOf: ModuleOf): string | undefined {
  if (ns === undefined || ns === '') return undefined;
  return moduleOf(ns) ?? ns;
}

function memberName(name: string, ns: string | undefined, moduleOf: ModuleOf, parentModule: string | undefined): string {
  const module = moduleName(ns, moduleOf);
  return module === undefined || module === parentModule ? name : `${module}:${name}`;
}

/** Module name → namespace URI, or undefined when unknown. */
export type NamespaceOf = (module: string) => string | undefined;

/** Preferred XML prefixes for the annotation namespaces JSON input uses. */
const ATTRIBUTE_PREFIXES: Readonly<Record<string, string>> = {
  'urn:ietf:params:xml:ns:netconf:base:1.0': 'nc',
  'urn:ietf:params:xml:ns:yang:1': 'yang',
};

/**
 * The inverse projection, for JSON input with no schema: one RFC 7951 JSON
 * member (`module:name` and its value) as XML elements.
 * - a member name's module gives its namespace (`namespaceOf`); an
 *   unqualified name takes its parent's;
 * - an array becomes one element per entry;
 * - an object becomes an element with children, its `@` member attributes;
 * - a scalar becomes the element's text, and `null` (or `[null]`) an empty element;
 * - `@name` members become attributes of `name`'s elements (entry by entry
 *   for an array).
 * @throws TypeError naming a module whose namespace isn't known
 */
export function buildSchemaless(member: string, value: unknown, namespaceOf: NamespaceOf, parentNs?: string): XmlElement[] {
  return build(member, value, namespaceOf, parentNs, `/${member}`, undefined);
}

function build(member: string, value: unknown, namespaceOf: NamespaceOf, parentNs: string | undefined, path: string, notes: unknown): XmlElement[] {
  const { name, ns } = qualify(member, namespaceOf, parentNs, path);
  const entries = Array.isArray(value) ? value : [value];
  const noteList = Array.isArray(value) ? (Array.isArray(notes) ? notes : []) : [notes];
  return entries.map((entry: unknown, i) => {
    const attributes = attributesOf(noteList[i], namespaceOf, path);
    if (entry === null || entry === undefined) return new XmlElement({ name, ns, attributes });
    if (typeof entry !== 'object') return new XmlElement({ name, ns, attributes, children: [textOf(entry)] });
    if (Array.isArray(entry)) throw new TypeError(`JSON input: ${path} holds an array inside an array`);
    const obj = entry as Readonly<Record<string, unknown>>;
    const children: XmlElement[] = [];
    for (const [key, v] of Object.entries(obj)) {
      if (key.startsWith('@')) continue;
      children.push(...build(key, v, namespaceOf, ns, `${path}/${key}`, obj[`@${key}`]));
    }
    return new XmlElement({ name, ns, attributes: [...attributes, ...attributesOf(obj['@'], namespaceOf, path)], children });
  });
}

function qualify(member: string, namespaceOf: NamespaceOf, parentNs: string | undefined, path: string): { name: string; ns: string } {
  const colon = member.indexOf(':');
  if (colon < 0) {
    if (parentNs === undefined) throw new TypeError(`JSON input: top-level member '${member}' has no module name (write it as module:${member})`);
    return { name: member, ns: parentNs };
  }
  const module = member.slice(0, colon);
  const ns = namespaceOf(module);
  if (ns === undefined) throw new TypeError(`JSON input: ${path} names module ${module}, whose namespace isn't known (it isn't in connect's namespaces, the profile's, the server's hello or its YANG library)`);
  return { name: member.slice(colon + 1), ns };
}

function attributesOf(notes: unknown, namespaceOf: NamespaceOf, path: string): XmlAttribute[] {
  if (notes === null || notes === undefined) return [];
  if (typeof notes !== 'object' || Array.isArray(notes)) throw new TypeError(`JSON input: metadata at ${path} is not an object`);
  return Object.entries(notes as Readonly<Record<string, unknown>>).map(([key, v]) => {
    const { name, ns } = qualify(key, namespaceOf, undefined, `${path}/@${key}`);
    const prefix = ATTRIBUTE_PREFIXES[ns];
    return { name, ns, ...(prefix !== undefined ? { prefix } : {}), value: v === null ? '' : textOf(v) };
  });
}

/** A JSON scalar's text; anything else as JSON. */
function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return v.toString();
  return JSON.stringify(v);
}
