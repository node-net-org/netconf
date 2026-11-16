import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { utils } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  connect,
  HostKeyError,
  knownHosts,
  ssh,
  TimeoutError,
  TransportError,
  withClient,
  x,
  type SshOptions,
} from '../../src/index.js';
import { startSshServer, type TestSshServer } from '../support/ssh-server.js';

let server: TestSshServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const base = (s: TestSshServer): SshOptions => ({
  host: '127.0.0.1',
  port: s.port,
  username: 'admin',
  password: 'secret',
  hostKey: s.fingerprint,
});

describe('ssh transport', () => {
  it('runs a NETCONF session over SSH with password auth and a pinned fingerprint', async () => {
    server = await startSshServer({ fake: { sessionId: 5, handler: () => ({ data: x('hostname', 'r1') }) } });
    const result = await withClient({ transport: ssh(base(server)) }, async (s) => {
      expect(s.session.sessionId).toBe(5);
      expect(s.transport.peer.identity).toBe(server!.fingerprint);
      return (await s.ops.get()).child('hostname')?.text();
    });
    expect(result).toBe('r1');
    expect(server.last()!.requests.map((r) => r.elements[0]?.name)).toEqual(['get', 'close-session']);
  });

  it('accepts the host key as a public key line or a list', async () => {
    server = await startSshServer();
    for (const hostKey of [server.publicKeyLine, ['SHA256:' + 'A'.repeat(43), server.fingerprint]]) {
      const s = await connect({ transport: ssh({ ...base(server), hostKey }) });
      await s.close();
    }
  });

  it('rejects a wrong host key before sending any credentials', async () => {
    server = await startSshServer();
    const err = await connect({ transport: ssh({ ...base(server), hostKey: 'SHA256:' + 'A'.repeat(43) }) }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HostKeyError);
    expect((err as Error).message).toContain(server.fingerprint);
    expect(server.authAttempts).toEqual([]);
  });

  it('reports a verifier that throws as a HostKeyError', async () => {
    server = await startSshServer();
    const hostKey = (): boolean => {
      throw new Error('cannot read known_hosts');
    };
    await expect(connect({ transport: ssh({ ...base(server), hostKey }) })).rejects.toBeInstanceOf(HostKeyError);
  });

  it('requires a host-key policy', () => {
    expect(() => ssh({ host: 'h', username: 'u' } as SshOptions)).toThrow(HostKeyError);
    expect(() => ssh({ host: 'h', username: 'u', hostKey: 'not-a-key' })).toThrow(TypeError);
  });

  it("allows 'insecure-accept-any', with a warning", async () => {
    server = await startSshServer();
    const warnings: string[] = [];
    const s = await connect({
      transport: ssh({ ...base(server), hostKey: 'insecure-accept-any', logger: { warn: (m) => warnings.push(m) } }),
    });
    await s.close();
    expect(warnings[0]).toMatch(/verification is disabled/);
  });

  it('fails with AuthenticationError on a bad password', async () => {
    server = await startSshServer();
    await expect(connect({ transport: ssh({ ...base(server), password: 'wrong' }) })).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it('reports a server that closes the connection during authentication as an AuthenticationError', async () => {
    // The server allows one failed attempt; the wrong password uses it up, so the key is never tried.
    server = await startSshServer({ maxAuthFailures: 1 });
    const other = utils.generateKeyPairSync('ecdsa', { bits: 256 });
    const err = await connect({ transport: ssh({ ...base(server), password: 'wrong', privateKey: other.private }) }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).message).toBe(
      `SSH server at 127.0.0.1:${server.port} closed the connection during authentication (it may limit failed attempts)`,
    );
    expect(server.authAttempts).toContain('password:admin');
  });

  it('still reports a wrong password as an AuthenticationError on a server that limits attempts', async () => {
    server = await startSshServer({ maxAuthFailures: 1 });
    const err = await connect({ transport: ssh({ ...base(server), password: 'wrong' }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
  });

  it('reports a connection closed before the SSH handshake as a TransportError', async () => {
    const closer = createServer((sock) => sock.end('SSH-2.0-closer\r\n', () => sock.destroy()));
    await new Promise<void>((r) => closer.listen(0, '127.0.0.1', r));
    const port = (closer.address() as AddressInfo).port;
    try {
      const err = await connect({
        transport: ssh({ host: '127.0.0.1', port, username: 'u', password: 'p', hostKey: 'insecure-accept-any' }),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      // Closed during setup, or a write error first: which one depends on timing.
      expect((err as Error).message).toMatch(new RegExp(`^SSH connection to 127\\.0\\.0\\.1:${port} (closed during setup|failed)`));
    } finally {
      await new Promise<void>((r) => closer.close(() => r()));
    }
  });

  it('authenticates with a private key supplied lazily', async () => {
    const clientKey = utils.generateKeyPairSync('ed25519');
    server = await startSshServer({ clientPublicKey: clientKey.public });
    let revealed = false;
    const { password: _password, ...noPassword } = base(server);
    const s = await connect({
      transport: ssh({
        ...noPassword,
        privateKey: () => {
          revealed = true;
          return clientKey.private;
        },
      }),
    });
    expect(revealed).toBe(true);
    expect(server.authAttempts.some((a) => a.startsWith('publickey'))).toBe(true);
    await s.close();
  });

  it('fails with TransportError when the netconf subsystem is refused', async () => {
    server = await startSshServer({ subsystem: 'something-else' });
    const err = await connect({ transport: ssh(base(server)) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as Error).message).toMatch(/Could not start NETCONF/);
  });

  it('fails with TransportError when nothing is listening', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const err = await connect({
      transport: ssh({ host: '127.0.0.1', port, username: 'u', password: 'p', hostKey: 'insecure-accept-any' }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
  });

  it('times out a server that accepts TCP but never speaks SSH, and closes the socket', async () => {
    const sockets: Socket[] = [];
    let socketClosed = false;
    const silent = createServer((sock) => {
      sockets.push(sock);
      sock.on('close', () => (socketClosed = true));
      sock.resume();
    });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const port = (silent.address() as AddressInfo).port;
    try {
      const err = await connect({
        transport: ssh({ host: '127.0.0.1', port, username: 'u', password: 'p', hostKey: 'insecure-accept-any' }),
        timeouts: { connect: 100 },
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TimeoutError);
      await new Promise((r) => setTimeout(r, 50));
      expect(socketClosed).toBe(true);
    } finally {
      sockets.forEach((s) => s.destroy());
      await new Promise<void>((r) => silent.close(() => r()));
    }
  });

  it('closes the session when the SSH connection drops', async () => {
    server = await startSshServer({ fake: { handler: () => undefined } });
    const s = await connect({ transport: ssh(base(server)) });
    const pending = s.session.rpc(x('get'));
    await new Promise((r) => setTimeout(r, 20));
    server.last()!.destroy();
    await expect(pending).rejects.toThrow();
    expect(s.session.state).toBe('closed');
  });
});

describe('private keys that cannot be used', () => {
  // ssh2's ed25519 generation is flaky (design note: ~1 in 270 unparseable); ecdsa is not.
  const encrypted = utils.generateKeyPairSync('ecdsa', { bits: 256, passphrase: 'right', cipher: 'aes256-ctr' });
  const keyed = (s: TestSshServer, key: Partial<SshOptions>): SshOptions => {
    const { password: _password, ...noPassword } = base(s);
    return { ...noPassword, ...key };
  };
  const failure = async (options: SshOptions): Promise<AuthenticationError> => {
    const err = await connect({ transport: ssh(options) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as AuthenticationError).reason).toBe('key');
    return err as AuthenticationError;
  };

  it('logs in with the right passphrase', async () => {
    server = await startSshServer({ clientPublicKey: encrypted.public });
    const s = await connect({ transport: ssh(keyed(server, { privateKey: encrypted.private, passphrase: 'right' })) });
    await s.close();
  });

  it('fails a wrong passphrase before connecting, without echoing it', async () => {
    server = await startSshServer({ clientPublicKey: encrypted.public });
    const err = await failure(keyed(server, { privateKey: encrypted.private, passphrase: 'wrong' }));
    expect(err.message).toBe(`The private key for admin@127.0.0.1:${server.port} could not be decrypted (wrong passphrase?)`);
    expect(server.connections()).toBe(0);
    expect(server.authAttempts).toEqual([]);
  });

  it('fails a missing passphrase before connecting', async () => {
    server = await startSshServer({ clientPublicKey: encrypted.public });
    const err = await failure(keyed(server, { privateKey: encrypted.private }));
    expect(err.message).toBe(`The private key for admin@127.0.0.1:${server.port} is encrypted, but no passphrase was given`);
    expect(server.connections()).toBe(0);
  });

  it('fails a key that cannot be parsed before connecting, with the reason', async () => {
    server = await startSshServer();
    const err = await failure({ ...base(server), privateKey: 'not a key at all' });
    expect(err.message).toMatch(new RegExp(`^The private key for admin@127\\.0\\.0\\.1:${server.port} could not be read: .+`));
    expect(err.message).not.toContain('not a key at all');
    expect(server.connections()).toBe(0);
  });

  it('checks a lazily supplied key and passphrase', async () => {
    server = await startSshServer({ clientPublicKey: encrypted.public });
    await failure(keyed(server, { privateKey: () => encrypted.private, passphrase: () => Promise.resolve('wrong') }));
    expect(server.connections()).toBe(0);
  });

  it('a refused login is reason refused', async () => {
    server = await startSshServer();
    const err = await connect({ transport: ssh({ ...base(server), password: 'wrong' }) }).catch((e: unknown) => e);
    expect((err as AuthenticationError).reason).toBe('refused');
  });

  it('fails a bad key on a jump host before connecting to any hop', async () => {
    server = await startSshServer();
    const jump = await startSshServer({ username: 'hop', allowForwarding: true, clientPublicKey: encrypted.public });
    try {
      const err = await failure({
        ...base(server),
        jump: [{ host: '127.0.0.1', port: jump.port, username: 'hop', hostKey: jump.fingerprint, privateKey: encrypted.private, passphrase: 'wrong' }],
      });
      expect(err.message).toBe(`The private key for jump host hop@127.0.0.1:${jump.port} could not be decrypted (wrong passphrase?)`);
      expect(jump.connections()).toBe(0);
      expect(server.connections()).toBe(0);
    } finally {
      await jump.close();
    }
  });

  it("fails a bad key on the target before connecting to its jump host", async () => {
    server = await startSshServer({ clientPublicKey: encrypted.public });
    const jump = await startSshServer({ username: 'hop', password: 'hop-secret', allowForwarding: true });
    try {
      await failure({
        ...keyed(server, { privateKey: encrypted.private }),
        jump: { host: '127.0.0.1', port: jump.port, username: 'hop', password: 'hop-secret', hostKey: jump.fingerprint },
      });
      expect(jump.connections()).toBe(0);
    } finally {
      await jump.close();
    }
  });
});

describe('known_hosts verification', () => {
  it('matches plain, hashed, bracketed-port and wildcard entries, and honours @revoked', async () => {
    server = await startSshServer();
    const name = `[127.0.0.1]:${server.port}`;
    const salt = randomBytes(20);
    const hashed = `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(name).digest('base64')}`;

    const cases: [string, boolean][] = [
      [`${name} ${server.publicKeyLine}`, true],
      [`${hashed} ${server.publicKeyLine}`, true],
      [`[127.0.0.*]:${server.port} ${server.publicKeyLine}`, true],
      [`127.0.0.1 ${server.publicKeyLine}`, false], // port 22 entry doesn't cover another port
      [`${name},!${name} ${server.publicKeyLine}`, false], // negated
      [`# comment\n\n${name} ssh-ed25519 ${'A'.repeat(68)}`, false], // wrong key
      [`${name} ${server.publicKeyLine}\n@revoked * ${server.publicKeyLine}`, false],
    ];
    for (const [content, ok] of cases) {
      const attempt = connect({ transport: ssh({ ...base(server), hostKey: knownHosts(content) }) });
      if (ok) await (await attempt).close();
      else await expect(attempt, content).rejects.toBeInstanceOf(HostKeyError);
    }
  });
});

describe('host-key negotiation', () => {
  it('negotiates the key type known_hosts holds when the server has several host keys', async () => {
    const ecdsa = utils.generateKeyPairSync('ecdsa', { bits: 256 });
    server = await startSshServer({ extraHostKeys: [ecdsa.private] });
    const ecdsaLine = ecdsa.public.trim().split(/\s+/).slice(0, 2).join(' ');
    const entry = `[127.0.0.1]:${server.port} ${ecdsaLine}`;
    // ssh2 would pick ed25519 first; the ecdsa entry must steer it.
    for (const hostKey of [knownHosts(entry), ecdsaLine]) {
      const s = await connect({ transport: ssh({ ...base(server), hostKey }) });
      expect(s.transport.peer.identity).not.toBe(server.fingerprint);
      await s.close();
    }
    // A fingerprint gives no key type, so the default (ed25519) is negotiated as before.
    const s = await connect({ transport: ssh(base(server)) });
    expect(s.transport.peer.identity).toBe(server.fingerprint);
    await s.close();
  });

  it('leaves an explicit serverHostKey list alone', async () => {
    const ecdsa = utils.generateKeyPairSync('ecdsa', { bits: 256 });
    server = await startSshServer({ extraHostKeys: [ecdsa.private] });
    const ecdsaLine = ecdsa.public.trim().split(/\s+/).slice(0, 2).join(' ');
    const attempt = connect({
      transport: ssh({ ...base(server), hostKey: ecdsaLine, algorithms: { serverHostKey: ['ssh-ed25519'] } }),
    });
    await expect(attempt).rejects.toBeInstanceOf(HostKeyError);
  });
});

describe('jump hosts', () => {
  const extra: TestSshServer[] = [];
  afterEach(async () => {
    await Promise.all(extra.splice(0).map((s) => s.close()));
  });
  const jumpServer = async (): Promise<TestSshServer> => {
    const s = await startSshServer({ username: 'hop', password: 'hop-secret', allowForwarding: true });
    extra.push(s);
    return s;
  };
  const hopTo = (s: TestSshServer) => ({ host: '127.0.0.1', port: s.port, username: 'hop', password: 'hop-secret', hostKey: s.fingerprint });

  it('runs a session through a jump host, with separate credentials, and closes both on close', async () => {
    server = await startSshServer({ fake: { handler: () => ({ data: x('hostname', 'r1') }) } });
    const jump = await jumpServer();
    const s = await connect({ transport: ssh({ ...base(server), jump: hopTo(jump) }) });
    expect((await s.ops.get()).child('hostname')?.text()).toBe('r1');
    expect(jump.forwards).toEqual([`127.0.0.1:${server.port}`]);
    expect(jump.authAttempts.at(-1)).toBe('password:hop');
    expect(server.authAttempts.at(-1)).toBe('password:admin');
    expect(s.transport.peer).toMatchObject({ host: '127.0.0.1', port: server.port, identity: server.fingerprint });
    await s.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.connected()).toBe(0);
    expect(jump.connected()).toBe(0);
  });

  it('chains several jump hosts in order', async () => {
    server = await startSshServer();
    const [first, second] = [await jumpServer(), await jumpServer()];
    const s = await connect({ transport: ssh({ ...base(server), jump: [hopTo(first), hopTo(second)] }) });
    expect(first.forwards).toEqual([`127.0.0.1:${second.port}`]);
    expect(second.forwards).toEqual([`127.0.0.1:${server.port}`]);
    await s.close();
  });

  it('verifies the jump host key before anything else is sent', async () => {
    server = await startSshServer();
    const jump = await jumpServer();
    const err = await connect({
      transport: ssh({ ...base(server), jump: { ...hopTo(jump), hostKey: 'SHA256:' + 'B'.repeat(43) } }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostKeyError);
    expect((err as Error).message).toContain(`jump host 127.0.0.1:${jump.port}`);
    expect(jump.authAttempts).toEqual([]);
    expect(jump.forwards).toEqual([]);
  });

  it('verifies the target host key end to end, through the tunnel', async () => {
    server = await startSshServer();
    const jump = await jumpServer();
    const err = await connect({ transport: ssh({ ...base(server), hostKey: 'SHA256:' + 'A'.repeat(43), jump: hopTo(jump) }) }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HostKeyError);
    expect(server.authAttempts).toEqual([]);
    await new Promise((r) => setTimeout(r, 50));
    expect(jump.connected()).toBe(0);
  });

  it('names the jump host when its authentication fails', async () => {
    server = await startSshServer();
    const jump = await jumpServer();
    const err = await connect({ transport: ssh({ ...base(server), jump: { ...hopTo(jump), password: 'wrong' } }) }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).message).toBe(`SSH authentication failed for hop@jump host 127.0.0.1:${jump.port}`);
  });

  it('names the jump host when it closes the connection during authentication', async () => {
    server = await startSshServer();
    const jump = await startSshServer({ username: 'hop', password: 'hop-secret', allowForwarding: true, maxAuthFailures: 1 });
    extra.push(jump);
    const other = utils.generateKeyPairSync('ecdsa', { bits: 256 });
    const err = await connect({
      transport: ssh({ ...base(server), jump: { ...hopTo(jump), password: 'wrong', privateKey: other.private } }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).message).toBe(
      `SSH server at jump host 127.0.0.1:${jump.port} closed the connection during authentication (it may limit failed attempts)`,
    );
    expect(server.authAttempts).toEqual([]);
  });

  it('reports a target the jump host cannot reach', async () => {
    const jump = await jumpServer();
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const err = await connect({
      transport: ssh({ host: '127.0.0.1', port, username: 'u', password: 'p', hostKey: 'insecure-accept-any', jump: hopTo(jump) }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as Error).message).toMatch(`jump host 127.0.0.1:${jump.port} could not open a connection to 127.0.0.1:${port}`);
  });

  it('times out a target that never speaks SSH, and closes the jump connection too', async () => {
    const jump = await jumpServer();
    const sockets: Socket[] = [];
    const silent = createServer((sock) => {
      sockets.push(sock);
      sock.resume();
    });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const port = (silent.address() as AddressInfo).port;
    try {
      const err = await connect({
        transport: ssh({ host: '127.0.0.1', port, username: 'u', password: 'p', hostKey: 'insecure-accept-any', jump: hopTo(jump) }),
        timeouts: { connect: 300 },
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TimeoutError);
      await new Promise((r) => setTimeout(r, 50));
      expect(jump.connected()).toBe(0);
    } finally {
      sockets.forEach((s) => s.destroy());
      await new Promise<void>((r) => silent.close(() => r()));
    }
  });

  it('closes the session when the jump connection drops', async () => {
    server = await startSshServer({ fake: { handler: () => undefined } });
    const jump = await jumpServer();
    const s = await connect({ transport: ssh({ ...base(server), jump: hopTo(jump) }) });
    const pending = s.session.rpc(x('get'));
    await new Promise((r) => setTimeout(r, 20));
    for (const c of jump.clients()) c.end();
    await expect(pending).rejects.toThrow();
    expect(s.session.state).toBe('closed');
  });

  it('requires a host-key policy per hop and rejects jump with sock', () => {
    const { hostKey: _hostKey, ...noKey } = { host: 'j', username: 'u', hostKey: 'insecure-accept-any' };
    expect(() => ssh({ host: 'h', username: 'u', hostKey: 'insecure-accept-any', jump: noKey as SshOptions })).toThrow(
      /hostKey is required for jump host j:22/,
    );
    expect(() =>
      ssh({ host: 'h', username: 'u', hostKey: 'insecure-accept-any', jump: { ...noKey, hostKey: 'insecure-accept-any' }, sock: new PassThrough() }),
    ).toThrow(/either jump or sock/);
  });
});
