/**
 * The library-owned connection interface (TRANSPORT-13): connectionPair(),
 * duplexConnection() and joinConnections(), and framing on plain byte arrays.
 */
import { duplexPair } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { AuthenticationError, connect, connectionPair, duplexConnection, FrameDecoder, joinConnections, NetconfError, type ConnectionReceiver } from '../../src/index.js';
import { encodeChunked } from '../../src/transport/framing/index.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (chunks: readonly Uint8Array[]): string => chunks.map((c) => new TextDecoder().decode(c)).join('');
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

/** A receiver that records what arrives, in order. */
class Recorder implements ConnectionReceiver {
  readonly events: string[] = [];
  readonly chunks: Uint8Array[] = [];
  closeError: Error | undefined;

  data(chunk: Uint8Array): void {
    this.events.push('data');
    this.chunks.push(chunk);
  }

  end(): void {
    this.events.push('end');
  }

  close(err?: Error): void {
    this.events.push('close');
    this.closeError = err;
  }
}
const recorder = (): Recorder => new Recorder();

describe('connectionPair()', () => {
  it('delivers what one end writes to the other, later and in order, as copies', async () => {
    const [a, b] = connectionPair();
    const got = recorder();
    b.receive(got);
    const buf = bytes('one');
    a.write(buf);
    a.write(bytes('two'));
    buf.fill(0); // the writer may reuse its array
    expect(got.events).toEqual([]); // never synchronously
    await tick();
    expect(text(got.chunks)).toBe('onetwo');
  });

  it('holds bytes that arrive before receive(), and delivers nothing during the call itself', async () => {
    const [a, b] = connectionPair();
    a.write(bytes('early'));
    await tick();
    const got = recorder();
    b.receive(got);
    expect(got.events).toEqual([]);
    await tick();
    expect(text(got.chunks)).toBe('early');
  });

  it('keeps close last when a receiver ends its side while held events are replayed', async () => {
    const [a, b] = connectionPair();
    a.write(bytes('A'));
    a.write(bytes('B'));
    a.end();
    await tick();
    const got = recorder();
    const endOnFirst: ConnectionReceiver = {
      data: (chunk) => {
        got.data(chunk);
        b.end();
      },
      end: () => got.end(),
      close: (err) => got.close(err),
    };
    b.receive(endOnFirst);
    await tick();
    expect(got.events).toEqual(['data', 'data', 'end', 'close']);
    expect(text(got.chunks)).toBe('AB');
  });

  it('refuses a second receiver', () => {
    const [, b] = connectionPair();
    b.receive(recorder());
    // A programming error, so a TypeError, not a NetconfError.
    expect(() => b.receive(recorder())).toThrow(TypeError);
    expect(() => b.receive(recorder())).toThrow(/already has a receiver/);
  });

  it('delivers end after pending data, and keeps receiving after its own end (half-close)', async () => {
    const [a, b] = connectionPair();
    const atA = recorder();
    const atB = recorder();
    a.receive(atA);
    b.receive(atB);
    a.write(bytes('last'));
    a.end();
    a.write(bytes('ignored')); // nothing after end, and no throw
    await tick();
    expect(atB.events).toEqual(['data', 'end']);
    b.write(bytes('reply'));
    await tick();
    expect(text(atA.chunks)).toBe('reply');
    // Both directions ended: both close.
    b.end();
    await tick();
    expect(atA.events).toEqual(['data', 'end', 'close']);
    expect(atB.events).toEqual(['data', 'end', 'close']);
  });

  it('destroy() closes both ends without an error, and later writes send nothing', async () => {
    const [a, b] = connectionPair();
    const atA = recorder();
    const atB = recorder();
    a.receive(atA);
    b.receive(atB);
    a.destroy();
    a.write(bytes('x'));
    await tick();
    expect(atA.events).toEqual(['close']);
    expect(atB.events).toEqual(['close']);
    expect(atB.closeError).toBeUndefined();
  });

  it('close() is graceful, idempotent and never rejects', async () => {
    const [a, b] = connectionPair();
    const atB = recorder();
    b.receive(atB);
    a.write(bytes('bye'));
    await Promise.all([a.close(), a.close()]);
    await a.close();
    expect(atB.events).toEqual(['data', 'end', 'close']);
  });

  it('reports the peers it was given', () => {
    const [a, b] = connectionPair({ client: { host: 'server', port: 830 }, server: { host: 'client', port: 0 } });
    expect(a.peer).toEqual({ host: 'server', port: 830 });
    expect(b.peer.host).toBe('client');
  });
});

describe('duplexConnection()', () => {
  it('turns a Node duplex stream into a Connection: data, end, close', async () => {
    const [ours, theirs] = duplexPair();
    const c = duplexConnection(ours, { peer: { host: 'h', port: 1 } });
    const got = recorder();
    c.receive(got);
    theirs.write('hello');
    theirs.end();
    await tick();
    expect(text(got.chunks)).toBe('hello');
    expect(got.events.slice(-1)).toEqual(['end']);
    const back: Buffer[] = [];
    theirs.on('data', (b: Buffer) => back.push(b));
    c.write(bytes('reply'));
    c.end();
    c.write(bytes('ignored'));
    await tick();
    expect(Buffer.concat(back).toString()).toBe('reply');
  });

  it('reports a stream error as the close error at once, keeping its class', async () => {
    const [ours] = duplexPair();
    const c = duplexConnection(ours, { peer: { host: 'h', port: 1 } });
    const got = recorder();
    c.receive(got);
    const refused = new AuthenticationError('refused');
    ours.destroy(refused);
    await tick();
    expect(got.events).toEqual(['close']);
    expect(got.closeError).toBe(refused);
  });

  it('reports a stream that is already gone after receive() returns, not during it', async () => {
    const [ours] = duplexPair();
    ours.on('error', () => undefined);
    ours.destroy(new Error('dropped'));
    await tick();
    const c = duplexConnection(ours, { peer: { host: 'h', port: 1 } });
    const got = recorder();
    c.receive(got);
    expect(got.events).toEqual([]);
    await tick();
    expect(got.events).toEqual(['close']);
    expect(got.closeError?.message).toBe('dropped');
  });

  it('a session on a stream that is already gone fails cleanly', async () => {
    const [ours] = duplexPair();
    ours.destroy();
    await tick();
    const attempt = connect({ transport: () => Promise.resolve(duplexConnection(ours, { peer: { host: 'h', port: 1 } })) });
    await expect(attempt).rejects.toBeInstanceOf(NetconfError);
  });

  it('close() runs the given close, once', async () => {
    const [ours] = duplexPair();
    let calls = 0;
    const c = duplexConnection(ours, {
      peer: { host: 'h', port: 1 },
      close: () => {
        calls++;
        return Promise.resolve();
      },
    });
    await Promise.all([c.close(), c.close()]);
    expect(calls).toBe(1);
  });
});

describe('joinConnections()', () => {
  it('splices two connections: data and ends both ways, and a close drops the other side', async () => {
    const [client, left] = connectionPair();
    const [right, server] = connectionPair();
    joinConnections(left, right);
    const atClient = recorder();
    const atServer = recorder();
    client.receive(atClient);
    server.receive(atServer);
    client.write(bytes('up'));
    server.write(bytes('down'));
    await tick();
    expect(text(atServer.chunks)).toBe('up');
    expect(text(atClient.chunks)).toBe('down');
    server.destroy();
    await tick();
    expect(atClient.events.at(-1)).toBe('close');
  });
});

describe('framing on plain byte arrays', () => {
  it('encoders return Uint8Array, not Buffer, and the decoder takes Uint8Array', () => {
    const framed = encodeChunked('<a/>');
    expect(Object.getPrototypeOf(framed)).toBe(Uint8Array.prototype);
    const d = new FrameDecoder({ mode: 'chunked' });
    d.push(new Uint8Array(framed));
    expect(d.next()).toBe('<a/>');
  });
});

