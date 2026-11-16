/**
 * CONTENT-12: client.content.datastores(), from the YANG library or the
 * hello's capabilities, against the fake server.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { compileProfile } from '../../src/devices/profile-spec.js';
import {
  AbortError,
  BASE_1_0,
  BASE_1_1,
  connect,
  NETCONF_NS,
  x,
  type ConnectOptions,
  type DatastoreSource,
  type NetconfClient,
  type ServerDatastore,
  type ServerDatastores,
  type XmlElement,
} from '../../src/index.js';
import { FakeServer, type RpcHandler, type RpcHandlerResult } from '../../src/testing/index.js';

const CAP = (n: string): string => `urn:ietf:params:netconf:capability:${n}`;
const YL = 'urn:ietf:params:xml:ns:yang:ietf-yang-library';
const DS = 'urn:ietf:params:xml:ns:yang:ietf-datastores';
const FD = 'urn:ietf:params:xml:ns:yang:ietf-factory-default';
const YL_1_1 = `${CAP('yang-library:1.1')}?revision=2019-01-04&content-id=1`;
const YL_1_0 = `${CAP('yang-library:1.0')}?revision=2016-06-21&module-set-id=1`;

/** An NMDA library: two schemas, and a non-standard datastore identity. */
const LIBRARY = x('yang-library', { xmlns: YL, 'xmlns:ds': DS, 'xmlns:fd': FD },
  x('module-set', x('name', 'config'), x('module', x('name', 'ietf-interfaces'), x('namespace', 'urn:ietf:params:xml:ns:yang:ietf-interfaces'))),
  x('module-set', x('name', 'state'), x('module', x('name', 'ietf-factory-default'), x('namespace', FD))),
  x('schema', x('name', 'config'), x('module-set', 'config')),
  x('schema', x('name', 'complete'), x('module-set', 'config'), x('module-set', 'state')),
  x('datastore', x('name', 'ds:running'), x('schema', 'config')),
  x('datastore', x('name', 'ds:candidate'), x('schema', 'config')),
  x('datastore', x('name', 'ds:operational'), x('schema', 'complete')),
  x('datastore', x('name', 'fd:factory-default'), x('schema', 'config')),
  x('content-id', '1'),
);

/** A 1.1 library with module sets but no datastores (Clixon's shape). */
const NO_DATASTORES = x('yang-library', { xmlns: YL },
  x('module-set', x('name', 'top'), x('module', x('name', 'clixon-example'), x('namespace', 'urn:example:clixon'))),
  x('content-id', '1'),
);

const isLibraryGet = (op: XmlElement | undefined): boolean => op?.name === 'get' && op.child('filter', NETCONF_NS)?.elements[0]?.name === 'yang-library';

function server(library: () => RpcHandlerResult | Promise<RpcHandlerResult> = () => ({ data: LIBRARY })): RpcHandler {
  return (_rpc, ctx) => (isLibraryGet(ctx.operation) ? library() : 'ok');
}

let clients: NetconfClient[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

async function open(capabilities: string[], handler: RpcHandler = server(), options: Partial<ConnectOptions> = {}) {
  const fake = new FakeServer({ capabilities, handler });
  const client = await connect({ transport: fake.transport(), ...options });
  clients.push(client);
  return { fake, client };
}

const std = (name: string) => ({ name: `ietf-datastores:${name}` });

describe('CONTENT-12: client.content.datastores()', () => {
  it("lists the YANG library's datastores, in library order with their schemas", async () => {
    const { fake, client } = await open([BASE_1_0, BASE_1_1, CAP('candidate:1.0'), YL_1_1]);
    expect(await client.content.datastores()).toEqual({
      source: 'yang-library',
      datastores: [
        { ...std('running'), schema: 'config' },
        { ...std('candidate'), schema: 'config' },
        { ...std('operational'), schema: 'complete' },
        // named by the library's own module for its namespace
        { name: 'ietf-factory-default:factory-default', schema: 'config' },
      ],
    });
    expect(fake.requests).toHaveLength(1);
  });

  it("doesn't add capability datastores the library leaves out", async () => {
    // :startup is advertised, but the library is the complete list.
    const { client } = await open([BASE_1_0, BASE_1_1, CAP('candidate:1.0'), CAP('startup:1.0'), YL_1_1]);
    const { datastores } = await client.content.datastores();
    expect(datastores.map((d) => d.name)).not.toContain('ietf-datastores:startup');
  });

  it('shares the session library read; refresh reads it again', async () => {
    const { fake, client } = await open([BASE_1_0, BASE_1_1, YL_1_1]);
    await client.content.loadModules();
    await client.content.datastores();
    expect(fake.requests).toHaveLength(1);
    await client.content.datastores({ refresh: true });
    expect(fake.requests).toHaveLength(2);
  });

  it.each([
    ['running only', [], ['running']],
    [':candidate', [CAP('candidate:1.0')], ['running', 'candidate']],
    [':startup', [CAP('startup:1.0')], ['running', 'startup']],
    [':candidate and :startup', [CAP('startup:1.0'), CAP('candidate:1.0')], ['running', 'candidate', 'startup']],
  ])('without a YANG library, derives the list from the capabilities (%s), sending nothing', async (_label, extra, names) => {
    const { fake, client } = await open([BASE_1_0, BASE_1_1, ...extra]);
    expect(await client.content.datastores()).toEqual({ source: 'capabilities', datastores: names.map(std) });
    expect(fake.requests).toHaveLength(0);
  });

  it('uses the capabilities with only :yang-library:1.0, sending nothing', async () => {
    const { fake, client } = await open([BASE_1_0, BASE_1_1, CAP('candidate:1.0'), YL_1_0]);
    expect(await client.content.datastores()).toEqual({ source: 'capabilities', datastores: [std('running'), std('candidate')] });
    expect(fake.requests).toHaveLength(0);
  });

  it('uses the capabilities when a 1.1 library lists no datastores', async () => {
    const { fake, client } = await open([BASE_1_0, BASE_1_1, CAP('candidate:1.0'), YL_1_1], server(() => ({ data: NO_DATASTORES })));
    expect(await client.content.datastores()).toEqual({ source: 'capabilities', datastores: [std('running'), std('candidate')] });
    expect(fake.requests).toHaveLength(1);
  });

  it("follows the profile's capability corrections", async () => {
    const device = compileProfile({ id: 'no-candidate', capabilities: { remove: [CAP('candidate:1.0')], add: [CAP('startup:1.0')] } }).profile;
    const { client } = await open([BASE_1_0, BASE_1_1, CAP('candidate:1.0')], server(), { profile: device });
    expect((await client.content.datastores()).datastores.map((d) => d.name)).toEqual(['ietf-datastores:running', 'ietf-datastores:startup']);
  });

  it('rejects when the library read fails, and reads again next time', async () => {
    let fail = true;
    const { fake, client } = await open(
      [BASE_1_0, BASE_1_1, YL_1_1],
      server(() => {
        if (!fail) return { data: LIBRARY };
        fail = false;
        return { errors: [{ type: 'application', tag: 'access-denied', message: 'no' }] };
      }),
    );
    await expect(client.content.datastores()).rejects.toThrow(/access-denied|no/);
    await expect(client.content.datastores()).resolves.toHaveProperty('source', 'yang-library');
    expect(fake.requests).toHaveLength(2);
  });

  it("rejects with AbortError when the caller's signal aborts", async () => {
    const { client } = await open([BASE_1_0, BASE_1_1, YL_1_1], server(() => new Promise<RpcHandlerResult>(() => {})));
    const ac = new AbortController();
    const pending = client.content.datastores({ signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toThrow(AbortError);
  });
});

describe('CONTENT-12: exported types', () => {
  it('types the result with ServerDatastores, ServerDatastore and DatastoreSource', async () => {
    const { client } = await open([BASE_1_0, BASE_1_1]);
    const result: ServerDatastores = await client.content.datastores();
    const source: DatastoreSource = result.source;
    const first: ServerDatastore | undefined = result.datastores[0];
    expect([source, first?.name]).toEqual(['capabilities', 'ietf-datastores:running']);
  });
});
