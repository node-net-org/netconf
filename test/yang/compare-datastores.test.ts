/**
 * Comparing configuration datastores in the client,
 * against the fake server: CONTENT-11 (compareDatastores, getCandidateChanges,
 * txn.getCandidateChanges) and OPS-21's txn.getCandidateChanges criterion.
 *
 * The fixture modules: ex-edit (ordered-by-user list and leaf-list) and
 * ex-json (a keyed list with an identityref), from test/fixtures/yang/json.
 */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AbortError,
  BASE_1_0,
  BASE_1_1,
  CapabilityError,
  connect,
  NETCONF_NS,
  parseXml,
  SchemaUnavailableError,
  subtree,
  x,
  YangDataError,
  type ConnectOptions,
  type NetconfClient,
  type XmlElement,
} from '../../src/index.js';
import { TransactionError, withCandidate } from '../../src/operations/transaction.js';
import { FakeServer, type RpcHandler } from '../../src/testing/index.js';

const MODULES = fileURLToPath(new URL('../fixtures/yang/json/', import.meta.url));
const EJ = 'urn:example:json';
const EE = 'urn:example:edit';
const CAP = (n: string): string => `urn:ietf:params:netconf:capability:${n}`;
const EI = 'urn:example:ident';
const MODS = [`${EJ}?module=ex-json&revision=2026-11-09`, `${EE}?module=ex-edit&revision=2026-11-09`, `${EI}?module=ex-ident&revision=2026-11-09`];
const HELLO = [BASE_1_0, BASE_1_1, CAP('candidate:1.0'), CAP('startup:1.0'), CAP('xpath:1.0'), ...MODS];

const RUNNING =
  `<sys xmlns="${EE}"><host>a</host><mtu>1500</mtu>` +
  `<user><name>x</name><uid>1</uid></user><user><name>y</name></user>` +
  `<dns>1</dns><dns>2</dns></sys>`;
const CANDIDATE =
  `<sys xmlns="${EE}"><host>b</host>` +
  `<user><name>y</name></user><user><name>x</name><uid>2</uid></user><user><name>z</name></user>` +
  `<dns>2</dns><dns>1</dns><dns>3</dns></sys>`;

/** Every change between RUNNING and CANDIDATE, in the order @node-net/yang's diff reports them. */
const EXPECTED = [
  { operation: 'replace', path: '/ex-edit:sys/host', value: 'b', previous: 'a' },
  { operation: 'move', path: "/ex-edit:sys/user[name='y']", value: { name: 'y' }, position: { where: 'first' } },
  { operation: 'create', path: "/ex-edit:sys/user[name='z']", value: { name: 'z' }, position: { where: 'after', anchor: "/ex-edit:sys/user[name='x']" } },
  { operation: 'replace', path: "/ex-edit:sys/user[name='x']/uid", value: 2, previous: 1 },
  { operation: 'move', path: "/ex-edit:sys/dns[.='2']", value: '2', position: { where: 'first' } },
  { operation: 'create', path: "/ex-edit:sys/dns[.='3']", value: '3', position: { where: 'after', anchor: "/ex-edit:sys/dns[.='1']" } },
  { operation: 'delete', path: '/ex-edit:sys/mtu', previous: 1500 },
];

const dataOf = (xml: string): XmlElement[] => parseXml(`<data xmlns="${NETCONF_NS}">${xml}</data>`).elements;

/** The datastore a get-config reads. */
const sourceOf = (op: XmlElement): string => op.child('source', NETCONF_NS)!.elements[0]!.name;

/** Answer get-config from `stores` by its source; anything else with ok. */
function server(stores: Readonly<Record<string, string>>): RpcHandler {
  return (_rpc, ctx) => {
    if (ctx.operation?.name === 'get-config') return { data: dataOf(stores[sourceOf(ctx.operation)] ?? '') };
    return 'ok';
  };
}

let clients: NetconfClient[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

async function open(stores: Readonly<Record<string, string>>, capabilities: readonly string[] = HELLO, options: Partial<ConnectOptions> = {}) {
  const fake = new FakeServer({ capabilities: [...capabilities], handler: server(stores) });
  const client = await connect({ transport: fake.transport(), yang: { modules: MODULES }, ...options });
  clients.push(client);
  return { fake, client };
}

const ops = (fake: FakeServer): XmlElement[] => fake.requests.map((r) => r.elements[0]!);
const getConfigs = (fake: FakeServer): XmlElement[] => ops(fake).filter((e) => e.name === 'get-config');

describe('CONTENT-11: compareDatastores', () => {
  it('lists the changes that turn the source into the target: create, delete, replace and move, with paths, values and positions', async () => {
    const { client } = await open({ running: RUNNING, candidate: CANDIDATE });
    expect(await client.content.compareDatastores({ source: 'running', target: 'candidate' })).toEqual(EXPECTED);
  });

  it('reads both datastores with get-config', async () => {
    const { client, fake } = await open({ running: RUNNING, startup: CANDIDATE });
    await client.content.compareDatastores({ source: 'startup', target: 'running' });
    expect(getConfigs(fake).map(sourceOf)).toEqual(['startup', 'running']);
  });

  it('resolves with an empty list when the datastores hold the same configuration', async () => {
    const { client } = await open({ running: RUNNING, candidate: RUNNING });
    expect(await client.content.compareDatastores({ source: 'running', target: 'candidate' })).toEqual([]);
  });

  it('resolves with an empty list when both datastores are empty', async () => {
    const { client } = await open({ running: '', candidate: '' });
    expect(await client.content.compareDatastores({ source: 'running', target: 'candidate' })).toEqual([]);
  });

  it('reports a whole created or deleted subtree once, as its object', async () => {
    const { client } = await open({ running: '', candidate: RUNNING });
    expect(await client.content.compareDatastores({ source: 'running', target: 'candidate' })).toEqual([
      { operation: 'create', path: '/ex-edit:sys', value: { host: 'a', mtu: 1500, user: [{ name: 'x', uid: 1 }, { name: 'y' }], dns: ['1', '2'] } },
    ]);
    expect(await client.content.compareDatastores({ source: 'candidate', target: 'running' })).toEqual([
      { operation: 'delete', path: '/ex-edit:sys', previous: { host: 'a', mtu: 1500, user: [{ name: 'x', uid: 1 }, { name: 'y' }], dns: ['1', '2'] } },
    ]);
  });

  it('matches list entries by key, so an inserted entry is one create, with typed values', async () => {
    const item = (name: string, extra = ''): string => `<item><name>${name}</name>${extra}</item>`;
    const before = `<top xmlns="${EJ}">${item('a')}${item('c')}</top>`;
    const after = `<top xmlns="${EJ}">${item('a')}${item('b', `<count>5</count><kind xmlns:ej="${EJ}">ej:fast</kind>`)}${item('c')}</top>`;
    const { client } = await open({ running: before, candidate: after });
    expect(await client.content.compareDatastores({ source: 'running', target: 'candidate' })).toEqual([
      { operation: 'create', path: "/ex-json:top/item[name='b']", value: { name: 'b', count: '5', kind: 'ex-json:fast' } },
    ]);
  });

  it('types identities from modules the data only names in a value prefix (as iana-if-type interface types)', async () => {
    const item = (kind: string): string => `<top xmlns="${EJ}"><item xmlns:ei="${EI}"><name>a</name><kind>${kind}</kind></item></top>`;
    const { client } = await open({ running: item('ei:slow'), candidate: item('ei:slow').replace('<name>a</name>', '<name>a</name><count>1</count>') });
    expect(await client.content.compareDatastores({ source: 'running', target: 'candidate' })).toEqual([
      { operation: 'create', path: "/ex-json:top/item[name='a']/count", value: '1' },
    ]);
  });

  it('sends the same filter with both reads', async () => {
    const { client, fake } = await open({ running: RUNNING, candidate: CANDIDATE });
    await client.content.compareDatastores({ source: 'running', target: 'candidate', filter: subtree(x('sys', { xmlns: EE }, x('host'))) });
    const filters = getConfigs(fake).map((g) => g.child('filter', NETCONF_NS)!.toString());
    expect(filters).toHaveLength(2);
    expect(filters[0]).toBe(filters[1]);
    expect(filters[0]).toContain('host');
  });

  it('takes an RFC 7951 JSON filter, converted for both reads', async () => {
    const { client, fake } = await open({ running: RUNNING, candidate: CANDIDATE });
    await client.content.compareDatastores({ source: 'running', target: 'candidate', filter: { 'ex-edit:sys': { host: 'a' } } });
    for (const g of getConfigs(fake)) {
      const filter = g.child('filter', NETCONF_NS)!;
      expect(filter.attr('type')).toBe('subtree');
      expect(filter.path('sys/host')).toBeDefined();
    }
  });

  it('refuses a datastore the server lacks under the capability policy, before sending', async () => {
    const { client, fake } = await open({ running: RUNNING }, [BASE_1_0, BASE_1_1, ...MODS]);
    await expect(client.content.compareDatastores({ source: 'running', target: 'candidate' })).rejects.toBeInstanceOf(CapabilityError);
    await expect(client.content.compareDatastores({ source: 'startup', target: 'running' })).rejects.toBeInstanceOf(CapabilityError);
    expect(getConfigs(fake).filter((g) => sourceOf(g) !== 'running')).toEqual([]);
  });

  it('refuses a source or target that is not a configuration datastore', async () => {
    const { client, fake } = await open({ running: RUNNING });
    await expect(client.content.compareDatastores({ source: 'operational' as 'running', target: 'running' })).rejects.toThrow(TypeError);
    expect(getConfigs(fake)).toEqual([]);
  });

  it('rejects with SchemaUnavailableError, not a schema-less comparison, when a node has no module', async () => {
    const { client } = await open({ running: RUNNING, candidate: `<other xmlns="urn:example:unknown"/>` });
    await expect(client.content.compareDatastores({ source: 'running', target: 'candidate' })).rejects.toBeInstanceOf(SchemaUnavailableError);
  });

  it('rejects with SchemaUnavailableError when the server lists no YANG modules', async () => {
    const { client } = await open({ running: RUNNING, candidate: CANDIDATE }, [BASE_1_0, BASE_1_1, CAP('candidate:1.0')]);
    await expect(client.content.compareDatastores({ source: 'running', target: 'candidate' })).rejects.toBeInstanceOf(SchemaUnavailableError);
  });

  it('rejects with a YANG data error when the data does not match the schema', async () => {
    const { client } = await open({ running: RUNNING, candidate: `<sys xmlns="${EE}"><mtu>5</mtu></sys>` });
    await expect(client.content.compareDatastores({ source: 'running', target: 'candidate' })).rejects.toBeInstanceOf(YangDataError);
  });

  it('honours an aborted signal', async () => {
    const { client } = await open({ running: RUNNING, candidate: CANDIDATE });
    await expect(client.content.compareDatastores({ source: 'running', target: 'candidate', signal: AbortSignal.abort() })).rejects.toBeInstanceOf(AbortError);
  });
});

describe('CONTENT-11: getCandidateChanges', () => {
  it('is compareDatastores from running to candidate', async () => {
    const { client, fake } = await open({ running: RUNNING, candidate: CANDIDATE });
    expect(await client.content.getCandidateChanges()).toEqual(EXPECTED);
    expect(getConfigs(fake).map(sourceOf)).toEqual(['running', 'candidate']);
  });

  it('passes the filter through', async () => {
    const { client, fake } = await open({ running: RUNNING, candidate: CANDIDATE });
    await client.content.getCandidateChanges({ filter: subtree(x('sys', { xmlns: EE }, x('host'))) });
    expect(getConfigs(fake).every((g) => g.child('filter', NETCONF_NS) !== undefined)).toBe(true);
  });
});

describe('OPS-21 / CONTENT-11: txn.getCandidateChanges', () => {
  it('lists the candidate changes inside the transaction, after the edits and before the commit', async () => {
    const { client, fake } = await open({ running: RUNNING, candidate: CANDIDATE });
    const changes = await withCandidate(client, async (txn) => {
      await txn.editConfig({ config: x('sys', { xmlns: EE }, x('host', 'b')) });
      return txn.getCandidateChanges();
    });
    expect(changes).toEqual(EXPECTED);
    const names = ops(fake).map((e) => (e.name === 'get-config' ? `get-config ${sourceOf(e)}` : e.name));
    expect(names).toEqual(['lock', 'lock', 'discard-changes', 'edit-config', 'get-config running', 'get-config candidate', 'commit', 'unlock', 'unlock']);
  });

  it('throwing after reviewing the changes discards the candidate and commits nothing', async () => {
    const { client, fake } = await open({ running: RUNNING, candidate: CANDIDATE });
    const err = await withCandidate(client, async (txn) => {
      if ((await txn.getCandidateChanges()).length > 0) throw new Error('not approved');
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionError);
    const names = ops(fake).map((e) => e.name);
    expect(names).not.toContain('commit');
    expect(names.filter((n) => n === 'discard-changes')).toHaveLength(2);
  });

  it('rejects with a TypeError when the transaction was started with a bare session', async () => {
    const { client } = await open({ running: RUNNING, candidate: CANDIDATE });
    const err = await withCandidate(client.session, (txn) => txn.getCandidateChanges()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionError);
    expect((err as TransactionError).cause).toBeInstanceOf(TypeError);
  });

  it('throws once the transaction has ended', async () => {
    const { client } = await open({ running: RUNNING, candidate: CANDIDATE });
    let saved: Parameters<Parameters<typeof withCandidate>[1]>[0] | undefined;
    await withCandidate(client, (txn) => {
      saved = txn;
    });
    await expect(saved!.getCandidateChanges()).rejects.toBeInstanceOf(TransactionError);
  });
});
