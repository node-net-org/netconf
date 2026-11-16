/**
 * RFC 7951 JSON input against netopeer2 (OPS-27, CONTENT-10).
 *
 *   scripts/netopeer2.sh start
 *   npm run test:integration
 *
 * No modules are supplied: the schema comes from netopeer2's YANG library and
 * <get-schema>. The test data is NACM: a group (json-test) and three empty
 * rule-lists (json-rl-a/b/c, ordered-by user), all removed again afterwards.
 * Neither grants or denies anything, since no rule names them.
 *
 * Skipped unless NETOPEER2_PORT is set. All writes go to netopeer2; never to a live device.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, ssh, withClient, YangCache, YangDataError, type ConnectOptions, type YangJsonObject } from '../../src/index.js';
import { nmda } from '../../src/operations/nmda.js';

const PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);
const NACM = 'ietf-netconf-acm:nacm';
const REMOVE = { 'ietf-netconf:operation': 'remove' };

let fingerprint = '';
const cache = new YangCache();

const options = (): ConnectOptions<[typeof nmda]> => ({
  transport: ssh({ host: '127.0.0.1', port: PORT, username: 'netconf', password: 'netconf', hostKey: fingerprint }),
  timeouts: { rpc: 20_000 },
  extensions: [nmda],
  yang: { cache, requireSchema: true },
});

/** Remove the test group and rule-lists, whether or not they exist. */
const cleanup: YangJsonObject = {
  [NACM]: {
    groups: { group: [{ name: 'json-test', '@': REMOVE }] },
    'rule-list': ['json-rl-a', 'json-rl-b', 'json-rl-c'].map((name) => ({ name, '@': REMOVE })),
  },
};

const groupFilter: YangJsonObject = { [NACM]: { groups: { group: { name: 'json-test' } } } };
type Nacm = { [NACM]?: { groups?: { group?: { name: string; 'user-name'?: string[] }[] }; 'rule-list'?: { name: string }[] } };

describe.skipIf(PORT === 0)('JSON input against netopeer2', () => {
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
    await withClient(options(), (c) => c.ops.editConfig({ target: 'running', config: cleanup }));
  }, 60_000);

  afterAll(async () => {
    if (PORT !== 0) await withClient(options(), (c) => c.ops.editConfig({ target: 'running', config: cleanup }));
  }, 60_000);

  it('round trip: read JSON, change it, send it back with editConfig, and read the change back', async () => {
    await withClient(options(), async (c) => {
      await c.ops.editConfig({ target: 'running', config: { [NACM]: { groups: { group: [{ name: 'json-test', 'user-name': ['alice'] }] } } } });
      const read = (await c.ops.getConfig({ filter: groupFilter, format: 'json' })) as Nacm;
      expect(read).toEqual({ [NACM]: { groups: { group: [{ name: 'json-test', 'user-name': ['alice'] }] } } });

      read[NACM]!.groups!.group![0]!['user-name']!.push('bob');
      await c.ops.editConfig({ target: 'running', config: read });
      const after = (await c.ops.getConfig({ filter: groupFilter, format: 'json' })) as Nacm;
      expect(after[NACM]!.groups!.group![0]!['user-name']!.sort()).toEqual(['alice', 'bob']);
    });
  }, 60_000);

  it('deletes through RFC 7952 metadata: a leaf-list entry, then a whole list entry', async () => {
    await withClient(options(), async (c) => {
      await c.ops.editConfig({
        target: 'running',
        config: { [NACM]: { groups: { group: [{ name: 'json-test', 'user-name': ['alice', 'bob'] }] } } },
      });
      await c.ops.editConfig({
        target: 'running',
        config: { [NACM]: { groups: { group: [{ name: 'json-test', 'user-name': ['bob'], '@user-name': [{ 'ietf-netconf:operation': 'delete' }] }] } } },
      });
      expect(await c.ops.getConfig({ filter: groupFilter, format: 'json' })).toEqual({ [NACM]: { groups: { group: [{ name: 'json-test', 'user-name': ['alice'] }] } } });
      await c.ops.editConfig({ target: 'running', config: { [NACM]: { groups: { group: [{ name: 'json-test', '@': { 'ietf-netconf:operation': 'delete' } }] } } } });
      expect(await c.ops.getConfig({ filter: groupFilter, format: 'json' })).toEqual({});
    });
  }, 60_000);

  it('positions an entry of an ordered-by-user list with yang:insert and yang:key', async () => {
    await withClient(options(), async (c) => {
      await c.ops.editConfig({ target: 'running', config: { [NACM]: { 'rule-list': [{ name: 'json-rl-a' }, { name: 'json-rl-c' }] } } });
      await c.ops.editConfig({
        target: 'running',
        config: { [NACM]: { 'rule-list': [{ name: 'json-rl-b', '@': { 'yang:insert': 'after', 'yang:key': "[name='json-rl-a']" } }] } },
      });
      const data = (await c.ops.getConfig({ filter: { [NACM]: { 'rule-list': { name: null } } }, format: 'json' })) as Nacm;
      const names = data[NACM]!['rule-list']!.map((r) => r.name).filter((n) => n.startsWith('json-rl-'));
      expect(names).toEqual(['json-rl-a', 'json-rl-b', 'json-rl-c']);
    });
  }, 60_000);

  it('a JSON filter on get selects state data, typed in the JSON reply', async () => {
    await withClient(options(), async (c) => {
      const data = (await c.ops.get({ filter: { [NACM]: { 'denied-operations': null } }, format: 'json' })) as Record<string, Record<string, unknown>>;
      expect(typeof data[NACM]!['denied-operations']).toBe('number');
    });
  }, 60_000);

  it('configure merges JSON with the device workflow, and nmda edit-data takes JSON', async () => {
    await withClient(options(), async (c) => {
      await c.content.configure((txn) => txn.merge({ [NACM]: { groups: { group: [{ name: 'json-test', 'user-name': ['carol'] }] } } }));
      expect(await c.ops.getConfig({ filter: groupFilter, format: 'json' })).toEqual({ [NACM]: { groups: { group: [{ name: 'json-test', 'user-name': ['carol'] }] } } });
      await c.ops.nmda.editData({ datastore: 'running', config: { [NACM]: { groups: { group: [{ name: 'json-test', 'user-name': ['dave'] }] } } } });
      const after = (await c.ops.nmda.getData({ datastore: 'running', filter: groupFilter, format: 'json' })) as Nacm;
      expect(after[NACM]!.groups!.group![0]!['user-name']!.sort()).toEqual(['carol', 'dave']);
    });
  }, 60_000);

  it('JSON that does not match netopeer2\'s schema is refused before sending', async () => {
    await withClient(options(), async (c) => {
      await expect(c.ops.editConfig({ target: 'running', config: { [NACM]: { 'write-default': 'maybe' } } })).rejects.toThrow(YangDataError);
      await expect(c.ops.editConfig({ target: 'running', config: { [NACM]: { 'denied-operations': 1 } } })).rejects.toThrow(YangDataError);
    });
  }, 60_000);
});
