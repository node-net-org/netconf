/**
 * A real SSH server (ssh2) on 127.0.0.1 whose `netconf` subsystem is bridged
 * to a FakeServer. Lets tests run the whole stack over genuine SSH.
 */
import { createHash } from 'node:crypto';
import { connect as tcpConnect, type AddressInfo, type Socket } from 'node:net';
import { Server, utils, type Algorithms, type AuthContext, type AuthenticationType, type Connection } from 'ssh2';
import { duplexConnection, joinConnections } from '../../src/index.js';
import { FakeServer, type FakeServerOptions } from '../../src/testing/index.js';

export interface TestSshServer {
  readonly port: number;
  /** OpenSSH fingerprint of the host key. */
  readonly fingerprint: string;
  /** `ssh-ed25519 AAAA...` line for the host key. */
  readonly publicKeyLine: string;
  /** Every authentication attempt, as `method:username`. */
  readonly authAttempts: string[];
  /** Answers received to each keyboard-interactive round. */
  readonly keyboardAnswers: string[][];
  /** The FakeServer behind the most recent netconf subsystem. */
  readonly last: () => FakeServer | undefined;
  /** Every direct-tcpip (jump host) request, as `host:port`. */
  readonly forwards: string[];
  /** SSH clients currently connected. */
  readonly connected: () => number;
  /** SSH clients that have connected, in all. */
  readonly connections: () => number;
  /** The live server-side connections, to drop them from a test. */
  readonly clients: () => Connection[];
  /** Call home (RFC 8071): connect out to 127.0.0.1:`port` and serve SSH over that connection. */
  callHome(port: number): Promise<Socket>;
  close(): Promise<void>;
}

export interface TestSshServerOptions {
  readonly username?: string;
  readonly password?: string;
  /** Accepted client public key (OpenSSH format). */
  readonly clientPublicKey?: string;
  readonly fake?: FakeServerOptions;
  /** Name of the subsystem that starts NETCONF. Default 'netconf'. */
  readonly subsystem?: string;
  /** Extra host keys (private, OpenSSH format) offered after the default ed25519 one. */
  readonly extraHostKeys?: readonly string[];
  /** Host keys (private) to use instead of the default ed25519 one and any extra ones. */
  readonly hostKeys?: readonly string[];
  /** Act as a jump host: allow direct-tcpip forwarding to 127.0.0.1. */
  readonly allowForwarding?: boolean;
  /**
   * End the connection once this many authentication attempts (other than
   * `none`) have failed, as servers with MaxAuthTries or a lockout do.
   */
  readonly maxAuthFailures?: number;
  /** The server's own algorithm lists (ssh2 defaults otherwise). */
  readonly algorithms?: Algorithms;
  /** Methods the server says can continue after a failure. Default password and publickey. */
  readonly methods?: AuthenticationType[];
  /**
   * Require two factors, as OpenSSH's `AuthenticationMethods publickey,password`
   * does: a good key is a partial success, after which only password can continue.
   */
  readonly keyThenPassword?: boolean;
  /**
   * Keyboard-interactive: the challenges to send, one per round, and the
   * answers that pass each. Each round's prompts and the answers received
   * are recorded in `challenges`.
   */
  readonly keyboard?: readonly { readonly prompts: readonly { prompt: string; echo: boolean }[]; readonly answers: readonly string[] }[];
}

/**
 * An ed25519 key pair ssh2 can parse. Its generator makes one it can't parse
 * about 1 time in 270, which would fail a whole test file at random.
 */
export function ed25519KeyPair(): { private: string; public: string } {
  for (;;) {
    const pair = utils.generateKeyPairSync('ed25519');
    if (!(utils.parseKey(pair.private) instanceof Error)) return pair;
  }
}

export const HOST_KEY = ed25519KeyPair();

export async function startSshServer(options: TestSshServerOptions = {}): Promise<TestSshServer> {
  const username = options.username ?? 'admin';
  const password = options.password ?? 'secret';
  const authAttempts: string[] = [];
  const keyboardAnswers: string[][] = [];
  const methods = options.methods ?? ['password', 'publickey'];
  let last: FakeServer | undefined;
  const forwards: string[] = [];
  const live = new Set<Connection>();
  let connections = 0;
  const allowedKey = options.clientPublicKey ? utils.parseKey(options.clientPublicKey) : undefined;
  if (allowedKey instanceof Error) throw allowedKey;

  const hostKeys = options.hostKeys !== undefined ? [...options.hostKeys] : [HOST_KEY.private, ...(options.extraHostKeys ?? [])];
  const server = new Server({ hostKeys, ...(options.algorithms !== undefined ? { algorithms: options.algorithms } : {}) }, (client) => {
    live.add(client);
    connections++;
    client.on('close', () => live.delete(client));
    client.on('error', () => undefined);
    let failures = 0;
    let keyDone = false;
    client.on('authentication', (ctx: AuthContext) => {
      authAttempts.push(`${ctx.method}:${ctx.username}`);
      const reject = (methods?: AuthenticationType[]): void => {
        ctx.reject(methods);
        if (ctx.method !== 'none' && ++failures >= (options.maxAuthFailures ?? Infinity)) client.end();
      };
      if (ctx.username !== username) return reject(methods);
      if (ctx.method === 'password' && options.keyThenPassword === true) {
        return keyDone && ctx.password === password ? ctx.accept() : reject(keyDone ? ['password'] : ['publickey']);
      }
      if (ctx.method === 'password' && methods.includes('password') && ctx.password === password) return ctx.accept();
      if (ctx.method === 'keyboard-interactive' && options.keyboard !== undefined && methods.includes('keyboard-interactive')) {
        const rounds = [...options.keyboard];
        const round = (): void => {
          const next = rounds.shift();
          if (next === undefined) return ctx.accept();
          ctx.prompt(next.prompts.map((p) => ({ ...p })), (answers) => {
            keyboardAnswers.push(answers);
            if (answers.length === next.answers.length && answers.every((a, i) => a === next.answers[i])) round();
            else reject(methods);
          });
        };
        return round();
      }
      if (ctx.method === 'publickey' && allowedKey !== undefined && ctx.key.data.equals(allowedKey.getPublicSSH())) {
        if (ctx.signature === undefined) return ctx.accept(); // key probe
        const ok = allowedKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo);
        if (ok === true && options.keyThenPassword === true) {
          keyDone = true;
          return ctx.reject(['password'], true);
        }
        return ok === true ? ctx.accept() : reject();
      }
      reject(methods);
    });
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        forwards.push(`${info.destIP}:${info.destPort}`);
        if (options.allowForwarding !== true || info.destIP !== '127.0.0.1') return reject();
        const sock = tcpConnect(info.destPort, info.destIP);
        let accepted = false;
        sock.on('error', () => (accepted ? sock.destroy() : reject()));
        sock.once('connect', () => {
          accepted = true;
          const channel = accept();
          channel.pipe(sock).pipe(channel);
          channel.on('close', () => sock.destroy());
          sock.on('close', () => channel.destroy());
        });
      });
      client.on('session', (accept) => {
        const session = accept();
        session.on('subsystem', (acceptSub, rejectSub, info) => {
          if (info.name !== (options.subsystem ?? 'netconf')) return rejectSub();
          const channel = acceptSub();
          const fake = new FakeServer(options.fake);
          last = fake;
          // Ends and closes travel both ways: a dropped fake server drops the channel too.
          joinConnections(duplexConnection(channel, { peer: { host: 'test-client', port: 0 } }), fake.connection);
        });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const parsed = utils.parseKey(HOST_KEY.public);
  if (parsed instanceof Error) throw parsed;
  const blob = parsed.getPublicSSH();
  return {
    port,
    fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`,
    publicKeyLine: `ssh-ed25519 ${blob.toString('base64')}`,
    authAttempts,
    keyboardAnswers,
    last: () => last,
    forwards,
    connected: () => live.size,
    connections: () => connections,
    clients: () => [...live],
    callHome: (listenerPort) =>
      new Promise<Socket>((resolve, reject) => {
        const sock = tcpConnect(listenerPort, '127.0.0.1');
        sock.once('error', reject);
        sock.once('connect', () => {
          sock.removeListener('error', reject);
          sock.on('error', () => undefined);
          (server as Server & { injectSocket(s: Socket): void }).injectSocket(sock);
          resolve(sock);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const c of live) c.end();
      }),
  };
}
