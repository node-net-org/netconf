/**
 * RFC 6470 base notifications decoded from a live netopeer2 subscription (OPS-20).
 *
 *   scripts/netopeer2.sh start
 *   npm run test:integration
 *
 * Skipped unless NETOPEER2_PORT is set.
 *
 * netopeer2 reports config changes as made by its datastore layer (`root`,
 * session-id 0) rather than by the NETCONF user, and sends no
 * netconf-confirmed-commit events, so neither is asserted here.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { connect, NETCONF_NS, ssh, withClient, x, type ConnectOptions } from '../../src/index.js';
import {
  decodeBaseNotification,
  supportsBaseNotifications,
  type BaseNotification,
  type ConfigChangeEvent,
  type SessionEndEvent,
  type SessionStartEvent,
} from '../../src/operations/base-notifications.js';
import { notifications, type Subscription } from '../../src/operations/notifications.js';

const PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);
const NACM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-acm';

let fingerprint = '';

const options = (): ConnectOptions<[typeof notifications]> => ({
  transport: ssh({ host: '127.0.0.1', port: PORT, username: 'netconf', password: 'netconf', hostKey: fingerprint }),
  timeouts: { rpc: 10_000 },
  extensions: [notifications],
});

/** Decode events until `match` accepts one. Reads with next(), because leaving a for-await loop disposes the subscription. */
/** The next decoded base notification that matches, its paths naming modules by the session's lookup when one is given. */
async function next<T extends BaseNotification>(sub: Subscription, match: (e: BaseNotification) => e is T, moduleOf?: (ns: string) => string | undefined): Promise<T> {
  for (let r = await sub.next(); r.done !== true; r = await sub.next()) {
    const e = decodeBaseNotification(r.value, moduleOf === undefined ? {} : { moduleOf });
    if (e !== undefined && match(e)) return e;
  }
  throw new Error(`subscription ended (${(await sub.ended).reason}) before a match`);
}

describe.skipIf(PORT === 0)('base notifications against netopeer2', () => {
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

  it('decodes another session\'s start, its config change with a parsed target, and its end', async () => {
    const name = `nn-bn-${Date.now()}`;
    const c = await connect(options());
    try {
      expect(supportsBaseNotifications(c.session.serverCapabilities)).toBe(true);
      await using sub = await c.ops.notifications.createSubscription();

      const writer = await connect(options());
      const id = writer.session.sessionId;
      const started = await next(sub, (e): e is SessionStartEvent => e.type === 'netconf-session-start' && e.session.sessionId === id);
      expect(started.session.username).toBe('netconf');
      expect(started.eventTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      await writer.ops.editConfig({ target: 'running', config: x('nacm', { xmlns: NACM }, x('groups', x('group', x('name', name), x('user-name', 'u1')))) });
      const groupPath = `/ietf-netconf-acm:nacm/groups/group[name='${name}']`;
      const change = await next(sub, (e): e is ConfigChangeEvent =>
        e.type === 'netconf-config-change' && e.edits.some((ed) => ed.target?.startsWith(groupPath) === true), (ns) => c.content.moduleOf(ns));
      expect(change.datastore).toBe('running');
      expect('server' in change.changedBy || typeof change.changedBy.sessionId === 'number').toBe(true);
      // the target is an RFC 7951 path, with module names in place of netopeer2's prefixes
      const group = change.edits.find((ed) => ed.target === groupPath)!;
      expect(group.operation).toBe('create');
      const member = change.edits.find((ed) => ed.target?.startsWith(`${groupPath}/user-name`) === true);
      if (member !== undefined) expect(member.target).toBe(`${groupPath}/user-name[.='u1']`); // a leaf-list entry

      await writer.close();
      const ended = await next(sub, (e): e is SessionEndEvent => e.type === 'netconf-session-end' && e.session.sessionId === id);
      expect(ended.terminationReason).toBe('closed');
      expect(ended).not.toHaveProperty('killedBy');
    } finally {
      await c.close();
      await withClient(options(), (cleanup) =>
        cleanup.ops.editConfig({
          target: 'running',
          config: x('nacm', { xmlns: NACM }, x('groups', x('group', { operation: { ns: NETCONF_NS, prefix: 'nc', value: 'remove' } }, x('name', name)))),
        }));
    }
  });
});
