/**
 * Two connected in-memory connection ends (design §5.1), for FakeServer, an
 * in-process server, and tests: no sockets and nothing from Node.js.
 *
 * Bytes written to one end arrive at the other asynchronously (in a later
 * microtask) and in order, so a receiver is never re-entered from its own
 * write, as with a real transport. Written bytes are copied, so the writer may
 * reuse its array.
 *
 * Ending both directions closes both ends, as a socket closes after both FINs.
 * destroy() closes both ends at once and drops anything still in flight to the
 * end that destroyed.
 */

import type { Connection, ConnectionPeer, ConnectionReceiver } from './types.js';

/** Options for {@link connectionPair}. */
export interface ConnectionPairOptions {
  /** The peer the first end reports (it is talking to the second). Default `{ host: 'memory', port: 0 }`. */
  readonly client?: ConnectionPeer;
  /** The peer the second end reports. Default `{ host: 'memory', port: 0 }`. */
  readonly server?: ConnectionPeer;
}

/** Two connected in-memory ends: what one writes, the other receives. */
export function connectionPair(options: ConnectionPairOptions = {}): [Connection, Connection] {
  const a = new MemoryEnd(options.client ?? DEFAULT_PEER);
  const b = new MemoryEnd(options.server ?? DEFAULT_PEER);
  a.other = b;
  b.other = a;
  return [a, b];
}

const DEFAULT_PEER: ConnectionPeer = { host: 'memory', port: 0 };

type Event = { readonly kind: 'data'; readonly bytes: Uint8Array } | { readonly kind: 'end' } | { readonly kind: 'close' };

class MemoryEnd implements Connection {
  other!: MemoryEnd;
  private receiver: ConnectionReceiver | undefined;
  /** Events that arrived before receive() and its first delivery. */
  private held: Event[] = [];
  /** The receiver has had the held events: deliver straight to it from now on. */
  private ready = false;
  private closeDelivered = false;
  /** We ended our sending side. */
  private sentEnd = false;
  /** The peer ended its sending side. */
  private gotEnd = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private resolveClosed!: () => void;
  private readonly closedPromise = new Promise<void>((resolve) => (this.resolveClosed = resolve));

  constructor(readonly peer: ConnectionPeer) {}

  receive(receiver: ConnectionReceiver): void {
    if (this.receiver !== undefined) throw new TypeError('This connection already has a receiver');
    this.receiver = receiver;
    // Held events go out in a later microtask, never during receive() itself:
    // the caller may not have finished setting up (as with a Node stream,
    // which also emits what it buffered asynchronously).
    queueMicrotask(() => {
      const held = this.held;
      this.held = [];
      this.ready = true;
      for (const e of held) this.dispatch(e);
    });
  }

  write(bytes: Uint8Array): void {
    if (this.sentEnd || this.closed) return;
    const copy = bytes.slice();
    const to = this.other;
    queueMicrotask(() => to.deliver({ kind: 'data', bytes: copy }));
  }

  end(): void {
    if (this.sentEnd || this.closed) return;
    this.sentEnd = true;
    const to = this.other;
    // Queued behind any data already written, so the peer sees it last.
    queueMicrotask(() => to.deliver({ kind: 'end' }));
    this.closeIfDone();
  }

  destroy(): void {
    if (this.closed) return;
    this.markClosed();
    const to = this.other;
    queueMicrotask(() => {
      this.notifyClose();
      to.peerDestroyed();
    });
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      if (this.closed) return;
      this.end();
      // Let what we've written reach the peer, then drop both ends.
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      this.destroy();
    })();
    return this.closing.then(() => this.closedPromise);
  }

  private deliver(e: Event): void {
    if (this.closed) return;
    if (!this.ready) this.held.push(e);
    else this.dispatch(e);
  }

  private peerDestroyed(): void {
    if (this.closed) return;
    this.markClosed();
    this.notifyClose();
  }

  private dispatch(e: Event): void {
    // close is the last thing a receiver hears, and it hears it once.
    if (this.closeDelivered) return;
    const r = this.receiver!;
    if (e.kind === 'data') r.data(e.bytes);
    else if (e.kind === 'end') {
      // The peer's end counts once the receiver has seen it, not while it is
      // held: a close must never overtake held data or the end itself.
      this.gotEnd = true;
      r.end();
      this.closeIfDone();
    } else {
      this.closeDelivered = true;
      r.close();
    }
  }

  /** Both directions have ended: the connection is over. */
  private closeIfDone(): void {
    if (!this.sentEnd || !this.gotEnd || this.closed) return;
    this.markClosed();
    this.notifyClose();
  }

  private notifyClose(): void {
    const close: Event = { kind: 'close' };
    if (!this.ready) this.held.push(close);
    else this.dispatch(close);
  }

  private markClosed(): void {
    this.closed = true;
    this.sentEnd = true;
    this.resolveClosed();
  }
}
