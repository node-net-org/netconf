/**
 * a server that declares a prefix only on <rpc-reply> or
 * <notification>, and uses it in a value further down. The value keeps its
 * meaning in everything the client hands out: reply data and the elements
 * below it, the elements read() selects, JSON conversion, rpc-errors
 * (MESSAGES-08) and notification content (MESSAGES-15).
 */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BASE_1_0, BASE_1_1, connect, NETCONF_NS, parseXml, RpcError, x, type NetconfClient, type Notification } from '../../src/index.js';
import { FakeServer, type RpcHandler } from '../../src/testing/index.js';

const MODULES = fileURLToPath(new URL('../fixtures/yang/json/', import.meta.url));
const EJ = 'urn:example:json';
const EI = 'urn:example:ident';
const NOTIF = 'urn:ietf:params:xml:ns:netconf:notification:1.0';
const HELLO = [BASE_1_0, BASE_1_1, `${EJ}?module=ex-json&revision=2026-11-09`, `${EI}?module=ex-ident&revision=2026-11-09`];

/** A reply whose only declaration of `ei` is on <rpc-reply>. */
const reply = (id: string, body: string): string => `<rpc-reply message-id="${id}" xmlns="${NETCONF_NS}" xmlns:ei="${EI}">${body}</rpc-reply>`;
const DATA = `<data><top xmlns="${EJ}"><item><name>a</name><kind>ei:slow</kind></item></top></data>`;

/** Answer reads with DATA, and anything named `fail` with an rpc-error whose path uses a prefix declared only on <rpc-reply>. */
function server(): RpcHandler {
  return (_rpc, ctx) => {
    const op = ctx.operation?.name;
    if (op === 'get' || op === 'get-config') {
      ctx.server.send(reply(ctx.messageId!, DATA));
      return undefined;
    }
    if (op === 'fail') {
      ctx.server.send(
        reply(
          ctx.messageId!,
          `<rpc-error xmlns:ej="${EJ}"><error-type>application</error-type><error-tag>invalid-value</error-tag><error-severity>error</error-severity><error-path>/ej:top/ej:item[ej:name='a']/ej:kind</error-path><error-info><bad-kind>ei:slow</bad-kind></error-info></rpc-error>`,
        ),
      );
      return undefined;
    }
    return 'ok';
  };
}

let clients: NetconfClient[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

async function open(): Promise<{ fake: FakeServer; client: NetconfClient }> {
  const fake = new FakeServer({ capabilities: HELLO, handler: server() });
  const client = await connect({ transport: fake.transport(), yang: { modules: MODULES } });
  clients.push(client);
  return { fake, client };
}

describe('prefixes declared only on <rpc-reply>', () => {
  it('reply data, and any element below it, resolve the prefix', async () => {
    const { client } = await open();
    const data = await client.ops.getConfig();
    const item = data.child('top', EJ)!.child('item', EJ)!;
    expect(data.lookupNamespace('ei')).toBe(EI);
    expect(item.child('kind', EJ)!.lookupNamespace('ei')).toBe(EI);
    // written out on its own, the item still says what ei means
    expect(parseXml(item.toString()).child('kind', EJ)!.lookupNamespace('ei')).toBe(EI);
  });

  it('elements read() selects resolve the prefix', async () => {
    const { client } = await open();
    const [item] = await client.content.read('/ex-json:top/item[name="a"]', { format: 'xml' });
    expect(item!.name).toBe('item');
    expect(item!.child('kind', EJ)!.lookupNamespace('ei')).toBe(EI);
  });

  it('get-config as JSON types the identity, compiling the module the reply only names in a prefix', async () => {
    const { client } = await open();
    expect(await client.ops.getConfig({ format: 'json', json: { requireSchema: true } })).toEqual({
      'ex-json:top': { item: [{ name: 'a', kind: 'ex-ident:slow' }] },
    });
  });

  it('toJson() of reply data obtained as XML needs no scope', async () => {
    const { client } = await open();
    const data = await client.ops.getConfig();
    expect(await client.content.toJson(data, { datastore: 'running', requireSchema: true })).toEqual({
      'ex-json:top': { item: [{ name: 'a', kind: 'ex-ident:slow' }] },
    });
  });

  it('read() as JSON types the identity', async () => {
    const { client } = await open();
    expect(await client.content.readValue('/ex-json:top/item[name="a"]/kind', { json: { requireSchema: true } })).toBe('ex-ident:slow');
  });
});

describe('MESSAGES-08: rpc-error prefixes resolve in the error\'s scope', () => {
  it('the error path is read with the declarations in scope on its element, and info keeps the reply\'s prefixes', async () => {
    const { client } = await open();
    const err = await client.session.rpc(x('fail', { xmlns: 'urn:example:x' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    const first = (err as RpcError).first;
    expect(first.path).toBe("/ej:top/ej:item[ej:name='a']/ej:kind");
    expect(first.element.lookupNamespace('ej')).toBe(EJ);
    expect(first.info!.child('bad-kind')!.lookupNamespace('ei')).toBe(EI);
  });
});

describe('MESSAGES-15: notification content keeps the notification\'s prefixes', () => {
  it('a prefix declared on <notification> resolves from the event', async () => {
    const { fake, client } = await open();
    const got = new Promise<Notification>((resolve) => client.session.once('notification', resolve));
    fake.send(`<notification xmlns="${NOTIF}" xmlns:ei="${EI}"><eventTime>2026-11-12T00:00:00Z</eventTime><changed xmlns="urn:example:events"><kind>ei:slow</kind></changed></notification>`);
    const n = await got;
    expect(n.event!.child('kind')!.text()).toBe('ei:slow');
    expect(n.event!.child('kind')!.lookupNamespace('ei')).toBe(EI);
  });
});
