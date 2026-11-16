/**
 * RFC 7951 JSON output for a NetconfClient (design §3.5): where its YANG
 * schemas come from, and the conversion `format: 'json'` runs.
 *
 * Module text comes from, in order: the modules given to `connect({ yang })`,
 * the device profile's `yang.modules`, the IETF modules bundled with
 * @node-net/yang, and `<get-schema>` when the server supports it (RFC 6022). The
 * module list comes from the server's YANG library, read once per session
 * and shared with the path API, or else from its hello.
 */

import type { DeviceProfile } from './devices/index.js';
import { AbortError, SessionClosedError, TimeoutError } from './errors.js';
import { NETCONF_NS, RpcError, type Session } from './messages/index.js';
import type { ExtensionContext, JsonDatastore, ToJsonOptions, ToXmlOptions, YangJsonObject } from './operations/index.js';
import { DATASTORES_NS } from './operations/identities.js';
import { getSchemaRequest, MONITORING_NS } from './operations/monitoring.js';
import { hasYangLibrary, loadYangLibrary, type YangLibrary } from './operations/yang-library.js';
import type { XmlElement } from './xml/index.js';
import type { ModuleNamespaces } from './module-namespaces.js';
import type { DeclaredFeature } from './client-content.js';
import {
  ANNOTATION_MODULES_BY_NAME,
  ANNOTATION_NAMESPACES,
  loadYang,
  YangCache,
  type DataDifference,
  type ModuleSource,
  type SchemaContext,
  type SchemaLibrary,
} from './yang/index.js';

/** `connect({ yang })`: YANG schemas for RFC 7951 JSON output. */
export interface YangOptions {
  /**
   * YANG modules to use before any other source: one or more directories of
   * `.yang` or `.yin` files (named `module.yang` or `module@revision.yang`), or a
   * @node-net/yang `ModuleSource`. Give them for modules the server can't serve,
   * such as on a server without `<get-schema>`.
   */
  readonly modules?: string | readonly string[] | ModuleSource;
  /**
   * Refuse to convert data without a YANG schema (see `JsonOptions.requireSchema`).
   * Overrides the device profile's `yang.requireSchema`; a call's own option overrides this.
   */
  readonly requireSchema?: boolean;
  /**
   * Share fetched module text and compiled schemas with other clients given
   * the same cache. Default: a cache for this client alone.
   */
  readonly cache?: YangCache;
}

/** @internal What ClientYang needs from the client that builds it. */
export interface ClientYangInit {
  readonly session: Session;
  /** Read lazily: the context is built after this object, and its toJson calls back here. */
  readonly ctx: () => ExtensionContext;
  readonly profile: DeviceProfile | undefined;
  readonly options: YangOptions | undefined;
  /** The session's module namespaces, shared with the path API. */
  readonly moduleNamespaces: ModuleNamespaces;
  readonly host: ClientHost;
}

/**
 * @internal What the runtime offers the client beyond the portable core. The
 * Node entry gives a way to read YANG module directories; @node-net/netconf/core
 * gives nothing, and directories are then refused with a clear error.
 */
export interface ClientHost {
  readonly directories?: (dirs: readonly string[]) => ModuleSource;
}

/** @internal The client's JSON conversion. */
export class ClientYang {
  readonly #init: ClientYangInit;
  readonly #schema: SchemaContext;
  readonly #requireSchema: boolean;
  #hello: SchemaLibrary | undefined;

  constructor(init: ClientYangInit) {
    this.#init = init;
    const { options, profile } = init;
    this.#requireSchema = options?.requireSchema ?? profile?.yang?.requireSchema ?? false;
    const given = options?.modules;
    const own: ModuleSource[] = [];
    const key: unknown[] = [];
    const directories = (dirs: readonly string[], whose: string): ModuleSource => {
      if (init.host.directories === undefined) {
        throw new TypeError(
          `${whose} names YANG module directories, which only the Node entry, @node-net/netconf, can read; ` +
            'with @node-net/netconf/core, give the modules as a ModuleSource in connect({ yang: { modules } }) instead',
        );
      }
      return init.host.directories(dirs);
    };
    if (typeof given === 'string' || Array.isArray(given)) {
      const dirs = typeof given === 'string' ? [given] : (given as readonly string[]);
      own.push(directories(dirs, 'connect({ yang: { modules } })'));
      key.push(dirs);
    } else if (given !== undefined) {
      own.push(given as ModuleSource);
      key.push(`source#${sourceId(given as ModuleSource)}`);
    }
    const profileDirs = profile?.yang?.modules ?? [];
    if (profileDirs.length > 0) {
      own.push(directories(profileDirs, `Device profile ${profile!.id}`));
      key.push(profileDirs);
    }
    this.#schema = {
      library: () => this.#library(),
      source: chainSources(...own, BUILTIN_SOURCE, this.#getSchemaSource()),
      sourceKey: JSON.stringify(key),
      moduleOf: (ns) => this.#moduleOf(ns),
      namespaceOf: (module) => this.#namespaceOf(module),
      warn: (message) => init.session.warn(message),
      cache: options?.cache ?? new YangCache(),
    };
  }

  /** Convert YANG data in XML to RFC 7951 JSON. */
  toJson = async (data: XmlElement, options: ToJsonOptions = {}): Promise<YangJsonObject> => {
    if (options.operation !== undefined) {
      const { convertOperation } = await loadYang();
      return convertOperation(this.#schema, data, {
        operation: options.operation,
        datastore: this.#datastoreName(options.datastore ?? 'operational'),
        requireSchema: options.requireSchema ?? this.#requireSchema,
        hint: options.hint,
      });
    }
    const { convertData } = await loadYang();
    return convertData(this.#schema, data, {
      datastore: this.#datastoreName(options.datastore ?? 'operational'),
      requireSchema: options.requireSchema ?? this.#requireSchema,
      scope: options.scope,
      hint: options.hint,
    });
  };

  /** Convert RFC 7951 JSON to XML: edit content, or with `filter`, subtree-filter content. */
  toXml = async (json: YangJsonObject, options: ToXmlOptions = {}): Promise<XmlElement[]> => {
    if (options.operation !== undefined || options.action === true) {
      if (options.filter === true) throw new TypeError('toXml: filter is for data, not operation input');
      const { encodeOperation } = await loadYang();
      return encodeOperation(this.#schema, json, {
        datastore: this.#datastoreName(options.datastore ?? 'operational'),
        requireSchema: options.requireSchema ?? this.#requireSchema,
        validate: options.validate ?? true,
        operation: options.operation,
      });
    }
    const { encodeData } = await loadYang();
    return encodeData(this.#schema, json, {
      datastore: this.#datastoreName(options.datastore ?? 'running'),
      requireSchema: options.requireSchema ?? this.#requireSchema,
      validate: options.validate ?? true,
      filter: options.filter ?? false,
    });
  };

  /** The changes that turn the YANG data in `from` into the data in `to`, typed with `datastore`'s schema. */
  diff = async (from: XmlElement, to: XmlElement, datastore: 'running' | 'candidate' | 'startup'): Promise<DataDifference[]> => {
    const { diffData } = await loadYang();
    return diffData(this.#schema, from, to, { datastore });
  };

  /**
   * Every feature each named module's source declares, with whether the
   * server supports it, from the schema of `selector`'s datastore or library
   * schema. A module whose source can't be found or compiled isn't in the map.
   */
  declaredFeatures = async (
    selector: { readonly datastore?: JsonDatastore; readonly schema?: string },
    modules: readonly string[],
  ): Promise<ReadonlyMap<string, readonly DeclaredFeature[]>> => {
    const out = new Map<string, readonly DeclaredFeature[]>();
    const { compile } = await loadYang();
    let library = await this.#library();
    // As modules(): a library listing no modules gives way to the hello.
    if (library !== undefined && !library.moduleSets.some((s) => s.modules.length > 0)) library = await this.#helloLibrary();
    if (library === undefined || modules.length === 0) return out;
    // A library listing no schemas (RFC 7895, or Clixon's 1.1 library) is one schema of every module set.
    if (library.schemas.length === 0) library = { ...library, schemas: [{ name: 'all', moduleSets: library.moduleSets.map((s) => s.name) }] };
    const servers = await compile(this.#schema, library, modules);
    const schema = selector.schema !== undefined
      ? servers.schemas.get(selector.schema)
      : servers.datastore(this.#datastoreName(selector.datastore ?? 'running'));
    for (const name of modules) {
      const m = schema?.module(name);
      if (m === undefined || !m.implemented) continue;
      out.set(name, [...m.features.values()].map((f) => ({ name: f.name, supported: f.enabled })));
    }
    return out;
  };

  /** The server's modules: its YANG library (shared with the path API), or else its hello. */
  async #library(): Promise<SchemaLibrary | undefined> {
    const { session } = this.#init;
    if (hasYangLibrary(session)) {
      try {
        const library = await loadYangLibrary(this.#init.ctx());
        return toSchemaLibrary(library);
      } catch (err) {
        if (err instanceof AbortError || err instanceof SessionClosedError || err instanceof TimeoutError) throw err;
        session.logger.warn?.('JSON output: reading the YANG library failed, so the modules come from the hello', { err });
      }
    }
    const hello = await this.#helloLibrary();
    return hello.moduleSets.some((s) => s.modules.length > 0) ? hello : undefined;
  }

  async #helloLibrary(): Promise<SchemaLibrary> {
    if (this.#hello === undefined) {
      const { fromCapabilities } = await loadYang();
      this.#hello ??= fromCapabilities(this.#init.session.serverCapabilities.toArray());
    }
    return this.#hello;
  }

  /** `<get-schema>`, when the server supports it. A module it refuses is reported as not found. */
  #getSchemaSource(): ModuleSource {
    return {
      load: async (name, revision) => {
        const { session } = this.#init;
        if (!session.serverCapabilities.has(MONITORING_NS)) return undefined;
        try {
          const request = getSchemaRequest({ identifier: name, ...(revision !== undefined ? { version: revision } : {}) });
          const reply = await this.#init.ctx().invoke(request);
          const data = reply.element.child('data', MONITORING_NS) ?? reply.element.child('data', NETCONF_NS);
          const text = data?.textContent() ?? '';
          if (text.trim() === '') return undefined;
          return { text, source: `<get-schema> ${name}${revision !== undefined ? `@${revision}` : ''}` };
        } catch (err) {
          if (err instanceof RpcError) return undefined;
          throw err;
        }
      },
    };
  }

  /** A namespace's module, in the session's order (see ModuleNamespaces), else an annotation module's. */
  #moduleOf(ns: string): string | undefined {
    return this.#init.moduleNamespaces.moduleOf(ns) ?? ANNOTATION_NAMESPACES[ns];
  }

  /** A module's namespace, in the session's order (see ModuleNamespaces), else an annotation module's. */
  #namespaceOf(module: string): string | undefined {
    return this.#init.moduleNamespaces.namespaceOf(module) ?? ANNOTATION_MODULES_BY_NAME[module];
  }

  /** A datastore as the schema lookup names it: `running`, or `module:identity`. */
  #datastoreName(ds: JsonDatastore): string {
    if (typeof ds === 'string') return ds;
    if (ds.namespace === DATASTORES_NS) return ds.name;
    return `${this.#moduleOf(ds.namespace) ?? ds.namespace}:${ds.name}`;
  }
}

/**
 * The IETF modules bundled with @node-net/yang, loaded with the rest of the YANG
 * machinery the first time a module is looked up.
 */
const BUILTIN_SOURCE: ModuleSource = {
  load: async (name, revision) => (await loadYang()).builtinSource.load(name, revision),
};

/** Tries each source in turn (@node-net/yang's chainSources, without loading @node-net/yang for it). */
function chainSources(...sources: readonly ModuleSource[]): ModuleSource {
  return {
    async load(name, revision) {
      for (const source of sources) {
        const found = await source.load(name, revision);
        if (found !== undefined) return found;
      }
      return undefined;
    },
  };
}

const sourceIds = new WeakMap<ModuleSource, number>();
let nextSourceId = 1;

function sourceId(source: ModuleSource): number {
  let id = sourceIds.get(source);
  if (id === undefined) {
    id = nextSourceId++;
    sourceIds.set(source, id);
  }
  return id;
}

const schemaLibraries = new WeakMap<YangLibrary, SchemaLibrary>();

/**
 * @node-net/netconf's reading of a YANG library, in the shape @node-net/yang compiles
 * from. Built once per library object: a session's library is
 * one object until it is read again, and the schema cache's views of it are
 * kept per object too.
 */
export function toSchemaLibrary(library: YangLibrary): SchemaLibrary {
  let out = schemaLibraries.get(library);
  if (out === undefined) {
    out = buildSchemaLibrary(library);
    schemaLibraries.set(library, out);
  }
  return out;
}

function buildSchemaLibrary(library: YangLibrary): SchemaLibrary {
  const rev = <T extends { readonly revision?: string | undefined }>(m: T): { readonly revision?: string } =>
    m.revision === undefined || m.revision === '' ? {} : { revision: m.revision };
  return {
    format: library.version === '1.1' ? 'yang-library' : 'modules-state',
    ...(library.contentId !== '' ? { contentId: library.contentId } : {}),
    moduleSets: library.moduleSets.map((set) => {
      const revisions = new Map(set.modules.map((m) => [m.name, m.revision]));
      return {
        name: set.name,
        modules: set.modules.map((m) => ({
          name: m.name,
          ...rev(m),
          namespace: m.namespace,
          features: m.features,
          deviations: m.deviations.map((d) => ({ name: d, ...rev({ revision: revisions.get(d) }) })),
          submodules: m.submodules.map((s) => ({ name: s.name, ...rev(s) })),
          locations: m.locations,
        })),
        importOnly: set.importOnlyModules.map((m) => ({
          name: m.name,
          ...rev(m),
          namespace: m.namespace,
          submodules: m.submodules.map((s) => ({ name: s.name, ...rev(s) })),
          locations: m.locations,
        })),
      };
    }),
    schemas: library.schemas.map((s) => ({ name: s.name, moduleSets: s.moduleSets })),
    datastores: library.datastores.map((d) => ({
      name: d.name,
      schema: d.schema,
    })),
  };
}
