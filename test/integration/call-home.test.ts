/**
 * Call home (RFC 8071, TRANSPORT-12) against netopeer2, over SSH and TLS.
 *
 * Some hosts drop TCP from containers to the host, so netopeer2 calls home to
 * a relay inside its container (scripts/callhome-relay.py), which pairs each
 * call with a connection from here on a published port. `bridge()` makes that
 * connection and pipes it into our listener on loopback, so the listener sees
 * the device's bytes exactly as if it had accepted its call directly.
 *
 *   scripts/netopeer2.sh start
 *   npm run test:integration
 *
 * Skipped unless NETOPEER2_PORT is set.
 */
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as tcp, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  connect,
  listenCallHome,
  NETCONF_NS,
  parseXml,
  ssh,
  withClient,
  x,
  type CallHomeCall,
  type CallHomeEvents,
  type CallHomeListener,
  type ConnectOptions,
} from '../../src/index.js';

const PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);
const RELAY_SSH = Number(process.env['NETOPEER2_CALLHOME_PORT'] ?? PORT + 2000);
const RELAY_TLS = Number(process.env['NETOPEER2_CALLHOME_TLS_PORT'] ?? PORT + 3000);
const NCS = 'urn:ietf:params:xml:ns:yang:ietf-netconf-server';
const FIX = join(import.meta.dirname, '..', 'fixtures', 'tls');
const pem = (name: string) => readFileSync(join(FIX, name));
/** netopeer2 presents server.pem; its SHA256: fingerprint is the device's TLS identity. */
const serverCertFingerprint = `SHA256:${Buffer.from(new X509Certificate(pem('server.pem')).fingerprint256.replace(/:/g, ''), 'hex').toString('base64').replace(/=+$/, '')}`;
/** cert-to-name entry for our client certificate's issuing CA, as scripts/netopeer2.sh sets it up. */
const caFingerprint = `04:${new X509Certificate(pem('ca.pem')).fingerprint256}`;

let hostKey = '';
const options = (): ConnectOptions => ({
  transport: ssh({ host: '127.0.0.1', port: PORT, username: 'netconf', password: 'netconf', hostKey }),
  timeouts: { rpc: 10_000 },
});

const SSH_SERVER = `
  <ssh-server-parameters>
    <server-identity><host-key><name>default-key</name><public-key><keystore-reference>genkey</keystore-reference></public-key></host-key></server-identity>
    <client-authentication><supported-authentication-methods><publickey/><passsword/></supported-authentication-methods></client-authentication>
  </ssh-server-parameters>`;
const TLS_SERVER = () => `
  <tls-server-parameters>
    <server-identity><keystore-reference><asymmetric-key>nn-tls-key</asymmetric-key><certificate>nn-tls-cert</certificate></keystore-reference></server-identity>
    <client-authentication>
      <required/>
      <ca-certs>nn-ca</ca-certs>
      <cert-maps><cert-to-name><id>1</id><fingerprint>${caFingerprint}</fingerprint>
        <map-type xmlns:x509c2n="urn:ietf:params:xml:ns:yang:ietf-x509-cert-to-name">x509c2n:common-name</map-type></cert-to-name></cert-maps>
    </client-authentication>
  </tls-server-parameters>`;

/** netopeer2's call-home configuration: a persistent call to the relay inside its container. */
const callHome = (name: string, transport: 'ssh' | 'tls') =>
  parseXml(`<netconf-server xmlns="${NCS}"><call-home><netconf-client>
    <name>${name}</name>
    <endpoints><endpoint><name>relay</name>
      <${transport}>
        <tcp-client-parameters><remote-address>127.0.0.1</remote-address><remote-port>${transport === 'ssh' ? 4334 : 4335}</remote-port></tcp-client-parameters>
        ${transport === 'ssh' ? SSH_SERVER : TLS_SERVER()}
      </${transport}>
    </endpoint></endpoints>
    <connection-type><persistent/></connection-type>
  </netconf-client></call-home></netconf-server>`);

async function configureCallHome(name: string, transport: 'ssh' | 'tls'): Promise<void> {
  await withClient(options(), (c) => c.ops.editConfig({ target: 'running', config: callHome(name, transport) }));
}
async function removeCallHome(name: string): Promise<void> {
  const remove = { ns: NETCONF_NS, prefix: 'nc', value: 'remove' };
  await withClient(options(), (c) =>
    c.ops.editConfig({ target: 'running', config: x('netconf-server', { xmlns: NCS }, x('call-home', x('netconf-client', { operation: remove }, x('name', name)))) }),
  ).catch(() => undefined);
}

/** Connect the relay's published port to our listener, so the next call reaches it. */
function bridge(relayPort: number, listenerPort: number): Socket[] {
  const relay = tcp({ host: '127.0.0.1', port: relayPort });
  const listener = tcp({ host: '127.0.0.1', port: listenerPort });
  relay.pipe(listener).pipe(relay);
  for (const s of [relay, listener]) s.on('error', () => undefined);
  return [relay, listener];
}

/** The next call, failing after `ms`. */
async function nextCall(listener: CallHomeListener, ms = 15_000): Promise<CallHomeCall> {
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no call within ${ms} ms`)), ms).unref());
  const r = await Promise.race([listener.next(), timer]);
  if (r.done === true) throw new Error('listener ended');
  return r.value;
}

const sockets: Socket[] = [];
let listener: CallHomeListener | undefined;

describe.skipIf(PORT === 0)('call home against netopeer2', () => {
  beforeAll(async () => {
    const c = await connect({
      transport: ssh({
        host: '127.0.0.1',
        port: PORT,
        username: 'netconf',
        password: 'netconf',
        hostKey: (info) => {
          hostKey = info.fingerprint;
          return true;
        },
      }),
    });
    await c.close();
  });

  afterEach(async () => {
    await listener?.close();
    listener = undefined;
    for (const s of sockets.splice(0)) s.destroy();
  });

  afterAll(async () => {
    if (PORT === 0) return;
    await removeCallHome('nn-ch-ssh');
    await removeCallHome('nn-ch-tls');
  });

  it('SSH: identifies the device by its host key, logs in with its credentials, and the device calls again after close', async () => {
    const seen: string[] = [];
    listener = await listenCallHome({
      ssh: { host: '127.0.0.1', port: 0 },
      identify: (caller) => {
        seen.push(caller.fingerprint);
        return caller.fingerprint === hostKey ? { name: 'router1', username: 'netconf', password: 'netconf' } : undefined;
      },
      connect: { timeouts: { rpc: 10_000 } },
    });
    const port = listener.addresses.ssh!.port;
    await configureCallHome('nn-ch-ssh', 'ssh');

    sockets.push(...bridge(RELAY_SSH, port));
    const first = await nextCall(listener);
    expect(first.device.name).toBe('router1');
    expect(first.caller).toMatchObject({ transport: 'ssh', fingerprint: hostKey });
    expect(first.caller.keyType).toMatch(/^(ssh-|ecdsa-|rsa-)/);
    expect(first.client.transport.peer.identity).toBe(hostKey);
    const data = await first.client.ops.getConfig({ source: 'running' });
    expect(data.name).toBe('data');
    await first.client.close();

    // Persistent call home: the device calls again.
    sockets.push(...bridge(RELAY_SSH, port));
    const second = await nextCall(listener);
    expect(second.caller.fingerprint).toBe(hostKey);
    expect(second.client.session.sessionId).not.toBe(first.client.session.sessionId);
    await second.client.close();
    expect(seen.every((f) => f === hostKey)).toBe(true);
  });

  it('SSH: a device identify does not know is refused before any credentials are sent', async () => {
    const rejected: CallHomeEvents['rejected'][] = [];
    listener = await listenCallHome({ ssh: { host: '127.0.0.1', port: 0 }, identify: () => undefined });
    listener.on('rejected', (e) => rejected.push(e));
    await configureCallHome('nn-ch-ssh', 'ssh');
    sockets.push(...bridge(RELAY_SSH, listener.addresses.ssh!.port));
    await expect.poll(() => rejected.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(rejected[0]).toMatchObject({ transport: 'ssh', caller: { fingerprint: hostKey } });
    expect(rejected[0]!.reason).toContain('unknown device');
    expect(listener.pendingCalls).toBe(0);
  });

  it('TLS: identifies the device by its certificate and runs NETCONF over the listener-wide client certificate', async () => {
    listener = await listenCallHome({
      tls: { host: '127.0.0.1', port: 0, cert: pem('client.pem'), key: pem('client.key'), ca: pem('ca.pem') },
      identify: (caller) => (caller.fingerprint === serverCertFingerprint ? { name: 'router1-tls' } : undefined),
      connect: { timeouts: { rpc: 10_000 } },
    });
    await removeCallHome('nn-ch-ssh');
    await configureCallHome('nn-ch-tls', 'tls');
    sockets.push(...bridge(RELAY_TLS, listener.addresses.tls!.port));
    const call = await nextCall(listener);
    expect(call.device.name).toBe('router1-tls');
    expect(call.caller.transport).toBe('tls');
    expect(call.caller.certificate?.subject).toContain('CN=');
    expect(call.client.transport.peer.identity).toBe(serverCertFingerprint);
    const data = await call.client.ops.getConfig({ source: 'running' });
    expect(data.name).toBe('data');
    await call.client.close();
  });
});
