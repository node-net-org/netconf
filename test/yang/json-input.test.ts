/**
 * RFC 7951 JSON input, against the fake server: OPS-27
 * (JSON config on edit-config, copy-config, edit-data and a candidate
 * transaction; JSON filters on get, get-config, get-data, a transaction read
 * and compare) and CONTENT-10 (configure's txn.merge/txn.replace, and toXml).
 *
 * The fixture modules: ex-json, ex-aug (augments ex-json's list entries) and
 * ex-edit (an ordered-by-user list and leaf-list, a range, an identityref
 * from ex-json, and state data).
 */
import { fileURLToPath } from 'node:url';
import { YangDataError as NetYangDataError } from '@node-net/yang/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BASE_1_0,
  BASE_1_1,
  connect,
  NetconfError,
  NETCONF_NS,
  SchemaUnavailableError,
  serializeXml,
  subtree,
  x,
  YangDataError,
  type ConnectOptions,
  type NetconfClient,
  type SessionWarning,
  type XmlElement,
} from '../../src/index.js';
import { extensionContext } from '../../src/operations/index.js';
import { compare } from '../../src/operations/compare.js';
import { nmda } from '../../src/operations/nmda.js';
import { withCandidate } from '../../src/operations/transaction.js';
import { FakeServer, type RpcHandler } from '../../src/testing/index.js';

const MODULES = fileURLToPath(new URL('../fixtures/yang/json/', import.meta.url));
const EJ = 'urn:example:json';
const EA = 'urn:example:aug';
const EE = 'urn:example:edit';
const NC = NETCONF_NS;
const CAP = (n: string): string => `urn:ietf:params:netconf:capability:${n}`;

const HELLO = [
  BASE_1_0,
  BASE_1_1,
  CAP('candidate:1.0'),
  CAP('writable-running:1.0'),
  CAP('validate:1.1'),
  `${EJ}?module=ex-json&revision=2026-11-09`,
  `${EA}?module=ex-aug&revision=2026-11-09`,
  `${EE}?module=ex-edit&revision=2026-11-09`,
];

let clients: NetconfClient[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

const ok: RpcHandler = (_rpc, ctx) => (ctx.operation?.name === 'get' || ctx.operation?.name === 'get-config' ? { data: [] } : 'ok');

async function open(options: Partial<ConnectOptions> = {}, capabilities: readonly string[] = HELLO, handler: RpcHandler = ok) {
  const fake = new FakeServer({ capabilities: [...capabilities], handler });
  const client = await connect({ transport: fake.transport(), yang: { modules: MODULES }, ...options });
  clients.push(client);
  const warnings: SessionWarning[] = [];
  client.session.on('warning', (w) => warnings.push(w));
  return { fake, client, warnings };
}

/** The operation elements sent with this name. */
const sent = (fake: FakeServer, name: string): XmlElement[] => fake.requests.map((r) => r.elements[0]!).filter((e) => e.name === name);
/** The XML of an operation's child (config, filter, ...), without its own wrapper. */
const inner = (op: XmlElement, child: string, ns?: string): string => op.child(child, ns)!.elements.map((e) => serializeXml(e)).join('');

describe('OPS-27: JSON config on edit operations', () => {
  it('editConfig converts a JSON config with the target schema, keys first and identityref prefixes declared', async () => {
    const { fake, client } = await open();
    await client.ops.editConfig({
      target: 'running',
      config: { 'ex-json:top': { item: [{ size: 7, name: 'a', kind: 'ex-json:fast', 'ex-aug:extra': 'e' }] } },
    });
    expect(inner(sent(fake, 'edit-config')[0]!, 'config', NC)).toBe(
      `<top xmlns="${EJ}"><item><name>a</name><size>7</size><kind xmlns:ej="${EJ}">ej:fast</kind><extra xmlns="${EA}">e</extra></item></top>`,
    );
  });

  it('RFC 7952 metadata becomes nc:operation and yang:insert/key/value', async () => {
    const { fake, client } = await open();
    await client.ops.editConfig({
      target: 'candidate',
      config: {
        'ex-edit:sys': {
          mtu: null,
          '@mtu': { 'ietf-netconf:operation': 'delete' },
          user: [
            { name: 'bob', '@': { 'yang:insert': 'after', 'yang:key': "[name='alice']" } },
            { name: 'carl', '@': { 'ietf-netconf:operation': 'remove' } },
          ],
          dns: ['8.8.8.8'],
          '@dns': [{ 'yang:insert': 'first' }],
        },
      },
    });
    const config = inner(sent(fake, 'edit-config')[0]!, 'config', NC);
    expect(config).toContain(`<mtu xmlns:nc="${NC}" nc:operation="delete"/>`);
    expect(config).toContain(`<user xmlns:yang="urn:ietf:params:xml:ns:yang:1" yang:insert="after" yang:key="[name='alice']"><name>bob</name></user>`);
    expect(config).toContain(`<user xmlns:nc="${NC}" nc:operation="remove"><name>carl</name></user>`);
    expect(config).toContain(`<dns xmlns:yang="urn:ietf:params:xml:ns:yang:1" yang:insert="first">8.8.8.8</dns>`);
  });

  it('XML config is sent exactly as before', async () => {
    const { fake, client } = await open();
    await client.ops.editConfig({ target: 'running', config: x('sys', { xmlns: EE }, x('host', 'r1')) });
    expect(inner(sent(fake, 'edit-config')[0]!, 'config', NC)).toBe(`<sys xmlns="${EE}"><host>r1</host></sys>`);
  });

  it('JSON that does not match the schema is never sent: every problem is reported with its path', async () => {
    const { fake, client } = await open();
    const err = await client.ops
      .editConfig({ target: 'running', config: { 'ex-edit:sys': { mtu: 10, nope: 1, user: [{ uid: 1 }] } } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YangDataError);
    // One error root: @node-net/netconf's own class, with @node-net/yang's error as the cause.
    expect(err).toBeInstanceOf(NetconfError);
    expect((err as YangDataError).code).toBe('ERR_NETCONF_YANG_DATA');
    expect((err as YangDataError).cause).toBeInstanceOf(NetYangDataError);
    const issues = (err as YangDataError).issues.map((i) => [i.code, i.path]);
    expect(issues).toEqual(
      expect.arrayContaining([
        ['invalid-value', '/ex-edit:sys/mtu'],
        ['unknown-node', '/ex-edit:sys/nope'],
        ['missing-key', '/ex-edit:sys/user'],
      ]),
    );
    expect(sent(fake, 'edit-config')).toHaveLength(0);
  });

  it('config-false nodes are refused in an edit, because the target datastore schema holds configuration only', async () => {
    const { fake, client } = await open();
    await expect(client.ops.editConfig({ target: 'running', config: { 'ex-edit:sys': { state: { up: true } } } })).rejects.toThrow(YangDataError);
    expect(sent(fake, 'edit-config')).toHaveLength(0);
  });

  it('json.datastore picks another datastore\'s schema: state data is accepted against operational', async () => {
    const { fake, client } = await open();
    await client.ops.editConfig({ target: 'running', config: { 'ex-edit:sys': { state: { up: true } } }, json: { datastore: 'operational' } });
    expect(inner(sent(fake, 'edit-config')[0]!, 'config', NC)).toBe(`<sys xmlns="${EE}"><state><up>true</up></state></sys>`);
  });

  it('json.validate false sends a mismatched member schema-less, with a warning', async () => {
    const { fake, client, warnings } = await open();
    await client.ops.editConfig({ target: 'running', config: { 'ex-edit:sys': { mtu: 10 } }, json: { validate: false } });
    expect(inner(sent(fake, 'edit-config')[0]!, 'config', NC)).toBe(`<sys xmlns="${EE}"><mtu>10</mtu></sys>`);
    expect(warnings.map((w) => w.message).join('\n')).toMatch(/ex-edit:sys was sent without a YANG schema, because it doesn't match the schema/);
  });

  it('with no schema, a member is sent schema-less with a warning; requireSchema refuses instead', async () => {
    const extra = 'urn:example:unknown';
    const { fake, client, warnings } = await open({}, [...HELLO, `${extra}?module=ex-unknown&revision=2026-11-09`]);
    await client.ops.editConfig({ target: 'running', config: { 'ex-unknown:box': { v: [1, 2], '@': { 'ietf-netconf:operation': 'replace' } } } });
    expect(inner(sent(fake, 'edit-config')[0]!, 'config', NC)).toBe(`<box xmlns:nc="${NC}" xmlns="${extra}" nc:operation="replace"><v>1</v><v>2</v></box>`);
    expect(warnings.some((w) => /ex-unknown:box was sent without a YANG schema, because no schema could be compiled/.test(w.message))).toBe(true);
    await expect(client.ops.editConfig({ target: 'running', config: { 'ex-unknown:box': {} }, json: { requireSchema: true } })).rejects.toThrow(SchemaUnavailableError);
    expect(sent(fake, 'edit-config')).toHaveLength(1);
  });

  it('a module the server does not have at all is refused, naming it', async () => {
    const { fake, client } = await open();
    await expect(client.ops.editConfig({ target: 'running', config: { 'no-such:thing': {} } })).rejects.toThrow(/no-such/);
    expect(sent(fake, 'edit-config')).toHaveLength(0);
  });

  it('copyConfig converts inline JSON with the target schema', async () => {
    const { fake, client } = await open();
    await client.ops.copyConfig({ target: 'candidate', source: { config: { 'ex-edit:sys': { host: 'r1' } } } });
    expect(sent(fake, 'copy-config')[0]!.child('source', NC)!.elements[0]!.elements.map((e) => serializeXml(e)).join('')).toBe(`<sys xmlns="${EE}"><host>r1</host></sys>`);
  });

  it('json options are never sent, and run() converts JSON too', async () => {
    const { fake, client } = await open();
    await client.ops.run('edit-config', { target: 'running', config: { 'ex-edit:sys': { host: 'r2' } }, json: { requireSchema: true } });
    const op = sent(fake, 'edit-config')[0]!;
    expect(op.elements.map((e) => e.name)).toEqual(['target', 'config']);
    expect(inner(op, 'config', NC)).toBe(`<sys xmlns="${EE}"><host>r2</host></sys>`);
  });

  it('a candidate transaction converts JSON edits with the candidate schema', async () => {
    const { fake, client } = await open();
    await withCandidate(client, async (txn) => {
      await txn.editConfig({ config: { 'ex-edit:sys': { host: 'r3' } } });
      await txn.getConfig({ filter: { 'ex-edit:sys': { host: null } } });
    });
    expect(inner(sent(fake, 'edit-config')[0]!, 'config', NC)).toBe(`<sys xmlns="${EE}"><host>r3</host></sys>`);
    expect(inner(sent(fake, 'get-config')[0]!, 'filter', NC)).toBe(`<sys xmlns="${EE}"><host/></sys>`);
  });

  it('a request builder refuses unconverted JSON', async () => {
    const { editConfig } = await import('../../src/operations/base.js');
    expect(() => editConfig({ target: 'running', config: { 'ex-edit:sys': {} } })).toThrow(/converted by a NetconfClient/);
  });
});

describe('OPS-27: JSON subtree filters', () => {
  it('objects are containment nodes, {} and null select, values are content matches in canonical form', async () => {
    const { fake, client } = await open();
    await client.ops.getConfig({
      filter: { 'ex-json:top': { item: [{ name: 'a', size: '7', kind: 'ex-json:fast', note: null, 'ex-aug:extra': null }] } },
    });
    expect(inner(sent(fake, 'get-config')[0]!, 'filter', NC)).toBe(
      `<top xmlns="${EJ}"><item><name>a</name><size>7</size><kind xmlns:ej="${EJ}">ej:fast</kind><note/><extra xmlns="${EA}"/></item></top>`,
    );
  });

  it('a content-match value written non-canonically is sent in canonical form', async () => {
    const { fake, client } = await open();
    await client.ops.getConfig({ filter: { 'ex-json:top': { item: [{ size: '01500', ratio: '1.50' }, { size: '+7', ratio: 2 }] } } });
    expect(inner(sent(fake, 'get-config')[0]!, 'filter', NC)).toBe(
      `<top xmlns="${EJ}"><item><size>1500</size><ratio>1.5</ratio></item><item><size>7</size><ratio>2.0</ratio></item></top>`,
    );
  });

  it('a list may be one object, and a whole node is selected with {}', async () => {
    const { fake, client } = await open();
    await client.ops.get({ filter: { 'ex-json:top': { item: { name: 'b' } }, 'ex-edit:sys': {} } });
    expect(inner(sent(fake, 'get')[0]!, 'filter', NC)).toBe(`<top xmlns="${EJ}"><item><name>b</name></item></top><sys xmlns="${EE}"/>`);
  });

  it('a get filter may select state data (operational schema); a bad value is refused before sending', async () => {
    const { fake, client } = await open();
    await client.ops.get({ filter: { 'ex-edit:sys': { state: { up: null } } } });
    expect(inner(sent(fake, 'get')[0]!, 'filter', NC)).toBe(`<sys xmlns="${EE}"><state><up/></state></sys>`);
    await expect(client.ops.get({ filter: { 'ex-edit:sys': { mtu: 'big' } } })).rejects.toThrow(YangDataError);
    expect(sent(fake, 'get')).toHaveLength(1);
  });

  it('the output format stays independent: a JSON filter with format json', async () => {
    const { client } = await open();
    expect(await client.ops.getConfig({ filter: { 'ex-edit:sys': {} }, format: 'json' })).toEqual({});
  });

  it('subtree() and xpath() filters are unchanged', async () => {
    const { fake, client } = await open();
    await client.ops.get({ filter: subtree(x('sys', { xmlns: EE })) });
    expect(inner(sent(fake, 'get')[0]!, 'filter', NC)).toBe(`<sys xmlns="${EE}"/>`);
  });

  it('nmda get-data and edit-data convert JSON with their datastore', async () => {
    // capabilityCheck off: nmda runs without :yang-library:1.1, so the schema comes from the hello's modules.
    const fake = new FakeServer({ capabilities: HELLO, handler: ok });
    const client = await connect({ transport: fake.transport(), yang: { modules: MODULES }, extensions: [nmda], capabilityCheck: 'off' });
    clients.push(client);
    await client.ops.nmda.getData({ datastore: 'operational', filter: { 'ex-edit:sys': { state: {} } } });
    await client.ops.nmda.editData({ datastore: 'running', config: { 'ex-edit:sys': { host: 'r4' } } });
    const nmdaNs = 'urn:ietf:params:xml:ns:yang:ietf-netconf-nmda';
    expect(inner(sent(fake, 'get-data')[0]!, 'subtree-filter', nmdaNs)).toBe(`<sys xmlns="${EE}"><state/></sys>`);
    expect(inner(sent(fake, 'edit-data')[0]!, 'config', nmdaNs)).toBe(`<sys xmlns="${EE}"><host>r4</host></sys>`);
    await expect(client.ops.nmda.editData({ datastore: 'running', config: { 'ex-edit:sys': { state: { up: true } } } })).rejects.toThrow(YangDataError);
  });

  it('compare converts a JSON filter', async () => {
    const fake = new FakeServer({ capabilities: HELLO, handler: ok });
    const client = await connect({ transport: fake.transport(), yang: { modules: MODULES }, extensions: [compare], capabilityCheck: 'off' });
    clients.push(client);
    await client.ops.compare.datastores({ source: 'running', target: 'operational', filter: { 'ex-edit:sys': {} } }).catch(() => undefined);
    const op = sent(fake, 'compare')[0]!;
    expect(inner(op, 'subtree-filter', 'urn:ietf:params:xml:ns:yang:ietf-nmda-compare')).toBe(`<sys xmlns="${EE}"/>`);
  });
});

describe('CONTENT-10: configure with JSON, and toXml', () => {
  it('txn.merge and txn.replace send JSON subtrees with the path edits in one edit-config', async () => {
    const { fake, client } = await open();
    await client.content.configure((txn) => {
      txn.set('/ex-json:top/item[name="a"]/size', 9);
      txn.merge({ 'ex-edit:sys': { host: 'r5' } });
      txn.merge({ 'ex-edit:sys': { dns: ['1.1.1.1'] } });
    });
    const edits = sent(fake, 'edit-config');
    expect(edits).toHaveLength(1);
    expect(inner(edits[0]!, 'config', NC)).toBe(`<top xmlns="${EJ}"><item><name>a</name><size>9</size></item></top><sys xmlns="${EE}"><host>r5</host><dns>1.1.1.1</dns></sys>`);

    await client.content.configure((txn) => txn.replace({ 'ex-edit:sys': { host: 'r6' } }));
    expect(inner(sent(fake, 'edit-config')[1]!, 'config', NC)).toBe(`<sys xmlns:nc="${NC}" xmlns="${EE}" nc:operation="replace"><host>r6</host></sys>`);
  });

  it('a JSON conversion failure rejects before anything is locked or sent, and checkEdits rejects the same way', async () => {
    const { fake, client } = await open();
    const build = (txn: Parameters<Parameters<NetconfClient['content']['configure']>[0]>[0]): void => void txn.merge({ 'ex-edit:sys': { mtu: 1 } });
    await expect(client.content.configure(build)).rejects.toThrow(YangDataError);
    await expect(client.content.checkEdits(build)).rejects.toThrow(YangDataError);
    expect(fake.requests.map((r) => r.elements[0]!.name).filter((n) => n !== 'get-schema')).toEqual([]);
  });

  it('a top-level node edited both by path and as JSON is refused', async () => {
    const { client } = await open();
    await expect(
      client.content.configure((txn) => {
        txn.set('/ex-edit:sys/host', 'a');
        txn.merge({ 'ex-edit:sys': { mtu: 1500 } });
      }),
    ).rejects.toThrow(/both by path and as JSON/);
    await expect(client.content.configure((txn) => txn.merge({ 'ex-edit:sys': {} }).replace({ 'ex-edit:sys': {} }))).rejects.toThrow(/both merged and replaced/);
    await expect(client.content.configure((txn) => txn.merge('nope' as never))).rejects.toThrow(TypeError);
  });

  it('content.toXml converts edits and filters, defaulting to running, sending nothing but schema reads', async () => {
    const { fake, client } = await open();
    const els = await client.content.toXml({ 'ex-edit:sys': { host: 'r7', '@host': { 'ietf-netconf:operation': 'merge' } } });
    expect(els.map((e) => serializeXml(e)).join('')).toBe(`<sys xmlns="${EE}"><host xmlns:nc="${NC}" nc:operation="merge">r7</host></sys>`);
    await expect(client.content.toXml({ 'ex-edit:sys': { state: {} } })).rejects.toThrow(YangDataError);
    expect((await client.content.toXml({ 'ex-edit:sys': { state: {} } }, { filter: true, datastore: 'operational' })).map((e) => serializeXml(e)).join('')).toBe(`<sys xmlns="${EE}"><state/></sys>`);
    await expect(client.content.toXml([] as never)).rejects.toThrow(TypeError);
    expect(fake.requests.filter((r) => r.elements[0]!.name !== 'get-schema')).toHaveLength(0);
  });

  it('an extension context offers toXml; one no client built rejects', async () => {
    const { client } = await open();
    const bare = extensionContext(client.session, 'strict');
    await expect(bare.toXml({ 'ex-edit:sys': {} })).rejects.toThrow(/context built by a NetconfClient/);
  });
});
