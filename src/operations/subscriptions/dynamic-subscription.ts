/** A dynamic subscription (RFC 8639): the AsyncIterable handle `establish()` returns. */

import { setDeadline, type Deadline } from '../../timers.js';
import { ProtocolError, SessionClosedError } from '../../errors.js';
import type { Notification, RpcOptions } from '../../messages/index.js';
import { XmlElement } from '../../xml/index.js';
import { splitRpcOptions, rfc3339 } from '../args.js';
import type { ExtensionContext } from '../extension.js';
import type { Identity } from '../identities.js';
import { moduleName, qualifiedIdentity, type ModuleOf } from '../qualified.js';
import { SubscriptionError, SubscriptionOverflowError } from '../notifications.js';
import { decodeYangPatch, type YangPatch } from '../yang-patch.js';
import { NO_SUCH_SUBSCRIPTION, SN, YP } from './common.js';
import { deleteSubscriptionRequest, modifySubscriptionRequest, resyncSubscriptionRequest, subscriptionErrorReason, type Established } from './requests.js';
import type { ModifyOptions, SubscriptionEnd, SubscriptionUpdate } from './types.js';

/** How long after its stop-time a subscription is ended locally if the server hasn't ended it. */
export const STOP_GRACE_MS = 2000;

/** @internal What a subscription needs from its session's coordinator. */
export interface SubscriptionHost {
  readonly ctx: ExtensionContext;
  readonly closed: boolean;
  /** The subscription ended and is deleted on the server: stop routing to it. */
  forget(sub: DynamicSubscription): void;
  /** A stream subscription may still be active on the server: refuse another on this session. */
  markStreamUncertain(): void;
}

/** A notification's `<reason>`, module-qualified; the text as sent if its prefix doesn't resolve. */
function reasonOf(ev: XmlElement, moduleOf: ModuleOf | undefined): string {
  const el = ev.child('reason', SN);
  if (el === undefined) return '';
  return qualifiedIdentity(el.text(), el, moduleOf) ?? el.text().trim();
}

function decodePatch(ev: XmlElement): YangPatch {
  const patch = ev.child('datastore-changes', YP)?.elements.find((e) => e.name === 'yang-patch');
  if (patch === undefined) throw new ProtocolError('push-change-update has no <datastore-changes>/<yang-patch>');
  return decodeYangPatch(patch);
}

// --- the subscription -----------------------------------------------------------------------------

type Waiter = { resolve(result: IteratorResult<SubscriptionUpdate>): void; reject(err: Error): void };

/** @internal */
export interface SubscriptionInit {
  readonly id: number;
  readonly established: Established;
  readonly queueSize: number;
  /** The caller's timeout without its signal, for cleanup. */
  readonly cleanup: RpcOptions;
}

/**
 * A dynamic subscription (RFC 8639): an AsyncIterable of its updates, in
 * arrival order. Read it once. Iteration ends when the subscription ends
 * (see `ended`), and fails with SubscriptionOverflowError if more than
 * `queueSize` updates wait unread. Leaving a `for await` early, or an
 * `await using` scope, deletes the subscription on the server.
 */
export class DynamicSubscription implements AsyncIterableIterator<SubscriptionUpdate>, AsyncDisposable {
  /** The server's subscription id. */
  readonly id: number;
  /** Whether it subscribes to an event stream or to a datastore (YANG-Push). */
  readonly kind: 'stream' | 'datastore';
  /** A stream subscription's stream. */
  readonly stream: string | undefined;
  /** A datastore subscription's datastore identity, module-qualified (RFC 7951): `ietf-datastores:operational`. */
  readonly datastore: string | undefined;
  /** A datastore subscription's trigger. */
  readonly trigger: 'periodic' | 'on-change' | undefined;
  /** True if a replay was requested. */
  readonly replay: boolean;
  /** Resolves true when the server reports replay complete; false if there was no replay or it ended first. */
  readonly replayComplete: Promise<boolean>;
  /** Resolves when the subscription ends, with the reason. Never rejects. */
  readonly ended: Promise<SubscriptionEnd>;

  /** The datastore as requested, sent again by modify(). */
  private readonly datastoreRef: Identity | undefined;
  private readonly queue: SubscriptionUpdate[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly limit: number;
  private readonly cleanup: RpcOptions;
  private end_: SubscriptionEnd | undefined;
  private dropped = 0;
  private overflowReported = false;
  private deleting: Promise<void> | undefined;
  private stopTime: number | undefined;
  private stopTimer: Deadline | undefined;
  private replayDone = false;
  private resolveReplay!: (done: boolean) => void;
  private resolveEnded!: (end: SubscriptionEnd) => void;

  /** @internal Created by `client.ops.subscriptions.establish()`. */
  constructor(
    private readonly session: SubscriptionHost,
    init: SubscriptionInit,
  ) {
    const e = init.established;
    this.id = init.id;
    this.kind = e.kind;
    this.stream = e.stream;
    this.datastoreRef = e.datastore;
    this.datastore = e.datastore === undefined ? undefined : `${moduleName(e.datastore.namespace, session.ctx.moduleOf)}:${e.datastore.name}`;
    this.trigger = e.trigger;
    this.replay = e.replay;
    this.limit = init.queueSize;
    this.cleanup = init.cleanup;
    this.replayComplete = new Promise((resolve) => (this.resolveReplay = resolve));
    this.ended = new Promise((resolve) => (this.resolveEnded = resolve));
    if (!this.replay) this.resolveReplay(false);
    this.setStopTime(e.stopTime);
  }

  /** Why and how it ended, or undefined while it is active. */
  get end(): SubscriptionEnd | undefined {
    return this.end_;
  }

  /**
   * `<modify-subscription>`: change the filter or stop-time, and for a
   * datastore subscription the period (periodic) or dampening period
   * (on-change). A stream subscription's modify must give a filter.
   */
  async modify(options: ModifyOptions = {}): Promise<void> {
    this.ensureActive('modify');
    const { rpc, rest: args } = splitRpcOptions(options);
    if (this.kind === 'stream' && (args.period !== undefined || args.dampeningPeriod !== undefined)) {
      throw new TypeError('modify-subscription: period and dampeningPeriod are for datastore subscriptions');
    }
    if (this.trigger === 'periodic' && args.dampeningPeriod !== undefined) throw new TypeError('modify-subscription: this subscription is periodic; give period');
    if (this.trigger === 'on-change' && args.period !== undefined) throw new TypeError('modify-subscription: this subscription is on-change; give dampeningPeriod');
    const request = modifySubscriptionRequest({ ...args, id: this.id, ...(this.datastoreRef !== undefined ? { datastore: this.datastoreRef } : {}) });
    await this.session.ctx.invoke(request, rpc);
    if (args.stopTime !== undefined) this.setStopTime(rfc3339(args.stopTime, 'stopTime'));
  }

  /** YANG-Push `<resync-subscription>`: ask an on-change subscription for a fresh `push-update`. */
  async resync(options: RpcOptions = {}): Promise<void> {
    this.ensureActive('resync');
    if (this.trigger !== 'on-change') throw new TypeError('resync-subscription is for on-change datastore subscriptions');
    await this.session.ctx.invoke(resyncSubscriptionRequest({ id: this.id }), splitRpcOptions(options).rpc);
  }

  /**
   * `<delete-subscription>`, then end with `deleted`. Does nothing once the
   * subscription has ended, and shares a delete already in progress.
   */
  delete(options: RpcOptions = {}): Promise<void> {
    if (this.end_ !== undefined) return Promise.resolve();
    this.deleting ??= this.session.ctx
      .invoke(deleteSubscriptionRequest({ id: this.id }), options)
      .then(
        () => this.finish({ reason: 'deleted' }),
        (err: unknown) => {
          if (err instanceof SessionClosedError || this.session.closed) {
            this.finish({ reason: 'closed' });
            return;
          }
          // Ended already (a terminated arrived meanwhile), or the server no
          // longer has it (a stop-time it passed silently): either way it's gone.
          if (this.end_ !== undefined || subscriptionErrorReason(err) === NO_SUCH_SUBSCRIPTION) {
            this.finish({ reason: 'deleted' });
            return;
          }
          throw err;
        },
      )
      .finally(() => {
        this.deleting = undefined;
      });
    return this.deleting;
  }

  /**
   * The next update, waiting for one if none is queued; `done` once the
   * subscription has ended, after rejecting once with a
   * `SubscriptionOverflowError` if it ended because the queue overflowed.
   */
  async next(): Promise<IteratorResult<SubscriptionUpdate>> {
    const queued = this.queue.shift();
    if (queued !== undefined) return { value: queued, done: false };
    if (this.end_?.reason === 'overflow' && !this.overflowReported) {
      this.overflowReported = true;
      throw new SubscriptionOverflowError(this.limit, this.dropped);
    }
    if (this.end_ !== undefined) return { value: undefined, done: true };
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /** Stop reading: delete the subscription (if still active) and end iteration. */
  async return(): Promise<IteratorResult<SubscriptionUpdate>> {
    this.queue.length = 0;
    this.overflowReported = true;
    await this.quietDelete();
    return { value: undefined, done: true };
  }

  /** Delete the subscription if still active, ignoring the caller's AbortSignal. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.quietDelete();
  }

  /** The subscription itself, so it can be read with `for await`. */
  [Symbol.asyncIterator](): this {
    return this;
  }

  // --- @internal: called by the session's router ---

  /** @internal A notification for this subscription arrived. */
  _deliver(n: Notification, ev: XmlElement | undefined): void {
    if (this.end_ !== undefined) {
      if (this.end_.reason === 'overflow') this.dropped++;
      return;
    }
    if (ev?.ns === SN) {
      switch (ev.name) {
        case 'replay-completed':
          this.replayDone = true;
          this.resolveReplay(true);
          // A replay can run past its stop-time (or replay a window wholly in
          // the past), so the stop timer starts only once the replay is done.
          this.armStop();
          return;
        case 'subscription-terminated':
          this.terminated(reasonOf(ev, this.session.ctx.moduleOf));
          return;
        case 'subscription-completed':
          this.finish({ reason: 'completed' });
          return;
        case 'subscription-suspended':
          this.push({ type: 'suspended', eventTime: n.eventTime, reason: reasonOf(ev, this.session.ctx.moduleOf), notification: n });
          return;
        case 'subscription-resumed':
          this.push({ type: 'resumed', eventTime: n.eventTime, notification: n });
          return;
        case 'subscription-modified':
        case 'subscription-started':
          return;
      }
    }
    if (ev?.ns === YP && ev.name === 'push-update') {
      const contents = ev.child('datastore-contents', YP) ?? new XmlElement({ name: 'datastore-contents', ns: YP });
      this.push({ type: 'push-update', eventTime: n.eventTime, contents, incomplete: ev.child('incomplete-update', YP) !== undefined, notification: n });
      return;
    }
    if (ev?.ns === YP && ev.name === 'push-change-update') {
      let patch: YangPatch;
      try {
        patch = decodePatch(ev);
      } catch (err) {
        this.session.ctx.logger.warn?.('Dropped a malformed push-change-update', { err, id: this.id });
        return;
      }
      this.push({ type: 'push-change-update', eventTime: n.eventTime, patch, incomplete: ev.child('incomplete-update', YP) !== undefined, notification: n });
      return;
    }
    if (this.kind === 'stream') this.push({ type: 'event', eventTime: n.eventTime, notification: n });
  }

  /** @internal The session ended. */
  _closed(): void {
    this.finish({ reason: 'closed' });
  }

  // --- internals ---

  private terminated(identity: string): void {
    // netopeer2 sends subscription-terminated before replying to our delete,
    // and when a stop-time passes; RFC 8639 sends nothing in either case.
    if (this.deleting !== undefined) this.finish({ reason: 'deleted' });
    else if (this.stopTime !== undefined && Date.now() >= this.stopTime - 1000) this.finish({ reason: 'completed' });
    else this.finish({ reason: 'terminated', identity });
  }

  private push(update: SubscriptionUpdate): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value: update, done: false });
    } else if (this.queue.length >= this.limit) {
      this.dropped = 1;
      // Nobody is reading fast enough: stop the server sending.
      this.finish({ reason: 'overflow' }, true);
    } else {
      this.queue.push(update);
    }
  }

  private setStopTime(stopTime: string | undefined): void {
    if (stopTime === undefined) return;
    this.stopTime = Date.parse(stopTime);
    this.armStop();
  }

  /**
   * RFC 8639 sends nothing when a dynamic subscription's stop-time passes, so
   * end it here, STOP_GRACE_MS after it. The delete covers servers that keep
   * sending (netopeer2 ignores a stop-time set by modify-subscription). A
   * replay subscription's timer waits for replay-completed.
   */
  private armStop(): void {
    this.stopTimer?.cancel();
    this.stopTimer = undefined;
    if (this.stopTime === undefined || this.end_ !== undefined || (this.replay && !this.replayDone)) return;
    const deadline = this.stopTime + STOP_GRACE_MS;
    this.stopTimer = setDeadline(deadline, () => {
      if (this.end_ === undefined) this.finish({ reason: 'completed' }, true);
    });
  }

  private ensureActive(what: string): void {
    if (this.end_ !== undefined) throw new SubscriptionError(`Can't ${what}: the subscription has ended (${this.end_.reason})`);
  }

  private async quietDelete(): Promise<void> {
    try {
      await this.delete(this.cleanup);
    } catch (err) {
      this.session.ctx.logger.warn?.('delete-subscription failed; the server may still be sending', { err, id: this.id });
      // Its event records could reach a later stream subscription: block that.
      if (this.kind === 'stream') this.session.markStreamUncertain();
      this.finish({ reason: 'deleted' });
    }
  }

  /**
   * Delete on the server after the subscription already ended locally. It
   * stays registered until then, so its notifications are still counted
   * (overflow) and a stream subscription's slot stays taken.
   */
  private async serverDelete(): Promise<void> {
    try {
      if (this.session.closed) return;
      await this.session.ctx.invoke(deleteSubscriptionRequest({ id: this.id }), this.cleanup);
    } catch (err) {
      if (!(err instanceof SessionClosedError) && subscriptionErrorReason(err) !== NO_SUCH_SUBSCRIPTION) {
        this.session.ctx.logger.warn?.('delete-subscription after the subscription ended failed; the server may still be sending', { err, id: this.id });
        if (this.kind === 'stream') this.session.markStreamUncertain();
      }
    } finally {
      this.session.forget(this);
    }
  }

  /**
   * End locally. With `deleteOnServer` (overflow, our own stop timer), the
   * server still thinks it is active: delete it there, and keep it registered
   * until that is done.
   */
  private finish(end: SubscriptionEnd, deleteOnServer = false): void {
    if (this.end_ !== undefined) return;
    this.end_ = Object.freeze(end);
    this.stopTimer?.cancel();
    if (deleteOnServer) void this.serverDelete();
    else this.session.forget(this);
    this.resolveReplay(false);
    this.resolveEnded(this.end_);
    for (const waiter of this.waiters.splice(0)) {
      if (end.reason === 'overflow' && !this.overflowReported) {
        this.overflowReported = true;
        waiter.reject(new SubscriptionOverflowError(this.limit, this.dropped));
      } else {
        waiter.resolve({ value: undefined, done: true });
      }
    }
  }
}
