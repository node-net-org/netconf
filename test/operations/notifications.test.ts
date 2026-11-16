/**
 * RFC 5277 notifications (OPS-19) and the seam it needs, against the fake server.
 */
import { describe, expect, it } from 'vitest';
import {
  BASE_1_0,
  BASE_1_1,
  CapabilityError,
  connect,
  NOTIFICATION_NS,
  parseXml,
  serializeXml,
  subtree,
  x,
  xpath,
  type Notification,
  type XmlElement,
} from '../../src/index.js';
import {
  NETMOD_NOTIFICATION_NS,
  SubscriptionError,
  SubscriptionOverflowError,
  createSubscriptionRequest,
  notifications,
  type Subscription,
} from '../../src/operations/notifications.js';
import { FakeServer, type RpcHandler } from '../../src/testing/index.js';

const CAP = (n: string): string => `urn:ietf:params:netconf:capability:${n}`;
const NOTIF = CAP('notification:1.0');
const INTERLEAVE = CAP('interleave:1.0');
const EX = 'urn:example:events';

async function open(capabilities: string[] = [NOTIF, INTERLEAVE], handler: RpcHandler = () => 'ok') {
  const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1, ...capabilities], handler });
  const client = await connect({ transport: fake.transport(), extensions: [notifications] });
  return { fake, client };
}

const event = (name: string, ns = EX): XmlElement => x(name, { xmlns: ns });
const tick = () => new Promise((r) => setTimeout(r, 10));
const lastOp = (fake: FakeServer) => fake.requests.at(-1)!.elements[0]!;

async function collect(sub: Subscription, count: number): Promise<Notification[]> {
  const out: Notification[] = [];
  for await (const n of sub) {
    out.push(n);
    if (out.length === count) break;
  }
  return out;
}

describe('the seam: onNotification, onClosed, addRpcGuard', () => {
  it('delivers notifications and the close to listeners until removed', async () => {
    const { fake, client } = await open();
    const seen: string[] = [];
    const off = client.session.onNotification((n) => seen.push(n.event!.name));
    let closed = 0;
    client.session.onClosed(() => closed++);
    fake.notify(event('a'));
    await tick();
    off();
    fake.notify(event('b'));
    await tick();
    expect(seen).toEqual(['a']);
    await client.close();
    expect(closed).toBe(1);
  });

  it('a guard refuses before sending, never blocks close, and can be removed', async () => {
    const { fake, client } = await open();
    const remove = client.session.addRpcGuard((op) => {
      if (op.name === 'get') throw new TypeError('no get');
    });
    await expect(client.ops.get()).rejects.toThrow('no get');
    await expect(client.session.rpc(x('get'))).rejects.toThrow('no get');
    expect(fake.requests).toHaveLength(0);
    await client.ops.getConfig();
    remove();
    await client.ops.get();
    client.session.addRpcGuard(() => {
      throw new TypeError('nothing');
    });
    await client.close();
    expect(lastOp(fake).name).toBe('close-session');
  });
});

describe('notifications extension (OPS-19)', () => {
  it('requires :notification:1.0', async () => {
    const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
    await expect(connect({ transport: fake.transport(), extensions: [notifications] })).rejects.toThrow(CapabilityError);
  });

  describe('create-subscription request', () => {
    it('sends each parameter in the notification namespace', () => {
      const req = createSubscriptionRequest({
        stream: 'NETCONF',
        filter: subtree(x('config-change', { xmlns: EX })),
        startTime: new Date('2026-11-01T00:00:00Z'),
        stopTime: '2026-11-02T00:00:00Z',
      });
      expect(serializeXml(req.element)).toBe(
        `<create-subscription xmlns="${NOTIFICATION_NS}"><stream>NETCONF</stream><filter type="subtree"><config-change xmlns="${EX}"/></filter>` +
          '<startTime>2026-11-01T00:00:00.000Z</startTime><stopTime>2026-11-02T00:00:00Z</stopTime></create-subscription>',
      );
      expect(serializeXml(createSubscriptionRequest({}).element)).toBe(`<create-subscription xmlns="${NOTIFICATION_NS}"/>`);
    });

    it('an XPath filter carries its namespaces and requires :xpath', () => {
      const req = createSubscriptionRequest({ filter: xpath('/e:alarm', { e: EX }) });
      expect(serializeXml(req.element)).toContain(`<filter xmlns:e="${EX}" type="xpath" select="/e:alarm"/>`);
      expect(req.requires).toEqual([':xpath']);
    });

    it.each([
      [{ stopTime: '2026-11-02T00:00:00Z' }, /needs startTime/],
      [{ startTime: '2026-11-02T00:00:00Z', stopTime: '2026-11-01T00:00:00Z' }, /later than/],
      [{ startTime: '2026-11-02T00:00:00Z', stopTime: '2026-11-02T00:00:00Z' }, /later than/],
      [{ startTime: new Date('nope') }, /invalid Date/],
      [{ stream: '' }, /stream/],
    ])('refuses %o', (args, message) => {
      expect(() => createSubscriptionRequest(args)).toThrow(message);
    });

    it('refuses a time string that is not a date, before sending (the RFC 3339 check subscriptions use)', async () => {
      expect(() => createSubscriptionRequest({ startTime: 'yesterday' })).toThrow('create-subscription: startTime must be a Date or an RFC 3339 string');
      expect(() => createSubscriptionRequest({ startTime: '2026-11-01T00:00:00Z', stopTime: 'soon' })).toThrow(
        'create-subscription: stopTime must be a Date or an RFC 3339 string',
      );
      const { fake, client } = await open();
      const sent = fake.requests.length;
      await expect(client.ops.notifications.createSubscription({ startTime: 'not a time' })).rejects.toThrow(TypeError);
      await expect(client.ops.run('create-subscription', { startTime: 'not a time' })).rejects.toThrow(TypeError);
      expect(fake.requests.length).toBe(sent);
      await client.close();
    });
  });

  it('yields notifications in order with for await', async () => {
    const { fake, client } = await open();
    const sub = await client.ops.notifications.createSubscription({ stream: 'NETCONF' });
    expect(lastOp(fake).name).toBe('create-subscription');
    expect([sub.stream, sub.replay, sub.interleave]).toEqual(['NETCONF', false, true]);
    fake.notify(event('one'));
    fake.notify(event('two'), '2026-11-07T10:00:00Z');
    const got = await collect(sub, 2);
    expect(got.map((n) => n.event!.name)).toEqual(['one', 'two']);
    expect(got[1]!.eventTime).toBe('2026-11-07T10:00:00Z');
    await client.close();
  });

  it('allows one subscription per session, refused before sending', async () => {
    const { fake, client } = await open();
    await client.ops.notifications.createSubscription();
    await expect(client.ops.notifications.createSubscription()).rejects.toBeInstanceOf(SubscriptionError);
    expect(fake.requests.filter((r) => r.elements[0]!.name === 'create-subscription')).toHaveLength(1);
    await client.close();
  });

  it('a refused create-subscription leaves nothing behind', async () => {
    const { client } = await open([NOTIF], () => ({ errors: [{ type: 'protocol', tag: 'operation-failed' }] }));
    await expect(client.ops.notifications.createSubscription()).rejects.toThrow();
    expect(client.ops.notifications.active).toBe(false);
    await expect(client.ops.getConfig()).rejects.toThrow(/operation-failed/); // sent, not refused locally
    await client.close();
  });

  describe('without :interleave', () => {
    it('refuses other operations while subscribed, but closing still works', async () => {
      const { fake, client } = await open([NOTIF]);
      expect(client.ops.notifications.interleave).toBe(false);
      const sub = await client.ops.notifications.createSubscription();
      const before = fake.requests.length;
      await expect(client.ops.getConfig()).rejects.toThrow(CapabilityError);
      await expect(client.session.rpc(x('get'))).rejects.toThrow(/:interleave/);
      expect(fake.requests).toHaveLength(before);
      await sub.return(); // dispose doesn't end the server's subscription
      await expect(client.ops.getConfig()).rejects.toThrow(CapabilityError);
      await client.close();
      expect(lastOp(fake).name).toBe('close-session');
    });

    it('notificationComplete ends the subscription and lifts the rule', async () => {
      const { fake, client } = await open([NOTIF]);
      const sub = await client.ops.notifications.createSubscription({ startTime: '2026-11-01T00:00:00Z', stopTime: '2026-11-01T01:00:00Z' });
      expect(sub.replay).toBe(true);
      fake.notify(event('logged'));
      fake.notify(event('replayComplete', NETMOD_NOTIFICATION_NS));
      fake.notify(event('notificationComplete', NETMOD_NOTIFICATION_NS));
      const got: string[] = [];
      for await (const n of sub) got.push(n.event!.name);
      expect(got).toEqual(['logged']);
      expect(await sub.replayComplete).toBe(true);
      expect(await sub.ended).toEqual({ reason: 'completed' });
      expect(client.ops.notifications.active).toBe(false);
      await expect(client.ops.getConfig()).resolves.toBeDefined();
      await client.ops.notifications.createSubscription(); // allowed again
      await client.close();
    });
  });

  it('ends iteration when the session closes, waking a waiting reader', async () => {
    const { client } = await open();
    const sub = await client.ops.notifications.createSubscription();
    const pending = sub.next();
    await client.close();
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(await sub.ended).toEqual({ reason: 'closed' });
    expect(await sub.replayComplete).toBe(false);
  });

  it('overflow: queued notifications are delivered, then an error with the limit and drop count', async () => {
    const { fake, client } = await open();
    const sub = await client.ops.notifications.createSubscription({ queueSize: 2 });
    for (const name of ['n1', 'n2', 'n3', 'n4', 'n5']) fake.notify(event(name));
    await tick();
    const got: string[] = [];
    const err = await (async () => {
      try {
        for await (const n of sub) got.push(n.event!.name);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(got).toEqual(['n1', 'n2']);
    expect(err).toBeInstanceOf(SubscriptionOverflowError);
    expect(err).toMatchObject({ limit: 2, dropped: 3, code: 'ERR_NETCONF_SUBSCRIPTION_OVERFLOW' });
    expect(await sub.ended).toEqual({ reason: 'overflow' });
    await client.close();
  });

  it('await using disposes: delivery stops, but the server subscription remains', async () => {
    const { fake, client } = await open();
    {
      await using sub = await client.ops.notifications.createSubscription();
      fake.notify(event('kept'));
      expect((await collect(sub, 1))[0]!.event!.name).toBe('kept');
    }
    expect(client.ops.notifications.active).toBe(true);
    await expect(client.ops.notifications.createSubscription()).rejects.toBeInstanceOf(SubscriptionError);
    await client.close();
  });

  it('rejects a bad queueSize', async () => {
    const { client } = await open();
    await expect(client.ops.notifications.createSubscription({ queueSize: 0 })).rejects.toThrow(TypeError);
    await client.close();
  });

  it('streams() parses /netconf/streams', async () => {
    const data = parseXml(
      `<netconf xmlns="${NETMOD_NOTIFICATION_NS}"><streams>` +
        '<stream><name>NETCONF</name><description>all</description><replaySupport>true</replaySupport>' +
        '<replayLogCreationTime>2026-11-01T00:00:00Z</replayLogCreationTime></stream>' +
        '<stream><name>syslog</name><replaySupport>false</replaySupport></stream></streams></netconf>',
    );
    const { fake, client } = await open([NOTIF], () => ({ data }));
    expect(await client.content.notifications.streams()).toEqual([
      { name: 'NETCONF', description: 'all', replaySupport: true, replayLogCreationTime: '2026-11-01T00:00:00Z' },
      { name: 'syslog', replaySupport: false },
    ]);
    expect(serializeXml(lastOp(fake))).toContain(`<netconf xmlns="${NETMOD_NOTIFICATION_NS}"><streams/></netconf>`);
    await client.close();
  });

  it('create-subscription is a described operation with the same XML as the builder (OPS-13)', async () => {
    const { fake, client } = await open();
    const d = client.ops.list.find((o) => o.name === 'create-subscription')!;
    expect(d).toMatchObject({ extension: 'notifications', mutates: false, namespace: NOTIFICATION_NS });
    await client.ops.run('create-subscription', { stream: 'NETCONF' });
    expect(serializeXml(lastOp(fake))).toBe(serializeXml(createSubscriptionRequest({ stream: 'NETCONF' }).element));
    await client.close();
  });
});
