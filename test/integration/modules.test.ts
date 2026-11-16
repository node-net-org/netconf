/**
 * CONTENT-13: client.content.modules() against netopeer2, an NMDA server
 * whose modules come from its YANG library; with a profile hiding
 * :yang-library:1.1 they come from the hello. Skipped unless NETOPEER2_PORT is set.
 */
import { describe, expect, it } from 'vitest';
import { compileProfile } from '../../src/devices/profile-spec.js';
import { connect, ssh, type ConnectOptions } from '../../src/index.js';

const PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);

const classic = compileProfile({
  id: 'netopeer2-without-nmda',
  capabilities: { remove: ['urn:ietf:params:netconf:capability:yang-library:1.1'] },
}).profile;

const options = (extra: Pick<ConnectOptions, 'profile'> = {}): ConnectOptions => ({
  transport: ssh({ host: '127.0.0.1', port: PORT, username: 'netconf', password: 'netconf', hostKey: () => true }),
  timeouts: { rpc: 30_000 },
  ...extra,
});

describe.skipIf(PORT === 0)('modules() against netopeer2', () => {
  it("lists running's modules from the YANG library, with ietf-netconf's features", async () => {
    const client = await connect(options());
    try {
      const result = await client.content.modules();
      expect(result.source).toBe('yang-library');
      expect(typeof result.schema).toBe('string');
      const netconf = result.modules.find((m) => m.name === 'ietf-netconf');
      expect(netconf?.conformance).toBe('implement');
      expect(netconf?.features).toEqual(expect.arrayContaining(['writable-running', 'candidate']));
      expect(result.modules.some((m) => m.conformance === 'import')).toBe(true);
      expect((await client.content.modules({ datastore: 'operational' })).modules.length).toBeGreaterThanOrEqual(result.modules.length);
    } finally {
      await client.close();
    }
  });

  it('marks every reported ietf-netconf feature supported in its declared features', async () => {
    const client = await connect(options());
    try {
      const [netconf] = (await client.content.modules({ module: 'ietf-netconf', declared: true })).modules;
      const supported = netconf?.declared?.filter((f) => f.supported).map((f) => f.name);
      expect(supported?.sort()).toEqual([...(netconf?.features ?? [])].sort());
      // ietf-netconf declares eight features (netopeer2 supports them all).
      expect(netconf?.declared?.map((f) => f.name).sort()).toEqual(['candidate', 'confirmed-commit', 'rollback-on-error', 'startup', 'url', 'validate', 'writable-running', 'xpath']);
      expect(netconf?.undeclared).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('uses the hello when the profile hides :yang-library:1.1', async () => {
    const client = await connect(options({ profile: classic }));
    try {
      const result = await client.content.modules();
      expect(result.source).toBe('capabilities');
      expect(result.modules.every((m) => m.conformance === 'implement')).toBe(true);
    } finally {
      await client.close();
    }
  });
});
