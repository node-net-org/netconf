/**
 * RFC 7951 JSON output, against the fake server:
 * OPS-26 (get, get-config and get-data as JSON), CONTENT-09 (path reads and
 * toJson) and CLIENT-06 (supplying modules, the profile yang section, the
 * shared cache).
 *
 * The fixture modules: ex-json (every type the rules care about) and ex-aug,
 * which augments ex-json's list entries from a second module.
 */
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { memorySource, YangDataError as NetYangDataError } from '@node-net/yang';
import { compileProfile } from '../../src/devices/profile-spec.js';
import {
  BASE_1_0,
  BASE_1_1,
  connect,
  loadDeviceProfile,
  NetconfError,
  NETCONF_NS,
  parseXml,
  ProfileError,
  SchemaUnavailableError,
  x,
  YangCache,
  YangDataError,
  type ConnectOptions,
  type NetconfClient,
  type SessionWarning,
  type XmlElement,
  READ_AS_XML_HINT,
  type YangJsonObject,
  type YangJsonValue,
} from '../../src/index.js';
import { extensionContext } from '../../src/operations/index.js';
import { nmda } from '../../src/operations/nmda.js';
import { FakeServer, type RpcHandler } from '../../src/testing/index.js';

const MODULES = fileURLToPath(new URL('../fixtures/yang/json/', import.meta.url));
const EJ = 'urn:example:json';
const EA = 'urn:example:aug';
const MON = 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring';
const YL = 'urn:ietf:params:xml:ns:yang:ietf-yang-library';
const NMDA_NS = 'urn:ietf:params:xml:ns:yang:ietf-netconf-nmda';
const ORIGIN = 'urn:ietf:params:xml:ns:yang:ietf-origin';
const WD = 'urn:ietf:params:xml:ns:yang:ietf-netconf-with-defaults';
const DS = 'urn:ietf:params:xml:ns:yang:ietf-datastores';
const CAP = (n: string): string => `urn:ietf:params:netconf:capability:${n}`;

/** The hello lists both fixture modules; the client gets their text from `yang.modules` (or get-schema). */
const HELLO = [BASE_1_0, BASE_1_1, `${EJ}?module=ex-json&revision=2026-11-09`, `${EA}?module=ex-aug&revision=2026-11-09`];

/** One list entry with every interesting type, and a leaf augmented in from ex-aug. */
const ITEM = `<item><name>a</name><count>-5</count><size>7</size><big>18446744073709551615</big><ratio>1.50</ratio><on>true</on><flag/><kind xmlns:ej="${EJ}">ej:fast</kind><note>  padded  </note><tag>x</tag><extra xmlns="${EA}">e</extra></item>`;
const TOP = `<top xmlns="${EJ}">${ITEM}</top>`;
const TYPED = {
  'ex-json:top': {
    item: [
      {
        name: 'a',
        count: '-5',
        size: 7,
        big: '18446744073709551615',
        ratio: '1.5',
        on: true,
        flag: [null],
        kind: 'ex-json:fast',
        note: '  padded  ',
        tag: ['x'],
        'ex-aug:extra': 'e',
      },
    ],
  },
};

const dataOf = (xml: string): XmlElement[] => parseXml(`<data xmlns="${NETCONF_NS}">${xml}</data>`).elements;

/** Answer get and get-config with `xml`, get-schema from the fixture directory, anything else with ok. */
function server(xml: string = TOP): RpcHandler {
  return (_rpc, ctx) => {
    const op = ctx.operation?.name;
    if (op === 'get' || op === 'get-config') return { data: dataOf(xml) };
    if (op === 'get-schema') {
      const id = ctx.operation!.child('identifier', MON)!.text();
      const rev = ctx.operation!.child('version', MON)?.text();
      try {
        return { data: readFileSync(join(MODULES, `${id}@${rev ?? '2026-11-09'}.yang`), 'utf8') };
      } catch {
        return { errors: [{ type: 'application', tag: 'invalid-value', message: 'no such schema' }] };
      }
    }
    return 'ok';
  };
}

let clients: NetconfClient[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

async function open(options: Partial<ConnectOptions> = {}, handler: RpcHandler = server(), capabilities: readonly string[] = HELLO) {
  const fake = new FakeServer({ capabilities: [...capabilities], handler });
  const client = await connect({ transport: fake.transport(), yang: { modules: MODULES }, ...options });
  clients.push(client);
  const warnings: SessionWarning[] = [];
  client.session.on('warning', (w) => warnings.push(w));
  return { fake, client, warnings };
}

const sent = (fake: FakeServer, name: string): XmlElement[] => fake.requests.map((r) => r.elements[0]!).filter((e) => e.name === name);

describe('OPS-26: get, get-config and get-data as RFC 7951 JSON', () => {
  it('types identities from a module the data only names in a value prefix (as iana-if-type interface types)', async () => {
    const EI = 'urn:example:ident';
    const xml = `<top xmlns="${EJ}"><item xmlns:ei="${EI}"><name>a</name><kind>ei:slow</kind></item></top>`;
    const { client, warnings } = await open({}, server(xml), [...HELLO, `${EI}?module=ex-ident&revision=2026-11-09`]);
    expect(await client.ops.getConfig({ source: 'running', format: 'json', json: { requireSchema: true } })).toEqual({
      'ex-json:top': { item: [{ name: 'a', kind: 'ex-ident:slow' }] },
    });
    expect(warnings).toEqual([]);
  });

  it('get and get-config with format json resolve with the data typed by the schema', async () => {
    const { client } = await open();
    expect(await client.ops.get({ format: 'json' })).toEqual(TYPED);
    expect(await client.ops.getConfig({ source: 'running', format: 'json' })).toEqual(TYPED);
  });

  it('the output matches yanglint\'s RFC 7951 JSON for the same data and modules', async () => {
    const xml = readFileSync(join(MODULES, 'top.xml'), 'utf8');
    const { client } = await open({}, server(xml));
    const oracle = JSON.parse(readFileSync(join(MODULES, 'top.yanglint.json'), 'utf8')) as unknown;
    expect(await client.ops.get({ format: 'json', json: { requireSchema: true } })).toEqual(oracle);
    expect(JSON.stringify(await client.ops.get({ format: 'json' }))).toBe(JSON.stringify(oracle));
  });

  it('without format, or with format xml, they resolve with the <data> element as before', async () => {
    const { client } = await open();
    const plain = await client.ops.getConfig();
    expect(plain.name).toBe('data');
    expect(plain.child('top', EJ)?.path('item/count', EJ)?.text()).toBe('-5');
    const xml = await client.ops.get({ format: 'xml' });
    expect(xml.child('top', EJ)).toBeDefined();
  });

  it('format and json are never sent, and a reply with no data is {}', async () => {
    const { fake, client } = await open({}, server(''));
    expect(await client.ops.getConfig({ format: 'json', json: { requireSchema: true } })).toEqual({});
    const request = sent(fake, 'get-config')[0]!;
    expect(request.elements.map((e) => e.name)).toEqual(['source']);
  });

  it('an unknown format is refused before anything is sent', async () => {
    const { fake, client } = await open();
    await expect(client.ops.get({ format: 'yaml' as 'json' })).rejects.toThrow(TypeError);
    expect(sent(fake, 'get')).toHaveLength(0);
  });

  it('member names are qualified at the top and where the module changes; lists and leaf-lists are arrays even with one entry', async () => {
    const { client } = await open();
    const data = (await client.ops.get({ format: 'json' })) as typeof TYPED;
    const item = data['ex-json:top'].item;
    expect(Array.isArray(item) && item.length).toBe(1);
    expect(item[0]!.tag).toEqual(['x']);
    expect(item[0]!['ex-aug:extra']).toBe('e');
    expect(Object.keys(item[0]!)).not.toContain('extra');
  });

  it('int64, uint64 and decimal64 are strings, uint32 a number, boolean true/false, empty [null], identityref module:identity, text untrimmed', async () => {
    const { client } = await open();
    const [item] = ((await client.ops.get({ format: 'json' })) as typeof TYPED)['ex-json:top'].item;
    expect(item).toMatchObject({ count: '-5', big: '18446744073709551615', ratio: '1.5', size: 7, on: true, flag: [null], kind: 'ex-json:fast', note: '  padded  ' });
  });

  it('a prefix declared on <rpc-reply> resolves an identityref inside the data', async () => {
    const handler: RpcHandler = (_rpc, ctx) =>
      ctx.operation?.name === 'get'
        ? { body: [parseXml(`<data xmlns="${NETCONF_NS}" xmlns:q="${EJ}"><top xmlns="${EJ}"><item><name>a</name><kind>q:fast</kind></item></top></data>`)] }
        : 'ok';
    const { client } = await open({}, handler);
    expect(await client.ops.get({ format: 'json', json: { requireSchema: true } })).toEqual({ 'ex-json:top': { item: [{ name: 'a', kind: 'ex-json:fast' }] } });
  });

  it('module text comes from <get-schema> when the server supports it and none is supplied', async () => {
    const { fake, client } = await open({ yang: {} }, server(), [...HELLO, `${MON}?module=ietf-netconf-monitoring&revision=2010-10-04`]);
    expect(await client.ops.get({ format: 'json', json: { requireSchema: true } })).toEqual(TYPED);
    const fetched = sent(fake, 'get-schema').map((g) => g.child('identifier', MON)!.text());
    expect(fetched.sort()).toEqual(['ex-aug', 'ex-json']);
    // The session keeps the schema: a second read fetches nothing more.
    await client.ops.get({ format: 'json' });
    expect(sent(fake, 'get-schema')).toHaveLength(2);
  });

  it('a subtree in no module the server lists is converted schema-less, with a warning, and the rest stays typed', async () => {
    const { client, warnings } = await open({}, server(`${TOP}<other xmlns="urn:example:none"><a>1</a><a>2</a><b/><c> t </c></other>`));
    const data = await client.ops.get({ format: 'json' });
    expect(data['ex-json:top']).toEqual(TYPED['ex-json:top']);
    expect(data['urn:example:none:other']).toEqual({ a: ['1', '2'], b: '', c: ' t ' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/urn:example:none:other was converted without a YANG schema, because no module the server lists has the namespace urn:example:none/);
  });

  it('a subtree that does not match the schema is converted schema-less, naming the problem; a single list entry is then not an array', async () => {
    const { client, warnings } = await open({}, server(`<top xmlns="${EJ}"><item><name>a</name><size>big</size></item></top>`));
    expect(await client.ops.get({ format: 'json' })).toEqual({ 'ex-json:top': { item: { name: 'a', size: 'big' } } });
    expect(warnings[0]!.message).toMatch(/ex-json:top was converted without a YANG schema, because it doesn't match the schema: .*size/);
  });

  it('when module text can be found nowhere, the subtree is schema-less and the warning says no schema could be compiled', async () => {
    const { client, warnings } = await open({ yang: {} });
    const data = await client.ops.get({ format: 'json' });
    expect(data['ex-json:top']).toEqual({
      item: { name: 'a', count: '-5', size: '7', big: '18446744073709551615', ratio: '1.50', on: 'true', flag: '', kind: 'ej:fast', note: '  padded  ', tag: 'x', 'ex-aug:extra': 'e' },
    });
    expect(warnings[0]!.message).toMatch(/no schema could be compiled for ex-json/);
  });

  it('the same container sent twice is merged, typed, with a warning; with requireSchema the clash rejects', async () => {
    const twice = `<top xmlns="${EJ}"><item><name>a</name><size>1</size></item></top><top xmlns="${EJ}"><item><name>b</name><size>2</size></item></top>`;
    const { client, warnings } = await open({}, server(twice));
    expect(await client.ops.get({ format: 'json' })).toEqual({ 'ex-json:top': { item: [{ name: 'a', size: 1 }, { name: 'b', size: 2 }] } });
    expect(warnings[0]!.message).toMatch(/clash/);
    await expect(client.ops.get({ format: 'json', json: { requireSchema: true } })).rejects.toThrow(YangDataError);
  });

  it('a server that lists no modules gives a schema-less conversion with that reason', async () => {
    const { client, warnings } = await open({}, server(), [BASE_1_0, BASE_1_1]);
    expect(await client.ops.get({ format: 'json' })).toEqual({ 'urn:example:json:top': expect.any(Object) as unknown });
    expect(warnings[0]!.message).toMatch(/the server lists no YANG modules/);
  });

  it('attributes that aren\'t YANG metadata modules the schema knows still become module-qualified annotations', async () => {
    const xml = `<top xmlns="${EJ}" xmlns:wd="${WD}"><item><name>a</name><size wd:default="true">7</size></item></top>`;
    const { client } = await open({}, server(xml));
    const [item] = ((await client.ops.get({ format: 'json' })) as { 'ex-json:top': { item: Record<string, unknown>[] } })['ex-json:top'].item;
    expect(item!['@size']).toEqual({ 'ietf-netconf-with-defaults:default': true });
  });

  describe('requireSchema', () => {
    it('per call: a subtree with no module rejects with SchemaUnavailableError, a mismatch with a YangDataError listing the issues', async () => {
      const none = await open({}, server('<other xmlns="urn:example:none"><a>1</a></other>'));
      await expect(none.client.ops.get({ format: 'json', json: { requireSchema: true } })).rejects.toThrow(SchemaUnavailableError);
      const bad = await open({}, server(`<top xmlns="${EJ}"><item><name>a</name><size>big</size></item></top>`));
      const err = await bad.client.ops.get({ format: 'json', json: { requireSchema: true } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(YangDataError);
      expect((err as YangDataError).issues.map((i) => i.path).join()).toMatch(/size/);
    });

    it('a YANG data error from a JSON read is a NetconfError (ERR_NETCONF_YANG_DATA) whose cause is @node-net/yang\'s error', async () => {
      const bad = await open({}, server(`<top xmlns="${EJ}"><item><name>a</name><size>big</size></item></top>`));
      const err = await bad.client.ops.get({ format: 'json', json: { requireSchema: true } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NetconfError);
      expect(err).toMatchObject({ name: 'YangDataError', code: 'ERR_NETCONF_YANG_DATA' });
      const cause = (err as YangDataError).cause;
      expect(cause).toBeInstanceOf(NetYangDataError);
      expect((err as YangDataError).issues).toBe((cause as NetYangDataError).issues);
      expect((err as Error).message).toBe((cause as Error).message);
    });

    it('SchemaUnavailableError is a NetconfError with code ERR_NETCONF_SCHEMA_UNAVAILABLE naming the data', async () => {
      const { client } = await open({}, server('<other xmlns="urn:example:none"/>'));
      const err = (await client.ops.get({ format: 'json', json: { requireSchema: true } }).catch((e: unknown) => e)) as SchemaUnavailableError;
      expect(err.code).toBe('ERR_NETCONF_SCHEMA_UNAVAILABLE');
      expect(err.message).toMatch(/urn:example:none:other/);
    });

    it('connect({ yang: { requireSchema } }) applies to every read, and a call can turn it off', async () => {
      const { client, warnings } = await open({ yang: { modules: MODULES, requireSchema: true } }, server('<other xmlns="urn:example:none"/>'));
      await expect(client.ops.get({ format: 'json' })).rejects.toThrow(SchemaUnavailableError);
      expect(await client.ops.get({ format: 'json', json: { requireSchema: false } })).toEqual({ 'urn:example:none:other': '' });
      expect(warnings).toHaveLength(1);
    });

    it('a device profile sets it, the connection overrides the profile', async () => {
      const { profile } = compileProfile({ id: 'strict', yang: { requireSchema: true } });
      const strict = await open({ profile: profile }, server('<other xmlns="urn:example:none"/>'));
      await expect(strict.client.ops.get({ format: 'json' })).rejects.toThrow(SchemaUnavailableError);
      const relaxed = await open({ profile: profile, yang: { modules: MODULES, requireSchema: false } }, server('<other xmlns="urn:example:none"/>'));
      expect(await relaxed.client.ops.get({ format: 'json' })).toEqual({ 'urn:example:none:other': '' });
    });
  });
});

describe('OPS-26: get-data as JSON, with origin annotations (NMDA)', () => {
  /** An NMDA library: both fixture modules and ietf-origin, operational using the same module set. */
  const LIBRARY = x('yang-library', { xmlns: YL },
    x('module-set', x('name', 'all'),
      x('module', x('name', 'ex-json'), x('revision', '2026-11-09'), x('namespace', EJ)),
      x('module', x('name', 'ex-aug'), x('revision', '2026-11-09'), x('namespace', EA)),
      x('module', x('name', 'ietf-origin'), x('revision', '2018-02-14'), x('namespace', ORIGIN)),
      x('import-only-module', x('name', 'ietf-datastores'), x('revision', '2018-02-14'), x('namespace', DS)),
    ),
    x('schema', x('name', 'all'), x('module-set', 'all')),
    x('datastore', { 'xmlns:ds': DS }, x('name', 'ds:running'), x('schema', 'all')),
    x('datastore', { 'xmlns:ds': DS }, x('name', 'ds:operational'), x('schema', 'all')),
    x('content-id', '1'),
  );
  const OPERATIONAL = `<top xmlns="${EJ}" xmlns:or="${ORIGIN}" or:origin="or:intended"><item><name>a</name><size or:origin="or:learned">7</size></item></top>`;
  const handler: RpcHandler = (_rpc, ctx) => {
    const op = ctx.operation;
    if (op?.name === 'get' && op.child('filter', NETCONF_NS)?.elements[0]?.name === 'yang-library') return { data: LIBRARY };
    if (op?.name === 'get-data') return { body: [parseXml(`<data xmlns="${NMDA_NS}">${OPERATIONAL}</data>`)] };
    return 'ok';
  };

  it('getData({ format: json, withOrigin }) types the data by the datastore schema and turns origins into annotations', async () => {
    const { client, fake } = await open(
      { extensions: [nmda] as const },
      handler,
      [BASE_1_0, BASE_1_1, `${CAP('yang-library:1.1')}?revision=2019-01-04&content-id=1`],
    );
    const ops = (client.ops as unknown as { nmda: typeof client.ops & { getData: (o: object) => Promise<unknown> } }).nmda;
    const data = await ops.getData({ datastore: 'operational', withOrigin: true, format: 'json', json: { requireSchema: true } });
    expect(data).toEqual({
      'ex-json:top': {
        '@': { 'ietf-origin:origin': 'ietf-origin:intended' },
        item: [{ name: 'a', size: 7, '@size': { 'ietf-origin:origin': 'ietf-origin:learned' } }],
      },
    });
    const request = sent(fake, 'get-data')[0]!;
    expect(request.elements.map((e) => e.name)).toEqual(['datastore', 'with-origin']);
  });

  it('without format, getData resolves with the <data> element as before', async () => {
    const { client } = await open({ extensions: [nmda] as const }, handler, [BASE_1_0, BASE_1_1, `${CAP('yang-library:1.1')}?revision=2019-01-04&content-id=1`]);
    const ops = (client.ops as unknown as { nmda: { getData: (o: object) => Promise<XmlElement> } }).nmda;
    const el = await ops.getData({ datastore: 'operational' });
    expect(el.name).toBe('data');
  });

  it('a context no client built has no conversion: toJson rejects with a TypeError', async () => {
    const fake = new FakeServer({ capabilities: HELLO, handler: server() });
    const client = await connect({ transport: fake.transport() });
    clients.push(client);
    await expect(extensionContext(client.session, 'strict').toJson(x('data'))).rejects.toThrow(TypeError);
  });
});

describe('CONTENT-09: path reads as JSON, and toJson', () => {
  it('read() asks the Operations layer for XML and converts it in the Content layer', async () => {
    const { client } = await open();
    const getConfig = vi.spyOn(client.ops, 'getConfig');
    const get = vi.spyOn(client.ops, 'get');
    expect(await client.content.read('/ex-json:top', { json: { requireSchema: true } })).toEqual(TYPED);
    expect(await client.content.read('/ex-json:top', { source: 'config+state', json: { requireSchema: true } })).toEqual(TYPED);
    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    for (const [options] of [...getConfig.mock.calls, ...get.mock.calls]) {
      expect(options).not.toHaveProperty('format');
      expect(options).not.toHaveProperty('json');
    }
  });

  const TWO = `<top xmlns="${EJ}">${ITEM}<item><name>01</name><size>9</size><ratio>2.00</ratio></item><item><name>1</name><size>10</size></item></top>`;

  it('read(path, { format: json }) resolves with the target as RESTCONF does: list entries as an array', async () => {
    const { client } = await open();
    expect(await client.content.read('/ex-json:top/item[name="a"]', { format: 'json' })).toEqual({ 'ex-json:item': TYPED['ex-json:top'].item });
  });

  it('a container is an object, a leaf its typed value, a leaf-list an array, and no match {}', async () => {
    const { client } = await open();
    expect(await client.content.read('/ex-json:top', { format: 'json' })).toEqual({ 'ex-json:top': TYPED['ex-json:top'] });
    expect(await client.content.read('/ex-json:top/item[name="a"]/size', { format: 'json' })).toEqual({ 'ex-json:size': 7 });
    expect(await client.content.read('/ex-json:top/item[name="a"]/tag', { format: 'json' })).toEqual({ 'ex-json:tag': ['x'] });
    expect(await client.content.read('/ex-json:top/item[name="a"]/ex-aug:extra', { format: 'json' })).toEqual({ 'ex-aug:extra': 'e' });
    expect(await client.content.read('/ex-json:top/item[name="zz"]', { format: 'json' })).toEqual({});
  });

  it('key predicates match by value whatever the JSON type, and a string key "01" never stands in for "1"', async () => {
    const { client } = await open({}, server(TWO));
    expect(await client.content.read('/ex-json:top/item[name="1"]/size', { format: 'json' })).toEqual({ 'ex-json:size': 10 });
    expect(await client.content.read('/ex-json:top/item[name="01"]/size', { format: 'json' })).toEqual({ 'ex-json:size': 9 });
    expect(await client.content.read('/ex-json:top/item[size="09"]/name', { format: 'json' })).toEqual({ 'ex-json:name': '01' });
    expect(await client.content.read('/ex-json:top/item[ratio="2.0"]/name', { format: 'json' })).toEqual({ 'ex-json:name': '01' });
    expect(await client.content.read('/ex-json:top/item[name="a"]/tag[.="x"]', { format: 'json' })).toEqual({ 'ex-json:tag': ['x'] });
  });

  it('readValue(path, { format: json }) resolves with the typed value, or undefined; with format xml the trimmed text', async () => {
    const { client } = await open();
    expect(await client.content.readValue('/ex-json:top/item[name="a"]/size', { format: 'json' })).toBe(7);
    expect(await client.content.readValue('/ex-json:top/item[name="a"]/on', { format: 'json' })).toBe(true);
    expect(await client.content.readValue('/ex-json:top/item[name="a"]/flag', { format: 'json' })).toEqual([null]);
    expect(await client.content.readValue('/ex-json:top/item[name="a"]/note', { format: 'json' })).toBe('  padded  ');
    expect(await client.content.readValue('/ex-json:top/item[name="zz"]/size', { format: 'json' })).toBeUndefined();
    expect(await client.content.readValue('/ex-json:top/item[name="a"]/note', { format: 'xml' })).toBe('padded');
  });

  it('read with format xml resolves with elements, and source operational uses <get>', async () => {
    const { client, fake } = await open();
    const els = await client.content.read('/ex-json:top/item[name="a"]/size', { format: 'xml' });
    expect(els.map((e) => e.text())).toEqual(['7']);
    await client.content.read('/ex-json:top', { source: 'config+state', format: 'json' });
    expect(sent(fake, 'get')).toHaveLength(1);
  });

  it('without a format, read and readValue resolve with JSON (the content layer\'s default)', async () => {
    const { client } = await open();
    expect(await client.content.read('/ex-json:top/item[name="a"]')).toEqual({ 'ex-json:item': TYPED['ex-json:top'].item });
    expect(await client.content.read('/ex-json:top/item[name="zz"]')).toEqual({});
    expect(await client.content.readValue('/ex-json:top/item[name="a"]/size')).toBe(7);
    expect(await client.content.readValue('/ex-json:top/item[name="a"]/note')).toBe('  padded  ');
    expect(await client.content.readValue('/ex-json:top/item[name="zz"]/size')).toBeUndefined();
    // The ops layer keeps XML as its default.
    expect((await client.ops.getConfig()).name).toBe('data');
  });

  it('the declared result types follow the format: JSON by default, XML for format xml, either for a runtime format', async () => {
    const { client } = await open();
    const path = '/ex-json:top/item[name="a"]/size';
    expectTypeOf(client.content.read(path)).resolves.toEqualTypeOf<YangJsonObject>();
    expectTypeOf(client.content.read(path, { format: 'json' })).resolves.toEqualTypeOf<YangJsonObject>();
    expectTypeOf(client.content.read(path, { source: 'config+state' })).resolves.toEqualTypeOf<YangJsonObject>();
    expectTypeOf(client.content.read(path, { format: 'xml' })).resolves.toEqualTypeOf<XmlElement[]>();
    expectTypeOf(client.content.readValue(path)).resolves.toEqualTypeOf<YangJsonValue | undefined>();
    expectTypeOf(client.content.readValue(path, { format: 'xml' })).resolves.toEqualTypeOf<string | undefined>();
    const format = Math.random() < 2 ? ('xml' as 'xml' | 'json') : 'json';
    expectTypeOf(client.content.read(path, { format })).resolves.toEqualTypeOf<XmlElement[] | YangJsonObject>();
    expectTypeOf(client.content.readValue(path, { format })).resolves.toEqualTypeOf<string | YangJsonValue | undefined>();
    // A runtime format still picks the right result.
    expect(await client.content.read(path, { format })).toHaveLength(1);
  });

  it('an unknown format is refused before anything is sent', async () => {
    const { client, fake } = await open();
    const before = fake.requests.length;
    await expect(client.content.read('/ex-json:top', { format: 'yaml' as 'xml' })).rejects.toThrow(TypeError);
    await expect(client.content.readValue('/ex-json:top', { format: 'yaml' as 'xml' })).rejects.toThrow(TypeError);
    expect(fake.requests).toHaveLength(before);
  });

  it('read applies requireSchema like get', async () => {
    const { client } = await open({ yang: {} });
    await expect(client.content.read('/ex-json:top', { format: 'json', json: { requireSchema: true } })).rejects.toThrow(SchemaUnavailableError);
  });

  it('toJson converts YANG data obtained elsewhere by the same rules', async () => {
    const { client } = await open();
    const reply = await client.session.rpc(x('get', { xmlns: NETCONF_NS }));
    expect(await client.content.toJson(reply.data!)).toEqual(TYPED);
    expect(await client.content.toJson(parseXml(`<data xmlns="${NETCONF_NS}"/>`))).toEqual({});
  });
});

describe('OPS-26: conversion failures and warnings suggest format: xml', () => {
  const NONE = '<other xmlns="urn:example:none"><a>1</a></other>';
  const BAD = `<top xmlns="${EJ}"><item><name>a</name><size>big</size></item></top>`;

  it('SchemaUnavailableError from get, get-config, getData and the path read ends with the hint', async () => {
    const { client } = await open({}, server(NONE));
    const strict = { requireSchema: true };
    for (const call of [
      () => client.ops.get({ format: 'json', json: strict }),
      () => client.ops.getConfig({ format: 'json', json: strict }),
      () => client.content.read('/ex-json:top', { json: strict }),
      () => client.content.readValue('/ex-json:top', { json: strict }),
    ]) {
      const err = (await call().catch((e: unknown) => e)) as SchemaUnavailableError;
      expect(err).toBeInstanceOf(SchemaUnavailableError);
      expect(err.message).toMatch(/urn:example:none:other/);
      expect(err.message.endsWith(`. ${READ_AS_XML_HINT}`)).toBe(true);
    }
  });

  it('a YANG data error under requireSchema keeps its class and issues, with the hint on its message', async () => {
    const { client } = await open({}, server(BAD));
    const err = (await client.content.read('/ex-json:top', { json: { requireSchema: true } }).catch((e: unknown) => e)) as YangDataError;
    expect(err).toBeInstanceOf(YangDataError);
    expect(err.code).toBe('ERR_NETCONF_YANG_DATA');
    expect(err.issues.map((i) => i.path).join()).toMatch(/size/);
    expect(err.message).toMatch(/size/);
    expect(err.message.endsWith(`. ${READ_AS_XML_HINT}`)).toBe(true);
    // A clash rethrown under requireSchema gets it too, once.
    const twice = `<top xmlns="${EJ}"><item><name>a</name></item></top><top xmlns="${EJ}"><item><name>b</name></item></top>`;
    const clash = await open({}, server(twice));
    const again = (await clash.client.ops.get({ format: 'json', json: { requireSchema: true } }).catch((e: unknown) => e)) as YangDataError;
    expect(again).toBeInstanceOf(YangDataError);
    expect(again.message.split(READ_AS_XML_HINT)).toHaveLength(2);
  });

  it('a schema-less warning for a missing schema says to supply yang.modules, and suggests format: xml', async () => {
    const { client, warnings } = await open({}, server(`${TOP}${NONE}`));
    // The fake server ignores filters, so <other> comes back with the read too.
    expect(await client.content.read('/ex-json:top')).toEqual({ 'ex-json:top': TYPED['ex-json:top'] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/Supply its modules with yang\.modules \(in connect\(\) or a device profile\) to type it/);
    expect(warnings[0]!.message.endsWith(`. ${READ_AS_XML_HINT}`)).toBe(true);
  });

  it('a schema-less warning for data that does not match the schema suggests format: xml but not yang.modules', async () => {
    const { client, warnings } = await open({}, server(BAD));
    await client.content.read('/ex-json:top');
    expect(warnings[0]!.message).toMatch(/doesn't match the schema/);
    expect(warnings[0]!.message).not.toMatch(/yang\.modules/);
    expect(warnings[0]!.message.endsWith(`. ${READ_AS_XML_HINT}`)).toBe(true);
  });

  it('toJson has no format option, so its errors and warnings carry no hint', async () => {
    const { client, warnings } = await open({}, server(NONE));
    const data = parseXml(`<data xmlns="${NETCONF_NS}">${NONE}</data>`);
    const err = (await client.content.toJson(data, { requireSchema: true }).catch((e: unknown) => e)) as SchemaUnavailableError;
    expect(err).toBeInstanceOf(SchemaUnavailableError);
    expect(err.message).not.toMatch(/format: 'xml'/);
    await client.content.toJson(data);
    expect(warnings[0]!.message).not.toMatch(/format: 'xml'/);
  });
});

describe('CLIENT-06: supplying modules, the profile yang section, and the shared cache', () => {
  it('yang.modules takes a @node-net/yang ModuleSource as well as directories', async () => {
    const text = (n: string): string => readFileSync(join(MODULES, `${n}@2026-11-09.yang`), 'utf8');
    const { client } = await open({ yang: { modules: memorySource([text('ex-json'), text('ex-aug')]) } });
    expect(await client.ops.get({ format: 'json', json: { requireSchema: true } })).toEqual(TYPED);
  });

  it('the profile yang section is optional, validated, and its modules resolve against the profile file', async () => {
    expect(compileProfile({ id: 'plain' }).profile.yang).toBeUndefined();
    expect(() => compileProfile({ id: 'bad', yang: { modulez: [] } })).toThrow(ProfileError);
    expect(() => compileProfile({ id: 'bad', yang: { requireSchema: 'yes' } })).toThrow(ProfileError);
    const dir = mkdtempSync(join(tmpdir(), 'nn-yang-profile-'));
    mkdirSync(join(dir, 'yang'));
    for (const n of ['ex-json', 'ex-aug']) writeFileSync(join(dir, 'yang', `${n}@2026-11-09.yang`), readFileSync(join(MODULES, `${n}@2026-11-09.yang`)));
    writeFileSync(join(dir, 'p.json'), JSON.stringify({ id: 'with-yang', yang: { modules: ['yang'] } }));
    const profile = await loadDeviceProfile(join(dir, 'p.json'));
    expect(profile.yang?.modules).toEqual([join(dir, 'yang')]);
    const { client } = await open({ yang: {}, profile: profile });
    expect(await client.ops.get({ format: 'json', json: { requireSchema: true } })).toEqual(TYPED);
  });

  it('a child profile inherits the parent\'s yang section and overrides it field by field', () => {
    const parent = compileProfile({ id: 'parent', yang: { modules: ['a'], requireSchema: true } }).spec;
    const child = compileProfile({ id: 'child', extends: 'parent', yang: { requireSchema: false } }, parent).profile;
    expect(child.yang).toEqual({ modules: ['a'], requireSchema: false });
  });

  it('clients given the same YangCache fetch and compile a module set once', async () => {
    const cache = new YangCache();
    const caps = [...HELLO, `${MON}?module=ietf-netconf-monitoring&revision=2010-10-04`];
    const first = await open({ yang: { cache } }, server(), caps);
    await first.client.ops.get({ format: 'json' });
    expect(sent(first.fake, 'get-schema')).toHaveLength(2);
    expect(cache.size).toBe(1);
    const second = await open({ yang: { cache } }, server(), caps);
    expect(await second.client.ops.get({ format: 'json' })).toEqual(TYPED);
    expect(sent(second.fake, 'get-schema')).toHaveLength(0);
    // Without the shared cache, a new client fetches again.
    const third = await open({ yang: {} }, server(), caps);
    await third.client.ops.get({ format: 'json' });
    expect(sent(third.fake, 'get-schema')).toHaveLength(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('no schema is read until JSON output is asked for', async () => {
    const caps = [...HELLO, `${MON}?module=ietf-netconf-monitoring&revision=2010-10-04`];
    const { fake, client } = await open({ yang: {} }, server(), caps);
    await client.ops.get();
    await client.content.read('/ex-json:top', { format: 'xml' });
    expect(sent(fake, 'get-schema')).toHaveLength(0);
  });
});
