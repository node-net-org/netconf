/**
 * NETCONF over TLS with mutual X.509 authentication (RFC 7589, design §5.1).
 *
 * TLS only replaces how the authenticated byte stream is built: the hello,
 * RFC 6242 framing and everything above are the same as over SSH.
 *
 * ```ts
 * const client = await connect({
 *   transport: tls({ host: 'router1', cert: clientPem, key: clientKey, ca: caPem }),
 * });
 * ```
 *
 * The server must be verified (RFC 7589 has no trust-on-first-use): give `ca`
 * (chain plus RFC 6125 name check), a `fingerprint` pin, or both. Node's public
 * root store is never used. `insecure: 'insecure-accept-any'` turns verification
 * off and logs a warning on every connection.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { Duplex } from 'node:stream';
import { checkServerIdentity, connect as tlsConnect, type ConnectionOptions, type PeerCertificate, type TLSSocket } from 'node:tls';
import { AuthenticationError, CertificateError, NetconfError, TransportError } from '../errors.js';
import { silentLogger, type Logger } from '../logger.js';
import { INSECURE_ACCEPT_ANY } from './host-keys.js';
import type { Secret } from './ssh.js';
import { duplexConnection } from './duplex.js';
import { sha256Fingerprint } from './fingerprint.js';
import type { Connection, ConnectionFactory } from './types.js';

/** A PEM certificate, key or CA bundle. */
export type Pem = string | Buffer;

/**
 * Options for {@link tls}: the server, our client certificate, and how to
 * verify the server (`ca`, `fingerprint`, or both). See [TLS](/guide/connecting#tls).
 */
export interface TlsOptions {
  /**
   * The host name or address to connect to. With `ca`, it is also the name
   * the server certificate must carry, unless `serverName` is given.
   */
  readonly host: string;
  /** Default 6513, the IANA port for NETCONF over TLS. */
  readonly port?: number;
  /** Our certificate (PEM), optionally followed by its intermediate CAs. Required: RFC 7589 is mutual TLS. */
  readonly cert: Secret<Pem>;
  /** The private key for `cert` (PEM). */
  readonly key: Secret<Pem>;
  /** The passphrase that decrypts `key`. */
  readonly passphrase?: Secret<string>;
  /**
   * Trust anchors for the server's certificate. The chain must lead to one of
   * them, and the certificate must name `serverName` (default `host`) as a DNS
   * name or IP address (RFC 6125).
   */
  readonly ca?: Pem | readonly Pem[];
  /**
   * Pin the server's certificate by SHA-256 fingerprint: `SHA256:` + base64 (as
   * for SSH), or hex with or without colons (as `openssl x509 -fingerprint
   * -sha256` prints). With `ca` as well, the chain, the name and the pin must all
   * pass; alone, the pin is the server's whole identity.
   */
  readonly fingerprint?: string | readonly string[];
  /** The name to check the server certificate against, if not `host`. Sent as SNI unless it is an IP address. */
  readonly serverName?: string;
  /**
   * `'insecure-accept-any'` turns off server certificate verification: any
   * certificate is accepted, so nothing proves you reached the server you
   * meant to, and anyone who can intercept the connection can read and change
   * the session. Each connection logs a warning to this transport's
   * `logger`, if one is given. Only for a lab. Can't be combined with `ca` or
   * `fingerprint`.
   */
  readonly insecure?: typeof INSECURE_ACCEPT_ANY;
  /** An already-connected socket to run TLS over, as in call home (RFC 8071) or through a tunnel. */
  readonly sock?: Duplex;
  /**
   * OpenSSL cipher list, replacing {@link DEFAULT_TLS_CIPHERS} (TLS 1.3
   * suites, then TLS 1.2 ECDHE with AES-GCM or ChaCha20-Poly1305 only, per
   * RFC 9325). Widen it only for a server that can't do better.
   */
  readonly ciphers?: string;
  /** Milliseconds of idle before TCP keepalive probes start. Default 30 000; 0 disables. Ignored with `sock`. */
  readonly keepalive?: number;
  /** Where the transport logs, such as a warning that verification is off. Separate from `connect({ logger })`. */
  readonly logger?: Logger;
}

const MIN_VERSION = 'TLSv1.2';

/**
 * The cipher suites offered unless `ciphers` is given. TLS 1.3: all three of
 * Node's suites. TLS 1.2: ECDHE key exchange with an AEAD cipher only, as
 * RFC 9325 (BCP 195) §4.2 recommends; no static RSA, finite-field DHE or CBC.
 */
export const DEFAULT_TLS_CIPHERS = [
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'TLS_AES_128_GCM_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
].join(':');
const CLOSE_GRACE_MS = 2_000;

/** Create a connection factory for NETCONF over TLS (RFC 7589). */
export function tls(options: TlsOptions): ConnectionFactory {
  const logger = options.logger ?? silentLogger;
  const port = options.port ?? 6513;
  const label = `${options.host}:${port}`;
  const pins = parsePins(options.fingerprint);
  const ca = options.ca;
  const insecure = (options as { insecure?: unknown }).insecure;
  if (insecure !== undefined && insecure !== INSECURE_ACCEPT_ANY) {
    throw new TypeError(`tls(): insecure must be '${INSECURE_ACCEPT_ANY}'`);
  }
  if (insecure !== undefined && (ca !== undefined || pins.length > 0)) {
    throw new TypeError(`tls(): '${INSECURE_ACCEPT_ANY}' can't be combined with ca or fingerprint`);
  }
  if (insecure === undefined && ca === undefined && pins.length === 0) {
    throw new CertificateError(
      `tls(): the server must be verified. Pass ca (trust anchors), fingerprint (the server certificate's SHA-256), ` +
        `or insecure: '${INSECURE_ACCEPT_ANY}' to disable verification.`,
    );
  }
  if ((options as { cert?: unknown }).cert === undefined || (options as { key?: unknown }).key === undefined) {
    throw new TypeError('tls(): cert and key are required (RFC 7589 uses mutual X.509 authentication)');
  }
  const serverName = options.serverName ?? options.host;

  return async (signal) => {
    if (insecure !== undefined) logger.warn?.(`TLS server verification is disabled for ${label}`);
    const [cert, key, passphrase] = await Promise.all([reveal(options.cert), reveal(options.key), reveal(options.passphrase)]);
    signal.throwIfAborted();

    const config: ConnectionOptions = {
      host: options.host,
      port,
      cert,
      key,
      ...(passphrase !== undefined ? { passphrase } : {}),
      minVersion: MIN_VERSION,
      ciphers: options.ciphers ?? DEFAULT_TLS_CIPHERS,
      ...(isIP(serverName) === 0 ? { servername: serverName } : {}),
      ...(options.sock !== undefined ? { socket: options.sock } : {}),
      ...(ca !== undefined
        ? {
            ca: typeof ca === 'string' || Buffer.isBuffer(ca) ? [ca] : [...ca],
            rejectUnauthorized: true,
            checkServerIdentity: (_host: string, peer: PeerCertificate) => checkServerIdentity(serverName, peer),
          }
        : { rejectUnauthorized: false }),
    };

    const socket = tlsConnect(config);
    try {
      await handshake(socket, signal, label);
      const peerCert = socket.getPeerCertificate();
      const fingerprint = certFingerprint(peerCert.raw);
      if (pins.length > 0 && !matchesPin(peerCert.raw, pins)) {
        throw new CertificateError(`TLS server certificate for ${label} doesn't match the pinned fingerprint (it is ${fingerprint})`);
      }
      if (options.sock === undefined && options.keepalive !== 0) socket.setKeepAlive(true, options.keepalive ?? 30_000);
      logger.debug?.(`TLS connection to ${label} established (${socket.getProtocol() ?? 'unknown protocol'})`);
      return tlsConnection(socket, options.host, port, label, fingerprint);
    } catch (err) {
      socket.destroy();
      throw err;
    }
  };
}

/** Options for a TLS connection over a socket a device opened to us (RFC 8071). */
export interface CallHomeTlsOptions {
  /** The accepted socket. */
  readonly sock: Duplex;
  /** The caller's address, for messages and the connection's peer. */
  readonly host: string;
  readonly port: number;
  /** Our certificate and key, used for every call: Node can't choose one after seeing the server's. */
  readonly cert: Secret<Pem>;
  readonly key: Secret<Pem>;
  readonly passphrase?: Secret<string>;
  /**
   * Trust anchors the server's chain must lead to. There is no host-name check:
   * the device's name isn't known until `identify` says who it is.
   */
  readonly ca?: Pem | readonly Pem[];
  /**
   * OpenSSL cipher list, replacing {@link DEFAULT_TLS_CIPHERS} (TLS 1.3
   * suites, then TLS 1.2 ECDHE with AES-GCM or ChaCha20-Poly1305 only, per
   * RFC 9325). Widen it only for a server that can't do better.
   */
  readonly ciphers?: string;
  /** Accept or refuse the device by its certificate (DER) and `SHA256:` fingerprint. */
  readonly identify: (certificate: Buffer, fingerprint: string) => Promise<boolean>;
  readonly logger?: Logger;
}

/**
 * A connection factory for NETCONF over TLS on a socket the device opened (call
 * home, RFC 8071). We are still the TLS client. The device is identified by its
 * certificate, checked against `ca` when given; its address is never trusted.
 */
export function callHomeTls(options: CallHomeTlsOptions): ConnectionFactory {
  const logger = options.logger ?? silentLogger;
  const label = `call-home device ${options.host}:${options.port}`;
  const ca = options.ca;
  return async (signal) => {
    const [cert, key, passphrase] = await Promise.all([reveal(options.cert), reveal(options.key), reveal(options.passphrase)]);
    signal.throwIfAborted();
    const socket = tlsConnect({
      socket: options.sock,
      cert,
      key,
      ...(passphrase !== undefined ? { passphrase } : {}),
      minVersion: MIN_VERSION,
      ciphers: options.ciphers ?? DEFAULT_TLS_CIPHERS,
      ...(ca !== undefined
        ? { ca: typeof ca === 'string' || Buffer.isBuffer(ca) ? [ca] : [...ca], rejectUnauthorized: true, checkServerIdentity: () => undefined }
        : { rejectUnauthorized: false }),
    });
    // Until the connection's stream owns the socket, an error from it (a caller
    // resetting the connection while identify runs) must not go unhandled.
    const guard = (): void => undefined;
    socket.on('error', guard);
    try {
      await handshake(socket, signal, label);
      const raw = socket.getPeerCertificate().raw;
      const fingerprint = certFingerprint(raw);
      if (!(await whileOpen(socket, signal, label, options.identify(raw, fingerprint)))) {
        throw new CertificateError(`The ${label} was not accepted (certificate ${fingerprint})`);
      }
      logger.debug?.(`TLS connection from ${label} established (${socket.getProtocol() ?? 'unknown protocol'})`);
      return tlsConnection(socket, options.host, options.port, label, fingerprint);
    } catch (err) {
      socket.destroy();
      throw err;
    } finally {
      socket.removeListener('error', guard);
    }
  };
}

/** Wait for the TLS handshake, failing with a typed error, or the signal's reason when it aborts. */
function handshake(socket: TLSSocket, signal: AbortSignal, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const fail = (err: Error): void => {
      done();
      reject(handshakeError(err, label));
    };
    const closed = (): void => {
      done();
      reject(new TransportError(`TLS connection to ${label} closed during the handshake`));
    };
    const aborted = (): void => {
      done();
      reject(signal.reason as Error);
    };
    const secure = (): void => {
      done();
      resolve();
    };
    const done = (): void => {
      socket.removeListener('error', fail);
      socket.removeListener('close', closed);
      socket.removeListener('secureConnect', secure);
      signal.removeEventListener('abort', aborted);
    };
    if (signal.aborted) {
      aborted();
      return;
    }
    socket.on('error', fail);
    socket.on('close', closed);
    socket.on('secureConnect', secure);
    signal.addEventListener('abort', aborted);
  });
}

/**
 * `work`, or a rejection as soon as the signal aborts or the socket fails or
 * closes: a slow identify must not hold a call past its timeout or a closed peer.
 */
function whileOpen<T>(socket: TLSSocket, signal: AbortSignal, label: string, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settle = (fn: () => void): void => {
      socket.removeListener('error', failed);
      socket.removeListener('close', closed);
      signal.removeEventListener('abort', aborted);
      fn();
    };
    const failed = (err: Error): void => settle(() => reject(new TransportError(`TLS connection from ${label} failed: ${err.message}`, { cause: err })));
    const closed = (): void => settle(() => reject(new TransportError(`TLS connection from ${label} closed while it was being identified`)));
    const aborted = (): void => settle(() => reject(signal.reason as Error));
    if (signal.aborted) {
      work.catch(() => undefined);
      reject(signal.reason as Error);
      return;
    }
    socket.on('error', failed);
    socket.on('close', closed);
    signal.addEventListener('abort', aborted);
    work.then(
      (value) => settle(() => resolve(value)),
      (err: unknown) => settle(() => reject(err instanceof Error ? err : new Error(String(err)))),
    );
  });
}

/** OpenSSH-style `SHA256:` fingerprint of a certificate's DER. */
function certFingerprint(der: Buffer): string {
  return sha256Fingerprint(der);
}

// --- verification -----------------------------------------------------------------------------

function parsePins(fingerprint: string | readonly string[] | undefined): Buffer[] {
  if (fingerprint === undefined) return [];
  const list = typeof fingerprint === 'string' ? [fingerprint] : fingerprint;
  if (list.length === 0) throw new TypeError('tls(): fingerprint is an empty list');
  return list.map((entry) => {
    const text = entry.trim();
    if (/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(text)) return Buffer.from(text.slice(7), 'base64');
    const hex = text.replace(/:/g, '');
    if (/^[0-9A-Fa-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
    throw new TypeError(`tls(): fingerprint ${JSON.stringify(entry)} is neither SHA256:<base64> nor a 64-digit hex SHA-256`);
  });
}

function matchesPin(der: Buffer, pins: readonly Buffer[]): boolean {
  const digest = createHash('sha256').update(der).digest();
  let match = false;
  for (const pin of pins) match = timingSafeEqual(digest, pin) || match;
  return match;
}

/** OpenSSL alerts a server sends when it refuses our certificate or the handshake. */
const SERVER_ALERT =
  /^ERR_SSL_(?:TLSV13|TLSV1|SSLV3)_ALERT_(CERTIFICATE_REQUIRED|BAD_CERTIFICATE|UNKNOWN_CA|HANDSHAKE_FAILURE|ACCESS_DENIED|CERTIFICATE_UNKNOWN|UNSUPPORTED_CERTIFICATE|CERTIFICATE_EXPIRED|CERTIFICATE_REVOKED|DECRYPT_ERROR)$/;
/** OpenSSL/Node codes for a server certificate we didn't accept. */
const CERT_REJECTED =
  /^(?:ERR_TLS_CERT_ALTNAME_INVALID|UNABLE_TO_|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_|INVALID_CA|INVALID_PURPOSE|HOSTNAME_MISMATCH|PATH_LENGTH_EXCEEDED)/;

function alertOf(err: Error): string | undefined {
  const m = SERVER_ALERT.exec((err as NodeJS.ErrnoException).code ?? '');
  return m?.[1]?.toLowerCase().replace(/_/g, '-');
}

function refused(label: string, alert: string, cause: Error): AuthenticationError {
  return new AuthenticationError(`The TLS server ${label} refused the client certificate (alert: ${alert})`, { cause });
}

function handshakeError(err: Error, label: string): NetconfError {
  if (err instanceof NetconfError) return err;
  const alert = alertOf(err);
  if (alert !== undefined) return refused(label, alert, err);
  if (CERT_REJECTED.test((err as NodeJS.ErrnoException).code ?? '')) {
    return new CertificateError(`TLS server certificate for ${label} was not accepted: ${err.message}`, { cause: err });
  }
  const reset = (err as NodeJS.ErrnoException).code === 'ECONNRESET';
  const hint = reset ? ' (a server that rejects the client certificate without an alert looks like this)' : '';
  return new TransportError(`TLS connection to ${label} failed: ${err.message}${hint}`, { cause: err });
}

// --- the connection ---------------------------------------------------------------------------

/**
 * The NETCONF byte stream over a TLS socket. With TLS 1.3 the server judges our
 * certificate after our side of the handshake is done, so a refusal, or a close
 * before the server's hello (cert-to-name found no user), arrives here; both
 * become an AuthenticationError that says so.
 */
class TlsStream extends Duplex {
  private received = false;

  constructor(
    private readonly socket: TLSSocket,
    private readonly label: string,
  ) {
    super();
    socket.on('data', (chunk: Buffer) => {
      this.received = true;
      if (!this.push(chunk)) socket.pause();
    });
    socket.on('end', () => {
      if (this.received) this.push(null);
      else this.destroy(this.closedEarly());
    });
    socket.on('error', (err: Error) => {
      const alert = alertOf(err);
      if (alert !== undefined) this.destroy(refused(this.label, alert, err));
      else if (!this.received) this.destroy(this.closedEarly(err));
      else this.destroy(err);
    });
    socket.on('close', () => {
      if (!this.destroyed) this.destroy(this.received ? undefined : this.closedEarly());
    });
  }

  private closedEarly(cause?: Error): AuthenticationError {
    return new AuthenticationError(
      `The TLS server ${this.label} closed the connection before sending its hello; it probably refused the client ` +
        `certificate or could not map it to a user (cert-to-name)`,
      cause === undefined ? undefined : { cause },
    );
  }

  override _read(): void {
    this.socket.resume();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.socket.write(chunk, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.socket.end();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.socket.destroy();
    callback(error);
  }
}

function tlsConnection(socket: TLSSocket, host: string, port: number, label: string, fingerprint: string): Connection {
  const stream = new TlsStream(socket, label);
  let closing: Promise<void> | undefined;
  return duplexConnection(stream, {
    peer: { host, port, identity: fingerprint },
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        if (socket.destroyed) {
          stream.destroy();
          resolve();
          return;
        }
        const timer = setTimeout(() => socket.destroy(), CLOSE_GRACE_MS);
        socket.once('close', () => {
          clearTimeout(timer);
          stream.destroy();
          resolve();
        });
        socket.end(); // sends close_notify
      });
      return closing;
    },
  });
}

async function reveal<T>(secret: Secret<T> | undefined): Promise<T | undefined> {
  return typeof secret === 'function' ? await (secret as () => T | Promise<T>)() : secret;
}
