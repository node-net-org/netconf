/**
 * What the YANG conversions (convert.ts for output, encode.ts and filter.ts
 * for input) share: where a client's schemas come from, and compiling only
 * the modules some data needs, through the client's YangCache.
 */

import { compileYangLibrary, type ModuleSource, type Schema, type ServerSchemas, type YangLibrary } from '@node-net/yang/core';
import { FrozenMap } from '../frozen-map.js';
import { ANNOTATION_NAMESPACES } from './annotations.js';
import type { YangCache } from './cache.js';
import type { ModuleOf } from './schemaless.js';

/** What the converter needs from a client: where the schema comes from. */
export interface SchemaContext {
  /** The server's modules (its YANG library, else its hello), or undefined when nothing lists any. */
  library(): Promise<YangLibrary | undefined>;
  /** Where module text comes from. */
  readonly source: ModuleSource;
  /** Identifies `source` apart from `<get-schema>` (the supplied module directories), for sharing a cache. */
  readonly sourceKey: string;
  /** Namespace URI → module name, from everything the client knows, for naming nodes without a schema. */
  readonly moduleOf: ModuleOf;
  /** Module name → namespace URI, the inverse of `moduleOf`, for JSON input without a schema. */
  readonly namespaceOf: (module: string) => string | undefined;
  /** Report a schema-less conversion (the session's `warning` event and the logger). */
  warn(message: string): void;
  readonly cache: YangCache;
}

// Views of a library, computed once per library object. A
// session's library is one object until it is read again, so a conversion
// pays for none of these after the first.
const descriptions = new WeakMap<YangLibrary, string>();
const implementedViews = new WeakMap<YangLibrary, ReadonlyMap<string, string>>();
const namespaceViews = new WeakMap<YangLibrary, Readonly<Record<string, string>>>();
const jsonNamespaceViews = new WeakMap<YangLibrary, Readonly<Record<string, string>>>();
const implementedNameViews = new WeakMap<YangLibrary, ReadonlySet<string>>();

/** The schemas for `only`, from the cache or compiled now. */
export function compile(ctx: SchemaContext, library: YangLibrary, only: readonly string[]): Promise<ServerSchemas> {
  // The library's description identifies it: no hash to compute, no
  // collisions, and equal libraries read by different sessions share a
  // compile. (Not the content-id: that is only unique per server.) It is
  // serialised once per library object, and the cache gives it a short id,
  // so the per-call key is short.
  let description = descriptions.get(library);
  if (description === undefined) {
    description = JSON.stringify([library.moduleSets, library.schemas, library.datastores]);
    descriptions.set(library, description);
  }
  const key = JSON.stringify([ctx.cache.libraryId(description), ctx.sourceKey, only]);
  return ctx.cache.schemas(key, () => compileYangLibrary(library, { source: ctx.cache.source(ctx.source, ctx.sourceKey), only }));
}

/** The datastore's schema; any schema when the library doesn't list the datastore. */
export function pick(servers: ServerSchemas, datastore: string): Schema | undefined {
  return servers.datastore(datastore) ?? [...servers.schemas.values()][0];
}

export function compileErrors(servers: ServerSchemas): string[] {
  const out: string[] = [];
  for (const d of [...servers.diagnostics, ...[...servers.schemas.values()].flatMap((s) => s.diagnostics)]) {
    if (d.severity === 'error' && !out.includes(d.message)) out.push(d.message);
  }
  return out;
}

/** Namespace → name of each module the library implements, in any module set. */
export function implementedByNamespace(library: YangLibrary): ReadonlyMap<string, string> {
  let view = implementedViews.get(library);
  if (view === undefined) {
    const map = new Map<string, string>();
    for (const set of library.moduleSets) {
      for (const m of set.modules) if (m.namespace !== undefined && !map.has(m.namespace)) map.set(m.namespace, m.name);
    }
    view = new FrozenMap(map);
    implementedViews.set(library, view);
  }
  return view;
}

const NO_NAMESPACES: Readonly<Record<string, string>> = Object.freeze({});

/** Namespace → module name for every module the library lists, imported ones included. */
export function namespacesOf(library: YangLibrary | undefined): Readonly<Record<string, string>> {
  if (library === undefined) return NO_NAMESPACES;
  let view = namespaceViews.get(library);
  if (view === undefined) {
    const out: Record<string, string> = {};
    for (const set of library.moduleSets) {
      for (const m of [...set.modules, ...set.importOnly]) if (m.namespace !== undefined) out[m.namespace] ??= m.name;
    }
    view = Object.freeze(out);
    namespaceViews.set(library, view);
  }
  return view;
}

/** The names of the modules the library implements, in any module set. */
export function implementedNames(library: YangLibrary): ReadonlySet<string> {
  let view = implementedNameViews.get(library);
  if (view === undefined) {
    view = new Set(implementedByNamespace(library).values());
    implementedNameViews.set(library, view);
  }
  return view;
}

const ANNOTATIONS_ONLY: Readonly<Record<string, string>> = Object.freeze({ ...ANNOTATION_NAMESPACES });

/** Namespace → module name for naming nodes in JSON: {@link namespacesOf}, then the annotation modules. */
export function jsonNamespaces(library: YangLibrary | undefined): Readonly<Record<string, string>> {
  if (library === undefined) return ANNOTATIONS_ONLY;
  let view = jsonNamespaceViews.get(library);
  if (view === undefined) {
    view = Object.freeze({ ...namespacesOf(library), ...ANNOTATION_NAMESPACES });
    jsonNamespaceViews.set(library, view);
  }
  return view;
}
