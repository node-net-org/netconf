/**
 * NETCONF over TLS (RFC 7589, TRANSPORT-10), against an in-process TLS server
 * whose connections are bridged to the FakeServer.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createNetServer, connect as netConnect, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import { createServer, type Server, type TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthenticationError,
  CertificateError,
  connect,
  DEFAULT_TLS_CIPHERS,
  tls,
  TransportError,
  type TlsOptions,
} from '../../src/index.js';
import { duplexConnection, joinConnections } from '../../src/index.js';
import { FakeServer } from '../../src/testing/index.js';

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/tls/${name}`, import.meta.url), 'utf8');
const pem = {
  ca: fixture('ca.pem'),
  server: fixture('server.pem'),
  serverKey: fixture('server.key'),
  client: fixture('client.pem'),
  clientKey: fixture('client.key'),
  otherCa: fixture('other-ca.pem'),
  otherServer: fixture('other-server.pem'),
  otherServerKey: fixture('other-server.key'),
  otherClient: fixture('other-client.pem'),
  otherClientKey: fixture('other-client.key'),
};

function sha256(certPem: string): Buffer {
  const der = Buffer.from(certPem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  return createHash('sha256').update(der).digest();
}
const serverPin = `SHA256:${sha256(pem.server).toString('base64').replace(/=+$/, '')}`;
const otherServerPin = sha256(pem.otherServer).toString('hex').toUpperCase().match(/../g)!.join(':');

interface TestServer {
  readonly port: number;
  readonly fakes: FakeServer[];
  readonly sockets: TLSSocket[];
  /** `protocol cipher` of each accepted connection. */
  readonly negotiated: string[];
}

const servers: (Server | NetServer)[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A TLS server that requires a client certificate signed by `ca`, and speaks NETCONF through a FakeServer. */
async function startServer(
  opts: { other?: boolean; maxVersion?: 'TLSv1.2' | 'TLSv1.3'; onSecure?: 'fake' | 'close'; ciphers?: string } = {},
): Promise<TestServer> {
  const fakes: FakeServer[] = [];
  const sockets: TLSSocket[] = [];
  const negotiated: string[] = [];
  const server = createServer(
    {
      cert: opts.other ? pem.otherServer : pem.server,
      key: opts.other ? pem.otherServerKey : pem.serverKey,
      ca: [pem.ca],
      requestCert: true,
      rejectUnauthorized: true,
      ...(opts.maxVersion ? { maxVersion: opts.maxVersion } : {}),
      ...(opts.ciphers ? { ciphers: opts.ciphers, dhparam: 'auto' } : {}),
    },
    (socket) => {
      sockets.push(socket);
      negotiated.push(`${socket.getProtocol()} ${socket.getCipher().name}`);
      socket.on('error', () => undefined);
      if (opts.onSecure === 'close') {
        // Consume the socket, so the client's close reaches it and server.close()
        // can finish; from Node 24.22 and 26 an unread socket never sees it.
        socket.resume();
        socket.end();
        return;
      }
      const fake = new FakeServer();
      fakes.push(fake);
      joinConnections(duplexConnection(socket, { peer: { host: 'test-client', port: 0 } }), fake.connection);
    },
  );
  server.on('tlsClientError', () => undefined);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, fakes, sockets, negotiated };
}

const client = (port: number, extra: Partial<TlsOptions> = {}): TlsOptions =>
  ({ host: 'localhost', port, cert: pem.client, key: pem.clientKey, ca: pem.ca, ...extra });

const open = (options: TlsOptions) => tls(options)(new AbortController().signal);

describe('tls() (TRANSPORT-10)', () => {
  it.each(['TLSv1.3', 'TLSv1.2'] as const)('runs a NETCONF session over %s with a trusted chain and name', async (maxVersion) => {
    const srv = await startServer({ maxVersion });
    const c = await connect({ transport: tls(client(srv.port)) });
    expect(c.transport.peer).toEqual({ host: 'localhost', port: srv.port, identity: serverPin });
    await c.ops.getConfig();
    expect(srv.fakes[0]!.requests.at(-1)!.elements[0]!.name).toBe('get-config');
    await c.close();
  });

  it('checks the IP address SAN when connecting by IP, and serverName when given', async () => {
    const srv = await startServer();
    await (await open(client(srv.port, { host: '127.0.0.1' }))).close();
    await (await open(client(srv.port, { host: '127.0.0.1', serverName: 'localhost' }))).close();
    const wrong = open(client(srv.port, { serverName: 'router2' }));
    await expect(wrong).rejects.toBeInstanceOf(CertificateError);
    await expect(wrong).rejects.toThrow(/router2/);
  });

  it('rejects a server certificate from an untrusted CA', async () => {
    const srv = await startServer({ other: true });
    const p = open(client(srv.port));
    await expect(p).rejects.toBeInstanceOf(CertificateError);
    await expect(p).rejects.toThrow(/localhost:\d+ was not accepted/);
  });

  it('a fingerprint pin alone identifies the server; a mismatch is refused', async () => {
    const srv = await startServer({ other: true });
    const { ca: _ca, ...noCa } = client(srv.port);
    await (await open({ ...noCa, fingerprint: otherServerPin })).close();
    await (await open({ ...noCa, fingerprint: [serverPin, otherServerPin.toLowerCase().replace(/:/g, '')] })).close();
    const bad = open({ ...noCa, fingerprint: serverPin });
    await expect(bad).rejects.toBeInstanceOf(CertificateError);
    await expect(bad).rejects.toThrow(/doesn't match the pinned fingerprint \(it is SHA256:/);
  });

  it('with ca and a pin, all checks must pass', async () => {
    const srv = await startServer();
    await (await open(client(srv.port, { fingerprint: serverPin }))).close();
    await expect(open(client(srv.port, { fingerprint: otherServerPin }))).rejects.toBeInstanceOf(CertificateError);
    const other = await startServer({ other: true });
    await expect(open(client(other.port, { fingerprint: otherServerPin }))).rejects.toBeInstanceOf(CertificateError);
  });

  it("'insecure-accept-any' connects to anything and warns every time", async () => {
    const srv = await startServer({ other: true });
    const warn = vi.fn();
    const { ca: _ca, ...noCa } = client(srv.port);
    const factory = tls({ ...noCa, insecure: 'insecure-accept-any', logger: { warn } });
    await (await factory(new AbortController().signal)).close();
    await (await factory(new AbortController().signal)).close();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(`TLS server verification is disabled for localhost:${srv.port}`);
  });

  it('refuses unsafe or incomplete configuration at once', () => {
    const base = { host: 'h', cert: pem.client, key: pem.clientKey };
    expect(() => tls(base)).toThrow(CertificateError);
    expect(() => tls(base)).toThrow(/ca .*fingerprint.*insecure-accept-any/);
    expect(() => tls({ ...base, ca: pem.ca, insecure: 'insecure-accept-any' })).toThrow(TypeError);
    expect(() => tls({ ...base, fingerprint: serverPin, insecure: 'insecure-accept-any' })).toThrow(TypeError);
    expect(() => tls({ ...base, insecure: 'yes' as 'insecure-accept-any' })).toThrow(TypeError);
    expect(() => tls({ ...base, fingerprint: 'SHA1:abc' })).toThrow(/neither SHA256/);
    expect(() => tls({ ...base, fingerprint: [] })).toThrow(/empty list/);
    expect(() => tls({ host: 'h', key: pem.clientKey, ca: pem.ca } as unknown as TlsOptions)).toThrow(/cert and key are required/);
  });

  it('a client certificate the server refuses after the TLS 1.3 handshake is an AuthenticationError', async () => {
    const srv = await startServer({ maxVersion: 'TLSv1.3' });
    const p = connect({ transport: tls(client(srv.port, { cert: pem.otherClient, key: pem.otherClientKey })) });
    await expect(p).rejects.toBeInstanceOf(AuthenticationError);
    await expect(p).rejects.toThrow(/refused the client certificate \(alert: [a-z-]+\)|closed the connection before sending its hello/);
  });

  it('a TLS 1.2 server that resets instead of sending an alert gives a TransportError with a hint', async () => {
    const srv = await startServer({ maxVersion: 'TLSv1.2' });
    const p = connect({ transport: tls(client(srv.port, { cert: pem.otherClient, key: pem.otherClientKey })) });
    await expect(p).rejects.toBeInstanceOf(TransportError);
    await expect(p).rejects.toThrow(/rejects the client certificate without an alert/);
  });

  it('a close after the handshake but before the hello is reported as a likely cert-to-name failure', async () => {
    const srv = await startServer({ onSecure: 'close' });
    const p = connect({ transport: tls(client(srv.port)) });
    await expect(p).rejects.toBeInstanceOf(AuthenticationError);
    await expect(p).rejects.toThrow(/before sending its hello.*cert-to-name/);
  });

  it('closing sends close_notify, which the server sees as a clean end', async () => {
    const srv = await startServer();
    const c = await connect({ transport: tls(client(srv.port)) });
    const ended = new Promise((r) => srv.sockets[0]!.once('end', r));
    await c.close();
    await ended;
  });

  it('runs over a given socket, and reads secrets lazily', async () => {
    const srv = await startServer();
    const sock = netConnect(srv.port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    const cert = vi.fn(() => Promise.resolve(pem.client));
    const factory = tls(client(srv.port, { sock, cert }));
    expect(cert).not.toHaveBeenCalled();
    const c = await connect({ transport: factory });
    expect(cert).toHaveBeenCalledOnce();
    await c.ops.getConfig();
    await c.close();
  });

  it('gives up when the signal aborts mid-handshake', async () => {
    const held = new Set<Socket>();
    const silent = createNetServer((s) => held.add(s.resume())); // accepts TCP, never speaks TLS
    servers.push(silent);
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const ac = new AbortController();
    const p = tls(client((silent.address() as AddressInfo).port))(ac.signal);
    setTimeout(() => ac.abort(new Error('stop')), 50);
    await expect(p).rejects.toThrow('stop');
    // The client gave up and closed its socket, so the server sees the connection end.
    await vi.waitFor(() => expect([...held].every((s) => s.readableEnded || s.destroyed)).toBe(true));
    held.forEach((s) => s.destroy());
  });

  it('a refused connection is a TransportError', async () => {
    const srv = await startServer();
    await new Promise((r) => servers.pop()!.close(r));
    const p = open(client(srv.port));
    await expect(p).rejects.toBeInstanceOf(TransportError);
    await expect(p).rejects.not.toBeInstanceOf(CertificateError);
  });
});

describe('TLS cipher policy (TRANSPORT-10, RFC 9325)', () => {
  /** A full session, so the hello is read before closing. */
  const session = async (options: TlsOptions): Promise<void> => (await connect({ transport: tls(options) })).close();

  it('offers TLS 1.3 suites, then only ECDHE with AES-GCM or ChaCha20-Poly1305 for TLS 1.2', () => {
    const suites = DEFAULT_TLS_CIPHERS.split(':');
    expect(suites.slice(0, 3)).toEqual(['TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256', 'TLS_AES_128_GCM_SHA256']);
    for (const suite of suites.slice(3)) expect(suite).toMatch(/^ECDHE-(ECDSA|RSA)-(AES(128|256)-GCM-SHA(256|384)|CHACHA20-POLY1305)$/);
  });

  it.each(['AES128-GCM-SHA256', 'AES256-SHA256', 'DHE-RSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-SHA256'])(
    'refuses a TLS 1.2 server that offers only %s',
    async (suite) => {
      const srv = await startServer({ maxVersion: 'TLSv1.2', ciphers: suite });
      await expect(open(client(srv.port))).rejects.toBeInstanceOf(TransportError);
      // The same server is reachable when the caller widens the list on purpose.
      await session(client(srv.port, { ciphers: `${DEFAULT_TLS_CIPHERS}:${suite}` }));
    },
  );

  it('negotiates ECDHE with AEAD over TLS 1.2, and TLS 1.3 is unaffected', async () => {
    const tls12 = await startServer({ maxVersion: 'TLSv1.2' });
    await session(client(tls12.port));
    expect(tls12.negotiated[0]).toMatch(/^TLSv1\.2 ECDHE-RSA-(AES\d+-GCM|CHACHA20)/);
    const tls13 = await startServer();
    await session(client(tls13.port));
    expect(tls13.negotiated[0]).toMatch(/^TLSv1\.3 TLS_/);
  });
});
