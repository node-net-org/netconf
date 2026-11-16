/**
 * CONTENT-09: converting to JSON decodes the data
 * against the schema once when it matches, and repeated
 * conversions reuse the YANG library as already read, without rebuilding or
 * re-serialising it.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as netYangCore from '@node-net/yang/core';
import { memorySource, YangDataError } from '@node-net/yang/core';
import { toSchemaLibrary } from '../../src/client-yang.js';
import type { YangLibrary } from '../../src/operations/yang-library.js';
import { parseXml } from '../../src/xml/index.js';
import { YangCache } from '../../src/yang/cache.js';
import { convertData } from '../../src/yang/convert.js';
import { implementedByNamespace, implementedNames, jsonNamespaces, namespacesOf, type SchemaContext } from '../../src/yang/schemas.js';

const decodes = vi.hoisted(() => ({ count: 0 }));
vi.mock('@node-net/yang/core', async (importOriginal) => {
  const actual = await importOriginal<typeof netYangCore>();
  return {
    ...actual,
    decodeXml: (...args: Parameters<typeof actual.decodeXml>) => {
      decodes.count++;
      return actual.decodeXml(...args);
    },
  };
});

const NC = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const EJ = 'urn:example:json';
const EA = 'urn:example:aug';
const fixture = (f: string): string => readFileSync(new URL(`../fixtures/yang/json/${f}`, import.meta.url), 'utf8');
const source = memorySource([fixture('ex-json@2026-11-09.yang'), fixture('ex-aug@2026-11-09.yang')]);

function library(): YangLibrary {
  const mod = (name: string, namespace: string) => ({ name, revision: '2026-11-09', namespace, locations: [], features: [], deviations: [], submodules: [] });
  const modules = [mod('ex-json', EJ), mod('ex-aug', EA)];
  return {
    version: '1.1',
    contentId: '1',
    moduleSets: [{ name: 'all', modules, importOnlyModules: [] }],
    schemas: [{ name: 'all', moduleSets: ['all'] }],
    datastores: [{ name: 'ietf-datastores:running', schema: 'all', modules, importOnlyModules: [] }],
  };
}

function context(lib: () => YangLibrary, cache = new YangCache()): SchemaContext & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    library: () => Promise.resolve(toSchemaLibrary(lib())),
    source,
    sourceKey: 'test',
    moduleOf: (ns) => ({ [EJ]: 'ex-json', [EA]: 'ex-aug' })[ns],
    namespaceOf: () => undefined,
    warn: (m) => warnings.push(m),
    cache,
    warnings,
  };
}

const data = (xml: string) => parseXml(`<data xmlns="${NC}">${xml}</data>`);
const top = (name: string, size: string) => `<top xmlns="${EJ}"><item><name>${name}</name><size>${size}</size></item></top>`;
const opts = { datastore: 'running', requireSchema: false };

afterEach(() => {
  decodes.count = 0;
});

describe('CONTENT-09: one decode when the data matches its schema', () => {
  it('data that matches is decoded once, however many top-level members it has', async () => {
    const lib = library();
    const ctx = context(() => lib);
    await convertData(ctx, data(top('a', '1')), opts); // compile
    decodes.count = 0;
    expect(await convertData(ctx, data(`${top('a', '1')}<other xmlns="urn:none"/>`), opts)).toEqual({
      'ex-json:top': { item: [{ name: 'a', size: 1 }] },
      'urn:none:other': '',
    });
    expect(decodes.count).toBe(1);
  });

  it('a clash decodes each member once more and merges, without decoding them together again', async () => {
    const lib = library();
    const ctx = context(() => lib);
    const result = await convertData(ctx, data(top('a', '1') + top('b', '2')), opts);
    expect(result).toEqual({ 'ex-json:top': { item: [{ name: 'a', size: 1 }, { name: 'b', size: 2 }] } });
    expect(decodes.count).toBe(3); // together, then each alone (it was 6 before)
    expect(ctx.warnings).toEqual([expect.stringMatching(/clash/)]);
    await expect(convertData(ctx, data(top('a', '1') + top('b', '2')), { ...opts, requireSchema: true })).rejects.toThrow(YangDataError);
  });

  it('a member that does not match is set aside, and the members that match but clash are merged', async () => {
    const lib = library();
    const ctx = context(() => lib);
    const result = await convertData(ctx, data(top('a', '1') + `<extra-top xmlns="${EJ}"/>` + top('b', '2')), opts);
    expect(result['ex-json:top']).toEqual({ item: [{ name: 'a', size: 1 }, { name: 'b', size: 2 }] });
    // together, each of three alone, then the two that matched together
    expect(decodes.count).toBe(5);
    expect(ctx.warnings.some((w) => /clash/.test(w))).toBe(true);
    expect(ctx.warnings.some((w) => /doesn't match the schema/.test(w))).toBe(true);
  });

  it('members that match and one that does not: the matching ones decode together once more', async () => {
    const lib = library();
    const ctx = context(() => lib);
    const result = await convertData(ctx, data(top('a', '1') + `<extra-top xmlns="${EJ}"/>`), opts);
    expect(result['ex-json:top']).toEqual({ item: [{ name: 'a', size: 1 }] });
    expect(decodes.count).toBe(4); // together, each of two alone, the one that matched again
  });
});

describe('CONTENT-09: the YANG library is reused as read', () => {
  it('its derived views are built once per library object, and are read-only', () => {
    const lib = library();
    const schemaLibrary = toSchemaLibrary(lib);
    expect(toSchemaLibrary(lib)).toBe(schemaLibrary);
    expect(toSchemaLibrary(library())).not.toBe(schemaLibrary);
    expect(implementedByNamespace(schemaLibrary)).toBe(implementedByNamespace(schemaLibrary));
    expect(namespacesOf(schemaLibrary)).toBe(namespacesOf(schemaLibrary));
    expect(jsonNamespaces(schemaLibrary)).toBe(jsonNamespaces(schemaLibrary));
    expect(implementedNames(schemaLibrary)).toBe(implementedNames(schemaLibrary));
    expect(Object.isFrozen(namespacesOf(schemaLibrary))).toBe(true);
    expect(() => (implementedByNamespace(schemaLibrary) as Map<string, string>).set('x', 'y')).toThrow(TypeError);
    expect(namespacesOf(undefined)).toEqual({});
  });

  it('equal libraries read by different sessions share one compile in a shared cache; a different library does not', async () => {
    const cache = new YangCache();
    await convertData(context(library, cache), data(top('a', '1')), opts);
    await convertData(context(library, cache), data(top('a', '1')), opts);
    expect(cache.size).toBe(1);
    const other = (): YangLibrary => ({ ...library(), datastores: [] });
    await convertData(context(other, cache), data(top('a', '1')), opts);
    expect(cache.size).toBe(2);
  });
});
