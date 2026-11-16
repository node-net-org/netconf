/**
 * An RFC 6241 subtree filter from RFC 7951 JSON, guided by the YANG schema
 * (design §3.5). Each JSON form maps to one kind of filter node (§6.2):
 * - an object is a containment node, holding the members below it;
 * - `{}` (or `null` on a container or list) selects the whole node;
 * - a leaf or leaf-list set to `null` is a selection node;
 * - a leaf or leaf-list with a value is a content-match node, written as the
 *   schema's canonical text ("01500" for a uint16 is sent as 1500, "1.50"
 *   for a decimal64 as 1.5), with any identityref prefix declared;
 * - a list is an array of entry objects, or one object.
 */

import { dataChildren, readJsonValue, writeXmlText, YangDataError, type CompiledModule, type DataIssue, type Schema, type SchemaNode } from '@node-net/yang/core';
import { XmlElement, type XmlNode } from '../xml/index.js';

const MEMBER = /^(?:([A-Za-z_][A-Za-z0-9_.-]*):)?([A-Za-z_][A-Za-z0-9_.-]*)$/;

/**
 * Convert one top-level JSON member to subtree-filter content.
 * @throws YangDataError listing every problem, each with its data path
 */
export function encodeFilter(schema: Schema, member: string, value: unknown): XmlElement[] {
  const walker = new FilterWalker(schema);
  const top = schema.dataNodes.flatMap((n) => (n.kind === 'choice' ? dataChildren(n) : [n]));
  const out = walker.member(member, value, top, undefined, '');
  if (walker.issues.length > 0) throw new YangDataError(walker.issues);
  return out;
}

class FilterWalker {
  readonly issues: DataIssue[] = [];
  constructor(readonly schema: Schema) {}

  #issue(code: string, message: string, path: string): void {
    this.issues.push({ code, message, path, severity: 'error' });
  }

  member(member: string, value: unknown, candidates: readonly SchemaNode[], context: CompiledModule | undefined, parentPath: string): XmlElement[] {
    const m = MEMBER.exec(member);
    if (m === null) {
      this.#issue('unknown-node', `'${member}' is not a member name`, `${parentPath}/${member}`);
      return [];
    }
    const module = m[1] === undefined ? context : this.schema.module(m[1]);
    const path = `${parentPath}/${member}`;
    if (module === undefined) {
      this.#issue('unknown-node', m[1] === undefined ? `top-level member '${member}' has no module name` : `module ${m[1]} is not in the schema`, path);
      return [];
    }
    const node = candidates.find((c) => c.name === m[2] && c.module === module);
    if (node === undefined) {
      this.#issue('unknown-node', `the schema has no node ${module.name}:${m[2]!} here`, path);
      return [];
    }
    return this.#node(node, value, path);
  }

  #node(node: SchemaNode, value: unknown, path: string): XmlElement[] {
    const ns = node.module.namespace;
    const element = (children: XmlNode[] = [], declarations?: ReadonlyMap<string, string>): XmlElement =>
      new XmlElement({ name: node.name, ns, children, ...(declarations !== undefined && declarations.size > 0 ? { declarations } : {}) });
    switch (node.kind) {
      case 'container':
        if (value === null) return [element()];
        if (!isObject(value)) return this.#wrong(node, value, 'an object or null', path);
        return [element(this.#children(node, value, path))];
      case 'list': {
        if (value === null) return [element()];
        const entries = Array.isArray(value) ? value : [value];
        const out: XmlElement[] = [];
        for (const entry of entries) {
          if (!isObject(entry)) {
            this.#wrong(node, entry, 'an object (an entry)', path);
            continue;
          }
          out.push(element(this.#children(node, entry, path)));
        }
        return out;
      }
      case 'leaf':
      case 'leaf-list': {
        if (value === null) return [element()];
        const values = node.kind === 'leaf-list' && Array.isArray(value) ? value : [value];
        const out: XmlElement[] = [];
        for (const v of values) {
          const typed = readJsonValue(this.schema, node.type, v, node.module, { lenient: true });
          if (typeof typed === 'string') {
            this.#issue('invalid-value', typed, path);
            continue;
          }
          const declarations = new Map<string, string>();
          const text = writeXmlText(typed, (m) => {
            for (const [p, u] of declarations) if (u === m.namespace) return p;
            let p = m.prefix;
            for (let i = 1; declarations.has(p); i++) p = `${m.prefix}${i}`;
            declarations.set(p, m.namespace);
            return p;
          }, this.schema);
          out.push(element(text === '' ? [] : [text], declarations));
        }
        return out;
      }
      case 'anydata':
      case 'anyxml':
        if (value === null || (isObject(value) && Object.keys(value).length === 0)) return [element()];
        return this.#wrong(node, value, '{} or null (an anydata node can only be selected)', path);
      default:
        this.#issue('unexpected-content', `${node.kind} ${node.name} can't be in a filter`, path);
        return [];
    }
  }

  #children(node: SchemaNode, obj: Readonly<Record<string, unknown>>, path: string): XmlElement[] {
    const candidates = dataChildren(node);
    const out: XmlElement[] = [];
    for (const [member, value] of Object.entries(obj)) {
      if (member.startsWith('@')) {
        this.#issue('unexpected-content', `metadata (${member}) can't be in a filter`, path);
        continue;
      }
      out.push(...this.member(member, value, candidates, node.module, path));
    }
    return out;
  }

  #wrong(node: SchemaNode, value: unknown, what: string, path: string): [] {
    const got = value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value === 'object' ? 'an object' : `${typeof value} ${JSON.stringify(value)}`;
    this.#issue('unexpected-content', `${node.kind} ${node.name} is ${got}, not ${what}`, path);
    return [];
  }
}

function isObject(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
