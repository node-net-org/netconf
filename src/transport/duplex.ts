/**
 * A Connection over a Node.js duplex stream (design §5.1): how ssh() and tls()
 * hand their streams to the library, and how a caller with their own Node
 * transport (a socket, a child process's stdio, a tunnel) plugs it in.
 */

import type { Duplex } from 'node:stream';
import type { Connection, ConnectionPeer, ConnectionReceiver } from './types.js';

/** Options for {@link duplexConnection}. */
export interface DuplexConnectionOptions {
  /** Who the stream talks to, reported as the connection's `peer` for logs and errors. */
  readonly peer: ConnectionPeer;
  /**
   * Closes the stream and whatever is underneath it, gracefully. Default:
   * end the stream, then destroy it if it hasn't closed within a moment.
   */
  readonly close?: () => Promise<void>;
}

/**
 * Turn a Node.js duplex stream into a Connection. A stream `error` is
 * reported as the close's error at once, before the stream's own `close`, so
 * an error class the transport chose (such as an AuthenticationError) reaches
 * the session unchanged. See [Your own transport](/guide/low-level#your-own-transport).
 */
export function duplexConnection(stream: Duplex, options: DuplexConnectionOptions): Connection {
  let receiver: ConnectionReceiver | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = (error?: Error): void => {
    if (closed) return;
    closed = true;
    receiver?.close(error);
  };
  return {
    peer: options.peer,
    receive(r) {
      if (receiver !== undefined) throw new TypeError('This connection already has a receiver');
      receiver = r;
      // Until a 'data' listener is attached the stream holds what it receives, so nothing is lost.
      stream.on('data', (chunk: Uint8Array) => {
        if (!closed) r.data(chunk);
      });
      stream.on('end', () => {
        if (!closed) r.end();
      });
      stream.on('error', (err: Error) => close(err));
      stream.on('close', () => close());
      // Already gone: say so, but after receive() returns, as the contract requires.
      if (stream.destroyed) queueMicrotask(() => close(stream.errored ?? undefined));
    },
    write(bytes) {
      if (!closed && !stream.writableEnded && !stream.destroyed) stream.write(bytes);
    },
    end() {
      if (!stream.writableEnded && !stream.destroyed) stream.end();
    },
    destroy() {
      stream.destroy();
    },
    close() {
      closing ??= (options.close ?? (() => endThenDestroy(stream)))().catch(() => undefined);
      return closing;
    },
  };
}

const CLOSE_GRACE_MS = 2_000;

function endThenDestroy(stream: Duplex): Promise<void> {
  return new Promise<void>((resolve) => {
    if (stream.destroyed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => stream.destroy(), CLOSE_GRACE_MS);
    stream.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    stream.end();
  });
}
