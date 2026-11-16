/**
 * RFC 5277 notifications against netopeer2 (OPS-19).
 *
 *   scripts/netopeer2.sh start
 *   npm run test:integration
 *
 * Skipped unless NETOPEER2_PORT is set.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { CapabilityError, connect, NETCONF_NS, ssh, subtree, withClient, x, type ConnectOptions, type Notification } from '../../src/index.js';
import { notifications, type Subscription } from '../../src/operations/notifications.js';

const PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);
const NACM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-acm';
const NC_NOTIF = 'urn:ietf:params:xml:ns:yang:ietf-netconf-notifications';

let fingerprint = '';

const options = (): ConnectOptions<[typeof notifications]> => ({
  transport: ssh({ host: '127.0.0.1', port: PORT, username: 'netconf', password: 'netconf', hostKey: fingerprint }),
  timeouts: { rpc: 10_000 },
  extensions: [notifications],
});

const group = (name: string) =>
  x('nacm', { xmlns: NACM }, x('groups', x('group', x('name', name), x('user-name', 'notify'))));
const removeGroup = (name: string) =>
  x('nacm', { xmlns: NACM },
    x('groups', x('group', { operation: { ns: NETCONF_NS, prefix: 'nc', value: 'remove' } }, x('name', name))));

/** Make a configuration change from another session, so the server emits netconf-config-change. */
async function touchConfig(name: string): Promise<void> {
  await withClient(options(), async (writer) => {
    await writer.ops.editConfig({ target: 'running', config: group(name) });
    await writer.ops.editConfig({ target: 'running', config: removeGroup(name) });
  });
}

async function first(sub: Subscription, match: (n: Notification) => boolean): Promise<Notification> {
  for await (const n of sub) if (match(n)) return n;
  throw new Error(`subscription ended (${(await sub.ended).reason}) before a match`);
}

describe.skipIf(PORT === 0)('notifications against netopeer2', () => {
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

  it('streams() lists the NETCONF stream', async () => {
    await withClient(options(), async (c) => {
      const list = await c.content.notifications.streams();
      expect(list.map((s) => s.name)).toContain('NETCONF');
      expect(typeof list.find((s) => s.name === 'NETCONF')!.replaySupport).toBe('boolean');
    });
  });

  it('delivers a live netconf-config-change through for await', async () => {
    await withClient(options(), async (c) => {
      await using sub = await c.ops.notifications.createSubscription();
      expect(c.ops.notifications.active).toBe(true);
      const arrived = first(sub, (n) => n.event?.name === 'netconf-config-change');
      await touchConfig('nn-notify-1');
      const n = await arrived;
      expect(n.event!.ns).toBe(NC_NOTIF);
      expect(n.eventTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it('applies a subtree filter on the server', async () => {
    await withClient(options(), async (c) => {
      await using sub = await c.ops.notifications.createSubscription({
        filter: subtree(x('netconf-config-change', { xmlns: NC_NOTIF })),
      });
      const arrived = first(sub, () => true);
      await touchConfig('nn-notify-2');
      expect((await arrived).event?.name).toBe('netconf-config-change');
    });
  });

  it('enforces one subscription per session, and the interleave rule the server advertises', async () => {
    await withClient(options(), async (c) => {
      const sub = await c.ops.notifications.createSubscription();
      await expect(c.ops.notifications.createSubscription()).rejects.toThrow(/already active/);
      if (c.ops.notifications.interleave) {
        await expect(c.ops.getConfig({ filter: subtree(x('nacm', { xmlns: NACM }, x('enable-nacm'))) })).resolves.toBeDefined();
      } else {
        await expect(c.ops.getConfig()).rejects.toThrow(CapabilityError);
      }
      await sub.return();
      // Disposing doesn't cancel the server's subscription.
      expect(c.ops.notifications.active).toBe(true);
    });
  });

  it('replays with startTime/stopTime and completes', async () => {
    await withClient(options(), async (c) => {
      const netconf = (await c.content.notifications.streams()).find((s) => s.name === 'NETCONF')!;
      if (!netconf.replaySupport) return; // replay depends on server configuration
      const start = new Date(Date.now() - 60_000);
      const sub = await c.ops.notifications.createSubscription({ startTime: start, stopTime: new Date(Date.now() + 1_000) });
      const seen: Notification[] = [];
      for await (const n of sub) seen.push(n);
      expect(await sub.replayComplete).toBe(true);
      expect((await sub.ended).reason).toBe('completed');
      expect(c.ops.notifications.active).toBe(false);
      // After notificationComplete the session takes other operations again.
      await expect(c.ops.getConfig({ filter: subtree(x('nacm', { xmlns: NACM }, x('enable-nacm'))) })).resolves.toBeDefined();
    });
  }, 20_000);

  it('ends iteration when the session closes', async () => {
    const c = await connect(options());
    const sub = await c.ops.notifications.createSubscription();
    const done = (async () => {
      for await (const _ of sub) { /* drain */ }
      return (await sub.ended).reason;
    })();
    await c.close();
    expect(await done).toBe('closed');
  });
});
