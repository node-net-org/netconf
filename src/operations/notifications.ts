/**
 * RFC 5277 event notifications (design §5.6, §8): subscribe to an event stream
 * and read its notifications with `for await`.
 *
 * ```ts
 * import { notifications } from '@node-net/netconf/operations/notifications';
 *
 * const client = await connect({ transport, extensions: [notifications] });
 * await using sub = await client.ops.notifications.createSubscription({ stream: 'NETCONF' });
 * for await (const n of sub) console.log(n.eventTime, n.event?.name);
 * ```
 *
 * Rules RFC 5277 imposes, enforced here before anything is sent:
 * - One subscription per session, and it can't be cancelled: it lasts until its
 *   `stopTime` (the server then sends `<notificationComplete>`) or until the
 *   session ends. Disposing a Subscription only stops delivery to you.
 * - Without `:interleave`, the server accepts nothing but `<close-session>` on a
 *   subscribed session, so the client refuses other operations with
 *   CapabilityError while the subscription lasts. Use a dedicated session.
 *
 * See [RFC 5277 event notifications](/guide/notifications#rfc-5277-event-notifications).
 *
 * @packageDocumentation
 */

import { CapabilityError, NetconfError } from '../errors.js';
import { NOTIFICATION_NS, type Notification, type RpcOptions } from '../messages/index.js';
import { x, type XmlElement } from '../xml/index.js';
import { get, subtree, type Filter, type OperationRequest } from './base.js';
import { rfc3339, splitRpcOptions } from './args.js';
import { defineExtension, type ExtensionContext, type OperationDescriptor, type RequestArgs } from './extension.js';

export { NOTIFICATION_NS, type Notification } from '../messages/index.js';

/** Namespace of stream discovery (`/netconf/streams`) and of `<replayComplete>`/`<notificationComplete>`. */
export const NETMOD_NOTIFICATION_NS = 'urn:ietf:params:xml:ns:netmod:notification';
/** The `:notification:1.0` capability. */
export const NOTIFICATION_CAPABILITY = 'urn:ietf:params:netconf:capability:notification:1.0';
/** The `:interleave:1.0` capability: other RPCs are allowed on a subscribed session. */
export const INTERLEAVE_CAPABILITY = 'urn:ietf:params:netconf:capability:interleave:1.0';

const DEFAULT_QUEUE_SIZE = 1000;

/** A subscription can't be created (one is already active on this session). */
export class SubscriptionError extends NetconfError {
  /** The error class name. */
  override name = 'SubscriptionError';
  override readonly code: string = 'ERR_NETCONF_SUBSCRIPTION';
}

/** The reader fell behind: the queue reached `limit`, and `dropped` notifications were discarded after that. */
export class SubscriptionOverflowError extends SubscriptionError {
  /** The error class name. */
  override name = 'SubscriptionOverflowError';
  override readonly code: string = 'ERR_NETCONF_SUBSCRIPTION_OVERFLOW';
  /** The queue size that was reached (the subscription's `queueSize`). */
  readonly limit: number;
  /** How many notifications were discarded once the queue was full. */
  readonly dropped: number;

  constructor(limit: number, dropped: number) {
    super(`Notification queue overflowed: ${limit} queued, ${dropped} dropped; read faster or raise queueSize`);
    this.limit = limit;
    this.dropped = dropped;
  }
}

/** What to subscribe to with `<create-subscription>`: the stream, a filter and an optional replay window. */
export interface CreateSubscriptionOptions {
  /** The stream to receive. The server default is `NETCONF`. */
  readonly stream?: string;
  /** A subtree filter, or an XPath filter (needs `:xpath`). */
  readonly filter?: Filter;
  /** Replay logged notifications from this time (RFC 3339 string or Date). */
  readonly startTime?: string | Date;
  /** End the subscription at this time. Needs `startTime`, and must be later than it. */
  readonly stopTime?: string | Date;
}

/** Options for `client.ops.notifications.createSubscription()`: what to subscribe to, plus RPC and queue options. */
export interface SubscriptionOptions extends CreateSubscriptionOptions, RpcOptions {
  /** Most notifications held for a slow reader before the subscription fails. Default 1000. */
  readonly queueSize?: number;
}

/**
 * Why an RFC 5277 subscription ended:
 * - `completed`: its stop time passed (the server sent `<notificationComplete>`)
 * - `closed`: the session ended
 * - `disposed`: `return()`, `break` or `await using` stopped delivery (RFC 5277
 *   can't cancel a subscription on the server)
 * - `overflow`: the reader fell behind
 */
export type NotificationSubscriptionEndReason = 'completed' | 'closed' | 'disposed' | 'overflow';

/** An event stream the server offers, from RFC 5277 `/netconf/streams` or RFC 8639 `/streams`. */
export interface StreamInfo {
  /** The stream's name, to pass as `stream` when subscribing. */
  readonly name: string;
  /** The server's description of the stream, if it gives one. */
  readonly description?: string;
  /** Whether the server can replay this stream's logged notifications (`startTime`). */
  readonly replaySupport: boolean;
  /** When the replay log was created (RFC 3339), if the stream supports replay. */
  readonly replayLogCreationTime?: string;
  /**
   * The time of the last notification aged out of the replay log (RFC 3339),
   * if any has been: replay can't reach back past it.
   */
  readonly replayLogAgedTime?: string;
}

/** What `client.ops.notifications` holds. */
export interface NotificationsOps {
  /** True if the server allows other operations on a subscribed session. */
  readonly interleave: boolean;
  /** True while a subscription is active on this session (even after it was disposed). */
  readonly active: boolean;
  /** Send `<create-subscription>` and return the subscription to read from. */
  createSubscription(options?: SubscriptionOptions): Promise<Subscription>;
}

/** What `client.content.notifications` holds. */
export interface NotificationsContent {
  /** The event streams the server offers (`/netconf/streams`). */
  streams(options?: RpcOptions): Promise<StreamInfo[]>;
}

// --- the request ------------------------------------------------------------------------------

/** Build a `<create-subscription>` request from plain arguments. Sends nothing. */
export function createSubscriptionRequest(args: RequestArgs): OperationRequest {
  const stream = args['stream'];
  const filter = args['filter'] as Filter | undefined;
  const startTime = rfc3339(args['startTime'], 'create-subscription: startTime');
  const stopTime = rfc3339(args['stopTime'], 'create-subscription: stopTime');
  if (stream !== undefined && (typeof stream !== 'string' || stream === '')) throw new TypeError('create-subscription: stream must be a name');
  if (stopTime !== undefined && startTime === undefined) throw new TypeError('create-subscription: stopTime needs startTime');
  if (startTime !== undefined && stopTime !== undefined) {
    const start = Date.parse(startTime);
    const stop = Date.parse(stopTime);
    if (!Number.isNaN(start) && !Number.isNaN(stop) && stop <= start) {
      throw new TypeError('create-subscription: stopTime must be later than startTime');
    }
  }

  const requires: string[] = [];
  let filterElement: XmlElement | undefined;
  if (filter?.type === 'subtree') {
    filterElement = x('filter', { type: 'subtree' }, filter.content);
  } else if (filter?.type === 'xpath') {
    const declarations: Record<string, string> = {};
    for (const [prefix, uri] of Object.entries(filter.namespaces)) declarations[`xmlns:${prefix}`] = uri;
    filterElement = x('filter', { type: 'xpath', select: filter.select, ...declarations });
    requires.push(':xpath');
  } else if (filter !== undefined) {
    throw new TypeError('create-subscription: filter must be subtree(...) or xpath(...)');
  }

  return {
    element: x('create-subscription', { xmlns: NOTIFICATION_NS },
      stream !== undefined && x('stream', stream),
      filterElement,
      startTime !== undefined && x('startTime', startTime),
      stopTime !== undefined && x('stopTime', stopTime),
    ),
    requires,
  };
}

// --- the subscription ---------------------------------------------------------------------------

type Waiter = { resolve(result: IteratorResult<Notification>): void; reject(err: Error): void };

/**
 * A subscription's notifications, in arrival order. Read it once, with
 * `for await` or `next()`. Iteration ends when the subscription completes
 * (`stopTime`), when the session closes, or when you dispose it, and fails
 * with SubscriptionOverflowError if more than `queueSize` notifications wait
 * unread.
 */
export class Subscription implements AsyncIterableIterator<Notification>, AsyncDisposable {
  /** The stream requested, or undefined for the server default (`NETCONF`). */
  readonly stream: string | undefined;
  /** True if `startTime` was given, so logged notifications are replayed first. */
  readonly replay: boolean;
  /** True if the server allows other operations on this session meanwhile. */
  readonly interleave: boolean;
  /** Resolves true when the server reports replay complete, false if there was no replay or it ended first. */
  readonly replayComplete: Promise<boolean>;
  /** Resolves when the subscription ends, with the reason. Never rejects. */
  readonly ended: Promise<{
    /** Why the subscription ended. */
    readonly reason: NotificationSubscriptionEndReason;
  }>;

  private readonly queue: Notification[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly limit: number;
  private reason: NotificationSubscriptionEndReason | undefined;
  private dropped = 0;
  private overflowReported = false;
  private resolveReplay!: (done: boolean) => void;
  private resolveEnded!: (end: { reason: NotificationSubscriptionEndReason }) => void;

  /** @internal Created by `createSubscription()`. */
  constructor(options: { stream: string | undefined; replay: boolean; interleave: boolean; queueSize: number }) {
    this.stream = options.stream;
    this.replay = options.replay;
    this.interleave = options.interleave;
    this.limit = options.queueSize;
    this.replayComplete = new Promise((resolve) => (this.resolveReplay = resolve));
    this.ended = new Promise((resolve) => (this.resolveEnded = resolve));
    if (!this.replay) this.resolveReplay(false);
  }

  /** @internal A notification arrived. */
  _push(notification: Notification): void {
    if (this.reason !== undefined) {
      if (this.reason === 'overflow') this.dropped++;
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value: notification, done: false });
    } else if (this.queue.length >= this.limit) {
      this.dropped = 1;
      this.end('overflow');
    } else {
      this.queue.push(notification);
    }
  }

  /** @internal The server reported replay complete. */
  _replayDone(): void {
    this.resolveReplay(true);
  }

  /** @internal The subscription ended for a reason other than the reader. */
  _end(reason: NotificationSubscriptionEndReason): void {
    this.end(reason);
  }

  /**
   * The next notification, waiting for one if none is queued; `done` once the
   * subscription has ended, after rejecting once with a
   * `SubscriptionOverflowError` if it ended because the queue overflowed.
   */
  async next(): Promise<IteratorResult<Notification>> {
    const queued = this.queue.shift();
    if (queued !== undefined) return { value: queued, done: false };
    if (this.reason === 'overflow' && !this.overflowReported) {
      this.overflowReported = true;
      throw new SubscriptionOverflowError(this.limit, this.dropped);
    }
    if (this.reason !== undefined) return { value: undefined, done: true };
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /**
   * Stop reading: the queue is emptied and iteration ends. RFC 5277 can't
   * cancel a subscription, so the server keeps it until `stopTime` or the end
   * of the session.
   */
  return(): Promise<IteratorResult<Notification>> {
    this.queue.length = 0;
    this.overflowReported = true;
    this.end('disposed');
    return Promise.resolve({ value: undefined, done: true });
  }

  /** Stop reading, as {@link Subscription.return} does; called by `await using`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.return();
  }

  /** The subscription itself, so it can be read with `for await`. */
  [Symbol.asyncIterator](): this {
    return this;
  }

  private end(reason: NotificationSubscriptionEndReason): void {
    if (this.reason !== undefined) return;
    this.reason = reason;
    this.resolveReplay(false);
    this.resolveEnded({ reason });
    // A reader waiting now has an empty queue: wake it with the end (or the overflow error).
    for (const waiter of this.waiters.splice(0)) {
      if (reason === 'overflow' && !this.overflowReported) {
        this.overflowReported = true;
        waiter.reject(new SubscriptionOverflowError(this.limit, this.dropped));
      } else {
        waiter.resolve({ value: undefined, done: true });
      }
    }
  }
}

// --- streams -------------------------------------------------------------------------------------

async function streams(ctx: ExtensionContext, options: RpcOptions = {}): Promise<StreamInfo[]> {
  const reply = await ctx.invoke(get({ filter: subtree(x('netconf', { xmlns: NETMOD_NOTIFICATION_NS }, x('streams'))) }), options);
  const list = reply.data?.child('netconf', NETMOD_NOTIFICATION_NS)?.child('streams', NETMOD_NOTIFICATION_NS);
  const leaf = (el: XmlElement, name: string) => el.child(name, NETMOD_NOTIFICATION_NS)?.text().trim();
  return (list?.childrenNamed('stream', NETMOD_NOTIFICATION_NS) ?? []).flatMap((s) => {
    const name = leaf(s, 'name');
    if (name === undefined) return [];
    const info: Record<string, unknown> = { name, replaySupport: leaf(s, 'replaySupport') === 'true' };
    for (const [key, el] of [['description', 'description'], ['replayLogCreationTime', 'replayLogCreationTime'], ['replayLogAgedTime', 'replayLogAgedTime']] as const) {
      const value = leaf(s, el);
      if (value !== undefined) info[key] = value;
    }
    return [Object.freeze(info as unknown as StreamInfo)];
  });
}

// --- the extension ------------------------------------------------------------------------------------

const CREATE_SUBSCRIPTION: OperationDescriptor = Object.freeze({
  name: 'create-subscription',
  namespace: NOTIFICATION_NS,
  method: 'createSubscription',
  description:
    'Subscribe to an event stream (RFC 5277). Run from a descriptor, this only sends the RPC; notifications then arrive as session notification events',
  mutates: false,
  requires: [':notification:1.0'],
  params: Object.freeze([
    { name: 'stream', kind: 'option', type: 'string', description: 'The stream (server default NETCONF)' },
    { name: 'filter', kind: 'option', type: 'filter', description: 'A subtree filter, or an XPath filter (needs :xpath)' },
    { name: 'startTime', kind: 'option', type: 'string', description: 'Replay logged notifications from this time (RFC 3339)' },
    { name: 'stopTime', kind: 'option', type: 'string', description: 'End the subscription at this time (needs startTime)' },
  ] as const),
});

const STREAMS: OperationDescriptor = Object.freeze({
  name: 'notification-streams',
  kind: 'read',
  namespace: NETMOD_NOTIFICATION_NS,
  method: 'streams',
  description: 'The event streams the server offers (RFC 5277 /netconf/streams)',
  mutates: false,
  requires: Object.freeze([':notification:1.0']),
  params: Object.freeze([]),
});

function isOperation(el: XmlElement, name: string): boolean {
  return el.name === name;
}

/** The RFC 5277 notifications extension. Enable it with `connect({ extensions: [notifications] })`. */
export const notifications = defineExtension({
  id: 'notifications',
  /** A one-line summary of the extension. */
  description: 'RFC 5277: subscribe to event streams',
  requires: [':notification:1.0'],
  descriptors: [CREATE_SUBSCRIPTION, STREAMS],
  requests: { 'create-subscription': createSubscriptionRequest },
  ops: (ctx): NotificationsOps => {
    const interleave = ctx.serverCapabilities.has(INTERLEAVE_CAPABILITY);
    let active = false;

    const createSubscription = async (options: SubscriptionOptions = {}): Promise<Subscription> => {
      const { rpc, rest } = splitRpcOptions(options);
      const { queueSize, ...args } = rest;
      if (queueSize !== undefined && !(Number.isInteger(queueSize) && queueSize >= 1)) {
        throw new TypeError('createSubscription: queueSize must be a positive integer');
      }
      if (active) throw new SubscriptionError('A subscription is already active on this session (RFC 5277 allows one per session)');
      const request = createSubscriptionRequest(args);

      active = true;
      const cleanups: (() => void)[] = [];
      let serverDone = false;
      // The server-side subscription ended: lift the rules and stop listening.
      const finishServer = (): void => {
        if (serverDone) return;
        serverDone = true;
        active = false;
        for (const cleanup of cleanups.splice(0)) cleanup();
      };
      const sub = new Subscription({
        stream: args.stream,
        replay: args.startTime !== undefined,
        interleave,
        queueSize: queueSize ?? DEFAULT_QUEUE_SIZE,
      });

      cleanups.push(
        ctx.onNotification((n) => {
          const event = n.event;
          if (event?.ns === NETMOD_NOTIFICATION_NS && event.name === 'replayComplete') {
            sub._replayDone();
          } else if (event?.ns === NETMOD_NOTIFICATION_NS && event.name === 'notificationComplete') {
            finishServer();
            sub._end('completed');
          } else {
            sub._push(n);
          }
        }),
        ctx.onClosed(() => {
          finishServer();
          sub._end('closed');
        }),
      );
      if (!interleave) {
        cleanups.push(
          ctx.addRpcGuard((operation) => {
            if (operation === request.element || isOperation(operation, 'close-session')) return;
            throw new CapabilityError(':interleave', `${operation.name} while subscribed to notifications`);
          }),
        );
      }

      try {
        await ctx.invoke(request, rpc);
      } catch (err) {
        finishServer();
        sub._end('closed');
        throw err;
      }
      return sub;
    };

    return {
      interleave,
      get active() {
        return active;
      },
      createSubscription,
    };
  },
  content: (ctx): NotificationsContent => ({
    streams: (options) => streams(ctx, options),
  }),
});
