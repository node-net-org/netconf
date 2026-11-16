/**
 * CLIENT-05: every call on a connected client sits on the object for the
 * RFC 6241 layer it works at (transport, session, ops, content), against the
 * fake server.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { BASE_1_0, BASE_1_1, ClientContent, ClientOps, connect, NETCONF_NS, Session, x, type NetconfClient, type XmlElement } from '../src/index.js';
import { monitoring, type MonitoringContent, type MonitoringOps } from '../src/operations/monitoring.js';
import { FakeServer } from '../src/testing/index.js';

const NCM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring';
const CAPS = [BASE_1_0, BASE_1_1, ':candidate', `${NCM}?module=ietf-netconf-monitoring&revision=2010-10-04`].map((c) =>
  c.startsWith(':') ? `urn:ietf:params:netconf:capability${c}:1.0` : c,
);

async function open(): Promise<{ fake: FakeServer; client: NetconfClient }> {
  const fake = new FakeServer({ capabilities: CAPS, handler: () => ({ data: [] }) });
  const client = await connect({ transport: fake.transport() });
  return { fake, client };
}

describe('the client is grouped by RFC 6241 layer (CLIENT-05)', () => {
  it('AC1: exposes transport, session, ops, content and profile, and only the lifecycle and logging controls as calls', async () => {
    const { client } = await open();
    expect(Object.keys(client).sort()).toEqual(['connectOptions', 'content', 'ops', 'profile', 'session', 'transport']);
    const proto = Object.getPrototypeOf(client) as object;
    expect(Object.getOwnPropertyNames(proto).sort()).toEqual(['close', 'constructor', 'logLevel', 'logger', 'setLogLevel', 'setLogger']);
    expect(Object.getOwnPropertySymbols(proto)).toEqual([Symbol.asyncDispose]);
    for (const gone of ['rpc', 'on', 'once', 'off', 'get', 'getConfig', 'editConfig', 'read', 'set', 'configure', 'ext', 'device', 'operations', 'runOperation']) {
      expect(gone in client, gone).toBe(false);
    }
    expect(client.profile).toBeUndefined();
    await client.close();
  });

  it('keeps the options given to connect(), as a frozen copy', async () => {
    const fake = new FakeServer({ capabilities: CAPS, handler: () => ({ data: [] }) });
    const namespaces = { 'my-module': 'urn:my' };
    const options = { transport: fake.transport(), namespaces, maxInFlight: 4, capabilityCheck: 'warn' as const };
    const client = await connect(options);
    expect(client.connectOptions).toEqual(options);
    expect(client.connectOptions).not.toBe(options);
    expect(client.connectOptions.namespaces).toBe(namespaces);
    expect(Object.isFrozen(client.connectOptions)).toBe(true);
    expect(Object.isFrozen(options)).toBe(false);
    await client.close();
  });

  it('AC2: transport reports the peer the connection reached', async () => {
    const { client } = await open();
    expect(client.transport.peer).toEqual(expect.objectContaining({ host: expect.any(String) as string }));
    expect(Object.isFrozen(client.transport)).toBe(true);
    // The session keeps the peer for its own logging, but it is no longer part of its public type.
    // @ts-expect-error Session has no public peer
    void client.session.peer;
    await client.close();
  });

  it('AC3: session carries raw RPCs, the session-id, capabilities and events', async () => {
    const { fake, client } = await open();
    expect(client.session).toBeInstanceOf(Session);
    expect(client.session.sessionId).toBeGreaterThan(0);
    expect(client.session.serverCapabilities.has(':candidate')).toBe(true);
    const seen: string[] = [];
    const off = client.session.on('closed', () => seen.push('closed'));
    expect(typeof off).toBe('function');
    await client.session.rpc(x('get-chassis-inventory', { xmlns: 'urn:example' }));
    expect(fake.requests.at(-1)!.elements[0]!.name).toBe('get-chassis-inventory');
    await client.close();
    expect(seen).toEqual(['closed']);
  });

  it('AC4: ops sends operations and hands back XML or the reply; list, run and device are there', async () => {
    const { fake, client } = await open();
    expect(client.ops).toBeInstanceOf(ClientOps);
    const data = await client.ops.getConfig({ source: 'candidate' });
    expectTypeOf(data).toEqualTypeOf<XmlElement>();
    expect(data.name).toBe('data');
    expect(fake.requests.at(-1)!.elements[0]).toMatchObject({ name: 'get-config', ns: NETCONF_NS });
    expect(client.ops.list.map((d) => d.name)).toContain('edit-config');
    await client.ops.run('discard-changes');
    expect(fake.requests.at(-1)!.elements[0]!.name).toBe('discard-changes');
    await expect(client.ops.device.call('show')).rejects.toThrow(/no device profile is in use/);
    await client.close();
  });

  it('AC5: content takes YANG paths and hands back typed values, running ops underneath', async () => {
    const { fake, client } = await open();
    expect(client.content).toBeInstanceOf(ClientContent);
    const path = '/ietf-netconf-monitoring:netconf-state/sessions';
    expect(client.content.resolvePath(path)[0]!.ns).toBe(NCM);
    expect(client.content.toXPath(path).type).toBe('xpath');
    expect(await client.content.readValue(path, { format: 'xml' })).toBeUndefined();
    expect(fake.requests.at(-1)!.elements[0]!.name).toBe('get-config');
    await client.close();
  });

  it('AC6: an extension with both sections appears under one id in each layer, holding different calls', async () => {
    const fake = new FakeServer({ capabilities: CAPS });
    const client = await connect({ transport: fake.transport(), extensions: [monitoring] });
    expectTypeOf(client.ops.monitoring).toEqualTypeOf<MonitoringOps>();
    expectTypeOf(client.content.monitoring).toEqualTypeOf<MonitoringContent>();
    expect(Object.keys(client.ops.monitoring)).toEqual(['getSchema']);
    expect(Object.keys(client.content.monitoring).sort()).toEqual(['datastores', 'schemas', 'sessions', 'statistics']);
    await client.close();
  });
});
