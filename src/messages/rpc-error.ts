import { NetconfError } from '../errors.js';
import type { XmlElement } from '../xml/index.js';
import { NETCONF_NS } from './constants.js';

/** The layer an `<rpc-error>` occurred in (RFC 6241 §4.3 `error-type`). */
export type RpcErrorType = 'transport' | 'rpc' | 'protocol' | 'application';
/** An `<rpc-error>`'s `error-severity`: `'error'` fails the RPC, `'warning'` doesn't. */
export type RpcErrorSeverity = 'error' | 'warning';

/** The error tags defined in RFC 6241 Appendix A. Servers may send others. */
export type StandardErrorTag =
  | 'in-use'
  | 'invalid-value'
  | 'too-big'
  | 'missing-attribute'
  | 'bad-attribute'
  | 'unknown-attribute'
  | 'missing-element'
  | 'bad-element'
  | 'unknown-element'
  | 'unknown-namespace'
  | 'access-denied'
  | 'lock-denied'
  | 'resource-denied'
  | 'rollback-failed'
  | 'data-exists'
  | 'data-missing'
  | 'operation-not-supported'
  | 'operation-failed'
  | 'partial-operation'
  | 'malformed-message';

// `string & {}` keeps autocomplete for the standard tags while allowing any string.
/** An `<rpc-error>`'s `error-tag`: one of the {@link StandardErrorTag}s, or any other string a server sends. */
export type RpcErrorTag = StandardErrorTag | (string & {});

/** One `<rpc-error>` (RFC 6241 §4.3). */
export interface RpcErrorDetail {
  /** The layer the error occurred in (`error-type`). `'rpc'` if the server sent none. */
  readonly type: RpcErrorType | (string & {});
  /** The error condition (`error-tag`), such as `'lock-denied'`. `'operation-failed'` if the server sent none. */
  readonly tag: RpcErrorTag;
  /** `error-severity`; anything other than `warning` reads as `'error'`. */
  readonly severity: RpcErrorSeverity;
  /** The data-model or implementation-specific error condition (`error-app-tag`), if sent. */
  readonly appTag?: string;
  /**
   * An XPath expression locating the problem. Its prefixes resolve with the
   * namespace declarations in scope on `element` (RFC 6241 §4.3), which
   * include any the server declared on `<rpc-reply>`:
   * `element.lookupNamespace(prefix)`.
   */
  readonly path?: string;
  /** The human-readable description (`error-message`), trimmed, if sent. */
  readonly message?: string;
  /** The language of `message` (its `xml:lang`), such as `'en'`, if sent. */
  readonly messageLang?: string;
  /** `<error-info>` content, such as `<session-id>` for lock-denied or `<bad-element>`. */
  readonly info?: XmlElement;
  /** The original `<rpc-error>` element. */
  readonly element: XmlElement;
}

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export function parseRpcErrors(reply: XmlElement): RpcErrorDetail[] {
  return reply.childrenNamed('rpc-error', NETCONF_NS).map((el) => {
    const text = (name: string): string | undefined => el.child(name, NETCONF_NS)?.text().trim();
    const messageEl = el.child('error-message', NETCONF_NS);
    const severity = text('error-severity') === 'warning' ? 'warning' : 'error';
    const detail: Record<string, unknown> = {
      type: text('error-type') ?? 'rpc',
      tag: text('error-tag') ?? 'operation-failed',
      severity,
      element: el,
    };
    const appTag = text('error-app-tag');
    const path = text('error-path');
    const info = el.child('error-info', NETCONF_NS);
    if (appTag !== undefined) detail['appTag'] = appTag;
    if (path !== undefined) detail['path'] = path;
    if (messageEl !== undefined) {
      detail['message'] = messageEl.text().trim();
      const lang = messageEl.attr('lang', XML_NS);
      if (lang !== undefined) detail['messageLang'] = lang;
    }
    if (info !== undefined) detail['info'] = info;
    return detail as unknown as RpcErrorDetail;
  });
}

/**
 * The server answered with one or more `<rpc-error>`s of severity `error`.
 * See [RpcError](/guide/errors#rpcerror).
 */
export class RpcError extends NetconfError {
  /** Always `'RpcError'`. */
  override name = 'RpcError';
  override readonly code = 'ERR_NETCONF_RPC';
  /** Every error and warning in the reply, in order. */
  readonly errors: readonly RpcErrorDetail[];
  /** The `<rpc-reply>` element. */
  readonly reply: XmlElement;

  constructor(errors: readonly RpcErrorDetail[], reply: XmlElement) {
    super(describe(errors));
    this.errors = errors;
    this.reply = reply;
  }

  /** The first error-severity entry. */
  get first(): RpcErrorDetail {
    return this.errors.find((e) => e.severity === 'error') ?? this.errors[0]!;
  }

  /** The tag of the first error, e.g. `'lock-denied'`. */
  get tag(): RpcErrorTag {
    return this.first.tag;
  }
}

function describe(errors: readonly RpcErrorDetail[]): string {
  const real = errors.filter((e) => e.severity === 'error');
  const e = real[0] ?? errors[0];
  if (e === undefined) return 'rpc-error';
  let text = `${e.tag}${e.message ? `: ${e.message}` : ''}${e.path ? ` (at ${e.path})` : ''}`;
  if (real.length > 1) text += ` (and ${real.length - 1} more error${real.length > 2 ? 's' : ''})`;
  return text;
}
