/**
 * The nmda (OPS-17) and yang-library (OPS-18) protocol modules, against the fake server.
 */
import { describe, expect, it } from 'vitest';
import {
  BASE_1_0,
  BASE_1_1,
  CapabilityError,
  connect,
  parseXml,
  serializeXml,
  subtree,
  x,
  xpath,
  type XmlElement,
} from '../../src/index.js';
import { DATASTORES_NS, NMDA_NS, ORIGIN_NS, getDataRequest, nmda, originOf, origins } from '../../src/operations/nmda.js';
import { findDatastore, parseYangLibrary, yangLibrary, YANG_LIBRARY_NS } from '../../src/operations/yang-library.js';
import { FakeServer, type RpcHandler } from '../../src/testing/index.js';

const CAP = (n: string): string => `urn:ietf:params:netconf:capability:${n}`;
const YL11 = `${CAP('yang-library:1.1')}?revision=2019-01-04&content-id=c42`;
const ALL = [BASE_1_0, BASE_1_1, YL11, CAP('xpath:1.0'), CAP('url:1.0'), `${CAP('with-defaults:1.0')}?basic-mode=explicit&also-supported=report-all`];
const EX = 'urn:example:ex';

async function open(handler: RpcHandler = () => 'ok', capabilities = ALL) {
  const fake = new FakeServer({ capabilities, handler });
  const client = await connect({ transport: fake.transport(), extensions: [nmda, yangLibrary] });
  return { fake, client };
}

const lastOp = (fake: FakeServer): XmlElement => fake.requests.at(-1)!.elements[0]!;
const xml = (el: XmlElement) => serializeXml(el);

describe('nmda extension (OPS-17)', () => {
  it('requires :yang-library:1.1', async () => {
    const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
    await expect(connect({ transport: fake.transport(), extensions: [nmda] })).rejects.toThrow(CapabilityError);
  });

  describe('get-data request', () => {
    it('sends the datastore as an identity with its prefix bound on the element', () => {
      expect(xml(getDataRequest({ datastore: 'operational' }).element)).toBe(
        `<get-data xmlns="${NMDA_NS}"><datastore xmlns:ds="${DATASTORES_NS}">ds:operational</datastore></get-data>`,
      );
      expect(xml(getDataRequest({ datastore: { name: 'ephemeral', namespace: EX } }).element)).toContain(
        `<datastore xmlns:id="${EX}">id:ephemeral</datastore>`,
      );
    });

    it('puts every option in YANG input order', () => {
      const req = getDataRequest({
        datastore: 'operational',
        filter: subtree(x('top', { xmlns: EX })),
        configFilter: true,
        originFilter: ['intended', 'system'],
        maxDepth: 3,
        withOrigin: true,
        withDefaults: 'report-all',
      });
      expect(req.element.elements.map((e) => e.name)).toEqual([
        'datastore', 'subtree-filter', 'config-filter', 'origin-filter', 'origin-filter', 'max-depth', 'with-origin', 'with-defaults',
      ]);
      expect(xml(req.element)).toContain(`<subtree-filter><top xmlns="${EX}"/></subtree-filter>`);
      expect(xml(req.element)).toContain(`<origin-filter xmlns:or="${ORIGIN_NS}">or:system</origin-filter>`);
      // with-defaults is in the nmda namespace: it comes from a grouping that ietf-netconf-nmda uses.
      // (Built but unsent, the child inherits the namespace; check it as it goes on the wire.)
      const wire = parseXml(xml(req.element));
      expect(wire.child('with-defaults', NMDA_NS)?.text()).toBe('report-all');
      expect(req.requires).toEqual([':with-defaults:1.0', 'urn:ietf:params:netconf:capability:with-operational-defaults:1.0']);
    });

    it('sends an XPath filter with its namespaces, requiring :xpath', () => {
      const req = getDataRequest({ datastore: 'running', filter: xpath('/e:top', { e: EX }) });
      expect(xml(req.element)).toContain(`<xpath-filter xmlns:e="${EX}">/e:top</xpath-filter>`);
      expect(req.requires).toEqual([':xpath']);
    });

    it('takes maxDepth as decimal text too, as its descriptor (type string) gives it', () => {
      for (const [text, sent] of [['1', '1'], ['2', '2'], ['65535', '65535']] as const) {
        const fromText = getDataRequest({ datastore: 'operational', maxDepth: text });
        const fromNumber = getDataRequest({ datastore: 'operational', maxDepth: Number(text) });
        expect(fromText.element.child('max-depth')?.text()).toBe(sent);
        expect(xml(fromText.element)).toBe(xml(fromNumber.element));
      }
    });

    it.each<unknown>(['0', '65536', '2.5', ' 2', '2 ', '-1', '+2', '1e2', '0x10', '02', '', 'two', 'Unbounded', '1'.repeat(400), true, {}, NaN, Infinity, null])(
      'refuses maxDepth %j with a TypeError',
      (value) => {
        const build = () => getDataRequest({ datastore: 'operational', maxDepth: value });
        expect(build).toThrow(TypeError);
        expect(build).toThrow(/maxDepth/);
      },
    );

    it('negated origins, unbounded depth, and a single origin value', () => {
      const req = getDataRequest({ datastore: 'operational', negatedOriginFilter: 'default', maxDepth: 'unbounded' });
      expect(req.element.childrenNamed('negated-origin-filter').map((e) => e.text())).toEqual(['or:default']);
      expect(req.element.child('max-depth')?.text()).toBe('unbounded');
    });

    it.each([
      [{ datastore: 'running', withOrigin: true }, /operational/],
      [{ datastore: 'intended', originFilter: 'system' }, /operational/],
      [{ datastore: 'operational', originFilter: 'system', negatedOriginFilter: 'default' }, /not both/],
      [{ datastore: 'operational', maxDepth: 0 }, /maxDepth/],
      [{ datastore: 'operational', maxDepth: 65536 }, /maxDepth/],
      [{ datastore: 'operational', maxDepth: 2.5 }, /maxDepth/],
      [{ datastore: 'operational', withDefaults: 'all' }, /withDefaults/],
      [{ datastore: 'operational', configFilter: 'yes' }, /configFilter/],
      [{ datastore: 'nowhere' }, /Unknown datastore/],
      [{ datastore: { name: 'bad name', namespace: EX } }, /Invalid datastore/],
      [{ datastore: 'operational', originFilter: 'somewhere' }, /Unknown origin/],
    ])('refuses %o with a TypeError', (args, message) => {
      expect(() => getDataRequest(args)).toThrow(message);
    });

    it('allows origin options on a non-standard datastore', () => {
      expect(() => getDataRequest({ datastore: { name: 'oper-x', namespace: EX }, withOrigin: true })).not.toThrow();
    });
  });

  describe('getData', () => {
    it('resolves with the nmda <data> element, carrying prefix declarations from the reply', async () => {
      const raw = `<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" xmlns:or="${ORIGIN_NS}"><data xmlns="${NMDA_NS}"><top xmlns="${EX}" or:origin="or:learned"><a>1</a></top></data></rpc-reply>`;
      const { client } = await open(() => ({ body: parseXml(raw).children }));
      const data = await client.ops.nmda.getData({ datastore: 'operational', withOrigin: true });
      expect([data.name, data.ns]).toEqual(['data', NMDA_NS]);
      const top = data.child('top', EX)!;
      expect(originOf(data, top)).toBe('ietf-origin:learned');
      expect(originOf(data, top.child('a', EX)!)).toBe('ietf-origin:learned');
      await client.close();
    });

    it('an empty reply gives an empty <data>', async () => {
      const { client } = await open();
      const data = await client.ops.nmda.getData({ datastore: 'running' });
      expect([data.name, data.ns, data.children.length]).toEqual(['data', NMDA_NS, 0]);
      await client.close();
    });

    it('with-defaults: mode and capabilities are checked before sending', async () => {
      const { fake, client } = await open(() => ({ data: [] }));
      await expect(client.ops.nmda.getData({ datastore: 'running', withDefaults: 'trim' })).rejects.toThrow(/with-defaults mode trim/);
      await expect(client.ops.nmda.getData({ datastore: 'operational', withDefaults: 'report-all' })).rejects.toThrow(/with-operational-defaults/);
      expect(fake.requests).toHaveLength(0);
      await client.ops.nmda.getData({ datastore: 'running', withDefaults: 'report-all' });
      expect(lastOp(fake).child('with-defaults', NMDA_NS)?.text()).toBe('report-all');
      await client.close();
    });

    it('an XPath filter without :xpath is refused', async () => {
      const { fake, client } = await open(() => 'ok', [BASE_1_0, BASE_1_1, YL11]);
      await expect(client.ops.nmda.getData({ datastore: 'running', filter: xpath('/a') })).rejects.toThrow(CapabilityError);
      expect(fake.requests).toHaveLength(0);
      await client.close();
    });
  });

  describe('editData', () => {
    it('sends <edit-data> with config, and needs exactly one of config and url', async () => {
      const { fake, client } = await open();
      await client.ops.nmda.editData({ datastore: 'running', config: x('top', { xmlns: EX }, x('a', '1')), defaultOperation: 'replace' });
      expect(xml(lastOp(fake))).toBe(
        `<edit-data xmlns="${NMDA_NS}"><datastore xmlns:ds="${DATASTORES_NS}">ds:running</datastore><default-operation>replace</default-operation><config><top xmlns="${EX}"><a>1</a></top></config></edit-data>`,
      );
      await client.ops.nmda.editData({ datastore: 'candidate', url: 'file:///c.xml' });
      expect(lastOp(fake).child('url')?.text()).toBe('file:///c.xml');
      await expect(client.ops.nmda.editData({ datastore: 'running' })).rejects.toThrow(TypeError);
      await expect(client.ops.nmda.editData({ datastore: 'running', config: x('a'), url: 'u' })).rejects.toThrow(TypeError);
      await client.close();
    });

    it('a url needs :url', async () => {
      const { client } = await open(() => 'ok', [BASE_1_0, BASE_1_1, YL11]);
      await expect(client.ops.nmda.editData({ datastore: 'running', url: 'file:///x' })).rejects.toThrow(CapabilityError);
      await client.close();
    });
  });

  describe('descriptors (OPS-13)', () => {
    it('get-data and edit-data are plain data and run with the same XML as the methods', async () => {
      const { fake, client } = await open(() => ({ data: [] }));
      const getData = client.ops.list.find((d) => d.name === 'get-data')!;
      const editData = client.ops.list.find((d) => d.name === 'edit-data')!;
      expect(getData).toMatchObject({ extension: 'nmda', mutates: false, namespace: NMDA_NS });
      expect(editData).toMatchObject({ extension: 'nmda', mutates: true });
      expect(getData.params.find((p) => p.name === 'originFilter')).toMatchObject({ multiple: true });
      expect(JSON.parse(JSON.stringify([getData, editData]))).toEqual([getData, editData]);

      const args = { datastore: 'operational', filter: subtree(x('top', { xmlns: EX })), originFilter: ['intended'], withOrigin: true } as const;
      await client.ops.run('get-data', args);
      const viaDescriptor = xml(lastOp(fake));
      await client.ops.nmda.getData(args);
      expect(xml(lastOp(fake))).toBe(viaDescriptor);
      await client.close();
    });

    it('ops.run() takes maxDepth as text, which is how its string-typed descriptor delivers it', async () => {
      const { fake, client } = await open(() => ({ data: [] }));
      await client.ops.run('get-data', { datastore: 'operational', maxDepth: '2' });
      const viaDescriptor = xml(lastOp(fake));
      expect(lastOp(fake).child('max-depth', NMDA_NS)?.text()).toBe('2');
      await client.ops.nmda.getData({ datastore: 'operational', maxDepth: 2 });
      expect(xml(lastOp(fake))).toBe(viaDescriptor);
      const sent = fake.requests.length;
      await expect(client.ops.run('get-data', { datastore: 'operational', maxDepth: '0' })).rejects.toThrow(TypeError);
      expect(fake.requests).toHaveLength(sent);
      await client.close();
    });
  });
});

describe('origins()', () => {
  it('inherits from the nearest annotated ancestor and resolves prefixes declared above', () => {
    const data = parseXml(
      `<data xmlns="${NMDA_NS}" xmlns:o="${ORIGIN_NS}" xmlns:v="${EX}">` +
        `<sys xmlns="${EX}" o:origin="o:intended"><name>r1</name>` +
        `<if o:origin="o:system"><name>lo0</name></if>` +
        `<if o:origin="v:vendor-origin"><name>x</name></if>` +
        `<counters><in>5</in></counters></sys>` +
        `<state xmlns="${EX}"><up>true</up></state></data>`,
    );
    const map = origins(data);
    const sys = data.child('sys', EX)!;
    const [lo0, vendor] = sys.childrenNamed('if', EX);
    expect(map.get(sys)).toBe('ietf-origin:intended');
    expect(map.get(sys.child('name', EX)!)).toBe('ietf-origin:intended');
    expect(map.get(lo0!.child('name', EX)!)).toBe('ietf-origin:system');
    // a module no source knows is named by its namespace; the session's lookup names it
    expect(map.get(vendor!)).toBe(`${EX}:vendor-origin`);
    expect(origins(data, { moduleOf: (ns) => (ns === EX ? 'ex-mod' : undefined) }).get(vendor!)).toBe('ex-mod:vendor-origin');
    expect(map.get(sys.path('counters/in', EX)!)).toBe('ietf-origin:intended');
    expect(map.has(data.child('state', EX)!)).toBe(false);
  });

  it('ignores an annotation whose prefix is not bound', () => {
    const data = parseXml(`<data xmlns:or="${ORIGIN_NS}"><a or:origin="zz:learned"/></data>`);
    expect(originOf(data, data.elements[0]!)).toBeUndefined();
  });
});

const LIBRARY = `
<yang-library xmlns="${YANG_LIBRARY_NS}" xmlns:ds="${DATASTORES_NS}">
  <module-set><name>config</name>
    <module><name>ietf-interfaces</name><revision>2018-02-20</revision><namespace>urn:if</namespace></module>
    <module><name>ex-routing</name><namespace>urn:rt</namespace><feature>a</feature><location>https://x/rt.yang</location>
      <submodule><name>ex-routing-sub</name><revision>2020-01-01</revision></submodule></module>
    <import-only-module><name>ietf-yang-types</name><revision>2013-07-15</revision><namespace>urn:yt</namespace></import-only-module>
  </module-set>
  <module-set><name>state</name>
    <module><name>ex-hardware</name><revision>2019-01-01</revision><namespace>urn:hw</namespace><deviation>ex-dev</deviation></module>
    <module><name>ex-routing</name><namespace>urn:rt</namespace><feature>b</feature></module>
    <module><name>ex-dev</name><namespace>urn:dev</namespace></module>
    <import-only-module><name>ietf-yang-types</name><revision>2013-07-15</revision><namespace>urn:yt</namespace></import-only-module>
  </module-set>
  <schema><name>config-schema</name><module-set>config</module-set></schema>
  <schema><name>state-schema</name><module-set>config</module-set><module-set>state</module-set></schema>
  <datastore><name>ds:running</name><schema>config-schema</schema></datastore>
  <datastore><name>ds:operational</name><schema>state-schema</schema></datastore>
  <datastore><name xmlns:v="${EX}">v:ephemeral</name><schema>state-schema</schema></datastore>
  <content-id>c42</content-id>
</yang-library>`;

describe('yang-library module (OPS-18)', () => {
  it('parses datastores, resolving each to the union of its schema\'s module sets', () => {
    const lib = parseYangLibrary(parseXml(LIBRARY));
    expect(lib.contentId).toBe('c42');
    expect(lib.datastores.map((d) => [d.name, d.schema])).toEqual([
      ['ietf-datastores:running', 'config-schema'],
      ['ietf-datastores:operational', 'state-schema'],
      [`${EX}:ephemeral`, 'state-schema'],
    ]);
    const running = findDatastore(lib, 'running')!;
    expect(running.modules.map((m) => m.name)).toEqual(['ietf-interfaces', 'ex-routing']);
    expect(running.modules[1]).toEqual({
      name: 'ex-routing', namespace: 'urn:rt', locations: ['https://x/rt.yang'], features: ['a'], deviations: [],
      submodules: [{ name: 'ex-routing-sub', revision: '2020-01-01', locations: [] }],
    });
    expect('revision' in running.modules[1]!).toBe(false);
    const operational = findDatastore(lib, 'operational')!;
    expect(operational.modules.map((m) => m.name)).toEqual(['ietf-interfaces', 'ex-routing', 'ex-hardware', 'ex-dev']);
    expect(operational.modules.find((m) => m.name === 'ex-routing')!.features).toEqual(['a', 'b']);
    expect(operational.modules.find((m) => m.name === 'ex-hardware')!.deviations).toEqual(['ex-dev']);
    expect(operational.importOnlyModules).toEqual([{ name: 'ietf-yang-types', revision: '2013-07-15', namespace: 'urn:yt', locations: [], submodules: [] }]);
    expect(findDatastore(lib, { name: 'ephemeral', namespace: EX })?.schema).toBe('state-schema');
    expect(findDatastore(lib, 'candidate')).toBeUndefined();
    expect(JSON.parse(JSON.stringify(lib))).toEqual(lib);
    expect(Object.isFrozen(lib.datastores[0]!.modules)).toBe(true);
  });

  it('reads only /yang-library, keeps the result, and refreshes on request', async () => {
    const { fake, client } = await open(() => ({ data: parseXml(LIBRARY) }));
    expect(client.content.yangLibrary.contentId).toBe('c42');
    const lib = await client.content.yangLibrary.load();
    expect(xml(lastOp(fake))).toBe(
      `<get xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><filter type="subtree"><yang-library xmlns="${YANG_LIBRARY_NS}"/></filter></get>`,
    );
    expect(lib.datastores).toHaveLength(3);
    expect(await client.content.yangLibrary.load()).toBe(lib);
    expect(fake.requests).toHaveLength(1);
    await client.content.yangLibrary.load({ refresh: true });
    expect(fake.requests).toHaveLength(2);
    await client.close();
  });

  it('a failed read is not kept', async () => {
    let fail = true;
    const { client } = await open(() => (fail ? { errors: [{ type: 'application', tag: 'operation-failed' }] } : { data: parseXml(LIBRARY) }));
    await expect(client.content.yangLibrary.load()).rejects.toThrow();
    fail = false;
    await expect(client.content.yangLibrary.load()).resolves.toMatchObject({ contentId: 'c42' });
    await client.close();
  });

  it('works without the nmda extension', async () => {
    const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1, YL11], handler: () => ({ data: parseXml(LIBRARY) }) });
    const client = await connect({ transport: fake.transport(), extensions: [yangLibrary] });
    expect((await client.content.yangLibrary.load()).datastores).toHaveLength(3);
    await client.close();
  });
});
