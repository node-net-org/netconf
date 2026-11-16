/**
 * An in-process, scriptable NETCONF server for tests (design §12).
 *
 * It speaks real RFC 6242 framing over an in-memory connection pair, and needs
 * nothing from Node.js. Hand `server.transport()` to connect(), or use
 * `server.connection` (the client's end) directly. Adversarial tests can
 * bypass the protocol with sendRaw().
 */

import { CapabilitySet } from '../messages/capabilities.js';
import { BASE_1_0, BASE_1_1, NETCONF_NS, NOTIFICATION_NS, type BaseVersion } from '../messages/constants.js';
import { negotiateBaseVersion } from '../messages/hello.js';
import { FrameDecoder, encodeMessage, type FramingMode } from '../transport/framing/index.js';
import { connectionPair, type Connection, type ConnectionFactory } from '../transport/index.js';
import { parseXml, serializeXml, x, XML_NS, XmlElement, type XmlNode } from '../xml/index.js';

export { NOTIFICATION_NS };

/** One `<rpc-error>` for a handler to return, as `{ errors: [...] }` (RFC 6241 §4.3). */
export interface RpcErrorSpec {
  /** `<error-type>`: the layer where the error occurred. */
  readonly type: 'transport' | 'rpc' | 'protocol' | 'application';
  /** `<error-tag>`, such as `operation-failed` or `lock-denied`. */
  readonly tag: string;
  /** `<error-severity>`. Default `'error'`. */
  readonly severity?: 'error' | 'warning';
  /** `<error-app-tag>`: a more specific, data-model-defined condition. */
  readonly appTag?: string;
  /** `<error-path>`: the XPath of the element the error is about. */
  readonly path?: string;
  /** `<error-message>`, sent with `xml:lang="en"`. */
  readonly message?: string;
  /** The children of `<error-info>`. */
  readonly info?: readonly XmlNode[];
}

/**
 * What a handler returns:
 * - `'ok'`: `<ok/>`
 * - `{ data }`: `<data>…</data>`
 * - `{ errors }`: one `<rpc-error>` per entry
 * - `{ body }`: these children, verbatim
 * - `undefined`: send no reply at all (to test timeouts)
 *
 * A handler that throws produces an `operation-failed` error.
 */
export type RpcHandlerResult =
  | 'ok'
  | {
      /** The content of `<data>`. */
      readonly data: XmlNode | readonly XmlNode[];
    }
  | {
      /** One `<rpc-error>` per entry. */
      readonly errors: readonly RpcErrorSpec[];
    }
  | {
      /** The `<rpc-reply>` children, sent verbatim. */
      readonly body: readonly XmlNode[];
    }
  | undefined;

/** What an {@link RpcHandler} gets with each request, besides the `<rpc>` element. */
export interface RpcHandlerContext {
  /** The `message-id` attribute of the request, if any. */
  readonly messageId: string | undefined;
  /** The operation element: the first child of `<rpc>`. */
  readonly operation: XmlElement | undefined;
  /** The server answering, for sending notifications or ending the session from a handler. */
  readonly server: FakeServer;
}

/**
 * Answers each `<rpc>` the server receives, given the `<rpc>` element. See
 * {@link RpcHandlerResult} for what it can return, and [Replies](/guide/testing#replies).
 */
export type RpcHandler = (rpc: XmlElement, ctx: RpcHandlerContext) => RpcHandlerResult | Promise<RpcHandlerResult>;

/** Options for a {@link FakeServer}. */
export interface FakeServerOptions {
  /** The session id sent in the server hello. Default 1. */
  readonly sessionId?: number;
  /** Server capabilities. Default: base 1.0 and 1.1. */
  readonly capabilities?: readonly string[];
  /** Called for every `<rpc>` except `<close-session>`. Default: reply `<ok/>`. */
  readonly handler?: RpcHandler;
  /** Replace the server hello with this raw text (EOM-framed for you), or `false` to send none. */
  readonly hello?: string | false;
}

const PEER = { host: 'fake-server', port: 0 } as const;
const ENCODER = new TextEncoder();

/**
 * An in-process, scriptable NETCONF server for tests, with no network and no
 * device. It speaks real RFC 6242 framing over an in-memory connection: pass
 * `server.transport()` to `connect()`, answer requests with a
 * {@link RpcHandler}, then check `requests` and `problems`. Each server serves
 * one connection. See [Testing your code](/guide/testing).
 */
export class FakeServer {
  /** The client's end of the connection. */
  readonly connection: Connection;
  /** Every `<rpc>` received, in arrival order. */
  readonly requests: XmlElement[] = [];
  /** Problems the server hit (bad framing, bad XML). Tests can assert this stays empty. */
  readonly problems: Error[] = [];
  /** Resolves with the client's `<hello>`. */
  readonly clientHello: Promise<XmlElement>;
  /** The session id sent in the server hello. */
  readonly sessionId: number;
  /** The capabilities the server advertises in its hello (unless `hello` replaces the hello). */
  readonly capabilities: CapabilitySet;

  private readonly serverEnd: Connection;
  private readonly decoder = new FrameDecoder();
  private readonly handler: RpcHandler;
  private mode: FramingMode = 'eom';
  private negotiated: BaseVersion | undefined;
  /** Messages sent before the client's hello: the framing isn't known yet. */
  private held: string[] | undefined = [];
  private resolveHello!: (el: XmlElement) => void;

  constructor(options: FakeServerOptions = {}) {
    const [client, server] = connectionPair({ client: PEER, server: { host: 'fake-client', port: 0 } });
    this.connection = client;
    this.serverEnd = server;
    this.sessionId = options.sessionId ?? 1;
    this.capabilities = new CapabilitySet(options.capabilities ?? [BASE_1_0, BASE_1_1]);
    this.handler = options.handler ?? (() => 'ok');
    this.clientHello = new Promise((resolve) => (this.resolveHello = resolve));

    server.receive({
      data: (chunk) => this.onData(chunk),
      end: () => undefined,
      close: (err) => {
        if (err !== undefined) this.problems.push(err);
      },
    });

    if (options.hello !== false) {
      const hello =
        options.hello ??
        serializeXml(
          x('hello', { xmlns: NETCONF_NS },
            x('capabilities', this.capabilities.toArray().map((c) => x('capability', c))),
            x('session-id', String(this.sessionId)),
          ),
          { declaration: true },
        );
      this.sendRaw(encodeMessage(hello, 'eom'));
    }
  }

  /**
   * A transport factory for `connect({ transport: server.transport() })`.
   * It can be used once, since the server serves a single connection.
   */
  transport(): ConnectionFactory {
    return () => Promise.resolve(this.connection);
  }

  /** The base version agreed after the client hello, if it has arrived. */
  get version(): BaseVersion | undefined {
    return this.negotiated;
  }

  /**
   * Send a message in the framing agreed with the client. Until the client's
   * hello arrives that framing isn't known (RFC 6242 §4.1), so a message sent
   * earlier is held and sent, in order, once it is. Use sendRaw() to send
   * before the hello on purpose.
   */
  send(message: XmlElement | string): void {
    const text = typeof message === 'string' ? message : serializeXml(message, { declaration: true });
    if (this.held !== undefined) this.held.push(text);
    else this.sendRaw(encodeMessage(text, this.mode));
  }

  /** Write bytes with no framing applied. */
  sendRaw(bytes: string | Uint8Array): void {
    this.serverEnd.write(typeof bytes === 'string' ? ENCODER.encode(bytes) : bytes);
  }

  /** Send an RFC 5277 `<notification>`. */
  notify(content: XmlElement, eventTime = new Date().toISOString()): void {
    this.send(x('notification', { xmlns: NOTIFICATION_NS }, x('eventTime', eventTime), content));
  }

  /** Close the connection cleanly from the server side. */
  end(): void {
    this.serverEnd.end();
  }

  /** Abort the connection from the server side, as if the link dropped. `err`, if given, is recorded in `problems`. */
  destroy(err?: Error): void {
    if (err !== undefined) this.problems.push(err);
    this.serverEnd.destroy();
  }

  private onData(chunk: Uint8Array): void {
    try {
      this.decoder.push(chunk);
      for (let msg = this.decoder.next(); msg !== undefined; msg = this.decoder.next()) {
        this.onMessage(parseXml(msg));
      }
    } catch (err) {
      this.problems.push(err as Error);
      this.serverEnd.destroy();
    }
  }

  private onMessage(el: XmlElement): void {
    if (this.negotiated === undefined) {
      if (el.name !== 'hello') throw new Error(`Expected client <hello>, got <${el.name}>`);
      const client = new CapabilitySet(
        (el.child('capabilities')?.childrenNamed('capability') ?? []).map((c) => c.text()),
      );
      this.negotiated = negotiateBaseVersion(client, this.capabilities);
      if (this.negotiated === '1.1') {
        this.mode = 'chunked';
        this.decoder.setMode('chunked');
      }
      const held = this.held ?? [];
      this.held = undefined;
      for (const text of held) this.send(text);
      this.resolveHello(el);
      return;
    }
    if (el.name !== 'rpc' || el.ns !== NETCONF_NS) throw new Error(`Expected <rpc>, got <${el.name}>`);
    this.requests.push(el);
    void this.answer(el);
  }

  private async answer(rpc: XmlElement): Promise<void> {
    const operation = rpc.elements[0];
    let result: RpcHandlerResult;
    if (operation?.name === 'close-session' && operation.ns === NETCONF_NS) {
      this.reply(rpc, 'ok');
      this.end();
      return;
    }
    try {
      result = await this.handler(rpc, { messageId: rpc.attr('message-id'), operation, server: this });
    } catch (err) {
      result = { errors: [{ type: 'application', tag: 'operation-failed', message: (err as Error).message }] };
    }
    if (result !== undefined) this.reply(rpc, result);
  }

  private reply(rpc: XmlElement, result: Exclude<RpcHandlerResult, undefined>): void {
    let body: XmlNode[];
    if (result === 'ok') body = [x('ok')];
    else if ('data' in result) body = [x('data', result.data)];
    else if ('errors' in result) body = result.errors.map(rpcErrorElement);
    else body = [...result.body];
    // RFC 6241 §4.2: the reply carries every attribute of the request.
    this.send(new XmlElement({ name: 'rpc-reply', ns: NETCONF_NS, attributes: rpc.attributes, children: body }));
  }
}

function rpcErrorElement(e: RpcErrorSpec): XmlElement {
  return x('rpc-error',
    x('error-type', e.type),
    x('error-tag', e.tag),
    x('error-severity', e.severity ?? 'error'),
    e.appTag !== undefined && x('error-app-tag', e.appTag),
    e.path !== undefined && x('error-path', e.path),
    e.message !== undefined && x('error-message', { lang: { ns: XML_NS, prefix: 'xml', value: 'en' } }, e.message),
    e.info !== undefined && x('error-info', e.info),
  );
}
