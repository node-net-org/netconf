/**
 * CONTENT-04: YANG paths through modules that only the YANG library lists.
 *
 *   scripts/netopeer2.sh start && scripts/clixon.sh start
 *   CLIXON_PORT=18400 npm run test:integration
 *
 * Clixon's example module (clixon-example) is YANG 1.1-era content that its
 * hello doesn't list; netopeer2 lists YANG 1.1 modules such as
 * ietf-subscribed-notifications only in its library. Skipped per server unless
 * CLIXON_PORT / NETOPEER2_PORT is set.
 */
import { describe, expect, it } from 'vitest';
import { connect, PathError, ssh, type NetconfClient } from '../../src/index.js';

const CLIXON_PORT = Number(process.env['CLIXON_PORT'] ?? 0);
const NETOPEER2_PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);
const EX = 'urn:example:clixon';
const SN = 'urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications';

async function open(port: number): Promise<NetconfClient> {
  return connect({
    transport: ssh({ host: '127.0.0.1', port, username: 'netconf', password: 'netconf', hostKey: () => true }),
    timeouts: { rpc: 10_000 },
  });
}

describe.skipIf(CLIXON_PORT === 0)('YANG library namespaces against Clixon', () => {
  it('writes and reads clixon-example by path, loading the library by itself', async () => {
    const client = await open(CLIXON_PORT);
    try {
      await client.ops.discardChanges(); // a clean candidate, whatever earlier tests left
      expect(client.session.serverCapabilities.helloModule('clixon-example')).toBeUndefined();
      expect(() => client.content.toXPath('/clixon-example:table')).toThrow(/await client\.content\.loadModules\(\) first/);

      // configure() learns the namespace from the library, then edits through the candidate and commits.
      await client.content.configure((txn) => txn.set("/clixon-example:table/parameter[name='lib']/value", '42'));
      expect(await client.content.readValue("/clixon-example:table/parameter[name='lib']/value", { format: 'xml' })).toBe('42');
      await client.content.remove("/clixon-example:table/parameter[name='lib']");
      expect(await client.content.read("/clixon-example:table/parameter[name='lib']", { format: 'xml' })).toEqual([]);

      expect(client.content.moduleNamespace('clixon-example')).toBe(EX);
      expect(client.content.toXPath('/clixon-example:table').namespaces).toEqual({ 'clixon-example': EX });
    } finally {
      await client.close();
    }
  });

  it('still rejects a module the library lacks with a PathError naming it', async () => {
    const client = await open(CLIXON_PORT);
    try {
      const err = await client.content.read('/no-such-module:top', { format: 'xml' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PathError);
      expect((err as PathError).module).toBe('no-such-module');
    } finally {
      await client.close();
    }
  });
});

describe.skipIf(NETOPEER2_PORT === 0)('YANG library namespaces against netopeer2', () => {
  it('reads a YANG 1.1 module that only the library lists', async () => {
    const client = await open(NETOPEER2_PORT);
    try {
      expect(client.session.serverCapabilities.helloModule('ietf-subscribed-notifications')).toBeUndefined();
      const streams = await client.content.read('/ietf-subscribed-notifications:streams/stream', { source: 'config+state', format: 'xml' });
      expect(streams.length).toBeGreaterThan(0);
      expect(streams[0]!.ns).toBe(SN);
      expect(streams.map((s) => s.child('name', SN)?.text())).toContain('NETCONF');
      const modules = await client.content.loadModules();
      expect(modules.get('ietf-subscribed-notifications')).toBe(SN);
    } finally {
      await client.close();
    }
  });
});
