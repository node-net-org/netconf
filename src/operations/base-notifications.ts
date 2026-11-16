/**
 * RFC 6470 NETCONF base notifications (design §8): decode the events the
 * `NETCONF` stream carries about the server itself into typed objects.
 *
 * ```ts
 * import { notifications } from '@node-net/netconf/operations/notifications';
 * import { decodeBaseNotification } from '@node-net/netconf/operations/base-notifications';
 *
 * const client = await connect({ transport, extensions: [notifications] });
 * await using sub = await client.ops.notifications.createSubscription();
 * for await (const n of sub) {
 *   const event = decodeBaseNotification(n);
 *   if (event?.type === 'netconf-config-change') console.log(event.changedBy, event.edits.map((e) => e.target));
 * }
 * ```
 *
 * These are pure functions, not a connect() extension: RFC 6470 adds no RPC and
 * no capability, only the `ietf-netconf-notifications` YANG module.
 *
 * An edit's target is an RFC 7951 instance-identifier with module names in
 * place of the server's prefixes, such as
 * `/ietf-interfaces:interfaces/interface[name='eth0']`. Pass the session's
 * module lookup, `{ moduleOf: (ns) => client.content.moduleOf(ns) }`, so a
 * module the library doesn't know by heart is named rather than given by its
 * namespace.
 *
 * A notification that isn't one of the five base events decodes to `undefined`.
 * A base event that breaks the YANG module (a required leaf missing, an unknown
 * enumeration value, a target path that can't be parsed) throws a
 * BaseNotificationError, which is a ProtocolError.
 *
 * See [Base notifications (RFC 6470)](/guide/notifications#base-notifications-rfc-6470).
 *
 * @packageDocumentation
 */

import { ProtocolError } from '../errors.js';
import type { CapabilitySet, Notification } from '../messages/index.js';
import type { XmlElement } from '../xml/index.js';
import { qualifiedPath, type ModuleOf } from './qualified.js';
import type { EditOperation } from './base.js';

export type { Notification } from '../messages/index.js';

/** Namespace of the ietf-netconf-notifications module; also its capability id. */
export const NETCONF_NOTIFICATIONS_NS = 'urn:ietf:params:xml:ns:yang:ietf-netconf-notifications';
const MODULE = 'ietf-netconf-notifications';

/** True if the server advertises the ietf-netconf-notifications module, so it can send these events. */
export function supportsBaseNotifications(capabilities: CapabilitySet): boolean {
  return capabilities.hasHelloModule(MODULE) || capabilities.has(NETCONF_NOTIFICATIONS_NS);
}

// --- types -----------------------------------------------------------------------------------

/**
 * Who a session belongs to (`common-session-parms`): its user, session-id and
 * source host. `sessionId` 0 means a non-NETCONF session, such as the CLI.
 * Not to be confused with monitoring's `SessionInfo`, a row of
 * `/netconf-state/sessions`.
 */
export interface SessionIdentity {
  /** The name the session's user authenticated as. */
  readonly username: string;
  /** The session's NETCONF session-id; 0 for a session that isn't NETCONF. */
  readonly sessionId: number;
  /** The address or host name the session came from, when the server reports it. */
  readonly sourceHost?: string;
}

/** Who caused an event: the server itself, or a session. */
export type ChangedBy =
  | {
      /** The server itself caused the event, not a session. */
      readonly server: true;
    }
  | SessionIdentity;

/** The edit operations a `netconf-config-change` event reports. */
export const EDIT_OPERATIONS = ['merge', 'replace', 'create', 'delete', 'remove'] as const satisfies readonly EditOperation[];
export type { EditOperation };

/** The reasons a `netconf-session-end` event gives for a session ending (RFC 6470 `termination-reason`). */
export const TERMINATION_REASONS = ['closed', 'killed', 'dropped', 'timeout', 'bad-hello', 'other'] as const;
/** Why a session ended: one of {@link TERMINATION_REASONS}. */
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

/** What can happen to a confirmed commit, as `netconf-confirmed-commit` reports it (RFC 6470 `confirm-event`). */
export const CONFIRM_EVENTS = ['start', 'cancel', 'timeout', 'extend', 'complete'] as const;
/** What happened to a confirmed commit: one of {@link CONFIRM_EVENTS}. */
export type ConfirmEvent = (typeof CONFIRM_EVENTS)[number];

/** One edit a `netconf-config-change` event reports: where the configuration changed, and how. */
export interface ConfigEdit {
  /**
   * The topmost node the edit changed, as an RFC 7951 instance-identifier:
   * `/ietf-interfaces:interfaces/interface[name='eth0']`.
   */
  readonly target?: string;
  /** The edit operation applied at the target, when the server reports it. */
  readonly operation?: EditOperation;
}

interface EventBase {
  /** The notification's `eventTime`, as sent. */
  readonly eventTime: string;
}

/** `running` or `startup` changed. The edits are a hint about where, and may be empty. */
export interface ConfigChangeEvent extends EventBase {
  /** The event's name. */
  readonly type: 'netconf-config-change';
  /** Who made the change. */
  readonly changedBy: ChangedBy;
  /** The datastore that changed; `running` when the server leaves it out (the YANG default). */
  readonly datastore: 'running' | 'startup';
  /** The edits that made the change, as far as the server reports them; may be empty. */
  readonly edits: readonly ConfigEdit[];
}

/** The server's capabilities changed: the hello is out of date. */
export interface CapabilityChangeEvent extends EventBase {
  /** The event's name. */
  readonly type: 'netconf-capability-change';
  /** Who caused the change. */
  readonly changedBy: ChangedBy;
  /** Capability URIs the server now advertises that it didn't before. */
  readonly added: readonly string[];
  /** Capability URIs the server no longer advertises. */
  readonly deleted: readonly string[];
  /** Capability URIs whose parameters changed, as they now read. */
  readonly modified: readonly string[];
}

/** A NETCONF session started on the server. */
export interface SessionStartEvent extends EventBase {
  /** The event's name. */
  readonly type: 'netconf-session-start';
  /** The session that started. */
  readonly session: SessionIdentity;
}

/** A NETCONF session on the server ended. */
export interface SessionEndEvent extends EventBase {
  /** The event's name. */
  readonly type: 'netconf-session-end';
  /** The session that ended. */
  readonly session: SessionIdentity;
  /** Why it ended. */
  readonly terminationReason: TerminationReason;
  /** The session that sent `<kill-session>`, when the reason is `killed`. */
  readonly killedBy?: number;
}

/** A confirmed commit started, was extended, completed, cancelled or timed out (rolled back). */
export interface ConfirmedCommitEvent extends EventBase {
  /** The event's name. */
  readonly type: 'netconf-confirmed-commit';
  /** The session that acted; absent for `timeout`. */
  readonly session?: SessionIdentity;
  /** What happened to the confirmed commit. */
  readonly confirmEvent: ConfirmEvent;
  /** Seconds until rollback, for `start` and `extend`. */
  readonly timeout?: number;
}

/** Any of the five RFC 6470 base events, told apart by `type`; what {@link decodeBaseNotification} returns. */
export type BaseNotification =
  | ConfigChangeEvent
  | CapabilityChangeEvent
  | SessionStartEvent
  | SessionEndEvent
  | ConfirmedCommitEvent;

/** The name of an RFC 6470 base event, such as `netconf-config-change`. */
export type BaseNotificationType = BaseNotification['type'];

/** A base notification that breaks the ietf-netconf-notifications module. */
export class BaseNotificationError extends ProtocolError {
  /** The error class name. */
  override name = 'BaseNotificationError';
  override readonly code: string = 'ERR_NETCONF_BASE_NOTIFICATION';
  /** The notification name, e.g. `netconf-session-end`. */
  readonly event: string;
  /** The offending field, e.g. `termination-reason` or `edit/target`. */
  readonly field: string;
  /** The event element. */
  readonly element: XmlElement;

  constructor(event: XmlElement, field: string, problem: string, cause?: unknown) {
    super(`Invalid ${event.name} notification: ${field} ${problem}`, cause === undefined ? undefined : { cause });
    this.event = event.name;
    this.field = field;
    this.element = event;
  }
}

// --- decoders --------------------------------------------------------------------------------

type Decoder<T extends BaseNotification> = (event: XmlElement, eventTime: string, moduleOf: ModuleOf | undefined) => T;

const DECODERS: { readonly [K in BaseNotificationType]: Decoder<Extract<BaseNotification, { type: K }>> } = {
  'netconf-config-change': (ev, eventTime, moduleOf) => ({
    type: 'netconf-config-change',
    eventTime,
    changedBy: changedBy(ev),
    datastore: enumLeaf(ev, 'datastore', ['running', 'startup'] as const) ?? 'running',
    edits: ev.childrenNamed('edit', NETCONF_NOTIFICATIONS_NS).map((edit) => configEdit(ev, edit, moduleOf)),
  }),
  'netconf-capability-change': (ev, eventTime) => ({
    type: 'netconf-capability-change',
    eventTime,
    changedBy: changedBy(ev),
    added: leafList(ev, 'added-capability'),
    deleted: leafList(ev, 'deleted-capability'),
    modified: leafList(ev, 'modified-capability'),
  }),
  'netconf-session-start': (ev, eventTime) => ({
    type: 'netconf-session-start',
    eventTime,
    session: sessionParms(ev, ev, ''),
  }),
  'netconf-session-end': (ev, eventTime) => {
    const terminationReason = enumLeaf(ev, 'termination-reason', TERMINATION_REASONS);
    if (terminationReason === undefined) throw new BaseNotificationError(ev, 'termination-reason', 'is missing');
    const killedBy = uint32Leaf(ev, ev, 'killed-by', '', 1);
    return {
      type: 'netconf-session-end',
      eventTime,
      session: sessionParms(ev, ev, ''),
      terminationReason,
      ...(killedBy === undefined ? {} : { killedBy }),
    };
  },
  'netconf-confirmed-commit': (ev, eventTime) => {
    const confirmEvent = enumLeaf(ev, 'confirm-event', CONFIRM_EVENTS);
    if (confirmEvent === undefined) throw new BaseNotificationError(ev, 'confirm-event', 'is missing');
    const hasSession = leaf(ev, 'username') !== undefined || leaf(ev, 'session-id') !== undefined;
    const timeout = uint32Leaf(ev, ev, 'timeout', '', 0);
    return {
      type: 'netconf-confirmed-commit',
      eventTime,
      ...(hasSession ? { session: sessionParms(ev, ev, '') } : {}),
      confirmEvent,
      ...(timeout === undefined ? {} : { timeout }),
    };
  },
};

/** Options for {@link decodeBaseNotification} and the single-event decoders. */
export interface DecodeOptions {
  /**
   * The module a namespace belongs to, for the module names in an edit's
   * target: pass `(ns) => client.content.moduleOf(ns)`. Without it, or for a
   * namespace it doesn't know, a well-known IETF module's name is used, then
   * the namespace itself.
   */
  readonly moduleOf?: ModuleOf;
}

/**
 * Decode one of the five RFC 6470 events. Returns `undefined` for any other
 * notification; throws BaseNotificationError for a base event that breaks the YANG module.
 */
export function decodeBaseNotification(notification: Notification, options: DecodeOptions = {}): BaseNotification | undefined {
  const ev = notification.event;
  if (ev?.ns !== NETCONF_NOTIFICATIONS_NS || !Object.hasOwn(DECODERS, ev.name)) return undefined;
  const decode = DECODERS[ev.name as BaseNotificationType] as Decoder<BaseNotification>;
  return decode(ev, notification.eventTime, options.moduleOf);
}

function decoderFor<K extends BaseNotificationType>(type: K) {
  return (notification: Notification, options: DecodeOptions = {}): Extract<BaseNotification, { type: K }> | undefined => {
    const ev = notification.event;
    if (ev?.ns !== NETCONF_NOTIFICATIONS_NS || ev.name !== type) return undefined;
    return decodeBaseNotification(notification, options) as Extract<BaseNotification, { type: K }>;
  };
}

/** Decode a `netconf-config-change`, or return `undefined` for any other notification. */
export const decodeConfigChange = decoderFor('netconf-config-change');
/** Decode a `netconf-capability-change`, or return `undefined` for any other notification. */
export const decodeCapabilityChange = decoderFor('netconf-capability-change');
/** Decode a `netconf-session-start`, or return `undefined` for any other notification. */
export const decodeSessionStart = decoderFor('netconf-session-start');
/** Decode a `netconf-session-end`, or return `undefined` for any other notification. */
export const decodeSessionEnd = decoderFor('netconf-session-end');
/** Decode a `netconf-confirmed-commit`, or return `undefined` for any other notification. */
export const decodeConfirmedCommit = decoderFor('netconf-confirmed-commit');

// --- field helpers ---------------------------------------------------------------------------

function leaf(parent: XmlElement, name: string): string | undefined {
  return parent.child(name, NETCONF_NOTIFICATIONS_NS)?.text().trim();
}

function leafList(parent: XmlElement, name: string): string[] {
  return parent.childrenNamed(name, NETCONF_NOTIFICATIONS_NS).map((c) => c.text().trim());
}

function enumLeaf<T extends string>(ev: XmlElement, name: string, values: readonly T[], parent = ev, path = name): T | undefined {
  const value = leaf(parent, name);
  if (value === undefined) return undefined;
  if (!(values as readonly string[]).includes(value)) {
    throw new BaseNotificationError(ev, path, `has unknown value ${JSON.stringify(value)}; expected one of ${values.join(', ')}`);
  }
  return value as T;
}

function uint32Leaf(ev: XmlElement, parent: XmlElement, name: string, at: string, min: number): number | undefined {
  const value = leaf(parent, name);
  if (value === undefined) return undefined;
  const n = /^\d{1,10}$/.test(value) ? Number(value) : NaN;
  if (!(n >= min && n <= 0xffffffff)) {
    throw new BaseNotificationError(ev, at + name, `must be an integer from ${min} to 4294967295, got ${JSON.stringify(value)}`);
  }
  return n;
}

/** `common-session-parms` read from `parent`; `at` prefixes field names in errors (e.g. `changed-by/`). */
function sessionParms(ev: XmlElement, parent: XmlElement, at: string): SessionIdentity {
  const username = leaf(parent, 'username');
  if (username === undefined) throw new BaseNotificationError(ev, `${at}username`, 'is missing');
  const sessionId = uint32Leaf(ev, parent, 'session-id', at, 0);
  if (sessionId === undefined) throw new BaseNotificationError(ev, `${at}session-id`, 'is missing');
  const sourceHost = leaf(parent, 'source-host');
  return { username, sessionId, ...(sourceHost === undefined || sourceHost === '' ? {} : { sourceHost }) };
}

function changedBy(ev: XmlElement): ChangedBy {
  const by = ev.child('changed-by', NETCONF_NOTIFICATIONS_NS);
  if (by === undefined) throw new BaseNotificationError(ev, 'changed-by', 'is missing');
  if (by.child('server', NETCONF_NOTIFICATIONS_NS) !== undefined) return { server: true };
  if (by.child('username', NETCONF_NOTIFICATIONS_NS) === undefined && by.child('session-id', NETCONF_NOTIFICATIONS_NS) === undefined) {
    throw new BaseNotificationError(ev, 'changed-by', 'has neither server nor session parameters');
  }
  return sessionParms(ev, by, 'changed-by/');
}

function configEdit(ev: XmlElement, edit: XmlElement, moduleOf: ModuleOf | undefined): ConfigEdit {
  const operation = enumLeaf(ev, 'operation', EDIT_OPERATIONS, edit, 'edit/operation');
  const targetEl = edit.child('target', NETCONF_NOTIFICATIONS_NS);
  let target: string | undefined;
  if (targetEl !== undefined) {
    try {
      target = qualifiedPath(targetEl.text(), targetEl, moduleOf);
    } catch (err) {
      throw new BaseNotificationError(ev, 'edit/target', (err as Error).message, err);
    }
  }
  return { ...(target === undefined ? {} : { target }), ...(operation === undefined ? {} : { operation }) };
}
