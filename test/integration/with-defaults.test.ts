/**
 * RFC 6243 with-defaults against netopeer2 (OPS-15).
 *
 *   scripts/netopeer2.sh start
 *   npm run test:integration
 *
 * netopeer2 advertises basic-mode=explicit with every other mode also
 * supported. The NACM tree is the test data: scripts/netopeer2.sh sets
 * write-default and exec-default explicitly, and leaves read-default (default
 * "permit") and enable-nacm (default true) at their schema defaults.
 *
 * Skipped unless NETOPEER2_PORT is set.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { connect, ssh, subtree, withClient, x, type ConnectOptions, type XmlElement } from '../../src/index.js';
import { isDefault, WITH_DEFAULTS_NS, withDefaults } from '../../src/operations/with-defaults.js';

const PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);
const NACM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-acm';

let fingerprint = '';

const options = (): ConnectOptions<[typeof withDefaults]> => ({
  transport: ssh({ host: '127.0.0.1', port: PORT, username: 'netconf', password: 'netconf', hostKey: fingerprint }),
  timeouts: { rpc: 10_000 },
  extensions: [withDefaults],
});

const nacmFilter = subtree(x('nacm', { xmlns: NACM }, x('read-default'), x('write-default'), x('enable-nacm')));
const leaf = (data: XmlElement, name: string): XmlElement | undefined => data.child('nacm', NACM)?.child(name, NACM);

describe.skipIf(PORT === 0)('with-defaults against netopeer2', () => {
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

  it('reads the server modes from its capability', async () => {
    await withClient(options(), (c) => {
      expect(c.content.withDefaults.basicMode).toBe('explicit');
      expect([...c.content.withDefaults.supportedModes].sort()).toEqual(['explicit', 'report-all', 'report-all-tagged', 'trim']);
      return Promise.resolve();
    });
  });

  it('report-all includes leaves at their default; explicit and trim leave them out', async () => {
    await withClient(options(), async (c) => {
      const all = await c.ops.getConfig({ filter: nacmFilter, withDefaults: 'report-all' });
      expect(leaf(all, 'read-default')?.text()).toBe('permit');
      expect(leaf(all, 'enable-nacm')?.text()).toBe('true');
      expect(leaf(all, 'write-default')?.text()).toBe('permit'); // set explicitly

      for (const mode of ['explicit', 'trim'] as const) {
        const data = await c.ops.getConfig({ filter: nacmFilter, withDefaults: mode });
        expect(leaf(data, 'read-default'), mode).toBeUndefined();
        expect(leaf(data, 'enable-nacm'), mode).toBeUndefined();
      }
      // write-default is set to permit, which differs from its default (deny): reported by every mode.
      const explicit = await c.ops.getConfig({ filter: nacmFilter, withDefaults: 'explicit' });
      expect(leaf(explicit, 'write-default')?.text()).toBe('permit');

      // Without the option, the server's basic mode (explicit) applies.
      const plain = await c.ops.getConfig({ filter: nacmFilter });
      expect(leaf(plain, 'read-default')).toBeUndefined();
    });
  });

  it('report-all-tagged marks default data, and isDefault() reads the mark', async () => {
    await withClient(options(), async (c) => {
      const tagged = await c.ops.getConfig({ filter: nacmFilter, withDefaults: 'report-all-tagged' });
      expect(isDefault(leaf(tagged, 'read-default')!)).toBe(true);
      expect(isDefault(leaf(tagged, 'enable-nacm')!)).toBe(true);
      expect(isDefault(leaf(tagged, 'write-default')!)).toBe(false);
    });
  });

  it('works on get, and through read()', async () => {
    await withClient(options(), async (c) => {
      const all = await c.ops.get({ filter: nacmFilter, withDefaults: 'report-all' });
      expect(leaf(all, 'read-default')?.text()).toBe('permit');
      const trimmed = await c.ops.get({ filter: nacmFilter, withDefaults: 'trim' });
      expect(leaf(trimmed, 'read-default')).toBeUndefined();

      expect(await c.content.readValue('/ietf-netconf-acm:nacm/read-default', { withDefaults: 'report-all', format: 'xml' })).toBe('permit');
      expect(await c.content.readValue('/ietf-netconf-acm:nacm/read-default', { format: 'xml' })).toBeUndefined();
    });
  });

  it('copy-config to a datastore accepts the parameter', async () => {
    await withClient(options(), async (c) => {
      const reply = await c.ops.copyConfig({ source: 'running', target: 'candidate', withDefaults: 'explicit' });
      expect(reply.ok).toBe(true);
    });
  });

  it('sends the parameter in the ietf-netconf-with-defaults namespace', async () => {
    // A tampered value never reaches the server: the extension refuses it locally.
    await withClient(options(), async (c) => {
      await expect(c.ops.getConfig({ withDefaults: 'all' as never })).rejects.toThrow(TypeError);
      const reply = await c.session.rpc(
        x('get-config', { xmlns: 'urn:ietf:params:xml:ns:netconf:base:1.0' }, x('source', x('running')), nacmFilterEl(),
          x('with-defaults', { xmlns: WITH_DEFAULTS_NS }, 'report-all')),
      );
      expect(leaf(reply.data!, 'read-default')?.text()).toBe('permit');
    });
  });
});

function nacmFilterEl(): XmlElement {
  return x('filter', { type: 'subtree' }, x('nacm', { xmlns: NACM }, x('read-default')));
}
