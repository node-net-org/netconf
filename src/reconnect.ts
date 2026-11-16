/**
 * Reconnecting after a session is lost (design §5.10): `reconnecting()`
 * connects, hands the client to the caller, and when that session ends,
 * waits with exponential backoff and connects again, for as long as the
 * caller iterates. It sends no request of its own, so it never repeats one:
 * restoring subscriptions or settling a confirmed commit is the caller's code,
 * run once per session.
 *
 * Portable: timers and AbortSignal only. The connect function is injected,
 * so `@node-net/netconf/core` and `@node-net/netconf` each bind their own `connect()`.
 */

import type { NetconfError } from './errors.js';
import { AuthenticationError, CertificateError, HostKeyError, SessionClosedError, TimeoutError, TransportError } from './errors.js';
import { MAX_TIMER_MS } from './timers.js';

/** How `reconnecting()` waits between attempts. Every delay is in milliseconds. */
export interface RetryOptions {
  /** The wait after the first failure or lost session. Default 1000. */
  readonly initialDelay?: number;
  /** The longest wait. Also how long a session must stay open to reset the backoff. Default 60000. */
  readonly maxDelay?: number;
  /** What each further consecutive failure multiplies the wait by. Default 2. */
  readonly factor?: number;
  /** Wait a random 50–100% of the computed delay, so many clients don't retry in step. Default true. */
  readonly jitter?: boolean;
  /** Give up after this many consecutive failed connect attempts, rejecting with the last error. Default unlimited. */
  readonly maxAttempts?: number;
}

/** What `onRetry` is told before each wait. */
export interface RetryInfo {
  /** How many consecutive failures and lost sessions this wait follows, from 1. */
  readonly attempt: number;
  /** How long it will wait, in milliseconds. */
  readonly delay: number;
  /** Why: the failed attempt's error, or the lost session's cause (a SessionClosedError when it gave none). */
  readonly error: NetconfError;
}

/** What `reconnecting()` adds to the options of `connect()`. */
export interface ReconnectingOptions {
  /** How long to wait between attempts. */
  readonly retry?: RetryOptions;
  /** Called before each wait. A listener that throws is ignored. */
  readonly onRetry?: (info: RetryInfo) => void;
  /** Stop reconnecting: closes the current client, and ends the iteration without an error. */
  readonly signal?: AbortSignal;
}

/** What Reconnecting needs of a client: to know when its session ends, and to close it. */
interface Closable {
  readonly session: { onClosed(listener: (event: { readonly cause?: NetconfError }) => void): () => void; readonly state: string };
  close(): Promise<void>;
}

/**
 * An async iterator of connected clients, from `reconnecting()`: each
 * `next()` resolves with a new client once the previous one's session has
 * ended. Leave the loop, call `return()`, or dispose of it (`await using`)
 * to close the current client and stop.
 */
export class Reconnecting<C> implements AsyncIterableIterator<C>, AsyncDisposable {
  readonly #open: (signal: AbortSignal) => Promise<C>;
  readonly #retry: Required<RetryOptions>;
  readonly #onRetry: ((info: RetryInfo) => void) | undefined;
  readonly #stop = new AbortController();
  readonly #signal: AbortSignal;
  /** Resolves when stopped: one promise for every wait, so no listener is added per reconnect. */
  readonly #stopped: Promise<undefined>;
  #current: { readonly client: C; readonly openedAt: number; readonly closed: Promise<NetconfError | undefined> } | undefined;
  #backoff = 0;
  #done = false;
  #queue: Promise<unknown> = Promise.resolve();

  /**
   * @internal Built by `reconnecting()`. `open` connects with the signal it is given.
   */
  constructor(open: (signal: AbortSignal) => Promise<C>, options: ReconnectingOptions) {
    this.#open = open;
    this.#retry = retryOptions(options.retry);
    this.#onRetry = options.onRetry;
    this.#signal = options.signal === undefined ? this.#stop.signal : AbortSignal.any([options.signal, this.#stop.signal]);
    this.#signal.addEventListener('abort', () => void this.#finish(), { once: true });
    this.#stopped = aborted(this.#signal);
  }

  /** The client the last `next()` resolved with, until it is closed by stopping. */
  get current(): C | undefined {
    return this.#current?.client;
  }

  /**
   * Wait until the current client's session has ended (at once for the first
   * call), back off, and connect again. Resolves with the new client, or
   * `done` once stopped.
   * @throws the error of a failure that retrying can't fix (authentication,
   *   host key, certificate, hello, profile, capability, or any error that
   *   isn't transient), or the last error after `retry.maxAttempts` failures.
   */
  next(): Promise<IteratorResult<C, undefined>> {
    const run = this.#queue.then(() => this.#next());
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Stop: close the current client and end the iteration. */
  async return(): Promise<IteratorResult<C, undefined>> {
    await this.#finish();
    return { done: true, value: undefined };
  }

  /** This iterator itself, so `for await` can use it. */
  [Symbol.asyncIterator](): this {
    return this;
  }

  /** The same as `return()`, for `await using`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.#finish();
  }

  async #next(): Promise<IteratorResult<C, undefined>> {
    if (this.#done) return { done: true, value: undefined };
    const previous = this.#current;
    if (previous !== undefined) {
      const cause = await Promise.race([previous.closed, this.#stopped]);
      if (this.#done || this.#signal.aborted) return { done: true, value: undefined };
      this.#current = undefined;
      if (Date.now() - previous.openedAt >= this.#retry.maxDelay) this.#backoff = 0;
      await this.#wait(cause ?? new SessionClosedError('The session closed'));
      if (this.#signal.aborted) return { done: true, value: undefined };
    }
    let failed = 0;
    for (;;) {
      let client: C;
      try {
        client = await this.#open(this.#signal);
      } catch (err) {
        if (this.#signal.aborted) return { done: true, value: undefined };
        if (!isTransient(err)) throw err;
        failed++;
        if (failed >= this.#retry.maxAttempts) throw err;
        await this.#wait(err);
        if (this.#signal.aborted) return { done: true, value: undefined };
        continue;
      }
      if (this.#done) {
        await (client as unknown as Closable).close().catch(() => undefined);
        return { done: true, value: undefined };
      }
      const session = (client as unknown as Closable).session;
      const closed = new Promise<NetconfError | undefined>((resolve) => {
        session.onClosed((event) => resolve(event.cause));
        if (session.state === 'closed') resolve(undefined);
      });
      this.#current = { client, openedAt: Date.now(), closed };
      return { done: false, value: client };
    }
  }

  /** Count a failure or a lost session, tell onRetry, and wait out the backoff (or until stopped). */
  async #wait(error: NetconfError): Promise<void> {
    this.#backoff++;
    const { initialDelay, maxDelay, factor, jitter } = this.#retry;
    const full = Math.min(maxDelay, initialDelay * factor ** (this.#backoff - 1));
    const delay = Math.round(jitter ? full * (0.5 + Math.random() * 0.5) : full);
    try {
      this.#onRetry?.({ attempt: this.#backoff, delay, error });
    } catch {
      // A listener's failure changes nothing about reconnecting.
    }
    await sleep(delay, this.#signal);
  }

  async #finish(): Promise<void> {
    this.#done = true;
    this.#stop.abort();
    const current = this.#current;
    this.#current = undefined;
    if (current !== undefined) await (current.client as unknown as Closable).close().catch(() => undefined);
  }
}

/**
 * True for a failure that a later attempt may not repeat: a transport
 * failure (but not authentication, host-key or certificate trust), a
 * connect or hello timeout, or a session that closed.
 */
function isTransient(err: unknown): err is NetconfError {
  if (err instanceof AuthenticationError || err instanceof HostKeyError || err instanceof CertificateError) return false;
  return err instanceof TransportError || err instanceof TimeoutError || err instanceof SessionClosedError;
}

function retryOptions(retry: RetryOptions = {}): Required<RetryOptions> {
  const out = { initialDelay: 1000, maxDelay: 60_000, factor: 2, jitter: true, maxAttempts: Infinity, ...retry };
  for (const key of ['initialDelay', 'maxDelay', 'factor'] as const) {
    const v = out[key];
    if (typeof v !== 'number') throw new TypeError(`retry.${key} must be a number`);
    if (!(v >= 0) || !Number.isFinite(v)) throw new RangeError(`retry.${key} must be a finite number of zero or more`);
  }
  if (out.factor < 1) throw new RangeError('retry.factor must be at least 1');
  if (typeof out.jitter !== 'boolean') throw new TypeError('retry.jitter must be a boolean');
  if (typeof out.maxAttempts !== 'number') throw new TypeError('retry.maxAttempts must be a number');
  if (!(out.maxAttempts >= 1)) throw new RangeError('retry.maxAttempts must be at least 1');
  return out;
}

/** Wait `ms`, or until `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.min(ms, MAX_TIMER_MS));
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Resolves (with undefined) when `signal` aborts. */
function aborted(signal: AbortSignal): Promise<undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true }));
}
