/**
 * FrozenMap: a Map that throws on writes once built. `Object.freeze` doesn't
 * stop `set()`, `delete()` or `clear()`, so a frozen object holding a plain
 * Map can still be changed through it. Used where a map is shared state:
 * capability params, XML namespace declarations.
 */
export class FrozenMap<K, V> extends Map<K, V> {
  #sealed = false;

  constructor(entries: Iterable<readonly [K, V]> = []) {
    super();
    for (const [k, v] of entries) super.set(k, v);
    this.#sealed = true;
    // A subclass freezes itself once its own fields are set.
    if (new.target === FrozenMap) Object.freeze(this);
  }

  override set(key: K, value: V): this {
    if (this.#sealed) throw new TypeError('This map is read-only');
    return super.set(key, value);
  }

  override delete(): boolean {
    throw new TypeError('This map is read-only');
  }

  override clear(): void {
    throw new TypeError('This map is read-only');
  }
}

/** `map` itself if already a FrozenMap, else a frozen copy. */
export function frozenMap<K, V>(map: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  return map instanceof FrozenMap ? map : new FrozenMap(map);
}
