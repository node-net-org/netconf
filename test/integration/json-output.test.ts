/**
 * RFC 7951 JSON output against netopeer2 (OPS-26, CONTENT-09).
 *
 *   scripts/netopeer2.sh start
 *   npm run test:integration
 *
 * No modules are supplied: the schema comes from netopeer2's YANG library
 * and <get-schema>. The NACM tree is the test data (see with-defaults.test.ts:
 * write-default and exec-default are set, read-default and enable-nacm are at
 * their defaults).
 *
 * Skipped unless NETOPEER2_PORT is set.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { connect, ssh, subtree, withClient, x, YangCache, type ConnectOptions } from '../../src/index.js';
import { nmda } from '../../src/operations/nmda.js';
import { withDefaults } from '../../src/operations/with-defaults.js';

const PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);
const NACM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-acm';

let fingerprint = '';
const cache = new YangCache();

const options = (): ConnectOptions<[typeof nmda, typeof withDefaults]> => ({
  transport: ssh({ host: '127.0.0.1', port: PORT, username: 'netconf', password: 'netconf', hostKey: fingerprint }),
  timeouts: { rpc: 20_000 },
  extensions: [nmda, withDefaults],
  yang: { cache, requireSchema: true },
});

const nacm = subtree(x('nacm', { xmlns: NACM }, x('read-default'), x('write-default'), x('exec-default'), x('enable-nacm')));

describe.skipIf(PORT === 0)('JSON output against netopeer2', () => {
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

  it('get-config resolves with typed RFC 7951 JSON, with the schema from the YANG library and <get-schema>', async () => {
    await withClient(options(), async (c) => {
      const data = await c.ops.getConfig({ filter: nacm, format: 'json' });
      expect(data).toEqual({ 'ietf-netconf-acm:nacm': { 'write-default': 'permit', 'exec-default': 'permit' } });
    });
  }, 60_000);

  it('get (config and state) types state too, and with-defaults report-all-tagged marks defaults with annotations', async () => {
    await withClient(options(), async (c) => {
      const data = (await c.ops.get({ filter: nacm, withDefaults: 'report-all-tagged', format: 'json' })) as {
        'ietf-netconf-acm:nacm': Record<string, unknown>;
      };
      const n = data['ietf-netconf-acm:nacm'];
      expect(n['enable-nacm']).toBe(true);
      expect(n['read-default']).toBe('permit');
      expect(n['@enable-nacm']).toEqual({ 'ietf-netconf-with-defaults:default': true });
      expect(n['@read-default']).toEqual({ 'ietf-netconf-with-defaults:default': true });
      expect(n['@write-default']).toBeUndefined();
    });
  }, 60_000);

  it('get-data with origin types the operational datastore and turns origins into ietf-origin annotations', async () => {
    await withClient(options(), async (c) => {
      const data = (await c.ops.nmda.getData({ datastore: 'operational', filter: nacm, withOrigin: true, format: 'json' })) as {
        'ietf-netconf-acm:nacm': Record<string, unknown>;
      };
      const n = data['ietf-netconf-acm:nacm'];
      expect(n['enable-nacm']).toBe(true);
      // netopeer2 puts the origin on the container, or on each leaf; either way it is a module-qualified identity.
      const origins = JSON.stringify(data).match(/"ietf-origin:origin":"([^"]+)"/g) ?? [];
      expect(origins.length).toBeGreaterThan(0);
      for (const o of origins) expect(o).toMatch(/"ietf-origin:origin":"ietf-origin:(intended|default|system|learned|unknown)"/);
    });
  }, 60_000);

  it('a path read is RESTCONF-style, and readValue gives the typed value; the shared cache means no schema is fetched again', async () => {
    await withClient(options(), async (c) => {
      expect(await c.content.read('/ietf-netconf-acm:nacm/write-default', { format: 'json' })).toEqual({ 'ietf-netconf-acm:write-default': 'permit' });
      // A leaf set explicitly: in netopeer2's basic mode (explicit), <get> leaves defaulted leaves out.
      expect(await c.content.readValue('/ietf-netconf-acm:nacm/exec-default', { source: 'config+state', format: 'json' })).toBe('permit');
      expect(await c.content.readValue('/ietf-netconf-acm:nacm/enable-nacm', { source: 'config+state', format: 'json' })).toBeUndefined();
      // JSON is the content layer's default; format: 'xml' gives the elements.
      expect(await c.content.read('/ietf-netconf-acm:nacm/write-default')).toEqual({ 'ietf-netconf-acm:write-default': 'permit' });
      expect(await c.content.readValue('/ietf-netconf-acm:nacm/exec-default', { source: 'config+state' })).toBe('permit');
      const els = await c.content.read('/ietf-netconf-acm:nacm/write-default', { format: 'xml' });
      expect(els.map((e) => e.text())).toEqual(['permit']);
    });
    expect(cache.size).toBeGreaterThan(0);
  }, 60_000);
});
