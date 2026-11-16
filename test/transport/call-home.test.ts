/**
 * Call home (RFC 8071, TRANSPORT-12): the listener, against a real ssh2 SSH
 * server and a node:tls server that each dial out to it, with a FakeServer
 * behind them for NETCONF.
 */
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as tcp, createServer, type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';
import { utils } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  CertificateError,
  listenCallHome,
  TimeoutError,
  TransportError,
  type CallHomeCall,
  type CallHomeCaller,
  type CallHomeEvents,
  type CallHomeListener,
  type CallHomeOptions,
} from '../../src/index.js';
import { monitoring } from '../../src/operations/monitoring.js';
import { duplexConnection, joinConnections } from '../../src/index.js';
import { FakeServer } from '../../src/testing/index.js';
import { startSshServer, type TestSshServer } from '../support/ssh-server.js';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'tls');
const pem = (name: string) => readFileSync(join(FIX, name));
const sha256 = (der: Buffer) => `SHA256:${Buffer.from(new X509Certificate(der).fingerprint256.replace(/:/g, ''), 'hex').toString('base64').replace(/=+$/, '')}`;
const SERVER_CERT_FP = sha256(pem('server.pem'));

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function sshDevice(options: Parameters<typeof startSshServer>[0] = {}): Promise<TestSshServer> {
  const server = await startSshServer(options);
  cleanups.push(() => server.close());
  return server;
}

async function listen(
  options: Partial<CallHomeOptions> & Pick<CallHomeOptions, 'identify'>,
  withSsh = true,
): Promise<{ listener: CallHomeListener; events: { rejected: CallHomeEvents['rejected'][]; failed: CallHomeEvents['failed'][] } }> {
  const listener = await listenCallHome({ ...(withSsh ? { ssh: { host: '127.0.0.1', port: 0 } } : {}), ...options });
  cleanups.push(() => listener.close());
  const events = { rejected: [] as CallHomeEvents['rejected'][], failed: [] as CallHomeEvents['failed'][] };
  listener.on('rejected', (e) => events.rejected.push(e));
  listener.on('failed', (e) => events.failed.push(e));
  return { listener, events };
}

async function nextCall(listener: CallHomeListener, ms = 5000): Promise<CallHomeCall> {
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no call within ${ms} ms`)), ms).unref());
  const r = await Promise.race([listener.next(), timer]);
  if (r.done === true) throw new Error('listener ended');
  cleanups.push(() => r.value.client.close());
  return r.value;
}

/** A TLS "device" that calls home: connects out, then serves TLS (server side) and NETCONF over that connection. */
function tlsDevice(listenerPort: number, cert = 'server.pem', key = 'server.key'): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const raw = tcp(listenerPort, '127.0.0.1');
    raw.once('error', reject);
    raw.once('connect', () => {
      const t = new TLSSocket(raw, { isServer: true, cert: pem(cert), key: pem(key), requestCert: true, rejectUnauthorized: true, ca: [pem('ca.pem')] });
      t.on('error', () => undefined);
      t.on('secure', () => {
        const fake = new FakeServer();
        joinConnections(duplexConnection(t, { peer: { host: 'test-listener', port: 0 } }), fake.connection);
      });
      cleanups.push(() => t.destroy());
      resolve(raw);
    });
  });
}

const until = async (check: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('listenCallHome over SSH (TRANSPORT-12)', () => {
  it('identifies the device by its host key before any credentials are sent, then logs in with its own', async () => {
    const device = await sshDevice();
    const callers: { caller: CallHomeCaller; attemptsSoFar: number }[] = [];
    const { listener } = await listen({
      identify: (caller) => {
        callers.push({ caller, attemptsSoFar: device.authAttempts.length });
        return caller.fingerprint === device.fingerprint ? { name: 'router1', username: 'admin', password: 'secret' } : undefined;
      },
    });
    expect(listener.addresses.ssh?.address).toBe('127.0.0.1');
    expect(listener.addresses.ssh?.port).toBeGreaterThan(0);
    await device.callHome(listener.addresses.ssh!.port);
    const call = await nextCall(listener);
    expect(call.device.name).toBe('router1');
    expect(call.caller).toMatchObject({ transport: 'ssh', fingerprint: device.fingerprint, keyType: 'ssh-ed25519', remote: { address: '127.0.0.1' } });
    expect(callers).toHaveLength(1);
    expect(callers[0]!.attemptsSoFar).toBe(0);
    expect(device.authAttempts).toEqual(['none:admin', 'password:admin']);
    expect(call.client.transport.peer.identity).toBe(device.fingerprint);
    await expect(call.client.ops.get()).resolves.toBeDefined();
  });

  it("logs in with a device's private key, and applies its own connect options over the listener's", async () => {
    const clientKey = utils.generateKeyPairSync('ecdsa', { bits: 256 });
    const device = await sshDevice({ clientPublicKey: clientKey.public, fake: { capabilities: ['urn:ietf:params:netconf:base:1.0', 'urn:ietf:params:netconf:base:1.1', 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring?module=ietf-netconf-monitoring'] } });
    const { listener } = await listen({
      identify: () => ({ username: 'admin', privateKey: () => clientKey.private, connect: { extensions: [monitoring] } }),
      connect: { timeouts: { rpc: 5000 } },
    });
    await device.callHome(listener.addresses.ssh!.port);
    const call = await nextCall(listener);
    expect(device.authAttempts).toEqual(['none:admin', 'publickey:admin', 'publickey:admin']);
    expect((call.client.ops as unknown as Record<string, unknown>)['monitoring']).toBeDefined();
    expect((call.client.content as unknown as Record<string, unknown>)['monitoring']).toBeDefined();
  });

  it("answers a device's keyboard-interactive challenge with its own handler", async () => {
    const device = await sshDevice({
      methods: ['keyboard-interactive'],
      keyboard: [{ prompts: [{ prompt: 'Code: ', echo: false }], answers: ['987654'] }],
    });
    const { listener } = await listen({ identify: () => ({ username: 'admin', keyboardInteractive: () => ['987654'] }) });
    await device.callHome(listener.addresses.ssh!.port);
    await nextCall(listener);
    expect(device.authAttempts).toEqual(['none:admin', 'keyboard-interactive:admin']);
    expect(device.keyboardAnswers).toEqual([['987654']]);
  });

  it('refuses a device identify does not know, reporting it, with nothing sent', async () => {
    const device = await sshDevice();
    const { listener, events } = await listen({ identify: () => undefined });
    await device.callHome(listener.addresses.ssh!.port);
    await until(() => events.rejected.length > 0);
    expect(events.rejected[0]).toMatchObject({ transport: 'ssh', caller: { fingerprint: device.fingerprint } });
    expect(events.rejected[0]!.reason).toContain('unknown device');
    expect(device.authAttempts).toEqual([]);
    expect(events.failed).toEqual([]);
    expect(listener.pendingCalls).toBe(0);
  });

  it('refuses when identify throws or returns no username', async () => {
    const device = await sshDevice();
    let mode: 'throw' | 'nouser' = 'throw';
    const { listener, events } = await listen({
      identify: () => {
        if (mode === 'throw') throw new Error('database down');
        return { password: 'secret' };
      },
    });
    await device.callHome(listener.addresses.ssh!.port);
    await until(() => events.rejected.length === 1);
    expect(events.rejected[0]!.reason).toBe('identify threw: database down');
    mode = 'nouser';
    await device.callHome(listener.addresses.ssh!.port);
    await until(() => events.rejected.length === 2);
    expect(events.rejected[1]!.reason).toContain('no username');
    expect(device.authAttempts).toEqual([]);
  });

  it('reports a failed login as a failed event with an AuthenticationError', async () => {
    const device = await sshDevice();
    const { listener, events } = await listen({ identify: () => ({ username: 'admin', password: 'wrong' }) });
    await device.callHome(listener.addresses.ssh!.port);
    await until(() => events.failed.length > 0);
    expect(events.failed[0]!.error).toBeInstanceOf(AuthenticationError);
    expect(events.failed[0]!.error.message).not.toContain('wrong');
    expect(events.failed[0]!.caller?.fingerprint).toBe(device.fingerprint);
  });

  it("fails a device whose chosen private key can't be decrypted, offering no credentials", async () => {
    const clientKey = utils.generateKeyPairSync('ecdsa', { bits: 256, passphrase: 'right', cipher: 'aes256-ctr' });
    const device = await sshDevice({ clientPublicKey: clientKey.public });
    const { listener, events } = await listen({ identify: () => ({ username: 'admin', privateKey: clientKey.private, passphrase: 'wrong' }) });
    await device.callHome(listener.addresses.ssh!.port);
    await until(() => events.failed.length + events.rejected.length > 0);
    expect(events.rejected).toEqual([]);
    const error = events.failed[0]!.error as AuthenticationError;
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.reason).toBe('key');
    expect(error.message).toBe('The private key for call-home device admin@127.0.0.1:' + events.failed[0]!.caller!.remote.port + ' could not be decrypted (wrong passphrase?)');
    expect(device.authAttempts).toEqual([]);
  });

  it('wrapConnection sees each identified call and its connection before the hello; the client uses what it returns', async () => {
    const device = await sshDevice();
    const seen: { fingerprint: string; received: string[] }[] = [];
    const { listener } = await listen({
      identify: () => ({ username: 'admin', password: 'secret' }),
      wrapConnection: (connection, caller) => {
        const record = { fingerprint: caller.fingerprint, received: [] as string[] };
        seen.push(record);
        const decoder = new TextDecoder();
        return {
          ...connection,
          peer: connection.peer,
          receive: (r) =>
            connection.receive({
              ...r,
              data: (chunk) => {
                record.received.push(decoder.decode(chunk));
                r.data(chunk);
              },
            }),
          write: (bytes) => connection.write(bytes),
          end: () => connection.end(),
          destroy: () => connection.destroy(),
          close: () => connection.close(),
        };
      },
    });
    await device.callHome(listener.addresses.ssh!.port);
    const call = await nextCall(listener);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.fingerprint).toBe(device.fingerprint);
    // The server's hello came through the wrapped connection.
    expect(seen[0]!.received.join('')).toContain('<hello');
    await expect(call.client.ops.get()).resolves.toBeDefined();
  });

  it('a wrapConnection that throws fails the call (a failed event), closing it', async () => {
    const device = await sshDevice();
    const { listener, events } = await listen({
      identify: () => ({ username: 'admin', password: 'secret' }),
      wrapConnection: () => {
        throw new Error('no thanks');
      },
    });
    await device.callHome(listener.addresses.ssh!.port);
    await until(() => events.failed.length > 0);
    expect(events.failed[0]!.error).toBeInstanceOf(TransportError);
    expect((events.failed[0]!.error.cause as Error).message).toBe('no thanks');
    expect(events.failed[0]!.caller?.fingerprint).toBe(device.fingerprint);
    expect(listener.pendingCalls).toBe(0);
  });

  it('bounds calls being set up (maxPending) and how long each may take (handshakeTimeout)', async () => {
    const device = await sshDevice();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { listener, events } = await listen({
      maxPending: 1,
      handshakeTimeout: 300,
      identify: async () => {
        await gate;
        return { username: 'admin', password: 'secret' };
      },
    });
    const port = listener.addresses.ssh!.port;
    await device.callHome(port);
    await until(() => listener.pendingCalls === 1);
    await device.callHome(port);
    await until(() => events.rejected.length === 1);
    expect(events.rejected[0]!.reason).toContain('maxPending 1');
    await until(() => events.failed.length === 1, 3000);
    expect(events.failed[0]!.error).toBeInstanceOf(TimeoutError);
    release();
    expect(listener.pendingCalls).toBe(0);
  });

  it('bounds clients waiting to be taken (maxQueued), closing the extra one', async () => {
    const device = await sshDevice();
    const { listener, events } = await listen({ maxQueued: 1, identify: () => ({ username: 'admin', password: 'secret' }) });
    const port = listener.addresses.ssh!.port;
    await device.callHome(port);
    await until(() => device.connected() === 1);
    await device.callHome(port);
    await until(() => events.rejected.length === 1);
    expect(events.rejected[0]!.reason).toContain('maxQueued 1');
    await until(() => device.connected() === 1);
    await nextCall(listener);
  });

  it('close() aborts calls being set up, closes untaken clients, ends iteration and unbinds; break closes too', async () => {
    const device = await sshDevice();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const { listener, events } = await listen({
      identify: async () => {
        if (++calls === 2) await gate;
        return { username: 'admin', password: 'secret' };
      },
    });
    const port = listener.addresses.ssh!.port;
    await device.callHome(port); // queued, not taken
    await until(() => device.connected() === 1);
    await new Promise((r) => setTimeout(r, 100));
    await device.callHome(port); // stuck in identify
    await until(() => listener.pendingCalls === 1);
    const waiting = listener.next();
    // The queued client is handed to the first reader; take it so the close test is about the rest.
    const first = await waiting;
    expect(first.done).toBe(false);
    const reader = listener.next();
    await listener.close();
    release();
    await expect(reader).resolves.toEqual({ value: undefined, done: true });
    await until(() => events.rejected.some((e) => e.reason === 'the listener closed'));
    expect(listener.closed).toBe(true);
    await expect(new Promise((resolve, reject) => tcp(port, '127.0.0.1').on('connect', resolve).on('error', reject))).rejects.toThrow();
    // The client already taken is still open.
    await expect((first as IteratorYieldResult<CallHomeCall>).value.client.ops.get()).resolves.toBeDefined();
    await (first as IteratorYieldResult<CallHomeCall>).value.client.close();

    const { listener: second } = await listen({ identify: () => ({ username: 'admin', password: 'secret' }) });
    await device.callHome(second.addresses.ssh!.port);
    for await (const call of second) {
      await call.client.close();
      break;
    }
    expect(second.closed).toBe(true);
  });

  it('closes when its signal aborts', async () => {
    const ac = new AbortController();
    const { listener } = await listen({ signal: ac.signal, identify: () => undefined });
    ac.abort();
    await until(() => listener.closed);
    await expect(listener.next()).resolves.toEqual({ value: undefined, done: true });
  });
});

describe('listenCallHome over TLS (TRANSPORT-12)', () => {
  const tlsListen = (identify: CallHomeOptions['identify'], ca: Buffer | undefined = pem('ca.pem')) =>
    listen({ tls: { host: '127.0.0.1', port: 0, cert: pem('client.pem'), key: pem('client.key'), ...(ca !== undefined ? { ca } : {}) }, identify }, false);

  it('identifies the device by its certificate and yields a working client', async () => {
    const seen: CallHomeCaller[] = [];
    const { listener } = await tlsListen((caller) => {
      seen.push(caller);
      return caller.fingerprint === SERVER_CERT_FP ? { name: 'tls-router' } : undefined;
    });
    expect(listener.addresses.tls).toBeDefined();
    expect(listener.addresses.ssh).toBeUndefined();
    await tlsDevice(listener.addresses.tls!.port);
    const call = await nextCall(listener);
    expect(call.device.name).toBe('tls-router');
    expect(seen[0]).toMatchObject({ transport: 'tls', fingerprint: SERVER_CERT_FP });
    expect(seen[0]!.certificate?.subject).toContain('CN=');
    expect(call.client.transport.peer.identity).toBe(SERVER_CERT_FP);
    await expect(call.client.ops.get()).resolves.toBeDefined();
  });

  it('refuses a certificate identify does not know', async () => {
    const { listener, events } = await tlsListen(() => false);
    await tlsDevice(listener.addresses.tls!.port);
    await until(() => events.rejected.length > 0);
    expect(events.rejected[0]).toMatchObject({ transport: 'tls', caller: { fingerprint: SERVER_CERT_FP } });
    expect(events.rejected[0]!.reason).toContain('unknown device');
  });

  it('fails a device whose chain does not lead to ca, before identify is asked', async () => {
    let asked = false;
    const { listener, events } = await tlsListen(() => {
      asked = true;
      return {};
    }, pem('other-ca.pem'));
    await tlsDevice(listener.addresses.tls!.port);
    await until(() => events.failed.length > 0);
    expect(events.failed[0]!.error).toBeInstanceOf(CertificateError);
    expect(asked).toBe(false);
  });
});

/** Found in review: each failed before the fix. */
describe('listenCallHome regressions (TRANSPORT-12 review)', () => {
  it('SSH: a re-key keeps the session and does not ask identify again', async () => {
    const device = await sshDevice();
    let calls = 0;
    const { listener } = await listen({
      identify: () => {
        calls++;
        return calls === 1 ? { username: 'admin', password: 'secret' } : undefined;
      },
    });
    await device.callHome(listener.addresses.ssh!.port);
    const call = await nextCall(listener);
    device.clients()[0]!.rekey();
    await new Promise((r) => setTimeout(r, 300));
    await expect(call.client.ops.get()).resolves.toBeDefined();
    expect(calls).toBe(1);
  });

  it('TLS: a caller resetting the connection while an async identify runs is a failed event, not an uncaught error', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown): void => void uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    cleanups.push(() => process.off('uncaughtException', onUncaught));
    const { listener, events } = await listen(
      {
        tls: { host: '127.0.0.1', port: 0, cert: pem('client.pem'), key: pem('client.key'), ca: pem('ca.pem') },
        identify: async () => {
          await new Promise((r) => setTimeout(r, 300));
          return { name: 'x' };
        },
      },
      false,
    );
    const raw = await tlsDevice(listener.addresses.tls!.port);
    await new Promise((r) => setTimeout(r, 100));
    raw.resetAndDestroy();
    await until(() => events.failed.length > 0);
    await new Promise((r) => setTimeout(r, 400));
    expect(uncaught).toEqual([]);
    expect(events.failed[0]!.error).toBeInstanceOf(TransportError);
    expect(listener.pendingCalls).toBe(0);
  });

  it('TLS: a hung identify is ended by handshakeTimeout and frees its maxPending slot', async () => {
    const { listener, events } = await listen(
      { tls: { host: '127.0.0.1', port: 0, cert: pem('client.pem'), key: pem('client.key') }, handshakeTimeout: 200, maxPending: 1, identify: () => new Promise(() => undefined) },
      false,
    );
    await tlsDevice(listener.addresses.tls!.port);
    await until(() => events.failed.length > 0, 2000);
    expect(events.failed[0]!.error).toBeInstanceOf(TimeoutError);
    expect(listener.pendingCalls).toBe(0);
  });
});

describe('listenCallHome options', () => {
  it('refuses bad options before listening', async () => {
    await expect(listenCallHome({} as CallHomeOptions)).rejects.toThrow(/identify is required/);
    await expect(listenCallHome({ identify: () => undefined })).rejects.toThrow(/give ssh, tls or both/);
    await expect(listenCallHome({ tls: {} as never, identify: () => undefined })).rejects.toThrow(/tls needs cert and key/);
    await expect(listenCallHome({ ssh: {}, maxPending: 0, identify: () => undefined })).rejects.toThrow(/maxPending must be a positive integer/);
  });

  it('rejects with a TransportError when the port is taken', async () => {
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => busy.close(r)));
    const port = (busy.address() as AddressInfo).port;
    await expect(listenCallHome({ ssh: { host: '127.0.0.1', port }, identify: () => undefined })).rejects.toThrow(TransportError);
  });
});
