/**
 * RFC 6241 candidate transactions (design §8): lock, discard, edit, validate,
 * commit (optionally confirmed), unlock, with cleanup that always runs.
 *
 * ```ts
 * import { withCandidate } from '@node-net/netconf';
 *
 * await withCandidate(client, async (txn) => {
 *   await txn.editConfig({ config: x('system', { xmlns: SYS }, x('hostname', 'router1')) });
 * });
 *
 * // A confirmed commit reverts unless confirmed. The candidate stays locked until it settles.
 * const { pending } = await withCandidate(client, (txn) => txn.editConfig({ config }), { confirmed: { timeout: 120 } });
 * if (await stillReachable()) await pending.confirm();
 * else await pending.cancel();
 * ```
 *
 * The order follows RFC 6241 Appendix E.1: lock running, lock the candidate,
 * discard stale candidate edits, edit, validate, commit, then unlock the
 * candidate and running. If anything fails after the locks are taken, the
 * candidate is discarded and the locks are released. Cleanup ignores the
 * caller's AbortSignal, so an aborted transaction still cleans up.
 *
 * Every failure rejects with a TransactionError. Its `phase` says where it
 * failed and its `cause` is the original error. Cleanup failures are listed in
 * `cleanupErrors` and never replace the original error. A lock held by another
 * session rejects with LockDeniedError, which gives the holder's session-id.
 *
 * This is a plain function, not a connect() extension: it adds no RPC and no
 * capability, only an order of base operations.
 */

import { CapabilityError, NetconfError } from '../errors.js';
import { setDeadline, type Deadline } from '../timers.js';
import { NETCONF_NS, RpcError, type RpcContext, type RpcOptions, type RpcReply } from '../messages/index.js';
import { XmlElement } from '../xml/index.js';
import { splitRpcOptions } from './args.js';
import {
  cancelCommit,
  commit,
  discardChanges,
  editConfig,
  getConfig,
  invoke,
  lock,
  unlock,
  validate,
  type CapabilityCheck,
  type EditConfigOptions,
  type Filter,
  type OperationRequest,
} from './base.js';
import { convertJsonArgs, type JsonOptions, type ToXml, type YangJsonObject, type YangJsonValue } from './json.js';

/** A workflow request that succeeded, as reported to an `onStep` listener. */
export interface ConfigureStep {
  /** The operation that succeeded. */
  readonly operation: 'lock' | 'unlock' | 'discard-changes' | 'edit-config' | 'validate' | 'commit' | 'cancel-commit';
  /** The datastore it acted on. commit, discard-changes and cancel-commit act on the candidate. */
  readonly datastore: 'running' | 'candidate';
}

const STEP_OPERATIONS: ReadonlySet<string> = new Set(['lock', 'unlock', 'discard-changes', 'edit-config', 'validate', 'commit', 'cancel-commit']);

/**
 * The step a request is, or undefined for one that isn't a workflow step (such
 * as get-config). The datastore comes from its `<target>` or `<source>`.
 */
function stepOf(element: XmlElement): ConfigureStep | undefined {
  if (element.ns !== NETCONF_NS || !STEP_OPERATIONS.has(element.name)) return undefined;
  const where = element.child('target') ?? element.child('source');
  const named = where?.elements.find((c) => c.name === 'running' || c.name === 'candidate')?.name;
  return { operation: element.name as ConfigureStep['operation'], datastore: named === 'running' ? 'running' : 'candidate' };
}

/** Call an onStep listener, logging rather than throwing if it fails: it only observes. */
function reportStep(onStep: ((step: ConfigureStep) => void) | undefined, step: ConfigureStep | undefined, ctx: { readonly logger: RpcContext['logger'] }): void {
  if (onStep === undefined || step === undefined) return;
  try {
    onStep(step);
  } catch (err) {
    ctx.logger.warn?.('onStep listener threw', { err });
  }
}

/** Where a transaction failed. */
export type TransactionPhase = 'lock' | 'discard' | 'edit' | 'validate' | 'commit' | 'confirm' | 'cancel';

/** A candidate transaction failed. `cause` is the original error; `cleanupErrors` lists any discard or unlock failures after it. */
export class TransactionError extends NetconfError {
  /** `'TransactionError'`, or a subclass's own name. */
  override name = 'TransactionError';
  override readonly code: string = 'ERR_NETCONF_TRANSACTION';
  /** Where the transaction failed: `'lock'`, `'edit'`, `'commit'`, `'confirm'` and so on. */
  readonly phase: TransactionPhase;
  /** Errors from discard-changes or unlock while cleaning up. They never replace the original error. */
  readonly cleanupErrors: readonly unknown[];

  constructor(phase: TransactionPhase, cause: unknown, cleanupErrors: readonly unknown[] = [], message?: string) {
    const reason = cause instanceof Error ? cause.message : cause === undefined ? undefined : JSON.stringify(cause);
    let text = message ?? `Transaction failed at ${phase}${reason !== undefined ? `: ${reason}` : ''}`;
    if (cleanupErrors.length > 0) {
      text += ` (and ${cleanupErrors.length} cleanup step${cleanupErrors.length > 1 ? 's' : ''} failed; see cleanupErrors)`;
    }
    super(text, cause === undefined ? undefined : { cause });
    this.phase = phase;
    this.cleanupErrors = Object.freeze([...cleanupErrors]);
  }
}

/** A lock was refused because another session holds it (`lock-denied`). */
export class LockDeniedError extends TransactionError {
  /** `'LockDeniedError'`. */
  override name = 'LockDeniedError';
  override readonly code: string = 'ERR_NETCONF_LOCK_DENIED';
  /** The datastore that couldn't be locked. */
  readonly datastore: 'running' | 'candidate';
  /** The holder's session-id from `<error-info>`. 0 means a non-NETCONF holder; undefined if the server didn't say. */
  readonly holder: number | undefined;

  constructor(datastore: 'running' | 'candidate', holder: number | undefined, cause: RpcError, cleanupErrors: readonly unknown[] = []) {
    const who = holder === undefined ? 'another session' : holder === 0 ? 'a non-NETCONF entity' : `session ${holder}`;
    super('lock', cause, cleanupErrors, `The ${datastore} datastore is locked by ${who}`);
    this.datastore = datastore;
    this.holder = holder;
  }
}

/** The holder's session-id from a `lock-denied` error, or undefined if absent or not a number. */
export function lockHolder(err: RpcError): number | undefined {
  const detail = err.errors.find((e) => e.tag === 'lock-denied') ?? err.first;
  const text = detail.info?.child('session-id')?.text().trim();
  if (text === undefined || !/^\d+$/.test(text)) return undefined;
  return Number(text);
}

/** The `confirmed` option of {@link withCandidate}, when it is an object. */
export interface ConfirmedCommitOptions {
  /** Seconds before the server reverts an unconfirmed commit. Server default 600. */
  readonly timeout?: number;
  /** Make the confirmed commit outlive this session (`:confirmed-commit:1.1`); confirm and cancel then use this id. */
  readonly persist?: string;
}

/**
 * Options for {@link withCandidate}. `timeout` applies to each request, and
 * `signal` to each one but the cleanup. See [Options](/guide/transactions#options).
 */
export interface TransactionOptions extends RpcOptions {
  /** Lock the datastores for the transaction. Default true. Set false for servers that can't lock. */
  readonly lock?: boolean;
  /** Also lock running, before the candidate (RFC 6241 Appendix E.1). Default true. Ignored when `lock` is false. */
  readonly lockRunning?: boolean;
  /** `'auto'` (default): validate when the server advertises `:validate`. `true` always validates, `false` never. */
  readonly validate?: boolean | 'auto';
  /** Commit as a confirmed commit and return a PendingCommit to confirm or cancel it. `true` uses the server's timeout. */
  readonly confirmed?: boolean | ConfirmedCommitOptions;
  /** How capabilities are checked before sending. Default `'strict'`. Pass the client's policy to match it. */
  readonly capabilityCheck?: CapabilityCheck;
  /**
   * Called as each request succeeds (lock, discard-changes, edit-config,
   * validate, commit, unlock, cancel-commit), including cleanup after a
   * failure. A failed request isn't reported: the rejection says where it
   * failed. A listener that throws is logged and ignored.
   */
  readonly onStep?: (step: ConfigureStep) => void;
}

/** What the callback gets: operations on the locked candidate. */
export interface CandidateTx {
  /** The session the transaction runs on. */
  readonly sessionId: number;
  /**
   * `<edit-config>` on the candidate. `config` may be an RFC 7951 JSON
   * object, converted with the candidate's YANG schema, when the transaction
   * was started with a NetconfClient or an extension context.
   */
  editConfig(options: Omit<EditConfigOptions, 'target'> & { readonly json?: JsonOptions } & RpcOptions): Promise<RpcReply>;
  /** `<get-config>` from the candidate, to see the edits so far. The filter may be an RFC 7951 JSON object, as for `editConfig`. */
  getConfig(options?: { readonly filter?: Filter | YangJsonObject; readonly json?: JsonOptions } & RpcOptions): Promise<XmlElement>;
  /** `<validate>` the candidate now (needs `:validate`). */
  validate(options?: RpcOptions): Promise<RpcReply>;
  /**
   * How the candidate differs from running, as `client.content.getCandidateChanges()`
   * reports it: while the transaction holds its locks, exactly what the
   * commit will apply. Needs the transaction to have been started with a
   * NetconfClient; with a bare session or an extension context it rejects
   * with a TypeError.
   */
  getCandidateChanges(options?: CandidateChangesOptions): Promise<DatastoreChange[]>;
}

/**
 * One difference between two configuration datastores
 * (`client.content.compareDatastores()`): a change that turns the source
 * into the target.
 */
export interface DatastoreChange {
  /**
   * `create`: the node is only in the target. `delete`: only in the source.
   * `replace`: a leaf's value (or anydata's content) changed. `move`: an
   * entry of an ordered-by-user list or leaf-list is in both, in a different place.
   * Nothing inside a created or deleted node is listed separately.
   */
  readonly operation: 'create' | 'delete' | 'replace' | 'move';
  /** The node's RFC 7951 data path, list entries by their keys and leaf-list entries by value: `/ietf-interfaces:interfaces/interface[name='eth0']/mtu`. */
  readonly path: string;
  /** The node as it is in the target (absent for `delete`): a leaf's or leaf-list entry's typed value, a container's or list entry's object. */
  readonly value?: YangJsonValue;
  /** The node as it is in the source, for `delete` and `replace`. */
  readonly previous?: YangJsonValue;
  /** Where a created or moved entry of an ordered-by-user list or leaf-list goes: first, or after the entry at `anchor` (a path). */
  readonly position?:
    | {
        /** First in the list. */
        readonly where: 'first';
      }
    | {
        /** After the entry at `anchor`. */
        readonly where: 'after';
        /** The path of the entry it follows. */
        readonly anchor: string;
      };
}

/** Options for `getCandidateChanges()`. */
export interface CandidateChangesOptions extends RpcOptions {
  /**
   * Compare only part of the configuration: `subtree(...)`, `xpath(...)`
   * (needs `:xpath`), or an RFC 7951 JSON object. The same filter is sent
   * with both reads.
   */
  readonly filter?: Filter | YangJsonObject;
  /** JSON input options for a JSON `filter` (see `JsonOptions`). */
  readonly json?: JsonOptions;
}

/** What a confirmed transaction resolves with. */
export interface ConfirmedTransaction<T> {
  /** The callback's result. */
  readonly result: T;
  /** The confirmed commit: confirm or cancel it before it expires. */
  readonly pending: PendingCommit;
}

/** Anything that carries a session: a NetconfClient, or an RpcContext itself. */
export type TransactionTarget =
  | RpcContext
  | {
      /** The session to run on, as on a NetconfClient. */
      readonly session: RpcContext;
    };

/**
 * Where a transaction's JSON input is converted: the client's
 * `content.toXml`, or an extension context's `toXml`. A bare session has
 * neither, and JSON input then rejects with a TypeError.
 */
function jsonInputOf(target: TransactionTarget, ctx: RpcContext): ToXml {
  const content = (target as { readonly content?: { readonly toXml?: unknown } }).content;
  if (typeof content?.toXml === 'function') return (json, options) => (content.toXml as ToXml)(json, options);
  const own = (ctx as { readonly toXml?: unknown }).toXml;
  if (typeof own === 'function') return own as ToXml;
  return () => Promise.reject(new TypeError('RFC 7951 JSON input in withCandidate needs a NetconfClient or an extension context, not a bare session'));
}

type GetCandidateChanges = (options: CandidateChangesOptions) => Promise<DatastoreChange[]>;

/**
 * Where `txn.getCandidateChanges()` comes from: the client's
 * `content.getCandidateChanges`. This layer can't build the comparison
 * itself, because it needs the client's YANG schemas.
 */
function candidateChangesOf(target: TransactionTarget): GetCandidateChanges {
  const content = (target as { readonly content?: { readonly getCandidateChanges?: unknown } }).content;
  if (typeof content?.getCandidateChanges === 'function') return (options) => (content.getCandidateChanges as GetCandidateChanges).call(content, options);
  return () => Promise.reject(new TypeError('txn.getCandidateChanges() needs withCandidate to be given a NetconfClient, not a bare session or extension context'));
}

/** Default `confirm-timeout` (RFC 6241 §8.4.5.1). */
export const DEFAULT_CONFIRM_TIMEOUT = 600;
/**
 * confirm() is refused when less than this many milliseconds remain. A plain
 * `<commit>` that reaches the server after it has reverted would commit the
 * candidate again rather than fail.
 */
export const CONFIRM_MARGIN_MS = 2000;

type Datastore = 'running' | 'candidate';

/** Sends requests for one transaction: tracks the locks, and whether the session has closed. */
class Runner {
  readonly locked: Datastore[] = [];
  closed = false;
  private readonly stopListening: () => void;

  constructor(
    readonly ctx: RpcContext,
    readonly check: CapabilityCheck,
    readonly rpc: RpcOptions,
    /** The caller's timeout without its signal: cleanup must run even after an abort. */
    readonly cleanup: RpcOptions,
    readonly onStep?: (step: ConfigureStep) => void,
  ) {
    this.stopListening = ctx.onClosed(() => {
      this.closed = true;
    });
  }

  /** Send a request whose capabilities were already checked up front. */
  async send(req: OperationRequest, options: RpcOptions = this.rpc): Promise<RpcReply> {
    const reply = await invoke(this.ctx, req, options, 'off');
    reportStep(this.onStep, stepOf(req.element), this.ctx);
    return reply;
  }

  /** Send a request, checking its capabilities under the transaction's policy. */
  async checked(req: OperationRequest, options: RpcOptions): Promise<RpcReply> {
    const reply = await invoke(this.ctx, req, options, this.check);
    reportStep(this.onStep, stepOf(req.element), this.ctx);
    return reply;
  }

  /** Discard the candidate, collecting a failure rather than throwing. Skipped once the session is gone. */
  async discard(errors: unknown[]): Promise<void> {
    if (this.closed) return;
    try {
      await this.send(discardChanges(), this.cleanup);
    } catch (err) {
      errors.push(err);
    }
  }

  /** Unlock everything locked, newest first, collecting failures. The session's end releases locks by itself. */
  async release(errors: unknown[]): Promise<void> {
    while (this.locked.length > 0) {
      const ds = this.locked.pop()!;
      if (this.closed) continue;
      try {
        await this.send(unlock(ds), this.cleanup);
      } catch (err) {
        errors.push(err);
      }
    }
  }

  /** Release, logging failures instead of returning them: used after an outcome is already decided. */
  async releaseQuietly(extra: unknown[] = []): Promise<void> {
    const errors = [...extra];
    await this.release(errors);
    for (const err of errors) this.ctx.logger.warn?.('Transaction cleanup failed', { err });
    this.stopListening();
  }

  /**
   * Unlock running now, keeping the candidate lock. A confirmed commit's revert
   * (on cancel or timeout) writes running, and a server can be unable to do
   * that while we hold running's lock: netopeer2 then leaves the commit in
   * place for good. Failures are logged, since the commit has already happened.
   */
  async releaseRunning(): Promise<void> {
    const i = this.locked.indexOf('running');
    if (i < 0 || this.closed) return;
    this.locked.splice(i, 1);
    try {
      await this.send(unlock('running'), this.cleanup);
    } catch (err) {
      this.ctx.logger.warn?.('Transaction cleanup failed', { err });
    }
  }

  done(): void {
    this.stopListening();
  }
}

/**
 * Run `fn` in an RFC 6241 candidate transaction and commit it as a confirmed
 * commit. Resolves with a {@link ConfirmedTransaction} holding what `fn`
 * returned, to confirm or cancel before it expires. See
 * [Confirmed commits](/guide/transactions#confirmed-commits).
 */
export function withCandidate<T>(
  target: TransactionTarget,
  fn: (txn: CandidateTx) => T | Promise<T>,
  options: TransactionOptions & { readonly confirmed: true | ConfirmedCommitOptions },
): Promise<ConfirmedTransaction<T>>;
/** Run `fn` in a candidate transaction and commit it. Resolves with what `fn` returns. */
export function withCandidate<T>(
  target: TransactionTarget,
  fn: (txn: CandidateTx) => T | Promise<T>,
  options?: TransactionOptions & { readonly confirmed?: false },
): Promise<T>;
/**
 * Run `fn` in a candidate transaction and commit it, confirmed when
 * `options.confirmed` says so: resolves with a {@link ConfirmedTransaction}
 * then, and with what `fn` returns otherwise.
 */
export function withCandidate<T>(
  target: TransactionTarget,
  fn: (txn: CandidateTx) => T | Promise<T>,
  options?: TransactionOptions,
): Promise<T | ConfirmedTransaction<T>>;
export async function withCandidate<T>(
  target: TransactionTarget,
  fn: (txn: CandidateTx) => T | Promise<T>,
  options: TransactionOptions = {},
): Promise<T | ConfirmedTransaction<T>> {
  // --- local checks: nothing is sent if any of these fail -----------------------------------
  if (typeof fn !== 'function') throw new TypeError('withCandidate: the transaction must be a function');
  const ctx = 'session' in target ? target.session : target;
  const toXml = jsonInputOf(target, ctx);
  const candidateChanges = candidateChangesOf(target);
  const { rpc } = splitRpcOptions(options);
  const { timeout } = rpc;
  const check = options.capabilityCheck ?? 'strict';
  const locking = bool(options.lock, 'lock', true);
  const lockRunning = locking && bool(options.lockRunning, 'lockRunning', true);
  const validateOption = options.validate ?? 'auto';
  if (validateOption !== 'auto' && typeof validateOption !== 'boolean') {
    throw new TypeError("withCandidate: validate must be true, false or 'auto'");
  }
  const confirmed = confirmedOptions(options.confirmed);
  // Built now so a bad confirm timeout throws before anything is sent.
  const commitRequest = commit(
    confirmed === undefined
      ? {}
      : {
          confirmed: true,
          ...(confirmed.timeout !== undefined ? { confirmTimeout: confirmed.timeout } : {}),
          ...(confirmed.persist !== undefined ? { persist: confirmed.persist } : {}),
        },
  );

  const caps = ctx.serverCapabilities;
  requireCapability(ctx, check, ':candidate', 'withCandidate');
  if (validateOption === true) requireCapability(ctx, check, ':validate', 'withCandidate with validate');
  for (const cap of commitRequest.requires) requireCapability(ctx, check, cap, 'withCandidate with a confirmed commit');
  const validating = validateOption === 'auto' ? caps.has(':validate') : validateOption;

  if (options.onStep !== undefined && typeof options.onStep !== 'function') throw new TypeError('withCandidate: onStep must be a function');
  const runner = new Runner(ctx, check, rpc, timeout !== undefined ? { timeout } : {}, options.onStep);

  // --- locks ----------------------------------------------------------------------------------
  if (locking) {
    for (const ds of lockRunning ? (['running', 'candidate'] as const) : (['candidate'] as const)) {
      try {
        await runner.send(lock(ds));
        runner.locked.push(ds);
      } catch (err) {
        const cleanupErrors: unknown[] = [];
        await runner.release(cleanupErrors);
        runner.done();
        if (err instanceof RpcError && err.tag === 'lock-denied') throw new LockDeniedError(ds, lockHolder(err), err, cleanupErrors);
        throw new TransactionError('lock', err, cleanupErrors);
      }
    }
  }

  // --- discard, edit, validate, commit ----------------------------------------------------------
  let phase: TransactionPhase = 'discard';
  let open = true;
  const ensureOpen = (): void => {
    if (!open) throw new TransactionError('edit', undefined, [], 'The transaction has ended; its txn can no longer be used');
  };
  const txn: CandidateTx = {
    sessionId: ctx.sessionId,
    editConfig: async (edit) => {
      ensureOpen();
      const { rpc: call, rest: given } = splitRpcOptions(edit as Omit<EditConfigOptions, 'target'> & RpcOptions & { target?: unknown; json?: JsonOptions });
      const { json, ...rest } = given;
      if (rest.target !== undefined) throw new TypeError('txn.editConfig always edits the candidate; leave out target');
      const args = await convertJsonArgs(toXml, rest, { config: 'candidate' }, json);
      return runner.checked(editConfig({ ...args, target: 'candidate' }), { ...rpc, ...call });
    },
    getConfig: async (read = {}) => {
      ensureOpen();
      const { rpc: call, rest: given } = splitRpcOptions(read);
      const { json, ...rest } = given;
      const args = await convertJsonArgs(toXml, rest, { filter: 'candidate' }, json);
      const reply = await runner.checked(getConfig({ ...args, source: 'candidate' }), { ...rpc, ...call });
      return reply.data ?? new XmlElement({ name: 'data', ns: NETCONF_NS });
    },
    validate: async (opts = {}) => {
      ensureOpen();
      return runner.checked(validate('candidate'), { ...rpc, ...splitRpcOptions(opts).rpc });
    },
    getCandidateChanges: async (opts = {}) => {
      ensureOpen();
      const { rpc: call, rest } = splitRpcOptions(opts);
      return candidateChanges({ ...rest, ...rpc, ...call });
    },
  };

  let result: T;
  try {
    await runner.send(discardChanges());
    phase = 'edit';
    result = await fn(txn);
    open = false;
    if (validating) {
      phase = 'validate';
      await runner.send(validate('candidate'));
    }
    phase = 'commit';
    await runner.send(commitRequest);
  } catch (err) {
    open = false;
    const cleanupErrors: unknown[] = [];
    await runner.discard(cleanupErrors);
    await runner.release(cleanupErrors);
    runner.done();
    throw new TransactionError(phase, err, cleanupErrors);
  }

  if (confirmed === undefined) {
    await runner.releaseQuietly();
    return result;
  }
  const pending = new PendingCommit(runner, confirmed);
  await runner.releaseRunning();
  return { result, pending };
}

/** Where a {@link PendingCommit} stands; see {@link PendingCommit.state}. */
export type PendingCommitState = 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'closed';

/**
 * A confirmed commit waiting for confirmation (RFC 6241 §8.4). The server
 * reverts it unless confirm() reaches it before `expires`.
 *
 * The candidate lock is held until it is confirmed, cancelled, expires or the
 * session closes, so no other session can edit the candidate and commit it
 * (which would confirm ours early). The running lock is released as soon as the
 * confirmed commit succeeds: the server's revert writes running, and holding
 * running's lock can stop it (netopeer2 then keeps the commit for good).
 *
 * `await using pending = …` cancels it on scope exit if it is still pending.
 */
export class PendingCommit implements AsyncDisposable {
  /** The persist id, when the commit was made with `persist` (it then outlives the session). */
  readonly persistId: string | undefined;
  /** When the server reverts the commit, measured on this machine from when the commit succeeded. */
  readonly expires: Date;
  private _state: PendingCommitState = 'pending';
  private busy: Promise<void> | undefined;
  private readonly timer: Deadline;
  private readonly stopListening: () => void;

  /** @internal Created by withCandidate(). */
  constructor(
    private readonly runner: Runner,
    options: ConfirmedCommitOptions,
  ) {
    this.persistId = options.persist;
    const ms = (options.timeout ?? DEFAULT_CONFIRM_TIMEOUT) * 1000;
    this.expires = new Date(Date.now() + ms);
    // A deadline, not a timer: a confirm-timeout can be far longer than a timer allows.
    this.timer = setDeadline(this.expires.getTime(), () => void this.expire());
    this.stopListening = runner.ctx.onClosed(() => this.settle('closed'));
  }

  /**
   * - `pending`: waiting for confirm() or cancel()
   * - `confirmed`, `cancelled`: settled by this handle
   * - `expired`: the timeout passed and the server reverted the commit
   * - `closed`: the session ended. The server reverted the commit unless it was
   *   made with `persist`; a persistent one can still be confirmed or cancelled
   *   from another session with `client.ops.commit({ persistId })` or
   *   `client.ops.cancelCommit({ persistId })`.
   */
  get state(): PendingCommitState {
    return this._state;
  }

  /**
   * Confirm the commit with `<commit>` (carrying `<persist-id>` if it was made with
   * `persist`), then release the locks. Refused locally once settled, or when
   * less than CONFIRM_MARGIN_MS remain before it expires.
   */
  confirm(options: RpcOptions = {}): Promise<void> {
    return this.act('confirm', async () => {
      if (this.expires.getTime() - Date.now() < CONFIRM_MARGIN_MS) {
        throw new TransactionError('confirm', undefined, [], 'The confirmed commit is about to expire or has expired; it was not confirmed');
      }
      await this.runner.send(commit(this.persistId !== undefined ? { persistId: this.persistId } : {}), options);
      this.settle('confirmed');
      await this.runner.releaseQuietly();
    });
  }

  /**
   * Revert the commit now with `<cancel-commit>` (needs `:confirmed-commit:1.1`),
   * discard the candidate and release the locks.
   */
  cancel(options: RpcOptions = {}): Promise<void> {
    return this.act('cancel', async () => {
      const req = cancelCommit(this.persistId !== undefined ? { persistId: this.persistId } : {});
      await this.runner.checked(req, options);
      this.settle('cancelled');
      const errors: unknown[] = [];
      await this.runner.discard(errors);
      await this.runner.releaseQuietly(errors);
    });
  }

  /** Cancel if still pending. */
  async [Symbol.asyncDispose](): Promise<void> {
    if (this.busy !== undefined) await this.busy.catch(() => undefined);
    if (this._state === 'pending') await this.cancel();
  }

  private act(phase: 'confirm' | 'cancel', run: () => Promise<void>): Promise<void> {
    if (this._state !== 'pending') {
      return Promise.reject(new TransactionError(phase, undefined, [], `The confirmed commit is already ${this._state}`));
    }
    if (this.busy !== undefined) {
      return Promise.reject(new TransactionError(phase, undefined, [], 'A confirm or cancel is already in progress'));
    }
    const work = run().catch((err: unknown) => {
      if (err instanceof TransactionError || err instanceof CapabilityError) throw err;
      throw new TransactionError(phase, err);
    });
    this.busy = work.finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }

  private async expire(): Promise<void> {
    // A confirm or cancel already on the wire decides the outcome; wait for it rather than race it.
    if (this.busy !== undefined) await this.busy.catch(() => undefined);
    if (this._state !== 'pending') return;
    // The server has reverted running. Clear our edits from the candidate too, so
    // nobody can commit them by accident, and release the locks.
    this.settle('expired');
    const errors: unknown[] = [];
    await this.runner.discard(errors);
    await this.runner.releaseQuietly(errors);
  }

  private settle(state: Exclude<PendingCommitState, 'pending'>): void {
    if (this._state !== 'pending') return;
    this._state = state;
    this.timer.cancel();
    this.stopListening();
    if (state === 'closed') this.runner.done();
  }
}

// --- helpers -----------------------------------------------------------------------------------

function bool(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`withCandidate: ${name} must be a boolean`);
  return value;
}

function confirmedOptions(value: TransactionOptions['confirmed']): ConfirmedCommitOptions | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return {};
  if (typeof value !== 'object' || value === null) throw new TypeError('withCandidate: confirmed must be true or { timeout?, persist? }');
  if (value.persist !== undefined && (typeof value.persist !== 'string' || value.persist === '')) {
    throw new TypeError('withCandidate: confirmed.persist must be a non-empty string');
  }
  return value;
}

function requireCapability(ctx: RpcContext, check: CapabilityCheck, cap: string, what: string): void {
  if (check === 'off' || ctx.serverCapabilities.has(cap)) return;
  if (check === 'strict') throw new CapabilityError(cap, what);
  ctx.logger.warn?.(`${what} needs ${cap}, which the server didn't advertise; continuing anyway`);
}

