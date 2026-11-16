import diagnostics from 'node:diagnostics_channel';
import { describe, expect, it } from 'vitest';
import {
  AbortError,
  BASE_1_0,
  BASE_1_1,
  CapabilityError,
  connect,
  HelloError,
  NETCONF_NS,
  RPC_CHANNEL,
  RpcError,
  serializeXml,
  subtree,
  TimeoutError,
  x,
  XmlError,
  xpath,
  type ConnectOptions,
  type Logger,
  type NetconfClient,
  type SessionWarning,
} from '../../src/index.js';
import { FakeServer, type FakeServerOptions, type RpcHandlerResult } from '../../src/testing/index.js';
import { watchConnection } from '../support/connections.js';

const CAP = (name: string): string => `urn:ietf:params:netconf:capability:${name}`;
const ALL_CAPS = [
  BASE_1_0,
  BASE_1_1,
  CAP('writable-running:1.0'),
  CAP('candidate:1.0'),
  CAP('confirmed-commit:1.1'),
  CAP('rollback-on-error:1.0'),
  CAP('validate:1.1'),
  CAP('startup:1.0'),
  CAP('url:1.0?scheme=file,https'),
  CAP('xpath:1.0'),
];

async function open(
  serverOptions: FakeServerOptions = {},
  options: Partial<ConnectOptions> = {},
): Promise<{ server: FakeServer; s: NetconfClient }> {
  const server = new FakeServer({ capabilities: ALL_CAPS, ...serverOptions });
  const s = await connect({ transport: server.transport(), ...options });
  return { server, s };
}

/** The operation the server received in request `i`, serialised. */
const sent = (server: FakeServer, i = 0): string => serializeXml(server.requests[i]!.elements[0]!);
const NC = `xmlns="${NETCONF_NS}"`;

describe('hello and negotiation', () => {
  it('exposes session-id, capabilities and the base version', async () => {
    const { s } = await open({ sessionId: 42 });
    expect(s.session.sessionId).toBe(42);
    expect(s.session.baseVersion).toBe('1.1');
    expect(s.session.serverCapabilities.has(':candidate')).toBe(true);
    expect(s.session.state).toBe('open');
    await s.close();
  });

  it('falls back to base 1.0 with a 1.0-only server', async () => {
    const { s, server } = await open({ capabilities: [BASE_1_0, CAP('candidate:1.0')] });
    expect(s.session.baseVersion).toBe('1.0');
    await expect(s.ops.getConfig({ source: 'candidate' })).resolves.toBeDefined();
    expect(server.version).toBe('1.0');
    await s.close();
  });

  it('advertises extra client capabilities', async () => {
    const { s, server } = await open({}, { capabilities: ['urn:example:client:1.0'] });
    const hello = await server.clientHello;
    const caps = hello.child('capabilities')!.childrenNamed('capability').map((c) => c.text());
    expect(caps).toEqual([BASE_1_0, BASE_1_1, 'urn:example:client:1.0']);
    await s.close();
  });

  it('fails with HelloError on a bad server hello, and closes the transport', async () => {
    const server = new FakeServer({ hello: `<hello xmlns="${NETCONF_NS}"><capabilities/></hello>` });
    const watched = watchConnection(server.connection);
    await expect(connect({ transport: () => Promise.resolve(watched.connection) })).rejects.toBeInstanceOf(HelloError);
    await new Promise((r) => setImmediate(r));
    expect(watched.closed).toBe(true);
  });

  it('honours an abort signal while connecting', async () => {
    const ac = new AbortController();
    const pending = connect({ transport: () => new Promise(() => undefined), signal: ac.signal });
    ac.abort(new Error('user cancelled'));
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AbortError);
  });

  it('times out a transport that never connects', async () => {
    const err = await connect({ transport: () => new Promise(() => undefined), timeouts: { connect: 20 } }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).phase).toBe('connect');
  });
});

describe('rpc()', () => {
  it('sends an element in the NETCONF namespace with a fresh message-id', async () => {
    const { s, server } = await open();
    await s.session.rpc(x('get-chassis-inventory'));
    await s.session.rpc(x('get-chassis-inventory'));
    const ids = server.requests.map((r) => r.attr('message-id'));
    expect(new Set(ids).size).toBe(2);
    expect(server.requests[0]!.elements[0]!.ns).toBe(NETCONF_NS);
    await s.close();
  });

  it('accepts XML text, and rejects malformed text without sending it', async () => {
    const { s, server } = await open();
    await s.session.rpc('<get-interface-information><terse/></get-interface-information>');
    expect(sent(server)).toBe(`<get-interface-information ${NC}><terse/></get-interface-information>`);
    await expect(s.session.rpc('<broken>')).rejects.toBeInstanceOf(XmlError);
    expect(server.requests).toHaveLength(1);
    await s.close();
  });

  it('refuses the <rpc> wrapper itself', async () => {
    const { s } = await open();
    await expect(s.session.rpc(x('rpc', { xmlns: NETCONF_NS }, x('get')))).rejects.toBeInstanceOf(TypeError);
    await s.close();
  });

  it('returns ok and data', async () => {
    const { s } = await open({ handler: (_r, { operation }) => (operation?.name === 'get' ? { data: x('a', '1') } : 'ok') });
    const ok = await s.session.rpc(x('lock'));
    expect(ok.ok).toBe(true);
    expect(ok.data).toBeUndefined();
    const data = await s.session.rpc(x('get'));
    expect(data.ok).toBe(false);
    expect(data.data!.child('a')!.text()).toBe('1');
    await s.close();
  });

  it('rejects with a fully parsed RpcError', async () => {
    const { s } = await open({
      handler: () => ({
        errors: [
          {
            type: 'protocol',
            tag: 'lock-denied',
            appTag: 'x-app',
            path: '/a/b',
            message: 'Lock held',
            info: [x('session-id', '17')],
          },
        ],
      }),
    });
    const err = (await s.ops.lock('running').catch((e: unknown) => e)) as RpcError;
    expect(err).toBeInstanceOf(RpcError);
    expect(err.tag).toBe('lock-denied');
    expect(err.message).toBe('lock-denied: Lock held (at /a/b)');
    expect(err.first).toMatchObject({ type: 'protocol', severity: 'error', appTag: 'x-app', path: '/a/b', messageLang: 'en' });
    expect(err.first.info!.child('session-id')!.text()).toBe('17');
    await s.close();
  });

  it('resolves replies that carry only warnings, and reports them', async () => {
    const { s } = await open({
      handler: () => ({
        body: [
          x('rpc-error',
            x('error-type', 'application'),
            x('error-tag', 'operation-failed'),
            x('error-severity', 'warning'),
            x('error-message', 'deprecated'),
          ),
          x('ok'),
        ],
      }),
    });
    const warnings: SessionWarning[] = [];
    s.session.on('warning', (w) => warnings.push(w));
    const reply = await s.session.rpc(x('get'));
    expect(reply.warnings).toHaveLength(1);
    expect(warnings[0]!.rpcError?.message).toBe('deprecated');
    await s.close();
  });

  it('attributes a message-id-less malformed-message error to the only pending RPC', async () => {
    const { s, server } = await open({ handler: () => undefined });
    const pending = s.session.rpc(x('get'));
    await new Promise((r) => setTimeout(r, 5));
    server.send(
      x('rpc-reply', { xmlns: NETCONF_NS },
        x('rpc-error', x('error-type', 'rpc'), x('error-tag', 'malformed-message'), x('error-severity', 'error'))),
    );
    await expect(pending).rejects.toMatchObject({ tag: 'malformed-message' });
    await s.close();
  });

  it('queues RPCs beyond maxInFlight', async () => {
    const held: ((r: RpcHandlerResult) => void)[] = [];
    const { s, server } = await open({ handler: () => new Promise((resolve) => held.push(resolve)) }, { maxInFlight: 1 });
    const a = s.session.rpc(x('get'));
    const b = s.session.rpc(x('get'));
    await new Promise((r) => setTimeout(r, 10));
    expect(server.requests).toHaveLength(1);
    held[0]!('ok');
    await a;
    await new Promise((r) => setTimeout(r, 10));
    expect(server.requests).toHaveLength(2);
    held[1]!('ok');
    await b;
    await s.close();
  });

  it('times out an RPC still waiting in the queue', async () => {
    const { s, server } = await open({ handler: () => undefined }, { maxInFlight: 1 });
    void s.session.rpc(x('get'), { timeout: 1000 }).catch(() => undefined);
    await expect(s.session.rpc(x('get'), { timeout: 20 })).rejects.toBeInstanceOf(TimeoutError);
    expect(server.requests).toHaveLength(1);
    await s.close();
  });

  it('stops waiting when the caller aborts', async () => {
    const { s } = await open({ handler: () => undefined });
    const ac = new AbortController();
    const pending = s.session.rpc(x('get'), { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
    await expect(s.session.rpc(x('get'), { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(AbortError);
    await s.close();
  });
});

describe('base operations', () => {
  it('get with a subtree filter', async () => {
    const { s, server } = await open({ handler: () => ({ data: x('interfaces', { xmlns: 'urn:if' }) }) });
    const data = await s.ops.get({ filter: subtree(x('interfaces', { xmlns: 'urn:if' })) });
    expect(data.name).toBe('data');
    expect(data.child('interfaces', 'urn:if')).toBeDefined();
    expect(sent(server)).toBe(`<get ${NC}><filter type="subtree"><interfaces xmlns="urn:if"/></filter></get>`);
    await s.close();
  });

  it('getConfig returns an empty <data> when the server sends none', async () => {
    const { s } = await open();
    const data = await s.ops.getConfig();
    expect(data.name).toBe('data');
    expect(data.children).toHaveLength(0);
    await s.close();
  });

  it('getConfig with an xpath filter declares its prefixes', async () => {
    const { s, server } = await open();
    await s.ops.getConfig({ source: 'candidate', filter: xpath('/if:interfaces', { if: 'urn:if' }) });
    expect(sent(server)).toBe(
      `<get-config ${NC}><source><candidate/></source>` +
        '<filter xmlns:if="urn:if" type="xpath" select="/if:interfaces"/></get-config>',
    );
    await s.close();
  });

  it('editConfig with options and an nc:operation attribute', async () => {
    const { s, server } = await open();
    await s.ops.editConfig({
      target: 'candidate',
      defaultOperation: 'none',
      testOption: 'test-then-set',
      errorOption: 'rollback-on-error',
      config: x('interfaces', { xmlns: 'urn:if' },
        x('interface', { operation: { ns: NETCONF_NS, prefix: 'nc', value: 'delete' } }, x('name', 'ge0'))),
    });
    expect(sent(server)).toBe(
      `<edit-config ${NC}><target><candidate/></target><default-operation>none</default-operation>` +
        '<test-option>test-then-set</test-option><error-option>rollback-on-error</error-option>' +
        `<config><interfaces xmlns="urn:if"><interface xmlns:nc="${NETCONF_NS}" nc:operation="delete">` +
        '<name>ge0</name></interface></interfaces></config></edit-config>',
    );
    await s.close();
  });

  it('editConfig needs exactly one of config and url', async () => {
    const { s } = await open();
    await expect(s.ops.editConfig({ target: 'running' })).rejects.toBeInstanceOf(TypeError);
    await expect(s.ops.editConfig({ target: 'running', config: x('a'), url: 'file://x' })).rejects.toBeInstanceOf(TypeError);
    await s.close();
  });

  it('copyConfig, deleteConfig, lock, unlock, validate, discardChanges, killSession', async () => {
    const { s, server } = await open();
    await s.ops.copyConfig({ source: 'running', target: 'startup' });
    await s.ops.copyConfig({ source: { config: x('a', { xmlns: 'urn:a' }) }, target: { url: 'file://backup.xml' } });
    await s.ops.deleteConfig('startup');
    await s.ops.lock('candidate');
    await s.ops.unlock('candidate');
    await s.ops.validate('candidate');
    await s.ops.discardChanges();
    await s.ops.killSession(9);
    expect(server.requests.map((_r, i) => sent(server, i))).toEqual([
      `<copy-config ${NC}><target><startup/></target><source><running/></source></copy-config>`,
      `<copy-config ${NC}><target><url>file://backup.xml</url></target><source><config><a xmlns="urn:a"/></config></source></copy-config>`,
      `<delete-config ${NC}><target><startup/></target></delete-config>`,
      `<lock ${NC}><target><candidate/></target></lock>`,
      `<unlock ${NC}><target><candidate/></target></unlock>`,
      `<validate ${NC}><source><candidate/></source></validate>`,
      `<discard-changes ${NC}/>`,
      `<kill-session ${NC}><session-id>9</session-id></kill-session>`,
    ]);
    await s.close();
  });

  it('commit variants', async () => {
    const { s, server } = await open();
    await s.ops.commit();
    await s.ops.commit({ confirmed: true, confirmTimeout: 120, persist: 'p1' });
    await s.ops.commit({ persistId: 'p1' });
    await s.ops.cancelCommit({ persistId: 'p1' });
    expect(server.requests.map((_r, i) => sent(server, i))).toEqual([
      `<commit ${NC}/>`,
      `<commit ${NC}><confirmed/><confirm-timeout>120</confirm-timeout><persist>p1</persist></commit>`,
      `<commit ${NC}><persist-id>p1</persist-id></commit>`,
      `<cancel-commit ${NC}><persist-id>p1</persist-id></cancel-commit>`,
    ]);
    await expect(s.ops.commit({ confirmed: true, confirmTimeout: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(s.ops.commit({ confirmTimeout: 60 })).rejects.toBeInstanceOf(TypeError);
    await s.close();
  });
});

describe('capability checks', () => {
  const bare = { capabilities: [BASE_1_0, BASE_1_1] };

  it.each([
    ['getConfig candidate', (s: NetconfClient) => s.ops.getConfig({ source: 'candidate' }), ':candidate'],
    ['editConfig running', (s: NetconfClient) => s.ops.editConfig({ target: 'running', config: x('a') }), ':writable-running'],
    ['xpath filter', (s: NetconfClient) => s.ops.get({ filter: xpath('/a') }), ':xpath'],
    ['commit', (s: NetconfClient) => s.ops.commit(), ':candidate'],
    ['validate', (s: NetconfClient) => s.ops.validate('running'), ':validate'],
    ['url target', (s: NetconfClient) => s.ops.copyConfig({ source: 'running', target: { url: 'file://x' } }), ':url'],
  ])('%s without its capability throws CapabilityError and sends nothing', async (_label, call, cap) => {
    const { s, server } = await open(bare);
    const err = await call(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).capability).toBe(cap);
    expect(server.requests).toHaveLength(0);
    await s.close();
  });

  it("sends anyway with capabilityCheck 'warn', and logs", async () => {
    const warned: string[] = [];
    const { s, server } = await open(bare, { capabilityCheck: 'warn', logger: { warn: (m) => warned.push(m) } });
    await s.ops.commit();
    expect(server.requests).toHaveLength(1);
    expect(warned[0]).toMatch(/:candidate/);
    await s.close();
  });
});

describe('notifications and events', () => {
  it('delivers notifications with eventTime and content', async () => {
    const { s, server } = await open();
    const got = new Promise<{ eventTime: string; name: string | undefined }>((resolve) =>
      s.session.once('notification', (n) => resolve({ eventTime: n.eventTime, name: n.event?.name })),
    );
    server.notify(x('link-down', { xmlns: 'urn:e' }), '2026-11-06T01:02:03Z');
    expect(await got).toEqual({ eventTime: '2026-11-06T01:02:03Z', name: 'link-down' });
    await s.close();
  });

  it('emits closing then closed on close(), and supports await using', async () => {
    const server = new FakeServer();
    const events: string[] = [];
    {
      await using s = await connect({ transport: server.transport() });
      s.session.on('closing', () => events.push('closing'));
      s.session.on('closed', ({ cause }) => events.push(cause ? 'closed-with-cause' : 'closed'));
    }
    expect(events).toEqual(['closing', 'closed']);
    expect(server.requests.at(-1)!.elements[0]!.name).toBe('close-session');
  });

  it('keeps going when a listener throws', async () => {
    const errors: string[] = [];
    const { s, server } = await open({}, { logger: { error: (m) => errors.push(m) } });
    s.session.on('notification', () => {
      throw new Error('listener bug');
    });
    let second = false;
    s.session.on('notification', () => (second = true));
    server.notify(x('e', { xmlns: 'urn:e' }));
    await s.session.rpc(x('get'));
    expect(second).toBe(true);
    expect(errors[0]).toMatch(/listener threw/);
    await s.close();
  });

  it('warns about stray messages without closing', async () => {
    const { s, server } = await open();
    const warnings: string[] = [];
    s.session.on('warning', (w) => warnings.push(w.message));
    server.send(x('surprise', { xmlns: 'urn:x' }));
    await s.session.rpc(x('get'));
    expect(warnings).toEqual(['Ignoring an unexpected <surprise> message']);
    expect(s.session.state).toBe('open');
    await s.close();
  });
});

describe('observability', () => {
  it('publishes RPC timings on the diagnostics channel', async () => {
    const seen: { phase: string; operation: string }[] = [];
    const onMessage = (m: unknown): void => {
      const { phase, operation } = m as { phase: string; operation: string };
      seen.push({ phase, operation });
    };
    diagnostics.subscribe(RPC_CHANNEL, onMessage);
    try {
      const { s } = await open();
      await s.ops.lock('running');
      await s.close();
    } finally {
      diagnostics.unsubscribe(RPC_CHANNEL, onMessage);
    }
    expect(seen.slice(0, 2)).toEqual([
      { phase: 'start', operation: 'lock' },
      { phase: 'end', operation: 'lock' },
    ]);
  });

  it('redacts secrets in trace logs', async () => {
    const logged: string[] = [];
    const logger: Logger = { trace: (_m, ctx) => logged.push(String(ctx?.['xml'])) };
    const { s } = await open({}, { logger });
    await s.ops.editConfig({
      target: 'running',
      config: x('user', { xmlns: 'urn:u' }, x('name', 'admin'), x('password', 'hunter2')),
    });
    await s.close();
    const all = logged.join('\n');
    expect(all).toContain('<name>admin</name>');
    expect(all).toContain('<password>***</password>');
    expect(all).not.toContain('hunter2');
  });
});
