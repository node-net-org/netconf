/**
 * CONTENT-04: module namespaces from the YANG library (RFC 8525), for modules
 * the hello doesn't list (every YANG 1.1 module), against the fake server.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { compileProfile } from '../../src/devices/profile-spec.js';
import {
  AbortError,
  TimeoutError,
  BASE_1_0,
  BASE_1_1,
  ConfigTransaction,
  connect,
  NETCONF_NS,
  PathError,
  serializeXml,
  x,
  type ConnectOptions,
  type NamespaceSource,
  type NetconfClient,
  type XmlElement,
} from '../../src/index.js';
import { FakeServer, type RpcHandler, type RpcHandlerResult } from '../../src/testing/index.js';

const CAP = (n: string): string => `urn:ietf:params:netconf:capability:${n}`;
const YL = 'urn:ietf:params:xml:ns:yang:ietf-yang-library';
const YL_CAP = `${CAP('yang-library:1.1')}?revision=2019-01-04&content-id=1`;
const EX = 'urn:example:clixon';
const IMP = 'urn:example:types';
const IF_NS = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
const HELLO_IF = `${IF_NS}?module=ietf-interfaces&revision=2018-02-20`;
const CAPS = [BASE_1_0, BASE_1_1, CAP('writable-running:1.0'), YL_CAP, HELLO_IF];

/** A library in Clixon's shape: one module set, no datastores. */
const LIBRARY = x('yang-library', { xmlns: YL },
  x('module-set', x('name', 'top'),
    x('module', x('name', 'clixon-example'), x('revision', '2022-11-01'), x('namespace', EX)),
    // A library entry that disagrees with the hello must not win over it.
    x('module', x('name', 'ietf-interfaces'), x('namespace', 'urn:example:wrong')),
    x('import-only-module', x('name', 'example-types'), x('revision', '2020-01-01'), x('namespace', IMP)),
  ),
  x('content-id', '1'),
);

const DATA = x('table', { xmlns: EX }, x('parameter', x('name', 'a'), x('value', '1')));

const isLibraryGet = (op: XmlElement | undefined): boolean =>
  op?.name === 'get' && op.child('filter', NETCONF_NS)?.elements[0]?.name === 'yang-library';

/** Answer the library get with `library`, other gets/get-configs with DATA, and edits with ok. */
function server(library: () => RpcHandlerResult | Promise<RpcHandlerResult> = () => ({ data: LIBRARY })): RpcHandler {
  return (_rpc, ctx) => {
    if (isLibraryGet(ctx.operation)) return library();
    if (ctx.operation?.name === 'get' || ctx.operation?.name === 'get-config') return { data: DATA };
    return 'ok';
  };
}

let clients: NetconfClient[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

async function open(handler: RpcHandler = server(), capabilities = CAPS, options: Partial<ConnectOptions> = {}) {
  const fake = new FakeServer({ capabilities, handler });
  const client = await connect({ transport: fake.transport(), ...options });
  clients.push(client);
  return { fake, client };
}

const ops = (fake: FakeServer): string[] => fake.requests.map((r) => (isLibraryGet(r.elements[0]) ? 'yang-library' : r.elements[0]!.name));

describe('CONTENT-04: namespaces from the YANG library', () => {
  describe('loadModules()', () => {
    it('reads /yang-library once and maps modules and import-only modules to namespaces', async () => {
      const { fake, client } = await open();
      const map = await client.content.loadModules();
      // The session's whole map: the hello's ietf-interfaces wins over the library's.
      expect([...map]).toEqual([
        ['ietf-interfaces', IF_NS],
        ['clixon-example', EX],
        ['example-types', IMP],
      ]);
      await client.content.loadModules();
      expect(ops(fake)).toEqual(['yang-library']);
      await client.content.loadModules({ refresh: true });
      expect(ops(fake)).toEqual(['yang-library', 'yang-library']);
    });

    it('sends nothing without :yang-library:1.1, and resolves with what the session knows', async () => {
      const { fake, client } = await open(server(), [BASE_1_0, BASE_1_1, HELLO_IF]);
      expect([...(await client.content.loadModules())]).toEqual([['ietf-interfaces', IF_NS]]);
      expect(fake.requests).toHaveLength(0);
    });

    it("doesn't keep a failed read", async () => {
      let fail = true;
      const { fake, client } = await open(
        server(() => {
          if (!fail) return { data: LIBRARY };
          fail = false;
          return { errors: [{ type: 'application', tag: 'access-denied', message: 'no' }] };
        }),
      );
      await expect(client.content.loadModules()).rejects.toThrow(/access-denied|no/);
      await expect(client.content.loadModules()).resolves.toHaveProperty('size', 3);
      expect(ops(fake)).toEqual(['yang-library', 'yang-library']);
    });

    it("stops a caller waiting when its own signal aborts, while the shared read goes on", async () => {
      let answer: (() => void) | undefined;
      const { fake, client } = await open(
        server(() => new Promise<RpcHandlerResult>((resolve) => (answer = () => resolve({ data: LIBRARY })))),
      );
      const ac = new AbortController();
      const first = client.content.loadModules({ signal: ac.signal });
      const second = client.content.loadModules();
      await new Promise((r) => setTimeout(r, 10));
      ac.abort();
      await expect(first).rejects.toThrow(AbortError);
      answer!();
      await expect(second).resolves.toHaveProperty('size', 3);
      expect(ops(fake)).toEqual(['yang-library']); // one read, shared
    });

    it('sends nothing for an already-aborted signal', async () => {
      const { fake, client } = await open();
      await expect(client.content.loadModules({ signal: AbortSignal.abort() })).rejects.toThrow(AbortError);
      await expect(client.content.read('/clixon-example:table', { signal: AbortSignal.abort(), format: 'xml' })).rejects.toThrow(AbortError);
      expect(fake.requests).toHaveLength(0);
    });

    it("bounds each caller by its own timeout while the shared read goes on", async () => {
      let answer: (() => void) | undefined;
      const { fake, client } = await open(server(() => new Promise<RpcHandlerResult>((resolve) => (answer = () => resolve({ data: LIBRARY })))));
      const patient = client.content.loadModules();
      await expect(client.content.loadModules({ timeout: 30 })).rejects.toThrow(TimeoutError);
      answer!();
      await expect(patient).resolves.toHaveProperty('size', 3);
      expect(ops(fake)).toEqual(['yang-library']);
    });

    it('keeps the first read when a refresh starts during it, even if the refresh fails', async () => {
      const answers: ((r: RpcHandlerResult) => void)[] = [];
      const { client } = await open(server(() => new Promise<RpcHandlerResult>((resolve) => answers.push(resolve))));
      const reading = client.content.read('/clixon-example:table', { format: 'xml' });
      await new Promise((r) => setTimeout(r, 10));
      const refresh = client.content.loadModules({ refresh: true });
      await new Promise((r) => setTimeout(r, 10));
      expect(answers).toHaveLength(2);
      answers[0]!({ data: LIBRARY });
      // The first read's namespaces are used, so the read goes ahead (its get-config is answered by the handler).
      await new Promise((r) => setTimeout(r, 10));
      answers[1]!({ errors: [{ type: 'application', tag: 'operation-failed', message: 'busy' }] });
      await expect(refresh).rejects.toThrow(/busy/);
      expect(client.content.moduleNamespace('clixon-example')).toBe(EX);
      expect(Array.isArray(await reading)).toBe(true);
    });
  });

  describe('lookup order', () => {
    it('connect({ namespaces }), then the profile, then the hello, then the YANG library', async () => {
      const device = compileProfile({
        id: 'p',
        namespaces: { 'clixon-example': 'urn:profile', 'from-profile': 'urn:profile:only', 'ietf-interfaces': 'urn:profile:if' },
      }).profile;
      const { client } = await open(server(), CAPS, {
        profile: device,
        namespaces: { 'from-profile': 'urn:option', 'from-option': 'urn:option:only' },
      });
      const lookups = (): Record<string, string | undefined> =>
        Object.fromEntries(
          ['clixon-example', 'from-profile', 'from-option', 'ietf-interfaces'].map((m) => [m, client.content.moduleNamespace(m)]),
        );
      const expected = {
        'clixon-example': 'urn:profile', // the profile beats the library
        'from-profile': 'urn:option', // the option beats the profile
        'from-option': 'urn:option:only',
        'ietf-interfaces': 'urn:profile:if', // the profile beats the hello
      };
      expect(lookups()).toEqual(expected);
      await client.content.loadModules();
      // Reading the library changes no answer already given.
      expect(lookups()).toEqual(expected);
      expect(client.content.moduleNamespace('example-types')).toBe(IMP); // import-only modules count
      expect(client.content.moduleNamespace('nowhere')).toBeUndefined();
    });

    it('the hello beats the YANG library, before and after the library is read', async () => {
      const { client } = await open();
      expect(client.content.moduleNamespace('ietf-interfaces')).toBe(IF_NS);
      expect(client.content.moduleNamespace('clixon-example')).toBeUndefined();
      await client.content.loadModules();
      expect(client.content.moduleNamespace('ietf-interfaces')).toBe(IF_NS);
      expect(client.content.moduleNamespace('clixon-example')).toBe(EX);
    });

    it('logs at debug level when a given namespace overrides the server’s', async () => {
      const debug: string[] = [];
      const logger = { debug: (m: string) => debug.push(m) };
      const device = compileProfile({ id: 'p', namespaces: { 'ietf-interfaces': 'urn:profile:if' } }).profile;
      const { client } = await open(server(), CAPS, { profile: device, logger });
      client.content.moduleNamespace('ietf-interfaces');
      await client.content.loadModules();
      client.content.moduleNamespace('clixon-example');
      expect(debug.some((m) => /ietf-interfaces overrides the one in the server's hello/.test(m))).toBe(true);
      expect(debug.some((m) => /ietf-interfaces's namespace in the server's YANG library differs/.test(m))).toBe(true);
    });
  });

  describe('moduleNamespaces() and moduleNamespacesInfo()', () => {
    it('send nothing, and grow once the library is read', async () => {
      const { fake, client } = await open();
      expect([...client.content.moduleNamespaces()]).toEqual([['ietf-interfaces', IF_NS]]);
      expect(fake.requests).toHaveLength(0);
      const loaded = await client.content.loadModules();
      expect(client.content.moduleNamespaces()).toBe(loaded); // the same map, until the next read
      expect([...client.content.moduleNamespaces().keys()]).toEqual(['ietf-interfaces', 'clixon-example', 'example-types']);
      expect(ops(fake)).toEqual(['yang-library']);
    });

    it('agree with moduleNamespace() for every module', async () => {
      const device = compileProfile({ id: 'p', namespaces: { 'clixon-example': 'urn:profile' } }).profile;
      const { client } = await open(server(), CAPS, { profile: device, namespaces: { 'from-option': 'urn:option' } });
      await client.content.loadModules();
      const all = client.content.moduleNamespaces();
      for (const [module, ns] of all) expect(client.content.moduleNamespace(module)).toBe(ns);
      expect(all.get('clixon-example')).toBe('urn:profile');
    });

    it('give each namespace its source and what it overrode', async () => {
      const device = compileProfile({
        id: 'p',
        namespaces: { 'clixon-example': 'urn:profile', 'ietf-interfaces': 'urn:profile:if', 'from-profile': 'urn:profile:only' },
      }).profile;
      const { client } = await open(server(), CAPS, { profile: device, namespaces: { 'from-profile': 'urn:option' } });
      expect(Object.fromEntries(client.content.moduleNamespacesInfo())).toEqual({
        'from-profile': { namespace: 'urn:option', source: 'given', overrides: [{ source: 'profile', namespace: 'urn:profile:only' }] },
        'clixon-example': { namespace: 'urn:profile', source: 'profile' },
        'ietf-interfaces': { namespace: 'urn:profile:if', source: 'profile', overrides: [{ source: 'hello', namespace: IF_NS }] },
      });
      await client.content.loadModules();
      expect(Object.fromEntries(client.content.moduleNamespacesInfo())).toEqual({
        'from-profile': { namespace: 'urn:option', source: 'given', overrides: [{ source: 'profile', namespace: 'urn:profile:only' }] },
        'clixon-example': { namespace: 'urn:profile', source: 'profile', overrides: [{ source: 'library', namespace: EX }] },
        'ietf-interfaces': {
          namespace: 'urn:profile:if',
          source: 'profile',
          overrides: [
            { source: 'hello', namespace: IF_NS },
            { source: 'library', namespace: 'urn:example:wrong' },
          ],
        },
        'example-types': { namespace: IMP, source: 'library' },
      });
    });

    it('with source, give that source\'s whole list, winners or not', async () => {
      const device = compileProfile({
        id: 'p',
        namespaces: { 'ietf-interfaces': 'urn:profile:if', 'from-profile': 'urn:profile:only' },
      }).profile;
      const { fake, client } = await open(server(), CAPS, { profile: device, namespaces: { 'from-profile': 'urn:option' } });
      const of = (source: NamespaceSource) => Object.fromEntries(client.content.moduleNamespacesInfo({ source }));
      expect(of('given')).toEqual({ 'from-profile': { namespace: 'urn:option', source: 'given' } });
      // from-profile loses to the option, and the hello's ietf-interfaces to the profile, but each is listed.
      expect(of('profile')).toEqual({
        'ietf-interfaces': { namespace: 'urn:profile:if', source: 'profile' },
        'from-profile': { namespace: 'urn:profile:only', source: 'profile' },
      });
      expect(of('hello')).toEqual({ 'ietf-interfaces': { namespace: IF_NS, source: 'hello' } });
      expect(of('library')).toEqual({});
      expect(fake.requests).toHaveLength(0);
      await client.content.loadModules();
      expect(of('library')).toEqual({
        'clixon-example': { namespace: EX, source: 'library' },
        'ietf-interfaces': { namespace: 'urn:example:wrong', source: 'library' },
        'example-types': { namespace: IMP, source: 'library' },
      });
      expect(client.content.moduleNamespacesInfo({})).toBe(client.content.moduleNamespacesInfo());
      // moduleNamespaces() takes the same option, without the sources.
      expect([...client.content.moduleNamespaces({ source: 'profile' })]).toEqual([
        ['ietf-interfaces', 'urn:profile:if'],
        ['from-profile', 'urn:profile:only'],
      ]);
      expect([...client.content.moduleNamespaces({ source: 'library' })]).toEqual([
        ['clixon-example', EX],
        ['ietf-interfaces', 'urn:example:wrong'],
        ['example-types', IMP],
      ]);
      expect(client.content.moduleNamespaces({})).toBe(client.content.moduleNamespaces());
    });

    it('reject an unknown source', async () => {
      const { client } = await open();
      expect(() => client.content.moduleNamespacesInfo({ source: 'bogus' as NamespaceSource })).toThrow(/Unknown namespace source "bogus"/);
      expect(() => client.content.moduleNamespaces({ source: 'bogus' as NamespaceSource })).toThrow(/Unknown namespace source "bogus"/);
    });

    it('has no overrides entry when sources agree', async () => {
      const { client } = await open(server(), CAPS, { namespaces: { 'ietf-interfaces': IF_NS } });
      expect(client.content.moduleNamespacesInfo().get('ietf-interfaces')).toEqual({ namespace: IF_NS, source: 'given' });
    });

    it('are read-only', async () => {
      const { client } = await open();
      await client.content.loadModules();
      const all = client.content.moduleNamespaces() as Map<string, string>;
      expect(() => all.set('x', 'urn:x')).toThrow(TypeError);
      expect(() => all.delete('ietf-interfaces')).toThrow(TypeError);
      const info = client.content.moduleNamespacesInfo().get('ietf-interfaces')!;
      expect(Object.isFrozen(info)).toBe(true);
      expect(client.content.moduleNamespace('x')).toBeUndefined();
    });
  });

  describe('lazy loading in the async path methods', () => {
    it('read() loads the library on the first unknown module, then reads', async () => {
      const { fake, client } = await open();
      const found = await client.content.read("/clixon-example:table/parameter[name='a']/value", { format: 'xml' });
      expect(found.map((e) => e.text())).toEqual(['1']);
      expect(ops(fake)).toEqual(['yang-library', 'get-config']);
      expect(serializeXml(fake.requests[1]!.elements[0]!)).toContain(`<table xmlns="${EX}">`);
      await client.content.readValue('/clixon-example:table', { format: 'xml' });
      expect(ops(fake)).toEqual(['yang-library', 'get-config', 'get-config']);
    });

    it("read() of a module the hello lists doesn't touch the library", async () => {
      const { fake, client } = await open();
      await client.content.read('/ietf-interfaces:interfaces', { format: 'xml' });
      expect(ops(fake)).toEqual(['get-config']);
    });

    it('configure(), set() and remove() load the library between the build and the edit', async () => {
      const { fake, client } = await open();
      await client.content.configure((txn) => {
        txn.set("/clixon-example:table/parameter[name='b']/value", '2');
        txn.set('/ietf-interfaces:interfaces/interface[name="eth0"]/enabled', true);
      }, { lock: false });
      expect(ops(fake)).toEqual(['yang-library', 'edit-config']);
      const edit = serializeXml(fake.requests[1]!.elements[0]!);
      expect(edit).toContain(`<table xmlns="${EX}"><parameter><name>b</name><value>2</value></parameter></table>`);
      expect(edit).toContain(`<interfaces xmlns="${IF_NS}">`);
      await client.content.remove("/clixon-example:table/parameter[name='b']", { lock: false });
      await client.content.set('/example-types:thing', 1, { lock: false });
      expect(ops(fake)).toEqual(['yang-library', 'edit-config', 'edit-config', 'edit-config']);
    });

    it('rejects with a PathError naming the module, sending nothing more, when the library lacks it', async () => {
      const { fake, client } = await open();
      const err = await client.content.read('/nowhere:top', { format: 'xml' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PathError);
      expect((err as PathError).module).toBe('nowhere');
      expect((err as Error).message).toMatch(/Unknown YANG module "nowhere"/);
      expect((err as Error).message).not.toMatch(/loadModules/);
      await expect(client.content.set('/nowhere:top', 1)).rejects.toThrow(PathError);
      expect(ops(fake)).toEqual(['yang-library']);
    });

    it('turns a failed library read into a PathError with the failure as its cause', async () => {
      const { fake, client } = await open(server(() => ({ errors: [{ type: 'application', tag: 'access-denied', message: 'denied' }] })));
      const err = await client.content.read('/clixon-example:table', { format: 'xml' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PathError);
      expect((err as PathError).module).toBe('clixon-example');
      expect((err as Error).message).toMatch(/^Unknown YANG module "clixon-example" in "\/clixon-example:table": .*; reading the server's YANG library failed: .*denied/);
      expect((err as Error).message).not.toMatch(/loadModules/);
      expect((err as Error).cause).toBeDefined();
      await expect(client.content.configure((txn) => txn.set('/clixon-example:table', null))).rejects.toThrow(PathError);
      expect(ops(fake)).toEqual(['yang-library', 'yang-library']);
    });

    it('rejects with AbortError when the caller aborts during the library read', async () => {
      const { fake, client } = await open(server(() => undefined));
      const ac = new AbortController();
      const reading = client.content.read('/clixon-example:table', { signal: ac.signal, format: 'xml' });
      await new Promise((r) => setTimeout(r, 10));
      ac.abort();
      await expect(reading).rejects.toThrow(AbortError);
      expect(ops(fake)).toEqual(['yang-library']);
    });

    it("doesn't read the library without :yang-library:1.1", async () => {
      const { fake, client } = await open(server(), [BASE_1_0, BASE_1_1, HELLO_IF]);
      await expect(client.content.read('/clixon-example:table', { format: 'xml' })).rejects.toThrow(PathError);
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe('the synchronous resolvers', () => {
    it("toXPath() doesn't read the library; its error says to load it, and it works afterwards", async () => {
      const { fake, client } = await open();
      let err: unknown;
      try {
        client.content.toXPath('/clixon-example:table');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PathError);
      expect((err as PathError).module).toBe('clixon-example');
      expect((err as Error).message).toMatch(/await client\.content\.loadModules\(\) first/);
      expect(fake.requests).toHaveLength(0);
      await client.content.loadModules();
      expect(client.content.toXPath('/clixon-example:table')).toEqual({ type: 'xpath', select: '/clixon-example:table', namespaces: { 'clixon-example': EX } });
      expect(client.content.resolvePath('/clixon-example:table')[0]).toMatchObject({ moduleName: 'clixon-example', ns: EX });
    });

    it("gives no loadModules hint when the server has no YANG library", async () => {
      const { client } = await open(server(), [BASE_1_0, BASE_1_1]);
      expect(() => client.content.toXPath('/clixon-example:table')).toThrow(/Unknown YANG module "clixon-example"/);
      expect(() => client.content.toXPath('/clixon-example:table')).not.toThrow(/loadModules/);
    });
  });

  describe('ConfigTransaction', () => {
    it('throws a malformed path at once, and resolves namespaces only when built', () => {
      const resolved: string[] = [];
      const txn = new ConfigTransaction((p) => {
        resolved.push(p);
        return [{ module: 'm', moduleName: 'm', name: 'top', keys: [], value: undefined, ns: 'urn:m' }];
      });
      expect(() => txn.set('no-slash', 1)).toThrow(PathError);
      expect(() => txn.set("/m:top[name='a'", 1)).toThrow(PathError);
      txn.set('/m:top', 1);
      txn.remove('@alias');
      expect(resolved).toEqual([]);
      expect(txn.size).toBe(2);
    });

    it('an unknown alias rejects configure() before anything is sent', async () => {
      const { fake, client } = await open();
      await expect(client.content.configure((txn) => txn.set('@missing', 1))).rejects.toThrow(/No path named "@missing"/);
      expect(fake.requests).toHaveLength(0);
    });
  });
});
