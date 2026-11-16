/**
 * A transport connection to a NETCONF server (design §5.1): the RFC 6241 §2.1
 * "persistent connection", with authentication and encryption already done.
 *
 * A connection only moves bytes. Framing (transport/framing) sits on top of it,
 * and the hello and everything above belong to the messages layer, so SSH,
 * TLS, call home, an in-memory pair or a test harness all fit here.
 *
 * The interface is the library's own rather than a Node.js stream, so it works
 * in any JavaScript runtime: duplexConnection() adapts a Node stream to it, and
 * connectionPair() makes two connected in-memory ends.
 */
export interface Connection {
  /** Who we're talking to, for logs and errors. */
  readonly peer: ConnectionPeer;
  /**
   * Start receiving. Called once: a second receiver throws. Bytes that arrived
   * before it are held and delivered to it, so none are lost. Nothing is
   * delivered during the call itself, only afterwards, so the caller can
   * finish setting up first.
   */
  receive(receiver: ConnectionReceiver): void;
  /** Send bytes. Sends nothing, and doesn't throw, once the connection has ended or closed. */
  write(bytes: Uint8Array): void;
  /** End our sending side. What the peer sends is still delivered until it closes. Idempotent. */
  end(): void;
  /** Drop the connection at once, with no grace period. Idempotent. */
  destroy(): void;
  /** Close the connection and anything underneath it (such as the SSH connection). Idempotent; never rejects. */
  close(): Promise<void>;
}

/** What a connection delivers to. Called synchronously, in order. */
export interface ConnectionReceiver {
  /** Bytes received. The array is the receiver's to keep. */
  data(chunk: Uint8Array): void;
  /** The peer ended its sending side: no more data follows. close() comes when the connection closes. */
  end(): void;
  /** The connection is gone: called exactly once, last, with the error when it failed. */
  close(error?: Error): void;
}

/** Who a connection talks to, for logs and errors. */
export interface ConnectionPeer {
  /** The host name or address, as given to connect (`'memory'` for an in-memory pair). */
  readonly host: string;
  /** The port (0 for an in-memory pair). */
  readonly port: number;
  /** Transport-specific identity, such as the SSH host-key fingerprint. */
  readonly identity?: string;
}

/**
 * Opens a connection. connect() passes a signal that aborts on its connect
 * timeout or the caller's signal; the factory must give up promptly when it does.
 */
export type ConnectionFactory = (signal: AbortSignal) => Promise<Connection>;
