/**
 * CONTENT-12: client.content.datastores() against real servers. netopeer2 is
 * an NMDA server, so its list comes from the YANG library; a profile that
 * hides its :yang-library:1.1 makes it a classic server, whose list comes
 * from the capabilities. Skipped unless NETOPEER2_PORT is set.
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
  timeouts: { rpc: 10_000 },
  ...extra,
});

describe.skipIf(PORT === 0)('datastores() against netopeer2', () => {
  it('lists the NMDA datastores from the YANG library', async () => {
    const client = await connect(options());
    try {
      const { source, datastores } = await client.content.datastores();
      expect(source).toBe('yang-library');
      const names = datastores.map((d) => d.name);
      expect(names).toEqual(expect.arrayContaining(['running', 'candidate', 'startup', 'operational'].map((n) => `ietf-datastores:${n}`)));
      expect(datastores.every((d) => typeof d.schema === 'string' && d.schema !== '')).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('derives the list from the capabilities when the profile hides :yang-library:1.1', async () => {
    const client = await connect(options({ profile: classic }));
    try {
      expect(await client.content.datastores()).toEqual({
        source: 'capabilities',
        datastores: ['running', 'candidate', 'startup'].map((name) => ({ name: `ietf-datastores:${name}` })),
      });
    } finally {
      await client.close();
    }
  });
});
