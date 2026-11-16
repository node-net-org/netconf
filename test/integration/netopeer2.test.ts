/**
 * Integration tests against netopeer2, the reference open-source NETCONF server.
 *
 *   scripts/netopeer2.sh start
 *   npm run test:integration
 *
 * Skipped unless NETOPEER2_PORT is set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  autoDetect,
  builtinDeviceProfiles,
  connect,
  loadDeviceProfile,
  NETCONF_NS,
  NOTIFICATION_NS,
  RpcError,
  SessionClosedError,
  TransactionError,
  ssh,
  subtree,
  withClient,
  x,
  xpath,
  type ConnectOptions,
  type Notification,
  type NetconfClient,
} from '../../src/index.js';

const PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);
const NACM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-acm';
const NC_NOTIF = 'urn:ietf:params:xml:ns:yang:ietf-netconf-notifications';

let fingerprint = '';

function options(extra: Partial<ConnectOptions> = {}): ConnectOptions {
  return {
    transport: ssh({ host: '127.0.0.1', port: PORT, username: 'netconf', password: 'netconf', hostKey: fingerprint }),
    timeouts: { rpc: 10_000 },
    ...extra,
  };
}

const group = (name: string, ...users: string[]) =>
  x('nacm', { xmlns: NACM }, x('groups', x('group', x('name', name), users.map((u) => x('user-name', u)))));

const deleteGroup = (name: string) =>
  x('nacm', { xmlns: NACM },
    x('groups', x('group', { operation: { ns: NETCONF_NS, prefix: 'nc', value: 'remove' } }, x('name', name))));

async function groupNames(s: NetconfClient, source: 'running' | 'candidate' = 'running'): Promise<string[]> {
  const data = await s.ops.getConfig({ source, filter: subtree(x('nacm', { xmlns: NACM }, x('groups'))) });
  return data.path('nacm/groups')?.childrenNamed('group').map((g) => g.child('name')!.text()) ?? [];
}

describe.skipIf(PORT === 0)('netopeer2 integration', () => {
  beforeAll(async () => {
    // Trust on first use, then pin: every later connection verifies this fingerprint.
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
    await withClient(options(), async (s) => {
      for (const name of ['nn-commit', 'nn-confirmed', 'nn-base10']) {
        await s.ops.editConfig({ target: 'running', config: deleteGroup(name) }).catch(() => undefined);
      }
    });
  });

  it('negotiates base 1.1 and reads the advertised capabilities', async () => {
    await withClient(options(), (s) => {
      expect(s.session.sessionId).toBeGreaterThan(0);
      expect(s.session.baseVersion).toBe('1.1');
      expect(s.transport.peer.identity).toBe(fingerprint);
      for (const cap of [':candidate', ':confirmed-commit:1.1', ':validate:1.1', ':startup', ':xpath', ':notification']) {
        expect(s.session.serverCapabilities.has(cap), cap).toBe(true);
      }
      expect(s.session.serverCapabilities.get(':with-defaults')?.params.get('basic-mode')).toBe('explicit');
      expect(s.session.serverCapabilities.hasHelloModule('ietf-netconf-acm')).toBe(true);
      return Promise.resolve();
    });
  });

  it('runs the candidate workflow: lock, edit, validate, commit, unlock', async () => {
    await withClient(options(), async (s) => {
      await s.ops.lock('candidate');
      try {
        await s.ops.discardChanges();
        await s.ops.editConfig({ target: 'candidate', config: group('nn-commit', 'alice', 'bob') });
        expect(await groupNames(s, 'candidate')).toContain('nn-commit');
        expect(await groupNames(s, 'running')).not.toContain('nn-commit');
        await s.ops.validate('candidate');
        await s.ops.commit();
        expect(await groupNames(s, 'running')).toContain('nn-commit');

        await s.ops.editConfig({ target: 'candidate', config: deleteGroup('nn-commit') });
        await s.ops.commit();
        expect(await groupNames(s, 'running')).not.toContain('nn-commit');
      } finally {
        await s.ops.unlock('candidate');
      }
    });
  });

  it('reads with an xpath filter', async () => {
    await withClient(options(), async (s) => {
      const data = await s.ops.get({ filter: xpath('/nm:netconf-state/nm:sessions', { nm: 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring' }) });
      const sessions = data.path('netconf-state/sessions')?.childrenNamed('session') ?? [];
      expect(sessions.map((e) => Number(e.child('session-id')!.text()))).toContain(s.session.sessionId);
    });
  });

  it('reports a server validation error as a structured RpcError', async () => {
    await withClient(options(), async (s) => {
      const err = await s
        .ops.editConfig({ target: 'candidate', config: x('nacm', { xmlns: NACM }, x('enable-nacm', 'maybe')) })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).first.type).toBe('application');
      expect((err as RpcError).first.message).toMatch(/Invalid boolean value "maybe"/);
      await s.ops.discardChanges();
    });
  });

  it('gets lock-denied when another session holds the lock', async () => {
    await withClient(options(), async (a) => {
      await a.ops.lock('candidate');
      try {
        await withClient(options(), async (b) => {
          const err = (await b.ops.lock('candidate').catch((e: unknown) => e)) as RpcError;
          expect(err).toBeInstanceOf(RpcError);
          expect(err.tag).toBe('lock-denied');
        });
      } finally {
        await a.ops.unlock('candidate');
      }
    });
  });

  it('reverts a confirmed commit that is cancelled', async () => {
    await withClient(options(), async (s) => {
      await s.ops.editConfig({ target: 'candidate', config: group('nn-confirmed', 'carol') });
      await s.ops.commit({ confirmed: true, confirmTimeout: 60, persist: 'nn-persist' });
      expect(await groupNames(s)).toContain('nn-confirmed');
      await s.ops.cancelCommit({ persistId: 'nn-persist' });
      expect(await groupNames(s)).not.toContain('nn-confirmed');
    });
  });

  it('pipelines many RPCs on one session', async () => {
    await withClient(options({ maxInFlight: 8 }), async (s) => {
      const results = await Promise.all(Array.from({ length: 25 }, () => s.ops.getConfig()));
      expect(results).toHaveLength(25);
      expect(results.every((d) => d.name === 'data')).toBe(true);
    });
  });

  it('copies running to startup', async () => {
    await withClient(options(), async (s) => {
      const reply = await s.ops.copyConfig({ source: 'running', target: 'startup' });
      expect(reply.ok).toBe(true);
    });
  });

  it('delivers notifications after create-subscription (RFC 5277)', async () => {
    await withClient(options(), async (listener) => {
      const received = new Promise<Notification>((resolve) => {
        listener.session.on('notification', (n) => {
          if (n.event?.name === 'netconf-config-change') resolve(n);
        });
      });
      await listener.session.rpc(x('create-subscription', { xmlns: NOTIFICATION_NS }));
      await withClient(options(), async (writer) => {
        await writer.ops.editConfig({ target: 'running', config: group('nn-notify', 'dave') });
        await writer.ops.editConfig({ target: 'running', config: deleteGroup('nn-notify') });
      });
      const n = await received;
      expect(n.event!.ns).toBe(NC_NOTIF);
      expect(n.eventTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it('closes a session killed by another, rejecting what was pending', async () => {
    const victim = await connect(options());
    const closed = new Promise<unknown>((resolve) => victim.session.on('closed', ({ cause }) => resolve(cause)));
    await withClient(options(), async (killer) => {
      await killer.ops.killSession(victim.session.sessionId);
    });
    expect(await closed).toBeInstanceOf(SessionClosedError);
    expect(victim.session.state).toBe('closed');
    await expect(victim.ops.getConfig()).rejects.toBeInstanceOf(SessionClosedError);
  });

  describe('device profiles and paths', () => {
    it('auto-detects the built-in netopeer2 profile', async () => {
      const s = await connect(options({ profile: autoDetect(await builtinDeviceProfiles()) }));
      try {
        expect(s.profile?.id).toBe('sysrepo-netopeer2');
        const sessions = await s.content.read('@sessions', { source: 'config+state', format: 'xml' });
        const ids = sessions[0]!.childrenNamed('session').map((e) => Number(e.child('session-id')!.text()));
        expect(ids).toContain(s.session.sessionId);
      } finally {
        await s.close();
      }
    });

    it('configures, reads and removes by path with the profile workflow', async () => {
      const s = await connect(options({ profile: autoDetect(await builtinDeviceProfiles()) }));
      const group = '/ietf-netconf-acm:nacm/groups/group[name="nn-path"]';
      try {
        await s.content.set(`${group}/user-name`, 'eve');
        await s.content.set(`${group}/user-name`, 'frank');
        expect((await s.content.read(`${group}/user-name`, { format: 'xml' })).map((e) => e.text()).sort()).toEqual(['eve', 'frank']);
        expect(await s.content.readValue(`${group}/user-name[.="frank"]`, { format: 'xml' })).toBe('frank');

        await s.content.remove(`${group}/user-name[.="frank"]`);
        expect((await s.content.read(`${group}/user-name`, { format: 'xml' })).map((e) => e.text())).toEqual(['eve']);

        await s.content.remove(group);
        expect(await s.content.read(group, { format: 'xml' })).toEqual([]);
        await s.content.remove(group); // idempotent
      } finally {
        await s.content.remove(group).catch(() => undefined);
        await s.close();
      }
    });

    it('surfaces a server-side failure from configure() and leaves no lock behind', async () => {
      await withClient(options(), async (s) => {
        const err = await s.content.set('/ietf-netconf-acm:nacm/enable-nacm', 'maybe').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(TransactionError);
        expect((err as TransactionError).cause).toBeInstanceOf(RpcError);
        await withClient(options(), async (other) => {
          await other.ops.lock('candidate'); // would fail with lock-denied if configure() leaked its lock
          await other.ops.unlock('candidate');
        });
      });
    });
  });

  // netopeer2 advertises base:1.1, so base:1.0 is reached by a
  // profile that sets forceBaseVersion. The quirk acts on our hello, so the
  // profile must be passed explicitly, not auto-detected.
  describe('base:1.0 over end-of-message framing', () => {
    const base10 = () =>
      loadDeviceProfile({
        id: 'netopeer2-base10',
        extends: 'sysrepo-netopeer2',
        quirks: { forceBaseVersion: '1.0' },
      });

    it('negotiates base 1.0 and reads with get-config', async () => {
      await withClient(options({ profile: await base10() }), async (s) => {
        expect(s.session.baseVersion).toBe('1.0');
        expect(s.session.serverCapabilities.has(':base:1.1')).toBe(true);
        expect(await groupNames(s)).toContain('nn-admin');
      });
    });

    it('edits the candidate, validates and commits', async () => {
      await withClient(options({ profile: await base10() }), async (s) => {
        expect(s.session.baseVersion).toBe('1.0');
        await s.ops.lock('candidate');
        try {
          await s.ops.discardChanges();
          await s.ops.editConfig({ target: 'candidate', config: group('nn-base10', 'carol') });
          expect(await groupNames(s, 'candidate')).toContain('nn-base10');
          expect(await groupNames(s, 'running')).not.toContain('nn-base10');
          await s.ops.validate('candidate');
          await s.ops.commit();
          expect(await groupNames(s, 'running')).toContain('nn-base10');

          await s.ops.editConfig({ target: 'candidate', config: deleteGroup('nn-base10') });
          await s.ops.commit();
          expect(await groupNames(s, 'running')).not.toContain('nn-base10');
        } finally {
          await s.ops.unlock('candidate');
        }
      });
    });

    it("runs configure() through the profile's workflow", async () => {
      await withClient(options({ profile: await base10() }), async (s) => {
        expect(s.session.baseVersion).toBe('1.0');
        const path = '/ietf-netconf-acm:nacm/groups/group[name="nn-base10"]';
        try {
          await s.content.set(`${path}/user-name`, 'dave');
          const users = await s.content.read(`${path}/user-name`, { format: 'xml' });
          expect(users.map((e) => e.text())).toEqual(['dave']);
        } finally {
          await s.content.remove(path).catch(() => undefined);
        }
        expect(await groupNames(s)).not.toContain('nn-base10');
      });
    });
  });
});
