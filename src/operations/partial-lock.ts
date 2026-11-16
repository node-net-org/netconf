/**
 * RFC 5717 partial lock (design §8): lock only the parts of `running` you are
 * about to change, so other sessions can keep working on the rest.
 *
 * ```ts
 * import { partialLock } from '@node-net/netconf/operations/partial-lock';
 *
 * const client = await connect({ transport, extensions: [partialLock] });
 * await using lock = await client.ops.partialLock.lock([
 *   client.content.toXPath('/ietf-interfaces:interfaces/interface[name="eth0"]'),
 *   xpath("/if:interfaces/if:interface[if:name='eth1']", { if: IF_NS }),
 * ]);
 * lock.lockId;       // 127
 * lock.lockedNodes;  // what the server locked: ['/ietf-interfaces:interfaces/interface[name=\'eth0\']', …]
 * await client.ops.editConfig({ target: 'running', config });
 * // leaving the scope sends <partial-unlock>
 * ```
 *
 * Each select is an XPath 1.0 expression that must pick out a node set. A
 * server without `:xpath` only accepts instance-identifiers (absolute paths
 * whose predicates give list keys), which is what `client.content.toXPath()` builds.
 * Only the server can tell which kind a select is, so this module doesn't
 * require `:xpath`.
 *
 * A partial lock covers the selected nodes and everything below them, is
 * fixed when taken, and lasts until `<partial-unlock>` or the end of the
 * session. A conflict with another session's lock rejects with
 * PartialLockDeniedError, a LockDeniedError that gives the holder's
 * session-id. Other refusals are RpcErrors: `invalid-value` (app tag
 * `not-a-node-set` or `invalid-lock-specification`), `operation-failed` (app
 * tag `no-matches`) and `access-denied`.
 *
 * No open-source NETCONF server implements partial lock, so this module is
 * tested against the fake server only.
 *
 * See [partial-lock](/guide/extensions#partial-lock).
 *
 * @packageDocumentation
 */

import { ProtocolError, SessionClosedError } from '../errors.js';
import { NETCONF_NS, RpcError, type RpcOptions, type RpcReply } from '../messages/index.js';
import { x, type XmlElement } from '../xml/index.js';
import type { Filter, OperationRequest, XPathFilter } from './base.js';
import { defineExtension, type ExtensionContext, type OperationDescriptor } from './extension.js';
import { qualifiedPath, type ModuleOf } from './qualified.js';
import { LockDeniedError, lockHolder } from './transaction.js';

/** Namespace of the ietf-netconf-partial-lock module (`<partial-lock>`, `<partial-unlock>`). */
export const PARTIAL_LOCK_NS = 'urn:ietf:params:xml:ns:netconf:partial-lock:1.0';
/** The `:partial-lock:1.0` capability. */
export const PARTIAL_LOCK_CAPABILITY = 'urn:ietf:params:netconf:capability:partial-lock:1.0';

const MAX_LOCK_ID = 0xffff_ffff;

/**
 * One select expression: an XPath filter from `xpath(expr, namespaces)` or
 * `client.content.toXPath(path)`, or a string that uses no namespace prefixes.
 */
export type PartialLockSelect = XPathFilter | string;

/** A partial lock was refused because another session holds a lock on some of the same nodes, or a global lock on running. */
export class PartialLockDeniedError extends LockDeniedError {
  /** The error class name. */
  override name = 'PartialLockDeniedError';
  override readonly code: string = 'ERR_NETCONF_PARTIAL_LOCK_DENIED';
  /** The conflicting partial lock's id, if the server gave one in `<error-info>`. */
  readonly lockId: number | undefined;

  constructor(holder: number | undefined, lockId: number | undefined, cause: RpcError) {
    super('running', holder, cause);
    const who = holder === undefined ? 'another session' : holder === 0 ? 'a non-NETCONF entity' : `session ${holder}`;
    this.message = `Part of the running datastore is locked by ${who}`;
    this.lockId = lockId;
  }
}

/** What `client.ops.partialLock` holds. */
export interface PartialLockOps {
  /** `<partial-lock>`: lock the nodes the selects pick out. Resolves with a handle that unlocks on dispose. */
  lock(select: PartialLockSelect | readonly PartialLockSelect[], options?: RpcOptions): Promise<PartialLock>;
  /** `<partial-unlock>`: release a lock this session holds, by id. */
  unlock(lockId: number, options?: RpcOptions): Promise<void>;
}

// --- request builders ---------------------------------------------------------------

const NCNAME = /^[A-Za-z_][\w.-]*$/;

/** The prefixes an XPath expression uses, ignoring string literals and `axis::` names. */
function prefixesIn(expr: string): Set<string> {
  const code = expr.replace(/'[^']*'|"[^"]*"/g, ' ');
  const out = new Set<string>();
  for (const m of code.matchAll(/([A-Za-z_][\w.-]*):(?![:])/g)) out.add(m[1]!);
  return out;
}

function selectElement(select: unknown, i: number): XmlElement {
  const where = `partial-lock select ${i + 1}`;
  let expr: string;
  let namespaces: Readonly<Record<string, string>> = {};
  if (typeof select === 'string') {
    expr = select;
  } else if (typeof select === 'object' && select !== null && (select as Filter).type === 'xpath') {
    const f = select as XPathFilter;
    if (typeof f.select !== 'string') throw new TypeError(`${where}: the XPath expression must be a string`);
    expr = f.select;
    namespaces = f.namespaces ?? {};
  } else {
    throw new TypeError(`${where} must be an XPath: xpath(expr, namespaces), client.content.toXPath(path) or a string`);
  }
  if (expr.trim() === '') throw new TypeError(`${where} is empty`);
  for (const [prefix, uri] of Object.entries(namespaces)) {
    if (!NCNAME.test(prefix) || /^xml/i.test(prefix)) throw new TypeError(`${where}: ${JSON.stringify(prefix)} is not a usable namespace prefix`);
    if (typeof uri !== 'string' || uri === '') throw new TypeError(`${where}: prefix ${JSON.stringify(prefix)} needs a namespace URI`);
  }
  for (const prefix of prefixesIn(expr)) {
    if (!Object.hasOwn(namespaces, prefix)) {
      throw new TypeError(
        `${where} uses prefix ${JSON.stringify(prefix)} with no namespace; give it with xpath(expr, { ${prefix}: '…' }) or use client.content.toXPath(path)`,
      );
    }
  }
  const declarations: Record<string, string> = {};
  for (const [prefix, uri] of Object.entries(namespaces)) declarations[`xmlns:${prefix}`] = uri;
  return x('select', declarations, expr);
}

/** Build a `<partial-lock>` request from plain arguments (`{ select }`). Sends nothing. */
export function partialLockRequest(args: Readonly<Record<string, unknown>>): OperationRequest {
  const given = args['select'];
  const selects = Array.isArray(given) ? given : given === undefined ? [] : [given];
  if (selects.length === 0) throw new TypeError('partial-lock needs at least one select');
  return {
    element: x('partial-lock', { xmlns: PARTIAL_LOCK_NS }, selects.map((s, i) => selectElement(s, i))),
    requires: [],
  };
}

function lockIdOf(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_LOCK_ID) {
    throw new TypeError(`${what}: lock-id must be an integer from 0 to ${MAX_LOCK_ID}`);
  }
  return value;
}

/** Build a `<partial-unlock>` request from plain arguments (`{ lockId }`). Sends nothing. */
export function partialUnlockRequest(args: Readonly<Record<string, unknown>>): OperationRequest {
  const lockId = lockIdOf(args['lockId'], 'partial-unlock');
  return { element: x('partial-unlock', { xmlns: PARTIAL_LOCK_NS }, x('lock-id', String(lockId))), requires: [] };
}

// --- descriptors -----------------------------------------------------------------------

const PARTIAL_LOCK: OperationDescriptor = Object.freeze({
  name: 'partial-lock',
  namespace: PARTIAL_LOCK_NS,
  method: 'lock',
  description: 'Lock part of the running datastore (RFC 5717)',
  mutates: true,
  requires: [PARTIAL_LOCK_CAPABILITY],
  params: Object.freeze([
    Object.freeze({
      name: 'select',
      kind: 'positional',
      type: 'xpath',
      description: 'What to lock: an XPath that selects nodes (a YANG instance-identifier unless the server has :xpath)',
      required: true,
      multiple: true,
    } as const),
  ]),
});

const PARTIAL_UNLOCK: OperationDescriptor = Object.freeze({
  name: 'partial-unlock',
  namespace: PARTIAL_LOCK_NS,
  method: 'unlock',
  description: 'Release a partial lock this session holds',
  mutates: true,
  requires: [PARTIAL_LOCK_CAPABILITY],
  params: Object.freeze([
    Object.freeze({ name: 'lockId', kind: 'positional', type: 'number', description: 'The lock-id partial-lock returned', required: true } as const),
  ]),
});

// --- replies ---------------------------------------------------------------------------

interface Granted {
  readonly lockId: number;
  readonly lockedNodes: readonly string[];
}

/**
 * Read `<lock-id>` and `<locked-node>` from the reply. They are direct children
 * of `<rpc-reply>`; a `<data>` wrapper (RFC 5717 §2.4.1's note on the RFC 6241
 * schema) is accepted too.
 */
function parseGranted(reply: RpcReply, moduleOf: ModuleOf | undefined): { lockId: number | undefined; nodes: () => string[] } {
  const root = reply.element;
  const data = root.child('data', NETCONF_NS);
  const holder = root.child('lock-id', PARTIAL_LOCK_NS) === undefined && data !== undefined ? data : root;
  const text = holder.child('lock-id', PARTIAL_LOCK_NS)?.text().trim();
  const lockId = text !== undefined && /^\d+$/.test(text) && Number(text) <= MAX_LOCK_ID ? Number(text) : undefined;
  const nodes = (): string[] =>
    holder.childrenNamed('locked-node', PARTIAL_LOCK_NS).map((el) => {
      try {
        return qualifiedPath(el.text(), el, moduleOf);
      } catch (err) {
        throw new ProtocolError(`partial-lock reply has a locked-node that isn't an instance-identifier: ${(err as Error).message}`, { cause: err });
      }
    });
  return { lockId, nodes };
}

/** The conflicting partial lock's id from a `lock-denied` error, if the server gave one. */
function deniedLockId(err: RpcError): number | undefined {
  const detail = err.errors.find((e) => e.tag === 'lock-denied') ?? err.first;
  const text = detail.info?.child('lock-id')?.text().trim();
  return text !== undefined && /^\d+$/.test(text) && Number(text) <= MAX_LOCK_ID ? Number(text) : undefined;
}

// --- the handle ------------------------------------------------------------------------

/** Where a {@link PartialLock} stands: `held`, `unlocked` (released by this client) or `closed` (the session ended). */
export type PartialLockState = 'held' | 'unlocked' | 'closed';

/**
 * A partial lock this session holds. `await using lock = …` releases it on
 * scope exit.
 */
export class PartialLock implements AsyncDisposable {
  /** The lock's id, used to release it. */
  readonly lockId: number;
  /**
   * The nodes the server locked, as RFC 7951 instance-identifiers with module
   * names in place of the server's prefixes:
   * `/ietf-interfaces:interfaces/interface[name='eth0']`.
   */
  readonly lockedNodes: readonly string[];
  private _state: PartialLockState = 'held';
  private releasing: Promise<void> | undefined;
  private readonly stopListening: () => void;

  /** @internal Created by partialLock(). */
  constructor(
    private readonly ctx: ExtensionContext,
    granted: Granted,
    /** The caller's timeout without its signal: dispose must run even after an abort. */
    private readonly cleanup: RpcOptions,
  ) {
    this.lockId = granted.lockId;
    this.lockedNodes = Object.freeze([...granted.lockedNodes]);
    this.stopListening = ctx.onClosed(() => this.settle('closed'));
  }

  /**
   * - `held`: the lock is in place
   * - `unlocked`: released by unlock() or dispose
   * - `closed`: the session ended, which released it on the server
   */
  get state(): PartialLockState {
    return this._state;
  }

  /**
   * Send `<partial-unlock>`. Does nothing once the lock is released or the
   * session has closed, and shares the request with an unlock in progress.
   */
  unlock(options: RpcOptions = {}): Promise<void> {
    if (this._state !== 'held') return Promise.resolve();
    this.releasing ??= this.ctx
      .invoke(partialUnlockRequest({ lockId: this.lockId }), options)
      .then(
        () => this.settle('unlocked'),
        (err: unknown) => {
          // The session closing (before or during the request) released the lock anyway.
          if (err instanceof SessionClosedError) this.settle('closed');
          if (this._state === 'closed') return;
          throw err;
        },
      )
      .finally(() => {
        this.releasing = undefined;
      });
    return this.releasing;
  }

  /** Unlock if still held, ignoring the caller's AbortSignal. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.unlock(this.cleanup);
  }

  private settle(state: Exclude<PartialLockState, 'held'>): void {
    if (this._state !== 'held') return;
    this._state = state;
    this.stopListening();
  }
}

async function takePartialLock(
  ctx: ExtensionContext,
  select: PartialLockSelect | readonly PartialLockSelect[],
  options: RpcOptions,
): Promise<PartialLock> {
  const request = partialLockRequest({ select });
  const cleanup: RpcOptions = options.timeout !== undefined ? { timeout: options.timeout } : {};
  let reply: RpcReply;
  try {
    reply = await ctx.invoke(request, options);
  } catch (err) {
    if (err instanceof RpcError && err.errors.some((e) => e.tag === 'lock-denied' && e.severity === 'error')) {
      throw new PartialLockDeniedError(lockHolder(err), deniedLockId(err), err);
    }
    throw err;
  }
  const { lockId, nodes } = parseGranted(reply, ctx.moduleOf);
  if (lockId === undefined) throw new ProtocolError('partial-lock reply has no valid <lock-id>');
  let lockedNodes: string[];
  try {
    lockedNodes = nodes();
  } catch (err) {
    // We can't describe the lock, so don't leave it held.
    await ctx.invoke(partialUnlockRequest({ lockId }), cleanup).catch((e: unknown) => ctx.logger.warn?.('partial-unlock failed', { err: e }));
    throw err;
  }
  return new PartialLock(ctx, { lockId, lockedNodes }, cleanup);
}

// --- the extension ------------------------------------------------------------------------

/** The RFC 5717 partial-lock extension. Enable it with `connect({ extensions: [partialLock] })`. */
export const partialLock = defineExtension({
  id: 'partialLock',
  /** A one-line summary of the extension. */
  description: 'RFC 5717: lock and unlock parts of the running datastore',
  requires: [PARTIAL_LOCK_CAPABILITY],
  descriptors: [PARTIAL_LOCK, PARTIAL_UNLOCK],
  requests: { 'partial-lock': partialLockRequest, 'partial-unlock': partialUnlockRequest },
  ops: (ctx): PartialLockOps => ({
    lock: (select, options = {}) => takePartialLock(ctx, select, options),
    unlock: async (lockId, options = {}) => {
      await ctx.invoke(partialUnlockRequest({ lockId }), options);
    },
  }),
});
