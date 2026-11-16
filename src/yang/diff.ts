/**
 * How two datastores' YANG data differ (client.content.compareDatastores):
 * both sides decoded with one schema and compared by @node-net/yang, so list
 * entries match by their keys and leaf-list entries by their values.
 *
 * There is no schema-less fallback, unlike the JSON output: without a
 * schema, list entries could only be matched by position, and one inserted
 * entry would report every entry after it as changed.
 */

import { decodeXml, diffTrees, encodeJson, LeafListEntry, ListEntry, type DataChange, type InstanceNode, type JsonValue } from '@node-net/yang/core';
import { SchemaUnavailableError } from '../errors.js';
import type { XmlElement } from '../xml/index.js';
import { namespacesOfChildren } from './convert.js';
import { NamespaceScope } from '../xml/scope.js';
import { compile, compileErrors, implementedByNamespace, jsonNamespaces, pick, type SchemaContext } from './schemas.js';

/** One difference, as `client.content.compareDatastores()` reports it. */
export interface DataDifference {
  readonly operation: 'create' | 'delete' | 'replace' | 'move';
  readonly path: string;
  readonly value?: JsonValue;
  readonly previous?: JsonValue;
  readonly position?: { readonly where: 'first' } | { readonly where: 'after'; readonly anchor: string };
}

export interface DiffOptions {
  /** The datastore whose schema types the data: `running`, `candidate`, `startup`. */
  readonly datastore: string;
}

/**
 * The changes that turn the data in `from` into the data in `to`: the
 * children of two `<data>` elements (or any elements holding YANG data nodes).
 * @throws SchemaUnavailableError when a node has no module or schema, or a
 *   YangDataError when the data doesn't match the schema.
 */
export async function diffData(ctx: SchemaContext, from: XmlElement, to: XmlElement, options: DiffOptions): Promise<DataDifference[]> {
  const fromElements = from.elements;
  const toElements = to.elements;
  const elements = [...fromElements, ...toElements];
  if (elements.length === 0) return [];
  const library = await ctx.library();
  if (library === undefined) {
    throw new SchemaUnavailableError(
      'Comparing datastores needs the YANG schema, but the server lists no YANG modules (no YANG library, and none in its hello). Supply the modules with connect({ yang: { modules } })',
    );
  }

  const implemented = implementedByNamespace(library);
  const modules = new Set<string>();
  for (const el of elements) {
    const module = implemented.get(el.ns ?? '');
    if (module === undefined) {
      throw new SchemaUnavailableError(`Comparing datastores needs the YANG schema, but no module the server lists has the namespace ${el.ns ?? '(none)'} (of <${el.name}>)`);
    }
  }
  const used = namespacesOfChildren(from.inScope, fromElements);
  namespacesOfChildren(to.inScope, toElements, used);
  for (const ns of used) {
    const m = implemented.get(ns);
    if (m !== undefined) modules.add(m);
  }
  const servers = await compile(ctx, library, [...modules].sort());
  const schema = pick(servers, options.datastore);
  const missing = [...modules].filter((m) => schema?.module(m) === undefined);
  if (schema === undefined || missing.length > 0) {
    const problems = compileErrors(servers);
    const why = problems.length > 0 ? `: ${problems.slice(0, 3).join('; ')}` : '';
    throw new SchemaUnavailableError(
      `Comparing datastores needs the YANG schema, but none could be compiled for ${missing.join(', ') || 'the data'}${why}. Supply the modules with connect({ yang: { modules } })`,
    );
  }

  const namespaces = jsonNamespaces(library);
  const decode = (data: XmlElement) => decodeXml(schema, [...data.elements], { scope: new Map(NamespaceScope.entries(data.inScope)), namespaces });
  // Configuration datastores carry no origins: leave them out whatever the schema.
  const changes = diffTrees(decode(from), decode(to), { origin: false });
  return changes.filter((c): c is DataChange & { operation: DataDifference['operation'] } => c.operation !== 'origin').map((c) => difference(c, namespaces));
}

function difference(change: DataChange & { operation: DataDifference['operation'] }, namespaces: Readonly<Record<string, string>>): DataDifference {
  const { operation, path, node, previous, position } = change;
  const value = (n: InstanceNode): JsonValue => valueOf(n, namespaces);
  return {
    operation,
    path,
    ...(operation === 'delete' ? { previous: value(node) } : { value: value(node) }),
    ...(previous !== undefined ? { previous: value(previous) } : {}),
    ...(position === undefined ? {} : { position: position.where === 'first' ? { where: 'first' as const } : { where: 'after' as const, anchor: position.anchor.path } }),
  };
}

/** A node's RFC 7951 value on its own: a leaf's or leaf-list entry's typed value, a container's or list entry's object. */
function valueOf(node: InstanceNode, namespaces: Readonly<Record<string, string>>): JsonValue {
  const encoded = Object.values(encodeJson(node, { namespaces }))[0];
  if ((node instanceof ListEntry || node instanceof LeafListEntry) && Array.isArray(encoded)) return encoded[0] ?? null;
  return encoded ?? null;
}
