/**
 * The one door to the YANG machinery (engine.ts): loaded with import() on
 * first use and kept, so @node-net/netconf/core costs no YANG code until a
 * conversion runs. A failed load (a chunk the browser couldn't fetch, say)
 * isn't kept, so the next conversion tries again.
 */

import type * as Engine from './engine.js';

export type YangEngine = typeof Engine;

let engine: Promise<YangEngine> | undefined;

/** The YANG machinery, loading it the first time. */
export function loadYang(): Promise<YangEngine> {
  if (engine === undefined) {
    const loading = import('./engine.js');
    engine = loading;
    loading.catch(() => {
      if (engine === loading) engine = undefined;
    });
  }
  return engine;
}
