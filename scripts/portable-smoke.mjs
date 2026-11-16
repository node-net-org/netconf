// What portable:check runs, bundled for the browser platform, in a context
// with only web-platform globals (scripts/portable-check.mjs). It imports the
// portable entries only: @node-net/netconf/core and @node-net/netconf/testing.

import { builtinDeviceProfiles, connect } from '../dist/core.js';
import { FakeServer } from '../dist/testing/index.js';

globalThis.portableSmoke = async () => {
  const server = new FakeServer({ handler: () => ({ data: [] }) });
  const client = await connect({ transport: server.transport() });
  const capabilities = client.session.serverCapabilities.size;
  const config = String(await client.ops.getConfig());
  await client.close();

  let directories = 'accepted';
  try {
    await connect({ transport: new FakeServer().transport(), yang: { modules: '/no/such/dir' } });
  } catch (err) {
    directories = err instanceof TypeError ? 'refused' : `failed: ${String(err)}`;
  }

  return { capabilities, version: server.version, config, profiles: (await builtinDeviceProfiles()).length, directories };
};
