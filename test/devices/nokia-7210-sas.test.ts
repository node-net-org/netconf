// Contract tests for the nokia-7210-sas profile, replaying what a router
// (7210 SAS-S, TiMOS B-25.9.R5) actually sent on 2026-11-07.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { autoDetect, builtinDeviceProfiles, connect, RpcError, serializeXml, SessionClosedError, x, type Logger } from '../../src/index.js';
import { FakeServer } from '../../src/testing/index.js';

const fixture = (name: string): Promise<string> =>
  readFile(new URL(`../fixtures/nokia-7210-sas/${name}`, import.meta.url), 'utf8');

/** Host and user names from the local live-device config, if there is one. */
async function liveDeviceNames(): Promise<string[]> {
  const dir = process.env['NET_NETCONF_CONFIG'] ?? join(homedir(), '.config', 'net-netconf');
  try {
    const c = JSON.parse(await readFile(join(dir, 'live-device.json'), 'utf8')) as Record<string, unknown> & {
      jump?: Record<string, unknown>;
    };
    return [c['host'], c['username'], c.jump?.['host'], c.jump?.['username']].filter(
      (v): v is string => typeof v === 'string' && v.length > 2,
    );
  } catch {
    return [];
  }
}

let HELLO = '';
let DENIED = '';
let SYSTEM = '';
beforeAll(async () => {
  HELLO = await fixture('hello.xml');
  DENIED = await fixture('get-config-denied.xml');
  SYSTEM = await fixture('get-config-system.xml');
});

async function open(options: { profiles: boolean; logger?: Logger }) {
  const fake = new FakeServer({ hello: HELLO, handler: () => undefined });
  const client = await connect({
    transport: fake.transport(),
    ...(options.profiles ? { profile: autoDetect(await builtinDeviceProfiles()) } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return { fake, client };
}

/** Send a captured reply (its message-id is "1") as the reply to the request just made. */
async function reply(fake: FakeServer, captured: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
  const id = fake.requests.at(-1)!.attr('message-id')!;
  fake.send(captured.replace('message-id="1"', `message-id="${id}"`));
}
const replyDenied = (fake: FakeServer): Promise<void> => reply(fake, DENIED);

describe('nokia-7210-sas profile', () => {
  it('the captured error really contains a BEL', () => {
    expect(DENIED).toContain('\u0007');
  });

  it('is auto-detected from the real hello, with the direct running workflow', async () => {
    const { client } = await open({ profiles: true });
    expect(client.profile?.id).toBe('nokia-7210-sas');
    expect(client.profile?.status).toBe('verified');
    expect(client.profile?.workflow).toEqual({ editTarget: 'running', lock: true, validate: false, commit: false });
    expect(client.session.serverCapabilities.has(':candidate')).toBe(false);
    expect(client.session.serverCapabilities.has(':writable-running')).toBe(true);
    // The hello's non-date revisions ("revision=Date") are accepted as-is.
    expect(client.session.serverCapabilities.hasHelloModule('alu-conf-r13')).toBe(true);
    await client.close();
  });

  it('turns the BEL-carrying rpc-error into a typed RpcError and keeps the session open', async () => {
    const debug: { message: string; context?: Record<string, unknown> }[] = [];
    const { fake, client } = await open({
      profiles: true,
      logger: { debug: (message, context) => debug.push({ message, ...(context ? { context } : {}) }) },
    });

    const pending = client.ops.getConfig();
    await replyDenied(fake);
    const err = await pending.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RpcError);
    const detail = (err as RpcError).errors[0]!;
    expect(detail.tag).toBe('operation-failed');
    expect(detail.message).toContain('CLI Command not allowed for this user.');
    expect(detail.message).not.toContain('\u0007');

    // Logged as a count only, never the content.
    const stripped = debug.find((d) => d.message.startsWith('Removed characters'));
    expect(stripped?.context).toEqual({ removed: 1 });
    expect(JSON.stringify(debug)).not.toContain('display-config');

    // The session is still usable.
    expect(client.session.state).toBe('open');
    const next = client.session.rpc(x('get'));
    await new Promise((r) => setTimeout(r, 5));
    fake.send(`<rpc-reply message-id="${fake.requests.at(-1)!.attr('message-id')!}" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><data/></rpc-reply>`);
    expect((await next).ok).toBe(false);
    await client.close();
  });

  it('without the profile, the same bytes are malformed XML: the session closes and the request rejects', async () => {
    const { fake, client } = await open({ profiles: false });
    expect(client.profile).toBeUndefined();

    const pending = client.ops.getConfig();
    await replyDenied(fake);
    const err = await pending.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SessionClosedError);
    expect((err as Error).message).toMatch(/Malformed XML: Invalid character \(line 12, column 58\)/);
    expect(client.session.state).toBe('closed');
  });

  it('reads @systemName with a filter cut at /configure/system (the device rejects leaf filters)', async () => {
    const { fake, client } = await open({ profiles: true });
    const pending = client.content.readValue('@systemName', { format: 'xml' });
    await reply(fake, SYSTEM);
    expect(await pending).toBe('router1');
    const sent = fake.requests.at(-1)!.elements[0]!;
    expect(sent.name).toBe('get-config');
    expect(serializeXml(sent.child('filter')!)).toBe(
      '<filter xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" type="subtree"><configure xmlns="urn:alcatel-lucent.com:sros:ns:yang:conf-r13"><system/></configure></filter>',
    );
    await client.close();
  });

  it('the fixtures carry no secrets, addresses or real names', async () => {
    const fixtures = [HELLO, DENIED, SYSTEM].join('\n');
    expect(SYSTEM).not.toMatch(/secret|password|hash/i);
    expect(fixtures).not.toMatch(/\b\d+\.\d+\.\d+\.\d+\b/);
    // Real names live only in the local live-device config (scripts/live-check.mjs), never in the repo.
    // Namespace URIs are protocol text (a user called "netconf" would match them), so leave them out.
    const text = fixtures.replace(/urn:[^\s"<]+/g, '');
    for (const name of await liveDeviceNames()) expect(text).not.toContain(name);
  });
});
