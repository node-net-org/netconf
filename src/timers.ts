/**
 * Timers that take a caller's timeout. A shared leaf: it imports nothing.
 *
 * setTimeout takes a signed 32-bit delay. Node turns anything longer,
 * Infinity included, into 1 ms (with a TimeoutOverflowWarning), so a
 * caller's long timeout would fire at once. Every timeout a caller gives
 * goes through checkTimeout(), and every wait longer than a timer allows
 * through setDeadline().
 */

/** The longest delay setTimeout accepts; Node fires longer ones after 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Check a caller's timeout, in milliseconds, and return the delay to use:
 * `undefined` for `Infinity` (no timer), otherwise the value rounded up and
 * clamped to {@link MAX_TIMER_MS}. Zero is refused rather than read as
 * "no timer" or "now": `Infinity` is the one way to say "wait forever".
 *
 * @throws TypeError if the value is not a number.
 * @throws RangeError if it is NaN, zero or negative.
 */
export function checkTimeout(value: unknown, name: string): number | undefined {
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number of milliseconds, or Infinity for no limit`);
  if (Number.isNaN(value) || value <= 0) {
    throw new RangeError(`${name} must be more than 0 ms, or Infinity for no limit (got ${String(value)})`);
  }
  if (value === Infinity) return undefined;
  return Math.min(Math.ceil(value), MAX_TIMER_MS);
}

/** setTimeout, or no timer at all when `ms` is undefined (a checkTimeout() of Infinity). */
export function startTimer(fn: () => void, ms: number | undefined): ReturnType<typeof setTimeout> | undefined {
  return ms === undefined ? undefined : setTimeout(fn, ms);
}

/**
 * Let a timer run without keeping the process alive. Node.js timers have
 * unref(); other runtimes return a plain number and have no such notion, so
 * there is nothing to do there.
 */
export function unrefTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
  (timer as { unref?: () => unknown } | undefined)?.unref?.();
}

/** A timer from {@link setDeadline}. */
export interface Deadline {
  cancel(): void;
}

/**
 * Call `fn` once `Date.now()` reaches `deadline`, however far off it is:
 * waits longer than a timer allows are made in steps. The timer doesn't keep
 * the process alive.
 */
export function setDeadline(deadline: number, fn: () => void): Deadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const arm = (): void => {
    const left = deadline - Date.now();
    timer = setTimeout(() => {
      if (cancelled) return;
      if (Date.now() < deadline) arm();
      else fn();
    }, Math.min(Math.max(0, left), MAX_TIMER_MS));
    unrefTimer(timer);
  };
  arm();
  return {
    cancel: () => {
      cancelled = true;
      clearTimeout(timer);
    },
  };
}
