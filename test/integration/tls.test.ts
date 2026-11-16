/**
 * NETCONF over TLS (RFC 7589) against netopeer2 (TRANSPORT-10).
 *
 *   scripts/netopeer2.sh start
 *   npm run test:integration
 *
 * Skipped unless NETOPEER2_PORT is set. The TLS endpoint listens on
 * NETOPEER2_TLS_PORT (default NETOPEER2_PORT + 1000) with the test-only
 * certificates in test/fixtures/tls; netopeer2 maps the client CN to the user.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  CertificateError,
  connect,
  NETCONF_NS,
  RpcError,
  subtree,
  tls,
  withClient,
  x,
  type TlsOptions,
} from '../../src/index.js';
import { monitoring } from '../../src/operations/monitoring.js';

const PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);
const TLS_PORT = Number(process.env['NETOPEER2_TLS_PORT'] ?? PORT + 1000);
const NACM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-acm';

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/tls/${name}`, import.meta.url), 'utf8');

const options = (extra: Partial<TlsOptions> = {}): TlsOptions =>
  ({
    host: 'localhost',
    port: TLS_PORT,
    cert: fixture('client.pem'),
    key: fixture('client.key'),
    ca: fixture('ca.pem'),
    ...extra,
  });

describe.skipIf(PORT === 0)('NETCONF over TLS against netopeer2', () => {
  it('connects with mutual X.509, and the server sees the certificate CN as the user', async () => {
    await withClient({ transport: tls(options()), extensions: [monitoring], timeouts: { rpc: 10_000 } }, async (c) => {
      expect(c.session.baseVersion).toBe('1.1'); // chunked framing over TLS, as over SSH
      expect(c.transport.peer.identity).toMatch(/^SHA256:/);
      const me = (await c.content.monitoring.sessions()).find((s) => s.sessionId === c.session.sessionId)!;
      expect(me.username).toBe('netconf');
      expect(me.transport).toMatch(/netconf-tls$/);
    });
  });

  it('reads and changes configuration over TLS', async () => {
    const name = `nn-tls-${Date.now()}`;
    const group = (op?: 'remove') =>
      x('nacm', { xmlns: NACM },
        x('groups', x('group', op ? { operation: { ns: NETCONF_NS, prefix: 'nc', value: op } } : {}, x('name', name))));
    await withClient({ transport: tls(options()), timeouts: { rpc: 10_000 } }, async (c) => {
      await c.ops.editConfig({ target: 'running', config: group() });
      try {
        const data = await c.ops.getConfig({ filter: subtree(group()) });
        expect(data.path('nacm/groups/group/name', NACM)?.text()).toBe(name);
      } finally {
        await c.ops.editConfig({ target: 'running', config: group('remove') });
      }
    });
  });

  // NACM against a real server. The guest certificate's CN,
  // nn-guest, becomes a NETCONF user in no NACM group, so only the defaults
  // apply to it, and kill-session is nacm:default-deny-all (RFC 8341 §3.5.2).
  it('an unprivileged user gets access-denied as a typed RpcError, and its session stays open', async () => {
    const guest = tls(options({ cert: fixture('guest.pem'), key: fixture('guest.key') }));
    await withClient({ transport: tls(options()), timeouts: { rpc: 10_000 } }, async (admin) => {
      await withClient({ transport: guest, extensions: [monitoring], timeouts: { rpc: 10_000 } }, async (c) => {
        const err = await c.ops.killSession(admin.session.sessionId).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).first).toMatchObject({ type: 'protocol', tag: 'access-denied', severity: 'error' });
        expect((err as RpcError).first.message).toMatch(/nn-guest/);

        // The error failed only that request: both sessions carry on.
        const me = (await c.content.monitoring.sessions()).find((s) => s.sessionId === c.session.sessionId);
        expect(me?.username).toBe('nn-guest');
        expect(admin.session.state).toBe('open');
        await admin.ops.getConfig({ filter: subtree(x('nacm', { xmlns: NACM })) });
      });
    });
  });

  it('a client certificate from an untrusted CA is refused with an AuthenticationError', async () => {
    const p = connect({ transport: tls(options({ cert: fixture('other-client.pem'), key: fixture('other-client.key') })) });
    await expect(p).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('a server that does not match the pin is refused with a CertificateError', async () => {
    const pin = 'SHA256:' + 'A'.repeat(43);
    await expect(connect({ transport: tls(options({ fingerprint: pin })) })).rejects.toBeInstanceOf(CertificateError);
  });

  it('the server name is checked: connecting as another name fails', async () => {
    await expect(connect({ transport: tls(options({ serverName: 'router2' })) })).rejects.toBeInstanceOf(CertificateError);
  });
});
