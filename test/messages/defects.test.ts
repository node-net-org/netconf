/**
 * Regression tests for the defects found in the old node-netconf fork.
 * Written before the session existed (red first), against the design's API.
 */
import { describe, expect, it } from 'vitest';
import {
  connect,
  FramingError,
  NETCONF_NS,
  SessionClosedError,
  TimeoutError,
  withClient,
  x,
  type SessionEvents,
} from '../../src/index.js';
import { FakeServer, type RpcHandlerResult } from '../../src/testing/index.js';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('fork defect (a): replies must never be missed, and nothing waits forever', () => {
  it('matches a reply the server sends immediately', async () => {
    const server = new FakeServer({ handler: () => ({ data: x('v', '1') }) });
    const s = await connect({ transport: server.transport() });
    const reply = await s.session.rpc(x('get'));
    expect(reply.data?.child('v')?.text()).toBe('1');
    await s.close();
  });

  it('keeps every message when several arrive back to back', async () => {
    // Two notifications and a reply arrive in quick succession; nothing may be lost.
    const server = new FakeServer();
    const s = await connect({ transport: server.transport() });
    const seen: string[] = [];
    s.session.on('notification', (n) => seen.push(n.event?.name ?? ''));
    server.notify(x('first', { xmlns: 'urn:e' }));
    server.notify(x('second', { xmlns: 'urn:e' }));
    await expect(s.session.rpc(x('get'))).resolves.toBeDefined();
    expect(seen).toEqual(['first', 'second']);
    await s.close();
  });

  it('times out an RPC that gets no reply, and the session stays usable', async () => {
    const server = new FakeServer({ handler: (_rpc, { operation }) => (operation?.name === 'hang' ? undefined : 'ok') });
    const s = await connect({ transport: server.transport() });
    const err = await s.session.rpc(x('hang'), { timeout: 30 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).phase).toBe('rpc');
    await expect(s.session.rpc(x('get'))).resolves.toBeDefined();
    await s.close();
  });

  it('drops a reply that arrives after its RPC timed out', async () => {
    const server = new FakeServer({
      handler: async (_rpc, { operation }) => {
        if (operation?.name === 'slow') await tick(60);
        return 'ok' as const;
      },
    });
    const s = await connect({ transport: server.transport() });
    await expect(s.session.rpc(x('slow'), { timeout: 20 })).rejects.toBeInstanceOf(TimeoutError);
    await tick(80); // the late reply arrives now
    expect(s.session.state).toBe('open');
    await expect(s.session.rpc(x('get'))).resolves.toBeDefined();
    await s.close();
  });

  it('times out a server that never sends its hello', async () => {
    const server = new FakeServer({ hello: false });
    const err = await connect({ transport: server.transport(), timeouts: { hello: 30 } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).phase).toBe('hello');
  });
});

describe('fork defect (b): transport failures must not crash the process', () => {
  it('rejects pending RPCs and emits closed when the connection drops', async () => {
    const server = new FakeServer({ handler: () => undefined });
    const s = await connect({ transport: server.transport() });
    const closed = new Promise<SessionEvents['closed']>((resolve) => s.session.on('closed', resolve));
    const pending = s.session.rpc(x('get'));
    await tick();
    server.destroy(new Error('link down'));
    await expect(pending).rejects.toBeInstanceOf(SessionClosedError);
    const event = await closed;
    expect(event.cause).toBeInstanceOf(SessionClosedError);
    expect(s.session.state).toBe('closed');
    await expect(s.session.rpc(x('get'))).rejects.toBeInstanceOf(SessionClosedError);
  });

  it('closes the session, without throwing, when the server breaks framing', async () => {
    const server = new FakeServer({ handler: () => undefined });
    const s = await connect({ transport: server.transport() });
    const pending = s.session.rpc(x('get'));
    await tick();
    server.sendRaw('this is not chunked framing');
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionClosedError);
    expect((err as SessionClosedError).cause).toBeInstanceOf(FramingError);
  });

  it('emits closed exactly once', async () => {
    const server = new FakeServer();
    const s = await connect({ transport: server.transport() });
    let count = 0;
    s.session.on('closed', () => count++);
    server.destroy(new Error('x'));
    await tick(10);
    await s.close();
    await tick(10);
    expect(count).toBe(1);
  });
});

describe('fork defect (c): sessions must not leak when an operation fails', () => {
  it('withClient sends close-session even when the callback throws', async () => {
    const server = new FakeServer({ handler: () => ({ errors: [{ type: 'application', tag: 'operation-failed' }] }) });
    const failure = withClient({ transport: server.transport() }, async (s) => {
      await s.session.rpc(x('get'));
    });
    await expect(failure).rejects.toThrow(/operation-failed/);
    expect(server.requests.map((r) => r.elements[0]?.name)).toEqual(['get', 'close-session']);
  });

  it('close() is idempotent and safe after the server has gone', async () => {
    const server = new FakeServer();
    const s = await connect({ transport: server.transport() });
    await Promise.all([s.close(), s.close()]);
    await s.close();
    expect(s.session.state).toBe('closed');
  });
});

describe('fork defect (e): replies are matched on the parsed message-id', () => {
  it('matches out-of-order replies to the right requests', async () => {
    const held = new Map<string, (r: RpcHandlerResult) => void>();
    const server = new FakeServer({
      handler: (_rpc, { messageId }) => new Promise((resolve) => held.set(messageId!, resolve)),
    });
    const s = await connect({ transport: server.transport() });
    const first = s.session.rpc(x('get', x('a')));
    const second = s.session.rpc(x('get', x('b')));
    await tick(10);
    const [id1, id2] = [...held.keys()];
    held.get(id2!)!({ data: x('answer', 'two') });
    held.get(id1!)!({ data: x('answer', 'one') });
    expect((await first).data?.child('answer')?.text()).toBe('one');
    expect((await second).data?.child('answer')?.text()).toBe('two');
    await s.close();
  });

  it('does not match a reply whose message-id merely contains the pending one', async () => {
    const held: ((r: RpcHandlerResult) => void)[] = [];
    const server = new FakeServer({ handler: () => new Promise((resolve) => held.push(resolve)) });
    const s = await connect({ transport: server.transport() });
    const warnings: unknown[] = [];
    s.session.on('warning', (w) => warnings.push(w));
    let settled = false;
    const pending = s.session.rpc(x('get')).finally(() => (settled = true));
    await tick(10);
    const id = server.requests[0]!.attr('message-id')!;
    server.send(x('rpc-reply', { xmlns: NETCONF_NS, 'message-id': `${id}0` }, x('ok')));
    await tick(10);
    expect(settled).toBe(false);
    expect(warnings).toHaveLength(1);
    held[0]!('ok');
    await expect(pending).resolves.toBeDefined();
    await s.close();
  });
});
