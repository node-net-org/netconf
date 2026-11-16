/**
 * Timeout values (MESSAGES-10, CLIENT-02, OPS-21). Node clamps a
 * timer delay above 2^31-1 ms, Infinity included, to 1 ms and warns, so a
 * caller's long timeout used to fire almost at once, after the RPC had been
 * sent. Infinity now means no timer, longer values are clamped quietly, and
 * values that make no sense are refused before anything is sent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileProfile } from '../../src/devices/profile-spec.js';
import {
  BASE_1_0,
  BASE_1_1,
  connect,
  serializeXml,
  x,
  type ConnectionFactory,
  type NetconfClient,
} from '../../src/index.js';
import { openSession } from '../../src/messages/index.js';
import { withCandidate } from '../../src/operations/transaction.js';
import { FakeServer, type RpcHandler } from '../../src/testing/index.js';
import { watchConnection } from '../support/connections.js';

const CAP = (n: string): string => `urn:ietf:params:netconf:capability:${n}`;
const CAPS = [BASE_1_0, BASE_1_1, CAP('candidate:1.0'), CAP('confirmed-commit:1.1')];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Replies `<ok/>` after `ms`, long enough for a 1 ms timer to have fired. */
const slow = (ms: number): RpcHandler => () => sleep(ms).then(() => 'ok' as const);

let warnings: Error[] = [];
const onWarning = (w: Error): void => void warnings.push(w);
let clients: NetconfClient[] = [];
beforeEach(() => {
  warnings = [];
  process.on('warning', onWarning);
});
afterEach(async () => {
  process.off('warning', onWarning);
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  clients = [];
});

async function open(handler?: RpcHandler, timeouts?: Record<string, number>) {
  const fake = new FakeServer({ capabilities: CAPS, ...(handler ? { handler } : {}) });
  const client = await connect({ transport: fake.transport(), ...(timeouts ? { timeouts } : {}) });
  clients.push(client);
  return { fake, client };
}

/** A transport factory that records whether connect() got as far as using it. */
function spyTransport(): { factory: ConnectionFactory; used: () => boolean } {
  const fake = new FakeServer({ capabilities: CAPS });
  let used = false;
  const inner = fake.transport();
  return {
    factory: (signal) => {
      used = true;
      return inner(signal);
    },
    used: () => used,
  };
}

/** Node reports TimeoutOverflowWarning on a later tick. */
const overflowWarnings = async (): Promise<string[]> => {
  await sleep(5);
  return warnings.map((w) => w.name).filter((n) => n === 'TimeoutOverflowWarning');
};

describe('RPC timeouts (MESSAGES-10)', () => {
  it('Infinity waits for a reply that takes longer than a clamped timer would', async () => {
    const { client } = await open(slow(50));
    await expect(client.session.rpc(x('get'), { timeout: Infinity })).resolves.toBeDefined();
    expect(await overflowWarnings()).toEqual([]);
  });

  it('a timeout above 2^31-1 ms is clamped, not fired at once, and raises no TimeoutOverflowWarning', async () => {
    const { client } = await open(slow(50));
    await expect(client.session.rpc(x('get'), { timeout: 3e9 })).resolves.toBeDefined();
    expect(await overflowWarnings()).toEqual([]);
  });

  it('timeouts.rpc: Infinity and 3e9 work as the session default', async () => {
    for (const rpc of [Infinity, 3e9]) {
      const { client } = await open(slow(30), { rpc });
      await expect(client.ops.get()).resolves.toBeDefined();
    }
    expect(await overflowWarnings()).toEqual([]);
  });

  it.each([
    [0, RangeError],
    [-1, RangeError],
    [Number.NaN, RangeError],
    [-Infinity, RangeError],
    ['1000', TypeError],
  ])('a per-call timeout of %s is refused with %O before anything is sent', async (timeout, type) => {
    const { client, fake } = await open();
    const before = fake.requests.length;
    await expect(client.session.rpc(x('get'), { timeout: timeout as number })).rejects.toBeInstanceOf(type);
    await expect(client.ops.get({ timeout: timeout as number })).rejects.toBeInstanceOf(type);
    expect(fake.requests.length).toBe(before);
    expect(client.session.state).toBe('open');
  });

  it('accepts a fractional timeout', async () => {
    const { client } = await open();
    await expect(client.session.rpc(x('get'), { timeout: 1500.5 })).resolves.toBeDefined();
  });
});

describe('session and connect timeouts (CLIENT-02)', () => {
  it('connects with every timeout set to Infinity, and with 3e9, without warnings', async () => {
    for (const t of [Infinity, 3e9]) {
      const { client } = await open(undefined, { connect: t, hello: t, rpc: t, close: t });
      await expect(client.ops.get()).resolves.toBeDefined();
      await client.close();
    }
    expect(await overflowWarnings()).toEqual([]);
  });

  it.each(['connect', 'hello', 'rpc', 'close'])('an invalid timeouts.%s rejects connect() before the transport is used', async (name) => {
    for (const [value, type] of [[0, RangeError], [-5, RangeError], [Number.NaN, RangeError], ['5', TypeError]] as const) {
      const { factory, used } = spyTransport();
      const err = await connect({ transport: factory, timeouts: { [name]: value } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(type);
      expect((err as Error).message).toContain(`timeouts.${name}`);
      expect(used()).toBe(false);
    }
  });

  it('openSession() refuses an invalid timeout before the hello is sent', async () => {
    const fake = new FakeServer({ capabilities: CAPS });
    const connection = await fake.transport()(new AbortController().signal);
    const writes: Uint8Array[] = [];
    const watched = watchConnection(connection, (bytes) => (writes.push(bytes), true));
    await expect(openSession(watched.connection, { timeouts: { hello: 0 } })).rejects.toBeInstanceOf(RangeError);
    expect(writes).toEqual([]);
    // The invalid options don't leak the connection.
    expect(watched.closed).toBe(true);
  });

  it("a profile's closeTimeout quirk must be at least 1 ms", () => {
    expect(() => compileProfile({ id: 'z', match: { anyModule: ['z'] }, quirks: { closeTimeout: 0 } })).toThrow(/closeTimeout/);
    expect(() => compileProfile({ id: 'z', match: { anyModule: ['z'] }, quirks: { closeTimeout: 1 } })).not.toThrow();
  });
});

describe('confirmed-commit expiry longer than a timer allows (OPS-21)', () => {
  it('stays pending with a 30-day confirm timeout', async () => {
    const { client } = await open();
    const { pending } = await withCandidate(client, () => undefined, { confirmed: { timeout: 30 * 86_400 } });
    await sleep(20);
    expect(pending.state).toBe('pending');
    expect(pending.expires.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
    await pending.cancel();
    expect(await overflowWarnings()).toEqual([]);
  });
});

describe('commit() confirmed-only parameters (OPS-07)', () => {
  it('refuses confirmTimeout or persist without confirmed: true, before sending', async () => {
    const { client, fake } = await open();
    const before = fake.requests.length;
    await expect(client.ops.commit({ confirmTimeout: 60 })).rejects.toBeInstanceOf(TypeError);
    await expect(client.ops.commit({ persist: 'p' })).rejects.toBeInstanceOf(TypeError);
    await expect(client.ops.commit({ confirmed: false, persist: 'p', confirmTimeout: 60 })).rejects.toThrow(/confirmed: true/);
    expect(fake.requests.length).toBe(before);
  });

  it('persistId alone builds the confirming commit', async () => {
    const { client, fake } = await open();
    await client.ops.commit({ persistId: 'p1' });
    expect(serializeXml(fake.requests.at(-1)!.elements[0]!)).toBe(
      '<commit xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><persist-id>p1</persist-id></commit>',
    );
  });
});
