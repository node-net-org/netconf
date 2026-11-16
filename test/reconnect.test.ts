/**
 * reconnecting() (CLIENT-07): reconnect with backoff
 * after transport loss, stop on failures retrying can't fix, never re-send.
 * Each connect attempt gets a fresh FakeServer, or a chosen failure; delays
 * are a few milliseconds with jitter off, so they can be checked exactly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthenticationError,
  CertificateError,
  HelloError,
  HostKeyError,
  NETCONF_NS,
  reconnecting,
  SessionClosedError,
  TimeoutError,
  TransportError,
  x,
  type ConnectionFactory,
  type NetconfClient,
  type RetryInfo,
} from '../src/index.js';
import { reconnecting as coreReconnecting } from '../src/core.js';
import { FakeServer, type RpcHandler } from '../src/testing/index.js';

/** A transport that serves each attempt from the next scripted outcome: a new FakeServer, or an error. */
function script(...outcomes: (Error | 'server' | 'hang')[]) {
  const servers: FakeServer[] = [];
  let attempts = 0;
  const transport: ConnectionFactory = (signal) => {
    const outcome = outcomes[Math.min(attempts++, outcomes.length - 1)]!;
    if (outcome instanceof Error) return Promise.reject(outcome);
    if (outcome === 'hang') {
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
    const server = new FakeServer({ handler: handler, sessionId: servers.length + 1 });
    servers.push(server);
    return Promise.resolve(server.connection);
  };
  return { transport, servers, attempts: () => attempts };
}

/** Never answers <get> (to leave a request in flight); ok to anything else. */
const handler: RpcHandler = (_rpc, ctx) => (ctx.operation?.name === 'get' ? undefined : 'ok');

const FAST = { initialDelay: 10, maxDelay: 1000, factor: 2, jitter: false };
const TRANSPORT_DOWN = (): TransportError => new TransportError('connect ECONNREFUSED 192.0.2.1:830');

let open: { return(): Promise<unknown> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.map((r) => r.return()));
  open = [];
});

function start(transport: ConnectionFactory, extra: { retry?: object; signal?: AbortSignal } = {}) {
  const retries: RetryInfo[] = [];
  const r = reconnecting({ transport, retry: { ...FAST, ...extra.retry }, onRetry: (i) => retries.push(i), ...(extra.signal ? { signal: extra.signal } : {}) });
  open.push(r);
  return { r, retries };
}

const value = async (p: Promise<IteratorResult<NetconfClient>>): Promise<NetconfClient> => {
  const result = await p;
  if (result.done === true) throw new Error('iteration ended');
  return result.value;
};

describe('CLIENT-07: reconnecting()', () => {
  it('yields a client per session: after the connection drops, it backs off and connects again', async () => {
    const s = script('server', 'server');
    const { r, retries } = start(s.transport);
    const first = await value(r.next());
    expect(first.session.sessionId).toBe(1);
    const next = r.next();
    s.servers[0]!.destroy();
    const second = await value(next);
    expect(second.session.sessionId).toBe(2);
    expect(first.session.state).toBe('closed');
    expect(retries.map((i) => [i.attempt, i.delay])).toEqual([[1, 10]]);
    expect(retries[0]!.error).toBeInstanceOf(Error);
    expect(r.current).toBe(second);
  });

  it('waits for the previous session to end before connecting again', async () => {
    const s = script('server', 'server');
    const { r } = start(s.transport);
    await value(r.next());
    let settled = false;
    const next = r.next().then((v) => ((settled = true), v));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);
    expect(s.attempts()).toBe(1);
    s.servers[0]!.end();
    await value(next);
    expect(s.attempts()).toBe(2);
  });

  it('retries transient failures with exponential backoff, capped at maxDelay', async () => {
    const s = script(TRANSPORT_DOWN(), new TimeoutError('connect', 5), TRANSPORT_DOWN(), TRANSPORT_DOWN(), 'server');
    const { r, retries } = start(s.transport, { retry: { maxDelay: 50 } });
    const client = await value(r.next());
    expect(client.session.sessionId).toBe(1);
    expect(retries.map((i) => [i.attempt, i.delay])).toEqual([
      [1, 10],
      [2, 20],
      [3, 40],
      [4, 50],
    ]);
    expect(retries[1]!.error).toBeInstanceOf(TimeoutError);
  });

  it('gives up after maxAttempts consecutive failures, rejecting with the last error', async () => {
    const last = TRANSPORT_DOWN();
    const s = script(TRANSPORT_DOWN(), TRANSPORT_DOWN(), last);
    const { r, retries } = start(s.transport, { retry: { maxAttempts: 3 } });
    await expect(r.next()).rejects.toBe(last);
    expect(s.attempts()).toBe(3);
    expect(retries).toHaveLength(2);
  });

  it.each([
    ['AuthenticationError', new AuthenticationError('Authentication failed', { reason: 'refused' })],
    ['HostKeyError', new HostKeyError('Host key mismatch')],
    ['CertificateError', new CertificateError('Certificate not trusted')],
    ['HelloError', new HelloError('No common base version')],
  ])('stops at once on %s, without retrying', async (_name, error) => {
    const s = script(error, 'server');
    const { r, retries } = start(s.transport);
    await expect(r.next()).rejects.toBe(error);
    expect(s.attempts()).toBe(1);
    expect(retries).toEqual([]);
  });

  it('stops at once on an error that is not a NetconfError (a TypeError from bad connect options)', async () => {
    const s = script('server');
    const r = reconnecting({ transport: s.transport, timeouts: { connect: 'soon' as never }, retry: FAST });
    open.push(r);
    await expect(r.next()).rejects.toThrow(TypeError);
    expect(s.attempts()).toBe(0);
  });

  it('resets the backoff once a session has stayed open for maxDelay', async () => {
    const s = script('server', 'server', 'server', 'server');
    const { r, retries } = start(s.transport, { retry: { maxDelay: 60 } });
    await value(r.next());
    // Dropped at once: the backoff grows.
    let next = r.next();
    s.servers[0]!.destroy();
    await value(next);
    next = r.next();
    s.servers[1]!.destroy();
    await value(next);
    expect(retries.map((i) => i.attempt)).toEqual([1, 2]);
    // Open longer than maxDelay: it starts again.
    await new Promise((resolve) => setTimeout(resolve, 80));
    next = r.next();
    s.servers[2]!.destroy();
    await value(next);
    expect(retries.map((i) => [i.attempt, i.delay])).toEqual([
      [1, 10],
      [2, 20],
      [1, 10],
    ]);
  });

  it('applies jitter: a random 50–100% of the delay', async () => {
    const s = script(TRANSPORT_DOWN(), TRANSPORT_DOWN(), 'server');
    const random = vi.spyOn(Math, 'random');
    random.mockReturnValueOnce(0).mockReturnValueOnce(0.999);
    const { r, retries } = start(s.transport, { retry: { jitter: true, initialDelay: 100, maxDelay: 100 } });
    await value(r.next());
    expect(retries.map((i) => i.delay)).toEqual([50, 100]);
  });

  it('stops quietly when the signal aborts during a backoff wait, and closes the current client', async () => {
    const controller = new AbortController();
    const s = script('server', TRANSPORT_DOWN());
    const { r } = start(s.transport, { signal: controller.signal, retry: { initialDelay: 10_000, maxDelay: 10_000 } });
    const client = await value(r.next());
    const next = r.next();
    s.servers[0]!.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(await next).toEqual({ done: true, value: undefined });
    expect(client.session.state).toBe('closed');
    expect(s.attempts()).toBe(1);
    expect(await r.next()).toEqual({ done: true, value: undefined });
  });

  it('stops quietly when the signal aborts during a connect attempt', async () => {
    const controller = new AbortController();
    const s = script('hang');
    const { r } = start(s.transport, { signal: controller.signal });
    const next = r.next();
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(await next).toEqual({ done: true, value: undefined });
  });

  it('closes the current client when the loop is left, and connects no more', async () => {
    const s = script('server', 'server');
    const r = reconnecting({ transport: s.transport, retry: FAST });
    let seen: NetconfClient | undefined;
    for await (const client of r) {
      seen = client;
      break;
    }
    expect(seen!.session.state).toBe('closed');
    expect(await r.next()).toEqual({ done: true, value: undefined });
    expect(s.attempts()).toBe(1);
  });

  it('closes the current client on await using', async () => {
    const s = script('server');
    let client: NetconfClient;
    {
      await using r = reconnecting({ transport: s.transport, retry: FAST });
      client = await value(r.next());
    }
    expect(client.session.state).toBe('closed');
  });

  it('never re-sends a request: one in flight when the link drops rejects with SessionClosedError', async () => {
    const s = script('server', 'server');
    const { r } = start(s.transport);
    const first = await value(r.next());
    const pending = first.session.rpc(x('get', { xmlns: NETCONF_NS }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const next = r.next();
    s.servers[0]!.destroy();
    await expect(pending).rejects.toBeInstanceOf(SessionClosedError);
    await value(next);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.servers[1]!.requests.map((q) => q.elements[0]!.name)).toEqual([]);
  });

  it('refuses invalid retry options at once', () => {
    const { transport } = script('server');
    expect(() => reconnecting({ transport, retry: { initialDelay: -1 } })).toThrow(RangeError);
    expect(() => reconnecting({ transport, retry: { factor: 0.5 } })).toThrow(RangeError);
    expect(() => reconnecting({ transport, retry: { maxAttempts: 0 } })).toThrow(RangeError);
    expect(() => reconnecting({ transport, retry: { maxDelay: '1' as never } })).toThrow(TypeError);
    expect(() => reconnecting({ transport, retry: { jitter: 1 as never } })).toThrow(TypeError);
  });

  it('is available from @node-net/netconf/core too', async () => {
    const s = script('server');
    const r = coreReconnecting({ transport: s.transport, retry: FAST });
    open.push(r);
    expect((await value(r.next())).session.sessionId).toBe(1);
  });
});
