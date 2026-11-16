/**
 * Error hierarchy shared by every layer (design §5.6).
 *
 * This module is a leaf: it imports nothing else from the package, so any
 * layer can use it without creating a dependency cycle.
 */

/** Options for constructing a {@link NetconfError}. */
export interface NetconfErrorOptions {
  /** The underlying error or reason, kept as the error's `cause`. */
  readonly cause?: unknown;
}

/**
 * Base class of every error @node-net/netconf raises when a call with well-formed
 * arguments fails, through any entry point (YANG data errors included).
 *
 * Programming errors are deliberately outside it, so catching NetconfError
 * never hides a bug: malformed arguments and API misuse throw `TypeError`,
 * out-of-range values `RangeError`. An error thrown by the caller's own code
 * (a transaction callback, a keyboard-interactive handler, a secret
 * function) reaches the caller unchanged, or as the `cause` of the error
 * that reports it. See [Errors](/guide/errors).
 */
export class NetconfError extends Error {
  /** Always `'NetconfError'`. */
  override name = 'NetconfError';
  /** Stable, machine-readable error code. */
  readonly code: string = 'ERR_NETCONF';

  constructor(message: string, options?: NetconfErrorOptions) {
    super(message, options);
  }
}

/** Malformed XML, a forbidden construct (such as a DOCTYPE), or a parser limit was exceeded. */
export class XmlError extends NetconfError {
  /** Always `'XmlError'`. */
  override name = 'XmlError';
  override readonly code = 'ERR_NETCONF_XML';
}

/** A message violated RFC 6242 framing, or exceeded a size limit. Always fatal to the session. */
export class FramingError extends NetconfError {
  /** Always `'FramingError'`. */
  override name = 'FramingError';
  override readonly code = 'ERR_NETCONF_FRAMING';
}

/** The hello exchange failed: malformed hello, bad session-id, or no common base version. */
export class HelloError extends NetconfError {
  /** Always `'HelloError'`. */
  override name = 'HelloError';
  override readonly code = 'ERR_NETCONF_HELLO';
}

/** Connecting or keeping the connection failed (DNS, TCP, SSH or TLS). */
export class TransportError extends NetconfError {
  /** Always `'TransportError'`. */
  override name = 'TransportError';
  override readonly code: string = 'ERR_NETCONF_TRANSPORT';
}

/**
 * Why authentication failed: `'refused'`, the server rejected our credentials
 * (or ended authentication); `'key'`, our own private key couldn't be read or
 * decrypted (wrong or missing passphrase), so nothing was sent to the server;
 * `'prompt'`, the server asked a keyboard-interactive question the password
 * can't answer (pass `keyboardInteractive` to answer it).
 */
export type AuthenticationReason = 'refused' | 'key' | 'prompt';

/** Options for constructing an {@link AuthenticationError}. */
export interface AuthenticationErrorOptions extends NetconfErrorOptions {
  /** Default `'refused'`. */
  readonly reason?: AuthenticationReason;
}

/** Authentication failed. `reason` says whether the server refused us, our private key was unusable, or a prompt couldn't be answered. */
export class AuthenticationError extends TransportError {
  /** Always `'AuthenticationError'`. */
  override name = 'AuthenticationError';
  override readonly code = 'ERR_NETCONF_AUTH';
  /** Why authentication failed; see {@link AuthenticationReason}. */
  readonly reason: AuthenticationReason;

  constructor(message: string, options?: AuthenticationErrorOptions) {
    super(message, options);
    this.reason = options?.reason ?? 'refused';
  }
}

/** The server's host key didn't match, or no host-key policy was given. */
export class HostKeyError extends TransportError {
  /** Always `'HostKeyError'`. */
  override name = 'HostKeyError';
  override readonly code = 'ERR_NETCONF_HOST_KEY';
}

/** The TLS server's certificate wasn't trusted, didn't name the server, or didn't match the pin; or no trust was configured. */
export class CertificateError extends TransportError {
  /** Always `'CertificateError'`. */
  override name = 'CertificateError';
  override readonly code = 'ERR_NETCONF_CERTIFICATE';
}

/**
 * The step that timed out: `'connect'` (opening the connection), `'hello'`
 * (the hello exchange), `'rpc'` (waiting for a reply) or `'close'` (closing
 * the session).
 */
export type TimeoutPhase = 'connect' | 'hello' | 'rpc' | 'close';

/** An operation didn't finish in time. `phase` says which. */
export class TimeoutError extends NetconfError {
  /** Always `'TimeoutError'`. */
  override name = 'TimeoutError';
  override readonly code = 'ERR_NETCONF_TIMEOUT';
  /** Which step timed out. */
  readonly phase: TimeoutPhase;

  constructor(phase: TimeoutPhase, ms: number, options?: NetconfErrorOptions) {
    super(`${phase} timed out after ${ms} ms`, options);
    this.phase = phase;
  }
}

/** The caller aborted the operation through its AbortSignal. `cause` is the signal's reason. */
export class AbortError extends NetconfError {
  /** Always `'AbortError'`. */
  override name = 'AbortError';
  override readonly code = 'ERR_NETCONF_ABORTED';
}

/** The session is closed, or closed while the operation was in progress. `cause` says why, if known. */
export class SessionClosedError extends NetconfError {
  /** Always `'SessionClosedError'`. */
  override name = 'SessionClosedError';
  override readonly code = 'ERR_NETCONF_SESSION_CLOSED';
}

/** The server broke the protocol: an unexpected message, or a reply that can't be matched. */
export class ProtocolError extends NetconfError {
  /** Always `'ProtocolError'`. */
  override name = 'ProtocolError';
  override readonly code: string = 'ERR_NETCONF_PROTOCOL';
}

/** An operation needs a capability the server didn't advertise. */
export class CapabilityError extends NetconfError {
  /** Always `'CapabilityError'`. */
  override name = 'CapabilityError';
  override readonly code = 'ERR_NETCONF_CAPABILITY';
  /** The capability the operation needs: a short name such as `:candidate`, a module or URI, or a description. */
  readonly capability: string;

  constructor(capability: string, operation: string, options?: NetconfErrorOptions) {
    super(`${operation} requires the ${capability} capability, which the server didn't advertise`, options);
    this.capability = capability;
  }
}

/**
 * A YANG schema the call needs isn't available. Either RFC 7951 JSON was
 * asked for with `requireSchema` and no schema could be built for some of the
 * data (the server lists no modules, or a module's text could be found
 * nowhere: supplied modules, the bundled IETF modules or `<get-schema>`), or
 * `client.content.modules()` was asked for a datastore or YANG library schema
 * the server doesn't list. The message says which and why.
 */
export class SchemaUnavailableError extends NetconfError {
  /** Always `'SchemaUnavailableError'`. */
  override name = 'SchemaUnavailableError';
  override readonly code = 'ERR_NETCONF_SCHEMA_UNAVAILABLE';
}
