/**
 * NETCONF over SSH (RFC 6242), using ssh2 (design §5.1).
 */

import type { Duplex } from 'node:stream';
import ssh2, { Client, type Algorithms, type AnyAuthMethod, type AuthHandlerMiddleware, type ClientChannel, type ConnectConfig } from 'ssh2';
// ssh2's own default lists, already filtered to what this platform supports. ssh2 has
// no exports map, so its internal constants module is reachable; see ssh2-constants.d.ts.
import ssh2Constants from 'ssh2/lib/protocol/constants.js';
import { AuthenticationError, HostKeyError, TransportError } from '../errors.js';
import { silentLogger, type Logger } from '../logger.js';
import {
  fingerprintOf,
  INSECURE_ACCEPT_ANY,
  toVerifier,
  type HostKeyInfo,
  type HostKeyPolicy,
  type HostKeyVerifier,
} from './host-keys.js';
import { duplexConnection } from './duplex.js';
import type { Connection, ConnectionFactory } from './types.js';

// ssh2 is CommonJS; Node's ESM loader doesn't see `utils` as a named export.
const { parseKey } = ssh2.utils;

/** A secret, or a function that supplies it when connecting (so it needn't sit in memory). */
export type Secret<T> = T | (() => T | Promise<T>);

/** One SSH server to log in to: the NETCONF server itself, or a jump host on the way. */
export interface SshEndpoint {
  /** The host name or address to connect to. */
  readonly host: string;
  /** Default 830 for the NETCONF server, 22 for a jump host. */
  readonly port?: number;
  /** The user to log in as. */
  readonly username: string;
  /** The password, for password authentication (and hidden keyboard-interactive prompts). */
  readonly password?: Secret<string>;
  /** A private key in OpenSSH or PEM format. */
  readonly privateKey?: Secret<string | Buffer>;
  /** The passphrase that decrypts `privateKey`. */
  readonly passphrase?: Secret<string>;
  /** Path of an ssh-agent socket, e.g. `process.env.SSH_AUTH_SOCK`. */
  readonly agent?: string;
  /**
   * Answer keyboard-interactive challenges (RFC 4256), as TACACS+ and RADIUS
   * set-ups often require. Without it, a `password` answers a challenge whose
   * prompts are all hidden; a prompt that would echo is never given the
   * password. See {@link KeyboardInteractiveHandler}.
   */
  readonly keyboardInteractive?: KeyboardInteractiveHandler;
  /**
   * Required. How to verify this server's host key: a `SHA256:` fingerprint,
   * a public key line, a list of either, a verifier such as `knownHostsFile()`,
   * or `'insecure-accept-any'` to skip verification (logged as a warning).
   */
  readonly hostKey: HostKeyPolicy;
  /**
   * Change the algorithm lists offered. The defaults,
   * {@link DEFAULT_SSH_ALGORITHMS}, are ssh2's own minus every legacy
   * algorithm (SHA-1 host keys and MACs, SHA-1 key exchange, CBC ciphers,
   * DSA). Per category, a list replaces the default; `{ append, prepend,
   * remove }` edits the default; an omitted category keeps it. Whenever the
   * result offers a legacy algorithm, each connection logs a warning naming it.
   */
  readonly algorithms?: SshAlgorithms;
  /** Milliseconds between SSH keepalives. Default 30 000; 0 disables. */
  readonly keepaliveInterval?: number;
  /** Unanswered keepalives before the connection is considered dead. Default 3. */
  readonly keepaliveCountMax?: number;
}

/**
 * A jump host (like OpenSSH's `ProxyJump` / `ssh -J`). The connection to the
 * next hop is tunnelled through it, and SSH to the NETCONF server runs end to
 * end inside the tunnel, so the jump host only relays encrypted bytes. Each
 * hop authenticates and verifies its host key independently.
 */
export type SshJumpHost = SshEndpoint;

/**
 * Options for {@link ssh}: the NETCONF server to log in to, plus how to reach
 * it and what to open. See [SSH](/guide/connecting#ssh).
 */
export interface SshOptions extends SshEndpoint {
  /** SSH subsystem to open. Default `'netconf'`. */
  readonly subsystem?: string;
  /** Run this command instead of opening a subsystem (some older devices need it). */
  readonly command?: string;
  /**
   * Reach the server through one or more jump hosts, first hop first:
   * `jump: { host: 'bastion', username, agent: process.env.SSH_AUTH_SOCK, hostKey: knownHostsFile() }`.
   */
  readonly jump?: SshJumpHost | readonly SshJumpHost[];
  /** An already-connected socket to run SSH over, as in call home (RFC 8071). Can't be combined with `jump`. */
  readonly sock?: Duplex;
  /** Where the transport logs, such as a warning about legacy algorithms. Separate from `connect({ logger })`. */
  readonly logger?: Logger;
}

/** One keyboard-interactive challenge from the server (RFC 4256). */
export interface KeyboardInteractiveChallenge {
  /** The server's name for the challenge; often empty. */
  readonly name: string;
  /** Instructions to show the user; often empty. */
  readonly instructions: string;
  /** What to ask. `echo` is true when the answer may be shown as it is typed. */
  readonly prompts: readonly {
    /** The prompt text, such as `Password: `. */
    readonly prompt: string;
    /** Whether the answer may be shown as it is typed; false for a password or code. */
    readonly echo: boolean;
  }[];
}

/**
 * Answers a keyboard-interactive challenge: one answer per prompt, in order.
 * It may be called more than once per login (one challenge per round). A
 * handler that throws ends authentication with an AuthenticationError.
 */
export type KeyboardInteractiveHandler = (challenge: KeyboardInteractiveChallenge) => readonly string[] | Promise<readonly string[]>;

/** Algorithms that are offered only when the caller asks for them, with a warning. */
const LEGACY_ALGORITHMS = [
  'ssh-rsa',
  'ssh-dss',
  'diffie-hellman-group1-sha1',
  'diffie-hellman-group14-sha1',
  'diffie-hellman-group-exchange-sha1',
  '3des-cbc',
  'aes128-cbc',
  'aes192-cbc',
  'aes256-cbc',
  'blowfish-cbc',
  'cast128-cbc',
  'arcfour',
  'arcfour128',
  'arcfour256',
  'hmac-sha1',
  'hmac-sha1-etm@openssh.com',
  'hmac-sha1-96',
  'hmac-md5',
  'hmac-md5-etm@openssh.com',
  'hmac-md5-96',
];

type AlgorithmCategory = 'kex' | 'serverHostKey' | 'cipher' | 'hmac' | 'compress';
const CATEGORIES: readonly AlgorithmCategory[] = ['kex', 'serverHostKey', 'cipher', 'hmac', 'compress'];

/** Complete algorithm lists, one per category, best first. */
export type SshAlgorithmLists = { readonly [K in AlgorithmCategory]: readonly string[] };

/**
 * An edit to one category's default list ({@link DEFAULT_SSH_ALGORITHMS}):
 * `prepend` names go first, `append` names last, and `remove` names are left
 * out. Each takes one name or a list.
 */
export interface SshAlgorithmEdit {
  /** Names to add at the end of the default list. */
  readonly append?: string | readonly string[];
  /** Names to add at the front of the default list, so they are preferred. */
  readonly prepend?: string | readonly string[];
  /** Names to leave out of the default list. */
  readonly remove?: string | readonly string[];
}

/**
 * The `algorithms` option. Per category, a list replaces the default, an
 * {@link SshAlgorithmEdit} changes it, and an omitted category keeps it.
 *
 * @example
 * ```ts
 * ssh({ host, username, password, hostKey,
 *   algorithms: { serverHostKey: { append: 'ssh-rsa' }, compress: ['none'] } });
 * ```
 */
export type SshAlgorithms = { readonly [K in AlgorithmCategory]?: readonly string[] | SshAlgorithmEdit };

const modern = (list: readonly string[]): readonly string[] => Object.freeze(list.filter((a) => !LEGACY_ALGORITHMS.includes(a)));

/**
 * The algorithms offered when `algorithms` is not given: ssh2's defaults for
 * this platform, minus every legacy algorithm. RSA keys still work, through
 * rsa-sha2-512 and rsa-sha2-256 (RFC 8332).
 */
export const DEFAULT_SSH_ALGORITHMS: SshAlgorithmLists = Object.freeze({
  kex: modern(ssh2Constants.DEFAULT_KEX),
  serverHostKey: modern(ssh2Constants.DEFAULT_SERVER_HOST_KEY),
  cipher: modern(ssh2Constants.DEFAULT_CIPHER),
  hmac: modern(ssh2Constants.DEFAULT_MAC),
  compress: modern(ssh2Constants.DEFAULT_COMPRESSION),
});

/** The lists a hop offers: the defaults with the caller's `algorithms` applied. */
function resolveAlgorithms(option: SshAlgorithms | undefined): SshAlgorithmLists {
  const lists = {} as Record<AlgorithmCategory, readonly string[]>;
  for (const category of CATEGORIES) {
    const given = option?.[category] as unknown;
    const defaults = DEFAULT_SSH_ALGORITHMS[category];
    if (given === undefined) lists[category] = defaults;
    else if (Array.isArray(given)) lists[category] = given.map(String);
    else if (given !== null && typeof given === 'object') {
      const edit = given as Partial<Record<'append' | 'prepend' | 'remove', string | readonly string[]>>;
      const names = (v: string | readonly string[] | undefined): string[] => (v === undefined ? [] : typeof v === 'string' ? [v] : [...v]);
      const remove = names(edit.remove);
      const prepend = names(edit.prepend);
      const append = names(edit.append);
      const moved = new Set([...remove, ...prepend, ...append]);
      lists[category] = [...prepend, ...defaults.filter((a) => !moved.has(a)), ...append.filter((a) => !prepend.includes(a))];
    } else {
      throw new TypeError(`ssh(): algorithms.${category} must be a list or { append, prepend, remove }`);
    }
  }
  return lists;
}

/** One hop of the chain, checked at configuration time. */
interface Hop {
  readonly endpoint: SshEndpoint;
  readonly port: number;
  /** For messages: `host:port`, or `jump host host:port`. */
  readonly label: string;
  /** Undefined when verification is disabled. */
  readonly verifier: HostKeyVerifier | undefined;
  /** The algorithm lists this hop offers. */
  readonly algorithms: SshAlgorithmLists;
  /** Legacy algorithms among them, for the warning. */
  readonly legacy: readonly string[];
  /**
   * Call home only: decide the credentials from the host key, once it is seen.
   * Undefined from it rejects the host key. The endpoint's own credentials are
   * then not used.
   */
  readonly credentials?: (info: HostKeyInfo) => Promise<SshCredentials | undefined>;
}

/** Credentials for one SSH login, as chosen for a call-home device. */
export interface SshCredentials {
  readonly username: string;
  readonly password?: Secret<string>;
  readonly privateKey?: Secret<string | Buffer>;
  readonly passphrase?: Secret<string>;
  /** Path of an ssh-agent socket. */
  readonly agent?: string;
  /** Answer keyboard-interactive challenges; see {@link SshEndpoint.keyboardInteractive}. */
  readonly keyboardInteractive?: KeyboardInteractiveHandler;
}

/** Options for an SSH connection over a socket a device opened to us (RFC 8071). */
export interface CallHomeSshOptions {
  /** The accepted socket. */
  readonly sock: Duplex;
  /** The caller's address, for messages and the connection's peer. */
  readonly host: string;
  readonly port: number;
  /**
   * Identify the device from its host key and return the credentials to log
   * in with, or undefined to refuse it. Runs before any credentials are sent.
   */
  readonly identify: (info: HostKeyInfo) => Promise<SshCredentials | undefined>;
  readonly algorithms?: SshAlgorithms;
  readonly keepaliveInterval?: number;
  readonly keepaliveCountMax?: number;
  /** SSH subsystem to open. Default `'netconf'`. */
  readonly subsystem?: string;
  readonly logger?: Logger;
}

/**
 * A connection factory for NETCONF over SSH on a socket the device opened (call
 * home, RFC 8071). We are still the SSH client. The device is identified by its
 * host key, and only then are credentials chosen and sent; its address is
 * never trusted.
 */
export function callHomeSsh(options: CallHomeSshOptions): ConnectionFactory {
  const logger = options.logger ?? silentLogger;
  const label = `call-home device ${options.host}:${options.port}`;
  const hop: Hop = {
    // Credentials come from `credentials`; the endpoint's are placeholders.
    endpoint: {
      host: options.host,
      port: options.port,
      username: '',
      hostKey: INSECURE_ACCEPT_ANY,
      ...(options.algorithms !== undefined ? { algorithms: options.algorithms } : {}),
      ...(options.keepaliveInterval !== undefined ? { keepaliveInterval: options.keepaliveInterval } : {}),
      ...(options.keepaliveCountMax !== undefined ? { keepaliveCountMax: options.keepaliveCountMax } : {}),
    },
    port: options.port,
    label,
    verifier: undefined,
    ...algorithmsOf(options.algorithms),
    credentials: options.identify,
  };
  return async (signal) => {
    if (hop.legacy.length > 0) logger.warn?.(`Legacy SSH algorithms enabled for ${label}: ${hop.legacy.join(', ')}`);
    const clients: Client[] = [];
    let channel: ClientChannel | undefined;
    const lost = (_hop: Hop, err?: Error): void => {
      if (channel === undefined) return;
      if (err !== undefined) logger.debug?.(`SSH connection to ${label} failed: ${err.message}`);
      (channel as Duplex).destroy(err);
      for (const c of clients) c.destroy();
    };
    try {
      // The device's credentials are revealed, and their key checked, once it is identified.
      const opened = await abortable(signal, login(hop, {}, options.sock, clients, lost));
      channel = await abortable(signal, startNetconf(opened.client, { subsystem: options.subsystem } as SshOptions, hop));
      return sshConnection(clients, channel, options.host, options.port, opened.fingerprint);
    } catch (err) {
      for (const c of clients.reverse()) c.destroy();
      throw err;
    }
  };
}

function hopOf(endpoint: SshEndpoint, defaultPort: number, jump: boolean): Hop {
  const port = endpoint.port ?? defaultPort;
  const label = `${jump ? 'jump host ' : ''}${endpoint.host}:${port}`;
  // Validate the policy now, so a bad fingerprint fails at configuration time.
  const policy: HostKeyPolicy | undefined = (endpoint as Partial<SshEndpoint>).hostKey;
  if (policy === undefined || policy === '') {
    throw new HostKeyError(
      `ssh(): hostKey is required${jump ? ` for ${label}` : ''}. Pass the server key fingerprint, knownHostsFile(), or ` +
        `'${INSECURE_ACCEPT_ANY}' to disable verification.`,
    );
  }
  return {
    endpoint,
    port,
    label,
    verifier: policy === INSECURE_ACCEPT_ANY ? undefined : toVerifier(policy),
    ...algorithmsOf(endpoint.algorithms),
  };
}

/** Create a connection factory for NETCONF over SSH, optionally through jump hosts. */
export function ssh(options: SshOptions): ConnectionFactory {
  const logger = options.logger ?? silentLogger;
  const jumps: readonly SshJumpHost[] = options.jump === undefined ? [] : 'host' in options.jump ? [options.jump] : options.jump;
  if (jumps.length > 0 && options.sock !== undefined) {
    throw new TypeError('ssh(): pass either jump or sock, not both');
  }
  const hops = [...jumps.map((j) => hopOf(j, 22, true)), hopOf(options, 830, false)];
  const target = hops.at(-1)!;

  return async (signal) => {
    for (const hop of hops) {
      if (hop.verifier === undefined) logger.warn?.(`SSH host-key verification is disabled for ${hop.label}`);
      if (hop.legacy.length > 0) logger.warn?.(`Legacy SSH algorithms enabled for ${hop.label}: ${hop.legacy.join(', ')}`);
    }

    const clients: Client[] = [];
    let channel: ClientChannel | undefined;
    // After setup, a failure anywhere in the chain ends the NETCONF stream, where the session listens.
    const lost = (hop: Hop, err?: Error): void => {
      if (channel === undefined) return; // during setup, the hop being set up reports the failure
      if (err !== undefined) logger.debug?.(`SSH connection to ${hop.label} failed: ${err.message}`);
      // ClientChannel's typings hide Duplex.destroy(err).
      (channel as Duplex).destroy(err);
      for (const c of clients) c.destroy();
    };

    try {
      // Every hop's secrets first, one hop at a time (a prompt for each, in order), and every
      // private key decrypted before anything is sent: a bad passphrase never reaches a server.
      const secrets: Secrets[] = [];
      for (const hop of hops) {
        const revealed = await abortable(signal, revealSecrets(hop.endpoint));
        const bad = keyProblem(userAt(hop.label, hop.endpoint.username), revealed.privateKey, revealed.passphrase);
        if (bad !== undefined) throw bad;
        secrets.push(revealed);
      }

      let sock = options.sock;
      let fingerprint: string | undefined;
      for (const [i, hop] of hops.entries()) {
        const opened = await abortable(signal, login(hop, secrets[i]!, sock, clients, lost));
        fingerprint = opened.fingerprint;
        const next = hops[i + 1];
        if (next !== undefined) {
          sock = await abortable(signal, tunnel(opened.client, hop, next));
          logger.debug?.(`SSH tunnel open through ${hop.label} to ${next.endpoint.host}:${next.port}`);
        }
      }
      const client = clients.at(-1)!;
      channel = await abortable(signal, startNetconf(client, options, target));
      return sshConnection(clients, channel, options.host, target.port, fingerprint);
    } catch (err) {
      // Hard close: a graceful end() can leave the socket open before the handshake.
      for (const c of clients.reverse()) c.destroy();
      throw err;
    }
  };
}

/**
 * SSH handshake, host-key check and authentication with one hop. The client is
 * added to `clients` before connecting, so an abort can destroy it mid-handshake.
 */
async function login(
  hop: Hop,
  { password, privateKey, passphrase }: Secrets,
  sock: Duplex | undefined,
  clients: Client[],
  lost: (hop: Hop, err?: Error) => void,
): Promise<{ client: Client; fingerprint: string | undefined }> {
  const { endpoint, port, label, verifier } = hop;
  const algorithms = await algorithmsFor(hop);

  return new Promise((resolve, reject) => {
    const client = new Client();
    clients.push(client);
    /**
     * Host-key rejection, an unusable key for call-home credentials, or a
     * keyboard-interactive handler that failed. Reported in place of ssh2's error.
     */
    let failure: TransportError | undefined;
    let fingerprint: string | undefined;
    /** Call home: the host key of the first key exchange; re-keys must present the same one. */
    let firstKey: Buffer | undefined;
    /** Call home: the credentials identify chose for the device. */
    let chosen: Credentials | undefined;

    /**
     * Call home: identify the device and choose its credentials. Runs from the
     * first authHandler call, so only after the handshake has finished and the
     * server has proved it holds the host key (ssh2 checks the exchange-hash
     * signature after hostVerifier), and only once per connection.
     */
    const identify = async (): Promise<boolean> => {
      const info: HostKeyInfo = { host: endpoint.host, port, key: firstKey!, fingerprint: fingerprint! };
      try {
        const creds = await hop.credentials!(info);
        if (creds === undefined) {
          failure = new HostKeyError(`The ${label} was not accepted (host key ${fingerprint})`);
          return false;
        }
        const [pw, pk, pp] = await Promise.all([reveal(creds.password), reveal(creds.privateKey), reveal(creds.passphrase)]);
        // Offer nothing at all when the key can't be decrypted: authentication ends unsent.
        const bad = keyProblem(userAt(label, creds.username), pk, pp);
        if (bad !== undefined) {
          failure = bad;
          return false;
        }
        chosen = {
          username: creds.username,
          ...(pw !== undefined ? { password: pw } : {}),
          ...(pk !== undefined ? { privateKey: pk } : {}),
          ...(pp !== undefined ? { passphrase: pp } : {}),
          ...(creds.agent !== undefined ? { agent: creds.agent } : {}),
          ...(creds.keyboardInteractive !== undefined ? { keyboardInteractive: creds.keyboardInteractive } : {}),
        };
        return true;
      } catch (err) {
        failure = new HostKeyError(`Identifying the ${label} failed`, { cause: err });
        return false;
      }
    };

    const config: ConnectConfig = {
      host: endpoint.host,
      port,
      username: endpoint.username,
      keepaliveInterval: endpoint.keepaliveInterval ?? 30_000,
      keepaliveCountMax: endpoint.keepaliveCountMax ?? 3,
      // The session's connect timeout (via the signal) governs; keep ssh2's out of the way.
      readyTimeout: 2_147_483_647,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        if (hop.credentials !== undefined) {
          // Call home: record the key; the device is identified once the handshake proves it.
          // ssh2 calls this again on every re-key: only the same key is accepted then.
          if (firstKey === undefined) {
            firstKey = Buffer.from(key);
            fingerprint = fingerprintOf(key);
            verify(true);
          } else {
            verify(firstKey.equals(key));
          }
          return;
        }
        fingerprint = fingerprintOf(key);
        if (verifier === undefined) {
          verify(true);
          return;
        }
        const info: HostKeyInfo = { host: endpoint.host, port, key, fingerprint };
        Promise.resolve()
          .then(() => verifier(info))
          .then(
            (ok) => {
              if (!ok) failure = new HostKeyError(`Host key for ${label} was not accepted (fingerprint ${fingerprint})`);
              verify(ok);
            },
            (err: unknown) => {
              failure = new HostKeyError(`Host-key verification failed for ${label}`, { cause: err });
              verify(false);
            },
          );
      },
      algorithms,
      ...(sock !== undefined ? { sock } : {}),
      // Call home: identify the device first, then offer the credentials chosen for it.
      authHandler: authHandler(
        hop.credentials !== undefined
          ? async () => ((await identify()) ? chosen : undefined)
          : () =>
              Promise.resolve({
                username: endpoint.username,
                ...(password !== undefined ? { password } : {}),
                ...(privateKey !== undefined ? { privateKey } : {}),
                ...(passphrase !== undefined ? { passphrase } : {}),
                ...(endpoint.agent !== undefined ? { agent: endpoint.agent } : {}),
                ...(endpoint.keyboardInteractive !== undefined ? { keyboardInteractive: endpoint.keyboardInteractive } : {}),
              }),
        (username, cause) => {
          // A password that can't answer the challenge says so in `reason`; a caller's handler that threw is 'refused'.
          const reason = cause instanceof AuthenticationError ? cause.reason : 'refused';
          failure = new AuthenticationError(`Keyboard-interactive authentication failed for ${userAt(label, username)}`, { cause, reason });
          client.destroy();
        },
      ),
    };

    client.on('error', (err: Error & { level?: string }) => {
      if (failure) reject(failure);
      else if (err.level === 'client-authentication') {
        const user = chosen?.username ?? endpoint.username;
        reject(new AuthenticationError(`SSH authentication failed for ${user}@${label}`, { cause: err }));
      } else reject(new TransportError(`SSH connection to ${label} failed: ${err.message}`, { cause: err }));
    });
    // Key exchange done: a close from here to 'ready' is the server ending authentication,
    // typically after too many failed attempts (MaxAuthTries and the like), with no
    // authentication failure reported by ssh2.
    let handshaken = false;
    client.once('handshake', () => {
      handshaken = true;
    });
    client.on('close', () => {
      if (failure) reject(failure);
      else if (handshaken) {
        reject(new AuthenticationError(`SSH server at ${label} closed the connection during authentication (it may limit failed attempts)`));
      } else reject(new TransportError(`SSH connection to ${label} closed during setup`));
    });
    client.on('ready', () => {
      client.removeAllListeners('error');
      client.removeAllListeners('close');
      client.on('error', (err: Error) => lost(hop, err));
      client.on('close', () => lost(hop));
      resolve({ client, fingerprint });
    });

    client.connect(config);
  });
}

/** What one hop authenticates with, revealed. */
interface Credentials {
  readonly username: string;
  readonly password?: string;
  readonly privateKey?: string | Buffer;
  readonly passphrase?: string;
  readonly agent?: string;
  readonly keyboardInteractive?: KeyboardInteractiveHandler;
}

/**
 * An ssh2 authHandler. Its first call gets the credentials (for call home,
 * that identifies the device, once the handshake has proved it holds its host
 * key), then it offers them in ssh2's own default order: none, password,
 * publickey, agent, keyboard-interactive. A method is offered only if the
 * server says it can continue with it, so methods it doesn't allow cost no
 * failed attempts against a lockout policy. With no credentials it offers
 * nothing, which ends authentication.
 *
 * Keyboard-interactive is offered with a handler, or with a password, which
 * then answers hidden prompts. A password the server already rejected through
 * password authentication is not sent again that way.
 */
function authHandler(
  credentials: () => Promise<Credentials | undefined>,
  failed: (username: string, cause: unknown) => void,
): AuthHandlerMiddleware {
  let methods: AnyAuthMethod[] | undefined;
  let last: string | undefined;
  let passwordRejected = false;
  /** Keyboard-interactive answered from the password, not from a handler. */
  let fromPassword = false;
  // ssh2 takes false for "no more methods"; its typings leave that out.
  type Next = (method: AnyAuthMethod | false) => void;
  const offer = (allowed: string[] | null, partialSuccess: boolean, next: Next): void => {
    if (last === 'password' && !partialSuccess) passwordRejected = true;
    // ssh2 doesn't pass on what the server allows after an agent attempt, so
    // the list it gives then is stale: offer the next method regardless.
    if (last === 'agent') allowed = null;
    // A method the server doesn't allow now stays queued: after a partial
    // success (publickey, then password, say) it may be allowed next.
    const i = methods!.findIndex(
      (m) =>
        // An agent signs with a key: on the wire that is the publickey method.
        (allowed === null || allowed.includes(m.type === 'agent' ? 'publickey' : m.type)) &&
        !(m.type === 'keyboard-interactive' && fromPassword && passwordRejected),
    );
    const [m] = i === -1 ? [] : methods!.splice(i, 1);
    last = m?.type;
    next(m ?? false);
  };
  return (allowed, partialSuccess, next) => {
    if (methods !== undefined) {
      offer(allowed, partialSuccess, next as Next);
      return;
    }
    void credentials().then((c) => {
      methods = [];
      if (c !== undefined) {
        const username = c.username;
        methods.push({ type: 'none', username });
        if (c.password !== undefined) methods.push({ type: 'password', username, password: c.password });
        if (c.privateKey !== undefined) {
          methods.push({ type: 'publickey', username, key: c.privateKey, ...(c.passphrase !== undefined ? { passphrase: c.passphrase } : {}) });
        }
        if (c.agent !== undefined) methods.push({ type: 'agent', username, agent: c.agent });
        const password = c.password;
        const answer = c.keyboardInteractive ?? (password !== undefined ? answerWithPassword(password) : undefined);
        fromPassword = c.keyboardInteractive === undefined;
        if (answer !== undefined) {
          methods.push({
            type: 'keyboard-interactive',
            username,
            prompt: (name, instructions, _lang, prompts, finish) => {
              const challenge: KeyboardInteractiveChallenge = {
                name,
                instructions,
                prompts: prompts.map((p) => ({ prompt: p.prompt, echo: p.echo === true })),
              };
              Promise.resolve()
                .then(() => answer(challenge))
                .then(
                  (answers) => finish(answers.map(String)),
                  (err: unknown) => failed(username, err),
                );
            },
          });
        }
      }
      offer(allowed, partialSuccess, next as Next);
    }).catch(() => undefined); // the connection was torn down meanwhile (abort, timeout): nothing to offer to
  };
}

/** Answer a challenge whose prompts are all hidden with the password; refuse one that echoes. */
function answerWithPassword(password: string): KeyboardInteractiveHandler {
  return ({ prompts }) => {
    const shown = prompts.find((p) => p.echo);
    if (shown !== undefined) {
      throw new AuthenticationError(`The server asked for more than a password (${JSON.stringify(shown.prompt)}); pass keyboardInteractive to answer it`, { reason: 'prompt' });
    }
    return prompts.map(() => password);
  };
}

/** ssh2 host-key algorithms for each key type, best first. Unsupported types are left out. */
const HOST_KEY_ALGORITHMS: Readonly<Record<string, readonly string[]>> = {
  'ssh-ed25519': ['ssh-ed25519'],
  'ecdsa-sha2-nistp256': ['ecdsa-sha2-nistp256'],
  'ecdsa-sha2-nistp384': ['ecdsa-sha2-nistp384'],
  'ecdsa-sha2-nistp521': ['ecdsa-sha2-nistp521'],
  'ssh-rsa': ['rsa-sha2-512', 'rsa-sha2-256'],
};

/**
 * The hop's algorithms as complete lists for ssh2, with the host-key types its
 * policy knows moved to the front (as OpenSSH does). Otherwise a server with
 * several host keys may present one the known_hosts file doesn't hold. An
 * explicit `algorithms.serverHostKey` is left alone.
 */
async function algorithmsFor(hop: Hop): Promise<Algorithms> {
  const { endpoint, verifier, port } = hop;
  let serverHostKey = hop.algorithms.serverHostKey;
  if (verifier?.knownKeyTypes !== undefined && endpoint.algorithms?.serverHostKey === undefined) {
    const known = (await verifier.knownKeyTypes(endpoint.host, port)).flatMap((t) => HOST_KEY_ALGORITHMS[t] ?? []);
    serverHostKey = [...known.filter((a) => serverHostKey.includes(a)), ...serverHostKey.filter((a) => !known.includes(a))];
  }
  // ssh2 checks each name against what it supports; its typings want literal unions.
  return { ...hop.algorithms, serverHostKey } as unknown as Algorithms;
}

/** Open a direct-tcpip channel through a jump host to the next hop. */
function tunnel(client: Client, through: Hop, next: Hop): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, next.endpoint.host, next.port, (err, stream) => {
      if (err) {
        reject(
          new TransportError(`The ${through.label} could not open a connection to ${next.endpoint.host}:${next.port}: ${err.message}`, {
            cause: err,
          }),
        );
      } else resolve(stream);
    });
  });
}

/** Open the netconf subsystem (or exec command) on the NETCONF server. */
function startNetconf(client: Client, options: SshOptions, target: Hop): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    const opened = (err: Error | undefined, channel: ClientChannel): void => {
      if (err) reject(new TransportError(`Could not start NETCONF on ${target.label}: ${err.message}`, { cause: err }));
      else resolve(channel);
    };
    if (options.command !== undefined) client.exec(options.command, opened);
    else client.subsys(options.subsystem ?? 'netconf', opened);
  });
}

/** Settle with `promise`, or reject with the signal's reason as soon as it aborts. */
function abortable<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      promise.catch(() => undefined);
      reject(signal.reason as Error);
      return;
    }
    const onAbort = (): void => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** The NETCONF server's client is last; jump hosts are closed after it, innermost first. */
function sshConnection(
  clients: readonly Client[],
  channel: ClientChannel,
  host: string,
  port: number,
  fingerprint: string | undefined,
): Connection {
  let closing: Promise<void> | undefined;
  const closed = new WeakSet<Client>();
  for (const client of clients) client.once('close', () => closed.add(client));
  const endGracefully = (client: Client): Promise<void> =>
    new Promise<void>((resolve) => {
      if (closed.has(client)) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        client.destroy();
        resolve();
      }, 2_000);
      client.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      client.end();
    });
  return duplexConnection(channel, {
    peer: { host, port, ...(fingerprint !== undefined ? { identity: fingerprint } : {}) },
    close: () => {
      closing ??= (async () => {
        channel.destroy();
        for (const client of [...clients].reverse()) await endGracefully(client);
      })();
      return closing;
    },
  });
}

/** One endpoint's secrets, revealed. */
interface Secrets {
  readonly password?: string;
  readonly privateKey?: string | Buffer;
  readonly passphrase?: string;
}

async function revealSecrets(endpoint: SshEndpoint): Promise<Secrets> {
  const [password, privateKey, passphrase] = await Promise.all([
    reveal(endpoint.password),
    reveal(endpoint.privateKey),
    reveal(endpoint.passphrase),
  ]);
  return {
    ...(password !== undefined ? { password } : {}),
    ...(privateKey !== undefined ? { privateKey } : {}),
    ...(passphrase !== undefined ? { passphrase } : {}),
  };
}

/** `user@host:port` from a hop label (`host:port`, `jump host host:port`, `call-home device host:port`). */
function userAt(label: string, username: string): string {
  const at = label.lastIndexOf(' ') + 1;
  return `${label.slice(0, at)}${username}@${label.slice(at)}`;
}

/**
 * Parse and decrypt a private key locally, as ssh2 would when authenticating.
 * Returns the error to fail with, or undefined if the key is usable (or absent).
 * Never quotes the key or the passphrase.
 */
function keyProblem(who: string, privateKey: string | Buffer | undefined, passphrase: string | undefined): AuthenticationError | undefined {
  if (privateKey === undefined) return undefined;
  const parsed = parseKey(privateKey, passphrase);
  if (!(parsed instanceof Error)) return undefined;
  // Without a passphrase, an encrypted key says so; then a given passphrase failed its check.
  const bare = passphrase === undefined ? parsed : parseKey(privateKey);
  const encrypted = bare instanceof Error && /no passphrase given/i.test(bare.message);
  const message =
    encrypted && passphrase === undefined
      ? `The private key for ${who} is encrypted, but no passphrase was given`
      : encrypted && /passphrase/i.test(parsed.message)
        ? `The private key for ${who} could not be decrypted (wrong passphrase?)`
        : `The private key for ${who} could not be read: ${parsed.message}`;
  return new AuthenticationError(message, { reason: 'key', cause: parsed });
}

async function reveal<T>(secret: Secret<T> | undefined): Promise<T | undefined> {
  return typeof secret === 'function' ? await (secret as () => T | Promise<T>)() : secret;
}

/** A hop's resolved algorithm lists, and the legacy algorithms they offer. */
function algorithmsOf(option: SshAlgorithms | undefined): { algorithms: SshAlgorithmLists; legacy: readonly string[] } {
  const algorithms = resolveAlgorithms(option);
  const offered = new Set(CATEGORIES.flatMap((c) => algorithms[c]));
  return { algorithms, legacy: LEGACY_ALGORITHMS.filter((a) => offered.has(a)) };
}
