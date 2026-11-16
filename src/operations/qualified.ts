/**
 * Values that name schema items, decoded the RFC 7951 way: an identityref
 * (`ianaift:ethernetCsmacd`) becomes a module-qualified identity
 * (`iana-if-type:ethernetCsmacd`, RFC 7951 §6.8), and an instance-identifier
 * (`/if:interfaces/if:interface[if:name='eth0']`) a path with module names
 * (`/ietf-interfaces:interfaces/interface[name='eth0']`, RFC 7951 §6.11).
 *
 * In XML both use prefixes, which mean nothing on their own: each resolves
 * against the namespace declarations in scope on the element holding the
 * value (RFC 7950 §9.10.3, §9.13.2), which a parsed element carries as
 * `inScope` wherever it was declared, up to `<rpc-reply>` or `<notification>`.
 * The module names replace them, so the result means the same whichever
 * prefixes the server chose, and is what the Content layer's JSON gives.
 */

import { DATASTORES_NS, MONITORING_NS, NETCONF_NS, NMDA_NS, ORIGIN_NS, WITH_DEFAULTS_NS } from '../messages/index.js';
import type { XmlElement } from '../xml/index.js';

/** The module a namespace belongs to, as the session knows it, or `undefined`. */
export type ModuleOf = (namespace: string) => string | undefined;

/**
 * Modules whose identities and paths the library's own readers decode, by
 * namespace. They are the last resort after the session's own lookup: YANG
 * 1.1 modules aren't in the hello, and a notification decoder can't wait for
 * a YANG library read.
 */
export const WELL_KNOWN_MODULES: Readonly<Record<string, string>> = Object.freeze({
  [NETCONF_NS]: 'ietf-netconf',
  [DATASTORES_NS]: 'ietf-datastores',
  [ORIGIN_NS]: 'ietf-origin',
  [MONITORING_NS]: 'ietf-netconf-monitoring',
  'urn:ietf:params:xml:ns:yang:ietf-netconf-notifications': 'ietf-netconf-notifications',
  [WITH_DEFAULTS_NS]: 'ietf-netconf-with-defaults',
  [NMDA_NS]: 'ietf-netconf-nmda',
  'urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications': 'ietf-subscribed-notifications',
  'urn:ietf:params:xml:ns:yang:ietf-yang-push': 'ietf-yang-push',
  'urn:ietf:params:xml:ns:yang:ietf-yang-library': 'ietf-yang-library',
  'urn:ietf:params:xml:ns:netconf:partial-lock:1.0': 'ietf-netconf-partial-lock',
  'urn:ietf:params:xml:ns:yang:ietf-interfaces': 'ietf-interfaces',
  'urn:ietf:params:xml:ns:yang:iana-if-type': 'iana-if-type',
});

/**
 * The name a namespace's module goes by in a module-qualified value: the
 * session's module for it, else a well-known one, else the namespace itself,
 * as the JSON conversion does for a namespace no source knows.
 */
export function moduleName(namespace: string, moduleOf?: ModuleOf): string {
  return moduleOf?.(namespace) ?? WELL_KNOWN_MODULES[namespace] ?? namespace;
}

/**
 * An identityref value as RFC 7951 writes it, `module:identity`, resolving
 * its prefix against the declarations in scope on `element` (the element
 * holding the value, or the one carrying the attribute). An unprefixed value
 * is in the default namespace in effect there (RFC 7950 §9.10.3).
 * `undefined` when the prefix isn't declared or nothing follows it. The name
 * is kept as the server sent it, even one YANG wouldn't allow, so a
 * malformed value is reported rather than silently replaced.
 */
export function qualifiedIdentity(text: string, element: XmlElement, moduleOf?: ModuleOf): string | undefined {
  const value = text.trim();
  const colon = value.indexOf(':');
  const prefix = colon === -1 ? '' : value.slice(0, colon);
  const name = colon === -1 ? value : value.slice(colon + 1);
  if (name === '') return undefined;
  const namespace = element.lookupNamespace(prefix);
  if (namespace === undefined || namespace === '') return undefined;
  return `${moduleName(namespace, moduleOf)}:${name}`;
}

/**
 * An XML instance-identifier (RFC 7950 §9.13) as RFC 7951 §6.11 writes it:
 * the module name on the first node and wherever the module changes, and no
 * prefix elsewhere. Prefixes resolve against the declarations in scope on
 * `element`. The result is in the same syntax as the Content layer's paths.
 * @throws TypeError if the path is malformed or uses an undeclared prefix.
 */
export function qualifiedPath(text: string, element: XmlElement, moduleOf?: ModuleOf): string {
  let out = '';
  let previous: string | undefined;
  for (const step of parseSteps(text.trim(), element)) {
    const module = moduleName(step.namespace, moduleOf);
    out += `/${module === previous ? '' : `${module}:`}${step.name}`;
    previous = module;
    for (const [key, value] of step.keys) out += `[${key}=${quote(value)}]`;
    if (step.value !== undefined) out += `[.=${quote(step.value)}]`;
    if (step.position !== undefined) out += `[${step.position}]`;
  }
  return out;
}

/** A literal in single quotes, or double quotes when it contains a single quote (XPath has no escapes). */
function quote(value: string): string {
  return value.includes("'") ? `"${value}"` : `'${value}'`;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]*/;

interface Step {
  readonly name: string;
  readonly namespace: string;
  readonly keys: readonly (readonly [string, string])[];
  readonly value?: string;
  readonly position?: number;
}

/** The steps of an XML instance-identifier, each node's prefix resolved. Every node name must be prefixed. */
function parseSteps(path: string, element: XmlElement): Step[] {
  const steps: Step[] = [];
  let i = 0;

  const fail = (problem: string): never => {
    throw new TypeError(`${problem} at offset ${i} in ${JSON.stringify(path)}`);
  };
  const skipSpace = (): void => {
    while (i < path.length && /\s/.test(path[i]!)) i++;
  };
  const expect = (ch: string): void => {
    if (path[i] !== ch) fail(`expected ${JSON.stringify(ch)}`);
    i++;
  };
  const identifier = (): string => {
    const m = IDENTIFIER.exec(path.slice(i));
    if (m === null) return fail('expected an identifier');
    i += m[0].length;
    return m[0];
  };
  const qname = (): { name: string; namespace: string } => {
    const start = i;
    const prefix = identifier();
    if (path[i] !== ':') {
      i = start;
      fail('expected a prefixed node name');
    }
    i++;
    const name = identifier();
    const namespace = element.lookupNamespace(prefix);
    if (namespace === undefined || namespace === '') {
      i = start;
      fail(`undeclared prefix ${JSON.stringify(prefix)}`);
    }
    return { name, namespace: namespace! };
  };
  const literal = (): string => {
    const q = path[i];
    if (q !== "'" && q !== '"') return fail('expected a quoted string');
    const end = path.indexOf(q, i + 1);
    if (end === -1) return fail('unterminated string');
    const value = path.slice(i + 1, end);
    i = end + 1;
    return value;
  };

  if (path === '') fail('empty path');
  while (i < path.length) {
    expect('/');
    const node = qname();
    const keys: [string, string][] = [];
    let value: string | undefined;
    let position: number | undefined;
    while (path[i] === '[') {
      if (value !== undefined || position !== undefined) fail('unexpected predicate');
      i++;
      skipSpace();
      if (/\d/.test(path[i] ?? '')) {
        if (keys.length > 0) fail("a position can't follow key predicates");
        const m = /^\d+/.exec(path.slice(i))!;
        position = Number(m[0]);
        if (position < 1 || !Number.isSafeInteger(position)) fail('a position must be a positive integer');
        i += m[0].length;
      } else if (path[i] === '.') {
        if (keys.length > 0) fail("a leaf-list value can't follow key predicates");
        i++;
        skipSpace();
        expect('=');
        skipSpace();
        value = literal();
      } else {
        const key = qname();
        skipSpace();
        expect('=');
        skipSpace();
        if (keys.some(([k]) => k === key.name)) fail(`duplicate key ${JSON.stringify(key.name)}`);
        keys.push([key.name, literal()]);
      }
      skipSpace();
      expect(']');
    }
    steps.push({ name: node.name, namespace: node.namespace, keys, ...(value === undefined ? {} : { value }), ...(position === undefined ? {} : { position }) });
  }
  return steps;
}
