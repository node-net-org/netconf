/**
 * Exercises the fake server with a hand-rolled client built only from the
 * framing and XML layers. The real session (phase 2) will replace this client.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildClientHello } from '../../src/messages/hello.js';
import { encodeMessage, FrameDecoder, type FramingMode } from '../../src/transport/framing/index.js';
import { BASE_1_0, connect, NETCONF_NS, NOTIFICATION_NS, parseXml, serializeXml, x, type Connection, type XmlElement } from '../../src/index.js';
import { FakeServer } from '../../src/testing/index.js';

class MiniClient {
  private readonly decoder = new FrameDecoder();
  private mode: FramingMode = 'eom';
  private readonly queue: XmlElement[] = [];
  private waiter: ((el: XmlElement) => void) | undefined;
  /** Resolves when the server ends its side. */
  readonly ended: Promise<void>;

  constructor(private readonly connection: Connection) {
    let ended!: () => void;
    this.ended = new Promise((resolve) => (ended = resolve));
    connection.receive({
      data: (chunk) => {
        this.decoder.push(chunk);
        for (let m = this.decoder.next(); m !== undefined; m = this.decoder.next()) {
          const el = parseXml(m);
          if (this.waiter) {
            const w = this.waiter;
            this.waiter = undefined;
            w(el);
          } else this.queue.push(el);
        }
      },
      end: () => ended(),
      close: () => ended(),
    });
  }

  receive(): Promise<XmlElement> {
    const el = this.queue.shift();
    return el ? Promise.resolve(el) : new Promise((resolve) => (this.waiter = resolve));
  }

  send(el: XmlElement): void {
    this.connection.write(encodeMessage(serializeXml(el), this.mode));
  }

  useChunked(): void {
    this.mode = 'chunked';
    this.decoder.setMode('chunked');
  }
}

async function handshake(server: FakeServer, capabilities?: string[]): Promise<MiniClient> {
  const client = new MiniClient(server.connection);
  const hello = await client.receive();
  expect(hello.name).toBe('hello');
  client.send(buildClientHello(capabilities));
  await server.clientHello;
  if (server.version === '1.1') client.useChunked();
  return client;
}

describe('FakeServer', () => {
  it('negotiates base 1.1 and answers in chunked framing', async () => {
    const server = new FakeServer({ sessionId: 7 });
    const client = await handshake(server);
    expect(server.version).toBe('1.1');

    client.send(x('rpc', { xmlns: NETCONF_NS, 'message-id': '1', extra: 'kept' }, x('get')));
    const reply = await client.receive();
    expect(reply.name).toBe('rpc-reply');
    expect(reply.attr('message-id')).toBe('1');
    expect(reply.attr('extra')).toBe('kept');
    expect(reply.child('ok')).toBeDefined();
    expect(server.requests).toHaveLength(1);
    expect(server.problems).toEqual([]);
  });

  it('falls back to base 1.0 with EOM framing', async () => {
    const server = new FakeServer();
    const client = await handshake(server, [BASE_1_0]);
    expect(server.version).toBe('1.0');
    client.send(x('rpc', { xmlns: NETCONF_NS, 'message-id': '2' }, x('get')));
    expect((await client.receive()).attr('message-id')).toBe('2');
  });

  it('returns data, errors, and nothing at all as scripted', async () => {
    const server = new FakeServer({
      handler: (_rpc, { operation }) => {
        switch (operation?.name) {
          case 'get':
            return { data: x('top', { xmlns: 'urn:t' }, 'v') };
          case 'lock':
            return { errors: [{ type: 'protocol', tag: 'lock-denied', info: [x('session-id', '9')] }] };
          default:
            return undefined;
        }
      },
    });
    const client = await handshake(server);

    client.send(x('rpc', { xmlns: NETCONF_NS, 'message-id': '1' }, x('get')));
    const data = await client.receive();
    expect(data.path('data/top')!.text()).toBe('v');
    expect(data.path('data/top')!.ns).toBe('urn:t');

    client.send(x('rpc', { xmlns: NETCONF_NS, 'message-id': '2' }, x('lock')));
    const err = (await client.receive()).child('rpc-error')!;
    expect(err.child('error-tag')!.text()).toBe('lock-denied');
    expect(err.child('error-severity')!.text()).toBe('error');
    expect(err.path('error-info/session-id')!.text()).toBe('9');

    client.send(x('rpc', { xmlns: NETCONF_NS, 'message-id': '3' }, x('unanswered')));
    client.send(x('rpc', { xmlns: NETCONF_NS, 'message-id': '4' }, x('get')));
    expect((await client.receive()).attr('message-id')).toBe('4');
  });

  it('turns a throwing handler into operation-failed', async () => {
    const server = new FakeServer({
      handler: () => {
        throw new Error('boom');
      },
    });
    const client = await handshake(server);
    client.send(x('rpc', { xmlns: NETCONF_NS, 'message-id': '1' }, x('get')));
    const err = (await client.receive()).child('rpc-error')!;
    expect(err.child('error-tag')!.text()).toBe('operation-failed');
    expect(err.child('error-message')!.text()).toBe('boom');
  });

  it('answers close-session and then ends the connection', async () => {
    const server = new FakeServer();
    const client = await handshake(server);
    client.send(x('rpc', { xmlns: NETCONF_NS, 'message-id': '1' }, x('close-session')));
    expect((await client.receive()).child('ok')).toBeDefined();
    await client.ended;
  });

  it('sends notifications in the current framing', async () => {
    const server = new FakeServer();
    const client = await handshake(server);
    server.notify(x('event', { xmlns: 'urn:e' }, 'up'), '2026-11-06T00:00:00Z');
    const n = await client.receive();
    expect(n.name).toBe('notification');
    expect(n.child('eventTime')!.text()).toBe('2026-11-06T00:00:00Z');
    expect(n.child('event', 'urn:e')!.text()).toBe('up');
  });

  // RFC 6242 §4.1: the framing after the hellos depends on both of them, so a
  // server can't frame anything until the client's hello has arrived. On a
  // slow link the client can have the server's hello, and switch to chunked,
  // while its own hello is still on the way.
  it('holds messages sent before the client hello, then sends them in the agreed framing', async () => {
    const server = new FakeServer();
    const slow: Connection = {
      peer: server.connection.peer,
      receive: (receiver) => server.connection.receive(receiver),
      write: (bytes) => void setTimeout(() => server.connection.write(bytes), 30),
      end: () => server.connection.end(),
      destroy: () => server.connection.destroy(),
      close: () => server.connection.close(),
    };
    const client = await connect({ transport: () => Promise.resolve(slow) });
    expect(client.session.baseVersion).toBe('1.1');
    expect(server.version).toBeUndefined(); // the client's hello is still on the way

    const notifications: string[] = [];
    client.session.on('notification', (n) => notifications.push(n.event!.name));
    let closedBy: Error | undefined;
    client.session.on('closed', (e) => (closedBy = e.cause));
    server.notify(x('first', { xmlns: 'urn:e' }));
    server.send(x('notification', { xmlns: NOTIFICATION_NS }, x('eventTime', '2026-11-15T00:00:00Z'), x('second', { xmlns: 'urn:e' })));
    await vi.waitFor(() => expect(closedBy ?? notifications).toEqual(['first', 'second']));
    expect(server.version).toBe('1.1');
    expect(client.session.state).toBe('open');
    await client.close();
  });

  it('records a client that sends garbage as a problem', async () => {
    const server = new FakeServer();
    const client = new MiniClient(server.connection);
    await client.receive();
    server.connection.write(new TextEncoder().encode('not xml]]>]]>'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(server.problems).toHaveLength(1);
  });
});
