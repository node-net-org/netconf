/**
 * RFC 8639/8640/8641 subscriptions and YANG-Push against netopeer2 (OPS-23).
 * netopeer2 implements ietf-subscribed-notifications (replay, subtree, xpath)
 * and ietf-yang-push (on-change). The assertions follow its probed behaviour,
 * including where it departs from the RFC:
 *
 * - it sends replay-completed, subscription-modified and the first push-update
 *   before the establish reply that carries the id;
 * - it sends subscription-terminated (reason no-such-subscription) on
 *   delete-subscription and when a stop-time passes, where RFC 8639 sends
 *   nothing;
 * - a stop-time set by modify-subscription never fires.
 *
 *   scripts/netopeer2.sh start
 *   npm run test:integration
 *
 * Skipped unless NETOPEER2_PORT is set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, NETCONF_NS, parsePath, RpcError, ssh, subtree, withClient, x, xpath, type ConnectOptions } from '../../src/index.js';
import { notifications } from '../../src/operations/notifications.js';
import {
  subscriptionErrorReason,
  SubscriptionError,
  subscriptions,
  type DynamicSubscription,
  type SubscriptionUpdate,
} from '../../src/operations/subscriptions.js';

const PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);
const NACM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-acm';
const NCN = 'urn:ietf:params:xml:ns:yang:ietf-netconf-notifications';
const GROUPS = ['nn-sub-1', 'nn-sub-2', 'nn-sub-3', 'nn-sub-4'];

let fingerprint = '';

const options = (): ConnectOptions<[typeof subscriptions, typeof notifications]> => ({
  transport: ssh({ host: '127.0.0.1', port: PORT, username: 'netconf', password: 'netconf', hostKey: fingerprint }),
  timeouts: { rpc: 10_000 },
  extensions: [subscriptions, notifications],
});

const remove = { ns: NETCONF_NS, prefix: 'nc', value: 'remove' };
const groups = x('nacm', { xmlns: NACM }, x('groups'));

async function addGroup(name: string): Promise<void> {
  await withClient(options(), (w) => w.ops.editConfig({ target: 'running', config: x('nacm', { xmlns: NACM }, x('groups', x('group', x('name', name)))) }));
}
async function removeGroup(name: string): Promise<void> {
  await withClient(options(), (w) =>
    w.ops.editConfig({ target: 'running', config: x('nacm', { xmlns: NACM }, x('groups', x('group', { operation: remove }, x('name', name)))) }),
  );
}

/** The next update matching `match`, failing after `ms`. */
async function next<T extends SubscriptionUpdate>(sub: DynamicSubscription, match: (u: SubscriptionUpdate) => u is T, ms = 8000): Promise<T> {
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no matching update within ${ms} ms`)), ms).unref());
  const found = (async () => {
    for (;;) {
      const r = await sub.next();
      if (r.done) throw new Error(`subscription ended (${JSON.stringify(await sub.ended)}) before a match`);
      if (match(r.value)) return r.value;
    }
  })();
  return Promise.race([found, timer]);
}
const isEvent = (u: SubscriptionUpdate): u is Extract<SubscriptionUpdate, { type: 'event' }> => u.type === 'event';
const isPush = (u: SubscriptionUpdate): u is Extract<SubscriptionUpdate, { type: 'push-update' }> => u.type === 'push-update';
const isChange = (u: SubscriptionUpdate): u is Extract<SubscriptionUpdate, { type: 'push-change-update' }> => u.type === 'push-change-update';
const groupNames = (u: Extract<SubscriptionUpdate, { type: 'push-update' }>): string[] =>
  u.contents.path('nacm/groups')?.childrenNamed('group').map((g) => g.child('name')!.text()) ?? [];

describe.skipIf(PORT === 0)('subscriptions extension against netopeer2', () => {
  beforeAll(async () => {
    const c = await connect({
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
    await c.close();
  });

  afterAll(async () => {
    if (PORT === 0) return;
    await withClient(options(), (c) =>
      c.ops.editConfig({ target: 'running', config: x('nacm', { xmlns: NACM }, x('groups', GROUPS.map((g) => x('group', { operation: remove }, x('name', g)))))}).catch(() => undefined),
    );
  });

  it('support() reads both modules and their features from the YANG library', async () => {
    await withClient(options(), async (c) => {
      const s = await c.content.subscriptions.support();
      expect(s.subscribedNotifications?.features).toEqual(expect.arrayContaining(['replay', 'subtree', 'xpath']));
      expect(s.yangPush?.features).toContain('on-change');
    });
  });

  it('capabilities() resolves undefined: netopeer2 does not implement RFC 9196', async () => {
    await withClient(options(), async (c) => {
      expect(await c.content.subscriptions.capabilities()).toBeUndefined();
    });
  });

  it('streams() and subscriptions() read /streams and /subscriptions', async () => {
    await withClient(options(), async (c) => {
      const streams = await c.content.subscriptions.streams();
      expect(streams.find((s) => s.name === 'NETCONF')?.replaySupport).toBe(true);
      await using sub = await c.ops.subscriptions.establish({ stream: 'NETCONF' });
      const listed = (await c.content.subscriptions.list()).find((s) => s.id === sub.id);
      expect(listed?.receivers[0]?.state).toBe('active');
      expect(typeof listed?.receivers[0]?.sentEventRecords).toBe('number');
    });
  });

  it('delivers a stream event record, filtered by XPath, then deletes on scope exit', async () => {
    let id = 0;
    await withClient(options(), async (c) => {
      {
        await using sub = await c.ops.subscriptions.establish({
          stream: 'NETCONF',
          filter: xpath('/ncn:netconf-config-change', { ncn: NCN }),
        });
        id = sub.id;
        expect(sub.kind).toBe('stream');
        expect(c.ops.subscriptions.active.get(id)).toBe(sub);
        const arrived = next(sub, isEvent);
        await addGroup('nn-sub-1');
        const event = await arrived;
        expect(event.notification.event).toMatchObject({ name: 'netconf-config-change', ns: NCN });
        expect(sub.end).toBeUndefined();
      }
      expect(c.ops.subscriptions.active.has(id)).toBe(false);
      // Gone from the server too.
      expect((await c.content.subscriptions.list()).map((s) => s.id)).not.toContain(id);
    });
    await removeGroup('nn-sub-1');
  });

  it('replays the log and resolves replayComplete, even though netopeer2 sends replay-completed before the reply', async () => {
    await withClient(options(), async (c) => {
      await using sub = await c.ops.subscriptions.establish({ stream: 'NETCONF', replayStartTime: new Date(Date.now() - 3600_000) });
      expect(sub.replay).toBe(true);
      await expect(sub.replayComplete).resolves.toBe(true);
    });
  });

  it('modify() changes the filter; delete() ends it as deleted (netopeer2 also sends subscription-terminated)', async () => {
    await withClient(options(), async (c) => {
      const sub = await c.ops.subscriptions.establish({ stream: 'NETCONF' });
      await sub.modify({ filter: subtree(x('netconf-config-change', { xmlns: NCN })) });
      const arrived = next(sub, isEvent);
      await addGroup('nn-sub-2');
      expect((await arrived).notification.event?.name).toBe('netconf-config-change');
      await sub.delete();
      expect(await sub.ended).toEqual({ reason: 'deleted' });
      await expect(sub.next()).resolves.toEqual({ value: undefined, done: true });
    });
    await removeGroup('nn-sub-2');
  });

  it('a stop-time given at establish completes the subscription', async () => {
    await withClient(options(), async (c) => {
      const sub = await c.ops.subscriptions.establish({ stream: 'NETCONF', stopTime: new Date(Date.now() + 1000) });
      expect(await sub.ended).toEqual({ reason: 'completed' });
    });
  });

  it("another session's kill-subscription terminates it with no-such-subscription", async () => {
    await withClient(options(), async (owner) => {
      const sub = await owner.ops.subscriptions.establish({ stream: 'NETCONF' });
      await withClient(options(), (admin) => admin.ops.subscriptions.kill(sub.id));
      expect(await sub.ended).toEqual({ reason: 'terminated', identity: 'ietf-subscribed-notifications:no-such-subscription' });
    });
  });

  it('refusals: unknown id from the server, a second stream subscription and RFC 5277 mixing locally', async () => {
    await withClient(options(), async (c) => {
      const err = await c.ops.subscriptions.kill(999_999).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect(subscriptionErrorReason(err)).toBe('ietf-subscribed-notifications:no-such-subscription');

      await using sub = await c.ops.subscriptions.establish({ stream: 'NETCONF' });
      await expect(c.ops.subscriptions.establish({ stream: 'NETCONF' })).rejects.toThrow(SubscriptionError);
      await expect(c.ops.notifications.createSubscription()).rejects.toThrow(SubscriptionError);
      expect(sub.end).toBeUndefined();
    });
    await withClient(options(), async (c) => {
      await using legacy = await c.ops.notifications.createSubscription();
      await expect(c.ops.subscriptions.establish({ stream: 'NETCONF' })).rejects.toThrow(SubscriptionError);
      void legacy;
    });
  });

  it('YANG-Push periodic: push-update with the selected data; modify() changes the period', async () => {
    await withClient(options(), async (c) => {
      await using sub = await c.ops.subscriptions.establish({
        datastore: 'operational',
        filter: subtree(groups),
        periodic: { period: 50 },
      });
      expect([sub.kind, sub.trigger, sub.datastore]).toEqual(['datastore', 'periodic', 'ietf-datastores:operational']);
      const update = await next(sub, isPush);
      expect(groupNames(update)).toContain('nn-admin');
      expect(update.incomplete).toBe(false);
      await sub.modify({ period: 100 });
      await next(sub, isPush);
    });
  });

  it('YANG-Push on-change: the initial push-update, then a push-change-update whose target parses as a YANG path', async () => {
    await withClient(options(), async (c) => {
      await using sub = await c.ops.subscriptions.establish({
        datastore: 'running',
        filter: subtree(groups),
        onChange: { dampeningPeriod: 0 },
      });
      // netopeer2 sends this sync-on-start push-update before the establish reply.
      expect(groupNames(await next(sub, isPush))).toContain('nn-admin');
      const changed = next(sub, isChange);
      await addGroup('nn-sub-3');
      const { patch } = await changed;
      expect(patch.patchId).not.toBe('');
      const created = patch.edits.find((e) => e.operation === 'create' && e.value[0]?.name === 'group');
      expect(created?.target).toBe("/ietf-netconf-acm:nacm/groups/group[name='nn-sub-3']");
      expect(parsePath(created!.target).at(-1)).toMatchObject({ name: 'group', keys: [{ name: 'name', value: 'nn-sub-3' }] });
      await sub.resync();
      await next(sub, isPush);
    });
    await removeGroup('nn-sub-3');
  });

  it('routes updates by id: two datastore subscriptions on one session each get their own', async () => {
    await withClient(options(), async (c) => {
      await using a = await c.ops.subscriptions.establish({ datastore: 'running', filter: subtree(groups), onChange: { syncOnStart: false } });
      await using b = await c.ops.subscriptions.establish({
        datastore: 'running',
        filter: subtree(groups),
        onChange: { syncOnStart: false, excludedChanges: ['create'] },
      });
      const toA = next(a, isChange);
      await addGroup('nn-sub-4');
      expect((await toA).patch.edits.some((e) => e.operation === 'create')).toBe(true);
      // b excludes creates, so its first change is the delete.
      const toB = next(b, isChange);
      await removeGroup('nn-sub-4');
      expect((await toB).patch.edits.every((e) => e.operation === 'delete')).toBe(true);
    });
  });

  it('ends every subscription as closed when the session closes, and the server drops them', async () => {
    let id = 0;
    const c = await connect(options());
    const sub = await c.ops.subscriptions.establish({ datastore: 'running', periodic: { period: 1000 }, filter: subtree(groups) });
    id = sub.id;
    await c.close();
    expect(await sub.ended).toEqual({ reason: 'closed' });
    await withClient(options(), async (other) => {
      expect((await other.content.subscriptions.list()).map((s) => s.id)).not.toContain(id);
    });
  });
});
