/**
 * CONTENT-13: client.content.modules(), from the YANG library or the hello's
 * module capabilities, per datastore or schema, against the fake server.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { compileProfile } from '../../src/devices/profile-spec.js';
import {
  SchemaUnavailableError,
  AbortError,
  BASE_1_0,
  BASE_1_1,
  connect,
  NETCONF_NS,
  x,
  type ConnectOptions,
  type DeclaredFeature,
  type ModulesOptions,
  type NetconfClient,
  type ServerModule,
  type ServerModules,
  type SessionWarning,
  type XmlElement,
} from '../../src/index.js';
import { FakeServer, type RpcHandler, type RpcHandlerResult } from '../../src/testing/index.js';

const CAP = (n: string): string => `urn:ietf:params:netconf:capability:${n}`;
const YL = 'urn:ietf:params:xml:ns:yang:ietf-yang-library';
const DS = 'urn:ietf:params:xml:ns:yang:ietf-datastores';
const NC = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const IF = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
const INET = 'urn:ietf:params:xml:ns:yang:ietf-inet-types';
const ACME = 'urn:example:acme';
const YL_1_1 = `${CAP('yang-library:1.1')}?revision=2019-01-04&content-id=1`;
const YL_1_0 = `${CAP('yang-library:1.0')}?revision=2016-06-21&module-set-id=1`;

const mod = (name: string, ns: string, revision: string | undefined, ...rest: XmlElement[]): XmlElement =>
  x('module', x('name', name), ...(revision === undefined ? [] : [x('revision', revision)]), x('namespace', ns), ...rest);

/** An NMDA library: config and state module sets, two schemas, datastores split between them. */
const LIBRARY = x('yang-library', { xmlns: YL, 'xmlns:ds': DS },
  x('module-set', x('name', 'config'),
    mod('ietf-netconf', NC, '2011-06-01', x('feature', 'writable-running'), x('feature', 'candidate'), x('feature', 'vendor-extra')),
    mod('ietf-interfaces', IF, '2018-02-20', x('feature', 'arbitrary-names'), x('deviation', 'acme-deviations'), x('location', 'https://example.com/ietf-interfaces.yang')),
    mod('acme-deviations', ACME, undefined),
    x('import-only-module', x('name', 'ietf-inet-types'), x('revision', '2013-07-15'), x('namespace', INET)),
  ),
  x('module-set', x('name', 'state'), mod('acme-state', `${ACME}:state`, '2026-01-01', x('submodule', x('name', 'acme-state-sub'), x('revision', '2026-01-01')))),
  x('schema', x('name', 'config'), x('module-set', 'config')),
  x('schema', x('name', 'complete'), x('module-set', 'config'), x('module-set', 'state')),
  x('datastore', x('name', 'ds:running'), x('schema', 'config')),
  x('datastore', x('name', 'ds:candidate'), x('schema', 'config')),
  x('datastore', x('name', 'ds:operational'), x('schema', 'complete')),
  x('content-id', '1'),
);

/** A 1.1 library with module sets but no schemas or datastores (Clixon's shape). */
const NO_DATASTORES = x('yang-library', { xmlns: YL },
  x('module-set', x('name', 'a'), mod('ietf-netconf', NC, '2011-06-01', x('feature', 'candidate'))),
  x('module-set', x('name', 'b'), mod('acme-state', `${ACME}:state`, '2026-01-01')),
  x('content-id', '1'),
);

/** An RFC 7895 library. */
const MODULES_STATE = x('modules-state', { xmlns: YL },
  x('module-set-id', '1'),
  x('module', x('name', 'ietf-netconf'), x('revision', '2011-06-01'), x('namespace', NC), x('feature', 'candidate'), x('conformance-type', 'implement')),
  x('module', x('name', 'ietf-inet-types'), x('revision', '2013-07-15'), x('namespace', INET), x('conformance-type', 'import')),
);

/** Module capabilities as a YANG 1.0 server sends them in its hello. */
const HELLO_MODULES = [
  `${NC}?module=ietf-netconf&revision=2011-06-01&features=writable-running,candidate`,
  `${IF}?module=ietf-interfaces&revision=2018-02-20&deviations=acme-deviations`,
  `${ACME}?module=acme-deviations`,
];

const libraryGet = (op: XmlElement | undefined): string | undefined =>
  op?.name === 'get' ? op.child('filter', NETCONF_NS)?.elements[0]?.name : undefined;

function server(library: () => RpcHandlerResult | Promise<RpcHandlerResult> = () => ({ data: LIBRARY })): RpcHandler {
  return (_rpc, ctx) => (libraryGet(ctx.operation) !== undefined ? library() : 'ok');
}

let clients: NetconfClient[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

async function open(capabilities: string[], handler: RpcHandler = server(), options: Partial<ConnectOptions> = {}) {
  const fake = new FakeServer({ capabilities, handler });
  const client = await connect({ transport: fake.transport(), ...options });
  clients.push(client);
  const warnings: SessionWarning[] = [];
  client.session.on('warning', (w) => warnings.push(w));
  return { fake, client, warnings };
}

const names = (r: ServerModules): string[] => r.modules.map((m) => m.name);
const NMDA = [BASE_1_0, BASE_1_1, YL_1_1];

describe('CONTENT-13: client.content.modules() from an NMDA YANG library', () => {
  it("lists running's modules by default, implemented first, with every field", async () => {
    const { fake, client } = await open(NMDA);
    const result = await client.content.modules();
    expect(result.source).toBe('yang-library');
    expect(result.schema).toBe('config');
    expect(names(result)).toEqual(['ietf-netconf', 'ietf-interfaces', 'acme-deviations', 'ietf-inet-types']);
    expect(result.modules[1]).toEqual({
      name: 'ietf-interfaces',
      revision: '2018-02-20',
      namespace: IF,
      conformance: 'implement',
      features: ['arbitrary-names'],
      deviations: ['acme-deviations'],
      submodules: [],
      locations: ['https://example.com/ietf-interfaces.yang'],
    });
    expect(result.modules[2]).not.toHaveProperty('revision');
    expect(result.modules[3]).toEqual({
      name: 'ietf-inet-types',
      revision: '2013-07-15',
      namespace: INET,
      conformance: 'import',
      features: [],
      deviations: [],
      submodules: [],
      locations: [],
    });
    expect(fake.requests).toHaveLength(1);
  });

  it("selects another datastore's schema, by name or identity", async () => {
    const { client } = await open(NMDA);
    const operational = await client.content.modules({ datastore: 'operational' });
    expect(operational.schema).toBe('complete');
    expect(names(operational)).toContain('acme-state');
    expect(operational.modules.find((m) => m.name === 'acme-state')?.submodules).toEqual([{ name: 'acme-state-sub', revision: '2026-01-01', locations: [] }]);
    const byIdentity = await client.content.modules({ datastore: { name: 'candidate', namespace: DS } });
    expect(byIdentity.schema).toBe('config');
    expect(names(byIdentity)).not.toContain('acme-state');
  });

  it('selects a schema by name', async () => {
    const { client } = await open(NMDA);
    const result = await client.content.modules({ schema: 'complete' });
    expect(result.schema).toBe('complete');
    expect(names(result)).toEqual(['ietf-netconf', 'ietf-interfaces', 'acme-deviations', 'acme-state', 'ietf-inet-types']);
  });

  it("rejects a datastore or schema the library doesn't list", async () => {
    const { client } = await open(NMDA);
    await expect(client.content.modules({ datastore: 'startup' })).rejects.toSatisfy((e) => e instanceof SchemaUnavailableError && /doesn't list datastore startup/.test(e.message));
    await expect(client.content.modules({ schema: 'nope' })).rejects.toSatisfy((e) => e instanceof SchemaUnavailableError && /no schema "nope"/.test(e.message));
  });

  it('refuses datastore and schema together, sending nothing', async () => {
    const { fake, client } = await open(NMDA);
    await expect(client.content.modules({ datastore: 'running', schema: 'config' })).rejects.toThrow(TypeError);
    expect(fake.requests).toHaveLength(0);
  });

  it('keeps one module by name; an unknown name gives an empty list', async () => {
    const { client } = await open(NMDA);
    expect(names(await client.content.modules({ module: 'ietf-netconf' }))).toEqual(['ietf-netconf']);
    expect(names(await client.content.modules({ module: 'ietf-inet-types' }))).toEqual(['ietf-inet-types']);
    expect((await client.content.modules({ module: 'no-such-module' })).modules).toEqual([]);
  });

  it('shares the session library read; refresh reads it again', async () => {
    const { fake, client } = await open(NMDA);
    await client.content.datastores();
    await client.content.modules();
    expect(fake.requests).toHaveLength(1);
    await client.content.modules({ refresh: true });
    expect(fake.requests).toHaveLength(2);
  });

  it('rejects when the library read fails, and reads again next time', async () => {
    let fail = true;
    const { client } = await open(NMDA, server(() => {
      if (!fail) return { data: LIBRARY };
      fail = false;
      return { errors: [{ type: 'application', tag: 'access-denied', message: 'no' }] };
    }));
    await expect(client.content.modules()).rejects.toThrow(/access-denied|no/);
    await expect(client.content.modules()).resolves.toHaveProperty('source', 'yang-library');
  });

  it("rejects with AbortError when the caller's signal aborts", async () => {
    const { client } = await open(NMDA, server(() => new Promise<RpcHandlerResult>(() => {})));
    const ac = new AbortController();
    const pending = client.content.modules({ signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toThrow(AbortError);
  });
});

describe('CONTENT-13: libraries without datastores', () => {
  it('merges every module set of a 1.1 library listing no datastores, for any datastore', async () => {
    const { client } = await open(NMDA, server(() => ({ data: NO_DATASTORES })));
    const result = await client.content.modules({ datastore: 'candidate' });
    expect(result).toMatchObject({ source: 'yang-library' });
    expect(result).not.toHaveProperty('schema');
    expect(names(result)).toEqual(['ietf-netconf', 'acme-state']);
    await expect(client.content.modules({ schema: 'a' })).rejects.toSatisfy((e) => e instanceof SchemaUnavailableError && /names no schemas/.test(e.message));
  });

  it('reads an RFC 7895 library on a :yang-library:1.0 server', async () => {
    const { client } = await open([BASE_1_0, BASE_1_1, YL_1_0], server(() => ({ data: MODULES_STATE })));
    const result = await client.content.modules();
    expect(result.source).toBe('yang-library');
    expect(result.modules.map((m) => [m.name, m.conformance, m.features])).toEqual([
      ['ietf-netconf', 'implement', ['candidate']],
      ['ietf-inet-types', 'import', []],
    ]);
  });
});

describe('CONTENT-13: from the hello', () => {
  it("uses the hello's module capabilities without a YANG library, sending nothing", async () => {
    const { fake, client } = await open([BASE_1_0, BASE_1_1, ...HELLO_MODULES]);
    const result = await client.content.modules({ datastore: 'candidate' });
    expect(result.source).toBe('capabilities');
    expect(result).not.toHaveProperty('schema');
    expect(result.modules).toEqual([
      { name: 'ietf-netconf', revision: '2011-06-01', namespace: NC, conformance: 'implement', features: ['writable-running', 'candidate'], deviations: [], submodules: [], locations: [] },
      { name: 'ietf-interfaces', revision: '2018-02-20', namespace: IF, conformance: 'implement', features: [], deviations: ['acme-deviations'], submodules: [], locations: [] },
      { name: 'acme-deviations', namespace: ACME, conformance: 'implement', features: [], deviations: [], submodules: [], locations: [] },
    ]);
    expect(fake.requests).toHaveLength(0);
    await expect(client.content.modules({ schema: 'config' })).rejects.toSatisfy((e) => e instanceof SchemaUnavailableError && /no YANG library/.test(e.message));
  });

  it('falls back to the hello when the library lists no modules', async () => {
    const empty = x('yang-library', { xmlns: YL }, x('content-id', '1'));
    const { client } = await open([...NMDA, ...HELLO_MODULES], server(() => ({ data: empty })));
    const result = await client.content.modules();
    expect(result.source).toBe('capabilities');
    expect(names(result)).toEqual(['ietf-netconf', 'ietf-interfaces', 'acme-deviations']);
  });

  it("follows the profile's capability corrections, and ignores hello modules when a library is advertised", async () => {
    const device = compileProfile({ id: 'trimmed', capabilities: { remove: [`${IF}?module=ietf-interfaces&revision=2018-02-20&deviations=acme-deviations`] } }).profile;
    const { client } = await open([BASE_1_0, BASE_1_1, ...HELLO_MODULES], server(), { profile: device });
    expect(names(await client.content.modules())).toEqual(['ietf-netconf', 'acme-deviations']);

    const nmda = await open([...NMDA, `${ACME}:hello-only?module=hello-only`]);
    expect(names(await nmda.client.content.modules())).not.toContain('hello-only');
  });
});

describe('CONTENT-13: declared features', () => {
  it("adds every declared feature with whether it's supported, and the undeclared ones", async () => {
    const { client } = await open(NMDA);
    const [netconf] = (await client.content.modules({ module: 'ietf-netconf', declared: true })).modules;
    expect(netconf?.declared?.map((f) => f.name)).toEqual(['writable-running', 'candidate', 'confirmed-commit', 'rollback-on-error', 'validate', 'startup', 'url', 'xpath']);
    const supported = netconf?.declared?.filter((f) => f.supported).map((f) => f.name);
    expect(supported).toEqual(['writable-running', 'candidate']);
    expect(netconf?.undeclared).toEqual(['vendor-extra']);
    expect(netconf?.features).toEqual(['writable-running', 'candidate', 'vendor-extra']);
  });

  it('compiles from the hello when the library lists no modules', async () => {
    const empty = x('yang-library', { xmlns: YL }, x('content-id', '1'));
    const { client, warnings } = await open([...NMDA, ...HELLO_MODULES], server(() => ({ data: empty })));
    const [netconf] = (await client.content.modules({ module: 'ietf-netconf', declared: true })).modules;
    expect(netconf?.declared?.filter((f) => f.supported).map((f) => f.name)).toEqual(['writable-running', 'candidate']);
    expect(warnings).toEqual([]);
  });

  it('works from the hello and from an RFC 7895 library', async () => {
    const hello = await open([BASE_1_0, BASE_1_1, ...HELLO_MODULES]);
    const fromHello = (await hello.client.content.modules({ module: 'ietf-netconf', declared: true })).modules[0];
    expect(fromHello?.declared?.filter((f) => f.supported).map((f) => f.name)).toEqual(['writable-running', 'candidate']);
    expect(fromHello?.undeclared).toEqual([]);

    const legacy = await open([BASE_1_0, BASE_1_1, YL_1_0], server(() => ({ data: MODULES_STATE })));
    const fromLegacy = (await legacy.client.content.modules({ module: 'ietf-netconf', declared: true })).modules[0];
    expect(fromLegacy?.declared?.filter((f) => f.supported).map((f) => f.name)).toEqual(['candidate']);
  });

  it("omits declared for a module whose source isn't found, with a warning, and for import-only modules", async () => {
    const { client, warnings } = await open(NMDA);
    const { modules } = await client.content.modules({ declared: true });
    const acme = modules.find((m) => m.name === 'acme-deviations');
    expect(acme).not.toHaveProperty('declared');
    expect(acme).not.toHaveProperty('undeclared');
    expect(modules.find((m) => m.name === 'ietf-inet-types')).not.toHaveProperty('declared');
    expect(modules.find((m) => m.name === 'ietf-netconf')?.declared).toBeDefined();
    expect(warnings.map((w) => w.message).join('\n')).toMatch(/no YANG source found for acme-deviations/);
  });

  it('reads no source without declared', async () => {
    const { client } = await open(NMDA);
    const { modules } = await client.content.modules();
    expect(modules.some((m) => 'declared' in m)).toBe(false);
  });
});

describe('CONTENT-13: exported types', () => {
  it('types the call with ModulesOptions, ServerModules, ServerModule and DeclaredFeature', async () => {
    const { client } = await open([BASE_1_0, BASE_1_1, ...HELLO_MODULES]);
    const options: ModulesOptions = { module: 'ietf-netconf', declared: true };
    const result: ServerModules = await client.content.modules(options);
    const first: ServerModule | undefined = result.modules[0];
    const feature: DeclaredFeature | undefined = first?.declared?.[0];
    expect([first?.name, feature?.name]).toEqual(['ietf-netconf', 'writable-running']);
  });
});
