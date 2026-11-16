/**
 * RFC 6022 monitoring as an extension (OPS-16, OPS-13), against the fake server.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BASE_1_0,
  BASE_1_1,
  CapabilityError,
  connect,
  parseXml,
  ProtocolError,
  RpcError,
  serializeXml,
  XmlError,
  x,
  type XmlElement,
} from '../../src/index.js';
import { MONITORING_NS, monitoring } from '../../src/operations/monitoring.js';
import { FakeServer, type RpcHandler } from '../../src/testing/index.js';

const NCM = MONITORING_NS;
const CAPS = [BASE_1_0, BASE_1_1, `${NCM}?module=ietf-netconf-monitoring&revision=2010-10-04`];

async function open(handler: RpcHandler = () => 'ok', capabilities = CAPS) {
  const fake = new FakeServer({ capabilities, handler });
  const client = await connect({ transport: fake.transport(), extensions: [monitoring] });
  return { fake, client };
}

const lastOp = (fake: FakeServer): XmlElement => fake.requests.at(-1)!.elements[0]!;
const state = (xml: string) => ({ data: parseXml(`<netconf-state xmlns="${NCM}" xmlns:ncm="${NCM}">${xml}</netconf-state>`) });

describe('monitoring extension (OPS-16)', () => {
  it('requires ietf-netconf-monitoring', async () => {
    const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
    await expect(connect({ transport: fake.transport(), extensions: [monitoring] })).rejects.toThrow(CapabilityError);
  });

  describe('getSchema', () => {
    it('sends <get-schema> in the monitoring namespace, leaving out version and format when not given', async () => {
      const { fake, client } = await open(() => ({ body: [x('data', { xmlns: NCM }, 'module a {}')] }));
      await client.ops.monitoring.getSchema({ identifier: 'a' });
      expect(serializeXml(lastOp(fake))).toBe(`<get-schema xmlns="${NCM}"><identifier>a</identifier></get-schema>`);
      await client.ops.monitoring.getSchema({ identifier: 'a', version: '2020-01-01', format: 'yang' });
      expect(serializeXml(lastOp(fake))).toBe(
        `<get-schema xmlns="${NCM}"><identifier>a</identifier><version>2020-01-01</version><format>yang</format></get-schema>`,
      );
      await client.close();
    });

    it('resolves YANG as decoded text, including escaped characters and CDATA', async () => {
      const raw = `<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><data xmlns="${NCM}">module a { description "x &lt; y &amp; z"; <![CDATA[// <raw>]]>}</data></rpc-reply>`;
      const { client } = await open(() => ({ body: parseXml(raw).children }));
      const text = await client.ops.monitoring.getSchema({ identifier: 'a' });
      expectTypeOf(text).toEqualTypeOf<string>();
      expect(text).toBe('module a { description "x < y & z"; // <raw>}');
      await client.close();
    });

    it('resolves XML formats with the root element, sent as elements or as escaped text', async () => {
      const YIN = 'urn:ietf:params:xml:ns:yang:yin:1';
      const replies = [
        () => ({ body: [x('data', { xmlns: NCM }, x('module', { xmlns: YIN, name: 'a' }))] }),
        () => ({ body: [x('data', { xmlns: NCM }, `<?xml version="1.0"?>\n<module xmlns="${YIN}" name="b"><namespace uri="urn:b"/></module>`)] }),
        () => ({ body: [x('data', { xmlns: NCM }, '<!DOCTYPE m [<!ENTITY e "x">]><module/>')] }),
      ];
      const { client } = await open(() => replies.shift()!());
      const yin = await client.ops.monitoring.getSchema({ identifier: 'a', format: 'yin' });
      expectTypeOf(yin).toEqualTypeOf<XmlElement>();
      expect([yin.name, yin.ns, yin.attr('name')]).toEqual(['module', YIN, 'a']);
      const fromText = await client.ops.monitoring.getSchema({ identifier: 'b', format: 'yin' });
      expect([fromText.name, fromText.ns, fromText.attr('name'), fromText.child('namespace')?.attr('uri')]).toEqual(['module', YIN, 'b', 'urn:b']);
      // Escaped text goes through the hardened parser: DOCTYPE is refused.
      await expect(client.ops.monitoring.getSchema({ identifier: 'c', format: 'xsd' })).rejects.toThrow(XmlError);
      await client.close();
    });

    it('accepts <data> in the base namespace too, and rejects a reply with none', async () => {
      const replies = [() => ({ data: 'module b {}' }), () => 'ok' as const];
      const { client } = await open(() => replies.shift()!());
      await expect(client.ops.monitoring.getSchema({ identifier: 'b' })).resolves.toBe('module b {}');
      await expect(client.ops.monitoring.getSchema({ identifier: 'b' })).rejects.toThrow(ProtocolError);
      await client.close();
    });

    it('surfaces invalid-value and data-not-unique as RpcError', async () => {
      const errors = [
        { type: 'protocol' as const, tag: 'invalid-value' },
        { type: 'protocol' as const, tag: 'operation-failed', appTag: 'data-not-unique' },
      ];
      const { client } = await open(() => ({ errors: [errors.shift()!] }));
      await expect(client.ops.monitoring.getSchema({ identifier: 'nope' })).rejects.toMatchObject({ errors: [{ tag: 'invalid-value' }] });
      const err = await client.ops.monitoring.getSchema({ identifier: 'dup' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).errors[0]).toMatchObject({ tag: 'operation-failed', appTag: 'data-not-unique' });
      await client.close();
    });

    it('rejects bad arguments before sending', async () => {
      const { fake, client } = await open();
      await expect(client.ops.monitoring.getSchema({ identifier: '' })).rejects.toThrow(TypeError);
      await expect(client.ops.monitoring.getSchema({ identifier: 'a', format: 'json' as never })).rejects.toThrow(TypeError);
      expect(fake.requests).toHaveLength(0);
      await client.close();
    });
  });

  describe('get-schema as a described operation (OPS-13)', () => {
    it('is listed in client.ops.list as plain data, from the monitoring extension', async () => {
      const { client } = await open();
      const d = client.ops.list.find((o) => o.name === 'get-schema')!;
      expect(d).toMatchObject({ extension: 'monitoring', namespace: NCM, method: 'getSchema', mutates: false, requires: [NCM] });
      expect(d.params.map((p) => [p.name, p.kind, p.required ?? false])).toEqual([
        ['identifier', 'positional', true],
        ['version', 'option', false],
        ['format', 'option', false],
      ]);
      expect(JSON.parse(JSON.stringify(d))).toEqual(d);
      await client.close();
    });

    it('ops.run sends the same XML as the method', async () => {
      const { fake, client } = await open(() => ({ body: [x('data', { xmlns: NCM }, 'm')] }));
      await client.ops.run('get-schema', { identifier: 'a', version: 'v', format: 'rnc' });
      const viaDescriptor = serializeXml(lastOp(fake));
      await client.ops.monitoring.getSchema({ identifier: 'a', version: 'v', format: 'rnc' });
      expect(serializeXml(lastOp(fake))).toBe(viaDescriptor);
      await client.close();
    });
  });

  describe('/netconf-state reads', () => {
    it('each read sends a <get> filtered to its own subtree', async () => {
      const { fake, client } = await open(() => ({ data: [] }));
      for (const [read, part] of [
        [() => client.content.monitoring.schemas(), 'schemas'],
        [() => client.content.monitoring.sessions(), 'sessions'],
        [() => client.content.monitoring.datastores(), 'datastores'],
        [() => client.content.monitoring.statistics(), 'statistics'],
      ] as const) {
        await read();
        expect(serializeXml(lastOp(fake))).toBe(
          `<get xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><filter type="subtree"><netconf-state xmlns="${NCM}"><${part}/></netconf-state></filter></get>`,
        );
      }
      await client.close();
    });

    it('schemas(): module-qualifies the format identity and lists locations', async () => {
      const { client } = await open(() =>
        state(`<schemas>
          <schema><identifier>ietf-interfaces</identifier><version>2018-02-20</version><format>ncm:yang</format>
            <namespace>urn:ietf:params:xml:ns:yang:ietf-interfaces</namespace><location>NETCONF</location><location>https://x/y.yang</location></schema>
          <schema><identifier>nover</identifier><version/><format>yin</format><namespace>urn:n</namespace></schema>
          <schema><version>broken</version></schema>
        </schemas>`),
      );
      expect(await client.content.monitoring.schemas()).toEqual([
        { identifier: 'ietf-interfaces', version: '2018-02-20', format: 'ietf-netconf-monitoring:yang', namespace: 'urn:ietf:params:xml:ns:yang:ietf-interfaces', locations: ['NETCONF', 'https://x/y.yang'] },
        { identifier: 'nover', version: '', format: 'ietf-netconf-monitoring:yin', namespace: 'urn:n', locations: [] },
      ]);
      await client.close();
    });

    it('identities and locked nodes resolve prefixes the server declared only on <rpc-reply>', async () => {
      const IF = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
      const { client } = await open((_rpc, ctx) => {
        ctx.server.send(
          `<rpc-reply message-id="${ctx.messageId}" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" xmlns:m="${NCM}" xmlns:i="${IF}"><data>` +
            `<netconf-state xmlns="${NCM}"><sessions><session><session-id>7</session-id><transport>m:netconf-ssh</transport>` +
            `<username>u</username><login-time>t</login-time></session></sessions>` +
            `<datastores><datastore><name>running</name><locks><partial-lock><locked-by-session>7</locked-by-session><locked-time>t</locked-time>` +
            `<lock-id>3</lock-id><select>/i:interfaces</select><locked-node>/i:interfaces/i:interface[i:name='eth0']</locked-node></partial-lock></locks></datastore></datastores>` +
            `</netconf-state></data></rpc-reply>`,
        );
        return undefined;
      });
      expect((await client.content.monitoring.sessions())[0]!.transport).toBe('ietf-netconf-monitoring:netconf-ssh');
      const [running] = await client.content.monitoring.datastores();
      expect(running!.partialLocks[0]!.lockedNodes).toEqual(["/ietf-interfaces:interfaces/interface[name='eth0']"]);
      await client.close();
    });

    it('sessions(): numbers, transport identity, optional source host', async () => {
      const { client } = await open(() =>
        state(`<sessions>
          <session><session-id>7</session-id><transport>ncm:netconf-ssh</transport><username>netconf</username>
            <source-host>192.0.2.1</source-host><login-time>2026-11-07T00:00:00Z</login-time>
            <in-rpcs>4</in-rpcs><in-bad-rpcs>0</in-bad-rpcs><out-rpc-errors>1</out-rpc-errors><out-notifications>0</out-notifications></session>
          <session><session-id>8</session-id><transport>netconf-tls</transport><username>u</username><login-time>t</login-time></session>
        </sessions>`),
      );
      const sessions = await client.content.monitoring.sessions();
      expect(sessions[0]).toEqual({
        sessionId: 7, transport: 'ietf-netconf-monitoring:netconf-ssh', username: 'netconf', sourceHost: '192.0.2.1', loginTime: '2026-11-07T00:00:00Z',
        inRpcs: 4, inBadRpcs: 0, outRpcErrors: 1, outNotifications: 0,
      });
      // unprefixed: the default namespace in effect (RFC 7950 §9.10.3)
      expect(sessions[1]).toEqual({ sessionId: 8, transport: 'ietf-netconf-monitoring:netconf-tls', username: 'u', loginTime: 't' });
      expect('sourceHost' in sessions[1]!).toBe(false);
      await client.close();
    });

    it('datastores(): global lock holder (0 = non-NETCONF) and partial locks', async () => {
      const { client } = await open(() =>
        state(`<datastores>
          <datastore><name>running</name><locks><global-lock><locked-by-session>0</locked-by-session><locked-time>T1</locked-time></global-lock></locks></datastore>
          <datastore><name>candidate</name><locks>
            <partial-lock><lock-id>3</lock-id><locked-by-session>9</locked-by-session><locked-time>T2</locked-time>
              <select>/a</select><locked-node>/a/b</locked-node><locked-node>/a/c</locked-node></partial-lock></locks></datastore>
          <datastore><name>startup</name></datastore>
        </datastores>`),
      );
      expect(await client.content.monitoring.datastores()).toEqual([
        { name: 'running', globalLock: { sessionId: 0, lockedTime: 'T1' }, partialLocks: [] },
        { name: 'candidate', partialLocks: [{ sessionId: 9, lockedTime: 'T2', lockId: 3, select: ['/a'], lockedNodes: ['/a/b', '/a/c'] }] },
        { name: 'startup', partialLocks: [] },
      ]);
      await client.close();
    });

    it('statistics(): counters as numbers; an empty reply gives an empty object', async () => {
      const replies = [
        () => state(`<statistics><netconf-start-time>T0</netconf-start-time><in-bad-hellos>1</in-bad-hellos><in-sessions>12</in-sessions>
          <dropped-sessions>2</dropped-sessions><in-rpcs>40</in-rpcs><in-bad-rpcs>3</in-bad-rpcs><out-rpc-errors>5</out-rpc-errors><out-notifications>0</out-notifications></statistics>`),
        () => ({ data: [] }),
      ];
      const { client } = await open(() => replies.shift()!());
      expect(await client.content.monitoring.statistics()).toEqual({
        netconfStartTime: 'T0', inBadHellos: 1, inSessions: 12, droppedSessions: 2, inRpcs: 40, inBadRpcs: 3, outRpcErrors: 5, outNotifications: 0,
      });
      expect(await client.content.monitoring.statistics()).toEqual({});
      await client.close();
    });
  });
});
