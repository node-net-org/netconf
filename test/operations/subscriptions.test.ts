/**
 * The RFC 8639/8640/8641 subscriptions extension (OPS-23), against the fake
 * server: request shapes, local refusals, routing (including notifications
 * that arrive before the establish reply), endings and decoding. The
 * netopeer2 integration test covers the real server's behaviour.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_1_0,
  BASE_1_1,
  CapabilityError,
  connect,
  NETCONF_NS,
  ProtocolError,
  RpcError,
  serializeXml,
  subtree,
  x,
  xpath,
  type NetconfClient,
  type XmlElement,
} from '../../src/index.js';
import { notifications } from '../../src/operations/notifications.js';
import {
  deleteSubscriptionRequest,
  establishSubscriptionRequest,
  killSubscriptionRequest,
  modifySubscriptionRequest,
  resyncSubscriptionRequest,
  STOP_GRACE_MS,
  SUBSCRIBED_NOTIFICATIONS_NS,
  subscriptionErrorReason,
  SubscriptionError,
  SubscriptionOverflowError,
  subscriptions,
  YANG_PUSH_NS,
  type DynamicSubscription,
  type SubscriptionUpdate,
} from '../../src/operations/subscriptions.js';
import { FakeServer, type RpcHandler } from '../../src/testing/index.js';

const SN = SUBSCRIBED_NOTIFICATIONS_NS;
const YP = YANG_PUSH_NS;
const DS = 'urn:ietf:params:xml:ns:yang:ietf-datastores';
const YL = 'urn:ietf:params:xml:ns:yang:ietf-yang-library';
const NCN = 'urn:ietf:params:xml:ns:yang:ietf-netconf-notifications';
const EX = 'urn:example:sub';
const SN_CAP = `${SN}?module=ietf-subscribed-notifications&revision=2019-09-09&features=replay,subtree,xpath`;
const YP_CAP = `${YP}?module=ietf-yang-push&revision=2019-09-09&features=on-change`;
const NOTIF_CAP = 'urn:ietf:params:netconf:capability:notification:1.0';
const CAPS = [BASE_1_0, BASE_1_1, NOTIF_CAP, 'urn:ietf:params:netconf:capability:interleave:1.0', SN_CAP, YP_CAP];

const idReply = (id: number) => ({ body: [x('id', { xmlns: SN }, String(id))] });

/** A server that numbers establish replies from `first`, and answers everything else with ok. */
function numbering(first = 7, before?: (id: number, fake: FakeServer, op: XmlElement) => void): RpcHandler {
  let next = first;
  return (_rpc, { operation, server }) => {
    if (operation?.name === 'establish-subscription') {
      const id = next++;
      before?.(id, server, operation);
      return idReply(id);
    }
    return 'ok';
  };
}

let clients: NetconfClient[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  clients = [];
});
async function open(handler: RpcHandler = numbering(), capabilities = CAPS, extra: { capabilityCheck?: 'strict' | 'warn' | 'off' } = {}) {
  const fake = new FakeServer({ capabilities, handler, sessionId: 4 });
  const client = await connect({ transport: fake.transport(), extensions: [subscriptions, notifications], ...extra });
  clients.push(client);
  return { fake, client, ext: client.ops.subscriptions, content: client.content.subscriptions };
}

const ops = (fake: FakeServer): string[] => fake.requests.map((r) => r.elements[0]!.name);
const lastOp = (fake: FakeServer): XmlElement => fake.requests.at(-1)!.elements[0]!;
const tick = () => new Promise((r) => setImmediate(r));
const sn = (name: string, id: number, ...rest: XmlElement[]) => x(name, { xmlns: SN }, x('id', String(id)), ...rest);
const pushUpdate = (id: number, ...data: XmlElement[]) => x('push-update', { xmlns: YP }, x('id', String(id)), x('datastore-contents', data));
const event = (leaf = 'v') => x('thing-happened', { xmlns: EX }, x('leaf', leaf));

async function take(sub: DynamicSubscription, n: number): Promise<SubscriptionUpdate[]> {
  const out: SubscriptionUpdate[] = [];
  while (out.length < n) {
    const r = await sub.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

describe('subscriptions extension (OPS-23)', () => {
  describe('request builders', () => {
    it('builds a stream establish with filter, replay and stop-time', () => {
      const req = establishSubscriptionRequest({
        stream: 'NETCONF',
        filter: xpath('/ncn:netconf-config-change', { ncn: NCN }),
        replayStartTime: new Date('2026-01-01T00:00:00Z'),
        stopTime: '2026-12-31T00:00:00Z',
      });
      expect(serializeXml(req.element)).toBe(
        `<establish-subscription xmlns="${SN}"><stream>NETCONF</stream>` +
          `<stream-xpath-filter xmlns:ncn="${NCN}">/ncn:netconf-config-change</stream-xpath-filter>` +
          '<replay-start-time>2026-01-01T00:00:00.000Z</replay-start-time><stop-time>2026-12-31T00:00:00Z</stop-time>' +
          '</establish-subscription>',
      );
      expect(serializeXml(establishSubscriptionRequest({ stream: 'NETCONF', filter: subtree(x('a', { xmlns: EX })) }).element)).toContain(
        `<stream-subtree-filter><a xmlns="${EX}"/></stream-subtree-filter>`,
      );
    });

    it('builds YANG-Push periodic and on-change establishes', () => {
      expect(serializeXml(establishSubscriptionRequest({ datastore: 'operational', filter: subtree(x('a', { xmlns: EX })), periodic: { period: 500, anchorTime: '2026-01-01T00:00:00Z' } }).element)).toBe(
        `<establish-subscription xmlns="${SN}"><datastore xmlns:ds="${DS}" xmlns="${YP}">ds:operational</datastore>` +
          `<datastore-subtree-filter xmlns="${YP}"><a xmlns="${EX}"/></datastore-subtree-filter>` +
          `<periodic xmlns="${YP}"><period>500</period><anchor-time>2026-01-01T00:00:00Z</anchor-time></periodic></establish-subscription>`,
      );
      expect(serializeXml(establishSubscriptionRequest({ datastore: 'running', onChange: { dampeningPeriod: 0, syncOnStart: false, excludedChanges: ['delete', 'delete', 'move'] } }).element)).toBe(
        `<establish-subscription xmlns="${SN}"><datastore xmlns:ds="${DS}" xmlns="${YP}">ds:running</datastore>` +
          `<on-change xmlns="${YP}"><dampening-period>0</dampening-period><sync-on-start>false</sync-on-start>` +
          '<excluded-change>delete</excluded-change><excluded-change>move</excluded-change></on-change></establish-subscription>',
      );
      // Descriptor-style flat arguments build the same request.
      expect(serializeXml(establishSubscriptionRequest({ datastore: 'running', onChange: true, dampeningPeriod: 0, syncOnStart: false, excludedChange: ['delete', 'move'] }).element)).toBe(
        serializeXml(establishSubscriptionRequest({ datastore: 'running', onChange: { dampeningPeriod: 0, syncOnStart: false, excludedChanges: ['delete', 'move'] } }).element),
      );
      expect(serializeXml(establishSubscriptionRequest({ datastore: 'running', period: 100 }).element)).toContain('<period>100</period>');
    });

    it('refuses bad arguments with TypeError', () => {
      const bad: [Record<string, unknown>, RegExp][] = [
        [{}, /give a stream or a datastore/],
        [{ stream: 'NETCONF', datastore: 'running' }, /give a stream or a datastore/],
        [{ stream: '' }, /stream must be a name/],
        [{ stream: 'NETCONF', periodic: { period: 10 } }, /for datastore subscriptions/],
        [{ datastore: 'running' }, /needs periodic or onChange/],
        [{ datastore: 'running', periodic: { period: 10 }, onChange: {} }, /needs periodic or onChange/],
        [{ datastore: 'running', periodic: { period: 0 } }, /period must be a whole number of centiseconds from 1/],
        [{ datastore: 'running', periodic: { period: 1.5 } }, /period must be/],
        [{ datastore: 'running', periodic: {} }, /needs a period/],
        [{ datastore: 'running', onChange: { dampeningPeriod: -1 } }, /dampeningPeriod must be/],
        [{ datastore: 'running', onChange: { excludedChanges: ['merge'] } }, /excludedChanges must list/],
        [{ datastore: 'running', onChange: { syncOnStart: 'yes' } }, /syncOnStart must be a boolean/],
        [{ datastore: 'scratch', periodic: { period: 10 } }, /Unknown datastore/],
        [{ datastore: 'running', periodic: { period: 10 }, replayStartTime: new Date() }, /replayStartTime is for stream/],
        [{ stream: 'NETCONF', replayStartTime: 'yesterday' }, /replayStartTime must be a Date or an RFC 3339 string/],
        [{ stream: 'NETCONF', replayStartTime: '2026-02-01T00:00:00Z', stopTime: '2026-01-01T00:00:00Z' }, /stopTime must be later/],
        [{ stream: 'NETCONF', filter: { type: 'other' } }, /filter must be subtree/],
        [{ stream: 'NETCONF', filter: xpath(' ') }, /XPath filter is empty/],
      ];
      for (const [args, message] of bad) expect(() => establishSubscriptionRequest(args), JSON.stringify(args)).toThrow(message);
    });

    it('builds modify, delete, kill and resync, and refuses a stream modify without a filter', () => {
      expect(serializeXml(modifySubscriptionRequest({ id: 3, filter: subtree(x('a', { xmlns: EX })), stopTime: '2026-01-01T00:00:00Z' }).element)).toBe(
        `<modify-subscription xmlns="${SN}"><id>3</id><stream-subtree-filter><a xmlns="${EX}"/></stream-subtree-filter><stop-time>2026-01-01T00:00:00Z</stop-time></modify-subscription>`,
      );
      expect(() => modifySubscriptionRequest({ id: 3, stopTime: '2026-01-01T00:00:00Z' })).toThrow(/needs a filter/);
      expect(serializeXml(modifySubscriptionRequest({ id: 3, datastore: 'operational', period: 50 }).element)).toBe(
        `<modify-subscription xmlns="${SN}"><id>3</id><datastore xmlns:ds="${DS}" xmlns="${YP}">ds:operational</datastore><periodic xmlns="${YP}"><period>50</period></periodic></modify-subscription>`,
      );
      expect(() => modifySubscriptionRequest({ id: 3, datastore: 'running', period: 5, dampeningPeriod: 5 })).toThrow(/not both/);
      expect(serializeXml(deleteSubscriptionRequest({ id: 9 }).element)).toBe(`<delete-subscription xmlns="${SN}"><id>9</id></delete-subscription>`);
      expect(serializeXml(killSubscriptionRequest({ id: 9 }).element)).toBe(`<kill-subscription xmlns="${SN}"><id>9</id></kill-subscription>`);
      expect(serializeXml(resyncSubscriptionRequest({ id: 9 }).element)).toBe(`<resync-subscription xmlns="${YP}"><id>9</id></resync-subscription>`);
      for (const id of [-1, 1.5, 2 ** 32, '9', undefined]) expect(() => killSubscriptionRequest({ id }), String(id)).toThrow(/id must be an integer/);
    });
  });

  describe('support', () => {
    it('reads support from the hello when the modules are listed there, without a request', async () => {
      const { fake, content } = await open();
      expect(await content.support()).toEqual({
        subscribedNotifications: { revision: '2019-09-09', features: ['replay', 'subtree', 'xpath'] },
        yangPush: { revision: '2019-09-09', features: ['on-change'] },
      });
      expect(fake.requests).toHaveLength(0);
    });

    it('reads the YANG library once when the hello does not list them', async () => {
      const library = x('yang-library', { xmlns: YL },
        x('module-set', x('name', 'all'),
          x('module', x('name', 'ietf-subscribed-notifications'), x('revision', '2019-09-09'), x('namespace', SN), x('feature', 'subtree')),
          x('module', x('name', 'ietf-yang-push'), x('revision', '2019-09-09'), x('namespace', YP)),
        ),
        x('content-id', '1'),
      );
      const handler: RpcHandler = (rpc, ctx) => (ctx.operation?.name === 'get' ? { data: library } : numbering()(rpc, ctx));
      const { fake, ext, content } = await open(handler, [BASE_1_0, BASE_1_1, NOTIF_CAP, 'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=1']);
      const s = await content.support();
      expect(s.subscribedNotifications?.features).toEqual(['subtree']);
      expect(s.yangPush?.features).toEqual([]);
      await content.support();
      expect(ops(fake)).toEqual(['get']);
      // on-change isn't a yang-push feature here, and replay isn't an sn one: both refused before sending.
      await expect(ext.establish({ datastore: 'running', onChange: {} })).rejects.toThrow(CapabilityError);
      await expect(ext.establish({ stream: 'NETCONF', replayStartTime: new Date() })).rejects.toThrow(/feature replay/);
      await expect(ext.establish({ stream: 'NETCONF', filter: xpath('/a') })).rejects.toThrow(/feature xpath/);
      expect(ops(fake)).toEqual(['get']);
    });

    it('refuses before sending when the server reports neither module, unless capabilityCheck says otherwise', async () => {
      const strict = await open(numbering(), [BASE_1_0, BASE_1_1, NOTIF_CAP]);
      await expect(strict.ext.establish({ stream: 'NETCONF' })).rejects.toThrow(CapabilityError);
      await expect(strict.ext.establish({ datastore: 'running', periodic: { period: 100 } })).rejects.toThrow(CapabilityError);
      expect(strict.fake.requests).toHaveLength(0);

      const off = await open(numbering(), [BASE_1_0, BASE_1_1, NOTIF_CAP], { capabilityCheck: 'off' });
      const sub = await off.ext.establish({ stream: 'NETCONF' });
      expect(sub.id).toBe(7);
      expect(ops(off.fake)).toEqual(['establish-subscription']);
    });
  });

  describe('routing', () => {
    it('delivers notifications sent before the establish reply (replay-completed, push-update)', async () => {
      const { ext } = await open(
        numbering(7, (id, fake, op) => {
          if (op.child('stream', SN) !== undefined) {
            fake.notify(event('replayed'));
            fake.notify(sn('replay-completed', id));
          } else {
            fake.notify(pushUpdate(id, x('top', { xmlns: EX }, 'initial')));
          }
        }),
      );
      const stream = await ext.establish({ stream: 'NETCONF', replayStartTime: new Date(0) });
      await expect(stream.replayComplete).resolves.toBe(true);
      const [replayed] = await take(stream, 1);
      expect(replayed).toMatchObject({ type: 'event' });
      expect((replayed as Extract<SubscriptionUpdate, { type: 'event' }>).notification.event?.child('leaf', EX)?.text()).toBe('replayed');

      const ds = await ext.establish({ datastore: 'operational', onChange: {} });
      const [first] = await take(ds, 1);
      expect(first).toMatchObject({ type: 'push-update', incomplete: false });
      expect((first as Extract<SubscriptionUpdate, { type: 'push-update' }>).contents.child('top', EX)?.text()).toBe('initial');
    });

    it('routes by id: each datastore subscription gets only its own updates; unknown ids are dropped', async () => {
      const { fake, ext } = await open();
      const a = await ext.establish({ datastore: 'running', periodic: { period: 100 } });
      const b = await ext.establish({ datastore: 'operational', periodic: { period: 100 } });
      expect([a.id, b.id]).toEqual([7, 8]);
      fake.notify(pushUpdate(8, x('b', { xmlns: EX })));
      fake.notify(pushUpdate(99, x('nobody', { xmlns: EX })));
      fake.notify(pushUpdate(7, x('a', { xmlns: EX })));
      const [fromA] = await take(a, 1);
      const [fromB] = await take(b, 1);
      expect((fromA as Extract<SubscriptionUpdate, { type: 'push-update' }>).contents.elements[0]!.name).toBe('a');
      expect((fromB as Extract<SubscriptionUpdate, { type: 'push-update' }>).contents.elements[0]!.name).toBe('b');
      expect([...ext.active.keys()]).toEqual([7, 8]);
    });

    it('gives id-less event records to the stream subscription, not to datastore ones', async () => {
      const { fake, ext } = await open();
      const ds = await ext.establish({ datastore: 'running', periodic: { period: 100 } });
      const stream = await ext.establish({ stream: 'NETCONF' });
      fake.notify(event('one'));
      fake.notify(pushUpdate(ds.id, x('d', { xmlns: EX })));
      expect(await take(stream, 1)).toMatchObject([{ type: 'event' }]);
      expect(await take(ds, 1)).toMatchObject([{ type: 'push-update' }]);
    });

    it('decodes push-change-update as a YANG Patch, and drops a malformed one', async () => {
      const { fake, ext } = await open();
      const sub = await ext.establish({ datastore: 'running', onChange: {} });
      const PATCH = 'urn:ietf:params:xml:ns:yang:ietf-yang-patch';
      fake.notify(x('push-change-update', { xmlns: YP }, x('id', String(sub.id)), x('datastore-changes')));
      fake.notify(
        x('push-change-update', { xmlns: YP }, x('id', String(sub.id)),
          x('datastore-changes', x('yang-patch', { xmlns: PATCH },
            x('patch-id', 'p1'),
            x('edit', x('edit-id', 'e1'), x('operation', 'create'), x('target', "/ex:top/item[name='a']"), x('value', x('item', { xmlns: EX }, x('name', 'a')))),
            x('edit', x('edit-id', 'e2'), x('operation', 'insert'), x('target', "/ex:top/item[name='b']"), x('point', "/ex:top/item[name='a']"), x('where', 'after')),
          )),
          x('incomplete-update'),
        ),
      );
      const [update] = await take(sub, 1);
      expect(update).toMatchObject({
        type: 'push-change-update',
        incomplete: true,
        patch: {
          patchId: 'p1',
          edits: [
            { editId: 'e1', operation: 'create', target: "/ex:top/item[name='a']" },
            { editId: 'e2', operation: 'insert', target: "/ex:top/item[name='b']", point: "/ex:top/item[name='a']", where: 'after', value: [] },
          ],
        },
      });
      expect((update as Extract<SubscriptionUpdate, { type: 'push-change-update' }>).patch.edits[0]!.value[0]!.name).toBe('item');
    });

    it('delivers suspended and resumed in-band, and ignores subscription-modified', async () => {
      const { fake, ext } = await open();
      const sub = await ext.establish({ datastore: 'running', periodic: { period: 100 } });
      fake.notify(sn('subscription-suspended', sub.id, x('reason', { 'xmlns:sn': SN }, 'sn:insufficient-resources')));
      fake.notify(sn('subscription-modified', sub.id));
      fake.notify(sn('subscription-resumed', sub.id));
      expect(await take(sub, 2)).toMatchObject([{ type: 'suspended', reason: 'ietf-subscribed-notifications:insufficient-resources' }, { type: 'resumed' }]);
    });
  });

  describe('rules', () => {
    it('refuses a second stream subscription, even one started concurrently, before sending', async () => {
      const { fake, ext } = await open();
      const first = ext.establish({ stream: 'NETCONF' });
      await expect(ext.establish({ stream: 'other' })).rejects.toThrow(SubscriptionError);
      await first;
      await expect(ext.establish({ stream: 'NETCONF' })).rejects.toThrow(/carry no subscription id/);
      expect(ops(fake)).toEqual(['establish-subscription']);
      // Datastore subscriptions are not limited.
      await ext.establish({ datastore: 'running', periodic: { period: 100 } });
    });

    it('allows a new stream subscription once the old one has ended', async () => {
      const { ext } = await open();
      const first = await ext.establish({ stream: 'NETCONF' });
      await first.delete();
      await expect(ext.establish({ stream: 'NETCONF' })).resolves.toMatchObject({ id: 8 });
    });

    it('refuses create-subscription after establish-subscription, and the reverse, on one session', async () => {
      const a = await open();
      await a.ext.establish({ datastore: 'running', periodic: { period: 100 } });
      await expect(a.client.ops.notifications.createSubscription()).rejects.toThrow(SubscriptionError);
      expect(ops(a.fake)).toEqual(['establish-subscription']);

      const b = await open();
      await b.client.ops.notifications.createSubscription();
      await expect(b.ext.establish({ stream: 'NETCONF' })).rejects.toThrow(/RFC 5277/);
      await expect(b.client.ops.run('establish-subscription', { stream: 'NETCONF' })).rejects.toThrow(SubscriptionError);
      expect(ops(b.fake)).toEqual(['create-subscription']);
    });
  });

  describe('endings', () => {
    it('delete() sends delete-subscription and ends as deleted, even when subscription-terminated arrives first', async () => {
      const { fake, ext } = await open((rpc, ctx) => {
        if (ctx.operation?.name === 'delete-subscription') {
          ctx.server.notify(sn('subscription-terminated', 7, x('reason', { 'xmlns:sn': SN }, 'sn:no-such-subscription')));
        }
        return numbering()(rpc, ctx);
      });
      const sub = await ext.establish({ stream: 'NETCONF' });
      await Promise.all([sub.delete(), sub.delete()]);
      await sub.delete();
      expect(await sub.ended).toEqual({ reason: 'deleted' });
      expect(ops(fake).filter((o) => o === 'delete-subscription')).toHaveLength(1);
      expect(ext.active.size).toBe(0);
      await expect(sub.modify({ filter: subtree(x('a', { xmlns: EX })) })).rejects.toThrow(/has ended \(deleted\)/);
    });

    it('treats a no-such-subscription refusal of delete as deleted, and passes on other refusals', async () => {
      let tag = 'no-such-subscription';
      const { ext } = await open((rpc, ctx) =>
        ctx.operation?.name === 'delete-subscription'
          ? { errors: [{ type: 'application', tag: 'invalid-value', appTag: `ietf-subscribed-notifications:${tag}` }] }
          : numbering()(rpc, ctx),
      );
      const gone = await ext.establish({ datastore: 'running', periodic: { period: 100 } });
      await gone.delete();
      expect(await gone.ended).toEqual({ reason: 'deleted' });
      tag = 'other';
      const sub = await ext.establish({ datastore: 'running', periodic: { period: 100 } });
      await expect(sub.delete()).rejects.toThrow(RpcError);
      expect(sub.end).toBeUndefined();
    });

    it('a reason whose prefix is declared only on <notification> resolves', async () => {
      const { fake, ext } = await open();
      const sub = await ext.establish({ stream: 'NETCONF' });
      fake.send(
        `<notification xmlns="urn:ietf:params:xml:ns:netconf:notification:1.0" xmlns:q="${SN}"><eventTime>2026-11-12T00:00:00Z</eventTime>` +
          `<subscription-terminated xmlns="${SN}"><id>${sub.id}</id><reason>q:filter-unavailable</reason></subscription-terminated></notification>`,
      );
      expect(await sub.ended).toEqual({ reason: 'terminated', identity: 'ietf-subscribed-notifications:filter-unavailable' });
    });

    it('subscription-terminated ends with its reason identity', async () => {
      const { fake, ext } = await open();
      const sub = await ext.establish({ stream: 'NETCONF' });
      const reading = take(sub, 5);
      fake.notify(sn('subscription-terminated', sub.id, x('reason', { 'xmlns:x': SN }, 'x:stream-unavailable')));
      expect(await reading).toEqual([]);
      expect(await sub.ended).toEqual({ reason: 'terminated', identity: 'ietf-subscribed-notifications:stream-unavailable' });
    });

    it('ends as completed shortly after the stop-time, and deletes it on the server', async () => {
      const { fake, ext } = await open();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const sub = await ext.establish({ datastore: 'running', periodic: { period: 100 }, stopTime: new Date(Date.now() + 5000) });
      await vi.advanceTimersByTimeAsync(5000 + STOP_GRACE_MS - 10);
      expect(sub.end).toBeUndefined();
      await vi.advanceTimersByTimeAsync(20);
      vi.useRealTimers();
      expect(await sub.ended).toEqual({ reason: 'completed' });
      await tick();
      expect(ops(fake)).toEqual(['establish-subscription', 'delete-subscription']);
    });

    it('a subscription-terminated at the stop-time counts as completed', async () => {
      const { fake, ext } = await open();
      const sub = await ext.establish({ stream: 'NETCONF', stopTime: new Date(Date.now() + 200) });
      await new Promise((r) => setTimeout(r, 300));
      fake.notify(sn('subscription-terminated', sub.id, x('reason', { 'xmlns:sn': SN }, 'sn:no-such-subscription')));
      expect(await sub.ended).toEqual({ reason: 'completed' });
    });

    it('break in for await deletes the subscription', async () => {
      const { fake, ext } = await open();
      const sub = await ext.establish({ stream: 'NETCONF' });
      fake.notify(event());
      for await (const u of sub) {
        expect(u.type).toBe('event');
        break;
      }
      expect(await sub.ended).toEqual({ reason: 'deleted' });
      expect(lastOp(fake).name).toBe('delete-subscription');
    });

    it('await using deletes on scope exit, ignoring an aborted signal', async () => {
      const { fake, ext } = await open();
      const ac = new AbortController();
      {
        await using sub = await ext.establish({ stream: 'NETCONF', signal: ac.signal });
        ac.abort();
        void sub;
      }
      expect(ops(fake)).toEqual(['establish-subscription', 'delete-subscription']);
    });

    it('ends every subscription as closed when the session closes, without sending deletes', async () => {
      const { fake, client, ext } = await open();
      const a = await ext.establish({ stream: 'NETCONF' });
      const b = await ext.establish({ datastore: 'running', periodic: { period: 100 } });
      const reading = a.next();
      fake.end();
      await expect(reading).resolves.toEqual({ value: undefined, done: true });
      expect(await a.ended).toEqual({ reason: 'closed' });
      expect(await b.ended).toEqual({ reason: 'closed' });
      await b[Symbol.asyncDispose]();
      expect(ops(fake)).toEqual(['establish-subscription', 'establish-subscription']);
      void client;
    });

    it('a reader that falls behind gets SubscriptionOverflowError, and the subscription is deleted', async () => {
      const { fake, ext } = await open();
      const sub = await ext.establish({ datastore: 'running', periodic: { period: 100 }, queueSize: 2 });
      for (let i = 0; i < 4; i++) fake.notify(pushUpdate(sub.id));
      await expect(sub.ended).resolves.toEqual({ reason: 'overflow' });
      expect(await take(sub, 2)).toHaveLength(2);
      const err = await sub.next().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubscriptionOverflowError);
      expect(err).toMatchObject({ limit: 2 });
      await expect(sub.next()).resolves.toEqual({ value: undefined, done: true });
      await tick();
      expect(lastOp(fake).name).toBe('delete-subscription');
    });
  });

  describe('extension operations', () => {
    it('modify() sends the datastore with the new period; resync() is for on-change', async () => {
      const { fake, ext } = await open();
      const periodic = await ext.establish({ datastore: 'operational', periodic: { period: 100 } });
      await periodic.modify({ period: 50 });
      expect(serializeXml(lastOp(fake))).toContain(`ds:operational</datastore><periodic xmlns="${YP}"><period>50</period></periodic>`);
      await expect(periodic.modify({ dampeningPeriod: 5 })).rejects.toThrow(/periodic; give period/);
      await expect(periodic.resync()).rejects.toThrow(/on-change/);
      const onChange = await ext.establish({ datastore: 'running', onChange: {} });
      await onChange.resync();
      expect(serializeXml(lastOp(fake))).toBe(`<resync-subscription xmlns="${YP}"><id>${onChange.id}</id></resync-subscription>`);
      // By id, through the module: the handle's own method runs.
      await ext.modify(onChange.id, { dampeningPeriod: 10 });
      expect(serializeXml(lastOp(fake))).toContain('<on-change xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-push"><dampening-period>10</dampening-period></on-change>');
      await ext.delete(onChange.id);
      expect(onChange.end).toEqual({ reason: 'deleted' });
    });

    it('kill() sends kill-subscription; subscriptionErrorReason() reads the reason identity', async () => {
      const { fake, ext } = await open((rpc, ctx) =>
        ctx.operation?.name === 'kill-subscription'
          ? { errors: [{ type: 'application', tag: 'invalid-value', appTag: 'ietf-subscribed-notifications:no-such-subscription' }] }
          : 'ok',
      );
      const err = await ext.kill(5).catch((e: unknown) => e);
      expect(serializeXml(lastOp(fake))).toBe(`<kill-subscription xmlns="${SN}"><id>5</id></kill-subscription>`);
      expect(subscriptionErrorReason(err)).toBe('ietf-subscribed-notifications:no-such-subscription');
      expect(subscriptionErrorReason(new Error('x'))).toBeUndefined();
    });

    it('rejects an establish reply without a valid id with a ProtocolError', async () => {
      const { ext } = await open(() => 'ok');
      await expect(ext.establish({ stream: 'NETCONF' })).rejects.toThrow(ProtocolError);
      // The failed establish doesn't count as the session's stream subscription.
      await expect(ext.establish({ stream: 'NETCONF' })).rejects.toThrow(ProtocolError);
    });

    it('streams() and list() parse /streams and /subscriptions', async () => {
      const { content } = await open((_rpc, ctx) => {
        const filter = ctx.operation?.child('filter', NETCONF_NS)?.elements[0]?.name;
        if (filter === 'streams') {
          return { data: x('streams', { xmlns: SN },
            x('stream', x('name', 'NETCONF'), x('description', 'all'), x('replay-support'), x('replay-log-creation-time', 'T0')),
            x('stream', x('name', 'quiet')),
          ) };
        }
        return { data: x('subscriptions', { xmlns: SN },
          x('subscription', x('id', '3'), x('stream', 'NETCONF'), x('stop-time', 'T9'),
            x('receivers', x('receiver', x('name', 'NETCONF session 4'), x('sent-event-records', '2'), x('excluded-event-records', '0'), x('state', 'active')))),
          x('subscription', x('id', '4'), x('datastore', { xmlns: YP, 'xmlns:ds': DS }, 'ds:operational'), x('receivers')),
          x('subscription', x('id', 'bad')),
        ) };
      });
      expect(await content.streams()).toEqual([
        { name: 'NETCONF', description: 'all', replaySupport: true, replayLogCreationTime: 'T0' },
        { name: 'quiet', replaySupport: false },
      ]);
      expect(await content.list()).toEqual([
        { id: 3, stream: 'NETCONF', stopTime: 'T9', receivers: [{ name: 'NETCONF session 4', sentEventRecords: 2, excludedEventRecords: 0, state: 'active' }] },
        { id: 4, datastore: 'ietf-datastores:operational', receivers: [] },
      ]);
    });

    it('lists the subscription RPCs in client.ops.list and runs them from plain arguments', async () => {
      const { fake, client } = await open();
      const found = client.ops.list.filter((d) => d.extension === 'subscriptions');
      expect(found.map((d) => [d.name, d.method, d.mutates])).toEqual([
        ['establish-subscription', 'establish', false],
        ['modify-subscription', 'modify', false],
        ['delete-subscription', 'delete', false],
        ['kill-subscription', 'kill', true],
        ['resync-subscription', 'resync', false],
        ['subscription-streams', 'streams', false],
        ['subscription-list', 'list', false],
        ['subscription-support', 'support', false],
        ['subscription-capabilities', 'capabilities', false],
      ]);
      expect(JSON.parse(JSON.stringify(found))).toEqual(found);
      await client.ops.run('establish-subscription', { datastore: 'running', period: 100 });
      expect(serializeXml(lastOp(fake))).toBe(serializeXml(establishSubscriptionRequest({ datastore: 'running', periodic: { period: 100 } }).element));
      await client.ops.run('kill-subscription', { id: 3 });
      expect(lastOp(fake).name).toBe('kill-subscription');
    });
  });
});

/** Found in review: each failed before the fix. */
describe('subscriptions extension regressions (OPS-23 review)', () => {
  it('a stop-time more than 24.8 days away does not end the subscription at once', async () => {
    const { fake, ext } = await open();
    const sub = await ext.establish({ datastore: 'running', periodic: { period: 100 }, stopTime: new Date(Date.now() + 30 * 86_400_000) });
    await new Promise((r) => setTimeout(r, 50));
    expect(sub.end).toBeUndefined();
    expect(ops(fake)).toEqual(['establish-subscription']);
  });

  it('a replay of a past window is not cut off before replay-completed; it completes after it', async () => {
    const { fake, ext } = await open();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const sub = await ext.establish({ stream: 'NETCONF', replayStartTime: new Date(Date.now() - 7_200_000), stopTime: new Date(Date.now() - 3_600_000) });
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS * 5);
    expect(sub.end).toBeUndefined();
    fake.notify(sn('replay-completed', sub.id));
    await vi.advanceTimersByTimeAsync(10);
    await expect(sub.replayComplete).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
    vi.useRealTimers();
    expect(await sub.ended).toEqual({ reason: 'completed' });
    await tick();
    expect(ops(fake)).toEqual(['establish-subscription', 'delete-subscription']);
  });

  it('an establish aborted after sending deletes what it created, and holds the stream slot until then', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let next = 7;
    const { fake, ext } = await open(async (_rpc, { operation }) => {
      if (operation?.name === 'establish-subscription') {
        if (next === 7) await gate;
        return idReply(next++);
      }
      return 'ok';
    });
    const ac = new AbortController();
    const pending = ext.establish({ stream: 'NETCONF', signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // The reply hasn't come yet, so the subscription may exist: the slot stays taken.
    await expect(ext.establish({ stream: 'NETCONF' })).rejects.toThrow(SubscriptionError);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(ops(fake)).toEqual(['establish-subscription', 'delete-subscription']);
    expect(serializeXml(lastOp(fake))).toBe(`<delete-subscription xmlns="${SN}"><id>7</id></delete-subscription>`);
    await expect(ext.establish({ stream: 'NETCONF' })).resolves.toMatchObject({ id: 8 });
  });

  it('an establish aborted before sending sends nothing', async () => {
    const { fake, ext } = await open();
    const ac = new AbortController();
    ac.abort();
    await expect(ext.establish({ stream: 'NETCONF', signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.requests).toHaveLength(0);
  });

  it('a timed-out stream establish leaves the stream slot refused, since a subscription may exist', async () => {
    const { ext } = await open((rpc, ctx) =>
      ctx.operation?.name === 'establish-subscription' && ctx.operation.child('stream', SN) !== undefined ? undefined : numbering()(rpc, ctx),
    );
    await expect(ext.establish({ stream: 'NETCONF', timeout: 50 })).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(ext.establish({ stream: 'NETCONF' })).rejects.toThrow(/may still be active/);
    await expect(ext.establish({ datastore: 'running', periodic: { period: 100 } })).resolves.toBeDefined();
  });

  it('a refused establish-subscription leaves the session free for create-subscription', async () => {
    const { client, ext } = await open((_rpc, { operation }) =>
      operation?.name === 'establish-subscription' ? { errors: [{ type: 'protocol', tag: 'operation-not-supported' }] } : 'ok',
    );
    await expect(ext.establish({ stream: 'NETCONF' })).rejects.toThrow(RpcError);
    await expect(client.ops.notifications.createSubscription()).resolves.toBeDefined();
  });

  it('a raw establish-subscription (ops.run) blocks create-subscription for the session', async () => {
    const { client } = await open();
    await client.ops.run('establish-subscription', { stream: 'NETCONF' });
    await expect(client.ops.notifications.createSubscription()).rejects.toThrow(SubscriptionError);
  });

  it('overflow counts every notification dropped until the server-side delete is done', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const numbered = numbering();
    const { fake, ext } = await open(async (rpc, ctx) => {
      if (ctx.operation?.name === 'delete-subscription') await gate;
      return numbered(rpc, ctx);
    });
    const sub = await ext.establish({ datastore: 'running', periodic: { period: 100 }, queueSize: 1 });
    for (let i = 0; i < 5; i++) fake.notify(pushUpdate(sub.id));
    await expect(sub.ended).resolves.toEqual({ reason: 'overflow' });
    await tick();
    release();
    await take(sub, 1);
    const err = (await sub.next().catch((e: unknown) => e)) as SubscriptionOverflowError;
    expect(err).toBeInstanceOf(SubscriptionOverflowError);
    expect(err.dropped).toBe(4);
  });

  it('event records held for a failed stream establish are not handed to the next one', async () => {
    let first = true;
    let releaseDs!: () => void;
    const dsGate = new Promise<void>((r) => (releaseDs = r));
    const { fake, ext } = await open(async (_rpc, { operation, server }) => {
      if (operation?.name !== 'establish-subscription') return 'ok';
      if (operation.child('datastore', YP) !== undefined) {
        await dsGate;
        return idReply(50);
      }
      if (first) {
        first = false;
        server.notify(event('stale'));
        return { errors: [{ type: 'application', tag: 'invalid-value' }] };
      }
      return idReply(60);
    });
    const ds = ext.establish({ datastore: 'running', periodic: { period: 100 } });
    await expect(ext.establish({ stream: 'NETCONF' })).rejects.toThrow(RpcError);
    const stream = await ext.establish({ stream: 'NETCONF' });
    releaseDs();
    await ds;
    fake.notify(event('fresh'));
    const [update] = await take(stream, 1);
    expect((update as Extract<SubscriptionUpdate, { type: 'event' }>).notification.event?.child('leaf', EX)?.text()).toBe('fresh');
  });

  it('support() shared by two callers: one aborting does not fail the other', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const library = x('yang-library', { xmlns: YL },
      x('module-set', x('name', 'all'), x('module', x('name', 'ietf-subscribed-notifications'), x('namespace', SN))),
      x('content-id', '1'),
    );
    const numbered = numbering();
    const { ext, content } = await open(
      async (rpc, ctx) => {
        if (ctx.operation?.name === 'get') {
          await gate;
          return { data: library };
        }
        return numbered(rpc, ctx);
      },
      [BASE_1_0, BASE_1_1, NOTIF_CAP, 'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=1'],
    );
    const ac = new AbortController();
    const aborted = content.support({ signal: ac.signal });
    const other = ext.establish({ stream: 'NETCONF' });
    ac.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    release();
    await expect(other).resolves.toMatchObject({ id: 7 });
  });
});
