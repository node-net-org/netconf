/**
 * RFC 6243 with-defaults as an extension (OPS-15), against the fake server.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { BASE_1_0, BASE_1_1, CapabilityError, connect, parseXml, serializeXml, x, type Logger } from '../../src/index.js';
import {
  isDefault,
  WITH_DEFAULTS_NS,
  withDefaults,
  type WithDefaultsMode,
} from '../../src/operations/with-defaults.js';
import { FakeServer } from '../../src/testing/index.js';

const WD = 'urn:ietf:params:netconf:capability:with-defaults:1.0';
const CAPS = [
  BASE_1_0,
  BASE_1_1,
  'urn:ietf:params:netconf:capability:url:1.0',
  'urn:ietf:params:netconf:capability:candidate:1.0',
  'urn:ietf:params:xml:ns:yang:ietf-interfaces?module=ietf-interfaces',
];
const EXPLICIT = `${WD}?basic-mode=explicit&also-supported=report-all,report-all-tagged`;

async function open(wd: string | undefined, extra: { capabilityCheck?: 'strict' | 'warn' | 'off'; logger?: Logger } = {}) {
  const fake = new FakeServer({ capabilities: wd === undefined ? CAPS : [...CAPS, wd] });
  const client = await connect({ transport: fake.transport(), extensions: [withDefaults], ...extra });
  return { fake, client };
}

const lastOp = (fake: FakeServer) => fake.requests.at(-1)!.elements[0]!;
const wdOf = (fake: FakeServer) => lastOp(fake).child('with-defaults', WITH_DEFAULTS_NS)?.text();

describe('with-defaults extension (OPS-15)', () => {
  it('requires :with-defaults:1.0', async () => {
    const fake = new FakeServer({ capabilities: CAPS });
    await expect(connect({ transport: fake.transport(), extensions: [withDefaults] })).rejects.toThrow(CapabilityError);
  });

  it('reports the basic mode and the supported modes', async () => {
    const { client } = await open(EXPLICIT);
    expectTypeOf(client.content.withDefaults.basicMode).toEqualTypeOf<WithDefaultsMode | undefined>();
    expect(client.content.withDefaults.basicMode).toBe('explicit');
    expect(client.content.withDefaults.supportedModes).toEqual(['explicit', 'report-all', 'report-all-tagged']);
    await client.close();

    const trim = await open(`${WD}?basic-mode=trim`);
    expect(trim.client.content.withDefaults.basicMode).toBe('trim');
    expect(trim.client.content.withDefaults.supportedModes).toEqual(['trim']);
    await trim.client.close();
  });

  it('adds <with-defaults> in its own namespace as the last child of get, get-config and copy-config', async () => {
    const { fake, client } = await open(EXPLICIT);
    await client.ops.get({ withDefaults: 'report-all' });
    expect(serializeXml(lastOp(fake))).toBe(
      `<get xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><with-defaults xmlns="${WITH_DEFAULTS_NS}">report-all</with-defaults></get>`,
    );
    await client.ops.getConfig({ source: 'candidate', withDefaults: 'report-all-tagged' });
    expect(lastOp(fake).elements.map((e) => e.name)).toEqual(['source', 'with-defaults']);
    expect(wdOf(fake)).toBe('report-all-tagged');
    await client.ops.copyConfig({ source: 'running', target: { url: 'file:///backup.xml' }, withDefaults: 'explicit' });
    expect(lastOp(fake).elements.map((e) => e.name)).toEqual(['target', 'source', 'with-defaults']);
    expect(wdOf(fake)).toBe('explicit');
    await client.close();
  });

  it('sends nothing extra without the option', async () => {
    const { fake, client } = await open(EXPLICIT);
    await client.ops.getConfig();
    expect(wdOf(fake)).toBeUndefined();
    await client.close();
  });

  it('read() passes withDefaults through', async () => {
    const { fake, client } = await open(EXPLICIT);
    await client.content.read('/ietf-interfaces:interfaces', { withDefaults: 'report-all', format: 'xml' });
    expect(lastOp(fake).name).toBe('get-config');
    expect(wdOf(fake)).toBe('report-all');
    await client.content.read('/ietf-interfaces:interfaces', { source: 'config+state', withDefaults: 'explicit', format: 'xml' });
    expect(lastOp(fake).name).toBe('get');
    expect(wdOf(fake)).toBe('explicit');
    await client.close();
  });

  it('strict: an unsupported mode is refused with CapabilityError before sending', async () => {
    const { fake, client } = await open(`${WD}?basic-mode=trim`);
    const err = await client.ops.getConfig({ withDefaults: 'report-all-tagged' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as Error).message).toMatch(/get-config.*with-defaults mode report-all-tagged/);
    expect(fake.requests).toHaveLength(0);
    await expect(client.ops.getConfig({ withDefaults: 'trim' })).resolves.toBeDefined();
    await client.close();
  });

  it('warn: an unsupported mode is sent with a warning; off: sent unchecked', async () => {
    const warnings: string[] = [];
    const logger: Logger = { warn: (m) => warnings.push(m) };
    const warn = await open(`${WD}?basic-mode=trim`, { capabilityCheck: 'warn', logger });
    await warn.client.ops.get({ withDefaults: 'report-all' });
    expect(wdOf(warn.fake)).toBe('report-all');
    expect(warnings.join('\n')).toMatch(/report-all/);
    await warn.client.close();

    const off = await open(undefined, { capabilityCheck: 'off' });
    await off.client.ops.get({ withDefaults: 'report-all' });
    expect(wdOf(off.fake)).toBe('report-all');
    await off.client.close();
  });

  it('rejects a value that is not a mode', async () => {
    const { fake, client } = await open(EXPLICIT);
    await expect(client.ops.get({ withDefaults: 'everything' as WithDefaultsMode })).rejects.toThrow(TypeError);
    expect(fake.requests).toHaveLength(0);
    await client.close();
  });

  it('without the extension, withDefaults is refused', async () => {
    const fake = new FakeServer({ capabilities: [...CAPS, EXPLICIT] });
    const client = await connect({ transport: fake.transport() });
    await expect(client.ops.getConfig({ withDefaults: 'report-all' })).rejects.toThrow(/withDefaults/);
    expect(fake.requests).toHaveLength(0);
    await client.close();
  });

  it('adds withDefaults to the get, get-config and copy-config descriptors', async () => {
    const { client } = await open(EXPLICIT);
    for (const name of ['get', 'get-config', 'copy-config']) {
      const p = client.ops.list.find((d) => d.name === name)!.params.find((q) => q.name === 'withDefaults');
      expect(p, name).toMatchObject({ extension: 'withDefaults', values: ['report-all', 'trim', 'explicit', 'report-all-tagged'] });
    }
    expect(client.ops.list.find((d) => d.name === 'edit-config')!.params.some((p) => p.name === 'withDefaults')).toBe(false);
    await client.close();
  });

  it('isDefault() reads wd:default as true or 1', () => {
    const data = parseXml(
      `<data xmlns:wd="urn:ietf:params:xml:ns:netconf:default:1.0"><a wd:default="true">1</a><b wd:default="1">2</b><c wd:default="false">3</c><d>4</d></data>`,
    );
    expect(data.elements.map(isDefault)).toEqual([true, true, false, false]);
    expect(isDefault(x('e'))).toBe(false);
    // libyang (netopeer2) uses the YANG module's namespace instead of RFC 6243 §6's.
    const libyang = parseXml(
      `<data xmlns:ncwd="${WITH_DEFAULTS_NS}"><a ncwd:default="true">1</a><b ncwd:default="false">2</b></data>`,
    );
    expect(libyang.elements.map(isDefault)).toEqual([true, false]);
  });
});
