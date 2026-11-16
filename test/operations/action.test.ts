/**
 * YANG 1.1 actions and RPCs by path, against the fake
 * server: OPS-28 (client.ops.action, RpcReply.output, the action descriptor)
 * and CONTENT-14 (client.content.invoke, XML and JSON).
 */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AbortError,
  BASE_1_0,
  BASE_1_1,
  BASE_OPERATIONS,
  buildOperation,
  connect,
  NETCONF_NS,
  PathError,
  RpcError,
  SchemaUnavailableError,
  TimeoutError,
  serializeXml,
  x,
  YangDataError,
  type NetconfClient,
  type SessionWarning,
  type XmlElement,
} from '../../src/index.js';
import { compileProfile } from '../../src/devices/profile-spec.js';
import { FakeServer, type RpcHandler } from '../../src/testing/index.js';

const MODULES = fileURLToPath(new URL('../fixtures/yang/actions/', import.meta.url));
const ACT = 'urn:example:act';
const YANG = 'urn:ietf:params:xml:ns:yang:1';
const HELLO = [BASE_1_0, BASE_1_1, `${ACT}?module=ex-act&revision=2026-11-15`];

let clients: NetconfClient[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

/** Answers reset with output, ping with ok, restart with output, and anything else with ok. */
const handler: RpcHandler = (_rpc, ctx) => {
  const op = ctx.operation!;
  if (op.name === 'action' && op.ns === YANG) {
    const server = op.child('servers', ACT)?.child('server', ACT);
    if (server?.child('name', ACT)?.text() === 'missing') return { errors: [{ type: 'application', tag: 'data-missing', message: 'No such server' }] };
    if (server?.child('reset', ACT) !== undefined) {
      return { body: [x('finished-at', { xmlns: ACT }, '2026-11-15T04:40:00Z'), x('attempts', { xmlns: ACT }, '2')] };
    }
    return 'ok';
  }
  if (op.name === 'restart' && op.ns === ACT) return { body: [x('when', { xmlns: ACT }, 'now')] };
  return 'ok';
};

async function open(options: { readonly requireSchema?: boolean; readonly modules?: boolean } = {}) {
  const fake = new FakeServer({ capabilities: HELLO, handler });
  const client = await connect({
    transport: fake.transport(),
    yang: { ...(options.modules === false ? {} : { modules: MODULES }), ...(options.requireSchema ? { requireSchema: true } : {}) },
  });
  clients.push(client);
  const warnings: SessionWarning[] = [];
  client.session.on('warning', (w) => warnings.push(w));
  return { fake, client, warnings };
}

const last = (fake: FakeServer): XmlElement => fake.requests[fake.requests.length - 1]!.elements[0]!;
const xml = (el: XmlElement): string => serializeXml(el);

describe('OPS-28: client.ops.action and RpcReply.output', () => {
  it('sends one <action> in the YANG 1.1 namespace wrapping the target tree, and resolves with the reply', async () => {
    const { fake, client } = await open();
    const target = x('servers', { xmlns: ACT }, x('server', x('name', 'a'), x('reset', x('delay', '3'))));
    const reply = await client.ops.action(target);
    const sent = last(fake);
    expect(sent.name).toBe('action');
    expect(sent.ns).toBe(YANG);
    expect(sent.elements.map(xml)).toEqual([xml(target)]);
    expect(reply.output.map((e) => [e.name, e.text()])).toEqual([
      ['finished-at', '2026-11-15T04:40:00Z'],
      ['attempts', '2'],
    ]);
    expect(reply.ok).toBe(false);
  });

  it('gives every reply an output: empty for <ok/>, [<data>] for get', async () => {
    const { client } = await open();
    const ping = await client.ops.action(x('servers', { xmlns: ACT }, x('server', x('name', 'a'), x('ping'))));
    expect(ping.ok).toBe(true);
    expect(ping.output).toEqual([]);
    const reply = await client.session.rpc(x('get', { xmlns: NETCONF_NS }));
    expect(reply.output.map((e) => e.name)).toEqual(reply.data === undefined ? [] : ['data']);
  });

  it('converts a JSON target tree with the schema before anything is sent', async () => {
    const { fake, client } = await open();
    await client.ops.action({ 'ex-act:servers': { server: [{ name: 'a', reset: { delay: 3 } }] } });
    expect(xml(last(fake).elements[0]!)).toBe(
      xml(x('servers', { xmlns: ACT }, x('server', x('name', 'a'), x('reset', x('delay', '3'))))),
    );
  });

  it('rejects a JSON target that breaks the schema before sending, and never sends json options', async () => {
    const { fake, client } = await open();
    const before = fake.requests.length;
    await expect(client.ops.action({ 'ex-act:servers': { server: [{ name: 'a', reset: { delay: 99 } }] } })).rejects.toBeInstanceOf(YangDataError);
    expect(fake.requests.length).toBe(before);
    await client.ops.action({ 'ex-act:servers': { server: [{ name: 'a', ping: {} }] } }, { json: { requireSchema: true } });
    expect(last(fake).elements[0]!.attributes).toEqual([]);
  });

  it('refuses a JSON target of more than one member or with no module name, before sending', async () => {
    const { fake, client } = await open();
    const before = fake.requests.length;
    await expect(client.ops.action({ 'ex-act:servers': {}, 'ex-act:other': {} })).rejects.toThrow(TypeError);
    await expect(client.ops.action({ servers: { server: [{ name: 'a', ping: {} }] } })).rejects.toThrow(TypeError);
    expect(fake.requests.length).toBe(before);
  });

  it('sends a JSON target schema-less with a warning when there is no schema, or refuses with requireSchema', async () => {
    const loose = await open({ modules: false });
    await loose.client.ops.action({ 'ex-act:servers': { server: [{ name: 'a', ping: {} }] } });
    expect(xml(last(loose.fake).elements[0]!)).toBe(xml(x('servers', { xmlns: ACT }, x('server', x('name', 'a'), x('ping')))));
    expect(loose.warnings.some((w) => /action target was sent without a YANG schema/.test(w.message))).toBe(true);
    const strict = await open({ modules: false, requireSchema: true });
    await expect(strict.client.ops.action({ 'ex-act:servers': { server: [{ name: 'a', ping: {} }] } })).rejects.toBeInstanceOf(SchemaUnavailableError);
  });

  it('refuses a target that is neither an element nor a JSON object, before sending', async () => {
    const { fake, client } = await open();
    const before = fake.requests.length;
    await expect(client.ops.action('<servers/>' as never)).rejects.toThrow(TypeError);
    await expect(client.ops.action([x('servers', { xmlns: ACT })] as never)).rejects.toThrow(TypeError);
    expect(fake.requests.length).toBe(before);
  });

  it('rejects an rpc-error with an RpcError carrying its details', async () => {
    const { client } = await open();
    const err = await client.ops.action(x('servers', { xmlns: ACT }, x('server', x('name', 'missing'), x('ping')))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).errors.map((e) => e.tag)).toEqual(['data-missing']);
  });

  it('is the action descriptor: changes state, needs no capability, one required target; run() sends the same request', async () => {
    const d = BASE_OPERATIONS.find((o) => o.name === 'action')!;
    expect(d).toMatchObject({ namespace: YANG, method: 'action', mutates: true, requires: [] });
    expect(d.params.map((p) => [p.name, p.kind, p.type, p.required])).toEqual([['target', 'positional', 'xml', true]]);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    const target = x('servers', { xmlns: ACT }, x('server', x('name', 'a'), x('ping')));
    expect(xml(buildOperation('action', { target }).element)).toBe(xml(x('action', { xmlns: YANG }, target)));

    const { fake, client } = await open();
    expect(client.ops.list.some((o) => o.name === 'action')).toBe(true);
    await client.ops.run('action', { target });
    const viaRun = xml(last(fake));
    await client.ops.action(target);
    expect(xml(last(fake))).toBe(viaRun);
    await client.ops.run('action', { target: { 'ex-act:servers': { server: [{ name: 'a', ping: {} }] } } });
    expect(xml(last(fake))).toBe(viaRun);
  });
});

describe('CONTENT-14: client.content.invoke', () => {
  it('invokes an action by path with JSON input and resolves with typed JSON output', async () => {
    const { fake, client } = await open();
    const out = await client.content.invoke('/ex-act:servers/server[name="a"]/reset', { delay: 3 });
    expect(out).toEqual({ 'finished-at': '2026-11-15T04:40:00Z', attempts: 2 });
    expect(xml(last(fake))).toBe(
      xml(x('action', { xmlns: YANG }, x('servers', { xmlns: ACT }, x('server', x('name', 'a'), x('reset', x('delay', '3')))))),
    );
  });

  it('invokes an RPC by a one-step path, sending the operation element itself', async () => {
    const { fake, client } = await open();
    expect(await client.content.invoke('/ex-act:restart', { after: 10 })).toEqual({ when: 'now' });
    expect(xml(last(fake))).toBe(xml(x('restart', { xmlns: ACT }, x('after', '10'))));
  });

  it('takes XML input and gives XML output with format xml; no input sends no parameters', async () => {
    const { fake, client } = await open();
    const out = await client.content.invoke('/ex-act:servers/server[name="a"]/reset', [x('delay', { xmlns: ACT }, '5')], { format: 'xml' });
    expect(out.map((e) => e.name)).toEqual(['finished-at', 'attempts']);
    expect(last(fake).child('servers', ACT)!.child('server', ACT)!.child('reset', ACT)!.child('delay', ACT)!.text()).toBe('5');
    expect(await client.content.invoke('/ex-act:servers/server[name="b"]/ping', undefined, { format: 'xml' })).toEqual([]);
    expect(await client.content.invoke('/ex-act:servers/server[name="b"]/ping')).toEqual({});
    expect(last(fake).child('servers', ACT)!.child('server', ACT)!.child('ping', ACT)!.elements).toEqual([]);
  });

  it('refuses a last step with a predicate, bad input and an unknown module, before sending', async () => {
    const { fake, client } = await open();
    const before = fake.requests.length;
    await expect(client.content.invoke('/ex-act:servers/server[name="a"]')).rejects.toThrow(TypeError);
    await expect(client.content.invoke('/ex-act:restart', 'after' as never)).rejects.toThrow(TypeError);
    await expect(client.content.invoke('/nope:restart')).rejects.toBeInstanceOf(PathError);
    await expect(client.content.invoke('/ex-act:restart', { after: 'soon' })).rejects.toBeInstanceOf(YangDataError);
    expect(fake.requests.length).toBe(before);
  });

  it('falls back to schema-less output with a warning, or rejects with requireSchema', async () => {
    const loose = await open({ modules: false });
    expect(await loose.client.content.invoke('/ex-act:restart', [x('after', { xmlns: ACT }, '1')])).toEqual({ when: 'now' });
    expect(loose.warnings.some((w) => /without a YANG schema/.test(w.message))).toBe(true);
    const strict = await open({ modules: false, requireSchema: true });
    await expect(strict.client.content.invoke('/ex-act:restart', [x('after', { xmlns: ACT }, '1')])).rejects.toBeInstanceOf(SchemaUnavailableError);
  });

  it('JSON input: schema-less with a warning without a schema, or with validate off when it mismatches; refused with requireSchema', async () => {
    const loose = await open({ modules: false });
    await loose.client.content.invoke('/ex-act:restart', { after: 1 }, { format: 'xml' });
    expect(xml(last(loose.fake))).toBe(xml(x('restart', { xmlns: ACT }, x('after', '1'))));
    expect(loose.warnings.some((w) => /operation input was sent without a YANG schema/.test(w.message))).toBe(true);
    const strict = await open({ modules: false, requireSchema: true });
    await expect(strict.client.content.invoke('/ex-act:restart', { after: 1 })).rejects.toBeInstanceOf(SchemaUnavailableError);
    const typed = await open();
    await typed.client.content.invoke('/ex-act:restart', { after: 'soon' }, { json: { validate: false } });
    expect(xml(last(typed.fake))).toBe(xml(x('restart', { xmlns: ACT }, x('after', 'soon'))));
    expect(typed.warnings.some((w) => /validate is off/.test(w.message))).toBe(true);
  });

  it('output that does not match the schema is converted schema-less with a warning', async () => {
    const fake = new FakeServer({ capabilities: HELLO, handler: () => ({ body: [x('when', { xmlns: ACT }, 'now'), x('bogus', { xmlns: ACT }, '1')] }) });
    const client = await connect({ transport: fake.transport(), yang: { modules: MODULES } });
    clients.push(client);
    const warnings: SessionWarning[] = [];
    client.session.on('warning', (w) => warnings.push(w));
    expect(await client.content.invoke('/ex-act:restart')).toEqual({ when: 'now', bogus: '1' });
    expect(warnings.some((w) => /doesn't match the schema/.test(w.message))).toBe(true);
  });

  it('rejects an rpc-error with an RpcError', async () => {
    const { client } = await open();
    await expect(client.content.invoke('/ex-act:servers/server[name="missing"]/ping')).rejects.toBeInstanceOf(RpcError);
  });

  it("takes a device profile's named path, with its parameters", async () => {
    const fake = new FakeServer({ capabilities: HELLO, handler });
    const profile = compileProfile({ id: 'p', paths: { reset: '/ex-act:servers/server[name={{server}}]/reset' } }).profile;
    const client = await connect({ transport: fake.transport(), profile, yang: { modules: MODULES } });
    clients.push(client);
    expect(await client.content.invoke('@reset(b)', { delay: 1 })).toEqual({ 'finished-at': '2026-11-15T04:40:00Z', attempts: 2 });
    expect(last(fake).child('servers', ACT)!.child('server', ACT)!.child('name', ACT)!.text()).toBe('b');
    // An action path needs every key: a parameter left out is refused before sending.
    await expect(client.content.invoke('@reset', { delay: 1 })).rejects.toBeInstanceOf(PathError);
  });

  it('applies the per-call signal and timeout', async () => {
    const fake = new FakeServer({ capabilities: HELLO, handler: () => undefined });
    const client = await connect({ transport: fake.transport(), yang: { modules: MODULES } });
    clients.push(client);
    const controller = new AbortController();
    const pending = client.content.invoke('/ex-act:restart', [x('after', { xmlns: ACT }, '1')], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
    await expect(client.content.invoke('/ex-act:restart', [x('after', { xmlns: ACT }, '1')], { timeout: 20 })).rejects.toBeInstanceOf(TimeoutError);
  });
});
