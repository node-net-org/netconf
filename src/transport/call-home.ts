/**
 * NETCONF call home (RFC 8071), transport side: listening for the TCP
 * connections devices open to us, and identifying who is calling.
 *
 * Only the TCP connection is reversed. On the accepted socket we are still the
 * SSH or TLS client (callHomeSsh / callHomeTls), and still the NETCONF client.
 * A caller is identified by its SSH host key or TLS certificate, never by its
 * address, which may be shared (NAT) or spoofed (RFC 8071 §7).
 *
 * The facade (`listenCallHome` in @node-net/netconf) turns each call into a client.
 */

import { X509Certificate } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { TransportError } from '../errors.js';

/** The IANA port for NETCONF call home over SSH. */
export const CALL_HOME_SSH_PORT = 4334;
/** The IANA port for NETCONF call home over TLS. */
export const CALL_HOME_TLS_PORT = 4335;

/** The transport a call came in on. */
export type CallHomeTransport = 'ssh' | 'tls';

/** Where a call came from. For logs only: it doesn't identify the device. */
export interface CallHomeRemote {
  /** The IP address. */
  readonly address: string;
  /** The TCP port. */
  readonly port: number;
}

/** Who is calling, as far as the handshake has shown. */
export interface CallHomeCaller {
  /** The transport the call came in on. */
  readonly transport: CallHomeTransport;
  /** The SSH host key's or TLS certificate's `SHA256:` fingerprint: the device's identity. */
  readonly fingerprint: string;
  /** SSH: the host key type, such as `ssh-ed25519`. */
  readonly keyType?: string;
  /** SSH: the raw public key blob. */
  readonly key?: Buffer;
  /** TLS: the device's certificate (subject, issuer, serialNumber, validity, …). */
  readonly certificate?: X509Certificate;
  /** Where the call came from; for logs only, never for identifying the device. */
  readonly remote: CallHomeRemote;
}

/** The key type named at the start of an SSH public key blob. */
export function sshKeyType(key: Buffer): string | undefined {
  if (key.length < 4) return undefined;
  const len = key.readUInt32BE(0);
  if (len === 0 || len > 64 || key.length < 4 + len) return undefined;
  return key.subarray(4, 4 + len).toString('latin1');
}

/** The remote address of an accepted socket. */
export function remoteOf(socket: Socket): CallHomeRemote {
  return { address: socket.remoteAddress ?? 'unknown', port: socket.remotePort ?? 0 };
}

/**
 * Listen for call-home TCP connections on `host:port` (all interfaces when
 * `host` is undefined). Resolves once listening; `onSocket` receives each
 * accepted socket. Fails with a TransportError if the port can't be bound.
 */
export function listenTcp(transport: CallHomeTransport, host: string | undefined, port: number, onSocket: (socket: Socket) => void): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(onSocket);
    const failed = (err: Error): void => {
      reject(new TransportError(`Can't listen for ${transport.toUpperCase()} call home on ${host ?? '*'}:${port}: ${err.message}`, { cause: err }));
    };
    server.once('error', failed);
    server.listen({ port, ...(host !== undefined ? { host } : {}) }, () => {
      server.removeListener('error', failed);
      resolve(server);
    });
  });
}

/** The certificate of a TLS call, parsed. */
export function certificateOf(der: Buffer): X509Certificate {
  return new X509Certificate(der);
}
