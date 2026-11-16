import { describe, expect, it } from 'vitest';
import {
  BASE_1_0,
  BASE_1_1,
  CapabilitySet,
  NETCONF_NS,
  openSession,
  ProtocolError,
  serializeXml,
  x,
  type ServerHello,
} from '../../src/index.js';
import { FakeServer } from '../../src/testing/index.js';
import { watchConnection } from '../support/connections.js';

const CANDIDATE = 'urn:ietf:params:netconf:capability:candidate:1.0';

/** The messages layer on its own: a Session needs only a Connection (design §3.1). */
describe('openSession (messages layer without NetconfClient)', () => {
  it('runs the hello and raw RPCs over a bare connection', async () => {
    const server = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1, CANDIDATE], sessionId: 7 });
    const connection = await server.transport()(new AbortController().signal);
    const session = await openSession(connection);
    try {
      expect(session.sessionId).toBe(7);
      expect(session.baseVersion).toBe('1.1');
      expect(server.version).toBe('1.1');
      const reply = await session.rpc(x('get-config', { xmlns: NETCONF_NS }, x('source', x('running'))));
      expect(reply.ok).toBe(true);
      expect(serializeXml(server.requests[0]!.elements[0]!)).toContain('<get-config');
      // Operations live in the layer above, not on the session.
      expect('getConfig' in session).toBe(false);
    } finally {
      await session.close();
    }
    expect(session.state).toBe('closed');
  });

  it('lets the hello hook correct capabilities and set quirks before the session opens', async () => {
    const server = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
    const connection = await server.transport()(new AbortController().signal);
    let seen: ServerHello | undefined;
    const session = await openSession(connection, {
      onHello: (hello) => {
        seen = hello;
        return { capabilities: new CapabilitySet([...hello.capabilities.toArray(), CANDIDATE]) };
      },
    });
    try {
      expect(seen?.capabilities.has(':candidate')).toBe(false);
      expect(session.advertisedCapabilities.has(':candidate')).toBe(false);
      expect(session.serverCapabilities.has(':candidate')).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('fails the hello, and closes the connection, if the hook throws', async () => {
    const server = new FakeServer({ capabilities: [BASE_1_0] });
    const watched = watchConnection(await server.transport()(new AbortController().signal));
    await expect(
      openSession(watched.connection, {
        onHello: () => {
          throw new Error('no thanks');
        },
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof ProtocolError && (err.cause as Error).message === 'no thanks');
    await new Promise((r) => setImmediate(r));
    expect(watched.closed).toBe(true);
  });
});
