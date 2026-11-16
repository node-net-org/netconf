/**
 * The YANG library (RFC 8525): which YANG modules a server implements, per
 * datastore, including YANG 1.1 modules that never appear in the hello
 * (design §8).
 *
 * ```ts
 * import { yangLibrary, findDatastore } from '@node-net/netconf/operations/yang-library';
 *
 * const client = await connect({ transport, extensions: [yangLibrary] });
 * const lib = await client.content.yangLibrary.load();      // cached for this client
 * const running = findDatastore(lib, 'running');
 * running?.modules.find((m) => m.name === 'ietf-interfaces')?.features;
 * ```
 *
 * The result is plain data. To reuse it across sessions, store it keyed by the
 * device and `lib.contentId`, and compare with `client.content.yangLibrary.contentId`
 * from the next hello: an unchanged content-id means an unchanged library.
 *
 * A server with only `:yang-library:1.0` (RFC 7895) has the older
 * `/modules-state` list instead; it is read and returned in the same shape,
 * with `version: '1.0'`, one module set and no datastores.
 *
 * Each session reads its library once: this module, `client.content.loadModules()` and
 * the other extensions' support checks share the read
 * (`loadYangLibrary()`).
 *
 * @packageDocumentation
 */

import { AbortError, CapabilityError } from '../errors.js';
import type { RpcOptions } from '../messages/index.js';
import { x, type XmlElement } from '../xml/index.js';
import { raceSignal, raceTimeout } from './abort.js';
import { get, subtree } from './base.js';
import { defineExtension, type ExtensionContext, type OperationDescriptor } from './extension.js';
import { YANG_LIBRARY_NS, datastoreIdentity, type DatastoreRef } from './identities.js';
import { moduleName, qualifiedIdentity, type ModuleOf } from './qualified.js';

export { YANG_LIBRARY_NS, type DatastoreRef, type Identity } from './identities.js';

/** The `:yang-library:1.1` capability (RFC 8526 §2). */
export const YANG_LIBRARY_1_1 = 'urn:ietf:params:netconf:capability:yang-library:1.1';
/** The `:yang-library:1.0` capability (RFC 7950 §5.6.4, RFC 7895): the older `/modules-state` list. */
export const YANG_LIBRARY_1_0 = 'urn:ietf:params:netconf:capability:yang-library:1.0';

/** A submodule of a module in the library. */
export interface Submodule {
  /** The submodule's name. */
  readonly name: string;
  /** Its revision date; absent when it has none. */
  readonly revision?: string;
  /** URLs of its source, if the server offers any. */
  readonly locations: readonly string[];
}

/** A module the server implements. */
export interface LibraryModule {
  /** The module's name. */
  readonly name: string;
  /** Absent when the module has no revision. */
  readonly revision?: string;
  /** The XML namespace the module defines, or `''` if the server sent none. */
  readonly namespace: string;
  /** URLs of its source, if the server offers any. */
  readonly locations: readonly string[];
  /** The module's features the server supports, by name. */
  readonly features: readonly string[];
  /** Names of the modules that deviate it. */
  readonly deviations: readonly string[];
  /** The submodules the server uses. */
  readonly submodules: readonly Submodule[];
}

/** A module whose definitions are used only because another module imports it. */
export interface ImportOnlyModule {
  /** The module's name. */
  readonly name: string;
  /** `''` when the module has no revision. */
  readonly revision: string;
  /** The XML namespace the module defines, or `''` if the server sent none. */
  readonly namespace: string;
  /** URLs of its source, if the server offers any. */
  readonly locations: readonly string[];
  /** The submodules the server uses. */
  readonly submodules: readonly Submodule[];
}

/**
 * An RFC 8525 `module-set`: modules a schema is built from. A
 * `:yang-library:1.0` server's list becomes one set named `modules-state`.
 */
export interface ModuleSet {
  /** The module set's name. */
  readonly name: string;
  /** The modules the server implements in this set. */
  readonly modules: readonly LibraryModule[];
  /** The modules in this set used only for their imported definitions. */
  readonly importOnlyModules: readonly ImportOnlyModule[];
}

/** An RFC 8525 `schema`: a named combination of module sets that datastores refer to. */
export interface LibrarySchema {
  /** The schema's name. */
  readonly name: string;
  /** The names of its module sets (see {@link ModuleSet}). */
  readonly moduleSets: readonly string[];
}

/** One datastore, resolved to the union of its schema's module sets. */
export interface LibraryDatastore {
  /**
   * The datastore identity, module-qualified as RFC 7951 writes it:
   * `ietf-datastores:running`, or another module's, such as
   * `ietf-factory-default:factory-default`.
   */
  readonly name: string;
  /** The name of the datastore's schema (see {@link LibrarySchema}). */
  readonly schema: string;
  /** The modules the server implements for this datastore, from all its schema's module sets. */
  readonly modules: readonly LibraryModule[];
  /** The import-only modules, from all its schema's module sets. */
  readonly importOnlyModules: readonly ImportOnlyModule[];
}

/**
 * A server's YANG library, as plain data: what `client.content.yangLibrary.load()`
 * resolves with. Find a datastore's modules with {@link findDatastore}.
 * See [yang-library](/guide/extensions#yang-library).
 */
export interface YangLibrary {
  /** `'1.1'`: read from `/yang-library` (RFC 8525). `'1.0'`: from `/modules-state` (RFC 7895). */
  readonly version: '1.1' | '1.0';
  /** RFC 8525's content-id, or RFC 7895's module-set-id. */
  readonly contentId: string;
  /** Every module set, as listed. */
  readonly moduleSets: readonly ModuleSet[];
  /** Every schema, as listed. Empty from a `:yang-library:1.0` server. */
  readonly schemas: readonly LibrarySchema[];
  /** Each datastore with its modules resolved. Empty from a `:yang-library:1.0` server. */
  readonly datastores: readonly LibraryDatastore[];
}

/** What `client.content.yangLibrary` holds. */
export interface YangLibraryContent {
  /** The `content-id` (or, on a `:yang-library:1.0` server, `module-set-id`) the server sent in its hello, if any. */
  readonly contentId: string | undefined;
  /**
   * Read the library: `/yang-library`, or `/modules-state` on a server with
   * only `:yang-library:1.0`. The result is kept for this session (shared with
   * `client.content.loadModules()`), so later calls send nothing; `refresh: true` reads
   * it again (after a library change).
   */
  load(options?: YangLibraryLoadOptions): Promise<YangLibrary>;
}

/** Options for `client.content.yangLibrary.load()`. */
export type YangLibraryLoadOptions = RpcOptions & {
  /** Read the library again instead of using what this session already read. */
  readonly refresh?: boolean;
};

/** A datastore's entry in the library, by standard name or by identity. */
export function findDatastore(library: YangLibrary, datastore: DatastoreRef): LibraryDatastore | undefined {
  const id = datastoreIdentity(datastore);
  const name = `${moduleName(id.namespace, libraryModuleOf(library.moduleSets))}:${id.name}`;
  return library.datastores.find((d) => d.name === name);
}

/** The module a namespace belongs to, by the library's own module sets. */
function libraryModuleOf(moduleSets: readonly ModuleSet[]): ModuleOf {
  const byNamespace = new Map<string, string>();
  for (const set of moduleSets) {
    for (const m of [...set.modules, ...set.importOnlyModules]) if (m.namespace !== '' && !byNamespace.has(m.namespace)) byNamespace.set(m.namespace, m.name);
  }
  return (ns) => byNamespace.get(ns);
}

/**
 * The modules of a library schema, by name: its module sets merged as a
 * datastore's are. With no name, every module set merged, the one schema of a
 * library that lists none (RFC 7895, or an RFC 8525 library without schemas).
 * Undefined when the library has no schema of that name.
 */
export function schemaModules(library: YangLibrary, schema?: string): Pick<LibraryDatastore, 'modules' | 'importOnlyModules'> | undefined {
  if (schema === undefined) return resolveSchema(library.moduleSets);
  const found = library.schemas.find((s) => s.name === schema);
  if (found === undefined) return undefined;
  const sets = new Map(library.moduleSets.map((s) => [s.name, s]));
  return resolveSchema(found.moduleSets.flatMap((n) => sets.get(n) ?? []));
}

// --- parsing ---------------------------------------------------------------------------------

const leaf = (el: XmlElement, name: string): string | undefined => el.child(name, YANG_LIBRARY_NS)?.text().trim();
const leaves = (el: XmlElement, name: string): string[] =>
  el.childrenNamed(name, YANG_LIBRARY_NS).map((c) => c.text().trim());

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined || value === '' ? {} : { [key]: value }) as { [P in K]?: string };
}

function parseSubmodules(el: XmlElement): Submodule[] {
  return el.childrenNamed('submodule', YANG_LIBRARY_NS).flatMap((s) => {
    const name = leaf(s, 'name');
    return name === undefined ? [] : [{ name, ...optional('revision', leaf(s, 'revision')), locations: leaves(s, 'location') }];
  });
}

function parseModuleSet(set: XmlElement): ModuleSet | undefined {
  const name = leaf(set, 'name');
  if (name === undefined) return undefined;
  const modules: LibraryModule[] = set.childrenNamed('module', YANG_LIBRARY_NS).flatMap((m) => {
    const moduleName = leaf(m, 'name');
    if (moduleName === undefined) return [];
    return [{
      name: moduleName,
      ...optional('revision', leaf(m, 'revision')),
      namespace: leaf(m, 'namespace') ?? '',
      locations: leaves(m, 'location'),
      features: leaves(m, 'feature'),
      deviations: leaves(m, 'deviation'),
      submodules: parseSubmodules(m),
    }];
  });
  const importOnlyModules: ImportOnlyModule[] = set.childrenNamed('import-only-module', YANG_LIBRARY_NS).flatMap((m) => {
    const moduleName = leaf(m, 'name');
    if (moduleName === undefined) return [];
    return [{
      name: moduleName,
      revision: leaf(m, 'revision') ?? '',
      namespace: leaf(m, 'namespace') ?? '',
      locations: leaves(m, 'location'),
      submodules: parseSubmodules(m),
    }];
  });
  return { name, modules, importOnlyModules };
}

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

/**
 * Merge a schema's module sets. A module listed in several sets keeps its first
 * revision and namespace; features, deviations, locations and submodules are
 * combined (RFC 8525 requires them to agree; its own Appendix C doesn't).
 */
function resolveSchema(sets: readonly ModuleSet[]): Pick<LibraryDatastore, 'modules' | 'importOnlyModules'> {
  const modules = new Map<string, LibraryModule>();
  const importOnly = new Map<string, ImportOnlyModule>();
  for (const set of sets) {
    for (const m of set.modules) {
      const seen = modules.get(m.name);
      if (seen === undefined) {
        modules.set(m.name, m);
        continue;
      }
      const submodules = new Map(seen.submodules.map((s) => [s.name, s]));
      for (const s of m.submodules) if (!submodules.has(s.name)) submodules.set(s.name, s);
      modules.set(m.name, {
        ...seen,
        locations: union(seen.locations, m.locations),
        features: union(seen.features, m.features),
        deviations: union(seen.deviations, m.deviations),
        submodules: [...submodules.values()],
      });
    }
    for (const m of set.importOnlyModules) {
      const key = `${m.name}@${m.revision}`;
      if (!importOnly.has(key)) importOnly.set(key, m);
    }
  }
  return { modules: [...modules.values()], importOnlyModules: [...importOnly.values()] };
}

/**
 * Parse a `<yang-library>` element. Datastore identities such as
 * `ds:running` resolve against the declarations in scope where the server
 * sent them, and are named by module: the library's own module for the
 * namespace, else `moduleOf`'s, else a well-known one.
 */
export function parseYangLibrary(yl: XmlElement, moduleOf?: ModuleOf): YangLibrary {
  const moduleSets = yl.childrenNamed('module-set', YANG_LIBRARY_NS).flatMap((s) => parseModuleSet(s) ?? []);
  const setsByName = new Map(moduleSets.map((s) => [s.name, s]));
  const schemas: LibrarySchema[] = yl.childrenNamed('schema', YANG_LIBRARY_NS).flatMap((s) => {
    const name = leaf(s, 'name');
    return name === undefined ? [] : [{ name, moduleSets: leaves(s, 'module-set') }];
  });
  const schemasByName = new Map(schemas.map((s) => [s.name, s]));
  const own = libraryModuleOf(moduleSets);
  const lookup: ModuleOf = (ns) => own(ns) ?? moduleOf?.(ns);
  const datastores: LibraryDatastore[] = yl.childrenNamed('datastore', YANG_LIBRARY_NS).flatMap((d) => {
    const nameEl = d.child('name', YANG_LIBRARY_NS);
    const schemaName = leaf(d, 'schema');
    if (nameEl === undefined || schemaName === undefined) return [];
    const name = qualifiedIdentity(nameEl.text(), nameEl, lookup);
    if (name === undefined) return [];
    const sets = (schemasByName.get(schemaName)?.moduleSets ?? []).flatMap((n) => setsByName.get(n) ?? []);
    return [{ name, schema: schemaName, ...resolveSchema(sets) }];
  });
  return deepFreeze({ version: '1.1' as const, contentId: leaf(yl, 'content-id') ?? '', moduleSets, schemas, datastores });
}

/**
 * Parse an RFC 7895 `<modules-state>` element into the RFC 8525 shape: one
 * module set named `modules-state`, implemented modules (conformance-type
 * `implement`) and import-only ones (`import`), with no schemas or datastores.
 */
export function parseModulesState(ms: XmlElement): YangLibrary {
  const modules: LibraryModule[] = [];
  const importOnlyModules: ImportOnlyModule[] = [];
  for (const m of ms.childrenNamed('module', YANG_LIBRARY_NS)) {
    const name = leaf(m, 'name');
    if (name === undefined || name === '') continue;
    const revision = leaf(m, 'revision');
    const namespace = leaf(m, 'namespace') ?? '';
    const locations = leaves(m, 'schema').filter((l) => l !== '');
    const submodules: Submodule[] = m.childrenNamed('submodule', YANG_LIBRARY_NS).flatMap((sub) => {
      const subName = leaf(sub, 'name');
      return subName === undefined ? [] : [{ name: subName, ...optional('revision', leaf(sub, 'revision')), locations: leaves(sub, 'schema').filter((l) => l !== '') }];
    });
    if (leaf(m, 'conformance-type') === 'import') {
      importOnlyModules.push({ name, revision: revision ?? '', namespace, locations, submodules });
      continue;
    }
    modules.push({
      name,
      ...optional('revision', revision),
      namespace,
      locations,
      features: leaves(m, 'feature'),
      deviations: m.childrenNamed('deviation', YANG_LIBRARY_NS).flatMap((d) => leaf(d, 'name') ?? []),
      submodules,
    });
  }
  return deepFreeze({
    version: '1.0' as const,
    contentId: leaf(ms, 'module-set-id') ?? '',
    moduleSets: [{ name: 'modules-state', modules, importOnlyModules }],
    schemas: [],
    datastores: [],
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** The server advertises a YANG library: `:yang-library:1.1` or `:yang-library:1.0`. */
export function hasYangLibrary(ctx: Pick<ExtensionContext, 'serverCapabilities'>): boolean {
  return ctx.serverCapabilities.has(':yang-library:1.1') || ctx.serverCapabilities.has(':yang-library:1.0');
}

/**
 * Read the library with a `<get>` (no caching): `/yang-library` on a
 * `:yang-library:1.1` server, `/modules-state` on one with only
 * `:yang-library:1.0`. Most callers want the shared {@link loadYangLibrary}.
 */
export async function readYangLibrary(ctx: ExtensionContext, options: RpcOptions = {}): Promise<YangLibrary> {
  const legacy = !ctx.serverCapabilities.has(':yang-library:1.1') && ctx.serverCapabilities.has(':yang-library:1.0');
  const top = legacy ? 'modules-state' : 'yang-library';
  const reply = await ctx.invoke(get({ filter: subtree(x(top, { xmlns: YANG_LIBRARY_NS })) }), options);
  const data = reply.data;
  const el = data?.child(top, YANG_LIBRARY_NS);
  if (legacy) return parseModulesState(el ?? x('modules-state', { xmlns: YANG_LIBRARY_NS }));
  if (data === undefined || el === undefined) return parseYangLibrary(x('yang-library', { xmlns: YANG_LIBRARY_NS }));
  return parseYangLibrary(el, ctx.moduleOf);
}

// --- one read per session ------------------------------------------------------------------------

interface SharedRead {
  /** The read callers wait on now (the newest one started). */
  current: Promise<YangLibrary> | undefined;
  /** Reads started, and the newest one whose result is in `latest`. */
  started: number;
  applied: number;
  latest: YangLibrary | undefined;
}

const shared = new WeakMap<object, SharedRead>();

function sharedFor(ctx: ExtensionContext): SharedRead {
  let entry = shared.get(ctx.sessionKey);
  if (entry === undefined) {
    entry = { current: undefined, started: 0, applied: 0, latest: undefined };
    shared.set(ctx.sessionKey, entry);
  }
  return entry;
}

/**
 * The session's YANG library, read once and shared by everything on the
 * session (this module, `client.content.loadModules()`, other modules' support
 * checks). Once a read has succeeded, later calls resolve with it and send
 * nothing, even after a failed refresh; only `refresh` reads again. A failed
 * read isn't kept. Concurrent callers share one read, which runs under the
 * session's own RPC timeout and no caller's signal; each caller stops waiting
 * when its own signal aborts or its own timeout passes (an already-aborted
 * signal sends nothing), without failing the others.
 *
 * A server that answers with an empty library (none configured, or hidden by
 * access control) is taken at its word for the session, as a successful read.
 * Doesn't check capabilities: see {@link hasYangLibrary}.
 */
export function loadYangLibrary(ctx: ExtensionContext, options: YangLibraryLoadOptions = {}): Promise<YangLibrary> {
  if (options.signal?.aborted === true) return Promise.reject(new AbortError('Reading the YANG library was aborted', { cause: options.signal.reason }));
  const entry = sharedFor(ctx);
  if (options.refresh !== true && entry.latest !== undefined) return Promise.resolve(entry.latest);
  if (entry.current === undefined || options.refresh === true) {
    const seq = ++entry.started;
    // Shared, so no one caller's timeout or signal applies to it (they are raced below).
    const reading = readYangLibrary(ctx).then((library) => {
      // An older read finishing after a newer one doesn't replace it; a failed refresh keeps the last good one.
      if (seq > entry.applied) {
        entry.applied = seq;
        entry.latest = library;
      }
      return library;
    });
    entry.current = reading;
    reading.catch(() => {
      if (entry.current === reading) entry.current = undefined;
    });
  }
  return raceTimeout(raceSignal(entry.current, options.signal, 'Reading the YANG library'), options.timeout);
}

/** The session's library from the newest successful read so far, without sending anything. */
export function cachedYangLibrary(ctx: ExtensionContext): YangLibrary | undefined {
  return shared.get(ctx.sessionKey)?.latest;
}

// --- the extension --------------------------------------------------------------------------------

const YANG_LIBRARY_READ: OperationDescriptor = Object.freeze({
  name: 'yang-library',
  kind: 'read',
  namespace: YANG_LIBRARY_NS,
  method: 'load',
  description: "The YANG modules the server implements, per datastore (RFC 8525, or RFC 7895's /modules-state)",
  mutates: false,
  requires: Object.freeze([]),
  params: Object.freeze([
    Object.freeze({ name: 'refresh', kind: 'option', type: 'boolean', description: 'Read the library again instead of using what this session already read' } as const),
  ]),
});

/**
 * The YANG library extension (RFC 8525, with the RFC 7895 fallback).
 * Enable it with `connect({ extensions: [yangLibrary] })`. It needs no
 * capability to be enabled; `client.content.yangLibrary.load()` needs `:yang-library:1.1` or
 * `:yang-library:1.0`.
 */
export const yangLibrary = defineExtension({
  id: 'yangLibrary',
  description: 'RFC 8525 (and RFC 7895): the YANG modules a server implements, per datastore',
  descriptors: [YANG_LIBRARY_READ],
  content: (ctx): YangLibraryContent => {
    const caps = ctx.serverCapabilities;
    return {
      contentId: caps.get(YANG_LIBRARY_1_1)?.params.get('content-id') ?? caps.get(YANG_LIBRARY_1_0)?.params.get('module-set-id'),
      load: async (options = {}) => {
        if (!hasYangLibrary(ctx) && ctx.capabilityCheck !== 'off') {
          if (ctx.capabilityCheck === 'strict') throw new CapabilityError(':yang-library:1.1 or :yang-library:1.0', 'yang-library');
          ctx.logger.warn?.("yang-library needs :yang-library:1.1 or :yang-library:1.0, which the server didn't advertise; reading anyway");
        }
        return loadYangLibrary(ctx, options);
      },
    };
  },
});
