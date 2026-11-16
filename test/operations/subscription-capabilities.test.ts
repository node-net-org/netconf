/**
 * RFC 9196 system and notification capabilities (OPS-29), against the fake server. The pinned netopeer2 doesn't implement
 * RFC 9196, so the server data here is written from the
 * ietf-system-capabilities and ietf-notification-capabilities modules.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BASE_1_0, BASE_1_1, connect, serializeXml, x, type NetconfClient, type XmlElement } from '../../src/index.js';
import { subscriptions } from '../../src/operations/subscriptions.js';
import { FakeServer, type RpcHandler } from '../../src/testing/index.js';

const SYSC = 'urn:ietf:params:xml:ns:yang:ietf-system-capabilities';
const NCAP = 'urn:ietf:params:xml:ns:yang:ietf-notification-capabilities';
const DS = 'urn:ietf:params:xml:ns:yang:ietf-datastores';
const YL = 'urn:ietf:params:xml:ns:yang:ietf-yang-library';
const SYSC_CAP = `${SYSC}?module=ietf-system-capabilities&revision=2022-02-17`;
const NCAP_CAP = `${NCAP}?module=ietf-notification-capabilities&revision=2022-02-17`;
const YL_CAP = 'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=1';

/** The system-capabilities tree, after RFC 9196 Appendix A's example. */
function capabilities(): XmlElement {
  const sub = (...children: XmlElement[]) => x('subscription-capabilities', { xmlns: NCAP }, ...children);
  return x('system-capabilities', { xmlns: SYSC, 'xmlns:ds': DS },
    sub(
      x('minimum-update-period', '500'),
      x('max-nodes-per-update', '2000'),
      x('minimum-dampening-period', '100'),
      x('periodic-notifications-supported', 'config-changes state-changes'),
      x('on-change-supported', 'config-changes state-changes'),
      x('supported-excluded-change-type', 'all'),
    ),
    x('datastore-capabilities',
      x('datastore', 'ds:operational'),
      x('per-node-capabilities',
        x('node-selector', { 'xmlns:if': 'urn:ietf:params:xml:ns:yang:ietf-interfaces' }, '/if:interfaces/if:interface[if:name=\'eth0\']/if:statistics'),
        sub(x('on-change-supported', ''), x('supported-update-period', '1000'), x('supported-update-period', '6000')),
      ),
      x('per-node-capabilities', x('node-selector', '/'), sub(x('on-change-supported', 'state-changes'), x('minimum-dampening-period', '0'))),
    ),
    x('datastore-capabilities', x('datastore', 'ds:running'), x('per-node-capabilities', x('node-selector', '/'))),
  );
}

let clients: NetconfClient[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

async function open(capabilitiesList: readonly string[], handler: RpcHandler) {
  const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1, ...capabilitiesList], handler });
  const client = await connect({ transport: fake.transport(), extensions: [subscriptions] });
  clients.push(client);
  return { fake, client };
}
const ops = (fake: FakeServer): string[] => fake.requests.map((r) => r.elements[0]!.name);
const answer = (data: XmlElement | (() => XmlElement)): RpcHandler => (_rpc, ctx) => (ctx.operation?.name === 'get' ? { data: typeof data === 'function' ? data() : data } : 'ok');

describe('OPS-29: client.content.subscriptions.capabilities()', () => {
  it('decodes system, per-datastore and per-node capabilities, in server order', async () => {
    const { fake, client } = await open([SYSC_CAP, NCAP_CAP], answer(capabilities));
    const caps = await client.content.subscriptions.capabilities();
    expect(caps).toEqual({
      system: {
        maxNodesPerUpdate: 2000,
        periodic: { config: true, state: true },
        minimumUpdatePeriod: 500,
        onChange: { config: true, state: true },
        minimumDampeningPeriod: 100,
        excludedChangeTypes: ['all'],
      },
      datastores: [
        {
          datastore: 'ietf-datastores:operational',
          nodes: [
            { selector: "/if:interfaces/if:interface[if:name='eth0']/if:statistics", onChange: { config: false, state: false }, supportedUpdatePeriods: [1000, 6000] },
            { selector: '/', onChange: { config: false, state: true }, minimumDampeningPeriod: 0 },
          ],
        },
        { datastore: 'ietf-datastores:running', nodes: [{ selector: '/' }] },
      ],
    });
    expect(Object.isFrozen(caps)).toBe(true);
    const get = fake.requests[0]!.elements[0]!;
    expect(serializeXml(get.child('filter')!.elements[0]!)).toBe(serializeXml(x('system-capabilities', { xmlns: SYSC })));
  });

  it('resolves undefined, reading nothing, on a server without ietf-system-capabilities', async () => {
    const { fake, client } = await open([], answer(capabilities));
    expect(await client.content.subscriptions.capabilities()).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
  });

  it('finds the module in the YANG library when the hello does not list it', async () => {
    const library = x('yang-library', { xmlns: YL },
      x('module-set', x('name', 'all'), x('module', x('name', 'ietf-system-capabilities'), x('revision', '2022-02-17'), x('namespace', SYSC))),
      x('content-id', '1'),
    );
    const handler: RpcHandler = (_rpc, ctx) => {
      const filter = ctx.operation?.child('filter')?.elements[0];
      if (filter?.ns === YL) return { data: library };
      return { data: x('system-capabilities', { xmlns: SYSC, 'xmlns:ds': DS }, x('datastore-capabilities', x('datastore', 'ds:running'), x('per-node-capabilities', x('node-selector', '/')))) };
    };
    const { fake, client } = await open([YL_CAP], handler);
    expect(await client.content.subscriptions.capabilities()).toEqual({ system: {}, datastores: [{ datastore: 'ietf-datastores:running', nodes: [{ selector: '/' }] }] });
    expect(ops(fake)).toEqual(['get', 'get']);
    // Without ietf-notification-capabilities, there are no notification values: just the structure.
  });

  it('resolves undefined on a server whose YANG library does not list it', async () => {
    const library = x('yang-library', { xmlns: YL }, x('module-set', x('name', 'all')), x('content-id', '1'));
    const { fake, client } = await open([YL_CAP], answer(library));
    expect(await client.content.subscriptions.capabilities()).toBeUndefined();
    expect(ops(fake)).toEqual(['get']);
  });

  it('leaves out malformed values and unknown change types, and skips entries it cannot identify', async () => {
    const data = x('system-capabilities', { xmlns: SYSC, 'xmlns:ds': DS },
      x('subscription-capabilities', { xmlns: NCAP },
        x('minimum-update-period', 'soon'),
        x('max-nodes-per-update', '0'),
        x('supported-excluded-change-type', 'rename'),
        x('supported-excluded-change-type', 'move'),
        x('periodic-notifications-supported', 'state-changes sometimes'),
      ),
      x('datastore-capabilities', x('datastore', 'nope:running')),
      x('datastore-capabilities', x('datastore', 'ds:candidate'), x('per-node-capabilities')),
    );
    const { client } = await open([SYSC_CAP], answer(data));
    expect(await client.content.subscriptions.capabilities()).toEqual({
      system: { excludedChangeTypes: ['move'], periodic: { config: false, state: true } },
      datastores: [{ datastore: 'ietf-datastores:candidate', nodes: [] }],
    });
  });

  it('gives an empty result when the server returns no data', async () => {
    const { client } = await open([SYSC_CAP], (_rpc, ctx) => (ctx.operation?.name === 'get' ? { data: [] } : 'ok'));
    expect(await client.content.subscriptions.capabilities()).toEqual({ system: {}, datastores: [] });
  });

  it('is the subscription-capabilities read: run() returns the same result', async () => {
    const { client } = await open([SYSC_CAP, NCAP_CAP], answer(capabilities));
    const d = client.ops.list.find((o) => o.name === 'subscription-capabilities')!;
    expect(d).toMatchObject({ kind: 'read', method: 'capabilities', mutates: false, params: [] });
    expect(await client.ops.run('subscription-capabilities')).toEqual(await client.content.subscriptions.capabilities());
  });
});
