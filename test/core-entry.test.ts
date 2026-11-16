/**
 * @node-net/netconf/core and the Node entry (PKG-06, PKG-01): what each exports,
 * the root as a superset, the one Node feature inside the client (YANG module
 * directories), runtime-neutral timers, and the embedded built-in profiles.
 * portable:check covers the browser bundle and the run without Node globals.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import * as core from '../src/core.js';
import { compileProfile } from '../src/devices/profile-spec.js';
import * as root from '../src/index.js';
import { FakeServer } from '../src/testing/index.js';
import { unrefTimer } from '../src/timers.js';
// @ts-expect-error: a plain .mjs build script, untyped.
import { render as renderProfiles, TARGET as PROFILES_TARGET } from '../scripts/gen-builtin-profiles.mjs';
import { readFile } from 'node:fs/promises';

const NODE_ONLY = [
  'ssh',
  'tls',
  'listenCallHome',
  'CallHomeListener',
  'duplexConnection',
  'knownHosts',
  'knownHostsFile',
  'fingerprintOf',
  'sha256Fingerprint',
  'toVerifier',
  'INSECURE_ACCEPT_ANY',
  'loadDeviceProfile',
  'loadDeviceProfiles',
  'BUILTIN_PROFILES_DIR',
] as const;

describe('@node-net/netconf/core', () => {
  it('exports the protocol and client API, the connection interface and the built-in profiles', () => {
    for (const name of ['connect', 'withClient', 'NetconfClient', 'openSession', 'openChannel', 'FrameDecoder', 'connectionPair', 'joinConnections', 'builtinDeviceProfiles', 'x', 'parseXml', 'RpcError']) {
      expect(core, name).toHaveProperty(name);
    }
  });

  it('exports candidate transactions with configure(): withCandidate is a helper, not an operations/ entry (OPS-21)', async () => {
    for (const name of ['withCandidate', 'PendingCommit', 'lockHolder', 'DEFAULT_CONFIRM_TIMEOUT', 'TransactionError', 'LockDeniedError']) {
      expect(core, name).toHaveProperty(name);
      expect(root, name).toHaveProperty(name);
    }
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, unknown> };
    expect(Object.keys(pkg.exports)).not.toContain('./operations/transaction');
  });

  it('exports no internal hand-off: the log switch stays out of every entry', () => {
    for (const name of ['LogSwitch', 'logSwitchOf', 'openClientSession']) {
      expect(core, name).not.toHaveProperty(name);
      expect(root, name).not.toHaveProperty(name);
    }
  });

  it('leaves out everything that needs Node.js', () => {
    for (const name of NODE_ONLY) expect(core, name).not.toHaveProperty(name);
  });
});

describe('@node-net/netconf (the Node entry)', () => {
  it('is a superset of core: the same objects, plus the Node-only parts', () => {
    for (const [name, value] of Object.entries(core)) {
      if (name === 'connect' || name === 'withClient' || name === 'reconnecting') continue;
      expect((root as Record<string, unknown>)[name], name).toBe(value);
    }
    for (const name of NODE_ONLY) expect(root, name).toHaveProperty(name);
  });

  it('has its own connect(), withClient() and reconnecting(), which can read YANG module directories', async () => {
    expect(root.connect).not.toBe(core.connect);
    expect(root.withClient).not.toBe(core.withClient);
    expect(root.reconnecting).not.toBe(core.reconnecting);
    const dir = await mkdtemp(join(tmpdir(), 'nn-yang-'));
    const client = await root.connect({ transport: new FakeServer().transport(), yang: { modules: dir } });
    await client.close();
  });
});

describe('YANG module directories through @node-net/netconf/core', () => {
  it('are refused before anything is opened, with a TypeError that says what to do instead', async () => {
    let opened = false;
    const attempt = core.connect({
      transport: () => {
        opened = true;
        return new FakeServer().transport()(new AbortController().signal);
      },
      yang: { modules: ['/some/dir'] },
    });
    await expect(attempt).rejects.toThrow(TypeError);
    await expect(attempt).rejects.toThrow(/ModuleSource/);
    expect(opened).toBe(false);
  });

  it("are refused in a device profile too, and the session isn't left open", async () => {
    const profile = compileProfile({ id: 'with-dirs', match: { anyModule: ['x'] }, yang: { modules: ['/some/dir'] } }).profile;
    const server = new FakeServer();
    await expect(core.connect({ transport: server.transport(), profile: profile })).rejects.toThrow(/device profile with-dirs.*ModuleSource/i);
    await new Promise((r) => setTimeout(r, 10));
    expect(server.requests.some((r) => r.elements[0]?.name === 'close-session')).toBe(true);
  });

  it('a ModuleSource works through core', async () => {
    const source = { load: () => Promise.resolve(undefined) };
    const client = await core.connect({ transport: new FakeServer().transport(), yang: { modules: source } });
    await client.close();
  });
});

describe('runtime-neutral pieces', () => {
  it('unrefTimer() unrefs a Node timer and accepts a runtime whose timers are plain numbers', () => {
    const timer = setTimeout(() => undefined, 1000);
    unrefTimer(timer);
    expect(timer.hasRef()).toBe(false);
    clearTimeout(timer);
    expect(() => unrefTimer(42 as unknown as ReturnType<typeof setTimeout>)).not.toThrow();
  });

  it('CapabilitySet still prints itself in Node without importing node:util', () => {
    expect(inspect(new core.CapabilitySet([core.BASE_1_0]))).toBe(`CapabilitySet(1) [ '${core.BASE_1_0}' ]`);
  });

  it('the built-in profiles load from embedded data, and the embedded copy matches profiles/*.json', async () => {
    const ids = (await core.builtinDeviceProfiles()).map((p) => p.id).sort();
    expect(ids).toEqual(['lab', 'nokia-7210-sas', 'nokia-sros-md', 'sysrepo-netopeer2']);
    expect(await readFile(PROFILES_TARGET as string, 'utf8'), 'run node scripts/gen-builtin-profiles.mjs').toBe((renderProfiles as () => string)());
  });
});
