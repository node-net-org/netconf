/**
 * NETCONF call home (RFC 8071): listen for devices that connect to us, and
 * get an ordinary NetconfClient for each (design §5.1).
 *
 * ```ts
 * await using listener = await listenCallHome({
 *   ssh: {},                 // port 4334
 *   tls: { cert, key, ca },  // port 4335
 *   identify: (caller) => devices.get(caller.fingerprint),  // undefined refuses the caller
 * });
 * listener.on('rejected', (e) => log.warn('call home refused', e));
 * for await (const { client, device } of listener) manage(device, client);
 * ```
 *
 * Only the TCP connection is reversed: we are still the SSH or TLS client and
 * the NETCONF client. A device is identified by its SSH host key or TLS
 * certificate, never by its address. Over SSH, `identify` runs once the
 * handshake has proved the device holds its host key, and returns that
 * device's credentials, so nothing is sent to an unknown caller. Over TLS, our certificate is the listener's (Node can't
 * choose one after seeing the server's), and `identify` accepts or refuses the
 * device by its certificate.
 *
 * The port is open to anyone: limits bound how many calls may be setting up at
 * once (`maxPending`), how long each may take (`handshakeTimeout`) and how
 * many clients may wait to be taken (`maxQueued`). Refused and failed calls
 * are reported as events; nothing is thrown.
 */

import type { Server, Socket } from 'node:net';
import { openClient, type ConnectOptions, type NetconfClient } from './client.js';
import { directorySource } from './yang/files.js';
import { AbortError, NetconfError, TimeoutError, TransportError } from './errors.js';
import { silentLogger, type Logger } from './logger.js';
import { TypedEmitter } from './messages/index.js';
import type { ContentMap, Extension, OpsMap } from './operations/index.js';
import {
  CALL_HOME_SSH_PORT,
  CALL_HOME_TLS_PORT,
  callHomeSsh,
  callHomeTls,
  certificateOf,
  listenTcp,
  remoteOf,
  sshKeyType,
  type CallHomeCaller,
  type CallHomeRemote,
  type CallHomeTransport,
  type KeyboardInteractiveHandler,
  type Pem,
  type Secret,
  type SshAlgorithms,
} from './transport/node.js';
import { checkTimeout, startTimer, unrefTimer } from './timers.js';
import type { Connection, ConnectionFactory } from './transport/index.js';

export type { CallHomeCaller, CallHomeRemote, CallHomeTransport } from './transport/node.js';
export { CALL_HOME_SSH_PORT, CALL_HOME_TLS_PORT } from './transport/node.js';

/** Connect options a listener or device may set: everything but the transport and signal. */
export type CallHomeConnectOptions<E extends readonly Extension[] = readonly Extension[]> = Omit<ConnectOptions<E>, 'transport' | 'signal'>;

/** What `identify` returns for a device it knows. */
export interface CallHomeDevice<E extends readonly Extension[] = readonly Extension[]> {
  /** Your name for the device, carried through to the call. */
  readonly name?: string;
  /** SSH: the user to log in as. Required for SSH calls. */
  readonly username?: string;
  /** SSH: the password to log in with. */
  readonly password?: Secret<string>;
  /** SSH: a private key in OpenSSH or PEM format. */
  readonly privateKey?: Secret<string | Buffer>;
  /** SSH: the passphrase that decrypts `privateKey`. */
  readonly passphrase?: Secret<string>;
  /** Path of an ssh-agent socket. */
  readonly agent?: string;
  /** Answer keyboard-interactive challenges, as for `ssh()`. */
  readonly keyboardInteractive?: KeyboardInteractiveHandler;
  /** Connect options for this device (a profile, say), over the listener's `connect`. */
  readonly connect?: CallHomeConnectOptions<E>;
}

/** How to listen for SSH call home, as `listenCallHome({ ssh })`. */
export interface CallHomeSshListen {
  /** Default 4334. 0 picks a free port (see `addresses`). */
  readonly port?: number;
  /** Interface address to listen on. Default: all interfaces. */
  readonly host?: string;
  /** Change the SSH algorithm lists offered, as for `ssh()`. */
  readonly algorithms?: SshAlgorithms;
  /** Milliseconds between SSH keepalives. Default 30 000; 0 disables. */
  readonly keepaliveInterval?: number;
}

/** How to listen for TLS call home, as `listenCallHome({ tls })`. */
export interface CallHomeTlsListen {
  /** Default 4335. 0 picks a free port (see `addresses`). */
  readonly port?: number;
  /** Interface address to listen on. Default: all interfaces. */
  readonly host?: string;
  /** Our certificate (PEM), sent to every caller. */
  readonly cert: Secret<Pem>;
  /** The private key for `cert` (PEM). */
  readonly key: Secret<Pem>;
  /** The passphrase that decrypts `key`. */
  readonly passphrase?: Secret<string>;
  /** Trust anchors the device's chain must lead to (no host-name check). `identify` decides either way. */
  readonly ca?: Pem | readonly Pem[];
  /** OpenSSL cipher list, replacing `DEFAULT_TLS_CIPHERS`, as for `tls()`. */
  readonly ciphers?: string;
}

/** Options for {@link listenCallHome}. See [Call home](/guide/call-home). */
export interface CallHomeOptions<E extends readonly Extension[] = readonly Extension[]> {
  /** Listen for SSH call home (RFC 8071 §3.1). */
  readonly ssh?: CallHomeSshListen;
  /** Listen for TLS call home (RFC 8071 §4.1). */
  readonly tls?: CallHomeTlsListen;
  /**
   * Identify the caller by its host key or certificate fingerprint, and return
   * the device (with SSH credentials), or undefined or false to refuse it. May
   * be async. Throwing refuses it too.
   */
  readonly identify: (caller: CallHomeCaller) => CallHomeDevice<E> | undefined | false | Promise<CallHomeDevice<E> | undefined | false>;
  /** Connect options for every client (extensions, timeouts, …). A device's own override these. */
  readonly connect?: CallHomeConnectOptions<E>;
  /** Most calls being set up at once; more are closed straight away. Default 16. */
  readonly maxPending?: number;
  /** Most clients waiting to be taken from the listener; more are closed. Default 16. */
  readonly maxQueued?: number;
  /**
   * Milliseconds a call may take from accept to a ready client. Default
   * 30 000. `Infinity` means no limit, and values above 2,147,483,647 are
   * shortened to it; zero, a negative number or NaN is a `RangeError`.
   */
  readonly handshakeTimeout?: number;
  /**
   * Wrap each accepted call's connection before the NETCONF hello, to watch or
   * record what passes over it (a tool's trace, say). It gets the connection
   * and the identified caller, and returns the connection the client uses.
   * A throw fails the call (a `failed` event). Default: none.
   */
  readonly wrapConnection?: (connection: Connection, caller: CallHomeCaller) => Connection;
  /** Closes the listener when aborted. */
  readonly signal?: AbortSignal;
  /** Where the listener and its transports log. Clients log to `connect.logger`, if given. */
  readonly logger?: Logger;
}

/** One device that called home and is ready. */
export interface CallHomeCall<E extends readonly Extension[] = readonly Extension[]> {
  /** An open client for the device; yours to close. */
  readonly client: NetconfClient<OpsMap<E>, ContentMap<E>>;
  /** What `identify` returned for the caller. */
  readonly device: CallHomeDevice<E>;
  /** Who called: the transport, the key or certificate fingerprint, and the address. */
  readonly caller: CallHomeCaller;
}

/** The events a {@link CallHomeListener} emits. See [Call home](/guide/call-home). */
export interface CallHomeEvents extends Record<string, unknown> {
  /** A call was refused: unknown device, over a limit, or the listener closing. */
  rejected: {
    /** The transport the call came in on. */
    readonly transport: CallHomeTransport;
    /** Where the call came from. */
    readonly remote: CallHomeRemote;
    /** Who called, when the handshake got far enough to show it. */
    readonly caller?: CallHomeCaller;
    /** Why the call was refused. */
    readonly reason: string;
  };
  /** A call failed while being set up: handshake, authentication, hello or timeout. */
  failed: {
    /** The transport the call came in on. */
    readonly transport: CallHomeTransport;
    /** Where the call came from. */
    readonly remote: CallHomeRemote;
    /** Who called, when the handshake got far enough to show it. */
    readonly caller?: CallHomeCaller;
    /** What went wrong. */
    readonly error: NetconfError;
  };
}

const DEFAULT_MAX_PENDING = 16;
const DEFAULT_MAX_QUEUED = 16;
const DEFAULT_HANDSHAKE_TIMEOUT = 30_000;

type Waiter<E extends readonly Extension[]> = (result: IteratorResult<CallHomeCall<E>>) => void;

/**
 * Listening for call home. Read the clients with `for await` (leaving the loop
 * closes the listener), or `next()`. `close()` and `await using` stop
 * listening, abort calls being set up, close clients not yet taken and end
 * iteration; clients already taken are yours to close.
 */
export class CallHomeListener<E extends readonly Extension[] = readonly Extension[]>
  extends TypedEmitter<CallHomeEvents>
  implements AsyncIterableIterator<CallHomeCall<E>>, AsyncDisposable
{
  private readonly servers: { transport: CallHomeTransport; server: Server }[] = [];
  private readonly pending = new Set<AbortController>();
  private readonly queue: CallHomeCall<E>[] = [];
  private readonly waiters: Waiter<E>[] = [];
  private closing: Promise<void> | undefined;
  private stopWatchingSignal: (() => void) | undefined;
  private readonly maxPending: number;
  private readonly maxQueued: number;
  private readonly handshakeTimeout: number | undefined;
  private readonly logger: Logger;

  /** @internal Use listenCallHome(). */
  constructor(private readonly options: CallHomeOptions<E>) {
    super(options.logger ?? silentLogger);
    this.logger = options.logger ?? silentLogger;
    this.maxPending = positive(options.maxPending, 'maxPending', DEFAULT_MAX_PENDING);
    this.maxQueued = positive(options.maxQueued, 'maxQueued', DEFAULT_MAX_QUEUED);
    this.handshakeTimeout = checkTimeout(options.handshakeTimeout ?? DEFAULT_HANDSHAKE_TIMEOUT, 'listenCallHome: handshakeTimeout');
  }

  /** Where the listener is bound, per transport. */
  get addresses(): {
    /** The SSH listening address, when listening for SSH. */
    readonly ssh?: CallHomeRemote;
    /** The TLS listening address, when listening for TLS. */
    readonly tls?: CallHomeRemote;
  } {
    const out: Record<string, CallHomeRemote> = {};
    for (const { transport, server } of this.servers) {
      const a = server.address();
      if (a !== null && typeof a === 'object') out[transport] = { address: a.address, port: a.port };
    }
    return out;
  }

  /** True once close() has been called. */
  get closed(): boolean {
    return this.closing !== undefined;
  }

  /** Calls being set up right now. */
  get pendingCalls(): number {
    return this.pending.size;
  }

  /** @internal Bind the ports. */
  async _listen(): Promise<void> {
    const { ssh, tls } = this.options;
    try {
      if (ssh !== undefined) {
        this.servers.push({ transport: 'ssh', server: await listenTcp('ssh', ssh.host, ssh.port ?? CALL_HOME_SSH_PORT, (s) => this.accept('ssh', s)) });
      }
      if (tls !== undefined) {
        this.servers.push({ transport: 'tls', server: await listenTcp('tls', tls.host, tls.port ?? CALL_HOME_TLS_PORT, (s) => this.accept('tls', s)) });
      }
    } catch (err) {
      await this.close();
      throw err;
    }
    const signal = this.options.signal;
    if (signal !== undefined) {
      if (signal.aborted) {
        await this.close();
      } else {
        const onAbort = (): void => void this.close();
        signal.addEventListener('abort', onAbort, { once: true });
        this.stopWatchingSignal = () => signal.removeEventListener('abort', onAbort);
      }
    }
  }

  /** The next ready call, waiting for one if none is queued; done once the listener is closed. */
  async next(): Promise<IteratorResult<CallHomeCall<E>>> {
    const queued = this.queue.shift();
    if (queued !== undefined) return { value: queued, done: false };
    if (this.closed) return { value: undefined, done: true };
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Stop reading: closes the listener. */
  async return(): Promise<IteratorResult<CallHomeCall<E>>> {
    await this.close();
    return { value: undefined, done: true };
  }

  /** Iterate over the calls with `for await`; leaving the loop closes the listener. */
  [Symbol.asyncIterator](): this {
    return this;
  }

  /** Close the listener, for `await using`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** Stop listening, abort calls being set up, close clients not yet taken, end iteration. Idempotent. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.stopWatchingSignal?.();
      for (const c of this.pending) c.abort(new AbortError('The call-home listener closed'));
      for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
      // Stop accepting now. server.close()'s callback waits for every accepted
      // connection to end, including clients already taken, so don't wait for it.
      for (const { server } of this.servers) server.close();
      await Promise.allSettled(this.queue.splice(0).map(({ client }) => client.close()));
    })();
    return this.closing;
  }

  // --- one call ---

  private accept(transport: CallHomeTransport, socket: Socket): void {
    const remote = remoteOf(socket);
    socket.on('error', () => undefined); // failures are reported by the handshake that owns the socket
    if (this.closed) {
      socket.destroy();
      return;
    }
    if (this.pending.size >= this.maxPending) {
      socket.destroy();
      this.dispatch('rejected', { transport, remote, reason: `too many calls being set up (maxPending ${this.maxPending})` });
      return;
    }
    void this.handle(transport, socket, remote);
  }

  private async handle(transport: CallHomeTransport, socket: Socket, remote: CallHomeRemote): Promise<void> {
    const controller = new AbortController();
    this.pending.add(controller);
    const timer = startTimer(() => controller.abort(new TimeoutError('connect', this.handshakeTimeout ?? Infinity)), this.handshakeTimeout);
    unrefTimer(timer);
    let caller: CallHomeCaller | undefined;
    let device: CallHomeDevice<E> | undefined;
    let refusal: string | undefined;
    let connection: Connection | undefined;

    /** Ask identify(); record why a caller is refused. */
    const decide = async (who: CallHomeCaller): Promise<CallHomeDevice<E> | undefined> => {
      caller = who;
      let answer: CallHomeDevice<E> | undefined | false;
      try {
        answer = await this.options.identify(who);
      } catch (err) {
        refusal = `identify threw: ${err instanceof Error ? err.message : String(err)}`;
        return undefined;
      }
      if (answer === undefined || answer === false) {
        refusal = `unknown device (${who.fingerprint})`;
        return undefined;
      }
      if (transport === 'ssh' && (typeof answer.username !== 'string' || answer.username === '')) {
        refusal = `identify returned no username for ${who.fingerprint}`;
        return undefined;
      }
      device = answer;
      return answer;
    };

    try {
      const factory = this.factory(transport, socket, remote, decide);
      connection = await factory(controller.signal);
      const base = this.options.connect ?? {};
      const own = device?.connect ?? {};
      const opened = this.options.wrapConnection === undefined ? connection : this.options.wrapConnection(connection, caller!);
      const client = (await openClient({
        ...base,
        ...own,
        transport: () => Promise.resolve(opened),
        signal: controller.signal,
      }, { directories: directorySource })) as unknown as NetconfClient<OpsMap<E>, ContentMap<E>>;
      this.deliver({ client, device: device!, caller: caller! }, transport, remote);
    } catch (err) {
      socket.destroy();
      void connection?.close();
      if (refusal !== undefined) {
        this.dispatch('rejected', { transport, remote, ...(caller !== undefined ? { caller } : {}), reason: refusal });
      } else if (this.closed) {
        this.dispatch('rejected', { transport, remote, ...(caller !== undefined ? { caller } : {}), reason: 'the listener closed' });
      } else {
        const error = toNetconfError(err, controller.signal);
        this.logger.debug?.(`Call home from ${remote.address}:${remote.port} failed: ${error.message}`);
        this.dispatch('failed', { transport, remote, ...(caller !== undefined ? { caller } : {}), error });
      }
    } finally {
      clearTimeout(timer);
      this.pending.delete(controller);
    }
  }

  private factory(
    transport: CallHomeTransport,
    socket: Socket,
    remote: CallHomeRemote,
    decide: (who: CallHomeCaller) => Promise<CallHomeDevice<E> | undefined>,
  ): ConnectionFactory {
    if (transport === 'ssh') {
      const ssh = this.options.ssh!;
      return callHomeSsh({
        sock: socket,
        host: remote.address,
        port: remote.port,
        ...(ssh.algorithms !== undefined ? { algorithms: ssh.algorithms } : {}),
        ...(ssh.keepaliveInterval !== undefined ? { keepaliveInterval: ssh.keepaliveInterval } : {}),
        logger: this.logger,
        identify: async (info) => {
          const keyType = sshKeyType(info.key);
          const d = await decide({ transport, fingerprint: info.fingerprint, key: info.key, ...(keyType !== undefined ? { keyType } : {}), remote });
          if (d === undefined) return undefined;
          return {
            username: d.username!,
            ...(d.password !== undefined ? { password: d.password } : {}),
            ...(d.privateKey !== undefined ? { privateKey: d.privateKey } : {}),
            ...(d.passphrase !== undefined ? { passphrase: d.passphrase } : {}),
            ...(d.agent !== undefined ? { agent: d.agent } : {}),
            ...(d.keyboardInteractive !== undefined ? { keyboardInteractive: d.keyboardInteractive } : {}),
          };
        },
      });
    }
    const tls = this.options.tls!;
    return callHomeTls({
      sock: socket,
      host: remote.address,
      port: remote.port,
      cert: tls.cert,
      key: tls.key,
      ...(tls.passphrase !== undefined ? { passphrase: tls.passphrase } : {}),
      ...(tls.ca !== undefined ? { ca: tls.ca } : {}),
      ...(tls.ciphers !== undefined ? { ciphers: tls.ciphers } : {}),
      logger: this.logger,
      identify: async (der, fingerprint) => (await decide({ transport, fingerprint, certificate: certificateOf(der), remote })) !== undefined,
    });
  }

  private deliver(call: CallHomeCall<E>, transport: CallHomeTransport, remote: CallHomeRemote): void {
    if (this.closed) {
      void call.client.close();
      this.dispatch('rejected', { transport, remote, caller: call.caller, reason: 'the listener closed' });
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: call, done: false });
      return;
    }
    if (this.queue.length >= this.maxQueued) {
      void call.client.close();
      this.dispatch('rejected', { transport, remote, caller: call.caller, reason: `too many clients waiting to be taken (maxQueued ${this.maxQueued})` });
      return;
    }
    this.queue.push(call);
  }
}

function positive(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`listenCallHome: ${name} must be a positive integer`);
  return value;
}

function toNetconfError(err: unknown, signal: AbortSignal): NetconfError {
  if (signal.aborted && signal.reason instanceof NetconfError) return signal.reason;
  if (err instanceof NetconfError) return err;
  return new TransportError('Call home failed', { cause: err });
}

/**
 * Listen for devices calling home (RFC 8071). Resolves once listening on every
 * transport given; rejects with a TransportError if a port can't be bound.
 */
export async function listenCallHome<const E extends readonly Extension[] = []>(options: CallHomeOptions<E>): Promise<CallHomeListener<E>> {
  if (typeof options !== 'object' || options === null) throw new TypeError('listenCallHome needs options');
  if (typeof options.identify !== 'function') throw new TypeError('listenCallHome: identify is required (RFC 8071 identifies a device by its key or certificate)');
  if (options.ssh === undefined && options.tls === undefined) throw new TypeError('listenCallHome: give ssh, tls or both');
  if (options.tls !== undefined && (options.tls.cert === undefined || options.tls.key === undefined)) {
    throw new TypeError('listenCallHome: tls needs cert and key (RFC 7589 is mutual TLS)');
  }
  const listener = new CallHomeListener<E>(options);
  await listener._listen();
  return listener;
}
