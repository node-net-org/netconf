/**
 * OPS-18: the RFC 7895 fallback and the shared library read, against netopeer2.
 *
 * netopeer2 advertises :yang-library:1.1 but still serves the deprecated RFC
 * 7895 /modules-state. A device profile that hides 1.1 and advertises 1.0
 * makes it an RFC 7895-only server to the client, so the fallback reads real
 * /modules-state data. Skipped unless NETOPEER2_PORT is set.
 */
import diagnostics from 'node:diagnostics_channel';
import { describe, expect, it } from 'vitest';
import { compileProfile } from '../../src/devices/profile-spec.js';
import { connect, RPC_CHANNEL, ssh, type ConnectOptions } from '../../src/index.js';
import { yangLibrary } from '../../src/operations/yang-library.js';

const PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);
const SN = 'urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications';

const legacy = compileProfile({
  id: 'netopeer2-as-rfc7895',
  capabilities: {
    remove: ['urn:ietf:params:netconf:capability:yang-library:1.1'],
    add: ['urn:ietf:params:netconf:capability:yang-library:1.0?revision=2016-06-21&module-set-id=legacy'],
  },
}).profile;

const options = (extra: Pick<ConnectOptions, 'profile'> = {}): ConnectOptions<[typeof yangLibrary]> => ({
  transport: ssh({ host: '127.0.0.1', port: PORT, username: 'netconf', password: 'netconf', hostKey: () => true }),
  timeouts: { rpc: 10_000 },
  extensions: [yangLibrary],
  ...extra,
});

describe.skipIf(PORT === 0)('YANG library against netopeer2', () => {
  it('reads /modules-state when only :yang-library:1.0 is advertised, in the RFC 8525 shape', async () => {
    const client = await connect(options({ profile: legacy }));
    try {
      expect(client.session.serverCapabilities.has(':yang-library:1.1')).toBe(false);
      expect(client.content.yangLibrary.contentId).toBe('legacy');
      const lib = await client.content.yangLibrary.load();
      expect(lib.version).toBe('1.0');
      expect(lib.datastores).toEqual([]);
      const [set] = lib.moduleSets;
      expect(set!.name).toBe('modules-state');
      const netconf = set!.modules.find((m) => m.name === 'ietf-netconf');
      expect(netconf?.namespace).toBe('urn:ietf:params:xml:ns:netconf:base:1.0');
      expect(netconf?.features.length).toBeGreaterThan(0);
      expect(set!.importOnlyModules.some((m) => m.name === 'ietf-yang-types')).toBe(true);
      expect(set!.modules.some((m) => m.name === 'ietf-subscribed-notifications')).toBe(true);

      // A YANG 1.1 module path resolves from it, without another read.
      const streams = await client.content.read('/ietf-subscribed-notifications:streams/stream', { source: 'config+state', format: 'xml' });
      expect(streams.map((s) => s.child('name', SN)?.text())).toContain('NETCONF');
    } finally {
      await client.close();
    }
  });

  it('shares one /yang-library read between yangLibrary() and loadModules()', async () => {
    const client = await connect(options());
    const sent: string[] = [];
    const listener = (msg: unknown): void => {
      const m = msg as { phase?: string; sessionId?: number; operation?: string };
      if (m.phase === 'start' && m.sessionId === client.session.sessionId && m.operation !== undefined) sent.push(m.operation);
    };
    diagnostics.subscribe(RPC_CHANNEL, listener);
    try {
      const lib = await client.content.yangLibrary.load();
      expect(lib.version).toBe('1.1');
      const modules = await client.content.loadModules();
      expect(modules.get('ietf-subscribed-notifications')).toBe(SN);
      await client.content.read('/ietf-subscribed-notifications:streams', { source: 'config+state', format: 'xml' });
      expect(sent).toEqual(['get', 'get']); // the library once, then the read
    } finally {
      diagnostics.unsubscribe(RPC_CHANNEL, listener);
      await client.close();
    }
  });
});
