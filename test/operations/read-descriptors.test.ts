/**
 * OPS-25: extensions' read helpers described as data (`kind: 'read'`),
 * listed in client.ops.list and run by ops.run, against the fake server.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  AbortError,
  BASE_1_0,
  BASE_1_1,
  CapabilityError,
  connect,
  defineExtension,
  NETCONF_NS,
  parseXml,
  x,
  type NetconfClient,
  type XmlElement,
} from '../../src/index.js';
import { MONITORING_NS, monitoring } from '../../src/operations/monitoring.js';
import { NETMOD_NOTIFICATION_NS, notifications } from '../../src/operations/notifications.js';
import { SUBSCRIBED_NOTIFICATIONS_NS, subscriptions } from '../../src/operations/subscriptions.js';
import { YANG_LIBRARY_NS, yangLibrary } from '../../src/operations/yang-library.js';
import { FakeServer, type RpcHandler } from '../../src/testing/index.js';
import type { DeviceProfile } from '../../src/devices/index.js';
import { compileProfile } from '../../src/devices/profile-spec.js';

const compile = (raw: object): DeviceProfile => compileProfile(raw).profile;

const NCM = MONITORING_NS;
const SN = SUBSCRIBED_NOTIFICATIONS_NS;
const YL = YANG_LIBRARY_NS;
const CAPS = [
  BASE_1_0,
  BASE_1_1,
  `${NCM}?module=ietf-netconf-monitoring&revision=2010-10-04`,
  'urn:ietf:params:netconf:capability:notification:1.0',
  `${SN}?module=ietf-subscribed-notifications&revision=2019-09-09&features=replay`,
  'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=1',
];

/** The first element of a <get>'s subtree filter. */
const topOf = (op: XmlElement | undefined): XmlElement | undefined => (op?.name === 'get' ? op.child('filter', NETCONF_NS)?.elements[0] : undefined);

const STATE = parseXml(`<netconf-state xmlns="${NCM}">
  <sessions><session><session-id>4</session-id><transport>netconf-ssh</transport><username>admin</username>
    <source-host>192.0.2.1</source-host><login-time>2026-11-07T00:00:00Z</login-time>
    <in-rpcs>3</in-rpcs><in-bad-rpcs>0</in-bad-rpcs><out-rpc-errors>0</out-rpc-errors><out-notifications>0</out-notifications></session></sessions>
  <schemas><schema><identifier>ietf-interfaces</identifier><version>2018-02-20</version><format>yang</format><namespace>urn:ietf:params:xml:ns:yang:ietf-interfaces</namespace><location>NETCONF</location></schema></schemas>
  <datastores><datastore><name>running</name></datastore></datastores>
  <statistics><netconf-start-time>2026-11-07T00:00:00Z</netconf-start-time><in-sessions>2</in-sessions></statistics>
</netconf-state>`);

/** Answers each read with its data, and counts the gets per top element. */
function server(gets: Map<string, number>): RpcHandler {
  return (_rpc, { operation }) => {
    const top = topOf(operation);
    if (top === undefined) return 'ok';
    const part = top.elements[0]?.name;
    const key = part === undefined ? top.name : `${top.name}/${part}`;
    gets.set(key, (gets.get(key) ?? 0) + 1);
    if (top.name === 'netconf-state') {
      const el = STATE.child(part!, NCM);
      return { data: [x('netconf-state', { xmlns: NCM }, el === undefined ? [] : [el])] };
    }
    if (top.name === 'netconf') {
      return { data: [x('netconf', { xmlns: NETMOD_NOTIFICATION_NS }, x('streams', x('stream', x('name', 'NETCONF'), x('description', 'default'), x('replaySupport', 'true'))))] };
    }
    if (top.name === 'streams') return { data: [x('streams', { xmlns: SN }, x('stream', x('name', 'NETCONF'), x('replay-support')))] };
    if (top.name === 'subscriptions') {
      return { data: [x('subscriptions', { xmlns: SN }, x('subscription', x('id', '9'), x('stream', 'NETCONF'), x('receivers', x('receiver', x('name', 'r'), x('state', 'active')))))] };
    }
    if (top.name === 'yang-library') {
      return { data: [x('yang-library', { xmlns: YL }, x('module-set', x('name', 'all'), x('module', x('name', 'ietf-subscribed-notifications'), x('revision', '2019-09-09'), x('namespace', SN), x('feature', 'replay'))), x('content-id', '1'))] };
    }
    return { data: [] };
  };
}

let clients: NetconfClient[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  clients = [];
});

async function open() {
  const gets = new Map<string, number>();
  const fake = new FakeServer({ capabilities: CAPS, handler: server(gets) });
  const client = await connect({ transport: fake.transport(), extensions: [monitoring, notifications, subscriptions, yangLibrary] });
  clients.push(client);
  return { fake, client, gets };
}

const READS = [
  ['monitoring-schemas', 'monitoring', 'schemas'],
  ['monitoring-sessions', 'monitoring', 'sessions'],
  ['monitoring-datastores', 'monitoring', 'datastores'],
  ['monitoring-statistics', 'monitoring', 'statistics'],
  ['notification-streams', 'notifications', 'streams'],
  ['subscription-streams', 'subscriptions', 'streams'],
  ['subscription-list', 'subscriptions', 'list'],
  ['subscription-support', 'subscriptions', 'support'],
  ['subscription-capabilities', 'subscriptions', 'capabilities'],
  ['yang-library', 'yangLibrary', 'load'],
] as const;

describe('read descriptors: review regressions (OPS-25)', () => {
  it('the built-in reads are deeply frozen, so one client cannot change what another accepts', async () => {
    const { client } = await open();
    for (const d of client.ops.list.filter((o) => o.kind === 'read')) {
      expect(Object.isFrozen(d.params), d.name).toBe(true);
      expect(Object.isFrozen(d.requires), d.name).toBe(true);
      for (const p of d.params) expect(Object.isFrozen(p), `${d.name} ${p.name}`).toBe(true);
    }
  });

  it("a device profile operation named like an extension's helper (statistics, sessions) doesn't clash with its read", async () => {
    const fake = new FakeServer({ capabilities: CAPS, handler: () => 'ok' });
    const profile = compile({ id: 'p', operations: { statistics: { request: '<stats xmlns="urn:example:x"/>' }, sessions: { request: '<s xmlns="urn:example:x"/>' } } });
    const client = await connect({ transport: fake.transport(), profile: profile, extensions: [monitoring, notifications, subscriptions, yangLibrary] });
    clients.push(client);
    expect(client.ops.list.filter((d) => d.name === 'statistics').map((d) => d.device)).toEqual(['p']);
    expect(client.ops.list.find((d) => d.name === 'monitoring-statistics')?.extension).toBe('monitoring');
  });

  it("a profile descriptor can't pass itself off as an extension read", async () => {
    const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1], handler: () => 'ok' });
    // A TypeScript profile can carry any descriptor fields.
    const base = compile({ id: 'p', operations: { peek: { request: '<peek xmlns="urn:example:x"/>', mutates: false } } });
    const profile: DeviceProfile = { ...base, descriptors: { peek: { ...base.descriptors!['peek']!, kind: 'read' } } };
    const client = await connect({ transport: fake.transport(), profile: profile });
    clients.push(client);
    expect(client.ops.list.find((d) => d.name === 'peek')?.kind).toBeUndefined();
  });
});

describe('read descriptors (OPS-25)', () => {
  it('AC1, AC2: client.ops.list lists each enabled extension\'s reads as plain data, never mutating', async () => {
    const { client } = await open();
    const reads = client.ops.list.filter((d) => d.kind === 'read');
    expect(reads.map((d) => [d.name, d.extension, d.method])).toEqual(READS.map((r) => [...r]));
    for (const d of reads) expect(d.mutates).toBe(false);
    expect(reads.find((d) => d.name === 'yang-library')!.params.map((p) => p.name)).toEqual(['refresh']);
    expect(reads.find((d) => d.name === 'subscription-support')!.params.map((p) => p.name)).toEqual(['refresh']);
    expect(JSON.parse(JSON.stringify(reads))).toEqual(reads);
    // RPC descriptors are unchanged: no kind.
    expect(client.ops.list.find((d) => d.name === 'get-schema')!.kind).toBeUndefined();
  });

  it('AC3: ops.run runs each read through its extension content method and resolves with the decoded result', async () => {
    const { client } = await open();
    const ext = client.content as unknown as Record<string, Record<string, () => Promise<unknown>>>;
    for (const [name, id, method] of READS) {
      const viaDescriptor = await client.ops.run(name);
      expect(viaDescriptor, name).toEqual(await ext[id]![method]!());
    }
    const sessions = (await client.ops.run('monitoring-sessions')) as { sessionId: number; username: string }[];
    expect(sessions[0]).toMatchObject({ sessionId: 4, username: 'admin' });
    expect(await client.ops.run('subscription-list')).toMatchObject([{ id: 9, stream: 'NETCONF' }]);
  });

  it('AC3: refresh is passed through, so yang-library reads again', async () => {
    const { client, gets } = await open();
    await client.ops.run('yang-library');
    await client.ops.run('yang-library');
    expect(gets.get('yang-library')).toBe(1);
    await client.ops.run('yang-library', { refresh: true });
    expect(gets.get('yang-library')).toBe(2);
  });

  it('AC3: unknown arguments are refused before anything is sent; per-call signal and timeout apply', async () => {
    const { fake, client } = await open();
    const before = fake.requests.length;
    await expect(client.ops.run('monitoring-sessions', { bogus: 1 })).rejects.toThrow(/monitoring-sessions has no option "bogus"/);
    // Types and required arguments are checked too: a read has no request builder to do it.
    await expect(client.ops.run('yang-library', { refresh: 'true' })).rejects.toThrow(/yang-library: refresh must be a boolean/);
    expect(fake.requests.length).toBe(before);
    const aborted = AbortSignal.abort();
    await expect(client.ops.run('monitoring-sessions', {}, { signal: aborted })).rejects.toThrow(AbortError);
    expect(fake.requests.length).toBe(before);
  });

  it('AC3: capability checks apply as for the method', async () => {
    const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1], handler: () => ({ data: [] }) });
    const client = await connect({ transport: fake.transport(), extensions: [yangLibrary] });
    clients.push(client);
    await expect(client.ops.run('yang-library')).rejects.toThrow(/yang-library/);
    expect(fake.requests).toHaveLength(0);
  });

  describe('AC4: validation', () => {
    const transport = () => Promise.reject(new Error('should not open'));
    const read = { name: 'peek', kind: 'read', namespace: 'urn:example:peek', method: 'peek', description: 'Peek', mutates: false, requires: [], params: [] } as const;

    it('a read that mutates, or one with no content section to run it, is refused before the transport opens', async () => {
      const mutating = defineExtension({ id: 'm', descriptors: [{ ...read, mutates: true }], content: () => ({ peek: () => Promise.resolve(1) }) });
      await expect(connect({ transport, extensions: [mutating] })).rejects.toThrow(/describes peek as a read that mutates/);
      const noOps = defineExtension({ id: 'n', descriptors: [read] });
      await expect(connect({ transport, extensions: [noOps] })).rejects.toThrow(/describes the read peek but has no content section/);
    });

    it('a read needs no request builder', async () => {
      const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
      const ok = defineExtension({ id: 'p', descriptors: [read], content: () => ({ peek: (o: object) => Promise.resolve({ seen: o }) }) });
      const client = await connect({ transport: fake.transport(), extensions: [ok] });
      clients.push(client);
      expect(await client.ops.run('peek', {}, { timeout: 50 })).toEqual({ seen: { timeout: 50 } });
    });

    it('review: a read param named like a per-call option, or a method from the prototype, is refused', async () => {
      const timeoutParam = defineExtension({
        id: 't',
        descriptors: [{ ...read, params: [{ name: 'timeout', kind: 'option', type: 'number', description: 'x' }] }],
        content: () => ({ peek: () => Promise.resolve(1) }),
      });
      await expect(connect({ transport, extensions: [timeoutParam] })).rejects.toThrow(/can't have a parameter named timeout/);
      const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
      const inherited = defineExtension({ id: 'i', descriptors: [{ ...read, method: 'toString' }], content: () => ({}) });
      await expect(connect({ transport: fake.transport(), extensions: [inherited] })).rejects.toThrow(/has no method toString/);
    });

    it('review: a required read argument must be given', async () => {
      const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
      const needs = defineExtension({
        id: 'r',
        descriptors: [{ ...read, params: [{ name: 'which', kind: 'positional', type: 'string', description: 'x', required: true }] }],
        content: () => ({ peek: (o: object) => Promise.resolve(o) }),
      });
      const client = await connect({ transport: fake.transport(), extensions: [needs] });
      clients.push(client);
      await expect(client.ops.run('peek')).rejects.toThrow(/peek needs which/);
      expect(await client.ops.run('peek', { which: 'a' })).toEqual({ which: 'a' });
    });

    it("review: a read's own requires is checked under capabilityCheck, before its method runs", async () => {
      const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
      let ran = false;
      const needsCap = defineExtension({
        id: 'c',
        descriptors: [{ ...read, requires: ['urn:example:peek-cap'] }],
        content: () => ({ peek: () => { ran = true; return Promise.resolve(1); } }),
      });
      const strict = await connect({ transport: fake.transport(), extensions: [needsCap] });
      clients.push(strict);
      await expect(strict.ops.run('peek')).rejects.toThrow(CapabilityError);
      expect(ran).toBe(false);
      const fake2 = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
      const off = await connect({ transport: fake2.transport(), extensions: [needsCap], capabilityCheck: 'off' });
      clients.push(off);
      expect(await off.ops.run('peek')).toBe(1);
    });

    it('a read naming a method its content section lacks makes connect() reject, closing the session first', async () => {
      const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
      const missing = defineExtension({ id: 'q', descriptors: [read], content: () => ({ other: () => Promise.resolve(1) }) });
      const err = await connect({ transport: fake.transport(), extensions: [missing] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message).toMatch(/describes the read peek, but its content section has no method peek/);
      expect(fake.requests.at(-1)?.elements[0]?.name).toBe('close-session');
    });
  });
});
