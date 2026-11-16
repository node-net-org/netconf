/**
 * The message channel (design §5.2): a Connection with RFC 6242 framing on top.
 *
 * This is the transport layer's whole interface to the messages layer. It
 * delivers whole messages as strings and frames outgoing ones; it never sees
 * XML. Framing starts in end-of-message mode, and the Session switches it to
 * chunked once the hello exchange has agreed base:1.1.
 */

import { NetconfError, ProtocolError, SessionClosedError, TransportError } from '../errors.js';
import { DEFAULT_MAX_MESSAGE_BYTES, encodeMessage, FrameDecoder, type FramingMode } from './framing/index.js';
import type { Connection, ConnectionPeer } from './types.js';

/** Options for {@link openChannel}. */
export interface ChannelOptions {
  /** Largest message accepted, in bytes; see `DecoderOptions.maxMessageBytes`. Default 64 MiB. */
  readonly maxMessageBytes?: number;
}

/** What the channel calls back into. Called synchronously, in order. */
export interface ChannelHandler {
  /** A whole message. If this throws, the channel ends with the error. */
  message(text: string): void;
  /**
   * The channel can no longer deliver messages: the connection failed or
   * closed, or the framing broke. Called at most once, and never after destroy().
   */
  end(reason: NetconfError): void;
}

/**
 * A connection with RFC 6242 framing on top: it delivers whole messages and
 * frames outgoing ones. Open one with {@link openChannel}.
 */
export interface MessageChannel {
  /** Who the underlying connection talks to. */
  readonly peer: ConnectionPeer;
  /** The current framing mode. */
  readonly framing: FramingMode;
  /**
   * Frame a message without sending it, so a caller can find out before
   * committing to a send whether it can be framed at all.
   * @throws FramingError if EOM framing can't carry it (it contains `]]>]]>`).
   */
  encode(message: string): Uint8Array;
  /** Write a message framed by encode(). */
  write(framed: Uint8Array): void;
  /** Switch both directions to chunked framing. Takes effect from the next message. */
  useChunkedFraming(): void;
  /** Stop delivering messages and drop the stream at once. Idempotent. */
  destroy(): void;
  /** Close the underlying connection. Idempotent; never rejects. */
  close(): Promise<void>;
}

/**
 * Put RFC 6242 framing on a connection: `handler` receives each whole message
 * as a string. Framing starts in end-of-message mode; call
 * `useChunkedFraming()` once the hello exchange has agreed base:1.1. See
 * [The framed message channel](/guide/low-level).
 */
export function openChannel(connection: Connection, handler: ChannelHandler, options: ChannelOptions = {}): MessageChannel {
  return new FramedChannel(connection, handler, options);
}

class FramedChannel implements MessageChannel {
  readonly peer: ConnectionPeer;
  private mode: FramingMode = 'eom';
  private readonly decoder: FrameDecoder;
  private done = false;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly connection: Connection,
    private readonly handler: ChannelHandler,
    options: ChannelOptions,
  ) {
    this.peer = connection.peer;
    this.decoder = new FrameDecoder({ maxMessageBytes: options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES });
    // One receiver, attached before anything is written (fork defect a).
    connection.receive({
      data: (chunk) => this.onData(chunk),
      end: () => this.end(new SessionClosedError('The server closed the connection')),
      close: (err) =>
        this.end(
          err === undefined
            ? new SessionClosedError('The connection closed')
            : // A transport that already classified its failure (e.g. tls(): AuthenticationError) keeps its type.
              err instanceof NetconfError
              ? err
              : new TransportError(`Transport error: ${err.message}`, { cause: err }),
        ),
    });
  }

  get framing(): FramingMode {
    return this.mode;
  }

  encode(message: string): Uint8Array {
    return encodeMessage(message, this.mode);
  }

  write(framed: Uint8Array): void {
    if (!this.done) this.connection.write(framed);
  }

  useChunkedFraming(): void {
    // Exactly between messages: everything decoded from here on is chunked.
    this.decoder.setMode('chunked');
    this.mode = 'chunked';
  }

  destroy(): void {
    this.done = true;
    this.connection.destroy();
  }

  close(): Promise<void> {
    this.done = true;
    this.closing ??= this.connection.close().catch(() => undefined);
    return this.closing;
  }

  private onData(chunk: Uint8Array): void {
    if (this.done) return;
    try {
      this.decoder.push(chunk);
      for (let text = this.decoder.next(); text !== undefined; text = this.decoder.next()) {
        this.handler.message(text);
        // The handler may have destroyed the channel.
        if (this.done) return;
      }
    } catch (err) {
      this.end(err instanceof NetconfError ? err : new ProtocolError('Failed to process a message', { cause: err }));
    }
  }

  private end(reason: NetconfError): void {
    if (this.done) return;
    this.done = true;
    this.handler.end(reason);
  }
}
