/**
 * The namespaces in scope at a parsed element, stored as a chain: each scope
 * holds only the declarations its element made, plus a link to the scope it
 * was declared in. Elements that declare nothing share their parent's scope.
 *
 * Copying the parent's whole map for every declaring element made a document
 * with K declarations on its root and K declaring children cost K² entries:
 * 400 KB of text took 1.8 GB. A chain costs one entry per
 * declaration, so memory grows with the number of declarations in the text,
 * which `maxNodes` counts.
 *
 * It is still a real, frozen Map. `get` and `has` walk the chain, which is
 * no longer than the element's declaring ancestors (so at most `maxDepth`).
 * Anything that needs every entry (`size`, iteration, `util.inspect`) first
 * flattens the chain into the Map's own storage, once, in the order the old
 * flat copy had: inherited prefixes keep their place, and new ones follow in
 * document order. Nothing on the parse path flattens.
 */

import { FrozenMap } from '../frozen-map.js';

// The Map's own storage, bypassing the overrides below.
const mapSet = (map: Map<string, string>, prefix: string, uri: string): unknown => Map.prototype.set.call(map, prefix, uri);
const mapGet = (map: Map<string, string>, prefix: string): string | undefined => Map.prototype.get.call(map, prefix) as string | undefined;
const mapEntries = (map: Map<string, string>): Iterable<[string, string]> => Map.prototype.entries.call(map) as Iterable<[string, string]>;

const NONE: ReadonlyMap<string, string> = new FrozenMap();

export class NamespaceScope extends FrozenMap<string, string> {
  readonly #parent: NamespaceScope | undefined;
  /** The declarations this scope adds, in the order a full iteration yields them. */
  readonly #own: ReadonlyMap<string, string>;
  #flat = false;

  /**
   * @param own The scope's own declarations, ordered as a full iteration
   *   yields them: prefixes the parent already binds first, in the parent's
   *   order, then new prefixes in document order.
   */
  constructor(parent: NamespaceScope | undefined, own: ReadonlyMap<string, string>) {
    super();
    this.#parent = parent;
    this.#own = own;
    if (parent === undefined) this.#flatten();
    Object.freeze(this);
  }

  /**
   * The entries `scope` adds to `parent`, when `scope` is `parent` itself or
   * was declared directly inside it; otherwise `undefined`. They are in the
   * order a full iteration of `scope` yields them, and every one of them is in
   * `scope`. Lets a walk over a tree read each declaration once instead of
   * every element's whole scope.
   */
  static added(scope: ReadonlyMap<string, string>, parent: ReadonlyMap<string, string> | undefined): ReadonlyMap<string, string> | undefined {
    if (scope === parent) return NONE;
    return scope instanceof NamespaceScope && scope.#parent !== undefined && scope.#parent === parent ? scope.#own : undefined;
  }

  /**
   * Every entry of `scope`, nearest declaration winning, in iteration order,
   * without flattening a NamespaceScope that isn't flat yet. For reads inside
   * the library that need the whole scope once (serialising an element,
   * copying it into another map): flattening caches the entries on the scope,
   * so doing it for every element of a tree would keep a copy per element.
   */
  static entries(scope: ReadonlyMap<string, string>): Iterable<[string, string]> {
    if (!(scope instanceof NamespaceScope) || scope.#flat) return scope;
    const flat = new Map<string, string>();
    scope.#fill(flat);
    return flat;
  }

  override get(prefix: string): string | undefined {
    return NamespaceScope.#lookup(this, prefix);
  }

  static #lookup(scope: NamespaceScope, prefix: string): string | undefined {
    for (let s: NamespaceScope | undefined = scope; s !== undefined; s = s.#parent) {
      if (s.#flat) return mapGet(s, prefix);
      const uri = s.#own.get(prefix);
      if (uri !== undefined) return uri;
    }
    return undefined;
  }

  override has(prefix: string): boolean {
    return this.get(prefix) !== undefined;
  }

  override get size(): number {
    this.#flatten();
    return super.size;
  }

  override entries(): ReturnType<Map<string, string>['entries']> {
    this.#flatten();
    return super.entries();
  }

  override keys(): ReturnType<Map<string, string>['keys']> {
    this.#flatten();
    return super.keys();
  }

  override values(): ReturnType<Map<string, string>['values']> {
    this.#flatten();
    return super.values();
  }

  override [Symbol.iterator](): ReturnType<Map<string, string>['entries']> {
    this.#flatten();
    return super.entries();
  }

  override forEach(callback: (value: string, key: string, map: Map<string, string>) => void, thisArg?: unknown): void {
    this.#flatten();
    super.forEach(callback, thisArg);
  }

  /** `util.inspect` reads the Map's storage directly, so fill it first. */
  [Symbol.for('nodejs.util.inspect.custom')](): this {
    this.#flatten();
    return this;
  }

  #flatten(): void {
    if (this.#flat) return;
    this.#fill(this);
    this.#flat = true;
  }

  /** Writes every entry of this scope into `target`, from the root down. */
  #fill(target: Map<string, string>): void {
    const links: ReadonlyMap<string, string>[] = [this.#own];
    let s = this.#parent;
    for (; s !== undefined && !s.#flat; s = s.#parent) links.push(s.#own);
    if (s !== undefined) for (const [prefix, uri] of mapEntries(s)) mapSet(target, prefix, uri);
    for (let i = links.length - 1; i >= 0; i--) for (const [prefix, uri] of links[i]!) mapSet(target, prefix, uri);
  }

  static {
    // Shown as before (`FrozenMap(2) [Map] {…}`) by util.inspect.
    Object.defineProperty(this, 'name', { value: 'FrozenMap' });
  }
}
