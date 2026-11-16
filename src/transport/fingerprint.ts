/**
 * The `SHA256:` fingerprint format (Node only): one definition for SSH host
 * keys, TLS certificates, and @node-net/netconf-server's logs, so a fingerprint
 * one of them prints is one the others accept.
 */

import { createHash } from 'node:crypto';

/**
 * The OpenSSH-style SHA-256 fingerprint of some bytes: `SHA256:` then the
 * base64 digest without its `=` padding, as `ssh-keygen -lf` prints it.
 * For an SSH host key, pass the public key blob in SSH wire format; for a
 * TLS certificate, its DER. The result is what the `hostKey` policy and the
 * TLS `fingerprint` pin accept.
 *
 * @example
 * ```ts
 * sha256Fingerprint(new TextEncoder().encode('abc'));
 * // 'SHA256:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0'
 * ```
 */
export function sha256Fingerprint(bytes: Uint8Array): string {
  return `SHA256:${createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '')}`;
}
