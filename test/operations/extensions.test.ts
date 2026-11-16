/**
 * The extension mechanism (design §6, §8) and operation descriptors
 * (nnc's docs/cli.md §7): OPS-12, OPS-13 and OPS-14.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BASE_1_0,
  BASE_1_1,
  BASE_OPERATIONS,
  buildOperation,
  CapabilityError,
  ClientOps,
  connect,
  NETCONF_NS,
  NetconfClient,
  serializeXml,
  subtree,
  x,
  type ConnectOptions,
  type Extension,
  type Logger,
} from '../../src/index.js';
import { defineExtension, type ExtensionContext, type RequestBuilder } from '../../src/operations/index.js';
import { FakeServer, type FakeServerOptions } from '../../src/testing/index.js';

const CAP = (n: string): string => `urn:ietf:params:netconf:capability:${n}`;
const ALL = [
  BASE_1_0,
  BASE_1_1,
  CAP('candidate:1.0'),
  CAP('validate:1.1'),
  CAP('writable-running:1.0'),
  CAP('startup:1.0'),
  CAP('url:1.0'),
  CAP('xpath:1.0'),
  CAP('confirmed-commit:1.1'),
  CAP('rollback-on-error:1.0'),
  'urn:example:echo:1.0',
];
const ECHO_NS = 'urn:example:echo';

/** A third-party style module: one RPC with a descriptor, one augment, plain ops and a content reader. */
const echo = defineExtension({
  id: 'echo',
  requires: ['urn:example:echo:1.0'],
  clientCapabilities: ['urn:example:client-echo:1.0'],
  ops: (ctx: ExtensionContext) => ({
    sessionId: ctx.sessionId,
    ping: async (text: string) => (await ctx.invoke({ element: x('ping', { xmlns: ECHO_NS }, text), requires: [] })).ok,
  }),
  content: (ctx: ExtensionContext) => ({
    greeting: () => `hello from session ${ctx.sessionId}`,
  }),
  descriptors: [
    {
      name: 'ping',
      namespace: ECHO_NS,
      method: 'ping',
      description: 'Echo some text',
      mutates: false,
      requires: ['urn:example:echo:1.0'],
      params: [{ name: 'text', kind: 'positional', type: 'string', description: 'What to echo', required: true }],
    },
  ],
  requests: { ping: (a) => ({ element: x('ping', { xmlns: ECHO_NS }, String(a['text'])), requires: [] }) },
  augments: [
    {
      operation: 'get',
      params: [{ name: 'depth', kind: 'option', type: 'number', description: 'Limit depth' }],
      apply: (req, args) => ({
        ...req,
        element: x(req.element.name, { xmlns: NETCONF_NS }, req.element.children, x('depth', { xmlns: ECHO_NS }, String(args['depth']))),
      }),
    },
  ],
});

async function open<const E extends readonly Extension[] = []>(
  server: FakeServerOptions = {},
  options: Partial<ConnectOptions<E>> = {},
) {
  const fake = new FakeServer({ capabilities: ALL, ...server });
  const client = await connect<E>({ transport: fake.transport(), ...options });
  return { fake, client };
}

const op = (fake: FakeServer, i = -1): string => serializeXml(fake.requests.at(i)!.elements[0]!);

function memoryLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return { warnings, warn: (m: string) => warnings.push(m) };
}

// --- OPS-12: base descriptors ----------------------------------------------------

describe('BASE_OPERATIONS (OPS-12)', () => {
  const names = BASE_OPERATIONS.map((d) => d.name);

  it('describes every base operation, including close-session', () => {
    expect(names).toEqual([
      'get', 'get-config', 'edit-config', 'copy-config', 'delete-config', 'lock', 'unlock',
      'validate', 'commit', 'cancel-commit', 'discard-changes', 'kill-session', 'close-session', 'action',
    ]);
  });

  it('gives each a description, its parameters and its capabilities', () => {
    for (const d of BASE_OPERATIONS) {
      expect(d.description.length, d.name).toBeGreaterThan(0);
      // The YANG 1.1 action is the one base operation outside the NETCONF namespace.
      expect(d.namespace).toBe(d.name === 'action' ? 'urn:ietf:params:xml:ns:yang:1' : NETCONF_NS);
      for (const p of d.params) {
        expect(['positional', 'option']).toContain(p.kind);
        expect(p.description.length, `${d.name} ${p.name}`).toBeGreaterThan(0);
      }
    }
    const commit = BASE_OPERATIONS.find((d) => d.name === 'commit')!;
    expect(commit.requires).toEqual([':candidate']);
    expect(commit.params.find((p) => p.name === 'confirmed')!.requires).toEqual([':confirmed-commit']);
    const getConfig = BASE_OPERATIONS.find((d) => d.name === 'get-config')!;
    expect(getConfig.params[0]).toMatchObject({ name: 'source', kind: 'positional', default: 'running', values: ['running', 'candidate', 'startup'] });
    expect(getConfig.params[0]!.valueRequires).toEqual({ candidate: [':candidate'], startup: [':startup'] });
  });

  it('says which operations change state', () => {
    const mutating = BASE_OPERATIONS.filter((d) => d.mutates).map((d) => d.name);
    expect(mutating).toEqual([
      'edit-config', 'copy-config', 'delete-config', 'lock', 'unlock', 'commit', 'cancel-commit', 'discard-changes', 'kill-session', 'action',
    ]);
  });

  it('is plain data that survives a JSON round trip', () => {
    expect(JSON.parse(JSON.stringify(BASE_OPERATIONS))).toEqual(BASE_OPERATIONS);
    const hasFunction = (v: unknown): boolean =>
      typeof v === 'function' || (typeof v === 'object' && v !== null && Object.values(v).some(hasFunction));
    expect(hasFunction(BASE_OPERATIONS)).toBe(false);
  });

  it('every descriptor names a client.ops method (close-session the client\'s close()), and every base method has a descriptor', () => {
    const methods = new Set(BASE_OPERATIONS.map((d) => d.method));
    for (const m of methods) {
      const on = m === 'close' ? NetconfClient.prototype : ClientOps.prototype;
      expect(typeof (on as unknown as Record<string, unknown>)[m], m).toBe('function');
    }
    const base = ['get', 'getConfig', 'editConfig', 'copyConfig', 'deleteConfig', 'lock', 'unlock', 'commit',
      'cancelCommit', 'discardChanges', 'validate', 'killSession', 'close'];
    for (const m of base) expect(methods.has(m), m).toBe(true);
  });

  // The same arguments through ops.run() and through the method send the same XML.
  const cases: [string, Record<string, unknown>, (c: NetconfClient) => Promise<unknown>][] = [
    ['get', { filter: subtree(x('a', { xmlns: 'urn:a' })) }, (c) => c.ops.get({ filter: subtree(x('a', { xmlns: 'urn:a' })) })],
    ['get-config', { source: 'candidate' }, (c) => c.ops.getConfig({ source: 'candidate' })],
    ['edit-config', { target: 'candidate', config: x('a', { xmlns: 'urn:a' }), defaultOperation: 'replace', testOption: 'test-only', errorOption: 'rollback-on-error' },
      (c) => c.ops.editConfig({ target: 'candidate', config: x('a', { xmlns: 'urn:a' }), defaultOperation: 'replace', testOption: 'test-only', errorOption: 'rollback-on-error' })],
    ['copy-config', { target: 'startup', source: 'running' }, (c) => c.ops.copyConfig({ target: 'startup', source: 'running' })],
    ['delete-config', { target: { url: 'file:///x.xml' } }, (c) => c.ops.deleteConfig({ url: 'file:///x.xml' })],
    ['lock', { target: 'candidate' }, (c) => c.ops.lock('candidate')],
    ['unlock', { target: 'running' }, (c) => c.ops.unlock('running')],
    ['validate', { source: 'candidate' }, (c) => c.ops.validate('candidate')],
    ['commit', { confirmed: true, confirmTimeout: 30, persist: 'p1' }, (c) => c.ops.commit({ confirmed: true, confirmTimeout: 30, persist: 'p1' })],
    ['cancel-commit', { persistId: 'p1' }, (c) => c.ops.cancelCommit({ persistId: 'p1' })],
    ['discard-changes', {}, (c) => c.ops.discardChanges()],
    ['kill-session', { sessionId: 7 }, (c) => c.ops.killSession(7)],
    ['action', { target: x('servers', { xmlns: 'urn:example:act' }, x('server', x('name', 'a'), x('ping'))) }, (c) => c.ops.action(x('servers', { xmlns: 'urn:example:act' }, x('server', x('name', 'a'), x('ping'))))],
  ];

  it.each(cases)('%s: ops.run sends the same XML as the method', async (name, args, viaMethod) => {
    const { fake, client } = await open();
    await client.ops.run(name, args);
    const fromDescriptor = op(fake);
    await viaMethod(client);
    expect(op(fake)).toBe(fromDescriptor);
    expect(serializeXml(buildOperation(name, args).element)).toBe(fromDescriptor);
    await client.close();
  });

  it('close-session through ops.run closes the client', async () => {
    const { fake, client } = await open();
    await expect(client.ops.run('close-session')).resolves.toBeUndefined();
    expect(client.session.state).toBe('closed');
    expect(fake.requests.at(-1)!.elements[0]!.name).toBe('close-session');
  });

  it('every operation with a test case is covered', () => {
    expect([...cases.map((c) => c[0]), 'close-session'].sort()).toEqual([...names].sort());
  });
});

// --- OPS-14: enabling extensions --------------------------------------------------

describe('connect({ extensions }) (OPS-14)', () => {
  it('enables nothing by default', async () => {
    const { client } = await open();
    expect(Object.keys(client.ops)).toEqual(['list', 'device']);
    expect(Object.keys(client.content)).toEqual([]);
    expect(client.ops.list).toEqual(BASE_OPERATIONS);
    await client.close();
  });

  it('exposes each extension as client.ops.<id> and client.content.<id>, typed from the extensions passed', async () => {
    const { fake, client } = await open({ handler: () => 'ok' }, { extensions: [echo] });
    expectTypeOf(client.ops.echo.ping).toEqualTypeOf<(text: string) => Promise<boolean>>();
    expectTypeOf(client.content.echo.greeting).toEqualTypeOf<() => string>();
    expect(client.ops.echo.sessionId).toBe(client.session.sessionId);
    await expect(client.ops.echo.ping('hi')).resolves.toBe(true);
    expect(op(fake)).toContain('<ping xmlns="urn:example:echo">hi</ping>');
    expect(client.content.echo.greeting()).toBe(`hello from session ${client.session.sessionId}`);
    expect(Object.isFrozen(client.ops.echo)).toBe(true);
    expect(Object.isFrozen(client.content.echo)).toBe(true);
    expect(() => {
      (client.ops as unknown as Record<string, unknown>)['echo'] = {};
    }).toThrow(TypeError);
    await client.close();
  });

  it('adds an extension only to the layers it has a section for', async () => {
    const opsOnly = defineExtension({ id: 'opsOnly', ops: () => ({ go: () => 1 }) });
    const contentOnly = defineExtension({ id: 'contentOnly', content: () => ({ look: () => 2 }) });
    const { client } = await open({}, { extensions: [opsOnly, contentOnly] });
    expect(client.ops.opsOnly.go()).toBe(1);
    expect(client.content.contentOnly.look()).toBe(2);
    expect('opsOnly' in client.content).toBe(false);
    expect('contentOnly' in client.ops).toBe(false);
    // @ts-expect-error contentOnly has no ops section
    void client.ops.contentOnly;
    await client.close();
  });

  it('refuses an extension id that would hide a built-in member of a layer, before opening the transport', async () => {
    let opened = false;
    const transport = () => {
      opened = true;
      return Promise.reject(new Error('should not open'));
    };
    for (const id of ['list', 'run', 'device', 'get', 'editConfig']) {
      const ext = defineExtension({ id, ops: () => ({}) });
      await expect(connect({ transport, extensions: [ext] }), id).rejects.toThrow(/would hide client\.ops\./);
    }
    for (const id of ['read', 'configure', 'loadModules']) {
      const ext = defineExtension({ id, content: () => ({}) });
      await expect(connect({ transport, extensions: [ext] }), id).rejects.toThrow(/would hide client\.content\./);
    }
    // The same name is free in a layer the extension doesn't contribute to.
    const readOps = defineExtension({ id: 'read', ops: () => ({}) });
    const fake = new FakeServer({ capabilities: ALL });
    const client = await connect({ transport: fake.transport(), extensions: [readOps] });
    expect(client.ops.read).toBeDefined();
    await client.close();
    expect(opened).toBe(false);
  });

  it("advertises the extensions' client capabilities in our hello", async () => {
    const fake = new FakeServer({ capabilities: ALL });
    const client = await connect({ transport: fake.transport(), capabilities: ['urn:example:mine:1.0'], extensions: [echo] });
    const caps = (await fake.clientHello).child('capabilities')!.childrenNamed('capability').map((c) => c.text());
    expect(caps).toContain('urn:example:mine:1.0');
    expect(caps).toContain('urn:example:client-echo:1.0');
    await client.close();
  });

  it('strict: a missing required capability rejects connect with CapabilityError and closes the session', async () => {
    const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
    const err = await connect({ transport: fake.transport(), extensions: [echo] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).capability).toBe('urn:example:echo:1.0');
    expect((err as Error).message).toMatch(/echo extension/);
    expect(fake.requests.at(-1)?.elements[0]?.name).toBe('close-session');
  });

  it('warn: logs and enables the extension anyway', async () => {
    const logger = memoryLogger();
    const { client } = await open({ capabilities: [BASE_1_0, BASE_1_1] }, { extensions: [echo], capabilityCheck: 'warn', logger });
    expect(logger.warnings.join('\n')).toMatch(/echo needs urn:example:echo:1.0/);
    expect(client.ops.echo).toBeDefined();
    await client.close();
  });

  it('off: no check', async () => {
    const logger = memoryLogger();
    const { client } = await open({ capabilities: [BASE_1_0, BASE_1_1] }, { extensions: [echo], capabilityCheck: 'off', logger });
    expect(logger.warnings).toEqual([]);
    expect(client.ops.echo).toBeDefined();
    await client.close();
  });

  it("extensionCheck 'off' enables an extension the server lacks, and its operations are still refused before sending", async () => {
    const logger = memoryLogger();
    const { client, fake } = await open({ capabilities: [BASE_1_0, BASE_1_1] }, { extensions: [echo], extensionCheck: 'off', logger });
    expect(logger.warnings).toEqual([]);
    expect(client.ops.list.map((d) => d.name)).toContain('ping');
    const err = await client.ops.run('ping', { text: 'hi' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).capability).toBe('urn:example:echo:1.0');
    expect(fake.requests.map((r) => r.elements[0]?.name)).not.toContain('ping');
    // The extension's own methods refuse too.
    await expect(client.ops.echo.ping('hi')).rejects.toThrow(CapabilityError);
    expect(fake.requests.map((r) => r.elements[0]?.name)).not.toContain('ping');
    await client.close();
  });

  it("extensionCheck 'warn' logs at connect, while capabilityCheck stays strict for operations", async () => {
    const logger = memoryLogger();
    const { client } = await open({ capabilities: [BASE_1_0, BASE_1_1] }, { extensions: [echo], extensionCheck: 'warn', logger });
    expect(logger.warnings.join('\n')).toMatch(/echo needs urn:example:echo:1.0/);
    await expect(client.ops.run('ping', { text: 'hi' })).rejects.toThrow(CapabilityError);
    await client.close();
  });

  it("extensionCheck 'strict' overrides a looser capabilityCheck at connect", async () => {
    const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
    const err = await connect({ transport: fake.transport(), extensions: [echo], capabilityCheck: 'off', extensionCheck: 'strict' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CapabilityError);
  });

  it('checks requirements against the profile-corrected capabilities', async () => {
    const { client } = await open(
      { capabilities: [BASE_1_0, BASE_1_1] },
      { extensions: [echo], profile: { id: 'adds-echo', capabilities: { add: ['urn:example:echo:1.0'] } } },
    );
    expect(client.ops.echo).toBeDefined();
    await client.close();
  });

  it('rejects duplicate ids and conflicting options before opening the transport', async () => {
    let opened = false;
    const transport = () => {
      opened = true;
      return Promise.reject(new Error('should not open'));
    };
    await expect(connect({ transport, extensions: [echo, echo] })).rejects.toThrow(TypeError);
    const echo2 = defineExtension({ ...echo, id: 'echo2' });
    await expect(connect({ transport, extensions: [echo, echo2] })).rejects.toThrow(/both add depth to get/);
    const clash = defineExtension({ id: 'clash', augments: [{ operation: 'get', params: [{ name: 'filter', kind: 'option', type: 'string', description: 'x' }], apply: (r) => r }] });
    await expect(connect({ transport, extensions: [clash] })).rejects.toThrow(/already has it/);
    expect(opened).toBe(false);
  });

  it('an added option works on the method only when its extension is enabled', async () => {
    const plain = await open();
    await expect(plain.client.ops.get({ depth: 2 } as never)).rejects.toThrow(TypeError);
    await expect(plain.client.ops.get({ depth: 2 } as never)).rejects.toThrow(/no option "depth"/);
    expect(plain.fake.requests).toHaveLength(0);
    await plain.client.close();

    const { fake, client } = await open({}, { extensions: [echo] });
    await client.ops.get({ depth: 2 } as never);
    expect(op(fake)).toBe(`<get xmlns="${NETCONF_NS}"><depth xmlns="${ECHO_NS}">2</depth></get>`);
    await client.ops.get();
    expect(op(fake)).toBe(`<get xmlns="${NETCONF_NS}"/>`);
    await client.close();
  });

  it('client.ops.list lists base operations with added options, then extension operations', async () => {
    const { client } = await open({}, { extensions: [echo] });
    const get = client.ops.list.find((d) => d.name === 'get')!;
    expect(get.params.map((p) => p.name)).toEqual(['filter', 'depth']);
    expect(get.params[1]!.extension).toBe('echo');
    expect(client.ops.list.at(-1)).toMatchObject({ name: 'ping', extension: 'echo', method: 'ping' });
    expect(JSON.parse(JSON.stringify(client.ops.list))).toEqual(client.ops.list);
    await client.close();
  });

  it('ops.run runs extension operations and applies options from extensions', async () => {
    const { fake, client } = await open({ handler: () => 'ok' }, { extensions: [echo] });
    await client.ops.run('ping', { text: 'yo' });
    expect(op(fake)).toBe(`<ping xmlns="${ECHO_NS}">yo</ping>`);
    await client.ops.run('get', { depth: 1 });
    expect(op(fake)).toContain('<depth');
    await expect(client.ops.run('nope')).rejects.toThrow(/No operation named "nope"/);
    await expect(client.ops.run('ping', { text: 'a', bogus: 1 })).rejects.toThrow(TypeError);
    await client.close();
  });

  it('a builder may type its own arguments, with no casts (RequestBuilder<A>)', async () => {
    const greet = (args: { readonly name: string; readonly loud?: boolean }) => ({
      element: x('greet', { xmlns: ECHO_NS }, args.loud === true ? args.name.toUpperCase() : args.name),
      requires: [],
    });
    expectTypeOf(greet).toExtend<RequestBuilder<{ readonly name: string; readonly loud?: boolean }>>();
    const typed = defineExtension({
      id: 'typed',
      descriptors: [
        {
          name: 'greet',
          namespace: ECHO_NS,
          method: 'greet',
          description: 'Greet someone',
          mutates: false,
          requires: [],
          params: [
            { name: 'name', kind: 'positional', type: 'string', description: 'Who', required: true },
            { name: 'loud', kind: 'option', type: 'boolean', description: 'Shout' },
          ],
        },
      ],
      requests: { greet },
    });
    const { fake, client } = await open({ handler: () => 'ok' }, { extensions: [typed] });
    await client.ops.run('greet', { name: 'ada', loud: true });
    expect(op(fake)).toBe(`<greet xmlns="${ECHO_NS}">ADA</greet>`);
    await expect(client.ops.run('greet', { name: 'ada', bogus: 1 })).rejects.toThrow(/greet has no option "bogus"/);
    await client.close();
  });

  it('ops.run applies the capability check', async () => {
    const { fake, client } = await open({ capabilities: [BASE_1_0, BASE_1_1] });
    await expect(client.ops.run('get-config', { source: 'candidate' })).rejects.toThrow(CapabilityError);
    expect(fake.requests).toHaveLength(0);
    await client.close();
  });
});

// --- OPS-13: extension descriptors ------------------------------------------------

describe('extension descriptors (OPS-13)', () => {
  it('an extension may not describe a base operation, or one another extension describes', async () => {
    const transport = () => Promise.reject(new Error('should not open'));
    const shadow = defineExtension({ id: 'shadow', descriptors: [{ ...echo.descriptors[0], name: 'get' }], requests: { get: echo.requests['ping'] } });
    await expect(connect({ transport, extensions: [shadow] })).rejects.toThrow(/describes get, which is a base operation/);
    const twin = defineExtension({ id: 'twin', descriptors: echo.descriptors, requests: echo.requests });
    await expect(connect({ transport, extensions: [echo, twin] })).rejects.toThrow(/both describe ping/);
  });

  it("closes the session if an extension's ops() or content() throws", async () => {
    const fake = new FakeServer({ capabilities: ALL });
    const bad = defineExtension({ id: 'bad', ops: () => { throw new Error('boom'); } });
    await expect(connect({ transport: fake.transport(), extensions: [bad] })).rejects.toThrow('boom');
    expect(fake.requests.at(-1)?.elements[0]?.name).toBe('close-session');
    const badContent = defineExtension({ id: 'badContent', content: () => { throw new Error('bang'); } });
    const fake2 = new FakeServer({ capabilities: ALL });
    await expect(connect({ transport: fake2.transport(), extensions: [badContent] })).rejects.toThrow('bang');
    expect(fake2.requests.at(-1)?.elements[0]?.name).toBe('close-session');
  });

  it('an extension that describes an operation without a builder is refused', async () => {
    const broken = defineExtension({ id: 'broken', descriptors: echo.descriptors });
    await expect(connect({ transport: () => Promise.reject(new Error('x')), extensions: [broken] })).rejects.toThrow(
      /describes ping but has no request builder/,
    );
  });

  it('extension descriptors carry the required capabilities in the same form as BASE_OPERATIONS', () => {
    const d = echo.descriptors[0];
    expect(Object.keys(d).sort()).toEqual(Object.keys(BASE_OPERATIONS[0]!).sort());
    expect(d.requires).toEqual(['urn:example:echo:1.0']);
  });
});
