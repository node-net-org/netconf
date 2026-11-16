/**
 * CONTENT-04: path edits are checked against the edit target's schema in the
 * YANG library: a module the library implements only in another datastore's
 * schema is refused before anything is locked or sent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  BASE_1_0,
  BASE_1_1,
  connect,
  NETCONF_NS,
  PathError,
  x,
  type ConnectOptions,
  type NetconfClient,
  type SessionWarning,
  type XmlElement,
} from '../../src/index.js';
import { FakeServer, type RpcHandler } from '../../src/testing/index.js';

const CAP = (n: string): string => `urn:ietf:params:netconf:capability:${n}`;
const YL = 'urn:ietf:params:xml:ns:yang:ietf-yang-library';
const DS = 'urn:ietf:params:xml:ns:yang:ietf-datastores';
const IF = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
const STATE = 'urn:example:acme:state';
const OTHER = 'urn:example:other';
const YL_1_1 = `${CAP('yang-library:1.1')}?revision=2019-01-04&content-id=1`;
const CAPS = [BASE_1_0, BASE_1_1, CAP('writable-running:1.0'), YL_1_1];

const mod = (name: string, ns: string): XmlElement => x('module', x('name', name), x('namespace', ns));

/** running uses the config schema; operational adds acme-state. */
const LIBRARY = x('yang-library', { xmlns: YL, 'xmlns:ds': DS },
  x('module-set', x('name', 'config'), mod('ietf-interfaces', IF)),
  x('module-set', x('name', 'state'), mod('acme-state', STATE)),
  x('schema', x('name', 'config'), x('module-set', 'config')),
  x('schema', x('name', 'complete'), x('module-set', 'config'), x('module-set', 'state')),
  x('datastore', x('name', 'ds:running'), x('schema', 'config')),
  x('datastore', x('name', 'ds:operational'), x('schema', 'complete')),
  x('content-id', '1'),
);

/** The same modules in module sets, with no schemas or datastores. */
const NO_DATASTORES = x('yang-library', { xmlns: YL },
  x('module-set', x('name', 'config'), mod('ietf-interfaces', IF)),
  x('module-set', x('name', 'state'), mod('acme-state', STATE)),
  x('content-id', '1'),
);

const isLibraryGet = (op: XmlElement | undefined): boolean =>
  op?.name === 'get' && op.child('filter', NETCONF_NS)?.elements[0]?.name === 'yang-library';

const server = (library: XmlElement): RpcHandler => (_rpc, ctx) => (isLibraryGet(ctx.operation) ? { data: library } : 'ok');

let clients: NetconfClient[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

async function open(options: Partial<ConnectOptions> = {}, library = LIBRARY) {
  const fake = new FakeServer({ capabilities: CAPS, handler: server(library) });
  const client = await connect({ transport: fake.transport(), ...options });
  clients.push(client);
  const warnings: SessionWarning[] = [];
  client.session.on('warning', (w) => warnings.push(w));
  return { fake, client, warnings };
}

const ops = (fake: FakeServer): string[] => fake.requests.map((r) => (isLibraryGet(r.elements[0]) ? 'yang-library' : r.elements[0]!.name));

const STATE_PATH = '/acme-state:counters/reset';
const IF_PATH = '/ietf-interfaces:interfaces/interface[name="eth0"]/description';

describe("CONTENT-04: edits checked against the target's schema", () => {
  it("refuses a module that only another datastore's schema implements, sending nothing", async () => {
    const { fake, client } = await open();
    const err = await client.content.set(STATE_PATH, 'true').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PathError);
    expect((err as PathError).message).toBe(
      `configure: ${STATE_PATH} is in module acme-state, which the server's YANG library implements in operational but not in running, the datastore this edit goes to`,
    );
    expect(ops(fake)).toEqual(['yang-library']);
  });

  it("refuses it in a transaction with other, valid edits", async () => {
    const { fake, client } = await open();
    await expect(
      client.content.configure((txn) => {
        txn.set(IF_PATH, 'uplink');
        txn.set(STATE_PATH, 'true');
      }),
    ).rejects.toThrow(PathError);
    expect(ops(fake)).toEqual(['yang-library']);
  });

  it("checkEdits() refuses it as configure() would", async () => {
    const { fake, client } = await open();
    await expect(client.content.checkEdits((txn) => txn.set(STATE_PATH, 'true'))).rejects.toThrow(/not in running/);
    expect(ops(fake)).toEqual(['yang-library']);
  });

  it("sends an edit to a module the target's schema implements", async () => {
    const { fake, client } = await open();
    await client.content.loadModules();
    await client.content.set(IF_PATH, 'uplink');
    expect(ops(fake)).toEqual(['yang-library', 'lock', 'edit-config', 'unlock']);
  });

  it("leaves a module the library doesn't implement anywhere to the server", async () => {
    const { fake, client } = await open({ namespaces: { 'other-mod': OTHER } });
    await client.content.loadModules();
    await client.content.set('/other-mod:settings/value', '1');
    expect(ops(fake)).toEqual(['yang-library', 'lock', 'edit-config', 'unlock']);
  });

  it("doesn't check against a library that lists no datastores", async () => {
    const { fake, client } = await open({}, NO_DATASTORES);
    await client.content.set(STATE_PATH, 'true');
    expect(ops(fake)).toEqual(['yang-library', 'lock', 'edit-config', 'unlock']);
  });

  it("with capabilityCheck 'warn', warns and sends", async () => {
    const { fake, client, warnings } = await open({ capabilityCheck: 'warn' });
    await client.content.set(STATE_PATH, 'true');
    expect(ops(fake)).toEqual(['yang-library', 'lock', 'edit-config', 'unlock']);
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringMatching(/module acme-state, .* not in running, .*; sending anyway$/),
    ]);
  });

  it("with capabilityCheck 'off', sends without a warning", async () => {
    const { fake, client, warnings } = await open({ capabilityCheck: 'off' });
    await client.content.set(STATE_PATH, 'true');
    expect(ops(fake)).toEqual(['yang-library', 'lock', 'edit-config', 'unlock']);
    expect(warnings).toEqual([]);
  });
});
