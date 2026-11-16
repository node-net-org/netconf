import { FrozenMap } from '../frozen-map.js';
import { BASE_1_0, BASE_1_1, CAPABILITY_PREFIX, type BaseVersion } from './constants.js';

/** The parts of Node's util.inspect options a custom inspector reads. */
interface InspectOptions {
  readonly depth?: number | null;
}
type Inspect = (value: unknown, options: object) => string;

/** One advertised capability URI, split into its identifier and query parameters. */
export interface Capability {
  /** The URI exactly as advertised. */
  readonly uri: string;
  /** The URI without its query string, e.g. `urn:ietf:params:netconf:capability:with-defaults:1.0`. */
  readonly id: string;
  /** Query parameters, e.g. `module`, `revision`, `basic-mode`, `content-id`. */
  readonly params: ReadonlyMap<string, string>;
}

/** A YANG module advertised in the hello (RFC 6020 §5.6.4, RFC 7950 §5.6.4). */
export interface ModuleCapability {
  /** The module name (the `module` parameter). */
  readonly name: string;
  /** The module's XML namespace (the capability URI without its query). */
  readonly namespace: string;
  /** The module revision (the `revision` parameter), if advertised. */
  readonly revision: string | undefined;
  /** The features the server supports in this module (the `features` parameter); empty if none. */
  readonly features: readonly string[];
  /** The modules that deviate this one (the `deviations` parameter); empty if none. */
  readonly deviations: readonly string[];
}

/** Parses a capability URI. The result is frozen, params included. */
export function parseCapability(uri: string): Capability {
  const q = uri.indexOf('?');
  const id = q === -1 ? uri : uri.slice(0, q);
  const params = new FrozenMap<string, string>(q === -1 ? [] : new URLSearchParams(uri.slice(q + 1)));
  return Object.freeze({ uri, id, params });
}

/**
 * The capabilities a peer advertised. Always a set, even when the peer sent a
 * single capability (fork defect d).
 *
 * Lookups accept a full URI, or a short name starting with `:`:
 * - `':candidate'` matches any version of `urn:ietf:params:netconf:capability:candidate:*`
 * - `':confirmed-commit:1.1'` matches that version only
 * - `':base:1.1'` matches `urn:ietf:params:netconf:base:1.1`
 */
export class CapabilitySet implements Iterable<Capability> {
  readonly #byId = new Map<string, Capability>();
  readonly #helloModulesByName = new Map<string, ModuleCapability>();

  constructor(uris: Iterable<string>) {
    for (const raw of uris) {
      const uri = raw.trim();
      if (uri === '') continue;
      const cap = parseCapability(uri);
      this.#byId.set(cap.id, cap);
      const name = cap.params.get('module');
      if (name !== undefined) {
        // Frozen: every helloModules caller shares these objects.
        this.#helloModulesByName.set(name, Object.freeze({
          name,
          namespace: cap.id,
          revision: cap.params.get('revision'),
          features: Object.freeze(splitList(cap.params.get('features'))),
          deviations: Object.freeze(splitList(cap.params.get('deviations'))),
        }));
      }
    }
  }

  /** How many capabilities the set holds. */
  get size(): number {
    return this.#byId.size;
  }

  /** True if the set has the capability: a full URI (its query is ignored) or a `:` short name. */
  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /**
   * The capability for a full URI (its query is ignored) or a `:` short name,
   * with its parameters, or undefined if the set doesn't have it.
   */
  get(name: string): Capability | undefined {
    if (!name.startsWith(':')) return this.#byId.get(parseCapability(name).id);
    const short = name.slice(1);
    if (/^base:\d+\.\d+$/.test(short)) return this.#byId.get(`urn:ietf:params:netconf:${short}`);
    if (/:\d+\.\d+$/.test(short)) return this.#byId.get(CAPABILITY_PREFIX + short);
    const prefix = `${CAPABILITY_PREFIX}${short}:`;
    for (const [id, cap] of this.#byId) {
      if (id.startsWith(prefix) && /^\d+\.\d+$/.test(id.slice(prefix.length))) return cap;
    }
    return undefined;
  }

  /**
   * A YANG module advertised in the hello. Only YANG 1.0 modules are advertised
   * there; YANG 1.1 modules appear only in the YANG library (RFC 7950 §5.6.4,
   * RFC 8525). For the complete list, use `client.content.modules()`.
   */
  helloModule(name: string): ModuleCapability | undefined {
    return this.#helloModulesByName.get(name);
  }

  /** True if the hello advertised this YANG module. See {@link helloModule}. */
  hasHelloModule(name: string): boolean {
    return this.#helloModulesByName.has(name);
  }

  /** The YANG modules advertised in the hello. See {@link helloModule}. */
  get helloModules(): ModuleCapability[] {
    return [...this.#helloModulesByName.values()];
  }

  /** NETCONF base versions in this set, oldest first. */
  get baseVersions(): BaseVersion[] {
    const out: BaseVersion[] = [];
    if (this.#byId.has(BASE_1_0)) out.push('1.0');
    if (this.#byId.has(BASE_1_1)) out.push('1.1');
    return out;
  }

  /** The advertised URIs, unchanged. */
  toArray(): string[] {
    return [...this.#byId.values()].map((c) => c.uri);
  }

  /** Iterate over the capabilities, in the order they were advertised. */
  [Symbol.iterator](): Iterator<Capability> {
    return this.#byId.values();
  }

  /** Serialises as the advertised URIs, the same as {@link toArray}. */
  toJSON(): string[] {
    return this.toArray();
  }

  /** Prints as `CapabilitySet(n) [ ...uris ]` in the REPL and console.log. */
  // Node's util.inspect looks this symbol up and passes itself as the third argument, so no node:util import is needed.
  [Symbol.for('nodejs.util.inspect.custom')](depth: number, options: InspectOptions, inspectFn?: Inspect): string {
    if (depth < 0) return `CapabilitySet(${this.size})`;
    const inner = options.depth === null || options.depth === undefined ? null : options.depth - 1;
    const items = inspectFn === undefined ? JSON.stringify(this.toArray()) : inspectFn(this.toArray(), { ...options, depth: inner });
    return `CapabilitySet(${this.size}) ${items}`;
  }
}

function splitList(value: string | undefined): string[] {
  return value === undefined || value === '' ? [] : value.split(',');
}
