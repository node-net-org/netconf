/**
 * RFC 9144 compare (OPS-24) against real servers.
 *
 * Clixon implements ietf-nmda-compare; netopeer2 doesn't.
 *
 *   CLIXON_PORT=18400 scripts/clixon.sh start
 *   CLIXON_PORT=18400 npm run test:integration
 *
 * The Clixon tests are skipped unless CLIXON_PORT is set, and the netopeer2
 * test unless NETOPEER2_PORT is. Assertions follow what Clixon 7.9 actually
 * does, which departs from RFC 9144 in places:
 * - identical datastores give `<no-matches/>`, not an empty `<differences>`;
 * - a delete carries the removed node in `<value>`, not `<source-value>`;
 * - targets are RESTCONF style, relative to the node an XPath filter selects;
 * - `all`, `report-origin` and subtree filters are refused (operation-not-supported),
 *   and so is any datastore but running, candidate and startup (operation-failed);
 * - a filter selecting several list entries pairs them by position (not tested).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CapabilityError, connect, RpcError, ssh, subtree, x, xpath, type Attrs, type ConnectOptions, type RpcReply } from '../../src/index.js';
import { compare, parseCompareReply, type CompareResult } from '../../src/operations/compare.js';
import { yangLibrary } from '../../src/operations/yang-library.js';

const CLIXON_PORT = Number(process.env['CLIXON_PORT'] ?? 0);
const NETOPEER2_PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);
const EX = 'urn:example:clixon';
const NC = 'urn:ietf:params:xml:ns:netconf:base:1.0';

/** The first connection learns the host key; later ones pin it. */
async function options(port: number): Promise<ConnectOptions<[typeof compare, typeof yangLibrary]>> {
  let fingerprint = '';
  const first = await connect({
    transport: ssh({
      host: '127.0.0.1', port, username: 'netconf', password: 'netconf',
      hostKey: (info) => {
        fingerprint = info.fingerprint;
        return true;
      },
    }),
  });
  await first.close();
  return {
    transport: ssh({ host: '127.0.0.1', port, username: 'netconf', password: 'netconf', hostKey: fingerprint }),
    timeouts: { rpc: 10_000 },
    extensions: [compare, yangLibrary],
    namespaces: { 'clixon-example': EX },
  };
}

const open = (o: ConnectOptions<[typeof compare, typeof yangLibrary]>) => connect(o);
type Client = Awaited<ReturnType<typeof open>>;

const param = (name: string, value?: string, attrs: Attrs = {}) =>
  x('parameter', attrs, x('name', name), value !== undefined && x('value', value));
const table = (...params: ReturnType<typeof param>[]) => x('table', { xmlns: EX }, ...params);
const summary = (r: CompareResult) => r.edits.map((e) => [e.operation, e.target]);
const texts = (els: readonly { text(): string }[]) => els.map((e) => e.text());

describe.skipIf(CLIXON_PORT === 0)('compare against Clixon', () => {
  let opts: ConnectOptions<[typeof compare, typeof yangLibrary]>;
  let client: Client;

  beforeAll(async () => {
    opts = await options(CLIXON_PORT);
    client = await open(opts);
  });
  afterAll(async () => {
    // Leave the candidate as found: Clixon refuses a candidate lock while it holds uncommitted edits.
    await client?.ops.discardChanges().catch(() => undefined);
    await client?.close();
  });

  /** running holds a=1, b=2; the candidate deletes a, changes b to 22 and adds c=3. */
  async function setUp(changeCandidate = true): Promise<void> {
    await client.ops.discardChanges();
    await client.ops.editConfig({ target: 'candidate', config: table(param('a', '1'), param('b', '2')), defaultOperation: 'replace' });
    await client.ops.commit();
    if (!changeCandidate) return;
    await client.ops.editConfig({
      target: 'candidate',
      config: table(param('a', undefined, { operation: { ns: NC, prefix: 'nc', value: 'delete' } }), param('b', '22'), param('c', '3')),
    });
  }
  beforeEach(async () => setUp());

  it('finds ietf-nmda-compare in the YANG library, which lists it in a module set only', async () => {
    const lib = await client.content.yangLibrary.load();
    expect(lib.moduleSets.flatMap((s) => s.modules.map((m) => m.name))).toContain('ietf-nmda-compare');
    expect(lib.datastores).toEqual([]);
  });

  it('reports no-matches when the datastores are the same', async () => {
    await setUp(false);
    const ext = client.ops.compare;
    await expect(ext.datastores({ source: 'running', target: 'candidate' })).resolves.toEqual({ noMatches: true, edits: [] });
  });

  it('turns running into candidate: delete a, replace b, create c, with values and source values', async () => {
    const r = await client.ops.compare.datastores({ source: 'running', target: 'candidate' });
    expect(r.noMatches).toBe(false);
    expect(r.patchId).toBe('patch');
    expect(r.comment).toBe('diff between running (source) and candidate (target)');
    expect(summary(r)).toEqual([
      ['delete', '/clixon-example:table/parameter=a'],
      ['replace', '/clixon-example:table/parameter=b/value'],
      ['create', '/clixon-example:table/parameter=c'],
    ]);
    const [del, rep, cre] = r.edits;
    // Clixon sends the removed node of a delete in <value>, not <source-value>.
    expect(del!.value.map((e) => [e.name, e.ns, e.child('name', EX)?.text()])).toEqual([['parameter', EX, 'a']]);
    expect(del!.sourceValue).toEqual([]);
    expect(texts(rep!.value)).toEqual(['22']);
    expect(texts(rep!.sourceValue)).toEqual(['2']);
    expect(cre!.value[0]!.child('value', EX)?.text()).toBe('3');
    expect(r.edits.map((e) => e.editId)).toEqual(['1', '2', '3']);
  });

  it('reverses the edits when source and target swap', async () => {
    const r = await client.ops.compare.datastores({ source: 'candidate', target: 'running' });
    expect(summary(r)).toEqual([
      ['create', '/clixon-example:table/parameter=a'],
      ['replace', '/clixon-example:table/parameter=b/value'],
      ['delete', '/clixon-example:table/parameter=c'],
    ]);
    expect(texts(r.edits[1]!.sourceValue)).toEqual(['22']);
  });

  it('limits the comparison with an XPath filter; targets are relative to the selected node', async () => {
    const ext = client.ops.compare;
    const whole = await ext.datastores({ source: 'running', target: 'candidate', filter: client.content.toXPath('/clixon-example:table') });
    expect(summary(whole)).toEqual([
      ['delete', '/clixon-example:parameter=a'],
      ['replace', '/clixon-example:parameter=b/value'],
      ['create', '/clixon-example:parameter=c'],
    ]);
    const b = await ext.datastores({ source: 'running', target: 'candidate', filter: xpath("/ex:table/ex:parameter[ex:name='b']", { ex: EX }) });
    expect(summary(b)).toEqual([['replace', '/clixon-example:value']]);
    const nothing = await ext.datastores({ source: 'running', target: 'candidate', filter: xpath('/ex:nothing', { ex: EX }) });
    expect(nothing).toEqual({ noMatches: true, edits: [] });
  });

  it('ops.run() resolves with the raw reply, which decodes to the same result', async () => {
    const reply = (await client.ops.run('compare', { source: 'running', target: 'candidate' })) as RpcReply;
    expect(parseCompareReply(reply.element)).toEqual(await client.ops.compare.datastores({ source: 'running', target: 'candidate' }));
  });

  it("passes the server's refusals through as RpcErrors", async () => {
    const ext = client.ops.compare;
    const tag = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof RpcError ? e.first.tag : String(e)));
    expect(await tag(ext.datastores({ source: 'running', target: 'candidate', all: true }))).toBe('operation-not-supported');
    expect(await tag(ext.datastores({ source: 'running', target: 'candidate', reportOrigin: true }))).toBe('operation-not-supported');
    expect(await tag(ext.datastores({ source: 'running', target: 'candidate', filter: subtree(table()) }))).toBe('operation-not-supported');
    expect(await tag(ext.datastores({ source: 'intended', target: 'operational' }))).toBe('operation-failed');
    // The session is still usable.
    await expect(ext.datastores({ source: 'running', target: 'candidate' })).resolves.toMatchObject({ noMatches: false });
  });
});

describe.skipIf(NETOPEER2_PORT === 0)('compare against netopeer2', () => {
  it('is refused with CapabilityError before sending: its YANG library has no ietf-nmda-compare', async () => {
    const client = await open(await options(NETOPEER2_PORT));
    try {
      const err = await client.ops.compare.datastores({ source: 'running', target: 'operational' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CapabilityError);
      expect((err as CapabilityError).capability).toBe('ietf-nmda-compare');
      // The answer is kept, and the session is fine.
      await expect(client.ops.compare.datastores({ source: 'running', target: 'candidate' })).rejects.toThrow(CapabilityError);
      await expect(client.ops.getConfig({ filter: subtree(x('nacm', { xmlns: 'urn:ietf:params:xml:ns:yang:ietf-netconf-acm' })) })).resolves.toBeDefined();
    } finally {
      await client.close();
    }
  });
});
