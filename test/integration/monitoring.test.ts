/**
 * RFC 6022 monitoring against netopeer2 (OPS-16).
 *
 *   scripts/netopeer2.sh start
 *   npm run test:integration
 *
 * Skipped unless NETOPEER2_PORT is set.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { connect, RpcError, ssh, withClient, type ConnectOptions, type RpcReply } from '../../src/index.js';
import { monitoring } from '../../src/operations/monitoring.js';

const PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);

let fingerprint = '';

const options = (): ConnectOptions<[typeof monitoring]> => ({
  transport: ssh({ host: '127.0.0.1', port: PORT, username: 'netconf', password: 'netconf', hostKey: fingerprint }),
  timeouts: { rpc: 10_000 },
  extensions: [monitoring],
});

describe.skipIf(PORT === 0)('monitoring against netopeer2', () => {
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

  it('getSchema fetches YANG source as text, and YIN as an element', async () => {
    await withClient(options(), async (c) => {
      const yang = await c.ops.monitoring.getSchema({ identifier: 'ietf-netconf-monitoring', version: '2010-10-04' });
      expect(yang).toMatch(/^module ietf-netconf-monitoring\s*\{/);
      expect(yang).toContain('rpc get-schema');

      const yin = await c.ops.monitoring.getSchema({ identifier: 'ietf-netconf-monitoring', version: '2010-10-04', format: 'yin' });
      // netopeer2 sends YIN as escaped text; the extension parses it into the root element.
      expect(yin.name).toBe('module');
      expect(yin.ns).toBe('urn:ietf:params:xml:ns:yang:yin:1');
      expect(yin.attr('name')).toBe('ietf-netconf-monitoring');
    });
  });

  it('ops.run runs get-schema from its descriptor', async () => {
    await withClient(options(), async (c) => {
      // An extension operation resolves with the RpcReply; ops.run is typed unknown because profile operations return other things.
      const reply = (await c.ops.run('get-schema', { identifier: 'ietf-netconf-monitoring', version: '2010-10-04' })) as RpcReply | undefined;
      expect(reply?.element.elements[0]?.name).toBe('data');
    });
  });

  it('an unknown schema rejects with RpcError invalid-value', async () => {
    await withClient(options(), async (c) => {
      const err = await c.ops.monitoring.getSchema({ identifier: 'no-such-module-xyz' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).errors[0]?.tag).toBe('invalid-value');
    });
  });

  it('schemas() lists the monitoring module itself, fetchable over NETCONF', async () => {
    await withClient(options(), async (c) => {
      const schemas = await c.content.monitoring.schemas();
      const self = schemas.find((s) => s.identifier === 'ietf-netconf-monitoring' && s.format === 'ietf-netconf-monitoring:yang');
      expect(self).toMatchObject({ version: '2010-10-04', namespace: 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring' });
      expect(self!.locations).toContain('NETCONF');
    });
  });

  it('sessions() includes this session', async () => {
    await withClient(options(), async (c) => {
      const mine = (await c.content.monitoring.sessions()).find((s) => s.sessionId === c.session.sessionId);
      expect(mine).toMatchObject({ username: 'netconf', transport: 'ietf-netconf-monitoring:netconf-ssh' });
      expect(typeof mine!.inRpcs).toBe('number');
    });
  });

  it('datastores() shows who holds a lock', async () => {
    await withClient(options(), async (c) => {
      await c.ops.lock('running');
      try {
        const running = (await c.content.monitoring.datastores()).find((d) => d.name === 'running');
        expect(running?.globalLock?.sessionId).toBe(c.session.sessionId);
        expect(running?.globalLock?.lockedTime).not.toBe('');
      } finally {
        await c.ops.unlock('running');
      }
      const after = (await c.content.monitoring.datastores()).find((d) => d.name === 'running');
      expect(after?.globalLock).toBeUndefined();
    });
  });

  it('statistics() reports counters as numbers', async () => {
    await withClient(options(), async (c) => {
      const stats = await c.content.monitoring.statistics();
      expect(stats.inSessions).toBeGreaterThan(0);
      expect(typeof stats.inRpcs).toBe('number');
      expect(stats.netconfStartTime).toMatch(/^\d{4}-/);
    });
  });
});
