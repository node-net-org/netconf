/**
 * The NETCONF session (design §5.4): the messages layer of RFC 6241.
 *
 * Hello and version negotiation, the capability set, message-id correlation
 * and pipelining, `<rpc-error>` decoding, notification routing, timeouts and
 * lifecycle. A Session knows nothing about datastores, paths or vendors; the
 * layers above use it through its RpcContext surface.
 */

import { AbortError, SessionClosedError, TimeoutError, type NetconfError } from '../errors.js';
import { LogSwitch, redactXml, type Logger, type LogLevel } from '../logger.js';
import { checkTimeout, startTimer } from '../timers.js';
import { openChannel, type Connection, type ConnectionPeer, type MessageChannel } from '../transport/index.js';
import { parseXml, serializeXml, x, type XmlElement, type XmlParseLimits } from '../xml/index.js';
import { CapabilitySet } from './capabilities.js';
import { BASE_1_1, NETCONF_NS, NOTIFICATION_NS, type BaseVersion } from './constants.js';
import { TypedEmitter } from './emitter.js';
import { buildClientHello, DEFAULT_CLIENT_CAPABILITIES, negotiateBaseVersion, parseServerHello, type ServerHello } from './hello.js';
import { stripInvalidXmlChars, stripPaddedEmptyElements, type SessionQuirks } from './quirks.js';
import { parseRpcErrors, RpcError, type RpcErrorDetail } from './rpc-error.js';

// --- public types ------------------------------------------------------------

/**
 * Timeouts in milliseconds. `Infinity` means no limit. Values above
 * 2,147,483,647 (about 24.8 days, the longest timer the platform has) are
 * shortened to it. A value that is not a number throws a `TypeError`, and
 * zero, a negative number or NaN a `RangeError`, before anything is sent.
 */
export interface SessionTimeouts {
  /** Receiving the server's hello once the connection is open. Default 30 s. */
  readonly hello?: number;
  /** Each RPC, unless overridden per call. Default 60 s. */
  readonly rpc?: number;
  /** Waiting for the reply to `<close-session>` before closing anyway. Default 5 s. */
  readonly close?: number;
}

/** The session's default {@link SessionTimeouts}, in ms. */
export const DEFAULT_SESSION_TIMEOUTS = Object.freeze({
  /** Receiving the server's hello: 30 s. */
  hello: 30_000,
  /** Each RPC: 60 s. */
  rpc: 60_000,
  /** Waiting for the reply to `<close-session>`: 5 s. */
  close: 5_000,
});

/** What a Session's hello hook may change, once the server's hello has arrived. */
export interface HelloAdjustments {
  /** The capabilities to use instead of the advertised ones (for capability checks and paths). */
  readonly capabilities?: CapabilitySet;
  /** Quirks chosen after the hello. `forceBaseVersion` can't apply this late and is ignored. */
  readonly quirks?: SessionQuirks;
}

/** Options for {@link openSession}. */
export interface SessionOptions {
  /** Capabilities to advertise in addition to base:1.0 and base:1.1. */
  readonly capabilities?: readonly string[];
  /** Hello, RPC and close timeouts. Defaults: {@link DEFAULT_SESSION_TIMEOUTS}. */
  readonly timeouts?: SessionTimeouts;
  /** Most RPCs awaiting a reply at once; later ones queue. Default 32, or the `maxInFlight` quirk. */
  readonly maxInFlight?: number;
  /** Largest message accepted from the server, in bytes; see `DecoderOptions.maxMessageBytes`. Default 64 MiB. */
  readonly maxMessageBytes?: number;
  /** Depth and node limits for every message received, checked before it is parsed. */
  readonly parseLimits?: XmlParseLimits;
  /** Where the session logs. Default: no logging. See [Logging and tracing](/guide/logging). */
  readonly logger?: Logger;
  /** Least severe level passed to the logger. Default `'trace'`: everything. */
  readonly logLevel?: LogLevel;
  /** Applied to message bodies before trace logging and the `message` event. Default: mask password-like elements. */
  readonly redact?: (xml: string) => string;
  /** Aborts the hello exchange. */
  readonly signal?: AbortSignal;
  /** Quirks known before the hello. Explicit options above take precedence. */
  readonly quirks?: SessionQuirks;
  /**
   * Called synchronously with the server's hello, before the session opens
   * and before any later message is handled. If it throws, the session fails.
   */
  readonly onHello?: (hello: ServerHello) => HelloAdjustments | undefined;
}

/** Per-call options for {@link Session.rpc}. */
export interface RpcOptions {
  /**
   * Milliseconds to wait for the reply. Default: the session's `timeouts.rpc`.
   * `Infinity` waits with no limit, and values above 2,147,483,647 are
   * shortened to it. A value that is not a number rejects with a
   * `TypeError`, and zero, a negative number or NaN with a `RangeError`,
   * before anything is sent.
   */
  readonly timeout?: number;
  /**
   * Stop waiting for the reply. NETCONF has no way to cancel an RPC, so the
   * server still processes it; its reply is discarded when it arrives.
   */
  readonly signal?: AbortSignal;
}

/** A successful `<rpc-reply>`. */
export interface RpcReply {
  /** The `message-id` of the request this reply answers. */
  readonly messageId: string;
  /** The whole `<rpc-reply>` element. */
  readonly element: XmlElement;
  /** True if the reply is `<ok/>`. */
  readonly ok: boolean;
  /** The `<data>` element, if the reply has one. */
  readonly data: XmlElement | undefined;
  /**
   * The operation's output parameters: every child element of the reply
   * except `<ok>` and `<rpc-error>`, in order (RFC 7950 §7.14.4, §7.15.3).
   * An RPC's or action's output is read here; `<get>`'s is `[<data>]`.
   * Empty for an `<ok/>` reply.
   */
  readonly output: readonly XmlElement[];
  /** `<rpc-error>`s with severity `warning`. (Severity `error` rejects with RpcError instead.) */
  readonly warnings: readonly RpcErrorDetail[];
}

/** An RFC 5277 `<notification>`. */
export interface Notification {
  /** The `eventTime` value, as sent (RFC 3339 date-and-time). */
  readonly eventTime: string;
  /** The event content: the first child element after `eventTime`. */
  readonly event: XmlElement | undefined;
  /** The whole `<notification>` element. */
  readonly element: XmlElement;
}

/** Payload of the session's `warning` event. */
export interface SessionWarning {
  /** What happened, for people. */
  readonly message: string;
  /** Set when the warning is an `<rpc-error>` of severity `warning`. */
  readonly rpcError?: RpcErrorDetail;
  /** The error behind the warning, if there is one. */
  readonly cause?: unknown;
}

/**
 * The events a {@link Session} emits, by name, with each one's payload.
 * Listen with `session.on(name, listener)`. See [Events](/guide/messages#events).
 */
export interface SessionEvents extends Record<string, unknown> {
  /** close() was called; `<close-session>` is being sent. */
  closing: {
    /** Always `'user'`: close() was called. */
    readonly reason: 'user';
  };
  /** The session is closed. Emitted exactly once. `cause` is set if it closed because something failed. */
  closed: {
    /** Why the session closed, if it closed because something failed. */
    readonly cause?: NetconfError;
  };
  /** A `<notification>` arrived from the server. */
  notification: Notification;
  /** Something odd that didn't stop the session: an rpc-error warning, an unmatched reply, a stray message. */
  warning: SessionWarning;
  /** A NETCONF message was sent or received. `xml` has been through the session's `redact`. */
  message: SessionMessage;
}

/** Payload of the session's `message` event. */
export interface SessionMessage {
  /** `'send'` for a message to the server, `'receive'` for one from it. */
  readonly direction: 'send' | 'receive';
  /** The message text, redacted. */
  readonly xml: string;
}

/**
 * Where a session is in its life: `'open'` (ready for RPCs), `'closing'`
 * (close() was called and `<close-session>` is under way) or `'closed'`.
 */
export type SessionState = 'open' | 'closing' | 'closed';

/**
 * The extension seam (design §6): everything an operation, extension or
 * device profile may use. No connection, no framing, no session internals.
 */
export interface RpcContext {
  /**
   * Send an operation (the content of `<rpc>`, as an element or XML text) and
   * wait for its reply. Rejects with RpcError if the reply has an
   * error-severity `<rpc-error>`.
   */
  rpc(operation: XmlElement | string, options?: RpcOptions): Promise<RpcReply>;
  /** The server's capabilities, after any corrections from the device profile. */
  readonly serverCapabilities: CapabilitySet;
  /** The session-id the server assigned. */
  readonly sessionId: number;
  /** The session's logger. Only enabled levels have a method, so call it as `logger.debug?.(…)`. */
  readonly logger: Logger;
  /** Call `listener` for every `<notification>` the session receives. Returns a function that stops it. */
  onNotification(listener: (notification: Notification) => void): () => void;
  /** Call `listener` once when the session closes. Returns a function that stops it. */
  onClosed(listener: (event: SessionEvents['closed']) => void): () => void;
  /**
   * Check every operation before rpc() sends it. A guard refuses by throwing;
   * rpc() then rejects with that error and sends nothing. `<close-session>`
   * from close() is never guarded. Returns a function that removes the guard.
   */
  addRpcGuard(guard: RpcGuard): () => void;
}

/** See {@link RpcContext.addRpcGuard}. */
export type RpcGuard = (operation: XmlElement) => void;

// --- diagnostics ---------------------------------------------------------------

/**
 * `node:diagnostics_channel` channel for RPC timing and outcomes. Messages:
 * `{ phase: 'start' | 'end' | 'error', sessionId, messageId, operation, durationMs?, error? }`.
 * Costs nothing when nobody subscribes.
 */
export const RPC_CHANNEL = '@node-net/netconf:rpc';
const rpcChannel = diagnosticsChannel(RPC_CHANNEL);

interface DiagnosticsChannel {
  readonly hasSubscribers: boolean;
  publish(message: unknown): void;
}

/**
 * The named diagnostics channel, looked up at run time so the session needs
 * no Node.js import: Node (≥ 22.3), Deno and Bun offer
 * process.getBuiltinModule(); elsewhere there are no subscribers to tell.
 */
function diagnosticsChannel(name: string): DiagnosticsChannel {
  const host = globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } };
  const dc = host.process?.getBuiltinModule?.('node:diagnostics_channel') as { channel(name: string): DiagnosticsChannel } | undefined;
  return dc?.channel(name) ?? { hasSubscribers: false, publish: () => undefined };
}

// --- opening -----------------------------------------------------------------------

/**
 * Start a NETCONF session on an open connection: frame it, exchange hellos,
 * and agree the base version. Resolves once the session is ready for RPCs.
 * If the hello fails, the connection is closed before this rejects.
 */
export function openSession(connection: Connection, options: SessionOptions = {}): Promise<Session> {
  return open(connection, options, undefined);
}

/**
 * The switch behind each session's logger, which the client changes. Kept
 * here rather than on the Session, so it is in no public type.
 */
const logSwitches = new WeakMap<Session, LogSwitch>();

/**
 * @internal openSession() for a NetconfClient: the session logs through the client's
 * switch (`logger` and `logLevel` in `options` are then ignored). Not part of
 * the public API.
 */
export function openClientSession(connection: Connection, options: SessionOptions, logSwitch: LogSwitch): Promise<Session> {
  return open(connection, options, logSwitch);
}

/** @internal The switch behind a session's logger. Not part of the public API. */
export function logSwitchOf(session: Session): LogSwitch {
  return logSwitches.get(session)!;
}

async function open(connection: Connection, options: SessionOptions, logSwitch: LogSwitch | undefined): Promise<Session> {
  let session: Session;
  try {
    session = new Session(connection, options, logSwitch);
  } catch (err) {
    // Invalid options (such as an unknown logLevel): don't leak the connection.
    await connection.close().catch(() => undefined);
    throw err;
  }
  await session._start(options.signal);
  return session;
}

// --- Session ---------------------------------------------------------------------

interface Pending {
  readonly id: string;
  readonly operation: string;
  readonly started: number;
  resolve(reply: RpcReply): void;
  reject(err: Error): void;
  /** Write the request. Called immediately, or later if maxInFlight was reached. */
  send(): void;
}

const MAX_ABANDONED = 1024;

/**
 * A NETCONF session on one connection (RFC 6241 messages layer): it sends
 * RPCs, matches replies and routes notifications. Open one with
 * {@link openSession}; a client from connect() has one inside it. See
 * [Messages](/guide/messages).
 */
export class Session extends TypedEmitter<SessionEvents> implements RpcContext, AsyncDisposable {
  private _state: 'hello' | SessionState = 'hello';
  private _sessionId = 0;
  private _serverCapabilities = new CapabilitySet([]);
  private _advertisedCapabilities = new CapabilitySet([]);
  private _baseVersion: BaseVersion = '1.0';
  /** Capabilities we advertised. */
  readonly clientCapabilities: CapabilitySet;
  /** The server end of the connection, for logging; the client reports it as `client.transport.peer`. */
  private readonly peer: ConnectionPeer;
  /**
   * The session's logger: one object whose methods follow the client's
   * logger and log level as they change. Only enabled levels have a method.
   */
  readonly logger: Logger;

  private readonly channel: MessageChannel;
  private nextMessageId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly queue: Pending[] = [];
  private inFlight = 0;
  /** message-ids we stopped waiting for (timeout/abort), so their late replies are expected. */
  private readonly abandoned = new Set<string>();
  private helloWaiter: { resolve(): void; reject(err: Error): void } | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly rpcGuards = new Set<RpcGuard>();
  private closedEmitted = false;

  private readonly timeouts: { readonly hello: number | undefined; readonly rpc: number | undefined };
  private maxInFlight: number;
  private closeTimeout: number | undefined;
  private replyWithoutMessageId: NonNullable<SessionQuirks['replyWithoutMessageId']>;
  private invalidXmlChars: NonNullable<SessionQuirks['invalidXmlChars']>;
  private paddedEmptyElements: NonNullable<SessionQuirks['paddedEmptyElements']>;
  private readonly explicitMaxInFlight: number | undefined;
  private readonly explicitCloseTimeout: boolean;
  private readonly onHello: SessionOptions['onHello'];
  private readonly parseLimits: XmlParseLimits;
  private readonly redact: (xml: string) => string;

  /** @internal Use {@link openSession}, or connect() for a NetconfClient. */
  constructor(connection: Connection, options: SessionOptions = {}, shared?: LogSwitch) {
    const logSwitch = shared ?? new LogSwitch(options.logger, options.logLevel);
    super(logSwitch.logger);
    logSwitches.set(this, logSwitch);
    this.logger = logSwitch.logger;
    this.peer = connection.peer;
    this.timeouts = sessionTimeouts(options.timeouts);
    const quirks = options.quirks ?? {};
    let ourCaps = [...DEFAULT_CLIENT_CAPABILITIES, ...(options.capabilities ?? [])];
    if (quirks.forceBaseVersion === '1.0') ourCaps = ourCaps.filter((c) => c !== BASE_1_1);
    this.clientCapabilities = new CapabilitySet(ourCaps);
    this.explicitMaxInFlight = options.maxInFlight;
    this.explicitCloseTimeout = options.timeouts?.close !== undefined;
    this.maxInFlight = 32;
    this.closeTimeout = checkTimeout(options.timeouts?.close ?? DEFAULT_SESSION_TIMEOUTS.close, 'timeouts.close');
    this.replyWithoutMessageId = 'strict';
    this.invalidXmlChars = 'reject';
    this.paddedEmptyElements = 'keep';
    this.applyQuirks(quirks);
    this.onHello = options.onHello;
    this.parseLimits = options.parseLimits ?? {};
    this.redact = options.redact ?? redactXml;

    this.channel = openChannel(
      connection,
      { message: (text) => this.onMessage(text), end: (reason) => this.fail(reason) },
      options.maxMessageBytes !== undefined ? { maxMessageBytes: options.maxMessageBytes } : {},
    );
  }

  /** Where the session is in its life: open, closing or closed. */
  get state(): SessionState {
    return this._state === 'hello' ? 'closed' : this._state;
  }

  /** The session-id the server assigned. */
  get sessionId(): number {
    return this._sessionId;
  }

  /**
   * The server's capabilities, after any corrections from the hello hook (the
   * device profile). Capability checks use these.
   */
  get serverCapabilities(): CapabilitySet {
    return this._serverCapabilities;
  }

  /** The capabilities exactly as the server advertised them in its hello. */
  get advertisedCapabilities(): CapabilitySet {
    return this._advertisedCapabilities;
  }

  /** The NETCONF base version in use: 1.1 (chunked framing) or 1.0 (EOM framing). */
  get baseVersion(): BaseVersion {
    return this._baseVersion;
  }

  /** @internal Exchange hellos. Called once by openSession(). */
  async _start(signal: AbortSignal | undefined): Promise<void> {
    const helloTimeout = this.timeouts.hello;
    const hello = new Promise<void>((resolve, reject) => (this.helloWaiter = { resolve, reject }));
    const timer = startTimer(() => this.fail(new TimeoutError('hello', helloTimeout ?? Infinity)), helloTimeout);
    const onAbort = (): void => this.fail(new AbortError('Connect aborted', { cause: signal?.reason }));
    if (signal?.aborted === true) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      this.write(serializeXml(buildClientHello(this.clientCapabilities.toArray()), { declaration: true }));
      await hello;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // --- RPCs ----------------------------------------------------------------------

  /**
   * Send any operation and wait for its reply.
   *
   * @param operation The operation element (the content of `<rpc>`), or its
   *   XML text. Text is parsed first, so malformed XML is rejected locally.
   *   An element without a namespace is sent in the NETCONF base namespace.
   * @throws RpcError if the reply contains an error-severity `<rpc-error>`.
   * @throws TimeoutError, AbortError, SessionClosedError.
   */
  async rpc(operation: XmlElement | string, options: RpcOptions = {}): Promise<RpcReply> {
    // Text is read as if it sat inside <rpc>, so unqualified elements are in the NETCONF namespace.
    const el =
      typeof operation === 'string'
        ? parseXml(operation, { ...this.parseLimits, defaultNamespace: NETCONF_NS })
        : operation;
    if (el.name === 'rpc' && el.ns === NETCONF_NS) {
      throw new TypeError('Pass the operation inside <rpc>, not the <rpc> element itself');
    }
    for (const guard of [...this.rpcGuards]) guard(el);
    return this.request(el, options, false);
  }

  onNotification(listener: (notification: Notification) => void): () => void {
    return this.on('notification', listener);
  }

  onClosed(listener: (event: SessionEvents['closed']) => void): () => void {
    return this.once('closed', listener);
  }

  addRpcGuard(guard: RpcGuard): () => void {
    const own = (operation: XmlElement): void => guard(operation);
    this.rpcGuards.add(own);
    return () => {
      this.rpcGuards.delete(own);
    };
  }

  // --- closing ---------------------------------------------------------------------

  /**
   * Close the session: send `<close-session>`, wait briefly for the reply,
   * then close the connection. Idempotent, and never rejects.
   */
  close(): Promise<void> {
    this.closePromise ??= this.doClose();
    return this.closePromise;
  }

  /** Close the session, for `await using`. Same as {@link Session.close}. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private async doClose(): Promise<void> {
    if (this._state === 'open') {
      this._state = 'closing';
      this.dispatch('closing', { reason: 'user' });
      try {
        // RFC 6241 §7.8. Part of the session lifecycle, so built here rather than in operations/.
        await this.request(x('close-session', { xmlns: NETCONF_NS }), { timeout: this.closeTimeout ?? Infinity }, true);
      } catch (err) {
        this.logger.debug?.('close-session did not complete cleanly', { err });
      }
    }
    this.shutdown(undefined);
    await this.channel.close();
  }

  // --- internals ---------------------------------------------------------------------

  private applyQuirks(quirks: SessionQuirks): void {
    if (this.explicitMaxInFlight === undefined && quirks.maxInFlight !== undefined) this.maxInFlight = quirks.maxInFlight;
    if (this.explicitMaxInFlight !== undefined) this.maxInFlight = this.explicitMaxInFlight;
    this.maxInFlight = Math.max(1, this.maxInFlight);
    if (!this.explicitCloseTimeout && quirks.closeTimeout !== undefined) {
      this.closeTimeout = checkTimeout(quirks.closeTimeout, 'the closeTimeout quirk');
    }
    if (quirks.replyWithoutMessageId !== undefined) this.replyWithoutMessageId = quirks.replyWithoutMessageId;
    if (quirks.invalidXmlChars !== undefined) this.invalidXmlChars = quirks.invalidXmlChars;
    if (quirks.paddedEmptyElements !== undefined) this.paddedEmptyElements = quirks.paddedEmptyElements;
  }

  private request(operation: XmlElement, options: RpcOptions, internal: boolean): Promise<RpcReply> {
    const usable = this._state === 'open' || (internal && this._state === 'closing');
    if (!usable) return Promise.reject(new SessionClosedError('The session is closed'));
    if (options.signal?.aborted === true) {
      return Promise.reject(new AbortError('RPC aborted', { cause: options.signal.reason }));
    }

    const id = String(this.nextMessageId++);
    let text: string;
    let framed: Uint8Array;
    try {
      text = serializeXml(x('rpc', { xmlns: NETCONF_NS, 'message-id': id }, operation), { declaration: true });
      framed = this.channel.encode(text);
    } catch (err) {
      // XmlError (invalid names or characters) or FramingError: nothing was sent.
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }

    let timeoutMs: number | undefined;
    try {
      timeoutMs = options.timeout === undefined ? this.timeouts.rpc : checkTimeout(options.timeout, 'timeout');
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const signal = options.signal;
    return new Promise<RpcReply>((resolve, reject) => {
      let sent = false;
      let settled = false;
      const finish = (): void => {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        const q = this.queue.indexOf(pending);
        if (q !== -1) this.queue.splice(q, 1);
        if (sent) this.release();
      };
      const giveUp = (err: Error): void => {
        if (settled) return;
        if (sent) this.abandon(id);
        finish();
        this.publish('error', pending, err);
        reject(err);
      };
      const timer = startTimer(() => giveUp(new TimeoutError('rpc', timeoutMs ?? Infinity)), timeoutMs);
      const onAbort = (): void => giveUp(new AbortError('RPC aborted', { cause: signal?.reason }));
      signal?.addEventListener('abort', onAbort, { once: true });

      const pending: Pending = {
        id,
        operation: operation.name,
        started: performance.now(),
        resolve: (reply) => {
          if (settled) return;
          finish();
          this.publish('end', pending);
          resolve(reply);
        },
        reject: (err) => {
          if (settled) return;
          finish();
          this.publish('error', pending, err);
          reject(err);
        },
        send: () => {
          sent = true;
          this.inFlight++;
          this.publish('start', pending);
          this.write(text, framed);
        },
      };
      this.pending.set(id, pending);
      if (internal || this.inFlight < this.maxInFlight) pending.send();
      else this.queue.push(pending);
    });
  }

  private release(): void {
    this.inFlight--;
    const next = this.queue.shift();
    if (next !== undefined && this._state !== 'closed') next.send();
  }

  private abandon(id: string): void {
    this.abandoned.add(id);
    if (this.abandoned.size > MAX_ABANDONED) {
      const oldest = this.abandoned.values().next().value;
      if (oldest !== undefined) this.abandoned.delete(oldest);
    }
  }

  private write(text: string, framed?: Uint8Array): void {
    this.observe('send', text);
    this.channel.write(framed ?? this.channel.encode(text));
  }

  /** Trace a message and emit it as a `message` event, redacting it once, and only if someone receives it. */
  private observe(direction: SessionMessage['direction'], text: string): void {
    const tracing = this.logger.trace !== undefined;
    const listening = this.listenerCount('message') > 0;
    if (!tracing && !listening) return;
    const xml = this.redact(text);
    if (tracing) this.logger.trace?.(direction, { xml });
    if (listening) this.dispatch('message', { direction, xml });
  }

  private onMessage(received: string): void {
    if (this._state === 'closed') return;
    let text = received;
    if (this.invalidXmlChars === 'strip') {
      const stripped = stripInvalidXmlChars(received);
      if (stripped.removed > 0) {
        text = stripped.text;
        this.logger.debug?.('Removed characters XML does not allow from a received message', { removed: stripped.removed });
      }
    }
    this.observe('receive', text);
    let el = parseXml(text, this.parseLimits);
    if (this.paddedEmptyElements === 'strip') {
      const stripped = stripPaddedEmptyElements(el);
      if (stripped.emptied > 0) {
        el = stripped.element;
        this.logger.debug?.('Emptied elements whose only content was line-break padding', { emptied: stripped.emptied });
      }
    }

    if (this._state === 'hello') {
      this.onServerHello(parseServerHello(el));
      return;
    }

    if (el.name === 'rpc-reply' && el.ns === NETCONF_NS) this.onReply(el);
    else if (el.name === 'notification' && el.ns === NOTIFICATION_NS) this.handleNotification(el);
    else this.warn(`Ignoring an unexpected <${el.name}> message`);
  }

  private onServerHello(hello: ServerHello): void {
    this._baseVersion = negotiateBaseVersion(this.clientCapabilities, hello.capabilities);
    this._sessionId = hello.sessionId;
    this._advertisedCapabilities = hello.capabilities;
    this._serverCapabilities = hello.capabilities;

    const adjust = this.onHello?.(hello);
    if (adjust?.capabilities !== undefined) this._serverCapabilities = adjust.capabilities;
    if (adjust?.quirks !== undefined) this.applyQuirks(adjust.quirks);

    // Exactly between messages: everything after the server's hello is chunked.
    if (this._baseVersion === '1.1') this.channel.useChunkedFraming();
    this._state = 'open';
    this.logger.debug?.('NETCONF session open', {
      sessionId: this._sessionId,
      baseVersion: this._baseVersion,
      peer: this.peer,
    });
    this.helloWaiter?.resolve();
    this.helloWaiter = undefined;
  }

  private onReply(el: XmlElement): void {
    const id = el.attr('message-id');
    const errors = parseRpcErrors(el);
    let pending: Pending | undefined;

    if (id === undefined) {
      // RFC 6241 §4.1: a server may omit message-id when it couldn't parse the
      // request (malformed-message). Attribute it only if there is no ambiguity.
      if (this.replyWithoutMessageId === 'oldest' || (errors.length > 0 && this.pending.size === 1)) {
        pending = this.pending.values().next().value;
      }
      if (pending === undefined) {
        this.warn('Received an <rpc-reply> without a message-id that cannot be matched', undefined, errors[0]);
        return;
      }
    } else {
      pending = this.pending.get(id);
      if (pending === undefined) {
        if (this.abandoned.delete(id)) {
          this.logger.debug?.('Dropped a late reply to an abandoned RPC', { messageId: id });
        } else {
          this.warn(`Received an <rpc-reply> for unknown message-id ${JSON.stringify(id)}`);
        }
        return;
      }
    }

    const warnings = errors.filter((e) => e.severity === 'warning');
    for (const w of warnings) this.warn(`rpc-error warning: ${w.tag}${w.message ? `: ${w.message}` : ''}`, undefined, w);

    if (errors.some((e) => e.severity === 'error')) {
      pending.reject(new RpcError(errors, el));
      return;
    }
    pending.resolve({
      messageId: pending.id,
      element: el,
      ok: el.child('ok', NETCONF_NS) !== undefined,
      data: el.child('data', NETCONF_NS),
      output: Object.freeze(el.elements.filter((c) => c.ns !== NETCONF_NS || (c.name !== 'ok' && c.name !== 'rpc-error'))),
      warnings,
    });
  }

  private handleNotification(el: XmlElement): void {
    const event = el.elements.find((c) => !(c.name === 'eventTime' && c.ns === NOTIFICATION_NS));
    this.dispatch('notification', {
      eventTime: el.child('eventTime', NOTIFICATION_NS)?.text().trim() ?? '',
      event,
      element: el,
    });
  }

  /**
   * Report something odd that didn't stop the session: log it as a warning
   * and emit a `warning` event. Used by the layers above, such as JSON output
   * falling back to a schema-less conversion.
   */
  warn(message: string, cause?: unknown, rpcError?: RpcErrorDetail): void {
    this.logger.warn?.(message);
    this.dispatch('warning', {
      message,
      ...(cause !== undefined ? { cause } : {}),
      ...(rpcError !== undefined ? { rpcError } : {}),
    });
  }

  /** Something broke: close everything and tell everyone why. */
  private fail(reason: NetconfError): void {
    if (this._state === 'closed') return;
    if (this._state === 'closing') {
      // The server hanging up after <close-session> is the normal ending.
      this.shutdown(undefined);
      return;
    }
    this.logger.debug?.('NETCONF session failed', { reason: reason.message });
    this.helloWaiter?.reject(reason);
    this.helloWaiter = undefined;
    this.shutdown(reason);
    void this.channel.close();
  }

  private shutdown(cause: NetconfError | undefined): void {
    if (this._state === 'closed') return;
    this._state = 'closed';
    const err =
      cause instanceof SessionClosedError
        ? cause
        : new SessionClosedError(cause ? `Session closed: ${cause.message}` : 'The session is closed', cause ? { cause } : undefined);
    for (const p of [...this.pending.values()]) p.reject(err);
    this.queue.length = 0;
    this.channel.destroy();
    if (!this.closedEmitted) {
      this.closedEmitted = true;
      this.dispatch('closed', cause ? { cause } : {});
    }
  }

  private publish(phase: 'start' | 'end' | 'error', p: Pending, error?: Error): void {
    if (!rpcChannel.hasSubscribers) return;
    rpcChannel.publish({
      phase,
      sessionId: this._sessionId,
      messageId: p.id,
      operation: p.operation,
      ...(phase === 'start' ? {} : { durationMs: performance.now() - p.started }),
      ...(error !== undefined ? { error } : {}),
    });
  }
}

/** The hello and rpc timeouts to use, checked: `undefined` means no timer. */
function sessionTimeouts(given: SessionTimeouts | undefined): { hello: number | undefined; rpc: number | undefined } {
  return {
    hello: checkTimeout(given?.hello ?? DEFAULT_SESSION_TIMEOUTS.hello, 'timeouts.hello'),
    rpc: checkTimeout(given?.rpc ?? DEFAULT_SESSION_TIMEOUTS.rpc, 'timeouts.rpc'),
  };
}
