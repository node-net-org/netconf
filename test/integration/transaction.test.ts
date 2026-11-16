/**
 * The transaction module (OPS-21) against netopeer2, which advertises
 * :candidate, :confirmed-commit:1.1 and :validate:1.1.
 *
 *   scripts/netopeer2.sh start
 *   npm run test:integration
 *
 * The NACM groups list is the test data. Skipped unless NETOPEER2_PORT is set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, NETCONF_NS, RpcError, ssh, subtree, withClient, x, type ConnectOptions, type NetconfClient } from '../../src/index.js';
import { LockDeniedError, TransactionError, withCandidate } from '../../src/operations/transaction.js';

const PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);
const NACM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-acm';
const GROUPS = ['nn-tx-ok', 'nn-tx-bad', 'nn-tx-confirm', 'nn-tx-cancel', 'nn-tx-expire', 'nn-tx-persist', 'nn-tx-path'];

let fingerprint = '';

const options = (): ConnectOptions => ({
  transport: ssh({ host: '127.0.0.1', port: PORT, username: 'netconf', password: 'netconf', hostKey: fingerprint }),
  timeouts: { rpc: 10_000 },
});

const group = (name: string, ...users: string[]) =>
  x('nacm', { xmlns: NACM }, x('groups', x('group', x('name', name), users.map((u) => x('user-name', u)))));

async function groupNames(s: NetconfClient, source: 'running' | 'candidate' = 'running'): Promise<string[]> {
  const data = await s.ops.getConfig({ source, filter: subtree(x('nacm', { xmlns: NACM }, x('groups'))) });
  return data.path('nacm/groups')?.childrenNamed('group').map((g) => g.child('name')!.text()) ?? [];
}

/** Both datastores are free: another session can lock and unlock them. */
async function expectUnlocked(): Promise<void> {
  await withClient(options(), async (other) => {
    await other.ops.lock('running');
    await other.ops.lock('candidate');
    await other.ops.unlock('candidate');
    await other.ops.unlock('running');
  });
}

describe.skipIf(PORT === 0)('transaction module against netopeer2', () => {
  beforeAll(async () => {
    const first = await connect({
      transport: ssh({
        host: '127.0.0.1',
        port: PORT,
        username: 'netconf',
        password: 'netconf',
        hostKey: (info) => {
          fingerprint = info.fingerprint;
          return true;
        },
      }),
    });
    await first.close();
  });

  afterAll(async () => {
    if (PORT === 0) return;
    await withClient(options(), async (c) => {
      const remove = { ns: NETCONF_NS, prefix: 'nc', value: 'remove' };
      await c.ops.editConfig({
        target: 'running',
        config: x('nacm', { xmlns: NACM }, x('groups', GROUPS.map((g) => x('group', { operation: remove }, x('name', g))))),
      }).catch(() => undefined);
    });
  });

  it('commits a transaction and releases both locks', async () => {
    await withClient(options(), async (c) => {
      const result = await withCandidate(c, async (txn) => {
        await txn.editConfig({ config: group('nn-tx-ok', 'alice') });
        const candidate = await txn.getConfig({ filter: subtree(x('nacm', { xmlns: NACM }, x('groups'))) });
        return candidate.path('nacm/groups')?.childrenNamed('group').length;
      });
      expect(result).toBeGreaterThan(0);
      expect(await groupNames(c)).toContain('nn-tx-ok');
    });
    await expectUnlocked();
  });

  it('fails with the holder session-id when another session holds the lock', async () => {
    await withClient(options(), async (holder) => {
      await holder.ops.lock('running');
      await withClient(options(), async (c) => {
        const err = await withCandidate(c, () => undefined).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(LockDeniedError);
        expect((err as LockDeniedError).datastore).toBe('running');
        expect((err as LockDeniedError).holder).toBe(holder.session.sessionId);
      });
      await holder.ops.unlock('running');

      // Held candidate: running is locked first, then released again.
      await holder.ops.lock('candidate');
      await withClient(options(), async (c) => {
        const err = (await withCandidate(c, () => undefined).catch((e: unknown) => e)) as LockDeniedError;
        expect(err.datastore).toBe('candidate');
        expect(err.holder).toBe(holder.session.sessionId);
        expect(err.cleanupErrors).toEqual([]);
      });
      await holder.ops.lock('running'); // would fail if the transaction had leaked its running lock
      await holder.ops.unlock('running');
      await holder.ops.unlock('candidate');
    });
  });

  it('rolls back a failed edit: running unchanged, candidate discarded, no lock left', async () => {
    await withClient(options(), async (c) => {
      const before = await groupNames(c);
      const err = await withCandidate(c, async (txn) => {
        await txn.editConfig({ config: group('nn-tx-bad', 'bob') }); // succeeds
        await txn.editConfig({ config: x('nacm', { xmlns: NACM }, x('enable-nacm', 'maybe')) }); // invalid boolean
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).phase).toBe('edit');
      expect((err as TransactionError).cause).toBeInstanceOf(RpcError);
      expect((err as TransactionError).cleanupErrors).toEqual([]);
      expect(await groupNames(c)).toEqual(before);
      expect(await groupNames(c, 'candidate')).not.toContain('nn-tx-bad');
    });
    await expectUnlocked();
  });

  it('confirmed commit: confirm keeps the change, and the candidate stays locked until then', async () => {
    await withClient(options(), async (c) => {
      const { pending } = await withCandidate(c, (txn) => txn.editConfig({ config: group('nn-tx-confirm', 'carol') }), {
        confirmed: { timeout: 60 },
      });
      expect(await groupNames(c)).toContain('nn-tx-confirm');
      await withClient(options(), async (other) => {
        await expect(other.ops.lock('candidate')).rejects.toMatchObject({ tag: 'lock-denied' });
        // Running is free again, so the server can revert running if the commit isn't confirmed.
        await other.ops.lock('running');
        await other.ops.unlock('running');
      });
      await pending.confirm();
      expect(pending.state).toBe('confirmed');
      expect(await groupNames(c)).toContain('nn-tx-confirm');
    });
    await expectUnlocked();
  });

  it('confirmed commit: cancel reverts the change', async () => {
    await withClient(options(), async (c) => {
      const { pending } = await withCandidate(c, (txn) => txn.editConfig({ config: group('nn-tx-cancel', 'dave') }), {
        confirmed: { timeout: 60 },
      });
      expect(await groupNames(c)).toContain('nn-tx-cancel');
      await pending.cancel();
      expect(pending.state).toBe('cancelled');
      expect(await groupNames(c)).not.toContain('nn-tx-cancel');
      expect(await groupNames(c, 'candidate')).not.toContain('nn-tx-cancel');
    });
    await expectUnlocked();
  });

  it('confirmed commit: the server reverts it on timeout, and the handle releases the candidate', async () => {
    await withClient(options(), async (c) => {
      const { pending } = await withCandidate(c, (txn) => txn.editConfig({ config: group('nn-tx-expire', 'fay') }), {
        confirmed: { timeout: 1 },
      });
      expect(await groupNames(c)).toContain('nn-tx-expire');
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(pending.state).toBe('expired');
      expect(await groupNames(c)).not.toContain('nn-tx-expire');
      expect(await groupNames(c, 'candidate')).not.toContain('nn-tx-expire');
    });
    await expectUnlocked();
  });

    it('persistent confirmed commit: survives the session and is confirmed by persist-id from another', async () => {
    await withClient(options(), async (c) => {
      const { pending } = await withCandidate(c, (txn) => txn.editConfig({ config: group('nn-tx-persist', 'erin') }), {
        confirmed: { timeout: 60, persist: 'nn-tx-persist-id' },
      });
      expect(pending.persistId).toBe('nn-tx-persist-id');
    });
    await withClient(options(), async (other) => {
      expect(await groupNames(other)).toContain('nn-tx-persist');
      await other.ops.commit({ persistId: 'nn-tx-persist-id' });
      expect(await groupNames(other)).toContain('nn-tx-persist');
    });
    await expectUnlocked();
  });

  it('client.content.configure() runs through the transaction and reports a held lock', async () => {
    await withClient(options(), async (holder) => {
      await holder.ops.lock('candidate');
      await withClient(options(), async (c) => {
        const err = await c.content.set('/ietf-netconf-acm:nacm/groups/group[name="nn-tx-ok"]/user-name', 'zed').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(LockDeniedError);
        expect((err as LockDeniedError).holder).toBe(holder.session.sessionId);
      });
      await holder.ops.unlock('candidate');
    });
    await expectUnlocked();
  });

  it('configure() with confirmed: a path change with a confirmed commit, then cancelled', async () => {
    await withClient(options(), async (c) => {
      const path = '/ietf-netconf-acm:nacm/groups/group[name="nn-tx-path"]/user-name';
      await c.content.checkEdits((txn) => txn.set(path, 'dave'));
      const pending = await c.content.set(path, 'dave', { confirmed: { timeout: 60 } });
      expect(await groupNames(c)).toContain('nn-tx-path');
      await pending!.cancel();
      expect(await groupNames(c)).not.toContain('nn-tx-path');
    });
    await expectUnlocked();
  });
});
