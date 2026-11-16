/** The per-session subscription coordinator: routes notifications to subscriptions and holds the session's rules. */

import { SubscriptionError } from '../notifications.js';
import { NOTIFICATION_NS, type Notification } from '../../messages/index.js';
import type { XmlElement } from '../../xml/index.js';
import type { ExtensionContext } from '../extension.js';
import { leaf, MAX_ID, SN, YP } from './common.js';
import type { DynamicSubscription, SubscriptionHost } from './dynamic-subscription.js';

/** Most notifications held for an establish whose reply hasn't arrived yet. */
const PENDING_LIMIT = 1000;

/** A subscription notification's `<id>`, or undefined. */

function idOf(ev: XmlElement): number | undefined {
  const text = leaf(ev, 'id', ev.ns ?? '');
  if (text === undefined || !/^\d+$/.test(text) || Number(text) > MAX_ID) return undefined;
  return Number(text);
}

/** @internal One per session: routes notifications to subscriptions and holds the session's rules. */
export class SessionSubscriptions implements SubscriptionHost {
  readonly byId = new Map<number, DynamicSubscription>();
  closed = false;
  /** Establish requests waiting for their reply. */
  private pending = 0;
  private pendingStream = false;
  private streamSub: DynamicSubscription | undefined;
  /** Notifications that may belong to an establish still waiting for its reply. */
  private buffer: { n: Notification; ev: XmlElement | undefined; id: number | undefined }[] = [];
  private bufferWarned = false;
  /** A stream subscription may exist on the server that we can't account for (an establish timed out, or a delete failed). */
  private streamUncertain = false;
  /** Our own establish requests, so the guard can tell them from raw ones. */
  readonly ownEstablishes = new Set<XmlElement>();
  /** An RFC 5277 `<create-subscription>` was sent on this session. */
  used5277 = false;
  /** An RFC 8639 subscription was established on this session (or a raw establish-subscription sent). */
  used8639 = false;

  constructor(readonly ctx: ExtensionContext) {
    ctx.onNotification((n) => this.route(n));
    ctx.onClosed(() => {
      this.closed = true;
      this.buffer = [];
      for (const sub of [...this.byId.values()]) sub._closed();
    });
    // RFC 5277 and RFC 8639 subscriptions don't share a session (RFC 8640 §3).
    // Our own establish counts once it succeeds (or while it is in flight), so
    // a refused one leaves the session free for <create-subscription>. A
    // <create-subscription> counts as soon as it is sent: its reply isn't ours to see.
    ctx.addRpcGuard((op) => {
      if (op.name === 'create-subscription' && op.ns === NOTIFICATION_NS) {
        if (this.used8639 || this.pending > 0) {
          throw new SubscriptionError('create-subscription refused: this session uses RFC 8639 subscriptions (establish-subscription); use another session');
        }
        this.used5277 = true;
      } else if (op.name === 'establish-subscription' && op.ns === SN) {
        if (this.used5277) throw new SubscriptionError('establish-subscription refused: this session has an RFC 5277 subscription (create-subscription); use another session');
        if (!this.ownEstablishes.has(op)) this.used8639 = true;
      }
    });
  }

  get hasStream(): boolean {
    return this.streamSub !== undefined || this.pendingStream || this.streamUncertain;
  }

  /** Why a new stream subscription is refused. */
  get streamRefusal(): string {
    return this.streamUncertain
      ? 'A stream subscription may still be active on this session (an establish timed out, or a delete failed), and stream event records carry no subscription id: use another session'
      : 'A stream subscription is already active on this session: stream event records carry no subscription id, so use another session for another stream';
  }

  markStreamUncertain(): void {
    this.streamUncertain = true;
  }

  /**
   * Track an establish in flight; notifications that may be its own are
   * buffered meanwhile. Call the result with whether a subscription claimed them.
   */
  begin(kind: 'stream' | 'datastore'): (claimed: boolean) => void {
    this.pending++;
    if (kind === 'stream') this.pendingStream = true;
    let done = false;
    return (claimed) => {
      if (done) return;
      done = true;
      this.pending--;
      if (kind === 'stream') {
        this.pendingStream = false;
        // Event records held for a stream establish that failed belong to nobody.
        if (!claimed) this.buffer = this.buffer.filter((b) => b.id !== undefined);
      }
      if (this.pending === 0) this.buffer = [];
    };
  }

  /** The establish reply named `sub.id`: register it and hand over what was buffered for it. */
  claim(sub: DynamicSubscription): void {
    this.used8639 = true;
    this.byId.set(sub.id, sub);
    if (sub.kind === 'stream') this.streamSub = sub;
    const mine = this.buffer.filter((b) => b.id === sub.id || (b.id === undefined && sub.kind === 'stream'));
    this.buffer = this.buffer.filter((b) => !mine.includes(b));
    for (const b of mine) sub._deliver(b.n, b.ev);
  }

  forget(sub: DynamicSubscription): void {
    if (this.byId.get(sub.id) === sub) this.byId.delete(sub.id);
    if (this.streamSub === sub) this.streamSub = undefined;
  }

  private route(n: Notification): void {
    const ev = n.event;
    if (ev !== undefined && (ev.ns === SN || ev.ns === YP)) {
      const id = idOf(ev);
      const sub = id === undefined ? undefined : this.byId.get(id);
      if (sub !== undefined) sub._deliver(n, ev);
      else if (this.pending > 0) this.hold(n, ev, id);
      return;
    }
    // An event record: it carries no id, so it belongs to the session's one stream subscription.
    if (this.streamSub !== undefined) this.streamSub._deliver(n, ev);
    else if (this.pendingStream) this.hold(n, ev, undefined);
  }

  private hold(n: Notification, ev: XmlElement | undefined, id: number | undefined): void {
    if (this.buffer.length >= PENDING_LIMIT) {
      if (!this.bufferWarned) this.ctx.logger.warn?.(`Dropped notifications while waiting for an establish-subscription reply (over ${PENDING_LIMIT})`);
      this.bufferWarned = true;
      return;
    }
    this.buffer.push({ n, ev, id });
  }
}
