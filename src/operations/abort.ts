/**
 * Waiting on shared work with a caller's own AbortSignal: the work goes on
 * for whoever else waits on it, but this caller stops waiting.
 */

import { AbortError, TimeoutError } from '../errors.js';
import { checkTimeout, startTimer } from '../timers.js';

/** `promise`, or an AbortError as soon as `signal` aborts (at once if it already has). */
export function raceSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined, what: string): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new AbortError(`${what} was aborted`, { cause: signal.reason }));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * `promise`, or a TimeoutError once `ms` have passed (no limit when undefined
 * or Infinity). An invalid `ms` rejects at once, as checkTimeout() describes.
 */
export function raceTimeout<T>(promise: Promise<T>, ms: number | undefined): Promise<T> {
  if (ms === undefined) return promise;
  let delay: number | undefined;
  try {
    delay = checkTimeout(ms, 'timeout');
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
  if (delay === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = startTimer(() => reject(new TimeoutError('rpc', delay)), delay);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
