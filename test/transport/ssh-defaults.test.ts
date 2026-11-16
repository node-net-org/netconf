/**
 * SSH algorithm defaults (TRANSPORT-04) and keyboard-interactive
 * authentication (TRANSPORT-01), against the in-process ssh2 server.
 */
import { utils } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  connect,
  DEFAULT_SSH_ALGORITHMS,
  fingerprintOf,
  ssh,
  TransportError,
  type KeyboardInteractiveChallenge,
  type Logger,
  type SshOptions,
} from '../../src/index.js';
import { startSshAgent } from '../support/ssh-agent.js';
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

function warnings(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: { warn: (m: string) => lines.push(m) }, lines };
}

const LEGACY = [
  'ssh-rsa',
  'ssh-dss',
  'diffie-hellman-group1-sha1',
  'diffie-hellman-group14-sha1',
  'diffie-hellman-group-exchange-sha1',
  '3des-cbc',
  'aes128-cbc',
  'aes192-cbc',
  'aes256-cbc',
  'hmac-sha1',
  'hmac-sha1-etm@openssh.com',
  'hmac-md5',
];

// One RSA host key for the whole file: generating it is slow.
const RSA = utils.generateKeyPairSync('rsa', { bits: 2048 });
const rsaFingerprint = (() => {
  const parsed = utils.parseKey(RSA.public);
  if (parsed instanceof Error) throw parsed;
  return fingerprintOf(parsed.getPublicSSH());
})();

describe('default SSH algorithms (TRANSPORT-04)', () => {
  it('AC1: are ssh2 defaults with no legacy algorithm, keeping rsa-sha2', () => {
    const all = Object.values(DEFAULT_SSH_ALGORITHMS).flat();
    for (const legacy of LEGACY) expect(all).not.toContain(legacy);
    expect(DEFAULT_SSH_ALGORITHMS.serverHostKey).toEqual(expect.arrayContaining(['rsa-sha2-512', 'rsa-sha2-256', 'ssh-ed25519']));
    expect(DEFAULT_SSH_ALGORITHMS.hmac).toEqual(expect.arrayContaining(['hmac-sha2-256-etm@openssh.com', 'hmac-sha2-256']));
    expect(DEFAULT_SSH_ALGORITHMS.kex.length).toBeGreaterThan(0);
    expect(DEFAULT_SSH_ALGORITHMS.cipher.length).toBeGreaterThan(0);
    expect(Object.isFrozen(DEFAULT_SSH_ALGORITHMS) && Object.isFrozen(DEFAULT_SSH_ALGORITHMS.hmac)).toBe(true);
  });

  it('AC1: a server that only has hmac-sha1 is refused by default', async () => {
    server = await startSshServer({ algorithms: { cipher: ['aes128-ctr'], hmac: ['hmac-sha1'] } });
    const w = warnings();
    await expect(connect({ transport: ssh({ ...base(server), logger: w.logger }) })).rejects.toBeInstanceOf(TransportError);
    expect(w.lines).toEqual([]);
    expect(server.authAttempts).toEqual([]);
  });

  it('AC1: an RSA host key still works by default, through rsa-sha2; ssh-rsa (SHA-1) alone is refused', async () => {
    server = await startSshServer({ hostKeys: [RSA.private] });
    await (await connect({ transport: ssh({ ...base(server), hostKey: rsaFingerprint }) })).close();
    await server.close();
    server = await startSshServer({ hostKeys: [RSA.private], algorithms: { serverHostKey: ['ssh-rsa'] } });
    await expect(connect({ transport: ssh({ ...base(server), hostKey: rsaFingerprint }) })).rejects.toBeInstanceOf(TransportError);
  });

  it('AC2+AC3: re-enabling a legacy algorithm connects, and warns on each attempt', async () => {
    server = await startSshServer({ algorithms: { cipher: ['aes128-ctr'], hmac: ['hmac-sha1'] } });
    const w = warnings();
    const transport = ssh({ ...base(server), algorithms: { hmac: { append: 'hmac-sha1', prepend: [], remove: [] } }, logger: w.logger });
    await (await connect({ transport })).close();
    await (await connect({ transport })).close();
    expect(w.lines).toEqual([
      `Legacy SSH algorithms enabled for 127.0.0.1:${server.port}: hmac-sha1`,
      `Legacy SSH algorithms enabled for 127.0.0.1:${server.port}: hmac-sha1`,
    ]);
  });

  it('AC2: a list replaces a category, and a legacy name in it warns', async () => {
    server = await startSshServer({ hostKeys: [RSA.private], algorithms: { serverHostKey: ['ssh-rsa'] } });
    const w = warnings();
    const options = { ...base(server), hostKey: rsaFingerprint, algorithms: { serverHostKey: ['ssh-rsa' as const] }, logger: w.logger };
    await (await connect({ transport: ssh(options) })).close();
    expect(w.lines).toEqual([`Legacy SSH algorithms enabled for 127.0.0.1:${server.port}: ssh-rsa`]);
  });

  it('AC2+AC3: removing an algorithm edits the default and never warns', async () => {
    server = await startSshServer({ algorithms: { cipher: ['aes128-ctr'], hmac: ['hmac-sha2-512'] } });
    const w = warnings();
    const remove = { remove: ['ssh-rsa' as const], append: [], prepend: [] };
    await (await connect({ transport: ssh({ ...base(server), algorithms: { serverHostKey: remove }, logger: w.logger }) })).close();
    expect(w.lines).toEqual([]);
    // Removing a default the server needs leaves nothing in common.
    const noSha512 = { hmac: { remove: 'hmac-sha2-512' as const, append: [], prepend: [] } };
    await expect(connect({ transport: ssh({ ...base(server), algorithms: noSha512 }) })).rejects.toBeInstanceOf(TransportError);
  });
});

describe('keyboard-interactive authentication (TRANSPORT-01)', () => {
  const hidden = (prompt: string) => ({ prompt, echo: false });

  it('a password answers hidden prompts, and methods the server does not allow are not tried', async () => {
    server = await startSshServer({
      methods: ['keyboard-interactive'],
      keyboard: [{ prompts: [hidden('Password: ')], answers: ['secret'] }],
    });
    await (await connect({ transport: ssh(base(server)) })).close();
    expect(server.authAttempts).toEqual(['none:admin', 'keyboard-interactive:admin']);
    expect(server.keyboardAnswers).toEqual([['secret']]);
  });

  it('a handler receives each challenge and answers it, sync or async, over several rounds', async () => {
    server = await startSshServer({
      methods: ['keyboard-interactive'],
      keyboard: [
        { prompts: [{ prompt: 'Username: ', echo: true }, hidden('Password: ')], answers: ['admin', 'secret'] },
        { prompts: [hidden('Token: ')], answers: ['123456'] },
      ],
    });
    const seen: KeyboardInteractiveChallenge[] = [];
    const keyboardInteractive = async (c: KeyboardInteractiveChallenge): Promise<string[]> => {
      seen.push(c);
      await new Promise((resolve) => setImmediate(resolve));
      return c.prompts.map((p) => (p.prompt === 'Username: ' ? 'admin' : p.prompt === 'Token: ' ? '123456' : 'secret'));
    };
    const { password: _pw, ...noPassword } = base(server);
    await (await connect({ transport: ssh({ ...noPassword, keyboardInteractive }) })).close();
    expect(seen.map((c) => c.prompts)).toEqual([
      [
        { prompt: 'Username: ', echo: true },
        { prompt: 'Password: ', echo: false },
      ],
      [{ prompt: 'Token: ', echo: false }],
    ]);
    expect([typeof seen[0]!.name, typeof seen[0]!.instructions]).toEqual(['string', 'string']);
  });

  it('a prompt that echoes is not answered with the password', async () => {
    server = await startSshServer({
      methods: ['keyboard-interactive'],
      keyboard: [{ prompts: [{ prompt: 'Username: ', echo: true }], answers: ['secret'] }],
    });
    const err = await connect({ transport: ssh(base(server)) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).message).toBe(`Keyboard-interactive authentication failed for admin@127.0.0.1:${server.port}`);
    expect(((err as Error).cause as Error).message).toMatch(/asked for more than a password \("Username: "\)/);
    // The password can't answer the prompt: said in `reason`, outside and on the cause.
    expect(err).toMatchObject({ reason: 'prompt' });
    expect((err as Error).cause).toBeInstanceOf(AuthenticationError);
    expect((err as Error).cause).toMatchObject({ reason: 'prompt' });
    expect(server.keyboardAnswers).toEqual([]);
    expect(JSON.stringify(err)).not.toContain('secret');
  });

  it('a password the server rejected is not sent again by keyboard-interactive', async () => {
    server = await startSshServer({
      methods: ['password', 'keyboard-interactive'],
      keyboard: [{ prompts: [hidden('Password: ')], answers: ['secret'] }],
    });
    const err = await connect({ transport: ssh({ ...base(server), password: 'wrong' }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(server.authAttempts).toEqual(['none:admin', 'password:admin']);
  });

  it('a handler is still tried after the password is rejected', async () => {
    server = await startSshServer({
      methods: ['password', 'keyboard-interactive'],
      keyboard: [{ prompts: [hidden('OTP: ')], answers: ['424242'] }],
    });
    const keyboardInteractive = (): string[] => ['424242'];
    await (await connect({ transport: ssh({ ...base(server), password: 'wrong', keyboardInteractive }) })).close();
    expect(server.authAttempts).toEqual(['none:admin', 'password:admin', 'keyboard-interactive:admin']);
  });

  it('a handler that throws fails with an AuthenticationError carrying the cause', async () => {
    server = await startSshServer({ methods: ['keyboard-interactive'], keyboard: [{ prompts: [hidden('PIN: ')], answers: ['1'] }] });
    const cause = new Error('no PIN available');
    const keyboardInteractive = (): never => {
      throw cause;
    };
    const err = await connect({ transport: ssh({ ...base(server), keyboardInteractive }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).cause).toBe(cause);
  });

  it('an agent is offered when the server lists publickey, as on a jump host', async () => {
    const agent = await startSshAgent();
    const target = await startSshServer();
    try {
      server = await startSshServer({ username: 'me', allowForwarding: true, clientPublicKey: agent.publicKey, methods: ['publickey'] });
      const jump = { host: '127.0.0.1', port: server.port, username: 'me', agent: agent.socketPath, hostKey: server.fingerprint };
      await (await connect({ transport: ssh({ ...base(target), jump }) })).close();
      expect(server.authAttempts).toEqual(['none:me', 'publickey:me', 'publickey:me']);
      expect(agent.signatures()).toBe(1);
      // A target that allows only password never sees the agent's key.
      const { password: _pw, ...noPassword } = base(target);
      const err = await connect({ transport: ssh({ ...noPassword, agent: agent.socketPath, username: 'nobody' }) }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AuthenticationError);
    } finally {
      await target.close();
      await agent.close();
    }
  });

  it('a method the server allows only after a partial success is still offered then', async () => {
    const agent = await startSshAgent();
    try {
      server = await startSshServer({ clientPublicKey: agent.publicKey, methods: ['publickey'], keyThenPassword: true });
      await (await connect({ transport: ssh({ ...base(server), agent: agent.socketPath }) })).close();
      expect(server.authAttempts).toEqual(['none:admin', 'publickey:admin', 'publickey:admin', 'password:admin']);
    } finally {
      await agent.close();
    }
  });

  it('works on a jump host too', async () => {
    const target = await startSshServer();
    try {
      server = await startSshServer({
        allowForwarding: true,
        methods: ['keyboard-interactive'],
        keyboard: [{ prompts: [hidden('Password: ')], answers: ['jump-secret'] }],
      });
      const jump = { host: '127.0.0.1', port: server.port, username: 'admin', password: 'jump-secret', hostKey: server.fingerprint };
      await (await connect({ transport: ssh({ ...base(target), jump }) })).close();
      expect(server.keyboardAnswers).toEqual([['jump-secret']]);
    } finally {
      await target.close();
    }
  });
});
