import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinDeviceProfiles, defineDeviceProfile, loadDeviceProfile, loadDeviceProfiles, type DeviceProfileSpec } from '../../src/index.js';

const BASE = {
  $schema: './profile.schema.json',
  id: 'acme-base',
  vendor: 'ACME',
  description: 'The ACME family.',
  notes: ['Base note.'],
  match: { anyModule: ['acme-conf'] },
  quirks: { maxInFlight: 1 },
  workflow: { editTarget: 'candidate', commit: true },
  capabilities: { add: ['urn:acme:extra'] },
  paths: { systemName: '/acme-conf:system/name' },
  operations: {
    show: {
      description: 'Run a show command.',
      mutates: false,
      params: { command: 'string' },
      request: '<show xmlns="urn:acme"><line>{{command}}</line></show>',
      result: { path: 'output', as: 'text' },
    },
    reboot: { request: '<reboot xmlns="urn:acme"/>' },
  },
};

const CHILD = {
  id: 'acme-edge',
  extends: 'acme-base',
  description: 'ACME edge routers.',
  quirks: { closeTimeout: 500 },
  capabilities: { remove: [':candidate'] },
  paths: { hostname: '/acme-conf:system/hostname' },
  operations: {
    // A new request replaces the parent's operation entirely.
    show: { params: { line: 'string' }, request: '<cli xmlns="urn:acme:edge"><cmd>{{line}}</cmd></cli>' },
    // No request: only mutates changes.
    reboot: { mutates: true, description: 'Reboot the router.' },
  },
};

async function dirWith(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nn-definition-'));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), JSON.stringify(body));
  return dir;
}

describe('profile.definition (PROFILE-14)', () => {
  it('AC1, AC3: keeps every field and each operation as written, without $schema', async () => {
    const profile = await loadDeviceProfile(BASE);
    const { $schema: _schema, ...expected } = BASE;
    expect(profile.definition).toEqual(expected);
    expect(profile.definition).not.toHaveProperty('$schema');
    expect(profile.definition?.notes).toEqual(['Base note.']);
    expect(profile.definition?.operations?.['show']).toEqual(BASE.operations.show);
  });

  it('AC1: built-in, file, directory and JSON-string profiles all have one', async () => {
    const builtin = (await builtinDeviceProfiles()).find((p) => p.id === 'nokia-sros-md')!;
    const cli = builtin.definition?.operations?.['cli'];
    expect(cli).toMatchObject({ params: { command: 'string' }, result: { path: 'md-cli-output-block', as: 'text' } });
    expect(cli?.request).toContain('<md-cli-input-line>{{command}}</md-cli-input-line>');
    for (const p of await builtinDeviceProfiles()) expect(p.definition?.id).toBe(p.id);

    const dir = await dirWith({ 'base.json': BASE });
    expect((await loadDeviceProfile(join(dir, 'base.json'))).definition?.id).toBe('acme-base');
    expect((await loadDeviceProfiles(dir))[0]!.definition?.id).toBe('acme-base');
    expect((await loadDeviceProfile(JSON.stringify(BASE))).definition?.id).toBe('acme-base');
  });

  it('AC2: an extending profile shows the merged result, with no extends', async () => {
    const dir = await dirWith({ 'a-child.json': CHILD, 'b-base.json': BASE });
    const child = (await loadDeviceProfiles(dir)).find((p) => p.id === 'acme-edge')!;
    const d = child.definition!;
    expect(d).not.toHaveProperty('extends');
    expect(d.vendor).toBe('ACME'); // inherited
    expect(d.description).toBe('ACME edge routers.'); // child wins
    expect(d.notes).toEqual(['Base note.']);
    expect(d.quirks).toEqual({ maxInFlight: 1, closeTimeout: 500 });
    expect(d.workflow).toEqual({ editTarget: 'candidate', commit: true });
    expect(d.capabilities).toEqual({ add: ['urn:acme:extra'], remove: [':candidate'] });
    expect(d.paths).toEqual({ systemName: '/acme-conf:system/name', hostname: '/acme-conf:system/hostname' });
    // A child operation with a request replaces the parent's: no inherited description, mutates or result.
    expect(d.operations?.['show']).toEqual(CHILD.operations.show);
    // One without a request changes only the fields it gives.
    expect(d.operations?.['reboot']).toEqual({ request: '<reboot xmlns="urn:acme"/>', mutates: true, description: 'Reboot the router.' });
  });

  it('AC2: a chain of extends is merged all the way down', async () => {
    const grandchild = { id: 'acme-edge-mini', extends: 'acme-edge', paths: { uptime: '/acme-state:system/uptime' } };
    const dir = await dirWith({ 'a.json': grandchild, 'b.json': CHILD, 'c.json': BASE });
    const p = (await loadDeviceProfiles(dir)).find((x) => x.id === 'acme-edge-mini')!;
    expect(p.definition?.paths).toEqual({ systemName: '/acme-conf:system/name', hostname: '/acme-conf:system/hostname', uptime: '/acme-state:system/uptime' });
    expect(p.definition?.operations?.['reboot']?.mutates).toBe(true);
    expect(p.definition).not.toHaveProperty('extends');
  });

  it('AC4: YANG module directories are the resolved ones the profile uses', async () => {
    const dir = await dirWith({ 'acme.json': { ...BASE, yang: { modules: ['yang', '/abs/yang'], requireSchema: true } } });
    const p = await loadDeviceProfile(join(dir, 'acme.json'));
    expect(p.yang?.modules).toEqual([join(dir, 'yang'), '/abs/yang']);
    expect(p.definition?.yang).toEqual({ modules: [join(dir, 'yang'), '/abs/yang'], requireSchema: true });
  });

  it('AC5: the definition is read-only at every level, and changing it fails without effect', async () => {
    const dir = await dirWith({ 'a-child.json': CHILD, 'b-base.json': BASE, 'c-sibling.json': { id: 'acme-core', extends: 'acme-base' } });
    const all = await loadDeviceProfiles(dir);
    const base = all.find((p) => p.id === 'acme-base')!;
    const child = all.find((p) => p.id === 'acme-edge')!;
    const sibling = all.find((p) => p.id === 'acme-core')!;
    const d = child.definition as unknown as { quirks: Record<string, unknown>; operations: Record<string, Record<string, unknown>>; capabilities: { add: string[] } };
    expect(() => {
      d.quirks['maxInFlight'] = 99;
    }).toThrow(TypeError);
    expect(() => {
      d.operations['show']!['request'] = '<evil/>';
    }).toThrow(TypeError);
    expect(() => d.capabilities.add.push('urn:x')).toThrow(TypeError);
    expect(() => {
      (child.definition as unknown as Record<string, unknown>)['id'] = 'other';
    }).toThrow(TypeError);
    expect(child.definition?.quirks?.maxInFlight).toBe(1);
    // Nothing is shared with the parent or another child of it.
    expect(base.definition).not.toBe(child.definition);
    expect(base.definition?.quirks).not.toBe(sibling.definition?.quirks);
    expect(sibling.definition?.quirks).toEqual({ maxInFlight: 1 });
    expect(base.definition?.capabilities).toEqual({ add: ['urn:acme:extra'] });
  });

  it('AC6: loading the definition gives an equivalent profile', async () => {
    const dir = await dirWith({ 'a-child.json': CHILD, 'b-base.json': BASE });
    const child = (await loadDeviceProfiles(dir)).find((p) => p.id === 'acme-edge')!;
    const again = await loadDeviceProfile(child.definition as DeviceProfileSpec);
    for (const key of ['id', 'match', 'quirks', 'workflow', 'paths', 'capabilities', 'descriptors'] as const) {
      expect(again[key], key).toEqual(child[key]);
    }
    expect(Object.keys(again.operations ?? {})).toEqual(Object.keys(child.operations ?? {}));
    expect(again.definition).toEqual(child.definition);
    // The same JSON again, through text.
    expect((await loadDeviceProfile(JSON.stringify(child.definition))).definition).toEqual(child.definition);
  });

  it('AC7: a defineDeviceProfile() profile has no definition', () => {
    expect(defineDeviceProfile({ id: 'in-code' }).definition).toBeUndefined();
  });
});
