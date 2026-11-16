/**
 * The shared `SHA256:` fingerprint format: what the SSH host-key policy, the
 * TLS pin and @node-net/netconf-server's logs all print and accept.
 */
import { describe, expect, it } from 'vitest';
import { fingerprintOf, sha256Fingerprint } from '../../src/index.js';

describe('sha256Fingerprint', () => {
  it('is SHA256: then the unpadded base64 SHA-256 digest', () => {
    // sha256('abc') = ba7816bf…15ad; its base64 ends in one '=' of padding, which is dropped.
    expect(sha256Fingerprint(new TextEncoder().encode('abc'))).toBe('SHA256:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0');
    expect(sha256Fingerprint(new Uint8Array())).toBe('SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU');
  });

  it('is what fingerprintOf gives for an SSH key blob', () => {
    const blob = Buffer.from('0000000b7373682d6564323535313900000020' + '11'.repeat(32), 'hex');
    expect(fingerprintOf(blob)).toBe(sha256Fingerprint(blob));
  });
});
