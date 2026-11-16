/**
 * The closeTimeout quirk through connect() (PROFILE-08): a profile's
 * closeTimeout sets how long close() waits for the <close-session> reply,
 * unless the caller gave timeouts.close, which wins. Found on DEF's
 * no-close-reply scenario (manual-testing row D16).
 */
import { describe, expect, it } from 'vitest';
import { compileProfile } from '../../src/devices/profile-spec.js';
import { autoDetect, BASE_1_0, BASE_1_1, connect, type ConnectOptions, type ConnectionFactory, type DeviceProfile } from '../../src/index.js';
import { FakeServer } from '../../src/testing/index.js';
import { text, watchConnection } from '../support/connections.js';

const MODULE = 'urn:example:slow-close?module=slow-close';

const slowClose = (closeTimeout: number): DeviceProfile =>
  compileProfile({ id: 'slow-close', match: { anyModule: ['slow-close'] }, quirks: { closeTimeout } }).profile;

/**
 * A transport to a FakeServer that never sees <close-session>, so it is never
 * answered (FakeServer answers it itself). The session writes each framed
 * message in one write, so a write naming it is the whole message.
 */
function droppingCloseSession(server: FakeServer): ConnectionFactory {
  const { connection } = watchConnection(server.connection, (bytes) => !text(bytes).includes('<close-session'));
  return () => Promise.resolve(connection);
}

/** Connect, close, and return the close timeout the session gave up after, from its debug log. */
async function closeTimeoutUsed(options: Omit<ConnectOptions, 'transport'>): Promise<number | undefined> {
  const server = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1, MODULE] });
  let used: number | undefined;
  const client = await connect({
    ...options,
    transport: droppingCloseSession(server),
    logger: {
      debug: (message, data) => {
        const err = (data as { err?: Error } | undefined)?.err;
        const ms = /timed out after (\d+) ms/.exec(err?.message ?? '')?.[1];
        if (message.startsWith('close-session did not complete') && ms !== undefined) used = Number(ms);
      },
    },
  });
  await client.close();
  return used;
}

describe('closeTimeout quirk through connect() (PROFILE-08)', () => {
  it('waits the profile closeTimeout when the profile is named', async () => {
    expect(await closeTimeoutUsed({ profile: slowClose(40) })).toBe(40);
  });

  it('waits the profile closeTimeout when the profile is auto-detected', async () => {
    expect(await closeTimeoutUsed({ profile: autoDetect([slowClose(40)]) })).toBe(40);
  });

  it('lets timeouts.close passed to connect() override the quirk', async () => {
    expect(await closeTimeoutUsed({ profile: slowClose(40), timeouts: { close: 60 } })).toBe(60);
  });

  it('keeps the quirk when the caller sets other timeouts but not close', async () => {
    expect(await closeTimeoutUsed({ profile: slowClose(40), timeouts: { connect: 5000, rpc: 5000 } })).toBe(40);
  });

  it('waits timeouts.close with no profile', async () => {
    expect(await closeTimeoutUsed({ timeouts: { close: 30 } })).toBe(30);
  });
});
