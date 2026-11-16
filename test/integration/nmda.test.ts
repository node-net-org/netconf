/**
 * NMDA (RFC 8526) and the YANG library (RFC 8525) against netopeer2 (OPS-17, OPS-18).
 *
 *   scripts/netopeer2.sh start
 *   npm run test:integration
 *
 * netopeer2 advertises :yang-library:1.1 and :with-defaults, but not
 * :with-operational-defaults. The NACM tree is the test data (see with-defaults.test.ts).
 *
 * Skipped unless NETOPEER2_PORT is set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CapabilityError, connect, ssh, subtree, withClient, x, type ConnectOptions, type RpcReply, type XmlElement } from '../../src/index.js';
import { nmda, origins } from '../../src/operations/nmda.js';
import { findDatastore, yangLibrary } from '../../src/operations/yang-library.js';

const PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);
const NACM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-acm';
const GROUP = 'nn-nmda';

let fingerprint = '';

const options = (): ConnectOptions<[typeof nmda, typeof yangLibrary]> => ({
  transport: ssh({ host: '127.0.0.1', port: PORT, username: 'netconf', password: 'netconf', hostKey: fingerprint }),
  timeouts: { rpc: 10_000 },
  extensions: [nmda, yangLibrary],
});

const nacm = (...children: XmlElement[]) => subtree(x('nacm', { xmlns: NACM }, ...children));
const leaf = (data: XmlElement, name: string) => data.child('nacm', NACM)?.child(name, NACM);
const groupNames = (data: XmlElement) =>
  data.path('nacm/groups', NACM)?.childrenNamed('group', NACM).map((g) => g.child('name', NACM)!.text()) ?? [];

describe.skipIf(PORT === 0)('nmda and yang-library against netopeer2', () => {
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
    await withClient(options(), (c) =>
      c.ops.nmda
        .editData({
          datastore: 'running',
          config: x('nacm', { xmlns: NACM },
            x('groups', x('group', { operation: { ns: 'urn:ietf:params:xml:ns:netconf:base:1.0', prefix: 'nc', value: 'remove' } }, x('name', GROUP)))),
        })
        .catch(() => undefined),
    );
  });

  it('getData on operational with origins: configured leaves are intended, defaults are default', async () => {
    await withClient(options(), async (c) => {
      const data = await c.ops.nmda.getData({ datastore: 'operational', filter: nacm(), withOrigin: true });
      const byElement = origins(data);
      const origin = (name: string) => byElement.get(leaf(data, name)!);
      expect(origin('write-default')).toBe('ietf-origin:intended'); // set by scripts/netopeer2.sh
      expect(origin('read-default')).toBe('ietf-origin:default');
      // A child without its own annotation inherits: the group name under an intended <nacm>.
      const groupName = data.path('nacm/groups/group/name', NACM)!;
      expect(byElement.get(groupName)).toBe('ietf-origin:intended');
    });
  });

  it('configFilter false returns only state', async () => {
    await withClient(options(), async (c) => {
      const state = await c.ops.nmda.getData({ datastore: 'operational', filter: nacm(), configFilter: false });
      expect(leaf(state, 'denied-operations')).toBeDefined();
      expect(leaf(state, 'write-default')).toBeUndefined();
    });
  });

  it('withDefaults on running is sent in the nmda namespace and honoured', async () => {
    await withClient(options(), async (c) => {
      const all = await c.ops.nmda.getData({ datastore: 'running', filter: nacm(x('read-default')), withDefaults: 'report-all' });
      expect(leaf(all, 'read-default')?.text()).toBe('permit');
      const trimmed = await c.ops.nmda.getData({ datastore: 'running', filter: nacm(x('read-default')), withDefaults: 'trim' });
      expect(leaf(trimmed, 'read-default')).toBeUndefined();
    });
  });

  it('withDefaults on operational is refused locally: no :with-operational-defaults', async () => {
    await withClient(options(), async (c) => {
      await expect(c.ops.nmda.getData({ datastore: 'operational', withDefaults: 'report-all' })).rejects.toThrow(CapabilityError);
    });
  });

  it('editData writes running, and getData reads it back from running and operational', async () => {
    await withClient(options(), async (c) => {
      const reply = await c.ops.nmda.editData({
        datastore: 'running',
        config: x('nacm', { xmlns: NACM }, x('groups', x('group', x('name', GROUP), x('user-name', 'netconf')))),
      });
      expect(reply.ok).toBe(true);
      const running = await c.ops.nmda.getData({ datastore: 'running', filter: nacm(x('groups')) });
      expect(groupNames(running)).toContain(GROUP);
      // netopeer2 has no <intended> (its YANG library lists running, candidate, startup, operational),
      // so check that the change is in use: present in <operational>, with origin intended.
      const operational = await c.ops.nmda.getData({ datastore: 'operational', filter: nacm(x('groups')), withOrigin: true });
      expect(groupNames(operational)).toContain(GROUP);
      const group = operational.path('nacm/groups', NACM)!.childrenNamed('group', NACM).find((g) => g.child('name', NACM)?.text() === GROUP)!;
      expect(origins(operational).get(group)).toBe('ietf-origin:intended');
    });
  });

  it('get-data and edit-data are described operations, runnable from plain arguments', async () => {
    await withClient(options(), async (c) => {
      expect(c.ops.list.find((d) => d.name === 'get-data')).toMatchObject({ extension: 'nmda', mutates: false });
      expect(c.ops.list.find((d) => d.name === 'edit-data')).toMatchObject({ extension: 'nmda', mutates: true });
      const reply = (await c.ops.run('get-data', { datastore: 'operational', filter: nacm(x('enable-nacm')) })) as RpcReply;
      expect(reply.element.elements[0]?.name).toBe('data');
    });
  });

  it('yangLibrary() lists the datastores and the ietf-netconf module, and is cached', async () => {
    await withClient(options(), async (c) => {
      expect(c.content.yangLibrary.contentId).toBeDefined();
      const lib = await c.content.yangLibrary.load();
      expect(lib.contentId).toBe(c.content.yangLibrary.contentId);
      expect(lib.datastores.map((d) => d.name).sort()).toEqual(expect.arrayContaining(['candidate', 'operational', 'running', 'startup'].map((n) => `ietf-datastores:${n}`)));
      const netconf = findDatastore(lib, 'running')!.modules.find((m) => m.name === 'ietf-netconf');
      expect(netconf).toMatchObject({ revision: '2013-09-29', namespace: 'urn:ietf:params:xml:ns:netconf:base:1.0' });
      expect(netconf!.features).toEqual(expect.arrayContaining(['candidate', 'xpath']));
      expect(findDatastore(lib, 'operational')!.modules.some((m) => m.name === 'ietf-yang-library')).toBe(true);
      expect(JSON.parse(JSON.stringify(lib))).toEqual(lib);
      expect(await c.content.yangLibrary.load()).toBe(lib);
      expect(await c.content.yangLibrary.load({ refresh: true })).not.toBe(lib);
    });
  });
});
