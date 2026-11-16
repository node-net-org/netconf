import type { Logger } from '../logger.js';

type Listener<T> = (payload: T) => void;

/**
 * A minimal typed event emitter (design §5.5).
 *
 * Deliberately not node:events: there is no special 'error' event that
 * crashes the process when nobody listens (fork defect b). A listener that
 * throws is logged and doesn't stop the other listeners or the session.
 */
export class TypedEmitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  constructor(private readonly emitterLogger: Logger) {}

  /** Add a listener. Returns a function that removes it. */
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  /** Add a listener that runs at most once. Returns a function that removes it. */
  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  /** Remove a listener added with on(). Removing one that isn't there does nothing. */
  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener);
  }

  /** How many listeners `event` has. */
  listenerCount<K extends keyof Events>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  /**
   * Call every listener for `event` with `payload`, in the order they were
   * added. For subclasses; a listener that throws is logged and skipped.
   */
  protected dispatch<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (set === undefined) return;
    for (const listener of [...set] as Listener<Events[K]>[]) {
      try {
        listener(payload);
      } catch (err) {
        this.emitterLogger.error?.(`A '${String(event)}' listener threw`, { err });
      }
    }
  }
}
