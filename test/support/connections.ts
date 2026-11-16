/**
 * Test helpers for the Connection interface: watch a connection being closed,
 * or filter what is written through it, without taking its one receiver.
 */
import type { Connection } from '../../src/index.js';

export interface WatchedConnection {
  readonly connection: Connection;
  /** True once the connection was dropped or closed by its user, or closed under it. */
  readonly closed: boolean;
}

/** Wrap `inner` so a test can see whether it was closed. `filter` may drop writes. */
export function watchConnection(inner: Connection, filter: (bytes: Uint8Array) => boolean = () => true): WatchedConnection {
  let closed = false;
  const connection: Connection = {
    peer: inner.peer,
    receive(r) {
      inner.receive({
        data: (chunk) => r.data(chunk),
        end: () => r.end(),
        close: (err) => {
          closed = true;
          r.close(err);
        },
      });
    },
    write(bytes) {
      if (filter(bytes)) inner.write(bytes);
    },
    end() {
      inner.end();
    },
    destroy() {
      closed = true;
      inner.destroy();
    },
    close() {
      closed = true;
      return inner.close();
    },
  };
  return {
    connection,
    get closed() {
      return closed;
    },
  };
}

export const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
