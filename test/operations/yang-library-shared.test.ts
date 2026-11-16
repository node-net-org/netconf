/**
 * OPS-18: the RFC 7895 fallback (`/modules-state` on a `:yang-library:1.0`
 * server) and one YANG library read per session, shared by the yangLibrary
 * module, client.content.loadModules() and other modules' support checks.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  AbortError,
  BASE_1_0,
  BASE_1_1,
  CapabilityError,
  connect,
  NETCONF_NS,
  parseXml,
  serializeXml,
  TimeoutError,
  x,
  type NetconfClient,
  type XmlElement,
} from '../../src/index.js';
import { compare } from '../../src/operations/compare.js';
import { subscriptions } from '../../src/operations/subscriptions.js';
import { parseModulesState, yangLibrary, YANG_LIBRARY_NS } from '../../src/operations/yang-library.js';
import { FakeServer, type RpcHandler, type RpcHandlerResult } from '../../src/testing/index.js';

const YL = YANG_LIBRARY_NS;
const CAP = (n: string): string => `urn:ietf:params:netconf:capability:${n}`;
const YL_1_1 = `${CAP('yang-library:1.1')}?revision=2019-01-04&content-id=7`;
const YL_1_0 = `${CAP('yang-library:1.0')}?revision=2016-06-21&module-set-id=ms-42`;
const SN = 'urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications';
const EX = 'urn:example:widgets';
const CMP = 'urn:ietf:params:xml:ns:yang:ietf-nmda-compare';

/** RFC 7895 data in netopeer2's shape, plus features, a deviation and a submodule. */
const MODULES_STATE = x('modules-state', { xmlns: YL },
  x('module-set-id', 'ms-42'),
  x('module', x('name', 'ietf-yang-types'), x('revision', '2013-07-15'), x('namespace', 'urn:ietf:params:xml:ns:yang:ietf-yang-types'), x('conformance-type', 'import')),
  x('module', x('name', 'example-widgets'), x('revision', '2024-01-01'), x('schema', 'file:///y/example-widgets.yang'), x('namespace', EX),
    x('feature', 'fast'), x('feature', 'slow'),
    x('deviation', x('name', 'example-widgets-dev'), x('revision', '2024-02-01')),
    x('conformance-type', 'implement'),
    x('submodule', x('name', 'example-widgets-sub'), x('revision', '2024-01-01'), x('schema', 'file:///y/sub.yang'))),
  x('module', x('name', 'ietf-subscribed-notifications'), x('revision', '2019-09-09'), x('namespace', SN), x('feature', 'replay'), x('conformance-type', 'implement')),
  x('module', x('name', 'no-revision'), x('revision', ''), x('namespace', 'urn:example:norev'), x('conformance-type', 'implement')),
);

const YANG_LIBRARY = x('yang-library', { xmlns: YL },
  x('module-set', x('name', 'all'),
    x('module', x('name', 'example-widgets'), x('namespace', EX)),
    x('module', x('name', 'ietf-nmda-compare'), x('namespace', CMP))),
  x('content-id', '7'),
);

const topOf = (op: XmlElement | undefined): string | undefined =>
  op?.name === 'get' ? op.child('filter', NETCONF_NS)?.elements[0]?.name : undefined;

/** Answer /modules-state, /yang-library, other gets, and compare. */
function server(answer: (top: string) => RpcHandlerResult | Promise<RpcHandlerResult> = (top) => ({ data: top === 'modules-state' ? MODULES_STATE : YANG_LIBRARY })): RpcHandler {
  return (_rpc, ctx) => {
    const top = topOf(ctx.operation);
    if (top === 'modules-state' || top === 'yang-library') return answer(top);
    if (ctx.operation?.name === 'compare') return { body: [x('no-matches', { xmlns: CMP })] };
    if (ctx.operation?.name === 'get' || ctx.operation?.name === 'get-config') return { data: [] };
    return 'ok';
  };
}

let clients: NetconfClient[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

async function open(capabilities: string[], handler: RpcHandler = server(), extensions: readonly unknown[] = [yangLibrary], options: object = {}) {
  const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1, ...capabilities], handler });
  const client = await connect({ transport: fake.transport(), extensions: extensions as [typeof yangLibrary], ...options });
  clients.push(client);
  return { fake, client };
}

const reads = (fake: FakeServer): (string | undefined)[] => fake.requests.map((r) => topOf(r.elements[0]) ?? r.elements[0]!.name);

describe('RFC 7895 /modules-state (OPS-18)', () => {
  it('parses implemented and import-only modules into one module set, with no datastores', () => {
    const lib = parseModulesState(parseXml(serializeXml(MODULES_STATE)));
    expect(lib.version).toBe('1.0');
    expect(lib.contentId).toBe('ms-42');
    expect(lib.schemas).toEqual([]);
    expect(lib.datastores).toEqual([]);
    expect(lib.moduleSets.map((s) => s.name)).toEqual(['modules-state']);
    const [set] = lib.moduleSets;
    expect(set!.modules.map((m) => m.name)).toEqual(['example-widgets', 'ietf-subscribed-notifications', 'no-revision']);
    expect(set!.modules[0]).toEqual({
      name: 'example-widgets',
      revision: '2024-01-01',
      namespace: EX,
      locations: ['file:///y/example-widgets.yang'],
      features: ['fast', 'slow'],
      deviations: ['example-widgets-dev'],
      submodules: [{ name: 'example-widgets-sub', revision: '2024-01-01', locations: ['file:///y/sub.yang'] }],
    });
    expect(set!.modules[2]).not.toHaveProperty('revision');
    expect(set!.importOnlyModules).toEqual([
      { name: 'ietf-yang-types', revision: '2013-07-15', namespace: 'urn:ietf:params:xml:ns:yang:ietf-yang-types', locations: [], submodules: [] },
    ]);
    expect(JSON.parse(JSON.stringify(lib))).toEqual(lib);
    expect(Object.isFrozen(set!.modules[0]!.features)).toBe(true);
  });

  it('on a server with only :yang-library:1.0, yangLibrary() reads /modules-state', async () => {
    const { fake, client } = await open([YL_1_0]);
    const lib = await client.content.yangLibrary.load();
    expect(reads(fake)).toEqual(['modules-state']);
    expect(lib.version).toBe('1.0');
    expect(lib.contentId).toBe('ms-42');
    expect(client.content.yangLibrary.contentId).toBe('ms-42');
  });

  it('prefers /yang-library when the server has both', async () => {
    const { fake, client } = await open([YL_1_1, YL_1_0]);
    expect((await client.content.yangLibrary.load()).version).toBe('1.1');
    expect(reads(fake)).toEqual(['yang-library']);
    expect(client.content.yangLibrary.contentId).toBe('7');
  });

  it('connects without either capability, then refuses yangLibrary() before sending (strict), or reads under warn', async () => {
    const strict = await open([]);
    await expect(strict.client.content.yangLibrary.load()).rejects.toThrow(/:yang-library:1\.1 or :yang-library:1\.0/);
    await expect(strict.client.content.yangLibrary.load()).rejects.toThrow(CapabilityError);
    expect(strict.fake.requests).toHaveLength(0);

    const warnings: string[] = [];
    const warn = await open([], server(), [yangLibrary], { capabilityCheck: 'warn', logger: { warn: (m: string) => warnings.push(m) } });
    await warn.client.content.yangLibrary.load();
    expect(reads(warn.fake)).toEqual(['yang-library']);
    expect(warnings.join()).toMatch(/yang-library:1\.0/);
  });

  it('a 1.0 server answering with no /modules-state gives an empty library', async () => {
    const { fake, client } = await open([YL_1_0], server(() => ({ data: [] })));
    const lib = await client.content.yangLibrary.load();
    expect(lib).toMatchObject({ version: '1.0', contentId: '', datastores: [] });
    expect(lib.moduleSets[0]!.modules).toEqual([]);
    expect(reads(fake)).toEqual(['modules-state']);
  });

  it("under capabilityCheck 'off', yangLibrary() reads without either capability and without a warning; loadModules() then agrees", async () => {
    const warnings: string[] = [];
    const { fake, client } = await open([], server(), [yangLibrary], { capabilityCheck: 'off', logger: { warn: (m: string) => warnings.push(m) } });
    await client.content.yangLibrary.load();
    expect(reads(fake)).toEqual(['yang-library']);
    expect(warnings).toEqual([]);
    expect((await client.content.loadModules()).get('example-widgets')).toBe(EX);
    expect(client.content.moduleNamespace('example-widgets')).toBe(EX);
    expect(reads(fake)).toEqual(['yang-library']);
  });

  it('client paths resolve YANG 1.1 modules from /modules-state on a 1.0 server', async () => {
    const { fake, client } = await open([YL_1_0], server(), []);
    await client.content.read('/example-widgets:widgets', { format: 'xml' });
    expect(reads(fake)).toEqual(['modules-state', 'get-config']);
    expect(client.content.moduleNamespace('example-widgets')).toBe(EX);
    expect(client.content.moduleNamespace('ietf-yang-types')).toBe('urn:ietf:params:xml:ns:yang:ietf-yang-types');
  });

  it("subscriptions' support check reads /modules-state on a 1.0 server", async () => {
    const { fake, client } = await open([YL_1_0, CAP('notification:1.0')], server(), [subscriptions]);
    const support = await (client.content as unknown as { subscriptions: { support(): Promise<{ subscribedNotifications?: { features: readonly string[] } }> } }).subscriptions.support();
    expect(support.subscribedNotifications?.features).toEqual(['replay']);
    expect(reads(fake)).toEqual(['modules-state']);
  });
});

describe('one YANG library read per session (OPS-18)', () => {
  it('yangLibrary() then loadModules() sends one read, and so does the reverse', async () => {
    const a = await open([YL_1_1]);
    await a.client.content.yangLibrary.load();
    expect((await a.client.content.loadModules()).get('example-widgets')).toBe(EX);
    expect(reads(a.fake)).toEqual(['yang-library']);

    const b = await open([YL_1_1]);
    await b.client.content.loadModules();
    await b.client.content.yangLibrary.load();
    expect(reads(b.fake)).toEqual(['yang-library']);
  });

  it("compare's support check uses the same read", async () => {
    const { fake, client } = await open([YL_1_1], server(), [yangLibrary, compare]);
    await client.content.yangLibrary.load();
    await (client.ops as unknown as { compare: { datastores(o: object): Promise<unknown> } }).compare.datastores({ source: 'running', target: 'candidate' });
    await client.content.read('/example-widgets:widgets', { format: 'xml' });
    expect(reads(fake)).toEqual(['yang-library', 'compare', 'get-config']);
  });

  it('a refresh through either updates both; a failed refresh keeps the last good library', async () => {
    let second = false;
    const { fake, client } = await open(
      [YL_1_1],
      server((top) => {
        if (top !== 'yang-library') return { data: [] };
        if (!second) return { data: YANG_LIBRARY };
        return { errors: [{ type: 'application', tag: 'operation-failed', message: 'busy' }] };
      }),
    );
    await client.content.yangLibrary.load();
    second = true;
    await expect(client.content.loadModules({ refresh: true })).rejects.toThrow(/busy/);
    // Paths keep resolving from the last good library, and plain calls get it without sending.
    expect(client.content.moduleNamespace('example-widgets')).toBe(EX);
    await expect(client.content.yangLibrary.load()).resolves.toHaveProperty('contentId', '7');
    await expect(client.content.loadModules()).resolves.toHaveProperty('size', 2);
    expect(reads(fake)).toEqual(['yang-library', 'yang-library']);
    // Only a refresh reads again; a failed one isn't kept, so the next refresh tries.
    second = false;
    await expect(client.content.loadModules({ refresh: true })).resolves.toHaveProperty('size', 2);
    expect(reads(fake)).toEqual(['yang-library', 'yang-library', 'yang-library']);
  });

  it('concurrent callers share one read; each stops on its own signal or timeout', async () => {
    let answer: (() => void) | undefined;
    const { fake, client } = await open(
      [YL_1_1],
      server(() => new Promise<RpcHandlerResult>((resolve) => (answer = () => resolve({ data: YANG_LIBRARY })))),
    );
    const ac = new AbortController();
    const aborting = client.content.yangLibrary.load({ signal: ac.signal });
    const hurried = client.content.loadModules({ timeout: 20 });
    const patient = client.content.yangLibrary.load();
    await expect(hurried).rejects.toThrow(TimeoutError);
    ac.abort();
    await expect(aborting).rejects.toThrow(AbortError);
    answer!();
    await expect(patient).resolves.toHaveProperty('version', '1.1');
    expect(reads(fake)).toEqual(['yang-library']);
    await expect(client.content.yangLibrary.load({ signal: AbortSignal.abort() })).rejects.toThrow(AbortError);
    expect(reads(fake)).toEqual(['yang-library']);
  });

  it("a short timeout on the caller that starts the read doesn't fail the others", async () => {
    let answer: (() => void) | undefined;
    const { fake, client } = await open(
      [YL_1_1],
      server(() => new Promise<RpcHandlerResult>((resolve) => (answer = () => resolve({ data: YANG_LIBRARY })))),
    );
    const hurried = client.content.loadModules({ timeout: 20 }); // starts the shared read
    const patient = client.content.yangLibrary.load();
    await expect(hurried).rejects.toThrow(TimeoutError);
    await new Promise((r) => setTimeout(r, 30));
    answer!();
    await expect(patient).resolves.toHaveProperty('version', '1.1');
    expect(reads(fake)).toEqual(['yang-library']);
  });

  it('a newer read is kept when an older one finishes after it', async () => {
    const answers: ((r: RpcHandlerResult) => void)[] = [];
    const { client } = await open([YL_1_1], server(() => new Promise<RpcHandlerResult>((resolve) => answers.push(resolve))));
    const older = client.content.yangLibrary.load();
    await new Promise((r) => setTimeout(r, 10));
    const newer = client.content.yangLibrary.load({ refresh: true });
    await new Promise((r) => setTimeout(r, 10));
    const newerLibrary = x('yang-library', { xmlns: YL }, x('module-set', x('name', 'all'), x('module', x('name', 'only-newer'), x('namespace', 'urn:example:newer'))), x('content-id', '8'));
    answers[1]!({ data: newerLibrary });
    await expect(newer).resolves.toHaveProperty('contentId', '8');
    answers[0]!({ data: YANG_LIBRARY });
    await expect(older).resolves.toHaveProperty('contentId', '7');
    expect(client.content.moduleNamespace('only-newer')).toBe('urn:example:newer');
    expect(client.content.moduleNamespace('example-widgets')).toBeUndefined();
    await expect(client.content.yangLibrary.load()).resolves.toHaveProperty('contentId', '8');
  });

  it("subscriptions' support({ refresh: true }) reads the library again", async () => {
    const { fake, client } = await open([YL_1_1, CAP('notification:1.0')], server(), [subscriptions]);
    const subs = (client.content as unknown as { subscriptions: { support(o?: object): Promise<unknown> } }).subscriptions;
    await subs.support();
    await subs.support();
    expect(reads(fake)).toEqual(['yang-library']);
    await subs.support({ refresh: true });
    expect(reads(fake)).toEqual(['yang-library', 'yang-library']);
  });

  it("separate sessions don't share", async () => {
    const a = await open([YL_1_1]);
    const b = await open([YL_1_1]);
    await a.client.content.yangLibrary.load();
    await b.client.content.yangLibrary.load();
    expect(reads(a.fake)).toEqual(['yang-library']);
    expect(reads(b.fake)).toEqual(['yang-library']);
  });
});
