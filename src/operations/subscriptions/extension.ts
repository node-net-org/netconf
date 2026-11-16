/** The subscriptions extension: its descriptors, `client.ops.subscriptions` and `client.content.subscriptions`. */

import { AbortError, ProtocolError, SessionClosedError, TimeoutError } from '../../errors.js';
import { RpcError, type RpcOptions, type RpcReply } from '../../messages/index.js';
import { raceSignal } from '../abort.js';
import { splitRpcOptions } from '../args.js';
import { defineExtension, type OperationDescriptor } from '../extension.js';
import type { DatastoreRef } from '../identities.js';
import { SubscriptionError, type StreamInfo } from '../notifications.js';
import { readCapabilities, SYSC, type SubscriptionCapabilities } from './capabilities.js';
import { CHANGE_TYPES, MAX_ID, SN, SN_MODULE, SUBSCRIBED_NOTIFICATIONS_NS, YANG_PUSH_NS, YP, YP_MODULE } from './common.js';
import { DynamicSubscription } from './dynamic-subscription.js';
import { readStreams, readSubscriptions, require_, supportReader } from './reads.js';
import {
  buildEstablish,
  deleteSubscriptionRequest,
  establishSubscriptionRequest,
  killSubscriptionRequest,
  modifySubscriptionRequest,
  resyncSubscriptionRequest,
} from './requests.js';
import { SessionSubscriptions } from './session.js';
import type { EstablishOptions, ModifyOptions, SubscriptionInfo, SubscriptionSupport } from './types.js';

const DEFAULT_QUEUE_SIZE = 1000;

/** What `client.ops.subscriptions` holds. */
export interface SubscriptionsOps {
  /** Send `<establish-subscription>` and return the subscription to read from. */
  establish(options: EstablishOptions): Promise<DynamicSubscription>;
  /**
   * `<modify-subscription>` by id. For a subscription this session holds, this
   * is its `modify()`; otherwise give `datastore` for a datastore subscription.
   */
  modify(id: number, options?: ModifyOptions & { readonly datastore?: DatastoreRef }): Promise<void>;
  /** `<delete-subscription>` by id. For a subscription this session holds, this is its `delete()`. */
  delete(id: number, options?: RpcOptions): Promise<void>;
  /** YANG-Push `<resync-subscription>` by id. */
  resync(id: number, options?: RpcOptions): Promise<void>;
  /** `<kill-subscription>`: end any session's dynamic subscription (an administrator's operation). */
  kill(id: number, options?: RpcOptions): Promise<void>;
  /** The subscriptions open on this session, by id. */
  readonly active: ReadonlyMap<number, DynamicSubscription>;
}

/** What `client.content.subscriptions` holds. */
export interface SubscriptionsContent {
  /** Which modules and features the server implements. Read once from the YANG library, then cached. */
  support(options?: RpcOptions & { readonly refresh?: boolean }): Promise<SubscriptionSupport>;
  /** The event streams the server offers (`/streams`). */
  streams(options?: RpcOptions): Promise<StreamInfo[]>;
  /** Every dynamic subscription on the server, of every session (`/subscriptions`). */
  list(options?: RpcOptions): Promise<SubscriptionInfo[]>;
  /**
   * What the server can push, from its RFC 9196 `/system-capabilities`:
   * on-change and periodic support, minimum periods and more, at system
   * level and per datastore and node. Resolves with `undefined`, reading
   * nothing more, when the server doesn't implement `ietf-system-capabilities`
   * (it is in neither the hello nor the YANG library).
   * See [What the server can push](/guide/notifications#what-the-server-can-push).
   */
  capabilities(options?: RpcOptions): Promise<SubscriptionCapabilities | undefined>;
}

/** The subscription id an establish-subscription reply carries, or undefined. */
function replyId(reply: RpcReply): number | undefined {
  const text = reply.element.child('id', SN)?.text().trim() ?? reply.data?.child('id', SN)?.text().trim();
  return text !== undefined && /^\d+$/.test(text) && Number(text) <= MAX_ID ? Number(text) : undefined;
}

const ID_PARAM = Object.freeze({ name: 'id', kind: 'positional', type: 'number', description: 'The subscription id', required: true } as const);
const DATASTORE_VALUES = ['running', 'candidate', 'startup', 'intended', 'operational'];

function descriptor(d: Omit<OperationDescriptor, 'namespace' | 'requires'> & { namespace?: string }): OperationDescriptor {
  return Object.freeze({ namespace: SN, requires: Object.freeze([]), ...d, params: Object.freeze(d.params.map((p) => Object.freeze(p))) });
}

const DESCRIPTORS: readonly OperationDescriptor[] = Object.freeze([
  descriptor({
    name: 'establish-subscription',
    method: 'establish',
    description:
      'Subscribe to an event stream, or (YANG-Push) to a datastore periodically or on change (RFC 8639, 8641). Run from a descriptor, this only sends the RPC; updates then arrive as session notification events',
    mutates: false,
    params: [
      { name: 'stream', kind: 'option', type: 'string', description: 'The event stream (give this or datastore)' },
      { name: 'datastore', kind: 'option', type: 'datastore', description: 'The datastore, for YANG-Push (give this or stream)', values: DATASTORE_VALUES },
      { name: 'filter', kind: 'option', type: 'filter', description: 'A subtree filter, or an XPath filter' },
      { name: 'replayStartTime', kind: 'option', type: 'string', description: 'Replay logged events from this time (RFC 3339; streams)' },
      { name: 'stopTime', kind: 'option', type: 'string', description: 'End the subscription at this time (RFC 3339)' },
      { name: 'period', kind: 'option', type: 'number', description: 'YANG-Push periodic: centiseconds between updates' },
      { name: 'anchorTime', kind: 'option', type: 'string', description: 'YANG-Push periodic: align periods to this time' },
      { name: 'onChange', kind: 'option', type: 'boolean', description: 'YANG-Push on-change updates' },
      { name: 'dampeningPeriod', kind: 'option', type: 'number', description: 'YANG-Push on-change: least centiseconds between updates' },
      { name: 'syncOnStart', kind: 'option', type: 'boolean', description: 'YANG-Push on-change: send the full state first (default true)' },
      { name: 'excludedChange', kind: 'option', type: 'string', description: 'YANG-Push on-change: change types to leave out', values: CHANGE_TYPES, multiple: true },
    ],
  }),
  descriptor({
    name: 'modify-subscription',
    method: 'modify',
    description: "Change a subscription's filter, stop-time, period or dampening period",
    mutates: false,
    params: [
      ID_PARAM,
      { name: 'datastore', kind: 'option', type: 'datastore', description: "A datastore subscription's datastore (required for one)", values: DATASTORE_VALUES },
      { name: 'filter', kind: 'option', type: 'filter', description: 'The new filter (required for a stream subscription)' },
      { name: 'stopTime', kind: 'option', type: 'string', description: 'The new stop-time (RFC 3339)' },
      { name: 'period', kind: 'option', type: 'number', description: 'Periodic: the new period in centiseconds' },
      { name: 'dampeningPeriod', kind: 'option', type: 'number', description: 'On-change: the new dampening period in centiseconds' },
    ],
  }),
  descriptor({ name: 'delete-subscription', method: 'delete', description: 'End one of this session\'s subscriptions', mutates: false, params: [ID_PARAM] }),
  descriptor({ name: 'kill-subscription', method: 'kill', description: "End any session's dynamic subscription", mutates: true, params: [ID_PARAM] }),
  descriptor({
    name: 'resync-subscription',
    namespace: YP,
    method: 'resync',
    description: 'Ask an on-change YANG-Push subscription for a fresh push-update',
    mutates: false,
    params: [ID_PARAM],
  }),
  descriptor({
    name: 'subscription-streams',
    kind: 'read',
    method: 'streams',
    description: 'The event streams the server offers for subscriptions (RFC 8639 /streams)',
    mutates: false,
    params: [],
  }),
  descriptor({
    name: 'subscription-list',
    kind: 'read',
    method: 'list',
    description: 'The dynamic subscriptions on the server, of every session (RFC 8639 /subscriptions)',
    mutates: false,
    params: [],
  }),
  descriptor({
    name: 'subscription-support',
    kind: 'read',
    method: 'support',
    description: 'Which subscription modules and features the server supports, from the hello or the YANG library',
    mutates: false,
    params: [{ name: 'refresh', kind: 'option', type: 'boolean', description: 'Read the YANG library again instead of using what this session already read' }],
  }),
  descriptor({
    name: 'subscription-capabilities',
    kind: 'read',
    method: 'capabilities',
    namespace: SYSC,
    description: 'What the server can push: on-change and periodic support per datastore and node (RFC 9196 /system-capabilities)',
    mutates: false,
    params: [],
  }),
]);


/** The RFC 8639/8640/8641 subscriptions extension. Enable it with `connect({ extensions: [subscriptions] })`. */
export const subscriptions = defineExtension({
  id: 'subscriptions',
  /** A one-line summary of the extension. */
  description: 'RFC 8639, 8641: dynamic subscriptions to event streams and datastores (YANG-Push)',
  descriptors: DESCRIPTORS,
  requests: {
    'establish-subscription': establishSubscriptionRequest,
    'modify-subscription': modifySubscriptionRequest,
    'delete-subscription': deleteSubscriptionRequest,
    'kill-subscription': killSubscriptionRequest,
    'resync-subscription': resyncSubscriptionRequest,
  },
  ops: (ctx): SubscriptionsOps => {
    const session = new SessionSubscriptions(ctx);
    const support = supportReader(ctx);

    const establish = async (options: EstablishOptions): Promise<DynamicSubscription> => {
      if (typeof options !== 'object' || options === null) throw new TypeError('establish needs { stream } or { datastore, periodic | onChange }');
      const { rpc, rest } = splitRpcOptions(options);
      const { queueSize, ...args } = rest;
      if (queueSize !== undefined && !(Number.isInteger(queueSize) && (queueSize) >= 1)) {
        throw new TypeError('establish: queueSize must be a positive integer');
      }
      const established = buildEstablish(args);
      if (session.used5277) throw new SubscriptionError('establish-subscription refused: this session has an RFC 5277 subscription (create-subscription); use another session');
      if (established.kind === 'stream' && session.hasStream) throw new SubscriptionError(session.streamRefusal);

      if (ctx.capabilityCheck !== 'off') {
        const s = await support(rpc);
        const sn = s.subscribedNotifications;
        const what = `establish-subscription to ${established.kind === 'stream' ? `stream ${established.stream ?? ''}` : `datastore ${established.datastore?.name ?? ''}`}`;
        require_(ctx, sn !== undefined, SUBSCRIBED_NOTIFICATIONS_NS, what);
        if (established.needs.module === 'yp') require_(ctx, s.yangPush !== undefined, YANG_PUSH_NS, what);
        for (const feature of established.needs.snFeatures) require_(ctx, sn === undefined || sn.features.includes(feature), `${SN_MODULE} feature ${feature}`, what);
        for (const feature of established.needs.features) require_(ctx, s.yangPush === undefined || s.yangPush.features.includes(feature), `${YP_MODULE} feature ${feature}`, what);
        // A second stream establish may have started while we waited for the library.
        if (established.kind === 'stream' && session.hasStream) throw new SubscriptionError(session.streamRefusal);
      }

      const { timeout, signal } = rpc;
      if (signal?.aborted === true) throw new AbortError('establish-subscription was aborted before it was sent', { cause: signal.reason });
      const cleanup: RpcOptions = timeout !== undefined ? { timeout } : {};
      const done = session.begin(established.kind);
      session.ownEstablishes.add(established.request.element);
      // The caller's signal isn't passed down: once the request is sent, its
      // reply must not be dropped, or the subscription it creates would run on
      // unseen. An abort rejects now, and the reply is still awaited and deleted.
      const sending = ctx.invoke(established.request, cleanup).finally(() => session.ownEstablishes.delete(established.request.element));
      let reply: RpcReply;
      try {
        reply = await raceSignal(sending, signal, 'establish-subscription');
      } catch (err) {
        if (err instanceof AbortError) {
          void sending
            .then(async (late) => {
              const id = replyId(late);
              if (id !== undefined && !session.closed) await ctx.invoke(deleteSubscriptionRequest({ id }), cleanup);
            })
            .catch((e: unknown) => {
              if (!(e instanceof SessionClosedError) && established.kind === 'stream') session.markStreamUncertain();
              if (!(e instanceof RpcError)) ctx.logger.debug?.('Cleaning up an aborted establish-subscription failed', { err: e });
            })
            .finally(() => done(false));
        } else {
          // A timed-out establish may still have created a subscription we'll never hear the id of.
          if (err instanceof TimeoutError && established.kind === 'stream') session.markStreamUncertain();
          done(false);
        }
        throw err;
      }
      const id = replyId(reply);
      if (id === undefined) {
        done(false);
        throw new ProtocolError('establish-subscription reply has no valid <id>');
      }
      const sub = new DynamicSubscription(session, { id, established, queueSize: queueSize ?? DEFAULT_QUEUE_SIZE, cleanup });
      session.claim(sub);
      done(true);
      if (session.closed) sub._closed();
      return sub;
    };

    return {
      establish,
      modify: async (id, options = {}) => {
        const sub = session.byId.get(id);
        if (sub !== undefined) return sub.modify(options);
        const { rpc, rest } = splitRpcOptions(options);
        await ctx.invoke(modifySubscriptionRequest({ ...rest, id }), rpc);
      },
      delete: async (id, options = {}) => {
        const sub = session.byId.get(id);
        if (sub !== undefined) return sub.delete(options);
        await ctx.invoke(deleteSubscriptionRequest({ id }), splitRpcOptions(options).rpc);
      },
      resync: async (id, options = {}) => {
        const sub = session.byId.get(id);
        if (sub !== undefined) return sub.resync(options);
        await ctx.invoke(resyncSubscriptionRequest({ id }), splitRpcOptions(options).rpc);
      },
      kill: async (id, options = {}) => {
        await ctx.invoke(killSubscriptionRequest({ id }), splitRpcOptions(options).rpc);
      },
      get active() {
        return new Map(session.byId) as ReadonlyMap<number, DynamicSubscription>;
      },
    };
  },
  content: (ctx): SubscriptionsContent => ({
    support: supportReader(ctx),
    streams: (options = {}) => readStreams(ctx, splitRpcOptions(options).rpc),
    list: (options = {}) => readSubscriptions(ctx, splitRpcOptions(options).rpc),
    capabilities: (options = {}) => readCapabilities(ctx, splitRpcOptions(options).rpc),
  }),
});
