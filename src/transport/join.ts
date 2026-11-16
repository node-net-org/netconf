import type { Connection } from './types.js';

/**
 * Splice two connections together: what either receives, the other sends;
 * when either ends its side, the other ends; when either closes, the other is
 * dropped. For example, serve a FakeServer over a real transport with
 * `joinConnections(duplexConnection(channel, { peer }), server.connection)`.
 */
export function joinConnections(a: Connection, b: Connection): void {
  const one = (from: Connection, to: Connection): void =>
    from.receive({
      data: (chunk) => to.write(chunk),
      end: () => to.end(),
      close: () => to.destroy(),
    });
  one(a, b);
  one(b, a);
}
