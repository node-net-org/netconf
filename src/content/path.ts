/**
 * YANG instance-identifier paths (design §6.4, level 1).
 *
 * Syntax: RFC 7950 §9.13 instance identifiers, with module names as prefixes
 * (as in RFC 7951/8040). The first step must name its module; later steps
 * inherit it unless they name another.
 *
 *   /ietf-interfaces:interfaces/interface[name="eth0"]/description
 *   /nokia-conf:configure/port[port-id='1/1/1']/admin-state
 *   /example:config/allowed-users[.="alice"]          (leaf-list entry)
 *   /example:config/user[name=concat('o', "'", 'neil "x"')]
 *                       (a value holding both quotes, as @node-net/yang writes it)
 *
 * Paths turn into subtree filters for reads and edit-config content for
 * writes. Module names resolve to namespaces through a resolver, normally the
 * server's own hello capabilities or YANG library, so no schema is needed.
 */

import { NetconfError, type NetconfErrorOptions } from '../errors.js';
import { x, XmlElement, type Child, type XmlNode } from '../xml/index.js';
import { NETCONF_NS } from '../messages/index.js';
import { xpath, type EditOperation, type XPathFilter } from '../operations/index.js';

export type { EditOperation };

/** A path that couldn't be parsed, or names a module that can't be resolved. */
export class PathError extends NetconfError {
  /** `'PathError'`. */
  override name = 'PathError';
  override readonly code = 'ERR_NETCONF_PATH';
  /** For a module no namespace source knows: the module's name. */
  readonly module: string | undefined;

  constructor(message: string, options?: NetconfErrorOptions & { readonly module?: string }) {
    super(message, options);
    this.module = options?.module;
  }
}

/** One list key predicate in a path step: `[name="value"]`. */
export interface PathKey {
  /** The key leaf's name. */
  readonly name: string;
  /** The key's value, unquoted. */
  readonly value: string;
}

/** One step of a parsed path, as {@link parsePath} returns it. See [Path syntax](/guide/content#path-syntax). */
export interface PathStep {
  /** Module named on this step, if any. */
  readonly module: string | undefined;
  /** The node's name, without its module. */
  readonly name: string;
  /** List key predicates, in the order written. */
  readonly keys: readonly PathKey[];
  /** A leaf-list value predicate: `[.="value"]`. */
  readonly value: string | undefined;
}

export interface ResolvedStep extends PathStep {
  /** Module this step belongs to (explicit or inherited). */
  readonly moduleName: string;
  readonly ns: string;
}

/** Maps a module name to its XML namespace, or undefined if unknown. */
export type ModuleResolver = (module: string) => string | undefined;

const IDENT = /[A-Za-z_][A-Za-z0-9_.-]*/y;

/**
 * Parse a path. With `continues`, the path carries on from another one (the
 * rest after a named path), so its first step may inherit its module.
 * @throws PathError
 */
export function parsePath(path: string, options: { readonly continues?: boolean } = {}): PathStep[] {
  const steps: PathStep[] = [];
  let i = 0;
  const fail = (msg: string): never => {
    throw new PathError(`Invalid path ${JSON.stringify(path)} at position ${i}: ${msg}`);
  };
  const skipWs = (): void => {
    while (i < path.length && /\s/.test(path[i]!)) i++;
  };
  const ident = (): string => {
    IDENT.lastIndex = i;
    const m = IDENT.exec(path);
    if (m === null) return fail('expected a name');
    i = IDENT.lastIndex;
    return m[0];
  };
  const literal = (): string => {
    const q = path[i];
    if (q !== '"' && q !== "'") return fail('expected a quoted value');
    const end = path.indexOf(q, i + 1);
    if (end === -1) return fail('unterminated quoted value');
    const value = path.slice(i + 1, end);
    i = end + 1;
    return value;
  };
  // A value holding both ' and " can't be one XPath literal, so it is written
  // as concat() of literals, as @node-net/yang writes such keys in data paths.
  const quoted = (): string => {
    if (!path.startsWith('concat(', i)) return literal();
    i += 'concat('.length;
    let value = '';
    for (;;) {
      skipWs();
      value += literal();
      skipWs();
      if (path[i] === ')') break;
      if (path[i] !== ',') fail("expected ',' or ')' in concat()");
      i++;
    }
    i++;
    return value;
  };

  if (path.trim() === '' || path[0] !== '/') fail('a path must start with /');
  while (i < path.length) {
    if (path[i] !== '/') fail("expected '/'");
    i++;
    let name = ident();
    let module: string | undefined;
    if (path[i] === ':') {
      i++;
      module = name;
      name = ident();
    }
    const keys: PathKey[] = [];
    let value: string | undefined;
    while (path[i] === '[') {
      i++;
      skipWs();
      if (path[i] === '.') {
        i++;
        skipWs();
        if (path[i] !== '=') fail("expected '='");
        i++;
        skipWs();
        value = quoted();
      } else if (/[0-9]/.test(path[i] ?? '')) {
        fail('positional predicates are not supported; use key predicates');
      } else {
        let key = ident();
        if (path[i] === ':') {
          i++;
          key = ident(); // a key in the list's own module; the prefix adds nothing
        }
        skipWs();
        if (path[i] !== '=') fail("expected '='");
        i++;
        skipWs();
        if (keys.some((k) => k.name === key)) fail(`key ${key} given twice`);
        keys.push({ name: key, value: quoted() });
      }
      skipWs();
      if (path[i] !== ']') fail("expected ']'");
      i++;
    }
    if (value !== undefined && keys.length > 0) fail('a step cannot have both key and value predicates');
    steps.push({ module, name, keys, value });
  }
  if (steps[0]?.module === undefined && options.continues !== true) {
    throw new PathError(`Invalid path ${JSON.stringify(path)}: the first step must name its module, e.g. /ietf-interfaces:interfaces`);
  }
  return steps;
}

/** Parse a path and resolve every step's namespace. @throws PathError */
export function resolvePath(path: string, resolve: ModuleResolver): ResolvedStep[] {
  let moduleName = '';
  return parsePath(path).map((step) => {
    moduleName = step.module ?? moduleName;
    const ns = resolve(moduleName);
    if (ns === undefined) {
      throw new PathError(
        `Unknown YANG module ${JSON.stringify(moduleName)} in ${JSON.stringify(path)}: ` +
          'the server did not advertise it, and no profile or schema defines its namespace',
        { module: moduleName },
      );
    }
    return { ...step, moduleName, ns };
  });
}

// --- building filters and edits ---------------------------------------------------

interface TreeNode {
  readonly name: string;
  readonly ns: string;
  readonly keys: readonly PathKey[];
  readonly value: string | undefined;
  readonly children: TreeNode[];
  /** For edits on the final step. */
  operation?: EditOperation;
  content?: XmlNode[];
  hasContent?: boolean;
}

function sameNode(n: TreeNode, s: ResolvedStep): boolean {
  return (
    n.name === s.name &&
    n.ns === s.ns &&
    n.value === s.value &&
    n.keys.length === s.keys.length &&
    n.keys.every((k, i) => k.name === s.keys[i]!.name && k.value === s.keys[i]!.value)
  );
}

function insert(roots: TreeNode[], steps: readonly ResolvedStep[]): TreeNode {
  let level = roots;
  let node: TreeNode | undefined;
  for (const step of steps) {
    node = level.find((n) => sameNode(n, step));
    if (node === undefined) {
      node = { name: step.name, ns: step.ns, keys: step.keys, value: step.value, children: [] };
      level.push(node);
    }
    level = node.children;
  }
  return node!;
}

function toElement(node: TreeNode): XmlElement {
  const children: XmlNode[] = node.keys.map((k) => new XmlElement({ name: k.name, ns: node.ns, children: [k.value] }));
  if (node.value !== undefined) children.push(node.value);
  if (node.content !== undefined) children.push(...node.content);
  children.push(...node.children.map(toElement));
  const attributes =
    node.operation === undefined || node.operation === 'merge'
      ? []
      : [{ name: 'operation', ns: NETCONF_NS, prefix: 'nc', value: node.operation }];
  return new XmlElement({ name: node.name, ns: node.ns, attributes, children });
}

/**
 * An XPath filter selecting what a resolved path selects, written as an
 * instance-identifier (RFC 7950 §9.13): every node and key is prefixed with
 * its module's name, which `namespaces` binds to the module's namespace.
 *
 *   /ietf-interfaces:interfaces/interface[name="eth0"]
 *   → /ietf-interfaces:interfaces/ietf-interfaces:interface[ietf-interfaces:name='eth0']
 *
 * Servers without `:xpath` accept instance-identifiers where XPath is asked
 * for (RFC 5717 partial-lock selects, for example).
 * @throws PathError if a key or value holds both kinds of quote, which XPath 1.0 can't express.
 */
export function pathXPath(steps: readonly ResolvedStep[]): XPathFilter {
  if (steps.length === 0) throw new PathError('An empty path has no XPath');
  const namespaces: Record<string, string> = {};
  let expr = '';
  for (const step of steps) {
    const prefix = step.moduleName;
    namespaces[prefix] = step.ns;
    expr += `/${prefix}:${step.name}`;
    for (const key of step.keys) expr += `[${prefix}:${key.name}=${xpathLiteral(key.value)}]`;
    if (step.value !== undefined) expr += `[.=${xpathLiteral(step.value)}]`;
  }
  return xpath(expr, namespaces);
}

function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  throw new PathError(`The value ${JSON.stringify(value)} holds both ' and ", which an XPath 1.0 literal can't express`);
}

/**
 * Subtree filter content selecting every path given (RFC 6241 §6). Keys
 * become content-match nodes; the last step becomes a selection node.
 */
export function buildFilter(paths: readonly (readonly ResolvedStep[])[]): XmlElement[] {
  const roots: TreeNode[] = [];
  for (const steps of paths) insert(roots, steps);
  return roots.map(toElement);
}

/**
 * The steps a `subtreeFilter: 'containers'` filter keeps: the first `depth`,
 * then the keyed steps right after them, stopping at the first unkeyed one.
 * Keyed list entries go into the filter as content matches, so
 * `/configure/port[port-id="1/1/1"]/ethernet/mtu` at depth 1 keeps the port.
 */
export function filterDepth(steps: readonly ResolvedStep[], depth: number): readonly ResolvedStep[] {
  let n = Math.min(Math.max(1, depth), steps.length);
  while (n < steps.length && steps[n]!.keys.length > 0) n++;
  return steps.slice(0, n);
}

export interface PathEdit {
  readonly path: readonly ResolvedStep[];
  readonly operation: EditOperation;
  /**
   * New content for the last step: a scalar becomes its text, elements become
   * its children, `null` an empty element (YANG `empty` leaves, presence containers).
   */
  readonly value?: Exclude<Child, undefined>;
}

/** edit-config `<config>` content for a set of edits, merged into one tree. */
export function buildEdit(edits: readonly PathEdit[]): XmlElement[] {
  const roots: TreeNode[] = [];
  for (const edit of edits) {
    const node = insert(roots, edit.path);
    if (node.hasContent === true || node.operation !== undefined) {
      throw new PathError(`Two edits target the same node: ${describe(edit.path)}`);
    }
    node.operation = edit.operation;
    const deleting = edit.operation === 'delete' || edit.operation === 'remove';
    if (deleting && edit.value !== undefined) {
      throw new PathError(`A ${edit.operation} edit takes no value: ${describe(edit.path)}`);
    }
    if (!deleting) {
      if (edit.value === undefined) throw new PathError(`A ${edit.operation} edit needs a value: ${describe(edit.path)}`);
      node.hasContent = true;
      node.content = contentOf(edit.value);
    }
  }
  return roots.map(toElement);
}

function contentOf(value: PathEdit['value']): XmlNode[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return [String(value)];
  }
  return [...x('content', value).children];
}

/** Every element in `data` that the path selects, honouring key and value predicates. */
export function selectPath(data: XmlElement, steps: readonly ResolvedStep[]): XmlElement[] {
  let current = [data];
  for (const step of steps) {
    current = current.flatMap((el) =>
      el.childrenNamed(step.name, step.ns).filter(
        (c) =>
          step.keys.every((k) => c.child(k.name)?.text().trim() === k.value) &&
          (step.value === undefined || c.text().trim() === step.value),
      ),
    );
    if (current.length === 0) break;
  }
  return current;
}

function describe(steps: readonly ResolvedStep[]): string {
  return steps
    .map((s) => {
      const preds = s.keys.map((k) => `[${k.name}="${k.value}"]`).join('') + (s.value !== undefined ? `[.="${s.value}"]` : '');
      return `/${s.moduleName}:${s.name}${preds}`;
    })
    .join('');
}
