/**
 * PKG-06: the YANG machinery loads on first use, once,
 * and a load that fails (a chunk the browser couldn't fetch) is tried again
 * by the next conversion rather than remembered.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Engine from '../../src/yang/engine.js';

/** Load load.js afresh, with engine.js failing its first `fail` loads. */
async function freshLoad(fail: number): Promise<{ loadYang: () => Promise<typeof Engine>; loads: () => number }> {
  vi.resetModules();
  let loads = 0;
  vi.doMock('../../src/yang/engine.js', async (importOriginal) => {
    loads++;
    if (fail > 0) {
      fail--;
      throw new Error('Failed to fetch dynamically imported module');
    }
    return importOriginal();
  });
  const { loadYang } = await import('../../src/yang/load.js');
  return { loadYang, loads: () => loads };
}

afterEach(() => {
  vi.doUnmock('../../src/yang/engine.js');
  vi.resetModules();
});

describe('loadYang', () => {
  it('loads the engine on the first call, not when imported, and only once', async () => {
    const { loadYang, loads } = await freshLoad(0);
    expect(loads()).toBe(0);
    const [a, b] = await Promise.all([loadYang(), loadYang()]);
    expect(a).toBe(b);
    expect(await loadYang()).toBe(a);
    expect(loads()).toBe(1);
    expect(typeof a.convertData).toBe('function');
  });

  it('tries again after a failed load', async () => {
    const { loadYang, loads } = await freshLoad(1);
    // Vitest wraps the factory's error in its own; the point is that it rejects.
    await expect(loadYang()).rejects.toThrow();
    const loaded = await loadYang();
    expect(typeof loaded.encodeData).toBe('function');
    expect(loads()).toBe(2);
  });
});
