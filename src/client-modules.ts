/**
 * Module and datastore discovery, and path resolution, for `client.content`
 * (design §3.1, §6.4). ClientContent delegates to this; nothing else uses it.
 * Paths resolve against the module namespaces, and an unknown module may be
 * found in the YANG library, so the two live together.
 */

import { PathError, compileNamedPath, expandNamedPath, parseNamedPathCall, resolvePath } from './content/index.js';
import type { MissingParams, NamedPathTemplate, ResolvedStep } from './content/index.js';
import type { DeviceProfile } from './devices/index.js';
import { AbortError, SchemaUnavailableError } from './errors.js';
import type { RpcOptions, Session } from './messages/index.js';
import type { ModuleNamespaceInfo, ModuleNamespaces, NamespaceSource } from './module-namespaces.js';
import type { ExtensionContext } from './operations/index.js';
import { datastoreIdentity, DATASTORES_NS, type DatastoreRef } from './operations/identities.js';
import {
  cachedYangLibrary,
  findDatastore,
  hasYangLibrary,
  loadYangLibrary,
  schemaModules,
  type ImportOnlyModule,
  type LibraryDatastore,
  type LibraryModule,
  type Submodule,
} from './operations/yang-library.js';

/** Where `datastores()` learned the list: the YANG library, or the hello's capabilities. */
export type DatastoreSource = 'yang-library' | 'capabilities';

/** A datastore the server has. */
export interface ServerDatastore {
  /**
   * The datastore identity, module-qualified as RFC 7951 writes it:
   * `ietf-datastores:running`, or another module's, such as
   * `ietf-factory-default:factory-default`.
   */
  readonly name: string;
  /** The YANG library schema the datastore uses; only when the list came from the library. */
  readonly schema?: string;
}

/** What `datastores()` resolves with. */
export interface ServerDatastores {
  /** Where the list came from: the YANG library, or the hello's capabilities. */
  readonly source: DatastoreSource;
  /** The datastores the server has. */
  readonly datastores: readonly ServerDatastore[];
}

/** A feature a module's YANG source declares, and whether the server supports it. */
export interface DeclaredFeature {
  /** The feature's name. */
  readonly name: string;
  /** Whether the server reports it supports the feature. */
  readonly supported: boolean;
}

/** A YANG module the server has, as `modules()` lists it. */
export interface ServerModule {
  /** The module's name. */
  readonly name: string;
  /** Absent when the module has no revision. */
  readonly revision?: string;
  /** The XML namespace the module defines, or `''` if the server sent none. */
  readonly namespace: string;
  /** `implement`: its nodes are part of the schema. `import`: only its definitions are used, by modules that import it. */
  readonly conformance: 'implement' | 'import';
  /** The features the server reports it supports. Always empty for an import-only module. */
  readonly features: readonly string[];
  /** Names of the modules that deviate it. */
  readonly deviations: readonly string[];
  /** The submodules the server uses. */
  readonly submodules: readonly Submodule[];
  /** URLs of its source, if the server offers any. */
  readonly locations: readonly string[];
  /** With `declared: true`: every feature its source declares, with whether the server supports it. Absent when the source wasn't found. */
  readonly declared?: readonly DeclaredFeature[];
  /** With `declared: true`: features the server reports that the source doesn't declare. */
  readonly undeclared?: readonly string[];
}

/** What `modules()` resolves with. */
export interface ServerModules {
  /** Where the list came from: the YANG library, or the hello's module capabilities. */
  readonly source: DatastoreSource;
  /** The YANG library schema the modules belong to, when the library names its schemas. */
  readonly schema?: string;
  /** The modules, in the order the server lists them. */
  readonly modules: readonly ServerModule[];
}

/** Options for `modules()`. */
export interface ModulesOptions extends RpcOptions {
  /** The datastore whose modules to list (default `running`). Not with `schema`. */
  readonly datastore?: DatastoreRef;
  /** A YANG library schema by name, instead of a datastore. */
  readonly schema?: string;
  /** Only the modules with this name. */
  readonly module?: string;
  /** Read and compile each implemented module's source, adding `declared` and `undeclared`. */
  readonly declared?: boolean;
  /** Read the YANG library again instead of using this session's read. */
  readonly refresh?: boolean;
}

/** @internal What ClientModules needs from the client. */
export interface ClientModulesInit {
  readonly session: Session;
  readonly profile: DeviceProfile | undefined;
  readonly moduleNamespaces: ModuleNamespaces;
  readonly ctx: ExtensionContext;
  /** Each module's declared features from its compiled source (the client's ClientYang.declaredFeatures). */
  readonly declaredFeatures: (
    selector: { readonly datastore?: { readonly name: string; readonly namespace: string }; readonly schema?: string },
    modules: readonly string[],
  ) => Promise<ReadonlyMap<string, readonly DeclaredFeature[]>>;
}

/**
 * @internal The session's modules, datastores and path resolution, behind
 * `client.content`'s methods of the same names (which carry the docs).
 */
export class ClientModules {
  readonly #init: ClientModulesInit;
  /** Named-path templates, compiled on first use. */
  readonly #templates = new Map<string, NamedPathTemplate>();

  constructor(init: ClientModulesInit) {
    this.#init = init;
  }

  namespaceOf(module: string): string | undefined {
    return this.#init.moduleNamespaces.namespaceOf(module);
  }

  moduleOf(namespace: string): string | undefined {
    return this.#init.moduleNamespaces.moduleOf(namespace);
  }

  namespaces(source: NamespaceSource | undefined): ReadonlyMap<string, string> {
    return source === undefined ? this.#init.moduleNamespaces.all() : this.#init.moduleNamespaces.sourceAll(source);
  }

  namespacesInfo(source: NamespaceSource | undefined): ReadonlyMap<string, ModuleNamespaceInfo> {
    return source === undefined ? this.#init.moduleNamespaces.info() : this.#init.moduleNamespaces.sourceInfo(source);
  }

  async load(options: RpcOptions & { readonly refresh?: boolean }): Promise<ReadonlyMap<string, string>> {
    // Without the capability nothing is read, but a library read anyway (capabilityCheck 'off') still counts.
    if (hasYangLibrary(this.#init.session)) await loadYangLibrary(this.#init.ctx, options);
    return this.namespaces(undefined);
  }

  async datastores(options: RpcOptions & { readonly refresh?: boolean }): Promise<ServerDatastores> {
    const caps = this.#init.session.serverCapabilities;
    if (caps.has(':yang-library:1.1')) {
      const library = await loadYangLibrary(this.#init.ctx, options);
      if (library.version === '1.1' && library.datastores.length > 0) {
        return {
          source: 'yang-library',
          datastores: library.datastores.map((d) => ({ name: d.name, schema: d.schema })),
        };
      }
    }
    const names = ['running', ...(caps.has(':candidate') ? ['candidate'] : []), ...(caps.has(':startup') ? ['startup'] : [])];
    return { source: 'capabilities', datastores: names.map((name) => ({ name: `ietf-datastores:${name}` })) };
  }

  async modules(options: ModulesOptions): Promise<ServerModules> {
    const { datastore, schema, module, declared, refresh, ...rpc } = options;
    if (datastore !== undefined && schema !== undefined) throw new TypeError('modules(): give datastore or schema, not both');
    const ds = datastoreIdentity(datastore ?? 'running');
    const dsName = ds.namespace === DATASTORES_NS ? ds.name : `${ds.namespace}:${ds.name}`;
    let resolved: { source: DatastoreSource; schema?: string; modules: ServerModule[] } | undefined;

    if (hasYangLibrary(this.#init.session)) {
      const library = await loadYangLibrary(this.#init.ctx, { ...rpc, ...(refresh === undefined ? {} : { refresh }) });
      if (library.moduleSets.some((s) => s.modules.length > 0)) {
        let picked: Pick<LibraryDatastore, 'modules' | 'importOnlyModules'>;
        let schemaName: string | undefined;
        if (schema !== undefined) {
          if (library.schemas.length === 0) throw new SchemaUnavailableError(`modules(): the server's YANG library names no schemas, so there is no schema ${JSON.stringify(schema)}`);
          const found = schemaModules(library, schema);
          if (found === undefined) throw new SchemaUnavailableError(`modules(): the server's YANG library has no schema ${JSON.stringify(schema)}`);
          picked = found;
          schemaName = schema;
        } else if (library.datastores.length > 0) {
          const found = findDatastore(library, ds);
          if (found === undefined) throw new SchemaUnavailableError(`modules(): the server's YANG library doesn't list datastore ${dsName}`);
          picked = found;
          schemaName = found.schema;
        } else {
          picked = schemaModules(library)!;
        }
        resolved = {
          source: 'yang-library',
          ...(schemaName === undefined ? {} : { schema: schemaName }),
          modules: [...picked.modules.map(implemented), ...picked.importOnlyModules.map(importOnly)],
        };
      }
    }
    if (resolved === undefined) {
      if (schema !== undefined) throw new SchemaUnavailableError(`modules(): the server has no YANG library, so there is no schema ${JSON.stringify(schema)}`);
      const modules = this.#init.session.serverCapabilities.helloModules.map((m): ServerModule => ({
        name: m.name,
        ...(m.revision === undefined || m.revision === '' ? {} : { revision: m.revision }),
        namespace: m.namespace,
        conformance: 'implement',
        features: m.features,
        deviations: m.deviations,
        submodules: [],
        locations: [],
      }));
      resolved = { source: 'capabilities', modules };
    }

    let modules = module === undefined ? resolved.modules : resolved.modules.filter((m) => m.name === module);
    if (declared === true) {
      const names = modules.filter((m) => m.conformance === 'implement').map((m) => m.name);
      const sources = names.length === 0 ? new Map<string, readonly DeclaredFeature[]>() : await this.#init.declaredFeatures(schema !== undefined ? { schema } : { datastore: ds }, names);
      modules = modules.map((m) => {
        if (m.conformance !== 'implement') return m;
        const features = sources.get(m.name);
        if (features === undefined) {
          this.#init.session.warn(`modules(): no YANG source found for ${m.name}${m.revision === undefined ? '' : `@${m.revision}`}, so its declared features are unknown`);
          return m;
        }
        return { ...m, declared: features, undeclared: m.features.filter((f) => !features.some((d) => d.name === f)) };
      });
    }
    return { source: resolved.source, ...(resolved.schema === undefined ? {} : { schema: resolved.schema }), modules };
  }

  /** The named path's template, compiled once. */
  namedPathTemplate(name: string): NamedPathTemplate | undefined {
    const path = this.#init.profile?.paths?.[name];
    if (path === undefined) return undefined;
    let template = this.#templates.get(name);
    if (template === undefined || template.path !== path) {
      template = compileNamedPath(path);
      this.#templates.set(name, template);
    }
    return template;
  }

  /** A named path with its parameters filled in (`missing` says what a left-out one does); any other path as given. */
  expand(path: string, missing: MissingParams): string {
    if (!path.startsWith('@')) return path;
    const call = parseNamedPathCall(path);
    const template = this.namedPathTemplate(call.name);
    if (template === undefined) throw new PathError(`No path named ${JSON.stringify(`@${call.name}`)} in the device profile`);
    return expandNamedPath(template, call, missing);
  }

  /** Resolve a path or `@alias`, pointing to loadModules() when the YANG library could know the module. */
  resolve(path: string, missing: MissingParams): ResolvedStep[] {
    const full = this.expand(path, missing);
    try {
      return resolvePath(full, (module) => this.namespaceOf(module));
    } catch (err) {
      if (err instanceof PathError && err.module !== undefined && this.#libraryCouldHelp()) {
        throw new PathError(`${err.message}. The server has a YANG library: await client.content.loadModules() first`, {
          module: err.module,
          cause: err,
        });
      }
      throw err;
    }
  }

  /** The YANG library isn't loaded yet, and the server has one. */
  #libraryCouldHelp(): boolean {
    return cachedYangLibrary(this.#init.ctx) === undefined && hasYangLibrary(this.#init.session);
  }

  /**
   * Load the YANG library if one of `paths` names a module no other source
   * knows and the library could help. Path problems are left for the caller's
   * own resolution to report; a failed read becomes that PathError's cause.
   */
  async ensure(paths: readonly string[], rpc: RpcOptions): Promise<void> {
    if (!this.#libraryCouldHelp()) return;
    let unknown: PathError | undefined;
    for (const path of paths) {
      try {
        this.resolve(path, 'drop');
      } catch (err) {
        if (err instanceof PathError && err.module !== undefined) {
          unknown = err;
          break;
        }
      }
    }
    if (unknown === undefined) return;
    try {
      await this.load(rpc);
    } catch (err) {
      if (err instanceof AbortError) throw err;
      // The message without the loadModules() hint resolve() adds.
      const original = unknown.cause instanceof PathError ? unknown.cause.message : unknown.message;
      throw new PathError(`${original}; reading the server's YANG library failed: ${(err as Error).message}`, {
        module: unknown.module!,
        cause: err,
      });
    }
  }
}

/** A library module as `modules()` lists it. */
function implemented(m: LibraryModule): ServerModule {
  return {
    name: m.name,
    ...(m.revision === undefined ? {} : { revision: m.revision }),
    namespace: m.namespace,
    conformance: 'implement',
    features: m.features,
    deviations: m.deviations,
    submodules: m.submodules,
    locations: m.locations,
  };
}

/** A library import-only module as `modules()` lists it. */
function importOnly(m: ImportOnlyModule): ServerModule {
  return {
    name: m.name,
    ...(m.revision === '' ? {} : { revision: m.revision }),
    namespace: m.namespace,
    conformance: 'import',
    features: [],
    deviations: [],
    submodules: m.submodules,
    locations: m.locations,
  };
}
