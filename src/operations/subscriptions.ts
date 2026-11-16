/**
 * RFC 8639 subscribed notifications over NETCONF (RFC 8640), with RFC 8641
 * YANG-Push datastore subscriptions (design §8).
 *
 * ```ts
 * import { subscriptions } from '@node-net/netconf/operations/subscriptions';
 *
 * const client = await connect({ transport, extensions: [subscriptions] });
 *
 * // An event stream.
 * await using events = await client.ops.subscriptions.establish({ stream: 'NETCONF' });
 * for await (const update of events) if (update.type === 'event') console.log(update.notification.event?.name);
 *
 * // YANG-Push: the selected part of operational, every 10 seconds (periods are in centiseconds).
 * const telemetry = await client.ops.subscriptions.establish({
 *   datastore: 'operational',
 *   filter: subtree(x('interfaces', { xmlns: IF })),
 *   periodic: { period: 1000 },
 * });
 * ```
 *
 * A session can hold one stream subscription and any number of datastore
 * subscriptions. Stream event records carry no subscription id, so a second
 * stream subscription on the same session would make them ambiguous; it is
 * refused locally. Datastore updates and state changes carry an id and are
 * routed by it, including the ones a server sends before the reply that
 * tells us the id.
 *
 * `<create-subscription>` (RFC 5277) and `<establish-subscription>` are
 * refused locally on a session that already used the other.
 *
 * The YANG modules are YANG 1.1, so the hello doesn't list them: support is
 * read from the YANG library on first use (`support()`).
 *
 * See [RFC 8639 subscriptions and YANG-Push](/guide/notifications#rfc-8639-subscriptions-and-yang-push).
 *
 * @packageDocumentation
 */

export { SubscriptionError, SubscriptionOverflowError, type StreamInfo } from './notifications.js';
export type { DatastoreRef } from './identities.js';
export type { PatchEdit, YangPatch } from './yang-patch.js';

export { CHANGE_TYPES, SUBSCRIBED_NOTIFICATIONS_NS, YANG_PUSH_NS, type ChangeType } from './subscriptions/common.js';
export type {
  DatastoreSubscriptionOptions,
  EstablishOptions,
  ModifyOptions,
  ModuleSupport,
  OnChangeOptions,
  PeriodicOptions,
  ReceiverInfo,
  StreamSubscriptionOptions,
  SubscriptionEnd,
  SubscriptionEndReason,
  SubscriptionInfo,
  SubscriptionSupport,
  SubscriptionUpdate,
} from './subscriptions/types.js';
export type {
  DatastoreCapabilities,
  NodeCapabilities,
  NotificationCapabilities,
  NotificationSupport,
  SubscriptionCapabilities,
} from './subscriptions/capabilities.js';
export {
  deleteSubscriptionRequest,
  establishSubscriptionRequest,
  killSubscriptionRequest,
  modifySubscriptionRequest,
  resyncSubscriptionRequest,
  subscriptionErrorReason,
} from './subscriptions/requests.js';
export { DynamicSubscription, STOP_GRACE_MS } from './subscriptions/dynamic-subscription.js';
export { subscriptions, type SubscriptionsContent, type SubscriptionsOps } from './subscriptions/extension.js';
