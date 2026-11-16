import { describe, expect, it } from 'vitest';
import { compileProfile } from '../../src/devices/profile-spec.js';
import {
  autoDetect,
  BASE_1_0,
  BASE_1_1,
  builtinDeviceProfiles,
  CapabilityError,
  connect,
  NETCONF_NS,
  PathError,
  RpcError,
  TransactionError,
  serializeXml,
  x,
  type ConnectOptions,
  type DeviceProfile,
  type XmlElement,
} from '../../src/index.js';
import { FakeServer, type FakeServerOptions, type RpcHandlerResult } from '../../src/testing/index.js';

const CAP = (n: string): string => `urn:ietf:params:netconf:capability:${n}`;
const IF_NS = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
const IF_MODULE = `${IF_NS}?module=ietf-interfaces&revision=2018-02-20`;
const CAPS = [BASE_1_0, BASE_1_1, CAP('candidate:1.0'), CAP('validate:1.1'), CAP('writable-running:1.0'), IF_MODULE];

const profile = (raw: object): DeviceProfile => compileProfile(raw).profile;

async function open(server: FakeServerOptions, options: Partial<ConnectOptions> = {}) {
  const fake = new FakeServer({ capabilities: CAPS, ...server });
  const s = await connect({ transport: fake.transport(), ...options });
  return { fake, s };
}

const opNames = (fake: FakeServer): string[] => fake.requests.map((r) => r.elements[0]!.name);
const sent = (fake: FakeServer, i: number): string => serializeXml(fake.requests[i]!.elements[0]!);

describe('quirks from an explicit profile', () => {
  it('maxInFlight: 1 serialises requests', async () => {
    const held: ((r: RpcHandlerResult) => void)[] = [];
    const { fake, s } = await open(
      { handler: () => new Promise((resolve) => held.push(resolve)) },
      { profile: profile({ id: 'serial', quirks: { maxInFlight: 1 } }) },
    );
    const a = s.session.rpc(x('get'));
    const b = s.session.rpc(x('get'));
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.requests).toHaveLength(1);
    held[0]!('ok');
    await a;
    await new Promise((r) => setTimeout(r, 10));
    held[1]!('ok');
    await b;
    await s.close();
  });

  it('forceBaseVersion: 1.0 advertises only base 1.0 and uses EOM framing', async () => {
    const { fake, s } = await open({}, { profile: profile({ id: 'old', quirks: { forceBaseVersion: '1.0' } }) });
    const caps = (await fake.clientHello).child('capabilities')!.childrenNamed('capability').map((c) => c.text());
    expect(caps).toEqual([BASE_1_0]);
    expect(s.session.baseVersion).toBe('1.0');
    await s.session.rpc(x('get'));
    await s.close();
  });

  it("replyWithoutMessageId: 'oldest' matches id-less replies", async () => {
    const { fake, s } = await open(
      { handler: () => undefined },
      { profile: profile({ id: 'sloppy', quirks: { replyWithoutMessageId: 'oldest' } }) },
    );
    const pending = s.session.rpc(x('get'));
    await new Promise((r) => setTimeout(r, 5));
    fake.send(x('rpc-reply', { xmlns: NETCONF_NS }, x('ok')));
    expect((await pending).ok).toBe(true);
    await s.close();
  });
});

describe('capability corrections', () => {
  it('adds and removes capabilities, and checks use the corrected set', async () => {
    const { s } = await open(
      {},
      { profile: profile({ id: 'fix', capabilities: { add: [CAP('startup:1.0')], remove: [':candidate'] } }) },
    );
    expect(s.session.advertisedCapabilities.has(':candidate')).toBe(true);
    expect(s.session.serverCapabilities.has(':candidate')).toBe(false);
    expect(s.session.serverCapabilities.has(':startup')).toBe(true);
    await expect(s.ops.commit()).rejects.toBeInstanceOf(CapabilityError);
    await s.close();
  });
});

describe('autoDetect', () => {
  const generic = profile({ id: 'generic' });
  const ifaces = profile({ id: 'ifaces', match: { anyModule: ['ietf-interfaces'] }, quirks: { maxInFlight: 2 } });
  const nokia = profile({ id: 'nokia', match: { anyModule: ['nokia-conf'] } });

  it('picks the matching profile after the hello', async () => {
    const { s } = await open({}, { profile: autoDetect([nokia, ifaces]) });
    expect(s.profile?.id).toBe('ifaces');
    await s.close();
  });

  it('uses the fallback, or no profile, when nothing matches', async () => {
    const a = await open({}, { profile: autoDetect([nokia], generic) });
    expect(a.s.profile?.id).toBe('generic');
    await a.s.close();
    const b = await open({}, { profile: autoDetect([nokia]) });
    expect(b.s.profile).toBeUndefined();
    await b.s.close();
  });

  describe('unverified profiles (PROFILE-05)', () => {
    const unverified = profile({ id: 'ifaces-draft', status: 'unverified', match: { anyModule: ['ietf-interfaces'] } });
    const verified = profile({ id: 'ifaces-ok', status: 'verified', match: { anyModule: ['ietf-interfaces'] } });

    async function warningsFor(options: Partial<ConnectOptions>): Promise<{ msg: string; meta: unknown }[]> {
      const warnings: { msg: string; meta: unknown }[] = [];
      const logger = { warn: (msg: string, meta?: unknown) => warnings.push({ msg, meta }) };
      const { s } = await open({}, { logger, ...options });
      await s.close();
      return warnings;
    }

    it('warns, naming the profile and its status, when auto-detection picks an unverified profile', async () => {
      const warnings = await warningsFor({ profile: autoDetect([unverified]) });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.msg).toMatch(/ifaces-draft is unverified/);
      expect(warnings[0]!.meta).toEqual({ profile: 'ifaces-draft', status: 'unverified' });
    });

    it('warns when an unverified profile is the fallback', async () => {
      const draft = profile({ id: 'draft', status: 'unverified' });
      const warnings = await warningsFor({ profile: autoDetect([], draft) });
      expect(warnings.map((w) => w.meta)).toEqual([{ profile: 'draft', status: 'unverified' }]);
    });

    it('still uses the unverified profile', async () => {
      const { s } = await open({}, { profile: autoDetect([unverified]), logger: {} });
      expect(s.profile?.id).toBe('ifaces-draft');
      await s.close();
    });

    it('warns when the built-in nokia-sros-md profile is detected from a device hello', async () => {
      const nokiaConf = 'urn:nokia.com:sros:ns:yang:sr:conf?module=nokia-conf&revision=2024-10-17';
      const warnings: { msg: string; meta: unknown }[] = [];
      const logger = { warn: (msg: string, meta?: unknown) => warnings.push({ msg, meta }) };
      const { s } = await open(
        { capabilities: [...CAPS, nokiaConf] },
        { logger, profile: autoDetect(await builtinDeviceProfiles()) },
      );
      expect(s.profile?.id).toBe('nokia-sros-md');
      await s.close();
      expect(warnings.map((w) => w.meta)).toEqual([{ profile: 'nokia-sros-md', status: 'unverified' }]);
    });

    it("doesn't warn for an explicit unverified profile, or an auto-detected verified one", async () => {
      expect(await warningsFor({ profile: unverified })).toEqual([]);
      expect(await warningsFor({ profile: autoDetect([verified]) })).toEqual([]);
    });
  });
});

describe('device operations', () => {
  it('runs a JSON-defined operation and extracts its result', async () => {
    const device = profile({
      id: 'vendor',
      operations: {
        cli: {
          params: { command: 'string' },
          request: '<cli xmlns="urn:vendor"><line>{{command}}</line></cli>',
          result: { path: 'output', as: 'text' },
        },
      },
    });
    const { fake, s } = await open({ handler: () => ({ body: [x('output', { xmlns: 'urn:vendor' }, 'v1.2.3')] }) }, { profile: device });
    expect(s.ops.list.filter((d) => d.device !== undefined).map((d) => d.name)).toEqual(['cli']);
    expect(await s.ops.device.call('cli', { command: 'show version' })).toBe('v1.2.3');
    expect(sent(fake, 0)).toBe('<cli xmlns="urn:vendor"><line>show version</line></cli>');
    await expect(s.ops.device.call('missing')).rejects.toThrow(/no operation "missing"/);
    await s.close();
  });
});

describe('path reads', () => {
  const data = x('interfaces', { xmlns: IF_NS },
    x('interface', x('name', 'eth0'), x('description', 'uplink')),
    x('interface', x('name', 'eth1'), x('description', 'spare')));

  it('reads by path from running config, resolving the module from the hello', async () => {
    const { fake, s } = await open({ handler: () => ({ data }) });
    const found = await s.content.read('/ietf-interfaces:interfaces/interface[name="eth0"]/description', { format: 'xml' });
    expect(found.map((e: XmlElement) => e.text())).toEqual(['uplink']);
    expect(sent(fake, 0)).toBe(
      `<get-config xmlns="${NETCONF_NS}"><source><running/></source><filter type="subtree">` +
        `<interfaces xmlns="${IF_NS}"><interface><name>eth0</name><description/></interface></interfaces></filter></get-config>`,
    );
    await s.close();
  });

  it("uses <get> for source 'config+state' and returns undefined for no match", async () => {
    const { fake, s } = await open({ handler: () => ({ data }) });
    expect(await s.content.readValue('/ietf-interfaces:interfaces/interface[name="eth9"]/description', { source: 'config+state', format: 'xml' })).toBeUndefined();
    expect(opNames(fake)).toEqual(['get']);
    await s.close();
  });

  it("refuses source 'operational' (the NMDA datastore), pointing at nmda, before sending anything", async () => {
    const { fake, s } = await open({ handler: () => ({ data }) });
    const path = '/ietf-interfaces:interfaces/interface[name="eth0"]/description';
    const source = 'operational' as 'config+state';
    await expect(s.content.read(path, { source })).rejects.toThrow(TypeError);
    await expect(s.content.readValue(path, { source })).rejects.toThrow(/client\.ops\.nmda\.getData\(\{ datastore: 'operational' \}\)/);
    expect(opNames(fake)).toEqual([]);
    await s.close();
  });

  it("subtreeFilter: 'unsupported' fetches the whole datastore and selects locally", async () => {
    const device = profile({ id: 'nofilter', quirks: { subtreeFilter: 'unsupported' } });
    const { fake, s } = await open({ handler: () => ({ data }) }, { profile: device });
    const found = await s.content.read('/ietf-interfaces:interfaces/interface[name="eth1"]/description', { format: 'xml' });
    expect(found.map((e: XmlElement) => e.text())).toEqual(['spare']);
    expect(sent(fake, 0)).toBe(`<get-config xmlns="${NETCONF_NS}"><source><running/></source></get-config>`);

    // So is configuration and state.
    expect(await s.content.readValue('/ietf-interfaces:interfaces/interface[name="eth0"]/description', { source: 'config+state', format: 'xml' })).toBe('uplink');
    expect(sent(fake, 1)).toBe(`<get xmlns="${NETCONF_NS}"/>`);

    // Explicit calls are unaffected: a filter the caller gives is still sent.
    await s.ops.getConfig({ filter: { type: 'subtree', content: [x('interfaces', { xmlns: IF_NS })] } });
    expect(sent(fake, 2)).toContain('<filter type="subtree">');
    await s.close();
  });

  it("subtreeFilter: 'containers' sends a filter cut at the depth and selects the rest locally", async () => {
    const device = profile({ id: 'shallow', quirks: { subtreeFilter: 'containers', subtreeFilterDepth: 1 } });
    const { fake, s } = await open({ handler: () => ({ data }) }, { profile: device });
    const found = await s.content.read('/ietf-interfaces:interfaces/interface[name="eth1"]/description', { format: 'xml' });
    expect(found.map((e: XmlElement) => e.text())).toEqual(['spare']);
    // The keyed interface right after the depth is kept; description is selected locally.
    expect(sent(fake, 0)).toBe(
      `<get-config xmlns="${NETCONF_NS}"><source><running/></source><filter type="subtree">` +
        `<interfaces xmlns="${IF_NS}"><interface><name>eth1</name></interface></interfaces></filter></get-config>`,
    );
    expect(await s.content.readValue('/ietf-interfaces:interfaces/interface[name="eth0"]/description', { source: 'config+state', format: 'xml' })).toBe('uplink');
    expect(sent(fake, 1)).toContain(`<interfaces xmlns="${IF_NS}"><interface><name>eth0</name></interface></interfaces>`);
    await s.close();
  });

  it('resolves @aliases from the profile, and namespaces from the profile or options', async () => {
    const device = profile({
      id: 'p',
      namespaces: { 'acme-system': 'urn:acme:system' },
      paths: { hostname: '/acme-system:system/hostname' },
    });
    const { fake, s } = await open({ handler: () => ({ data: x('system', { xmlns: 'urn:acme:system' }, x('hostname', 'r1')) }) }, { profile: device });
    expect(await s.content.readValue('@hostname', { format: 'xml' })).toBe('r1');
    expect(() => s.content.resolvePath('@nope')).toThrow(PathError);
    expect(() => s.content.resolvePath('/other:thing')).toThrow(/Unknown YANG module "other"/);
    expect(sent(fake, 0)).toContain('<system xmlns="urn:acme:system"><hostname/></system>');
    await s.close();

    const b = await open({}, { namespaces: { other: 'urn:other' } });
    expect(b.s.content.resolvePath('/other:thing')[0]!.ns).toBe('urn:other');
    await b.s.close();
  });
});

describe('configure() workflow', () => {
  it('candidate: locks running and candidate, discards, edits, validates, commits, unlocks (via withCandidate)', async () => {
    const { fake, s } = await open({});
    await s.content.configure((txn) => {
      txn.set('/ietf-interfaces:interfaces/interface[name="eth0"]/description', 'uplink');
      txn.remove('/ietf-interfaces:interfaces/interface[name="eth9"]');
    });
    expect(opNames(fake)).toEqual(['lock', 'lock', 'discard-changes', 'edit-config', 'validate', 'commit', 'unlock', 'unlock']);
    expect(sent(fake, 0)).toContain('<running/>');
    expect(sent(fake, 1)).toContain('<candidate/>');
    expect(sent(fake, 3)).toBe(
      `<edit-config xmlns="${NETCONF_NS}"><target><candidate/></target><config>` +
        `<interfaces xmlns="${IF_NS}"><interface><name>eth0</name><description>uplink</description></interface>` +
        `<interface xmlns:nc="${NETCONF_NS}" nc:operation="remove"><name>eth9</name></interface></interfaces></config></edit-config>`,
    );
    await s.close();
  });

  it("follows the profile's workflow, and explicit options override it", async () => {
    const device = profile({ id: 'r', workflow: { editTarget: 'running', lock: false } });
    const { fake, s } = await open({}, { profile: device });
    await s.content.set('/ietf-interfaces:interfaces/interface[name="eth0"]/enabled', true);
    await s.content.remove('/ietf-interfaces:interfaces/interface[name="eth0"]/description', { lock: true });
    expect(opNames(fake)).toEqual(['edit-config', 'lock', 'edit-config', 'unlock']);
    expect(sent(fake, 0)).toContain('<target><running/></target>');
    await s.close();
  });

  it('on failure discards the candidate, always unlocks, and rejects with a TransactionError', async () => {
    const { fake, s } = await open({
      handler: (_rpc, { operation }) =>
        operation?.name === 'commit' ? { errors: [{ type: 'application', tag: 'operation-failed', message: 'nope' }] } : 'ok',
    });
    const err = await s.content.set('/ietf-interfaces:interfaces/interface[name="eth0"]/mtu', 9000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionError);
    expect((err as TransactionError).phase).toBe('commit');
    expect((err as TransactionError).cause).toBeInstanceOf(RpcError);
    expect(opNames(fake)).toEqual(['lock', 'lock', 'discard-changes', 'edit-config', 'validate', 'commit', 'discard-changes', 'unlock', 'unlock']);
    await s.close();
  });

  it('sends nothing for an empty transaction, and rejects bad paths before locking', async () => {
    const { fake, s } = await open({});
    await s.content.configure(() => undefined);
    await expect(s.content.set('/unknown-mod:x', 1)).rejects.toBeInstanceOf(PathError);
    expect(fake.requests).toHaveLength(0);
    await s.close();
  });
});

describe('readFilter() (CONTENT-01)', () => {
  const path = '/ietf-interfaces:interfaces/interface[name="eth0"]/description';

  it('returns the subtree filter read() sends, and sends nothing', async () => {
    const { fake, s } = await open({ handler: () => ({ data: x('interfaces', { xmlns: IF_NS }) }) });
    const filter = s.content.readFilter(path);
    expect(fake.requests).toHaveLength(0);
    expect(filter?.type).toBe('subtree');
    await s.content.read(path, { format: 'xml' });
    const wire = sent(fake, 0);
    const content = (filter as unknown as { content: XmlElement[] }).content.map((e) => serializeXml(e)).join('');
    expect(wire).toContain(`<filter type="subtree">${content}</filter>`);
    await s.close();
  });

  it("follows the subtreeFilter quirk: trimmed with 'containers', none with 'unsupported'", async () => {
    const shallow = await open({}, { profile: profile({ id: 'shallow', quirks: { subtreeFilter: 'containers', subtreeFilterDepth: 1 } }) });
    const trimmed = shallow.s.content.readFilter(path) as unknown as { content: XmlElement[] };
    expect(serializeXml(trimmed.content[0]!)).toBe(`<interfaces xmlns="${IF_NS}"><interface><name>eth0</name></interface></interfaces>`);
    await shallow.s.close();
    const none = await open({}, { profile: profile({ id: 'nofilter', quirks: { subtreeFilter: 'unsupported' } }) });
    expect(none.s.content.readFilter(path)).toBeUndefined();
    expect(none.fake.requests).toHaveLength(0);
    await none.s.close();
  });

  it('resolves @names and throws PathError as read() would', async () => {
    const device = profile({ id: 'p', paths: { desc: path } });
    const { s } = await open({}, { profile: device });
    expect(serializeXml((s.content.readFilter('@desc') as unknown as { content: XmlElement[] }).content[0]!)).toContain('<description/>');
    expect(() => s.content.readFilter('@nope')).toThrow(PathError);
    expect(() => s.content.readFilter('/other:thing')).toThrow(/Unknown YANG module "other"/);
    await s.close();
  });
});

describe('configure() onStep (CONTENT-06)', () => {
  type Step = { operation: string; datastore: string };
  const desc = '/ietf-interfaces:interfaces/interface[name="eth0"]/description';

  it('reports each candidate workflow step as it succeeds', async () => {
    const { s } = await open({});
    const steps: Step[] = [];
    await s.content.set(desc, 'uplink', { onStep: (st) => steps.push(st) });
    expect(steps).toEqual([
      { operation: 'lock', datastore: 'running' },
      { operation: 'lock', datastore: 'candidate' },
      { operation: 'discard-changes', datastore: 'candidate' },
      { operation: 'edit-config', datastore: 'candidate' },
      { operation: 'validate', datastore: 'candidate' },
      { operation: 'commit', datastore: 'candidate' },
      { operation: 'unlock', datastore: 'candidate' },
      { operation: 'unlock', datastore: 'running' },
    ]);
    await s.close();
  });

  it('reports the running workflow steps', async () => {
    const device = profile({ id: 'r', workflow: { editTarget: 'running' } });
    const { s } = await open({}, { profile: device });
    const steps: Step[] = [];
    await s.content.remove(desc, { onStep: (st) => steps.push(st) });
    expect(steps).toEqual([
      { operation: 'lock', datastore: 'running' },
      { operation: 'edit-config', datastore: 'running' },
      { operation: 'unlock', datastore: 'running' },
    ]);
    await s.close();
  });

  it('reports cleanup after a failure, but not the failed step', async () => {
    const { s } = await open({
      handler: (_rpc, { operation }) =>
        operation?.name === 'commit' ? { errors: [{ type: 'application', tag: 'operation-failed', message: 'nope' }] } : 'ok',
    });
    const steps: string[] = [];
    await expect(s.content.set(desc, 'x', { onStep: (st) => steps.push(`${st.operation} ${st.datastore}`) })).rejects.toBeInstanceOf(TransactionError);
    expect(steps).toEqual([
      'lock running', 'lock candidate', 'discard-changes candidate', 'edit-config candidate', 'validate candidate',
      'discard-changes candidate', 'unlock candidate', 'unlock running',
    ]);
    await s.close();
  });

  it('reports discard and unlock after a failed running-path edit on the candidate', async () => {
    const device = profile({ id: 'c', workflow: { editTarget: 'candidate', commit: false } });
    const { s } = await open({
      handler: (_rpc, { operation }) =>
        operation?.name === 'edit-config' ? { errors: [{ type: 'application', tag: 'invalid-value', message: 'bad' }] } : 'ok',
    }, { profile: device });
    const steps: string[] = [];
    await expect(s.content.set(desc, 'x', { onStep: (st) => steps.push(`${st.operation} ${st.datastore}`) })).rejects.toBeInstanceOf(RpcError);
    expect(steps).toEqual(['lock candidate', 'discard-changes candidate', 'unlock candidate']);
    await s.close();
  });

  it('a listener that throws is logged and changes nothing', async () => {
    const warnings: string[] = [];
    const logger = { warn: (msg: string) => warnings.push(msg) };
    const { fake, s } = await open({}, { logger });
    await s.content.set(desc, 'uplink', { onStep: () => { throw new Error('listener broke'); } });
    expect(opNames(fake)).toEqual(['lock', 'lock', 'discard-changes', 'edit-config', 'validate', 'commit', 'unlock', 'unlock']);
    expect(warnings.filter((w) => w === 'onStep listener threw')).toHaveLength(8);
    await expect(s.content.set(desc, 'x', { onStep: 'no' as never })).rejects.toThrow(/onStep must be a function/);
    await s.close();
  });
});

describe('configure() confirmed (CONTENT-06)', () => {
  const desc = '/ietf-interfaces:interfaces/interface[name="eth0"]/description';
  const CONFIRMING = [...CAPS, CAP('confirmed-commit:1.1')];

  it('applies with a confirmed commit and resolves with the PendingCommit', async () => {
    const { fake, s } = await open({ capabilities: CONFIRMING });
    const pending = await s.content.set(desc, 'uplink', { confirmed: { timeout: 120 } });
    expect(pending?.state).toBe('pending');
    expect(opNames(fake)).toEqual(['lock', 'lock', 'discard-changes', 'edit-config', 'validate', 'commit', 'unlock']);
    expect(sent(fake, 5)).toBe(`<commit xmlns="${NETCONF_NS}"><confirmed/><confirm-timeout>120</confirm-timeout></commit>`);
    await pending!.confirm();
    expect(pending!.state).toBe('confirmed');
    expect(opNames(fake).slice(-2)).toEqual(['commit', 'unlock']);
    // confirmed: false from an untyped caller is a plain commit.
    expect(await s.content.set(desc, 'plain', { confirmed: false as never })).toBeUndefined();
    expect(opNames(fake).at(-2)).toBe('unlock');
    // No changes: nothing sent, no pending commit.
    expect(await s.content.configure(() => undefined, { confirmed: true })).toBeUndefined();
    await s.close();
  });

  it('remove() and configure() take confirmed too, and the pending commit can be cancelled', async () => {
    const { fake, s } = await open({ capabilities: CONFIRMING });
    const pending = await s.content.remove(desc, { confirmed: true });
    await pending!.cancel();
    expect(pending!.state).toBe('cancelled');
    expect(opNames(fake)).toContain('cancel-commit');
    await s.close();
  });

  it('is refused before sending without a candidate, or with a running or no-commit workflow', async () => {
    const bare = await open({ capabilities: [BASE_1_0, BASE_1_1, CAP('writable-running:1.0'), IF_MODULE] });
    await expect(bare.s.content.set(desc, 'x', { confirmed: true })).rejects.toBeInstanceOf(CapabilityError);
    expect(bare.fake.requests).toHaveLength(0);
    await bare.s.close();

    const running = await open({ capabilities: CONFIRMING }, { profile: profile({ id: 'r', workflow: { editTarget: 'running' } }) });
    await expect(running.s.content.set(desc, 'x', { confirmed: true })).rejects.toThrow(/confirmed commit needs the candidate workflow with commit, but this one edits running/);
    await expect(running.s.content.set(desc, 'x', { confirmed: true, editTarget: 'candidate', commit: false })).rejects.toThrow(/has commit turned off/);
    expect(running.fake.requests).toHaveLength(0);
    await running.s.close();

    // Missing :confirmed-commit is checked by withCandidate, still before sending.
    const plain = await open({});
    await expect(plain.s.content.set(desc, 'x', { confirmed: true })).rejects.toThrow(/:confirmed-commit/);
    expect(plain.fake.requests).toHaveLength(0);
    await plain.s.close();
  });
});

describe('checkEdits() (CONTENT-05)', () => {
  const desc = '/ietf-interfaces:interfaces/interface[name="eth0"]/description';

  it('rejects with the PathError configure() would give, and sends nothing', async () => {
    const { fake, s } = await open({});
    await expect(s.content.checkEdits((txn) => txn.set(desc, 'a'))).resolves.toBeUndefined();
    const cases: ((txn: Parameters<Parameters<typeof s.content.checkEdits>[0]>[0]) => unknown)[] = [
      (txn) => txn.set('/acme:system/name', 'x'),
      (txn) => txn.set('@nope', 'x'),
      (txn) => txn.set(desc, 'a').set(desc, 'b'),
    ];
    for (const build of cases) {
      const checked = await s.content.checkEdits(build).catch((e: unknown) => e);
      expect(checked).toBeInstanceOf(PathError);
      const applied = await s.content.configure(build).catch((e: unknown) => e);
      expect((checked as Error).message).toBe((applied as Error).message);
    }
    await expect(s.content.checkEdits((txn) => txn.set('no-slash', 'x'))).rejects.toBeInstanceOf(PathError);
    expect(fake.requests).toHaveLength(0);
    await s.close();
  });
});
