/**
 * The RFC 9144 compare extension (OPS-24), against the fake server.
 *
 * Reply shapes follow RFC 9144 §4 and what Clixon 7.9 sends (see
 * test/integration/compare.test.ts): `<no-matches/>`, or `<differences>`
 * holding a YANG Patch whose elements are in the ietf-nmda-compare namespace.
 */
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  BASE_1_0,
  BASE_1_1,
  parseXml,
  CapabilityError,
  connect,
  ProtocolError,
  RpcError,
  serializeXml,
  subtree,
  TimeoutError,
  AbortError,
  x,
  xpath,
  type NetconfClient,
  type XmlElement,
} from '../../src/index.js';
import {
  NMDA_COMPARE_NS,
  compare,
  compareRequest,
  parseCompareReply,
  type CompareOps,
  type CompareResult,
} from '../../src/operations/compare.js';
import { FakeServer, type RpcHandler, type RpcHandlerResult } from '../../src/testing/index.js';

const CMP = NMDA_COMPARE_NS;
const DS = 'urn:ietf:params:xml:ns:yang:ietf-datastores';
const YL = 'urn:ietf:params:xml:ns:yang:ietf-yang-library';
const EX = 'urn:example:clixon';
const YL_CAP = 'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=1';
const XPATH_CAP = 'urn:ietf:params:netconf:capability:xpath:1.0';
const CAPS = [BASE_1_0, BASE_1_1, YL_CAP, XPATH_CAP];

/** A YANG library listing ietf-nmda-compare in a module set only, as Clixon does. */
const LIBRARY = x('yang-library', { xmlns: YL },
  x('module-set', x('name', 'top'),
    x('module', x('name', 'ietf-datastores'), x('revision', '2018-02-14'), x('namespace', DS)),
    x('module', x('name', 'ietf-nmda-compare'), x('revision', '2021-12-10'), x('namespace', CMP)),
  ),
  x('content-id', '1'),
);
const EMPTY_LIBRARY = x('yang-library', { xmlns: YL }, x('module-set', x('name', 'top')), x('content-id', '1'));

/** The differences Clixon 7.9 reported for running → candidate after deleting a, changing b and adding c. */
const DIFFERENCES = x('differences', { xmlns: CMP },
  x('yang-patch',
    x('patch-id', 'patch'),
    x('comment', 'diff between running (source) and candidate (target)'),
    x('edit', x('edit-id', '1'), x('operation', 'delete'), x('target', '/clixon-example:table/parameter=a'),
      x('value', x('parameter', { xmlns: EX }, x('name', 'a'), x('value', '1')))),
    x('edit', x('edit-id', '2'), x('operation', 'replace'), x('target', '/clixon-example:table/parameter=b/value'),
      x('value', x('value', { xmlns: EX }, '22')),
      x('source-value', x('value', { xmlns: EX }, '2'))),
    x('edit', x('edit-id', '3'), x('operation', 'create'), x('target', '/clixon-example:table/parameter=c'),
      x('value', x('parameter', { xmlns: EX }, x('name', 'c'), x('value', '3')))),
  ),
);


/** Answer get with `library` and compare with `reply`. */
function server(reply: () => RpcHandlerResult = () => ({ body: [x('no-matches', { xmlns: CMP })] }), library: XmlElement = LIBRARY): RpcHandler {
  return (_rpc, ctx) => {
    if (ctx.operation?.name === 'get') return { data: library };
    if (ctx.operation?.name === 'compare') return reply();
    return 'ok';
  };
}

let clients: NetconfClient[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  clients = [];
});

async function open(
  handler: RpcHandler = server(),
  options: { capabilities?: readonly string[]; capabilityCheck?: 'strict' | 'warn' | 'off'; warnings?: string[] } = {},
) {
  const fake = new FakeServer({ capabilities: options.capabilities ?? CAPS, handler });
  const warnings = options.warnings;
  const client = await connect({
    transport: fake.transport(),
    extensions: [compare],
    ...(options.capabilityCheck !== undefined ? { capabilityCheck: options.capabilityCheck } : {}),
    ...(warnings !== undefined ? { logger: { warn: (m: string) => warnings.push(m) } } : {}),
  });
  clients.push(client);
  return { fake, client, ext: client.ops.compare };
}

/** Built elements take their namespaces when serialized; read them back as a server or client would. */
const reparse = (el: XmlElement): XmlElement => parseXml(serializeXml(el));
const reply = (...children: XmlElement[]): XmlElement => reparse(x('rpc-reply', { xmlns: 'urn:ietf:params:xml:ns:netconf:base:1.0' }, ...children));

const ops = (fake: FakeServer): string[] => fake.requests.map((r) => r.elements[0]!.name);
const lastOp = (fake: FakeServer): XmlElement => fake.requests.at(-1)!.elements[0]!;

describe('compare extension (OPS-24)', () => {
  describe('AC1: enabling the extension', () => {
    it('adds client.ops.compare, typed from the extension', async () => {
      const { client } = await open();
      expectTypeOf(client.ops.compare).toEqualTypeOf<CompareOps>();
      expect(typeof client.ops.compare.datastores).toBe('function');
    });

    it('requires :yang-library:1.1 after the hello', async () => {
      const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
      await expect(connect({ transport: fake.transport(), extensions: [compare] })).rejects.toThrow(CapabilityError);
    });
  });

  describe('AC2: source and target', () => {
    it('sends one <compare> with both datastores as ds: identities', async () => {
      const { fake, ext } = await open();
      await ext.datastores({ source: 'running', target: 'candidate' });
      expect(ops(fake)).toEqual(['get', 'compare']);
      expect(serializeXml(lastOp(fake))).toBe(
        `<compare xmlns="${CMP}">` +
          `<source xmlns:ds="${DS}">ds:running</source>` +
          `<target xmlns:ds="${DS}">ds:candidate</target>` +
          '</compare>',
      );
    });

    it('accepts every standard datastore and any { name, namespace } identity', () => {
      for (const ds of ['running', 'candidate', 'startup', 'intended', 'operational'] as const) {
        expect(serializeXml(compareRequest({ source: ds, target: 'operational' }).element)).toContain(`>ds:${ds}</source>`);
      }
      const custom = serializeXml(compareRequest({ source: 'intended', target: { name: 'scratch', namespace: 'urn:example:ds' } }).element);
      expect(custom).toContain(`<target xmlns:id="urn:example:ds">id:scratch</target>`);
    });
  });

  describe('AC3: all and report-origin', () => {
    it('sends <all/> and <report-origin/> only when true', () => {
      const both = reparse(compareRequest({ source: 'intended', target: 'operational', all: true, reportOrigin: true }).element);
      expect(both.elements.map((e) => e.name)).toEqual(['source', 'target', 'all', 'report-origin']);
      expect(both.child('all', CMP)!.children).toEqual([]);
      expect(both.child('report-origin', CMP)!.children).toEqual([]);
      const neither = reparse(compareRequest({ source: 'intended', target: 'operational', all: false, reportOrigin: false }).element);
      expect(neither.elements.map((e) => e.name)).toEqual(['source', 'target']);
    });
  });

  describe('AC4: filters and argument checks', () => {
    it('sends a subtree filter as <subtree-filter>, needing no extra capability', async () => {
      const { fake, ext } = await open(server(), { capabilities: [BASE_1_0, BASE_1_1, YL_CAP] });
      await ext.datastores({ source: 'running', target: 'candidate', filter: subtree(x('table', { xmlns: EX })) });
      expect(serializeXml(lastOp(fake).child('subtree-filter', CMP)!)).toBe(`<subtree-filter xmlns="${CMP}"><table xmlns="${EX}"/></subtree-filter>`);
    });

    it('sends an XPath filter as <xpath-filter> with its namespace declarations', async () => {
      const { fake, ext } = await open();
      await ext.datastores({ source: 'running', target: 'candidate', filter: xpath("/ex:table/ex:parameter[ex:name='b']", { ex: EX }) });
      expect(serializeXml(lastOp(fake).child('xpath-filter', CMP)!)).toBe(
        `<xpath-filter xmlns:ex="${EX}" xmlns="${CMP}">/ex:table/ex:parameter[ex:name='b']</xpath-filter>`,
      );
    });

    it('takes a YANG path through client.content.toXPath()', async () => {
      const fake = new FakeServer({ capabilities: [...CAPS, `${EX}?module=clixon-example&revision=2022-11-01`], handler: server() });
      const client = await connect({ transport: fake.transport(), extensions: [compare] });
      clients.push(client);
      await client.ops.compare.datastores({ source: 'running', target: 'candidate', filter: client.content.toXPath('/clixon-example:table') });
      const filter = lastOp(fake).child('xpath-filter', CMP)!;
      expect(filter.text()).toBe('/clixon-example:table');
      expect(filter.declarations.get('clixon-example')).toBe(EX);
    });

    it('refuses an XPath filter without :xpath before sending', async () => {
      const { fake, ext } = await open(server(), { capabilities: [BASE_1_0, BASE_1_1, YL_CAP] });
      await expect(ext.datastores({ source: 'running', target: 'candidate', filter: xpath('/ex:table', { ex: EX }) })).rejects.toThrow(
        expect.objectContaining({ name: 'CapabilityError', capability: ':xpath' }),
      );
      // Settled by the hello, so not even the YANG library read is sent.
      expect(fake.requests).toHaveLength(0);
    });

    it('refuses without :yang-library:1.1 before sending when the module is enabled anyway', async () => {
      const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1, XPATH_CAP], handler: server() });
      const client = await connect({ transport: fake.transport(), extensions: [compare], extensionCheck: 'off' });
      clients.push(client);
      await expect(client.ops.compare.datastores({ source: 'running', target: 'candidate' })).rejects.toThrow(
        expect.objectContaining({ name: 'CapabilityError', capability: ':yang-library:1.1' }),
      );
      expect(fake.requests).toHaveLength(0);
    });

    it('refuses bad arguments with a TypeError before anything is sent', async () => {
      const { fake, ext } = await open();
      const bad: unknown[] = [
        {},
        { source: 'running' },
        { source: 'scratch', target: 'running' },
        { source: 'running', target: { name: '' } },
        { source: 'running', target: 'candidate', all: 'yes' },
        { source: 'running', target: 'candidate', reportOrigin: 1 },
        { source: 'running', target: 'candidate', filter: '/ex:table' },
        { source: 'running', target: 'candidate', filter: { type: 'subtree' } },
        { source: 'running', target: 'candidate', filter: xpath('  ') },
      ];
      for (const args of bad) {
        await expect(ext.datastores(args as never), JSON.stringify(args)).rejects.toThrow(TypeError);
      }
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe('AC5: support from the hello and the YANG library', () => {
    it('reads the YANG library once per client, then sends only compare', async () => {
      const { fake, ext } = await open();
      await ext.datastores({ source: 'running', target: 'candidate' });
      await ext.datastores({ source: 'candidate', target: 'running' });
      expect(ops(fake)).toEqual(['get', 'compare', 'compare']);
      expect(serializeXml(fake.requests[0]!.elements[0]!)).toContain(`<yang-library xmlns="${YL}"/>`);
    });

    it('finds the module in a datastore schema too', async () => {
      const library = x('yang-library', { xmlns: YL },
        x('module-set', x('name', 'cmp'), x('module', x('name', 'ietf-nmda-compare'), x('namespace', CMP))),
        x('schema', x('name', 's'), x('module-set', 'cmp')),
        x('datastore', { 'xmlns:ds': DS }, x('name', 'ds:running'), x('schema', 's')),
        x('content-id', '1'),
      );
      const { fake, ext } = await open(server(undefined, library));
      await expect(ext.datastores({ source: 'running', target: 'candidate' })).resolves.toMatchObject({ noMatches: true });
      expect(ops(fake)).toEqual(['get', 'compare']);
    });

    it('trusts the hello when it lists the module, without reading the library', async () => {
      const { fake, ext } = await open(server(), { capabilities: [...CAPS, `${CMP}?module=ietf-nmda-compare&revision=2021-12-10`] });
      await ext.datastores({ source: 'running', target: 'candidate' });
      expect(ops(fake)).toEqual(['compare']);
    });

    it('refuses with CapabilityError before sending when the library lacks the module (strict)', async () => {
      const { fake, ext } = await open(server(undefined, EMPTY_LIBRARY));
      const err = await ext.datastores({ source: 'running', target: 'candidate' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CapabilityError);
      expect((err as CapabilityError).capability).toBe('ietf-nmda-compare');
      expect((err as Error).message).toContain('compare');
      // The answer is kept: a second compare reads nothing and sends nothing.
      await expect(ext.datastores({ source: 'running', target: 'candidate' })).rejects.toThrow(CapabilityError);
      expect(ops(fake)).toEqual(['get']);
    });

    it("sends with a warning under 'warn', and without reading the library under 'off'", async () => {
      const warnings: string[] = [];
      const warn = await open(server(undefined, EMPTY_LIBRARY), { capabilityCheck: 'warn', warnings });
      await warn.ext.datastores({ source: 'running', target: 'candidate' });
      expect(ops(warn.fake)).toEqual(['get', 'compare']);
      expect(warnings.join('\n')).toContain('ietf-nmda-compare');

      const offWarnings: string[] = [];
      const off = await open(server(undefined, EMPTY_LIBRARY), { capabilityCheck: 'off', warnings: offWarnings });
      await off.ext.datastores({ source: 'running', target: 'candidate' });
      expect(ops(off.fake)).toEqual(['compare']);
      expect(offWarnings).toEqual([]);
    });

    it("sends with a warning under 'warn' when the YANG library can't be read", async () => {
      const handler: RpcHandler = (rpc, ctx) =>
        ctx.operation?.name === 'get' ? { errors: [{ type: 'application', tag: 'access-denied', message: 'no' }] } : server()(rpc, ctx);
      const warnings: string[] = [];
      const { fake, ext } = await open(handler, { capabilityCheck: 'warn', warnings });
      await expect(ext.datastores({ source: 'running', target: 'candidate' })).resolves.toMatchObject({ noMatches: true });
      expect(ops(fake)).toEqual(['get', 'compare']);
      expect(warnings.join('\n')).toMatch(/couldn't read the YANG library/);
    });

    it('stops waiting on the library read when its own signal aborts, sending no compare', async () => {
      let answer: (() => void) | undefined;
      const handler: RpcHandler = (rpc, ctx) =>
        ctx.operation?.name === 'get'
          ? new Promise((resolve) => {
              answer = () => resolve({ data: LIBRARY });
            })
          : server()(rpc, ctx);
      const { fake, ext } = await open(handler);
      const ac = new AbortController();
      const first = ext.datastores({ source: 'running', target: 'candidate', signal: ac.signal });
      const second = ext.datastores({ source: 'running', target: 'candidate' });
      await new Promise((r) => setTimeout(r, 20));
      ac.abort();
      await expect(first).rejects.toThrow(AbortError);
      // The shared read goes on for the other caller.
      answer!();
      await expect(second).resolves.toMatchObject({ noMatches: true });
      expect(ops(fake)).toEqual(['get', 'compare']);

      const aborted = await open();
      await expect(aborted.ext.datastores({ source: 'running', target: 'candidate', signal: AbortSignal.abort() })).rejects.toThrow(AbortError);
      expect(ops(aborted.fake)).not.toContain('compare');
    });

    it('reads the library again after a failed read', async () => {
      let fail = true;
      const handler: RpcHandler = (rpc, ctx) => {
        if (ctx.operation?.name === 'get' && fail) {
          fail = false;
          return { errors: [{ type: 'application', tag: 'operation-failed', message: 'busy' }] };
        }
        return server()(rpc, ctx);
      };
      const { fake, ext } = await open(handler);
      await expect(ext.datastores({ source: 'running', target: 'candidate' })).rejects.toThrow(RpcError);
      await expect(ext.datastores({ source: 'running', target: 'candidate' })).resolves.toMatchObject({ noMatches: true });
      expect(ops(fake)).toEqual(['get', 'get', 'compare']);
    });
  });

  describe('AC6 and AC7: reading the reply', () => {
    it('resolves <no-matches/> as no matches and no edits', async () => {
      const { ext } = await open();
      const result = await ext.datastores({ source: 'running', target: 'candidate' });
      expect(result).toEqual({ noMatches: true, edits: [] });
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('decodes <differences>: patch-id, comment and each edit in order with value and source-value', async () => {
      const { ext } = await open(server(() => ({ body: [DIFFERENCES] })));
      const result: CompareResult = await ext.datastores({ source: 'running', target: 'candidate' });
      expect(result.noMatches).toBe(false);
      expect(result.patchId).toBe('patch');
      expect(result.comment).toBe('diff between running (source) and candidate (target)');
      expect(result.edits.map((e) => [e.editId, e.operation, e.target])).toEqual([
        ['1', 'delete', '/clixon-example:table/parameter=a'],
        ['2', 'replace', '/clixon-example:table/parameter=b/value'],
        ['3', 'create', '/clixon-example:table/parameter=c'],
      ]);
      const [del, rep, cre] = result.edits;
      expect(serializeXml(del!.value[0]!)).toBe(`<parameter xmlns="${EX}"><name>a</name><value>1</value></parameter>`);
      expect(del!.sourceValue).toEqual([]);
      expect(rep!.value.map((e) => e.text())).toEqual(['22']);
      expect(rep!.sourceValue.map((e) => e.text())).toEqual(['2']);
      expect(cre!.sourceValue).toEqual([]);
      expect(del).not.toHaveProperty('point');
      expect(Object.isFrozen(result.edits)).toBe(true);
      expect(Object.isFrozen(rep)).toBe(true);
      expect(Object.isFrozen(rep!.sourceValue)).toBe(true);
    });

    it('keeps point and where, and gives empty lists when value and source-value are absent', () => {
      const result = parseCompareReply(
        reply(x('differences', { xmlns: CMP },
          x('yang-patch', x('patch-id', 'p'),
            x('edit', x('edit-id', 'm'), x('operation', 'move'), x('target', '/ex:list=b'), x('point', '/ex:list=a'), x('where', 'after')),
            x('edit', x('edit-id', 'r'), x('operation', 'remove'), x('target', '/ex:leaf'))))),
      );
      expect(result.comment).toBeUndefined();
      expect(result.edits[0]).toEqual({ editId: 'm', operation: 'move', target: '/ex:list=b', point: '/ex:list=a', where: 'after', value: [], sourceValue: [] });
      expect(result.edits[1]).toEqual({ editId: 'r', operation: 'remove', target: '/ex:leaf', value: [], sourceValue: [] });
    });

    it('resolves an empty <differences> patch with no edits (not no-matches)', () => {
      const result = parseCompareReply(reply(x('differences', { xmlns: CMP }, x('yang-patch', x('patch-id', 'p')))));
      expect(result).toEqual({ noMatches: false, patchId: 'p', edits: [] });
    });
  });

  describe('AC8: malformed replies', () => {
    it('rejects a reply with neither <no-matches/> nor <differences> with a ProtocolError', async () => {
      const { ext } = await open(server(() => ({ body: [x('ok')] })));
      await expect(ext.datastores({ source: 'running', target: 'candidate' })).rejects.toThrow(ProtocolError);
    });

    it('rejects <differences> without <yang-patch>, and elements in the wrong namespace', () => {
      expect(() => parseCompareReply(reply(x('differences', { xmlns: CMP })))).toThrow(/no <yang-patch>/);
      expect(() => parseCompareReply(reply(x('no-matches', { xmlns: 'urn:example:other' })))).toThrow(ProtocolError);
    });
  });

  describe('AC9: refusals, timeout and abort', () => {
    it("rejects with the server's RpcError", async () => {
      const { ext } = await open(server(() => ({ errors: [{ type: 'application', tag: 'operation-not-supported', message: 'all not supported' }] })));
      const err = await ext.datastores({ source: 'running', target: 'candidate', all: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).first.tag).toBe('operation-not-supported');
    });

    it('applies per-call timeout and signal to the compare', async () => {
      // The hello lists the module, so nothing but the (unanswered) compare is sent.
      const { ext } = await open(server(() => undefined), { capabilities: [...CAPS, `${CMP}?module=ietf-nmda-compare`] });
      await expect(ext.datastores({ source: 'running', target: 'candidate', timeout: 50 })).rejects.toThrow(TimeoutError);
      const ac = new AbortController();
      const pending = ext.datastores({ source: 'running', target: 'candidate', signal: ac.signal });
      setTimeout(() => ac.abort(), 10);
      await expect(pending).rejects.toThrow(AbortError);
    });
  });

  describe('AC10: descriptor, ops.run and request builder', () => {
    it('lists compare in client.ops.list as plain data that does not change state', async () => {
      const { client } = await open();
      const found = client.ops.list.filter((d) => d.extension === 'compare');
      expect(found.map((d) => [d.name, d.method, d.namespace, d.mutates, d.requires])).toEqual([
        ['compare', 'datastores', CMP, false, [':yang-library:1.1']],
      ]);
      expect(found[0]!.params.map((p) => [p.name, p.kind, p.type, p.required === true])).toEqual([
        ['source', 'positional', 'datastore', true],
        ['target', 'positional', 'datastore', true],
        ['all', 'option', 'boolean', false],
        ['reportOrigin', 'option', 'boolean', false],
        ['filter', 'option', 'filter', false],
      ]);
      expect(found[0]!.params[0]!.values).toEqual(['running', 'candidate', 'startup', 'intended', 'operational']);
      expect(JSON.parse(JSON.stringify(found))).toEqual(found);
    });

    it('ops.run() sends the same XML as the method, and the builder sends nothing', async () => {
      const { fake, client } = await open();
      const args = { source: 'intended', target: 'operational', all: true, reportOrigin: true, filter: xpath('/ex:table', { ex: EX }) } as const;
      await client.ops.run('compare', args);
      const viaDescriptor = serializeXml(lastOp(fake));
      await client.ops.compare.datastores(args);
      expect(serializeXml(lastOp(fake))).toBe(viaDescriptor);
      const before = fake.requests.length;
      expect(serializeXml(compareRequest(args).element)).toBe(viaDescriptor);
      expect(compareRequest(args).requires).toEqual([':xpath']);
      expect(fake.requests).toHaveLength(before);
    });
  });
});
