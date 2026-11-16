/**
 * The RFC 5717 partial-lock extension (OPS-22), against the fake server.
 *
 * No open-source NETCONF server implements partial lock (netopeer2 doesn't;
 * yuma123 2.13 advertises it but fails every request), so these tests are the
 * extension's only coverage: they check the request and reply shapes in RFC 5717
 * §2.4 and the YANG module in §4.
 */
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  BASE_1_0,
  BASE_1_1,
  CapabilityError,
  connect,
  LockDeniedError,
  NETCONF_NS,
  parseXml,
  PathError,
  pathXPath,
  ProtocolError,
  RpcError,
  serializeXml,
  SessionClosedError,
  subtree,
  x,
  xpath,
  type NetconfClient,
  XmlElement,
} from '../../src/index.js';
import type { ExtensionContext } from '../../src/operations/extension.js';
import { MONITORING_NS, monitoring } from '../../src/operations/monitoring.js';
import {
  PARTIAL_LOCK_CAPABILITY,
  PARTIAL_LOCK_NS,
  PartialLock,
  PartialLockDeniedError,
  partialLock,
  partialLockRequest,
  partialUnlockRequest,
} from '../../src/operations/partial-lock.js';
import { TransactionError } from '../../src/operations/transaction.js';
import { FakeServer, type RpcHandler } from '../../src/testing/index.js';

const PL = PARTIAL_LOCK_NS;
const IF = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
const RT = 'urn:example:route';
const NCM_CAP = `${MONITORING_NS}?module=ietf-netconf-monitoring&revision=2010-10-04`;
const CAPS = [BASE_1_0, BASE_1_1, PARTIAL_LOCK_CAPABILITY, `${IF}?module=ietf-interfaces&revision=2018-02-20`, NCM_CAP];
const ETH0 = "/if:interfaces/if:interface[if:name='eth0']";

/** A reply granting `lockId` on these instance-identifiers, each declaring the prefixes it uses. */
const granted = (lockId: string, ...nodes: [path: string, ns: Record<string, string>][]): RpcHandler =>
  () => ({
    body: [
      x('lock-id', { xmlns: PL }, lockId),
      ...nodes.map(([path, ns]) =>
        x('locked-node', { xmlns: PL, ...Object.fromEntries(Object.entries(ns).map(([p, u]) => [`xmlns:${p}`, u])) }, path),
      ),
    ],
  });

/** Grant locks for partial-lock, ok for everything else. */
function server(lock: RpcHandler = granted('127', [ETH0, { if: IF }])): RpcHandler {
  return (rpc, ctx) => (ctx.operation?.name === 'partial-lock' ? lock(rpc, ctx) : 'ok');
}

let clients: NetconfClient[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  clients = [];
});
async function open(handler: RpcHandler = server(), capabilities = CAPS, sessionId = 7) {
  const fake = new FakeServer({ capabilities, handler, sessionId });
  const client = await connect({ transport: fake.transport(), extensions: [partialLock, monitoring] });
  clients.push(client);
  return { fake, client };
}

const ops = (fake: FakeServer): string[] => fake.requests.map((r) => r.elements[0]!.name);
const lastOp = (fake: FakeServer): XmlElement => fake.requests.at(-1)!.elements[0]!;
const lockDenied = (sessionId: string, extra: XmlElement[] = []) => ({
  errors: [{ type: 'protocol' as const, tag: 'lock-denied', message: 'Lock failed', info: [x('session-id', { xmlns: NETCONF_NS }, sessionId), ...extra] }],
});

describe('partial-lock extension (OPS-22)', () => {
  it('requires :partial-lock:1.0 after the hello', async () => {
    const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
    await expect(connect({ transport: fake.transport(), extensions: [partialLock] })).rejects.toThrow(CapabilityError);
  });

  describe('request builders', () => {
    it('sends one <select> per expression, each declaring the namespaces its prefixes use', () => {
      const req = partialLockRequest({
        select: [xpath(ETH0, { if: IF }), xpath("/rte:routing/rte:virtualRouter[rte:routerName='router1']", { rte: RT }), '/top'],
      });
      expect(serializeXml(req.element)).toBe(
        `<partial-lock xmlns="${PL}">` +
          `<select xmlns:if="${IF}">${ETH0}</select>` +
          `<select xmlns:rte="${RT}">/rte:routing/rte:virtualRouter[rte:routerName='router1']</select>` +
          '<select>/top</select>' +
          '</partial-lock>',
      );
      // The XML round-trips to the same expressions.
      const parsed = parseXml(serializeXml(req.element));
      expect(parsed.childrenNamed('select', PL).map((s) => s.text())).toEqual([ETH0, "/rte:routing/rte:virtualRouter[rte:routerName='router1']", '/top']);
      expect(req.requires).toEqual([]);
    });

    it('takes a single select as well as a list', () => {
      const el = parseXml(serializeXml(partialLockRequest({ select: xpath(ETH0, { if: IF }) }).element));
      expect(el.childrenNamed('select', PL)).toHaveLength(1);
    });

    it('refuses bad selects locally, before anything is sent', async () => {
      const { fake, client } = await open();
      const sent = fake.requests.length;
      const bad: [unknown, RegExp][] = [
        [[], /at least one select/],
        [undefined, /at least one select/],
        ['  ', /is empty/],
        [xpath('', {}), /is empty/],
        [subtree(x('interfaces', { xmlns: IF })), /must be an XPath/],
        [42, /must be an XPath/],
        [ETH0, /prefix "if" with no namespace/],
        [xpath(ETH0, {}), /prefix "if" with no namespace/],
        [xpath('/a:b', { a: '' }), /needs a namespace URI/],
        [xpath('/x:b', { 'bad prefix': IF, x: IF }), /not a usable namespace prefix/],
        [xpath('/xml:b', { xml: IF }), /not a usable namespace prefix/],
      ];
      for (const [select, message] of bad) {
        expect(() => partialLockRequest({ select }), String(select)).toThrow(message);
        await expect(client.ops.partialLock.lock(select as string)).rejects.toThrow(TypeError);
      }
      expect(fake.requests.length).toBe(sent);
    });

    it("ignores colons inside string literals and axis names when finding a select's prefixes", () => {
      expect(() => partialLockRequest({ select: "/top[name='a:b'][x=\"c:d\"]/child::leaf" })).not.toThrow();
    });

    it('builds <partial-unlock> and refuses a lock-id that is not a uint32', () => {
      expect(serializeXml(partialUnlockRequest({ lockId: 127 }).element)).toBe(`<partial-unlock xmlns="${PL}"><lock-id>127</lock-id></partial-unlock>`);
      expect(serializeXml(partialUnlockRequest({ lockId: 0xffff_ffff }).element)).toContain('<lock-id>4294967295</lock-id>');
      for (const lockId of [undefined, -1, 1.5, 2 ** 32, '127', Number.NaN]) {
        expect(() => partialUnlockRequest({ lockId }), String(lockId)).toThrow(/lock-id must be an integer/);
      }
    });
  });

  describe('partialLock()', () => {
    it('resolves with the lock-id and the locked nodes as RFC 7951 instance-identifiers', async () => {
      const { fake, client } = await open(
        server(granted('127', [ETH0, { if: IF }], ["/rte:routing/rte:virtualRouter[rte:routerName='router1']", { rte: RT }])),
      );
      const lock = await client.ops.partialLock.lock([xpath(ETH0, { if: IF }), xpath('/rte:routing', { rte: RT })]);
      expectTypeOf(lock).toEqualTypeOf<PartialLock>();
      expect(ops(fake)).toEqual(['partial-lock']);
      expect(lock.lockId).toBe(127);
      expect(lock.state).toBe('held');
      // RFC 7951 paths: a module the session doesn't know is named by its namespace
      expect(lock.lockedNodes).toEqual(["/ietf-interfaces:interfaces/interface[name='eth0']", `/${RT}:routing/virtualRouter[routerName='router1']`]);
    });

    it('resolves locked-node prefixes declared on the reply element, and accepts a <data> wrapper', async () => {
      const { client } = await open(
        server((_rpc, ctx) => {
          ctx.server.send(
            `<rpc-reply message-id="${ctx.messageId}" xmlns="${NETCONF_NS}" xmlns:pl="${PL}" xmlns:if="${IF}"><data>` +
              `<pl:lock-id>5</pl:lock-id><pl:locked-node>\n  ${ETH0}\n</pl:locked-node></data></rpc-reply>`,
          );
          return undefined;
        }),
      );
      const lock = await client.ops.partialLock.lock(xpath(ETH0, { if: IF }));
      expect(lock.lockId).toBe(5);
      expect(lock.lockedNodes).toEqual(["/ietf-interfaces:interfaces/interface[name='eth0']"]);
    });

    it('takes a lock by YANG path through client.content.toXPath()', async () => {
      const { fake, client } = await open();
      await client.ops.partialLock.lock(client.content.toXPath('/ietf-interfaces:interfaces/interface[name="eth0"]'));
      const select = lastOp(fake).child('select', PL)!;
      expect(select.text()).toBe("/ietf-interfaces:interfaces/ietf-interfaces:interface[ietf-interfaces:name='eth0']");
      expect([...select.declarations]).toEqual([['ietf-interfaces', IF]]);
    });

    it('rejects a reply with no valid lock-id with a ProtocolError', async () => {
      for (const body of [[], [x('lock-id', { xmlns: PL }, 'abc')], [x('lock-id', { xmlns: PL }, '4294967296')], [x('lock-id', '1')]]) {
        const { fake, client } = await open(server(() => ({ body })));
        await expect(client.ops.partialLock.lock('/top')).rejects.toThrow(ProtocolError);
        expect(ops(fake)).toEqual(['partial-lock']);
      }
    });

    it('releases the lock and rejects with a ProtocolError when a locked-node is not an instance-identifier', async () => {
      const { fake, client } = await open(server(granted('9', ['/undeclared:top', {}])));
      const err = await client.ops.partialLock.lock('/top').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProtocolError);
      expect((err as Error).message).toMatch(/locked-node .*undeclared prefix "undeclared"/);
      expect(ops(fake)).toEqual(['partial-lock', 'partial-unlock']);
      expect(lastOp(fake).child('lock-id', PL)!.text()).toBe('9');
    });

    it('rejects lock-denied with PartialLockDeniedError: a LockDeniedError naming the holder', async () => {
      const { client } = await open(server(() => lockDenied('12')));
      const err = await client.ops.partialLock.lock(xpath(ETH0, { if: IF })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PartialLockDeniedError);
      expect(err).toBeInstanceOf(LockDeniedError);
      expect(err).toBeInstanceOf(TransactionError);
      const denied = err as PartialLockDeniedError;
      expect(denied.datastore).toBe('running');
      expect(denied.holder).toBe(12);
      expect(denied.lockId).toBeUndefined();
      expect(denied.phase).toBe('lock');
      expect(denied.code).toBe('ERR_NETCONF_PARTIAL_LOCK_DENIED');
      expect(denied.message).toBe('Part of the running datastore is locked by session 12');
      expect(denied.cause).toBeInstanceOf(RpcError);
    });

    it('reports a non-NETCONF holder (session-id 0), an unknown holder, and a conflicting lock-id when given', async () => {
      const zero = await open(server(() => lockDenied('0', [x('lock-id', { xmlns: PL }, '3')])));
      const a = (await zero.client.ops.partialLock.lock('/top').catch((e: unknown) => e)) as PartialLockDeniedError;
      expect([a.holder, a.lockId, a.message]).toEqual([0, 3, 'Part of the running datastore is locked by a non-NETCONF entity']);

      const none = await open(server(() => ({ errors: [{ type: 'protocol', tag: 'lock-denied' }] })));
      const b = (await none.client.ops.partialLock.lock('/top').catch((e: unknown) => e)) as PartialLockDeniedError;
      expect([b.holder, b.lockId, b.message]).toEqual([undefined, undefined, 'Part of the running datastore is locked by another session']);
    });

    it('leaves other refusals as RpcError', async () => {
      const refusals = [
        { type: 'application' as const, tag: 'operation-failed', appTag: 'no-matches' },
        { type: 'application' as const, tag: 'invalid-value', appTag: 'not-a-node-set' },
        { type: 'application' as const, tag: 'invalid-value', appTag: 'invalid-lock-specification' },
        { type: 'application' as const, tag: 'access-denied' },
      ];
      for (const e of refusals) {
        const { client } = await open(server(() => ({ errors: [e] })));
        const err = await client.ops.partialLock.lock('/top').catch((x: unknown) => x);
        expect(err).toBeInstanceOf(RpcError);
        expect(err).not.toBeInstanceOf(LockDeniedError);
        expect((err as RpcError).first.appTag).toBe(e.appTag);
      }
    });

    it('honours the caller\'s AbortSignal while locking', async () => {
      const { client } = await open(server(() => undefined));
      const ac = new AbortController();
      const pending = client.ops.partialLock.lock('/top', { signal: ac.signal });
      ac.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  describe('the handle', () => {
    it('unlock() sends <partial-unlock> once; later calls do nothing', async () => {
      const { fake, client } = await open();
      const lock = await client.ops.partialLock.lock('/top');
      await Promise.all([lock.unlock(), lock.unlock()]);
      await lock.unlock();
      expect(ops(fake)).toEqual(['partial-lock', 'partial-unlock']);
      expect(serializeXml(lastOp(fake))).toBe(`<partial-unlock xmlns="${PL}"><lock-id>127</lock-id></partial-unlock>`);
      expect(lock.state).toBe('unlocked');
    });

    it('await using unlocks on scope exit, ignoring an aborted signal', async () => {
      const { fake, client } = await open();
      const ac = new AbortController();
      {
        await using lock = await client.ops.partialLock.lock('/top', { signal: ac.signal });
        ac.abort();
        expect(lock.state).toBe('held');
      }
      expect(ops(fake)).toEqual(['partial-lock', 'partial-unlock']);
    });

    it('a failed unlock rejects with the RpcError and leaves the lock held, so dispose tries again', async () => {
      let fail = true;
      const { fake, client } = await open((rpc, ctx) => {
        if (ctx.operation?.name === 'partial-unlock' && fail) return { errors: [{ type: 'application', tag: 'invalid-value' }] };
        return server()(rpc, ctx);
      });
      const lock = await client.ops.partialLock.lock('/top');
      await expect(lock.unlock()).rejects.toThrow(RpcError);
      expect(lock.state).toBe('held');
      fail = false;
      await lock[Symbol.asyncDispose]();
      expect(lock.state).toBe('unlocked');
      expect(ops(fake)).toEqual(['partial-lock', 'partial-unlock', 'partial-unlock']);
    });

    it('becomes closed when the session ends, and then sends nothing', async () => {
      const { fake, client } = await open();
      const lock = await client.ops.partialLock.lock('/top');
      fake.end();
      await new Promise((resolve) => client.session.once('closed', resolve));
      expect(lock.state).toBe('closed');
      await lock.unlock();
      await lock[Symbol.asyncDispose]();
      expect(ops(fake)).toEqual(['partial-lock']);
    });

    it('treats SessionClosedError on unlock as released, even if the close event was missed', async () => {
      // A context whose session closed before the handle could listen for it.
      const ctx = {
        onClosed: () => () => undefined,
        invoke: () => Promise.reject(new SessionClosedError('The session is closed')),
      } as unknown as ExtensionContext;
      const lock = new PartialLock(ctx, { lockId: 1, lockedNodes: [] }, {});
      await lock[Symbol.asyncDispose]();
      expect(lock.state).toBe('closed');
    });

    it('unlock(lockId) releases a lock by id and passes on the server\'s refusal', async () => {
      const { fake, client } = await open((rpc, ctx) =>
        ctx.operation?.child('lock-id', PL)?.text() === '99' ? { errors: [{ type: 'application', tag: 'invalid-value' }] } : 'ok',
      );
      await client.ops.partialLock.unlock(4);
      expect(serializeXml(lastOp(fake))).toBe(`<partial-unlock xmlns="${PL}"><lock-id>4</lock-id></partial-unlock>`);
      await expect(client.ops.partialLock.unlock(99)).rejects.toMatchObject({ tag: 'invalid-value' });
      await expect(client.ops.partialLock.unlock(-1)).rejects.toThrow(TypeError);
      expect(fake.requests).toHaveLength(2);
    });
  });

  describe('descriptors', () => {
    it('lists partial-lock and partial-unlock in client.ops.list, both marked as changing state', async () => {
      const { client } = await open();
      const found = client.ops.list.filter((d) => d.extension === 'partialLock');
      expect(found.map((d) => [d.name, d.method, d.namespace, d.mutates, d.requires])).toEqual([
        ['partial-lock', 'lock', PL, true, [PARTIAL_LOCK_CAPABILITY]],
        ['partial-unlock', 'unlock', PL, true, [PARTIAL_LOCK_CAPABILITY]],
      ]);
      expect(found[0]!.params).toEqual([expect.objectContaining({ name: 'select', kind: 'positional', type: 'xpath', multiple: true, required: true })]);
      expect(JSON.parse(JSON.stringify(found))).toEqual(found);
    });

    it('ops.run() sends the same XML as the methods', async () => {
      const { fake, client } = await open();
      await client.ops.run('partial-lock', { select: [client.content.toXPath('/ietf-interfaces:interfaces')] });
      const viaDescriptor = serializeXml(lastOp(fake));
      await client.ops.partialLock.lock(client.content.toXPath('/ietf-interfaces:interfaces'));
      expect(serializeXml(lastOp(fake))).toBe(viaDescriptor);
      await client.ops.run('partial-unlock', { lockId: 127 });
      expect(lastOp(fake).child('lock-id', PL)!.text()).toBe('127');
    });

    it('refuses to send either RPC without :partial-lock under the default capability check', async () => {
      const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
      const client = await connect({ transport: fake.transport(), extensions: [partialLock], extensionCheck: 'off' });
      clients.push(client);
      await expect(client.ops.partialLock.lock('/top')).rejects.toThrow(CapabilityError);
      await expect(client.ops.run('partial-unlock', { lockId: 1 })).rejects.toThrow(CapabilityError);
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe('agreement with monitoring datastores()', () => {
    /** A server that keeps its partial locks and reports them in /netconf-state, as RFC 6022 does. */
    function lockingServer(sessionId: number): RpcHandler {
      const locks = new Map<number, { selects: XmlElement[]; nodes: XmlElement[] }>();
      let next = 40;
      return (_rpc, { operation }) => {
        if (operation?.name === 'partial-lock') {
          const id = next++;
          const selects = operation.childrenNamed('select', PL);
          // Lock what each select names (the fake treats each select as an instance-identifier).
          const nodes = selects.map((s) => new XmlElement({ ...s, name: 'locked-node', ns: PL }));
          locks.set(id, { selects, nodes });
          return { body: [x('lock-id', { xmlns: PL }, String(id)), ...nodes] };
        }
        if (operation?.name === 'partial-unlock') {
          locks.delete(Number(operation.child('lock-id', PL)!.text()));
          return 'ok';
        }
        if (operation?.name === 'get') {
          const partial = [...locks].map(([id, l]) =>
            x('partial-lock',
              x('lock-id', String(id)),
              x('locked-by-session', String(sessionId)),
              x('locked-time', '2026-11-07T00:00:00Z'),
              l.selects.map((s) => new XmlElement({ ...s, ns: MONITORING_NS })),
              l.nodes.map((n) => new XmlElement({ ...n, ns: MONITORING_NS })),
            ),
          );
          return { data: x('netconf-state', { xmlns: MONITORING_NS }, x('datastores', x('datastore', x('name', 'running'), x('locks', partial)))) };
        }
        return 'ok';
      };
    }

    it('reports the same lock-id, holder and locked nodes, and drops the lock once unlocked', async () => {
      const { client } = await open(lockingServer(7), CAPS, 7);
      const lock = await client.ops.partialLock.lock([client.content.toXPath('/ietf-interfaces:interfaces/interface[name="eth0"]')]);
      const [running] = await client.content.monitoring.datastores();
      expect(running!.partialLocks).toEqual([
        {
          lockId: lock.lockId,
          sessionId: client.session.sessionId,
          lockedTime: '2026-11-07T00:00:00Z',
          select: ["/ietf-interfaces:interfaces/ietf-interfaces:interface[ietf-interfaces:name='eth0']"],
          lockedNodes: lock.lockedNodes,
        },
      ]);
      await lock.unlock();
      expect((await client.content.monitoring.datastores())[0]!.partialLocks).toEqual([]);
    });
  });
});

describe('client.content.toXPath() and pathXPath (OPS-22)', () => {
  it('turns a YANG path into a prefixed instance-identifier with its namespaces', async () => {
    const { client } = await open();
    expect(client.content.toXPath('/ietf-interfaces:interfaces/interface[name="eth0"]/description')).toEqual(
      xpath("/ietf-interfaces:interfaces/ietf-interfaces:interface[ietf-interfaces:name='eth0']/ietf-interfaces:description", {
        'ietf-interfaces': IF,
      }),
    );
  });

  it("quotes a value holding ' with \", and refuses one holding both", async () => {
    const { client } = await open();
    expect(client.content.toXPath(`/ietf-interfaces:interfaces/interface[name="it's"]`).select).toBe(
      `/ietf-interfaces:interfaces/ietf-interfaces:interface[ietf-interfaces:name="it's"]`,
    );
    // A YANG path can't hold both quotes in one value, but resolved steps built another way can.
    const step = { module: 'ietf-interfaces', moduleName: 'ietf-interfaces', ns: IF, name: 'interface', keys: [{ name: 'name', value: `say "it's"` }], value: undefined };
    expect(() => pathXPath([step])).toThrow(PathError);
    expect(() => pathXPath([])).toThrow(PathError);
  });

  it('writes a leaf-list value predicate and refuses an unknown module', async () => {
    const { client } = await open();
    expect(client.content.toXPath('/ietf-interfaces:interfaces/tag[.="core"]').select).toBe("/ietf-interfaces:interfaces/ietf-interfaces:tag[.='core']");
    expect(() => client.content.toXPath('/nope:top')).toThrow(PathError);
  });
});
