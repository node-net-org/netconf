/**
 * Argument handling the operation modules and the client layers share: the
 * per-call RPC options split off a method's options, and RFC 3339 times.
 * Internal: not exported from any entry point.
 */

import type { RpcOptions } from '../messages/index.js';

/**
 * Split a method's options into the RPC options (`timeout` and `signal`,
 * each only when given) and everything else.
 */
export function splitRpcOptions<T extends RpcOptions>(options: T): { rpc: RpcOptions; rest: Omit<T, 'timeout' | 'signal'> } {
  const { timeout, signal, ...rest } = options;
  return {
    rpc: { ...(timeout !== undefined ? { timeout } : {}), ...(signal !== undefined ? { signal } : {}) },
    rest,
  };
}

/**
 * A time as RFC 3339 text: a Date (which must be valid) as `toISOString()`, a
 * string as given once `Date.parse` accepts it. Undefined stays undefined.
 * `what` starts the error message, such as `establish-subscription: stopTime`.
 * @throws TypeError
 */
export function rfc3339(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`${what} is an invalid Date`);
    return value.toISOString();
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new TypeError(`${what} must be a Date or an RFC 3339 string`);
  return value;
}
