/**
 * Session-level fuzzing: mutated and arbitrary hellos, replies,
 * rpc-errors and notifications from the server, fed through a real Session on
 * an in-memory connection.
 *
 * The framing decoders and parseXml are fuzzed on their own in
 * test/transport/framing-limits.test.ts and test/xml/parse-limits.test.ts. Here
 * the damaged messages are framed correctly, so they reach the messages layer:
 * hello parsing, reply correlation, rpc-error decoding and notification routing.
 *
 * The properties:
 * - every failure is a NetconfError, with no TypeError or RangeError in its
 *   cause chain (that would be a decoder crash the channel wrapped up);
 * - every RPC settles, and openSession() settles, within a bound;
 * - nothing becomes an unhandled rejection.
 */
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BASE_1_0,
  BASE_1_1,
  NETCONF_NS,
  NetconfError,
  NOTIFICATION_NS,
  openSession,
  x,
  type Connection,
  type Session,
} from '../../src/index.js';
import { connectionPair } from '../../src/transport/memory.js';
import { encodeMessage } from '../../src/transport/framing/index.js';

const RUNS = 150;
/** Longer than anything here should take; a settle that misses it is a hang. */
const SETTLE_MS = 2_000;

const CAPS = [BASE_1_0, BASE_1_1, 'urn:ietf:params:netconf:capability:candidate:1.0'];
const NC = `xmlns="${NETCONF_NS}"`;

const hello = (caps: readonly string[] = CAPS, sessionId = '7'): string =>
  `<?xml version="1.0" encoding="UTF-8"?><hello ${NC}><capabilities>` +
  caps.map((c) => `<capability>${c}</capability>`).join('') +
  `</capabilities><session-id>${sessionId}</session-id></hello>`;

/** Valid server messages to start mutating from. `{id}` is filled with a message-id. */
const TEMPLATES = [
  `<rpc-reply ${NC} message-id="{id}"><ok/></rpc-reply>`,
  `<rpc-reply ${NC} message-id="{id}"><data><top xmlns="urn:x"><a>1</a><b/></top></data></rpc-reply>`,
  `<rpc-reply ${NC} message-id="{id}"><rpc-error><error-type>application</error-type>` +
    `<error-tag>invalid-value</error-tag><error-severity>error</error-severity>` +
    `<error-app-tag>too-big</error-app-tag><error-path xmlns:t="urn:x">/t:top/t:a</error-path>` +
    `<error-message xml:lang="en">Value too big</error-message>` +
    `<error-info><bad-element>a</bad-element><session-id>3</session-id></error-info></rpc-error></rpc-reply>`,
  `<rpc-reply ${NC} message-id="{id}"><rpc-error><error-type>protocol</error-type>` +
    `<error-tag>access-denied</error-tag><error-severity>warning</error-severity></rpc-error>` +
    `<rpc-error><error-type>rpc</error-type><error-tag>operation-failed</error-tag>` +
    `<error-severity>error</error-severity></rpc-error></rpc-reply>`,
  `<rpc-reply ${NC}><rpc-error><error-type>rpc</error-type><error-tag>malformed-message</error-tag>` +
    `<error-severity>error</error-severity></rpc-error></rpc-reply>`,
  `<notification xmlns="${NOTIFICATION_NS}"><eventTime>2026-11-15T00:00:00Z</eventTime>` +
    `<event xmlns="urn:x"><n>1</n></event></notification>`,
  `<notification xmlns="${NOTIFICATION_NS}"><event xmlns="urn:x"/></notification>`,
  `<hello ${NC}><capabilities><capability>${BASE_1_1}</capability></capabilities></hello>`,
];

// --- Mutations ---------------------------------------------------------------

/** Characters that matter to XML and to framing, plus arbitrary text. */
const nasty = fc.oneof(
  fc.constantFrom('<', '>', '/', '&', '"', "'", '=', ' ', ':', '#', '\n', ']]>', ']]>]]>', '\u0000', '\u0007', '￿', '\uD800', '&amp;', '&#0;', '<!DOCTYPE x>', '<![CDATA[', '-->', 'xmlns="', 'message-id="'),
  fc.string({ maxLength: 8 }),
  fc.string({ unit: 'binary', maxLength: 8 }),
);

type Mutation = (s: string) => string;

const mutation: fc.Arbitrary<Mutation> = fc.oneof(
  fc.tuple(fc.nat(), nasty).map(([i, t]): Mutation => (s) => s.slice(0, i % (s.length + 1)) + t + s.slice(i % (s.length + 1))),
  fc.tuple(fc.nat(), nasty).map(([i, t]): Mutation => (s) => s.slice(0, i % (s.length + 1)) + t + s.slice((i % (s.length + 1)) + 1)),
  fc.tuple(fc.nat(), fc.nat({ max: 40 })).map(([i, n]): Mutation => (s) => s.slice(0, i % (s.length + 1)) + s.slice((i % (s.length + 1)) + n)),
  fc.nat().map((i): Mutation => (s) => s.slice(0, i % (s.length + 1))),
  fc.tuple(fc.nat(), fc.nat({ max: 40 })).map(([i, n]): Mutation => (s) => {
    const at = i % (s.length + 1);
    return s.slice(0, at) + s.slice(at, at + n) + s.slice(at);
  }),
  // Swap whole tags around, so the result is often still well-formed XML.
  fc.tuple(fc.nat(), fc.nat()).map(([a, b]): Mutation => (s) => {
    const tags = s.match(/<[^>]*>/g) ?? [];
    if (tags.length < 2) return s;
    const ta = tags[a % tags.length]!;
    const tb = tags[b % tags.length]!;
    return s.replace(ta, '\u0001').replace(tb, ta).replace('\u0001', tb);
  }),
);

const mutated = (base: fc.Arbitrary<string>): fc.Arbitrary<string> =>
  fc.tuple(base, fc.array(mutation, { minLength: 0, maxLength: 3 })).map(([s, ms]) => ms.reduce((acc, m) => m(acc), s));

// --- Harness -----------------------------------------------------------------

/** The server end of a pair: writes framed messages and can hang up. */
function serverEnd(server: Connection): { send(text: string, mode: 'eom' | 'chunked'): void; end(): void } {
  server.receive({ data: () => undefined, end: () => undefined, close: () => undefined });
  return {
    send(text, mode) {
      if (mode === 'eom') {
        // encodeMessage refuses ]]>]]> inside an EOM message; a server can't, so frame by hand.
        server.write(new TextEncoder().encode(text + ']]>]]>'));
      } else if (text !== '') {
        // A chunk can't be empty (RFC 6242 §4.2): an empty message is a framing
        // matter, fuzzed in framing-limits.test.ts, so it isn't sent here.
        server.write(encodeMessage(text, 'chunked'));
      }
    },
    end() {
      void server.close();
    },
  };
}

/** Resolve with how `p` settled, or fail the property if it hasn't within SETTLE_MS. */
async function settled<T>(p: Promise<T>, what: string): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const hang = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${SETTLE_MS} ms`)), SETTLE_MS);
  });
  try {
    return await Promise.race([p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })), hang]);
  } finally {
    clearTimeout(timer);
  }
}

const closedOf = (s: Session): Promise<void> =>
  new Promise((resolve) => {
    if (s.state === 'closed') resolve();
    else s.onClosed(() => resolve());
  });

/**
 * The error is a NetconfError, and its cause chain holds no programming error.
 * An XmlError may wrap the XML parser's own error; a TypeError or RangeError
 * anywhere would be a decoder crash that the channel turned into a
 * ProtocolError.
 */
function expectTyped(error: unknown): void {
  if (!(error instanceof NetconfError)) throw new Error(`Not a NetconfError: ${String(error)}`, { cause: error });
  const seen = new Set<unknown>();
  for (let e: unknown = error; e !== undefined && !seen.has(e); e = (e as { cause?: unknown }).cause) {
    seen.add(e);
    if (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError) {
      throw new Error(`A programming error in the cause chain: ${String(e)}`, { cause: error });
    }
  }
}

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});
afterEach(async () => {
  // Let any stray rejection reach the handler before checking.
  await new Promise((r) => setTimeout(r, 0));
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
});

describe('session-level fuzzing', () => {
  it('a damaged or arbitrary hello either opens the session or fails with a typed error', async () => {
    const helloText = fc.oneof(
      { weight: 4, arbitrary: mutated(fc.constantFrom(hello(), hello([BASE_1_0]), hello([BASE_1_1, 'urn:x:y']), hello(CAPS, '4294967295'))) },
      { weight: 1, arbitrary: fc.string({ maxLength: 200 }) },
      { weight: 1, arbitrary: mutated(fc.constantFrom(...TEMPLATES.map((t) => t.replace('{id}', '1')))) },
    );
    await fc.assert(
      fc.asyncProperty(helloText, async (text) => {
        const [client, server] = connectionPair();
        const srv = serverEnd(server);
        srv.send(text, 'eom');
        // A hello cut short never completes: the hello timeout must end it.
        const result = await settled(openSession(client, { timeouts: { hello: 200 } }), 'openSession');
        if (result.ok) {
          const s = result.value;
          expect(s.state).toBe('open');
          expect(['1.0', '1.1']).toContain(s.baseVersion);
          srv.end();
          expect((await settled(closedOf(s), 'session close')).ok).toBe(true);
        } else {
          expectTyped(result.error);
          srv.end();
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('damaged replies, rpc-errors and notifications settle every pending RPC with a value or a typed error', async () => {
    const message = fc.tuple(
      mutated(fc.constantFrom(...TEMPLATES)),
      fc.integer({ min: 0, max: 5 }),
    ).map(([t, id]) => t.replaceAll('{id}', String(id)));

    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.integer({ min: 1, max: 4 }),
        fc.array(message, { minLength: 1, maxLength: 6 }),
        async (chunked, rpcs, messages) => {
          const [client, server] = connectionPair();
          const srv = serverEnd(server);
          srv.send(hello(chunked ? CAPS : [BASE_1_0]), 'eom');
          const session: Session = await openSession(client, { timeouts: { hello: 1_000 } });
          expect(session.baseVersion).toBe(chunked ? '1.1' : '1.0');

          let notifications = 0;
          session.onNotification((n) => {
            notifications++;
            // What a listener reads from a damaged notification must not throw.
            void n.eventTime.length;
            void n.element.name;
          });

          const pending = Array.from({ length: rpcs }, () => session.rpc(x('get')));
          // These are the test's own promises: if an assertion fails before they
          // are awaited, that failure is the one to report, not their rejection.
          for (const p of pending) p.catch(() => undefined);
          for (const m of messages) srv.send(m, chunked ? 'chunked' : 'eom');
          // The server hangs up: whatever wasn't answered must now fail.
          srv.end();

          for (const [i, p] of pending.entries()) {
            const r = await settled(p, `rpc ${i + 1}`);
            if (!r.ok) expectTyped(r.error);
          }
          const closed = await settled(closedOf(session), 'session close');
          expect(closed.ok).toBe(true);
          expect(session.state).toBe('closed');
          expect(notifications).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('a session that stays open still settles RPCs whose replies were damaged, by timing them out', async () => {
    await fc.assert(
      fc.asyncProperty(mutated(fc.constantFrom(...TEMPLATES.slice(0, 4))), async (template) => {
        const [client, server] = connectionPair();
        const srv = serverEnd(server);
        srv.send(hello(), 'eom');
        const session = await openSession(client, { timeouts: { hello: 1_000 } });
        const p = session.rpc(x('get'), { timeout: 100 });
        p.catch(() => undefined);
        srv.send(template.replaceAll('{id}', '1'), 'chunked');
        const r = await settled(p, 'rpc');
        if (!r.ok) expectTyped(r.error);
        srv.end();
      }),
      { numRuns: 60 },
    );
  });
});
