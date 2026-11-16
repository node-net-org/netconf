/**
 * The shared timer helpers: checkTimeout's rules, and setDeadline
 * waiting past the longest delay a timer allows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkTimeout, MAX_TIMER_MS, setDeadline, startTimer } from '../src/timers.js';
import { raceTimeout } from '../src/operations/abort.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('checkTimeout', () => {
  it('returns no timer for Infinity, rounds up, and clamps to MAX_TIMER_MS', () => {
    expect(checkTimeout(Infinity, 't')).toBeUndefined();
    expect(checkTimeout(1, 't')).toBe(1);
    expect(checkTimeout(0.2, 't')).toBe(1);
    expect(checkTimeout(1500.5, 't')).toBe(1501);
    expect(checkTimeout(MAX_TIMER_MS, 't')).toBe(MAX_TIMER_MS);
    expect(checkTimeout(3e9, 't')).toBe(MAX_TIMER_MS);
    expect(checkTimeout(Number.MAX_VALUE, 't')).toBe(MAX_TIMER_MS);
  });

  it.each([0, -0, -1, -Infinity, Number.NaN])('refuses %s with a RangeError naming the option', (value) => {
    expect(() => checkTimeout(value, 'timeouts.rpc')).toThrow(RangeError);
    expect(() => checkTimeout(value, 'timeouts.rpc')).toThrow(/timeouts\.rpc/);
  });

  it.each(['10', null, undefined, 10n, {}])('refuses %s with a TypeError', (value) => {
    expect(() => checkTimeout(value, 'timeout')).toThrow(TypeError);
  });
});

describe('startTimer', () => {
  it('starts no timer for undefined', () => {
    expect(startTimer(() => undefined, undefined)).toBeUndefined();
  });
});

describe('setDeadline', () => {
  it('fires once at a deadline beyond the longest timer, in steps', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    setDeadline(Date.now() + 2 * MAX_TIMER_MS + 1000, fn);
    vi.advanceTimersByTime(MAX_TIMER_MS);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MAX_TIMER_MS);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * MAX_TIMER_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires at once for a deadline already passed, and not at all once cancelled', () => {
    vi.useFakeTimers();
    const past = vi.fn();
    setDeadline(Date.now() - 5, past);
    const cancelled = vi.fn();
    setDeadline(Date.now() + MAX_TIMER_MS + 5, cancelled).cancel();
    vi.advanceTimersByTime(3 * MAX_TIMER_MS);
    expect(past).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });
});

describe('raceTimeout', () => {
  it('waits with no limit for Infinity, and rejects an invalid timeout at once', async () => {
    const slow = new Promise((r) => setTimeout(() => r('done'), 20));
    await expect(raceTimeout(slow, Infinity)).resolves.toBe('done');
    await expect(raceTimeout(Promise.resolve(1), 0)).rejects.toBeInstanceOf(RangeError);
  });
});
