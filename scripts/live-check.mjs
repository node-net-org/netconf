#!/usr/bin/env node
// Read-only check of a live device with the built library (npm run build first).
//
// Everything about the device comes from a config file, never from this repo:
//   ${NET_NETCONF_CONFIG:-~/.config/net-netconf}/live-device.json
//   {
//     "host": "...", "port": 830, "username": "...",
//     "passwordFile": "live-device.password",      // relative to the config directory
//     "hostKey": "SHA256:..." | "known_hosts",
//     "jump": { "host": "...", "username": "...", "hostKey": "known_hosts" }   // optional; uses SSH_AUTH_SOCK
//   }
//
// It logs in once and only reads: hello and profile detection, <get>, <get-config>,
// <get-config> with the device's own with-defaults basic mode (RFC 6243), and the
// profile's named paths. It never retries a failed login and never prints secrets.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { autoDetect, builtinDeviceProfiles, connect, knownHostsFile, serializeXml, ssh } from '../dist/index.js';
import { WITH_DEFAULTS_CAPABILITY, withDefaults } from '../dist/operations/with-defaults.js';

const dir = process.env.NET_NETCONF_CONFIG ?? join(homedir(), '.config', 'net-netconf');
const config = JSON.parse(await readFile(join(dir, 'live-device.json'), 'utf8'));
const hostKey = (key) => (key === undefined || key === 'known_hosts' ? knownHostsFile() : key);

const client = await connect({
  transport: ssh({
    host: config.host,
    port: config.port ?? 830,
    username: config.username,
    password: async () => (await readFile(join(dir, config.passwordFile), 'utf8')).replace(/\r?\n$/, ''),
    hostKey: hostKey(config.hostKey),
    ...(config.jump
      ? { jump: { host: config.jump.host, username: config.jump.username, agent: process.env.SSH_AUTH_SOCK, hostKey: hostKey(config.jump.hostKey) } }
      : {}),
  }),
  profile: autoDetect(await builtinDeviceProfiles()),
  timeouts: { connect: 20000, hello: 20000 },
  // Enabled only if advertised (checked after the hello), so a device without it still runs the other reads.
  extensions: [withDefaults],
  capabilityCheck: 'warn',
});

const step = async (label, run) => {
  try {
    console.log(`${label}: ${await run()}`);
  } catch (err) {
    console.log(`${label}: ${err.name} ${err.errors?.[0]?.tag ?? ''} ${JSON.stringify(err.errors?.[0]?.message ?? err.message)}`);
  }
};

const profile = client.profile;
console.log(`session ${client.session.sessionId}, base ${client.session.baseVersion}, profile ${profile?.id ?? 'none'}`);
await step('get', async () => `${serializeXml(await client.ops.get({ timeout: 60000 })).length} bytes`);
await step('get-config', async () => `${serializeXml(await client.ops.getConfig({ timeout: 120000 })).length} bytes`);
const wd = client.content.withDefaults;
if (client.session.serverCapabilities.has(WITH_DEFAULTS_CAPABILITY) && wd.basicMode !== undefined) {
  console.log(`with-defaults: basic-mode ${wd.basicMode}, supported ${wd.supportedModes.join(',')}`);
  await step(`get-config with-defaults ${wd.basicMode}`, async () =>
    `${serializeXml(await client.ops.getConfig({ withDefaults: wd.basicMode, timeout: 120000 })).length} bytes`);
} else {
  console.log('with-defaults: not advertised');
}
for (const name of Object.keys(profile?.paths ?? {})) {
  await step(`@${name}`, async () => JSON.stringify(await client.content.readValue(`@${name}`, { timeout: 120000 })));
}
console.log(`session ${client.session.state}`);
await client.close();
