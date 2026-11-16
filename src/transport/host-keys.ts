/**
 * SSH host-key verification policies (design §5.1, §9).
 *
 * Verification is mandatory. A policy is one of:
 * - an OpenSSH fingerprint, `'SHA256:…'` (as printed by `ssh-keygen -lf`), or a list of them;
 * - a public key line, `'ssh-ed25519 AAAA…'`, or a list of them;
 * - a function, such as {@link knownHosts} or {@link knownHostsFile};
 * - `'insecure-accept-any'`, which disables verification and logs a warning.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sha256Fingerprint } from './fingerprint.js';

/** The host key an SSH server presented, as a {@link HostKeyVerifier} sees it. */
export interface HostKeyInfo {
  /** The host name or address that was connected to. */
  readonly host: string;
  /** The TCP port that was connected to. */
  readonly port: number;
  /** The raw public key blob, in SSH wire format. */
  readonly key: Buffer;
  /** OpenSSH-style SHA-256 fingerprint: `SHA256:` + unpadded base64. */
  readonly fingerprint: string;
}

/**
 * Your own host-key check, given as `hostKey` when connecting: return (or
 * resolve) `true` to accept the key the server presented. See
 * [Host keys](/guide/connecting#host-keys).
 */
export interface HostKeyVerifier {
  /** Decide whether to trust the key; `false` fails the connection with a `HostKeyError`. */
  (info: HostKeyInfo): boolean | Promise<boolean>;
  /**
   * Optional: the key types (`ssh-ed25519`, `ecdsa-sha2-nistp256`, …) this
   * policy holds for a host. The transport negotiates those first, as OpenSSH
   * does, so a server with several host keys presents one that can be checked.
   */
  knownKeyTypes?: (host: string, port: number) => readonly string[] | Promise<readonly string[]>;
}

// `string & {}` keeps editor autocomplete for 'insecure-accept-any' while allowing any fingerprint string.
/**
 * How an SSH connection verifies the server's host key, given as `hostKey`:
 * a `SHA256:` fingerprint or a public key line (or a list of them), a
 * {@link HostKeyVerifier} such as {@link knownHostsFile}, or
 * {@link INSECURE_ACCEPT_ANY}. Verification is mandatory, so one of these is
 * required. See [Host keys](/guide/connecting#host-keys).
 */
export type HostKeyPolicy = 'insecure-accept-any' | (string & {}) | readonly string[] | HostKeyVerifier;

/**
 * Turns off host-key verification: any key the server presents is accepted,
 * so nothing proves you are talking to the device you meant to, and anyone
 * who can intercept the connection can read and change the session,
 * credentials included. Each connection logs a warning to the `logger` given
 * to `ssh()`, if there is one (`connect({ logger })` doesn't receive it).
 * Only for a lab or a first look at a device; pin its fingerprint or use
 * known_hosts after that.
 * See [Host keys](/guide/connecting#host-keys).
 */
export const INSECURE_ACCEPT_ANY = 'insecure-accept-any';

/** The OpenSSH-style `SHA256:` fingerprint of a public key blob (SSH wire format), as `ssh-keygen -lf` prints it. */
export function fingerprintOf(key: Buffer): string {
  return sha256Fingerprint(key);
}

/**
 * Turn a policy into a verifier.
 * @throws TypeError for strings that are neither fingerprints nor key lines.
 */
export function toVerifier(policy: Exclude<HostKeyPolicy, 'insecure-accept-any'>): HostKeyVerifier {
  if (typeof policy === 'function') return policy;
  const entries = typeof policy === 'string' ? [policy] : policy;
  if (entries.length === 0) throw new TypeError('hostKey: the list of accepted keys is empty');
  const fingerprints = new Set<string>();
  const blobs: Buffer[] = [];
  for (const entry of entries) {
    const e = entry.trim();
    if (/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(e)) fingerprints.add(e.replace(/=$/, ''));
    else {
      const blob = keyLineBlob(e);
      if (blob === undefined) {
        throw new TypeError(`hostKey: ${JSON.stringify(entry)} is neither a SHA256: fingerprint nor a public key line`);
      }
      blobs.push(blob);
    }
  }
  const verifier: HostKeyVerifier = ({ key, fingerprint }) => fingerprints.has(fingerprint) || blobs.some((b) => sameBytes(b, key));
  // Pinned fingerprints don't reveal their key type, so prefer types only when every entry is a key line.
  if (fingerprints.size === 0) {
    const types = [...new Set(blobs.map(keyTypeOf))];
    verifier.knownKeyTypes = () => types;
  }
  return verifier;
}

/**
 * Verify against OpenSSH known_hosts content. Supports plain and hashed
 * (`|1|…`) host entries, `[host]:port` entries, `*`/`?` wildcards, `!`
 * negation, and `@revoked` markers. `@cert-authority` lines are ignored.
 */
export function knownHosts(content: string): HostKeyVerifier {
  const entries = parseKnownHosts(content);
  const namesOf = (host: string, port: number): string[] => (port === 22 ? [host] : [`[${host}]:${port}`]);
  const verifier: HostKeyVerifier = ({ host, port, key }) => {
    const names = namesOf(host, port);
    let accepted = false;
    for (const e of entries) {
      if (!e.matches(names)) continue;
      if (!sameBytes(e.key, key)) continue;
      if (e.marker === 'revoked') return false;
      accepted = true;
    }
    return accepted;
  };
  verifier.knownKeyTypes = (host, port) => {
    const names = namesOf(host, port);
    const matching = entries.filter((e) => e.matches(names));
    const revoked = matching.filter((e) => e.marker === 'revoked');
    const usable = matching.filter((e) => e.marker === undefined && !revoked.some((r) => sameBytes(r.key, e.key)));
    return [...new Set(usable.map((e) => keyTypeOf(e.key)))];
  };
  return verifier;
}

/** Like {@link knownHosts}, reading the file at verification time. Default `~/.ssh/known_hosts`. */
export function knownHostsFile(path = join(homedir(), '.ssh', 'known_hosts')): HostKeyVerifier {
  const verifier: HostKeyVerifier = async (info) => knownHosts(await readFile(path, 'utf8'))(info);
  // A missing or unreadable file is reported by the verification itself; here it just means no preference.
  verifier.knownKeyTypes = async (host, port) =>
    knownHosts(await readFile(path, 'utf8').catch(() => '')).knownKeyTypes!(host, port);
  return verifier;
}

// --- internals ---------------------------------------------------------------

interface KnownHostEntry {
  readonly marker: 'revoked' | undefined;
  readonly key: Buffer;
  matches(names: readonly string[]): boolean;
}

function parseKnownHosts(content: string): KnownHostEntry[] {
  const out: KnownHostEntry[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    let marker: string | undefined;
    if (fields[0]?.startsWith('@')) marker = fields.shift();
    if (marker === '@cert-authority') continue;
    const [hosts, keyType, keyData] = fields;
    if (hosts === undefined || keyType === undefined || keyData === undefined) continue;
    const key = keyLineBlob(`${keyType} ${keyData}`);
    if (key === undefined) continue;
    out.push({ marker: marker === '@revoked' ? 'revoked' : undefined, key, matches: hostMatcher(hosts) });
  }
  return out;
}

function hostMatcher(field: string): (names: readonly string[]) => boolean {
  if (field.startsWith('|1|')) {
    const [, , salt, hash] = field.split('|');
    if (salt === undefined || hash === undefined) return () => false;
    const saltBuf = Buffer.from(salt, 'base64');
    const hashBuf = Buffer.from(hash, 'base64');
    return (names) =>
      names.some((n) => sameBytes(createHmac('sha1', saltBuf).update(n).digest(), hashBuf));
  }
  const patterns = field.split(',');
  return (names) =>
    names.some((name) => {
      let matched = false;
      for (const p of patterns) {
        const negated = p.startsWith('!');
        if (!wildcard(negated ? p.slice(1) : p, name)) continue;
        if (negated) return false;
        matched = true;
      }
      return matched;
    });
}

function wildcard(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(name);
}

/** The key blob of an OpenSSH public key line, if the line is one. */
function keyLineBlob(line: string): Buffer | undefined {
  const m = /^((?:ssh|ecdsa|sk)-[\w@.-]+)\s+([A-Za-z0-9+/]+={0,2})(?:\s|$)/.exec(line);
  if (m === null) return undefined;
  const blob = Buffer.from(m[2]!, 'base64');
  // The blob starts with the key type as an SSH string; check it agrees.
  if (blob.length < 4) return undefined;
  const len = blob.readUInt32BE(0);
  return blob.subarray(4, 4 + len).toString('latin1') === m[1] ? blob : undefined;
}

/** The key type named at the start of a key blob. */
function keyTypeOf(blob: Buffer): string {
  return blob.subarray(4, 4 + blob.readUInt32BE(0)).toString('latin1');
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
