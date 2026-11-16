/** What every part of the subscriptions extension shares: namespaces, module names, limits. */

import type { XmlElement } from '../../xml/index.js';

/** Namespace of ietf-subscribed-notifications (RFC 8639). */
export const SUBSCRIBED_NOTIFICATIONS_NS = 'urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications';
/** Namespace of ietf-yang-push (RFC 8641). */
export const YANG_PUSH_NS = 'urn:ietf:params:xml:ns:yang:ietf-yang-push';

export const SN = SUBSCRIBED_NOTIFICATIONS_NS;
export const YP = YANG_PUSH_NS;
export const SN_MODULE = 'ietf-subscribed-notifications';
export const YP_MODULE = 'ietf-yang-push';
export const NO_SUCH_SUBSCRIPTION = `${SN_MODULE}:no-such-subscription`;
/** The largest subscription id (and centisecond value): a uint32. */
export const MAX_ID = 0xffff_ffff;

/** A kind of change an on-change YANG-Push subscription can leave out (RFC 8641 `change-type`). */
export type ChangeType = 'create' | 'delete' | 'insert' | 'move' | 'replace';
/** Every {@link ChangeType}, as a list. */
export const CHANGE_TYPES: readonly ChangeType[] = Object.freeze(['create', 'delete', 'insert', 'move', 'replace']);

/** A child leaf's trimmed text, or undefined. */
export const leaf = (el: XmlElement | undefined, name: string, ns: string): string | undefined => el?.child(name, ns)?.text().trim();
