/**
 * The transaction module (OPS-21): withCandidate and PendingCommit, against the fake server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_1_0,
  BASE_1_1,
  CapabilityError,
  connect,
  NETCONF_NS,
  RpcError,
  serializeXml,
  subtree,
  x,
  type NetconfClient,
  type XmlElement,
} from '../../src/index.js';
import {
  CONFIRM_MARGIN_MS,
  LockDeniedError,
  TransactionError,
  lockHolder,
  withCandidate,
} from '../../src/operations/transaction.js';
import { FakeServer, type RpcErrorSpec, type RpcHandler } from '../../src/testing/index.js';

const CAP = (n: string): string => `urn:ietf:params:netconf:capability:${n}`;
const FULL = [BASE_1_0, BASE_1_1, CAP('candidate:1.0'), CAP('validate:1.1'), CAP('confirmed-commit:1.1')];
const EX = 'urn:example:tx';
const config = x('top', { xmlns: EX }, x('leaf', 'v'));

async function open(handler: RpcHandler = () => 'ok', capabilities = FULL) {
  const fake = new FakeServer({ capabilities, handler, sessionId: 7 });
  const client = await connect({ transport: fake.transport() });
  return { fake, client };
}

const ops = (fake: FakeServer): string[] => fake.requests.map((r) => r.elements[0]!.name);
const op = (fake: FakeServer, i: number): XmlElement => fake.requests[i]!.elements[0]!;
const target = (el: XmlElement): string | undefined => el.child('target')?.elements[0]?.name;
const fail = (tag: string, extra: Partial<RpcErrorSpec> = {}) => ({ errors: [{ type: 'protocol' as const, tag, ...extra }] });

/** A handler that fails the named operations (optionally only for one target datastore). */
function failing(rules: Record<string, ReturnType<typeof fail>>, onTarget?: string): RpcHandler {
  return (_rpc, { operation }) => {
    const name = operation?.name ?? '';
    if (rules[name] !== undefined && (onTarget === undefined || target(operation!) === onTarget)) return rules[name];
    return 'ok';
  };
}

let clients: NetconfClient[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  clients = [];
});
async function client(handler?: RpcHandler, capabilities?: string[]) {
  const o = await open(handler, capabilities);
  clients.push(o.client);
  return o;
}

describe('withCandidate (OPS-21)', () => {
  it('locks running then candidate, discards, edits, validates, commits, unlocks in reverse, and returns the result', async () => {
    const { fake, client: c } = await client();
    const result = await withCandidate(c, async (txn) => {
      expect(txn.sessionId).toBe(7);
      await txn.editConfig({ config, defaultOperation: 'merge' });
      return 42;
    });
    expect(result).toBe(42);
    expect(ops(fake)).toEqual(['lock', 'lock', 'discard-changes', 'edit-config', 'validate', 'commit', 'unlock', 'unlock']);
    expect(fake.requests.map((r) => target(r.elements[0]!))).toEqual(['running', 'candidate', undefined, 'candidate', undefined, undefined, 'candidate', 'running']);
    expect(serializeXml(op(fake, 3))).toBe(
      `<edit-config xmlns="${NETCONF_NS}"><target><candidate/></target><default-operation>merge</default-operation>` +
        `<config><top xmlns="${EX}"><leaf>v</leaf></top></config></edit-config>`,
    );
    expect(op(fake, 4).path('source/candidate')).toBeDefined();
  });

  it('takes an RpcContext as well as a client, and lockRunning: false locks only the candidate', async () => {
    const { fake, client: c } = await client();
    await withCandidate(c.session, (txn) => txn.editConfig({ config }), { lockRunning: false });
    expect(ops(fake)).toEqual(['lock', 'discard-changes', 'edit-config', 'validate', 'commit', 'unlock']);
  });

  it('lock: false sends no lock or unlock', async () => {
    const { fake, client: c } = await client();
    await withCandidate(c, (txn) => txn.editConfig({ config }), { lock: false });
    expect(ops(fake)).toEqual(['discard-changes', 'edit-config', 'validate', 'commit']);
  });

  it('validates only when :validate is advertised, unless forced or turned off', async () => {
    const noValidate = [BASE_1_0, BASE_1_1, CAP('candidate:1.0')];
    const a = await client(undefined, noValidate);
    await withCandidate(a.client, (txn) => txn.editConfig({ config }));
    expect(ops(a.fake)).not.toContain('validate');

    const b = await client();
    await withCandidate(b.client, (txn) => txn.editConfig({ config }), { validate: false });
    expect(ops(b.fake)).not.toContain('validate');

    const d = await client(undefined, noValidate);
    await expect(withCandidate(d.client, () => undefined, { validate: true })).rejects.toBeInstanceOf(CapabilityError);
    expect(d.fake.requests).toHaveLength(0);
  });

  it('txn.getConfig reads the candidate and txn.validate validates it', async () => {
    const { fake, client: c } = await client((_rpc, { operation }) =>
      operation?.name === 'get-config' ? { data: x('top', { xmlns: EX }) } : 'ok',
    );
    await withCandidate(c, async (txn) => {
      const data = await txn.getConfig({ filter: subtree(x('top', { xmlns: EX })) });
      expect(data.child('top', EX)).toBeDefined();
      await txn.validate();
    });
    expect(op(fake, 3).path('source/candidate')).toBeDefined();
    expect(op(fake, 3).child('filter')).toBeDefined();
    expect(ops(fake).filter((n) => n === 'validate')).toHaveLength(2);
  });

  describe('refusals before anything is sent', () => {
    it('refuses a server without :candidate with CapabilityError', async () => {
      const { fake, client: c } = await client(undefined, [BASE_1_0, BASE_1_1, CAP('writable-running:1.0')]);
      const err = await withCandidate(c, () => undefined).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CapabilityError);
      expect((err as CapabilityError).capability).toBe(':candidate');
      expect(fake.requests).toHaveLength(0);
    });

    it('refuses confirmed without :confirmed-commit, and persist without :confirmed-commit:1.1', async () => {
      const { fake, client: c } = await client(undefined, [BASE_1_0, BASE_1_1, CAP('candidate:1.0')]);
      await expect(withCandidate(c, () => undefined, { confirmed: true })).rejects.toThrow(/:confirmed-commit/);
      const v10 = await client(undefined, [BASE_1_0, BASE_1_1, CAP('candidate:1.0'), CAP('confirmed-commit:1.0')]);
      const err = await withCandidate(v10.client, () => undefined, { confirmed: { persist: 'p' } }).catch((e: unknown) => e);
      expect((err as CapabilityError).capability).toBe(':confirmed-commit:1.1');
      expect(fake.requests).toHaveLength(0);
      expect(v10.fake.requests).toHaveLength(0);
    });

    it("capabilityCheck: 'warn' logs and continues", async () => {
      const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
      const warn = vi.fn();
      const c = await connect({ transport: fake.transport(), logger: { warn } });
      clients.push(c);
      await withCandidate(c, () => undefined, { capabilityCheck: 'warn', validate: false });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(':candidate'));
      expect(ops(fake)).toContain('commit');
    });

    it('rejects bad options with TypeError', async () => {
      const { fake, client: c } = await client();
      await expect(withCandidate(c, () => undefined, { lock: 'yes' as never })).rejects.toBeInstanceOf(TypeError);
      await expect(withCandidate(c, () => undefined, { validate: 'maybe' as never })).rejects.toBeInstanceOf(TypeError);
      await expect(withCandidate(c, () => undefined, { confirmed: { persist: '' } })).rejects.toBeInstanceOf(TypeError);
      await expect(withCandidate(c, () => undefined, { confirmed: { timeout: 0 } })).rejects.toBeInstanceOf(RangeError);
      await expect(withCandidate(c, 'nope' as never)).rejects.toBeInstanceOf(TypeError);
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe('failures and cleanup', () => {
    it('a failing callback discards and unlocks, rejecting with phase edit and the original cause', async () => {
      const { fake, client: c } = await client();
      const boom = new Error('boom');
      const err = await withCandidate(c, () => {
        throw boom;
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).phase).toBe('edit');
      expect((err as TransactionError).cause).toBe(boom);
      expect((err as TransactionError).cleanupErrors).toEqual([]);
      expect((err as TransactionError).message).toContain('boom');
      expect(ops(fake)).toEqual(['lock', 'lock', 'discard-changes', 'discard-changes', 'unlock', 'unlock']);
    });

    it.each([
      ['edit-config', 'edit'],
      ['validate', 'validate'],
      ['commit', 'commit'],
    ] as const)('a failing %s rejects with phase %s', async (name, phase) => {
      const { fake, client: c } = await client(failing({ [name]: fail('operation-failed', { type: 'application', message: 'nope' }) }));
      const err = await withCandidate(c, (txn) => txn.editConfig({ config })).catch((e: unknown) => e);
      expect((err as TransactionError).phase).toBe(phase);
      expect((err as TransactionError).cause).toBeInstanceOf(RpcError);
      expect(ops(fake).slice(-3)).toEqual(['discard-changes', 'unlock', 'unlock']);
    });

    it('a failing initial discard rejects with phase discard', async () => {
      let first = true;
      const { client: c } = await client((_rpc, { operation }) => {
        if (operation?.name === 'discard-changes' && first) {
          first = false;
          return fail('operation-failed');
        }
        return 'ok';
      });
      const err = await withCandidate(c, () => undefined).catch((e: unknown) => e);
      expect((err as TransactionError).phase).toBe('discard');
    });

    it('cleanup failures are attached and never replace the original error', async () => {
      const { fake, client: c } = await client(
        failing({ commit: fail('operation-failed', { message: 'commit refused' }), unlock: fail('operation-failed', { message: 'unlock refused' }) }),
      );
      const err = await withCandidate(c, (txn) => txn.editConfig({ config })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransactionError);
      const t = err as TransactionError;
      expect(t.phase).toBe('commit');
      expect((t.cause as RpcError).message).toContain('commit refused');
      expect(t.cleanupErrors).toHaveLength(2); // both unlocks failed
      expect(t.message).toMatch(/2 cleanup steps failed/);
      // Both unlocks were still attempted, candidate first.
      expect(ops(fake).slice(-2)).toEqual(['unlock', 'unlock']);
    });

    it('an aborted transaction still discards and unlocks (cleanup ignores the signal)', async () => {
      const ac = new AbortController();
      const { fake, client: c } = await client();
      const err = await withCandidate(
        c,
        async (txn) => {
          ac.abort();
          await txn.editConfig({ config });
        },
        { signal: ac.signal },
      ).catch((e: unknown) => e);
      expect((err as TransactionError).phase).toBe('edit');
      expect(ops(fake).slice(-3)).toEqual(['discard-changes', 'unlock', 'unlock']);
    });

    it('txn can not be used after the transaction ends', async () => {
      const { client: c } = await client();
      let saved: Parameters<Parameters<typeof withCandidate>[1]>[0] | undefined;
      await withCandidate(c, (txn) => {
        saved = txn;
      });
      await expect(saved!.editConfig({ config })).rejects.toThrow(/transaction has ended/);
    });

    it('skips cleanup RPCs once the session has closed', async () => {
      const { fake, client: c } = await client((_rpc, { operation, server }) => {
        if (operation?.name === 'commit') {
          server.end();
          return undefined;
        }
        return 'ok';
      });
      const err = await withCandidate(c, (txn) => txn.editConfig({ config })).catch((e: unknown) => e);
      expect((err as TransactionError).phase).toBe('commit');
      expect((err as TransactionError).cleanupErrors).toEqual([]);
      expect(ops(fake).at(-1)).toBe('commit');
    });
  });

  describe('lock contention', () => {
    const denied = (holder?: string) =>
      fail('lock-denied', {
        message: 'Lock failed, lock is already held',
        ...(holder !== undefined ? { info: [x('session-id', { xmlns: NETCONF_NS }, holder)] } : {}),
      });

    it('a held running lock rejects with LockDeniedError naming the holder, and sends nothing else', async () => {
      const { fake, client: c } = await client(failing({ lock: denied('12') }, 'running'));
      const err = await withCandidate(c, () => undefined).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LockDeniedError);
      expect(err).toBeInstanceOf(TransactionError);
      const l = err as LockDeniedError;
      expect(l.phase).toBe('lock');
      expect(l.datastore).toBe('running');
      expect(l.holder).toBe(12);
      expect(l.code).toBe('ERR_NETCONF_LOCK_DENIED');
      expect(l.message).toBe('The running datastore is locked by session 12');
      expect(l.cause).toBeInstanceOf(RpcError);
      expect(ops(fake)).toEqual(['lock']);
    });

    it('a held candidate lock releases running first', async () => {
      const { fake, client: c } = await client(failing({ lock: denied('0') }, 'candidate'));
      const err = (await withCandidate(c, () => undefined).catch((e: unknown) => e)) as LockDeniedError;
      expect(err.datastore).toBe('candidate');
      expect(err.holder).toBe(0);
      expect(err.message).toContain('non-NETCONF');
      expect(ops(fake)).toEqual(['lock', 'lock', 'unlock']);
      expect(target(op(fake, 2))).toBe('running');
    });

    it('holder is undefined when error-info has no session-id', async () => {
      const { client: c } = await client(failing({ lock: denied() }));
      const err = (await withCandidate(c, () => undefined).catch((e: unknown) => e)) as LockDeniedError;
      expect(err.holder).toBeUndefined();
      expect(lockHolder(err.cause as RpcError)).toBeUndefined();
    });

    it('any other lock failure is a TransactionError in phase lock', async () => {
      const { client: c } = await client(failing({ lock: fail('access-denied') }));
      const err = await withCandidate(c, () => undefined).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(LockDeniedError);
      expect((err as TransactionError).phase).toBe('lock');
    });
  });
});

describe('confirmed commit (PendingCommit)', () => {
  it('commits confirmed, holds the locks, and confirm() commits again then unlocks', async () => {
    const { fake, client: c } = await client();
    const { result, pending } = await withCandidate(c, (txn) => txn.editConfig({ config }).then(() => 'done'), { confirmed: { timeout: 120 } });
    expect(result).toBe('done');
    expect(serializeXml(op(fake, 5))).toBe(`<commit xmlns="${NETCONF_NS}"><confirmed/><confirm-timeout>120</confirm-timeout></commit>`);
    // Running is unlocked at once (the server's revert writes running); the candidate stays locked.
    expect(ops(fake).slice(-2)).toEqual(['commit', 'unlock']);
    expect(target(op(fake, 6))).toBe('running');
    expect(pending.state).toBe('pending');
    expect(pending.persistId).toBeUndefined();
    expect(pending.expires.getTime() - Date.now()).toBeGreaterThan(110_000);

    await pending.confirm();
    expect(pending.state).toBe('confirmed');
    expect(ops(fake).slice(-2)).toEqual(['commit', 'unlock']);
    expect(target(op(fake, 8))).toBe('candidate');
    expect(serializeXml(op(fake, 7))).toBe(`<commit xmlns="${NETCONF_NS}"/>`);
    await expect(pending.confirm()).rejects.toThrow(/already confirmed/);
  });

  it('with persist, confirm and cancel carry the persist-id', async () => {
    const a = await client();
    const one = await withCandidate(a.client, () => undefined, { confirmed: { persist: 'p1' } });
    expect(op(a.fake, 4).child('persist')?.text()).toBe('p1');
    expect(one.pending.persistId).toBe('p1');
    await one.pending.confirm();
    expect(op(a.fake, 6).child('persist-id')?.text()).toBe('p1');

    const b = await client();
    const two = await withCandidate(b.client, () => undefined, { confirmed: { persist: 'p2' } });
    await two.pending.cancel();
    expect(two.pending.state).toBe('cancelled');
    expect(ops(b.fake).slice(-3)).toEqual(['cancel-commit', 'discard-changes', 'unlock']);
    expect(op(b.fake, 6).child('persist-id')?.text()).toBe('p2');
  });

  it('cancel() needs :confirmed-commit:1.1 and refuses locally without it', async () => {
    const { fake, client: c } = await client(undefined, [BASE_1_0, BASE_1_1, CAP('candidate:1.0'), CAP('confirmed-commit:1.0')]);
    const { pending } = await withCandidate(c, () => undefined, { confirmed: true });
    const before = fake.requests.length;
    await expect(pending.cancel()).rejects.toBeInstanceOf(CapabilityError);
    expect(fake.requests).toHaveLength(before);
    expect(pending.state).toBe('pending');
    await pending.confirm();
  });

  it('a failed confirm stays pending and reports phase confirm', async () => {
    let commits = 0;
    const { client: c } = await client((_rpc, { operation }) => {
      if (operation?.name === 'commit' && ++commits === 2) return fail('operation-failed');
      return 'ok';
    });
    const { pending } = await withCandidate(c, () => undefined, { confirmed: true });
    const err = await pending.confirm().catch((e: unknown) => e);
    expect((err as TransactionError).phase).toBe('confirm');
    expect(pending.state).toBe('pending');
    await pending.confirm();
    expect(pending.state).toBe('confirmed');
  });

  it('a failed confirmed commit discards and unlocks like any commit failure', async () => {
    const { fake, client: c } = await client(failing({ commit: fail('operation-failed') }));
    const err = await withCandidate(c, () => undefined, { confirmed: true }).catch((e: unknown) => e);
    expect((err as TransactionError).phase).toBe('commit');
    expect(ops(fake).slice(-3)).toEqual(['discard-changes', 'unlock', 'unlock']);
  });

  it('refuses a second confirm or cancel while one is in flight', async () => {
    const { client: c } = await client();
    const { pending } = await withCandidate(c, () => undefined, { confirmed: true });
    const first = pending.confirm();
    await expect(pending.cancel()).rejects.toThrow(/in progress/);
    await first;
  });

  it('expires: discards, unlocks, and confirm() is then refused locally', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { fake, client: c } = await client();
    const { pending } = await withCandidate(c, () => undefined, { confirmed: { timeout: 30 } });
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(ops(fake).slice(-3)).toEqual(['unlock', 'discard-changes', 'unlock']));
    expect(target(op(fake, fake.requests.length - 1))).toBe('candidate');
    expect(pending.state).toBe('expired');
    const before = fake.requests.length;
    await expect(pending.confirm()).rejects.toThrow(/already expired/);
    expect(fake.requests).toHaveLength(before);
  });

  it('expiry waits for a cancel already in flight instead of racing it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { fake, client: c } = await client(async (_rpc, { operation }) => {
      if (operation?.name === 'cancel-commit') await gate;
      return 'ok' as const;
    });
    const { pending } = await withCandidate(c, () => undefined, { confirmed: { timeout: 30 } });
    const cancelling = pending.cancel();
    await vi.advanceTimersByTimeAsync(30_000); // the timer fires while cancel-commit is unanswered
    vi.useRealTimers();
    release();
    await cancelling;
    await vi.waitFor(() => expect(ops(fake).at(-1)).toBe('unlock'));
    expect(pending.state).toBe('cancelled');
    expect(ops(fake).slice(-3)).toEqual(['cancel-commit', 'discard-changes', 'unlock']);
  });

  it(`refuses confirm() within ${CONFIRM_MARGIN_MS} ms of expiry rather than risk committing again`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { fake, client: c } = await client();
    const { pending } = await withCandidate(c, () => undefined, { confirmed: { timeout: 10 } });
    vi.setSystemTime(Date.now() + 9_000);
    const before = fake.requests.length;
    await expect(pending.confirm()).rejects.toThrow(/about to expire/);
    expect(fake.requests).toHaveLength(before);
    expect(pending.state).toBe('pending');
  });

  it('becomes closed when the session ends', async () => {
    const { client: c } = await client();
    const { pending } = await withCandidate(c, () => undefined, { confirmed: true });
    await c.close();
    expect(pending.state).toBe('closed');
    await expect(pending.confirm()).rejects.toThrow(/already closed/);
  });

  it('await using cancels a pending commit on scope exit, and leaves a settled one alone', async () => {
    const { fake, client: c } = await client();
    {
      await using pending = (await withCandidate(c, () => undefined, { confirmed: true })).pending;
      expect(pending.state).toBe('pending');
    }
    expect(ops(fake).slice(-3)).toEqual(['cancel-commit', 'discard-changes', 'unlock']);

    const count = fake.requests.length;
    {
      await using pending = (await withCandidate(c, () => undefined, { confirmed: true })).pending;
      await pending.confirm();
    }
    expect(ops(fake).slice(count)).toEqual(['lock', 'lock', 'discard-changes', 'validate', 'commit', 'unlock', 'commit', 'unlock']);
  });

  it('unlock failures after a confirm are logged, not thrown', async () => {
    const fake = new FakeServer({ capabilities: FULL, handler: failing({ unlock: fail('operation-failed') }) });
    const warn = vi.fn();
    const c = await connect({ transport: fake.transport(), logger: { warn } });
    clients.push(c);
    const { pending } = await withCandidate(c, () => undefined, { confirmed: true });
    await pending.confirm();
    expect(pending.state).toBe('confirmed');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('onStep (CONTENT-06)', () => {
  it('reports txn requests and the confirmed commit, confirm and cancel; not get-config', async () => {
    const { client: c } = await client();
    const steps: string[] = [];
    const onStep = (s: { operation: string; datastore: string }): void => void steps.push(`${s.operation} ${s.datastore}`);
    const { pending } = await withCandidate(c, async (txn) => {
      await txn.editConfig({ config });
      await txn.getConfig();
      await txn.validate();
    }, { confirmed: true, onStep });
    expect(steps).toEqual([
      'lock running', 'lock candidate', 'discard-changes candidate', 'edit-config candidate', 'validate candidate',
      'validate candidate', 'commit candidate', 'unlock running',
    ]);
    steps.length = 0;
    await pending.cancel();
    expect(steps).toEqual(['cancel-commit candidate', 'discard-changes candidate', 'unlock candidate']);
  });

  it('rejects a non-function before sending', async () => {
    const { fake, client: c } = await client();
    await expect(withCandidate(c, () => undefined, { onStep: 1 as never })).rejects.toThrow(/onStep must be a function/);
    expect(fake.requests).toHaveLength(0);
  });
});
