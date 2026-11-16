/**
 * NetconfClient (design §3.1, §5.5): what connect() returns.
 *
 * The client sits above the layer stack and puts it together: it opens a
 * Connection (Transport), starts a Session on it (Messages), and adds the
 * Operations layer (`client.ops`: base operations, extensions' operations, the
 * device profile's own) and the Content layer (`client.content`: the path API,
 * the configure workflow, extensions' decoded readers). Each call sits on the
 * object for the RFC 6241 layer it works at. Nothing below this file imports it.
 */

import { ClientContent, CONTENT_MEMBERS } from './client-content.js';
import { ClientOps, OPS_MEMBERS } from './client-ops.js';
import { ClientYang, type ClientHost, type YangOptions } from './client-yang.js';
import { bindDevice, pickProfile, type AutoDetect, type DeviceProfile } from './devices/index.js';
import { AbortError, CapabilityError, NetconfError, TimeoutError, TransportError } from './errors.js';
import { checkLogLevel, LogSwitch, type Logger, type LogLevel } from './logger.js';
import { Reconnecting, type ReconnectingOptions } from './reconnect.js';
import {
  CapabilitySet,
  DEFAULT_SESSION_TIMEOUTS,
  logSwitchOf,
  openClientSession,
  parseCapability,
  type HelloAdjustments,
  type ServerHello,
  type Session,
  type SessionTimeouts,
} from './messages/index.js';
import {
  BASE_OPERATIONS,
  extensionContext,
  missingRequirement,
  validateExtensions,
  type CapabilityCheck,
  type ContentMap,
  type Extension,
  type OperationDescriptor,
  type ToJson,
  type ToXml,
  type ModuleOf,
  type OpsMap,
} from './operations/index.js';
import { checkTimeout, startTimer, unrefTimer } from './timers.js';
import type { Connection, ConnectionFactory, ConnectionPeer } from './transport/index.js';
import type { XmlParseLimits } from './xml/index.js';
import { ModuleNamespaces } from './module-namespaces.js';

export {
  ClientContent,
  type CompareDatastoresOptions,
  type ConfigureOptions,
  type DatastoreSource,
  type DeclaredFeature,
  type ModulesOptions,
  type ReadOptions,
  type ContentJsonFormat,
  type InvokeInput,
  type InvokeOptions,
  type ContentXmlFormat,
  type ServerDatastore,
  type ServerDatastores,
  type ModuleNamespaceInfo,
  type NamespaceSource,
  type ServerModule,
  type ServerModules,
} from './client-content.js';
export { ClientOps, type DeviceOps } from './client-ops.js';
export type { YangOptions } from './client-yang.js';

// --- public types ------------------------------------------------------------

/**
 * Timeouts in milliseconds. `Infinity` means no limit. Values above
 * 2,147,483,647 (about 24.8 days, the longest timer the platform has) are
 * shortened to it. A value that is not a number makes connect() reject with
 * a `TypeError`, and zero, a negative number or NaN with a `RangeError`,
 * before any connection is attempted.
 */
export interface Timeouts extends SessionTimeouts {
  /** Opening the connection (TCP, SSH or TLS handshake, authentication). Default 30 s. */
  readonly connect?: number;
}

/** The default {@link Timeouts}, in ms: connect and hello 30 s, rpc 60 s, close 5 s. */
export const DEFAULT_TIMEOUTS = Object.freeze({
  /** Opening the connection: 30 s. */
  connect: 30_000,
  ...DEFAULT_SESSION_TIMEOUTS,
});

/**
 * What {@link connect} takes: the transport, plus options that shape the
 * session. Only `transport` is required.
 * See [Session options](/guide/connecting#session-options).
 */
export interface ConnectOptions<E extends readonly Extension[] = readonly Extension[]> {
  /** How to reach the server: a ConnectionFactory such as `ssh({ ... })` or `tls({ ... })`. */
  readonly transport: ConnectionFactory;
  /** Capabilities to advertise in addition to base:1.0 and base:1.1. */
  readonly capabilities?: readonly string[];
  /** Timeouts for connecting, the hello, each RPC and closing, in ms. Defaults: {@link DEFAULT_TIMEOUTS}. */
  readonly timeouts?: Timeouts;
  /** Most RPCs awaiting a reply at once; later ones queue. Default 32. */
  readonly maxInFlight?: number;
  /**
   * Largest message accepted from the server, in bytes of the message itself
   * (not counting chunk headers or the end-of-message delimiter). A larger
   * message is refused as soon as the limit is passed, and closes the session
   * with a `FramingError`. However the message is chunked, the client holds
   * at most about twice this for it while it arrives, plus one copy when it is
   * handed on. Default 64 MiB.
   */
  readonly maxMessageBytes?: number;
  /**
   * Depth and node limits applied to every message received, checked before
   * the message is parsed; see {@link XmlParseLimits} for what they bound. A
   * message over a limit closes the session with an `XmlError`. Default
   * `DEFAULT_PARSE_LIMITS`: depth 256, 1,000,000 nodes.
   */
  readonly parseLimits?: XmlParseLimits;
  /** How operations are checked against the server's capabilities before sending. Default `'strict'`. */
  readonly capabilityCheck?: CapabilityCheck;
  /**
   * How each enabled extension's required capabilities are checked after the
   * hello. Default: the same as `capabilityCheck`. `'off'` enables every
   * module whatever the server advertises, so tools can list them all, while
   * each operation is still checked under `capabilityCheck`.
   */
  readonly extensionCheck?: CapabilityCheck;
  /**
   * Where the client logs: anything with some of `trace`, `debug`, `info`,
   * `warn` and `error` methods, such as `console`. Default: no logging.
   * Change it later with `client.setLogger()`. See [Logging and tracing](/guide/logging).
   */
  readonly logger?: Logger;
  /**
   * Least severe level passed to the logger: `'trace'`, `'debug'`, `'info'`,
   * `'warn'`, `'error'` or `'silent'`. Default `'trace'`: everything the
   * logger has a method for. Change it later with `client.setLogLevel()`.
   */
  readonly logLevel?: LogLevel;
  /** Applied to message bodies before trace logging and the session's `message` event. Default: mask password-like elements. */
  readonly redact?: (xml: string) => string;
  /** Aborts connecting (connection and hello). */
  readonly signal?: AbortSignal;
  /**
   * The device profile to use: a profile, or autoDetect([...]) to choose one
   * from the server's hello. `client.profile` is the profile in use. Quirks
   * that affect the hello (forceBaseVersion) need an explicit profile.
   */
  readonly profile?: DeviceProfile | AutoDetect;
  /**
   * Module name → namespace, for modules the server doesn't advertise or
   * advertises wrongly. Beats the device profile's `namespaces`, which beat
   * the server's hello and YANG library.
   */
  readonly namespaces?: Readonly<Record<string, string>>;
  /**
   * YANG schemas for RFC 7951 JSON output (`format: 'json'` on reads):
   * modules to use before the bundled IETF ones and `<get-schema>`, whether
   * to refuse a schema-less conversion, and a cache to share between clients.
   */
  readonly yang?: YangOptions;
  /**
   * Extensions to enable, such as `withDefaults` from
   * `@node-net/netconf/operations/with-defaults`. Each is reached as
   * `client.ops.<id>` and/or `client.content.<id>`, for the layers it
   * contributes to, and its required capabilities are checked after the hello
   * (`extensionCheck`).
   */
  readonly extensions?: E;
}

// --- connect -------------------------------------------------------------------

/**
 * Connect to a NETCONF server: open the connection, start the NETCONF session
 * (hello, framing), and apply the device profile. Resolves once the client is
 * ready for RPCs.
 */
export function connect<const E extends readonly Extension[] = []>(
  options: ConnectOptions<E>,
): Promise<NetconfClient<OpsMap<E>, ContentMap<E>>> {
  return openClient(options, {});
}

/**
 * @internal connect() with what the runtime offers: the Node entry passes a
 * way to read YANG module directories, @node-net/netconf/core passes nothing.
 */
export async function openClient<const E extends readonly Extension[] = []>(
  options: ConnectOptions<E>,
  host: ClientHost,
): Promise<NetconfClient<OpsMap<E>, ContentMap<E>>> {
  const modules = options.yang?.modules;
  if ((typeof modules === 'string' || Array.isArray(modules)) && host.directories === undefined) {
    throw new TypeError(NO_DIRECTORIES);
  }
  // The session gets only the timeouts the caller set, and fills in its own
  // defaults: a default passed on would count as the caller's and override a
  // profile's closeTimeout quirk.
  const { connect: connectTimeout = DEFAULT_TIMEOUTS.connect, ...sessionTimeouts } = options.timeouts ?? {};
  // One switch for the client's whole life: everything logs through its
  // logger, so setLogger() and setLogLevel() reach everything at once.
  const logSwitch = new LogSwitch(options.logger, options.logLevel ?? 'trace');
  const logger = logSwitch.logger;
  const extensions: readonly Extension[] = options.extensions ?? [];
  validateExtensions(extensions, BASE_PARAMS, RESERVED);
  const ourCapabilities = [
    ...(options.capabilities ?? []),
    ...extensions.flatMap((e) => e.clientCapabilities ?? []),
  ];

  // Checked here so a bad value fails before anything is opened; the session checks its own again.
  const connectMs = checkTimeout(connectTimeout, 'timeouts.connect');
  for (const name of ['hello', 'rpc', 'close'] as const) {
    const value = sessionTimeouts[name];
    if (value !== undefined) checkTimeout(value, `timeouts.${name}`);
  }
  const connectTimer = new AbortController();
  const timer = startTimer(() => connectTimer.abort(), connectMs);
  unrefTimer(timer);
  const signal = options.signal ? AbortSignal.any([options.signal, connectTimer.signal]) : connectTimer.signal;
  const abortReason = (): NetconfError =>
    options.signal?.aborted === true
      ? new AbortError('Connect aborted', { cause: options.signal.reason })
      : new TimeoutError('connect', connectMs ?? Infinity);

  let connection: Connection;
  try {
    if (options.signal?.aborted === true) throw abortReason();
    connection = await raceAbort(options.transport(signal), signal);
  } catch (err) {
    if (signal.aborted) throw abortReason();
    throw err instanceof NetconfError ? err : new TransportError('Could not open the connection', { cause: err });
  } finally {
    clearTimeout(timer);
  }

  // An explicit profile is known before the hello; autoDetect picks one from it.
  const choice = options.profile;
  let profile = choice !== undefined && !('autoDetect' in choice) ? choice : undefined;
  const onHello = (hello: ServerHello): HelloAdjustments => {
    let quirks;
    if (choice !== undefined && 'autoDetect' in choice) {
      profile = pickProfile(choice, hello);
      quirks = profile?.quirks;
      if (quirks?.forceBaseVersion !== undefined) {
        logger.warn?.(`Profile ${profile!.id} sets forceBaseVersion, which only works with an explicit profile`);
      }
      logger.debug?.('Device profile selected', { profile: profile?.id ?? '(none)' });
      if (profile?.status === 'unverified') {
        logger.warn?.(`Auto-detected device profile ${profile.id} is unverified: it hasn't been tested against a device`, {
          profile: profile.id,
          status: profile.status,
        });
      }
    }
    return {
      capabilities: correctCapabilities(hello.capabilities, profile?.capabilities),
      ...(quirks !== undefined ? { quirks } : {}),
    };
  };

  const session = await openClientSession(connection, {
    timeouts: sessionTimeouts,
    onHello,
    ...(ourCapabilities.length > 0 ? { capabilities: ourCapabilities } : {}),
    ...(options.maxInFlight !== undefined ? { maxInFlight: options.maxInFlight } : {}),
    ...(options.maxMessageBytes !== undefined ? { maxMessageBytes: options.maxMessageBytes } : {}),
    ...(options.parseLimits !== undefined ? { parseLimits: options.parseLimits } : {}),
    ...(options.redact !== undefined ? { redact: options.redact } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(profile?.quirks !== undefined ? { quirks: profile.quirks } : {}),
  }, logSwitch);

  const check = options.extensionCheck ?? options.capabilityCheck ?? 'strict';
  const missing = missingRequirement(extensions, session.serverCapabilities, check, logger);
  if (missing !== undefined) {
    await session.close();
    throw new CapabilityError(missing.capability, `The ${missing.extension} extension`);
  }
  try {
    return new NetconfClient<OpsMap<E>, ContentMap<E>>(session, connection.peer, profile, options, extensions, host);
  } catch (err) {
    // An extension's ops() or content() threw, or a profile operation's name collides: don't leak the session.
    await session.close();
    throw err;
  }
}

const NO_DIRECTORIES =
  'YANG module directories (yang.modules) can only be read through the Node entry, @node-net/netconf; ' +
  'with @node-net/netconf/core, pass the modules as a ModuleSource instead (for example memorySource() from @node-net/yang/core)';

/** Names an extension id can't take, per layer: they would hide a built-in member. */
const RESERVED = { ops: OPS_MEMBERS, content: CONTENT_MEMBERS };

/** Each base operation's parameter names, for spotting conflicting augments. */
const BASE_PARAMS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  BASE_OPERATIONS.map((d) => [d.name, new Set(d.params.map((p) => p.name))]),
);

/**
 * Wait for the connection, but don't depend on the factory honouring the
 * signal: on abort, reject at once, and close the connection if it turns up later.
 */
function raceAbort(opening: Promise<Connection>, signal: AbortSignal): Promise<Connection> {
  return new Promise<Connection>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as Error);
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    opening.then(
      (connection) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) void connection.close().catch(() => undefined);
        else resolve(connection);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Apply a profile's capability corrections to what the server advertised. */
function correctCapabilities(
  advertised: CapabilitySet,
  corrections: DeviceProfile['capabilities'],
): CapabilitySet {
  if (corrections === undefined) return advertised;
  const removed = new Set((corrections.remove ?? []).map((r) => advertised.get(r)?.id ?? parseCapability(r).id));
  return new CapabilitySet([
    ...advertised.toArray().filter((uri) => !removed.has(parseCapability(uri).id)),
    ...(corrections.add ?? []),
  ]);
}

/**
 * Connect, run `fn`, and always close the client afterwards, whether `fn`
 * succeeds or throws.
 */
export function withClient<const E extends readonly Extension[] = [], T = unknown>(
  options: ConnectOptions<E>,
  fn: (client: NetconfClient<OpsMap<E>, ContentMap<E>>) => Promise<T>,
): Promise<T> {
  return withOpenClient(options, {}, fn);
}

/** @internal withClient() with what the runtime offers (see openClient). */
export async function withOpenClient<const E extends readonly Extension[] = [], T = unknown>(
  options: ConnectOptions<E>,
  host: ClientHost,
  fn: (client: NetconfClient<OpsMap<E>, ContentMap<E>>) => Promise<T>,
): Promise<T> {
  const client = await openClient(options, host);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** Options for `reconnecting()`: those of `connect()`, plus how to retry. `signal` stops reconnecting. */
export interface ReconnectOptions<E extends readonly Extension[] = readonly Extension[]> extends ConnectOptions<E>, ReconnectingOptions {}

/**
 * Connect, and connect again with backoff each time the session is lost,
 * for as long as you iterate: `for await (const client of
 * reconnecting(options))` runs its body once per session. The next client
 * comes once the previous session has ended. Failures that retrying can't
 * fix (authentication, host key, certificate, hello, profile, capability)
 * end the loop with that error. Nothing is ever re-sent: restore
 * subscriptions or settle a confirmed commit in the body.
 * See [Reconnecting](/guide/connecting#reconnecting).
 *
 * ```ts
 * for await (const client of reconnecting(options)) {
 *   await using sub = await client.ops.subscriptions.establish(opts);
 *   for await (const update of sub) handle(update);
 * }
 * ```
 * @throws TypeError or RangeError for invalid `retry` options.
 */
export function reconnecting<const E extends readonly Extension[] = []>(
  options: ReconnectOptions<E>,
): Reconnecting<NetconfClient<OpsMap<E>, ContentMap<E>>> {
  return reconnectWith(options, {});
}

/** @internal reconnecting() with what the runtime offers (see openClient). */
export function reconnectWith<const E extends readonly Extension[] = []>(
  options: ReconnectOptions<E>,
  host: ClientHost,
): Reconnecting<NetconfClient<OpsMap<E>, ContentMap<E>>> {
  const { retry, onRetry, signal, ...connectOptions } = options;
  return new Reconnecting((stop) => openClient<E>({ ...connectOptions, signal: stop }, host), {
    ...(retry !== undefined ? { retry } : {}),
    ...(onRetry !== undefined ? { onRetry } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
}

// --- NetconfClient -----------------------------------------------------------------

/** `client.transport`: the secure transport under the session. */
export interface TransportInfo {
  /** The server end of the connection: host, port, and the server's key or certificate identity. */
  readonly peer: ConnectionPeer;
}

/**
 * A connected client. Each call sits on the object for the RFC 6241 layer it
 * works at: `transport` (Secure Transport), `session` (Messages), `ops`
 * (Operations) and `content` (Content).
 */
export class NetconfClient<O extends object = object, C extends object = object> implements AsyncDisposable {
  /** Secure Transport: the peer the connection reached. */
  readonly transport: TransportInfo;
  /** Messages: raw RPCs, capabilities, session-id, state and events. */
  readonly session: Session;
  /** Operations: base operations, `list` and `run`, the device profile's own (`device`), and each extension's under its id. */
  readonly ops: ClientOps & Readonly<O>;
  /** Content: reading and configuring by YANG path, module resolution, and each extension's decoded readers under its id. */
  readonly content: ClientContent & Readonly<C>;
  /** The device profile in use, if any. It shapes every layer, so it belongs to none of them. */
  readonly profile: DeviceProfile | undefined;
  /**
   * The options given to `connect()`, as given: a frozen copy of the top
   * level (nested objects are yours, and not copied). Its `profile` is what
   * was passed, such as an `autoDetect([...])`; `client.profile` is the
   * profile it chose.
   * Secrets such as a password stay inside `transport`, which is a function.
   */
  readonly connectOptions: Readonly<ConnectOptions>;

  /** @internal Use {@link connect}. */
  constructor(
    session: Session,
    peer: ConnectionPeer,
    profile: DeviceProfile | undefined,
    options: ConnectOptions,
    extensions: readonly Extension[] = [],
    host: ClientHost = {},
  ) {
    this.session = session;
    this.transport = Object.freeze({ peer });
    this.profile = profile;
    this.connectOptions = Object.freeze({ ...options });
    const capabilityCheck = options.capabilityCheck ?? 'strict';
    const namespaces = options.namespaces ?? {};
    // The JSON conversion reads the YANG library through ctx, and ctx offers the conversion: each refers to the other lazily.
    const toJson: ToJson = (data, opts) => yang.toJson(data, opts);
    const toXml: ToXml = (json, opts) => yang.toXml(json, opts);
    // Readers name identities and paths by module; the lookup reads the session's sources lazily.
    const moduleOf: ModuleOf = (ns) => moduleNamespaces.moduleOf(ns);
    const ctx = extensionContext(session, capabilityCheck, [], toJson, toXml, moduleOf);
    const moduleNamespaces = new ModuleNamespaces({ session, ctx: () => ctx, profile, namespaces });
    const yang = new ClientYang({ session, ctx: () => ctx, profile, options: options.yang, moduleNamespaces, host });
    const device = profile === undefined ? undefined : bindDevice(profile, session);

    // Each extension's sections share one context, whose requests also check the extension's own required capabilities.
    const opsSections: Record<string, object> = {};
    const contentSections: Record<string, object> = {};
    for (const e of extensions) {
      const own = extensionContext(session, capabilityCheck, e.requires ?? [], toJson, toXml, moduleOf);
      if (typeof e.ops === 'function') opsSections[e.id] = Object.freeze(e.ops(own));
      if (typeof e.content === 'function') contentSections[e.id] = Object.freeze(e.content(own));
    }

    const list: OperationDescriptor[] = BASE_OPERATIONS.map((d) => {
      const added = extensions.flatMap((e) =>
        (e.augments ?? []).filter((a) => a.operation === d.name).flatMap((a) => a.params.map((p) => ({ ...p, extension: e.id }))),
      );
      return added.length === 0 ? d : Object.freeze({ ...d, params: Object.freeze([...d.params, ...added]) });
    });
    for (const e of extensions) {
      for (const d of e.descriptors ?? []) {
        if (d.kind === 'read') {
          const section = (contentSections[e.id] ?? {}) as Record<string, unknown>;
          if (!(Object.hasOwn(section, d.method) && typeof section[d.method] === 'function')) {
            throw new TypeError(`Extension ${e.id} describes the read ${d.name}, but its content section has no method ${d.method}`);
          }
        }
        list.push(Object.freeze({ ...d, extension: e.id }));
      }
    }
    for (const d of device?.descriptors ?? []) {
      const other = list.find((o) => o.name === d.name);
      if (other !== undefined) {
        const owner = other.extension === undefined ? 'a base operation' : `an operation of the ${other.extension} extension`;
        throw new TypeError(`Profile ${d.device} has an operation named ${JSON.stringify(d.name)}, which is already ${owner}`);
      }
      list.push(d);
    }

    const opsLayer = new ClientOps({
      session,
      capabilityCheck,
      extensions,
      ctx,
      device,
      list: Object.freeze(list),
      content: contentSections,
      close: () => this.close(),
      toJson,
      toXml,
    });
    const contentLayer = new ClientContent({
      session,
      ops: opsLayer,
      profile,
      capabilityCheck,
      moduleNamespaces,
      ctx,
      diff: (from, to, datastore) => yang.diff(from, to, datastore),
      declaredFeatures: (selector, modules) => yang.declaredFeatures(selector, modules),
    });
    attach(opsLayer, opsSections);
    attach(contentLayer, contentSections);
    this.ops = opsLayer as ClientOps & Readonly<O>;
    this.content = contentLayer as ClientContent & Readonly<C>;
  }

  /**
   * The logger in use: the one passed to connect() or setLogger(), or
   * `undefined` for none. (`client.session.logger` is the object the library
   * logs through, which forwards to this one.)
   */
  get logger(): Logger | undefined {
    return logSwitchOf(this.session).target;
  }

  /** The least severe level passed to the logger. */
  get logLevel(): LogLevel {
    return logSwitchOf(this.session).level;
  }

  /**
   * Log to `logger` from now on, or stop logging with `undefined`. Takes
   * effect at once for the session, operations, extensions and the client.
   * The loggers given to ssh(), tls() or a call-home server are separate.
   */
  setLogger(logger: Logger | undefined): void {
    logSwitchOf(this.session).setTarget(logger);
  }

  /**
   * Pass only entries at `level` and above to the logger: `'trace'`,
   * `'debug'`, `'info'`, `'warn'`, `'error'`, or `'silent'` for none.
   * @throws TypeError for any other value.
   */
  setLogLevel(level: LogLevel): void {
    checkLogLevel(level);
    logSwitchOf(this.session).setLevel(level);
  }

  /** Close the session and its connection. Idempotent, and never rejects. */
  close(): Promise<void> {
    return this.session.close();
  }

  /** Close the client at the end of an `await using` scope, as {@link NetconfClient.close} does. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Put each extension's section on a layer object, under its id, read-only. */
function attach(layer: object, sections: Readonly<Record<string, object>>): void {
  for (const [id, section] of Object.entries(sections)) {
    Object.defineProperty(layer, id, { value: section, enumerable: true, writable: false, configurable: false });
  }
}
