/** The subscriptions extension's option and result types (RFC 8639, 8641). */

import type { RpcOptions, Notification } from '../../messages/index.js';
import type { XmlElement } from '../../xml/index.js';
import type { Filter } from '../base.js';
import type { DatastoreRef } from '../identities.js';
import type { YangPatch } from '../yang-patch.js';
import type { ChangeType } from './common.js';

interface CommonOptions extends RpcOptions {
  /** A subtree filter, or an XPath filter. Checked against the server's `subtree` / `xpath` features. */
  readonly filter?: Filter;
  /** End the subscription at this time (RFC 3339 string or Date). */
  readonly stopTime?: string | Date;
  /** Most updates held for a slow reader before the subscription fails. Default 1000. */
  readonly queueSize?: number;
}

/** Subscribe to an event stream (RFC 8639). */
export interface StreamSubscriptionOptions extends CommonOptions {
  /** The stream, such as `NETCONF`. See `streams()`. */
  readonly stream: string;
  /** Replay logged events from this time first (needs the `replay` feature). */
  readonly replayStartTime?: string | Date;
}

/** Periodic YANG-Push updates: the selected data, sent every `period`. */
export interface PeriodicOptions {
  /** Centiseconds between updates (100 = one second). */
  readonly period: number;
  /** Align periods to this time (RFC 3339 string or Date). */
  readonly anchorTime?: string | Date;
}

/** On-change YANG-Push updates: what changed, sent when it changes. */
export interface OnChangeOptions {
  /** Least centiseconds between updates; changes in between are batched. Server default when left out. */
  readonly dampeningPeriod?: number;
  /** Send the full state first (server default true). */
  readonly syncOnStart?: boolean;
  /** Change types to leave out. */
  readonly excludedChanges?: readonly ChangeType[];
}

/** Subscribe to a datastore's updates (RFC 8641 YANG-Push): periodic or on-change. */
export interface DatastoreSubscriptionOptions extends CommonOptions {
  /** An NMDA datastore: `running`, `operational`, … or `{ name, namespace }`. */
  readonly datastore: DatastoreRef;
  /** Periodic updates. Give this or `onChange`. */
  readonly periodic?: PeriodicOptions;
  /** On-change updates (needs the `on-change` feature). */
  readonly onChange?: OnChangeOptions;
}

/** What to subscribe to with `establish()`: an event stream, or a datastore (YANG-Push). */
export type EstablishOptions = StreamSubscriptionOptions | DatastoreSubscriptionOptions;

/** What `modify()` can change: the filter, the stop-time, and for a datastore subscription its period or dampening. */
export interface ModifyOptions extends RpcOptions {
  /** The new filter. Required for a stream subscription (RFC 8639 makes the target mandatory). */
  readonly filter?: Filter;
  /** The new stop-time (RFC 3339 string or Date). */
  readonly stopTime?: string | Date;
  /** Datastore subscriptions with periodic updates: the new period, in centiseconds. */
  readonly period?: number;
  /** With `period`: align the new periods to this time (RFC 3339 string or Date). */
  readonly anchorTime?: string | Date;
  /** Datastore subscriptions with on-change updates: the new dampening period, in centiseconds. */
  readonly dampeningPeriod?: number;
}

/** What a subscription delivers, in arrival order. */
export type SubscriptionUpdate =
  /** A stream event record. */
  | {
      /** What kind of update this is. */
      readonly type: 'event';
      /** The notification's `eventTime`, as sent. */
      readonly eventTime: string;
      /** The event notification itself. */
      readonly notification: Notification;
    }
  /** YANG-Push: the selected datastore contents. */
  | {
      /** What kind of update this is. */
      readonly type: 'push-update';
      /** The notification's `eventTime`, as sent. */
      readonly eventTime: string;
      /** The `<datastore-contents>` element; its children are the selected data. */
      readonly contents: XmlElement;
      /** The server couldn't include everything selected. */
      readonly incomplete: boolean;
      /** The `push-update` notification it was read from. */
      readonly notification: Notification;
    }
  /** YANG-Push on-change: what changed. */
  | {
      /** What kind of update this is. */
      readonly type: 'push-change-update';
      /** The notification's `eventTime`, as sent. */
      readonly eventTime: string;
      /** The changes, as an RFC 8072 YANG Patch. */
      readonly patch: YangPatch;
      /** The server couldn't include every change. */
      readonly incomplete: boolean;
      /** The `push-change-update` notification it was read from. */
      readonly notification: Notification;
    }
  /** The server paused sending; updates may have been lost. */
  | {
      /** What kind of update this is. */
      readonly type: 'suspended';
      /** The notification's `eventTime`, as sent. */
      readonly eventTime: string;
      /** Why, as the reason identity, module-qualified (RFC 7951). */
      readonly reason: string;
      /** The `subscription-suspended` notification it was read from. */
      readonly notification: Notification;
    }
  /** Sending started again. A datastore subscription should resynchronise (`resync()` for on-change). */
  | {
      /** What kind of update this is. */
      readonly type: 'resumed';
      /** The notification's `eventTime`, as sent. */
      readonly eventTime: string;
      /** The `subscription-resumed` notification it was read from. */
      readonly notification: Notification;
    };

/**
 * Why a subscription ended:
 * - `deleted`: by `delete()`, `break`, or `await using`
 * - `terminated`: the server ended it (`identity` says why: `ietf-subscribed-notifications:no-such-subscription` when killed)
 * - `completed`: its stop-time passed
 * - `closed`: the session ended
 * - `overflow`: the reader fell behind (the subscription is deleted)
 */
export type SubscriptionEndReason = 'deleted' | 'terminated' | 'completed' | 'closed' | 'overflow';

/** How a {@link DynamicSubscription} ended. */
export interface SubscriptionEnd {
  /** Why it ended. */
  readonly reason: SubscriptionEndReason;
  /** For `terminated`: the reason identity, module-qualified (RFC 7951), such as `ietf-subscribed-notifications:no-such-subscription`. */
  readonly identity?: string;
}

/** A subscription module the server implements. */
export interface ModuleSupport {
  /** The module revision, if the server gives one. */
  readonly revision?: string;
  /** The module's features the server supports. */
  readonly features: readonly string[];
}

/** What the server implements, from the hello or the YANG library. */
export interface SubscriptionSupport {
  /** ietf-subscribed-notifications, if implemented. Features: `replay`, `subtree`, `xpath`, `encode-xml`, … */
  readonly subscribedNotifications?: ModuleSupport;
  /** ietf-yang-push, if implemented. Features: `on-change`. */
  readonly yangPush?: ModuleSupport;
}



/** A receiver of a subscription, from RFC 8639 `/subscriptions`. */
export interface ReceiverInfo {
  /** The receiver's name; empty if the server left it out. */
  readonly name: string;
  /** How many event records have been sent to the receiver. */
  readonly sentEventRecords?: number;
  /** How many event records were left out by the subscription's filter or access control. */
  readonly excludedEventRecords?: number;
  /** `active`, `suspended`, `connecting`, `disconnected`. */
  readonly state?: string;
}

/** One entry of `/subscriptions`: dynamic subscriptions of every session, and configured ones. */
export interface SubscriptionInfo {
  /** The subscription id. */
  readonly id: number;
  /** A stream subscription's stream. */
  readonly stream?: string;
  /** A datastore subscription's datastore identity, module-qualified (RFC 7951): `ietf-datastores:operational`. */
  readonly datastore?: string;
  /** When the subscription ends (RFC 3339), if it has a stop-time. */
  readonly stopTime?: string;
  /** The subscription's receivers; a dynamic subscription has one. */
  readonly receivers: readonly ReceiverInfo[];
}
