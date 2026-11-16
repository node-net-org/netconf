/**
 * Module name ↔ XML namespace for one session, in one order for every layer
 * (the path API and the JSON conversion alike):
 *
 * 1. `connect({ namespaces })`,
 * 2. the device profile's `namespaces`,
 * 3. the server's hello,
 * 4. the server's YANG library, once the session has read it.
 *
 * What you set beats what the profile sets, which beats what the server says.
 * The first three are known when the session opens, so the library only
 * answers modules none of them knows: reading it never changes an answer
 * already given. Reading the library (when nothing knows a module) is the
 * caller's step; see `ClientContent.loadModules()`.
 */

import type { DeviceProfile } from './devices/index.js';
import type { Session } from './messages/index.js';
import { FrozenMap } from './frozen-map.js';
import { cachedYangLibrary, type YangLibrary } from './operations/yang-library.js';
import type { ExtensionContext } from './operations/index.js';

/** @internal What ModuleNamespaces needs from the client that builds it. */
export interface ModuleNamespacesInit {
  readonly session: Session;
  /** Read lazily: the context is built after this object. */
  readonly ctx: () => ExtensionContext;
  readonly profile: DeviceProfile | undefined;
  readonly namespaces: Readonly<Record<string, string>>;
}

/** Where a module's namespace came from, in lookup order. */
export type NamespaceSource = 'given' | 'profile' | 'hello' | 'library';

/** A module's namespace as the session uses it, and where it came from. */
export interface ModuleNamespaceInfo {
  /** The namespace the session uses for the module. */
  readonly namespace: string;
  /**
   * The source it came from: `given` is `connect({ namespaces })`, `profile`
   * the device profile's `namespaces`, `hello` the server's hello, `library`
   * its YANG library.
   */
  readonly source: NamespaceSource;
  /**
   * Later sources that gave the module a different namespace, in lookup
   * order; absent when none did.
   */
  readonly overrides?: readonly {
    /** The source that gave the other namespace. */
    readonly source: NamespaceSource;
    /** The namespace it gave, which the session doesn't use. */
    readonly namespace: string;
  }[];
}

interface Maps {
  readonly byName: ReadonlyMap<string, string>;
  readonly byNamespace: ReadonlyMap<string, string>;
  /** Every module this layer knows, in lookup order, with where it came from. */
  readonly info: ReadonlyMap<string, ModuleNamespaceInfo>;
  /** `info` without the sources. */
  readonly namespaces: ReadonlyMap<string, string>;
}

/** Builds one layer's maps from candidates added in lookup order. */
class MapsBuilder {
  readonly byName = new Map<string, string>();
  readonly byNamespace = new Map<string, string>();
  readonly #entries = new Map<string, { namespace: string; source: NamespaceSource; overrides: { source: NamespaceSource; namespace: string }[] }>();

  /** Start from `base`'s modules, so later candidates add to them. */
  constructor(base?: Maps) {
    if (base === undefined) return;
    for (const [name, ns] of base.byName) this.byName.set(name, ns);
    for (const [ns, name] of base.byNamespace) this.byNamespace.set(ns, name);
    for (const [name, i] of base.info) {
      this.#entries.set(name, { namespace: i.namespace, source: i.source, overrides: [...(i.overrides ?? [])] });
    }
  }

  /** Add a candidate; undefined when it was used, else the namespace it lost to. */
  add(name: string, namespace: string, source: NamespaceSource): string | undefined {
    if (namespace === '') return undefined;
    if (!this.byNamespace.has(namespace)) this.byNamespace.set(namespace, name);
    const entry = this.#entries.get(name);
    if (entry === undefined) {
      this.byName.set(name, namespace);
      this.#entries.set(name, { namespace, source, overrides: [] });
      return undefined;
    }
    if (!this.byName.has(name)) this.byName.set(name, namespace);
    if (entry.namespace === namespace) return undefined;
    if (!entry.overrides.some((o) => o.source === source && o.namespace === namespace)) entry.overrides.push({ source, namespace });
    return entry.namespace;
  }

  build(): Maps {
    const info = new FrozenMap(
      [...this.#entries].map(([name, e]): [string, ModuleNamespaceInfo] => [
        name,
        Object.freeze({
          namespace: e.namespace,
          source: e.source,
          ...(e.overrides.length > 0 ? { overrides: Object.freeze(e.overrides.map((o) => Object.freeze(o))) } : {}),
        }),
      ]),
    );
    const namespaces = new FrozenMap([...info].map(([name, i]): [string, string] => [name, i.namespace]));
    return { byName: this.byName, byNamespace: this.byNamespace, info, namespaces };
  }
}

/** No modules: the library's own list before the session has read it. */
const EMPTY: Maps = new MapsBuilder().build();

/** @internal The session's module namespaces. */
export class ModuleNamespaces {
  readonly #init: ModuleNamespacesInit;
  #fixed: Maps | undefined;
  /** Each fixed source's own list, every module it names, whether or not it wins. */
  #fixedSources: Readonly<Record<'given' | 'profile' | 'hello', Maps>> | undefined;
  #fromLibrary: { readonly library: YangLibrary; readonly maps: Maps; readonly all: Maps } | undefined;

  constructor(init: ModuleNamespacesInit) {
    this.#init = init;
  }

  /** A module's namespace, or undefined if no source knows the module. */
  namespaceOf(module: string): string | undefined {
    return this.#fixedMaps().byName.get(module) ?? this.#library()?.maps.byName.get(module);
  }

  /** The module a namespace belongs to, or undefined if no source knows it. */
  moduleOf(namespace: string): string | undefined {
    return this.#fixedMaps().byNamespace.get(namespace) ?? this.#library()?.maps.byNamespace.get(namespace);
  }

  /** Every module any source knows, in lookup order, each with the namespace namespaceOf() gives. */
  all(): ReadonlyMap<string, string> {
    return (this.#library()?.all ?? this.#fixedMaps()).namespaces;
  }

  /** all(), with each namespace's source and the namespaces it overrode. */
  info(): ReadonlyMap<string, ModuleNamespaceInfo> {
    return (this.#library()?.all ?? this.#fixedMaps()).info;
  }

  /**
   * One source's whole list, in its own order: every module it names, with
   * the namespace it gives, whether or not that namespace is the one used.
   * `library` is empty until the session has read the library.
   */
  sourceInfo(source: NamespaceSource): ReadonlyMap<string, ModuleNamespaceInfo> {
    return this.#sourceMaps(source).info;
  }

  /** sourceInfo() without the sources: name → the namespace the source gives. */
  sourceAll(source: NamespaceSource): ReadonlyMap<string, string> {
    return this.#sourceMaps(source).namespaces;
  }

  #sourceMaps(source: NamespaceSource): Maps {
    if (source === 'library') return this.#library()?.maps ?? EMPTY;
    if (source !== 'given' && source !== 'profile' && source !== 'hello') {
      throw new TypeError(`Unknown namespace source ${JSON.stringify(source)}: expected given, profile, hello or library`);
    }
    this.#fixedMaps();
    return this.#fixedSources![source];
  }

  /** connect({ namespaces }), then the profile, then the hello: fixed for the session. */
  #fixedMaps(): Maps {
    if (this.#fixed !== undefined) return this.#fixed;
    const { session, profile, namespaces } = this.#init;
    const b = new MapsBuilder();
    const given = new MapsBuilder();
    const fromProfile = new MapsBuilder();
    const hello = new MapsBuilder();
    for (const [name, ns] of Object.entries(namespaces)) {
      given.add(name, ns, 'given');
      b.add(name, ns, 'given');
    }
    for (const [name, ns] of Object.entries(profile?.namespaces ?? {})) {
      fromProfile.add(name, ns, 'profile');
      b.add(name, ns, 'profile');
    }
    for (const m of session.serverCapabilities.helloModules) {
      hello.add(m.name, m.namespace, 'hello');
      const used = b.add(m.name, m.namespace, 'hello');
      if (used !== undefined) {
        session.logger.debug?.(`The namespace given for module ${m.name} overrides the one in the server's hello`, {
          module: m.name,
          given: used,
          hello: m.namespace,
        });
      }
    }
    this.#fixedSources = { given: given.build(), profile: fromProfile.build(), hello: hello.build() };
    this.#fixed = b.build();
    return this.#fixed;
  }

  /**
   * The session's newest library read, if there has been one: `maps` is the
   * library's own lookup (namespaceOf() asks the fixed layer first), `all`
   * the fixed layer with the library added after it.
   */
  #library(): { readonly maps: Maps; readonly all: Maps } | undefined {
    const library = cachedYangLibrary(this.#init.ctx());
    if (library === undefined) return undefined;
    if (this.#fromLibrary?.library === library) return this.#fromLibrary;
    const fixed = this.#fixedMaps();
    const own = new MapsBuilder();
    const all = new MapsBuilder(fixed);
    const logged = new Set<string>();
    for (const holder of [...library.datastores, ...library.moduleSets]) {
      for (const m of [...holder.modules, ...holder.importOnlyModules]) {
        own.add(m.name, m.namespace, 'library');
        const used = all.add(m.name, m.namespace, 'library');
        if (used !== undefined && fixed.byName.has(m.name) && !logged.has(m.name)) {
          logged.add(m.name);
          this.#init.session.logger.debug?.(`Module ${m.name}'s namespace in the server's YANG library differs from an earlier source, which wins`, {
            module: m.name,
            used,
            library: m.namespace,
          });
        }
      }
    }
    this.#fromLibrary = { library, maps: own.build(), all: all.build() };
    return this.#fromLibrary;
  }
}
