/**
 * Device profile operations as operation descriptors, with mutates (PROFILE-13).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { compileProfile } from '../../src/devices/profile-spec.js';
import {
  BASE_1_0,
  BASE_1_1,
  BUILTIN_PROFILES_DIR,
  builtinDeviceProfiles,
  connect,
  defineDeviceProfile,
  ProfileError,
  serializeXml,
  x,
  type DeviceProfile,
} from '../../src/index.js';
import { defineExtension } from '../../src/operations/index.js';
import { FakeServer } from '../../src/testing/index.js';

const SHOW_NS = 'urn:example:show';

const showProfile = {
  id: 'acme',
  operations: {
    show: {
      description: 'Run a show command',
      mutates: false,
      params: { command: 'string', detail: 'boolean?' },
      request: `<show xmlns="${SHOW_NS}"><cmd>{{command}}</cmd><detail>{{detail}}</detail></show>`,
      result: { path: 'data/output', as: 'text' },
    },
    reboot: { request: '<reboot xmlns="urn:example:admin"/>' },
  },
};

const compile = (raw: object): DeviceProfile => compileProfile(raw).profile;

async function open(device: DeviceProfile, extensions: Parameters<typeof connect>[0]['extensions'] = []) {
  const fake = new FakeServer({
    capabilities: [BASE_1_0, BASE_1_1],
    handler: (_rpc, { operation }) => (operation?.name === 'show' ? { data: x('output', 'version 1.2') } : 'ok'),
  });
  const client = await connect({ transport: fake.transport(), profile: device, extensions });
  return { fake, client };
}

describe('mutates in the profile format', () => {
  it('accepts true and false, and rejects anything else naming the operation and field', () => {
    expect(() => compile({ id: 'p', operations: { a: { request: '<a/>', mutates: false } } })).not.toThrow();
    expect(() => compile({ id: 'p', operations: { a: { request: '<a/>', mutates: true } } })).not.toThrow();
    expect(() => compile({ id: 'p', operations: { a: { request: '<a/>', mutates: 'no' } } })).toThrow(
      new ProfileError('profile p: operations.a.mutates must be a boolean'),
    );
  });

  it('the JSON Schema accepts mutates and rejects a non-boolean', async () => {
    const ajv = new Ajv2020();
    const validate = ajv.compile(JSON.parse(await readFile(join(BUILTIN_PROFILES_DIR, 'profile.schema.json'), 'utf8')) as object);
    expect(validate({ id: 'p', operations: { a: { request: '<a/>', mutates: false } } })).toBe(true);
    expect(validate({ id: 'p', operations: { a: { request: '<a/>', mutates: 'no' } } })).toBe(false);
  });

  it('an operation without mutates is described as changing state', () => {
    const p = compile(showProfile);
    expect(p.descriptors!['reboot']!.mutates).toBe(true);
    expect(p.descriptors!['show']!.mutates).toBe(false);
  });

  it('a TypeScript profile operation with no descriptor is described as changing state, with no parameters', async () => {
    const ts = defineDeviceProfile({ id: 'ts', operations: { poke: () => Promise.resolve('poked') } });
    const { client } = await open(ts);
    expect(client.ops.list.filter((d) => d.device !== undefined)).toEqual([
      { name: 'poke', namespace: '', method: 'call', description: '', mutates: true, requires: [], params: [], device: 'ts' },
    ]);
    await client.close();
  });
});

describe('extends', () => {
  const parent = compileProfile(showProfile).spec;

  it('a child profile can set mutates alone on an inherited operation, keeping the rest', () => {
    const child = compileProfile(
      { id: 'acme-safe', extends: 'acme', operations: { reboot: { mutates: false }, show: { mutates: true } } },
      parent,
    ).profile;
    expect(child.id).toBe('acme-safe');
    expect(child.descriptors!['reboot']).toMatchObject({ mutates: false, namespace: 'urn:example:admin', device: 'acme-safe' });
    expect(child.descriptors!['show']).toMatchObject({ mutates: true, description: 'Run a show command' });
    expect(child.descriptors!['show']!.params).toHaveLength(2);
  });

  it('a child operation with its own request replaces the inherited one, keeping none of its params or result', async () => {
    const child = compileProfile(
      { id: 'acme-v2', extends: 'acme', operations: { show: { request: '<status xmlns="urn:example:v2"/>' } } },
      parent,
    ).profile;
    expect(child.descriptors!['show']).toMatchObject({ namespace: 'urn:example:v2', description: '', mutates: true, params: [] });
    const { client } = await open(child);
    const reply = (await client.ops.run('show')) as { ok: boolean };
    expect(reply.ok).toBe(true); // no inherited result extraction: the whole reply comes back
    await client.close();
  });

  it('an operation with no request after merging is refused', () => {
    expect(() => compileProfile({ id: 'x', extends: 'acme', operations: { fresh: { mutates: false } } }, parent)).toThrow(
      /operations\.fresh\.request must be a string/,
    );
  });

  it('without extends, every operation still needs a request (loader and JSON Schema)', async () => {
    expect(() => compile({ id: 'p', operations: { a: { mutates: false } } })).toThrow(/operations\.a\.request must be a string/);
    const ajv = new Ajv2020();
    const validate = ajv.compile(JSON.parse(await readFile(join(BUILTIN_PROFILES_DIR, 'profile.schema.json'), 'utf8')) as object);
    expect(validate({ id: 'p', operations: { a: { mutates: false } } })).toBe(false);
    expect(validate({ id: 'p', extends: 'q', operations: { a: { mutates: false } } })).toBe(true);
  });
});

describe('profile operations as descriptors', () => {
  it('describe name, description, mutates, typed parameters, the request namespace and the profile', () => {
    expect(compile(showProfile).descriptors!['show']).toEqual({
      name: 'show',
      namespace: SHOW_NS,
      method: 'call',
      description: 'Run a show command',
      mutates: false,
      requires: [],
      params: [
        { name: 'command', kind: 'option', type: 'string', description: '', required: true },
        { name: 'detail', kind: 'option', type: 'boolean', description: '' },
      ],
      device: 'acme',
    });
  });

  it('are plain data that survives a JSON round trip', () => {
    const d = compile(showProfile).descriptors!;
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it('client.device.descriptors lists them, and client.ops.list lists them after base and extension operations', async () => {
    const ping = defineExtension({
      id: 'pinger',
      descriptors: [{ name: 'ping', namespace: 'urn:example:ping', method: 'ping', description: 'Ping', mutates: false, requires: [], params: [] }],
      requests: { ping: () => ({ element: x('ping'), requires: [] }) },
    });
    const { client } = await open(compile(showProfile), [ping]);
    expect(client.ops.list.filter((d) => d.device !== undefined).map((d) => d.name)).toEqual(['show', 'reboot']);
    const names = client.ops.list.map((d) => d.name);
    expect(names.slice(-3)).toEqual(['ping', 'show', 'reboot']);
    expect(names.indexOf('get')).toBeLessThan(names.indexOf('ping'));
    expect(client.ops.list.find((d) => d.name === 'show')!.device).toBe('acme');
    await client.close();
  });

  it('ops.run runs a profile operation exactly as ops.device.call does', async () => {
    const { fake, client } = await open(compile(showProfile));
    const viaCall = await client.ops.device.call('show', { command: 'show version' });
    const viaRun = await client.ops.run('show', { command: 'show version' });
    expect(viaRun).toBe('version 1.2');
    expect(viaRun).toEqual(viaCall);
    const shows = fake.requests.filter((r) => r.elements[0]!.name === 'show').map((r) => serializeXml(r.elements[0]!));
    expect(shows).toHaveLength(2);
    expect(shows[1]).toBe(shows[0]);
    await expect(client.ops.run('show', {})).rejects.toThrow(/command/);
    await client.close();
  });

  it('a profile operation named like a base operation makes connect() reject, closing the session first', async () => {
    const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
    const clash = compile({ id: 'clash', operations: { lock: { request: '<my-lock xmlns="urn:example:x"/>' } } });
    const err = await connect({ transport: fake.transport(), profile: clash }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(/Profile clash has an operation named "lock", which is already a base operation/);
    expect(fake.requests.at(-1)?.elements[0]?.name).toBe('close-session');
  });

  it('a profile operation named like an enabled extension operation makes connect() reject, naming the extension', async () => {
    const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
    const ping = defineExtension({
      id: 'pinger',
      descriptors: [{ name: 'ping', namespace: 'urn:example:ping', method: 'ping', description: 'Ping', mutates: false, requires: [], params: [] }],
      requests: { ping: () => ({ element: x('ping'), requires: [] }) },
    });
    const clash = compile({ id: 'clash', operations: { ping: { request: '<ping xmlns="urn:example:x"/>' } } });
    const err = await connect({ transport: fake.transport(), profile: clash, extensions: [ping] }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/"ping", which is already an operation of the pinger extension/);
    expect(fake.requests.at(-1)?.elements[0]?.name).toBe('close-session');
  });
});

describe('built-in profiles', () => {
  it("nokia-sros-md's cli operation is left unmarked, so it counts as changing state", async () => {
    const sros = (await builtinDeviceProfiles()).find((p) => p.id === 'nokia-sros-md')!;
    expect(sros.descriptors!['cli']!.mutates).toBe(true);
  });

  it('no built-in profile marks an operation as read-only without saying so in its file', async () => {
    for (const p of await builtinDeviceProfiles()) {
      const raw = JSON.parse(await readFile(join(BUILTIN_PROFILES_DIR, `${p.id}.json`), 'utf8')) as {
        operations?: Record<string, { mutates?: boolean }>;
      };
      for (const [name, d] of Object.entries(p.descriptors ?? {})) {
        expect(d.mutates, `${p.id} ${name}`).toBe(raw.operations?.[name]?.mutates ?? true);
      }
    }
  });
});
