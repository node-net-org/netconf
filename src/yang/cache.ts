/**
 * YangCache: YANG module text and compiled schemas, shared by every client it
 * is given to (`connect({ yang: { cache } })`), so a service with many
 * sessions to the same kind of device fetches and compiles each module set
 * once.
 */

import type { ModuleSource, ModuleText, ServerSchemas } from '@node-net/yang/core';

/**
 * A store of fetched YANG module text and compiled schemas that several
 * clients can share, given as `connect({ yang: { cache } })`. A service with
 * many sessions to the same kind of device then fetches and compiles each
 * module set once. See [Where the schema comes from](/guide/json#where-the-schema-comes-from).
 */
export class YangCache {
  readonly #texts = new Map<string, Promise<ModuleText | undefined>>();
  readonly #schemas = new Map<string, Promise<ServerSchemas>>();
  /** Each distinct library description seen → a short id, so schema keys are short to hash. */
  readonly #libraries = new Map<string, string>();

  /** How many compiled module sets the cache holds. */
  get size(): number {
    return this.#schemas.size;
  }

  /** Forget everything: later reads fetch and compile again. */
  clear(): void {
    this.#texts.clear();
    this.#schemas.clear();
    this.#libraries.clear();
  }

  /**
   * @internal A short id for a YANG library's description (its JSON), the
   * same for equal descriptions, so clients reading the same library share
   * compiled schemas.
   */
  libraryId(description: string): string {
    let id = this.#libraries.get(description);
    if (id === undefined) {
      id = `L${this.#libraries.size + 1}`;
      this.#libraries.set(description, id);
    }
    return id;
  }

  /**
   * @internal A source that remembers each module found by name and revision.
   * Text without a revision isn't shared (two servers may mean different
   * modules by it), and a module not found isn't remembered.
   */
  source(source: ModuleSource, key: string): ModuleSource {
    return {
      load: (name, revision) => {
        if (revision === undefined) return source.load(name);
        const k = `${key}\u0000${name}@${revision}`;
        let text = this.#texts.get(k);
        if (text === undefined) {
          text = source.load(name, revision);
          this.#texts.set(k, text);
          text.then(
            (t) => {
              if (t === undefined) this.#texts.delete(k);
            },
            () => this.#texts.delete(k),
          );
        }
        return text;
      },
    };
  }

  /** @internal The compiled schemas for a key, compiled by `make` the first time. A failed compile isn't kept. */
  schemas(key: string, make: () => Promise<ServerSchemas>): Promise<ServerSchemas> {
    let schemas = this.#schemas.get(key);
    if (schemas === undefined) {
      schemas = make();
      this.#schemas.set(key, schemas);
      schemas.catch(() => this.#schemas.delete(key));
    }
    return schemas;
  }
}
