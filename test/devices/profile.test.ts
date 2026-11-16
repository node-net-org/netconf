import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { CapabilitySet } from '../../src/messages/capabilities.js';
import type { DeviceContext } from '../../src/devices/device.js';
import { compileProfile } from '../../src/devices/profile-spec.js';
import {
  BASE_1_0,
  BUILTIN_PROFILES_DIR,
  builtinDeviceProfiles,
  loadDeviceProfile,
  loadDeviceProfiles,
  NETCONF_NS,
  parseXml,
  ProfileError,
  serializeXml,
  type XmlElement,
} from '../../src/index.js';

/** A DeviceContext that records requests and answers with a canned reply. */
function fakeContext(replyXml = `<rpc-reply xmlns="${NETCONF_NS}"><ok/></rpc-reply>`) {
  const sent: string[] = [];
  const ctx: DeviceContext = {
    rpc: (op) => {
      sent.push(typeof op === 'string' ? op : serializeXml(op));
      const element = parseXml(replyXml);
      return Promise.resolve({ messageId: '1', element, data: element.child('data'), ok: element.child('ok') !== undefined, output: [], warnings: [] });
    },
    serverCapabilities: new CapabilitySet([BASE_1_0]),
    sessionId: 1,
    logger: {},
    onNotification: () => () => undefined,
    onClosed: () => () => undefined,
    addRpcGuard: () => () => undefined,
  };
  return { ctx, sent };
}

const op = (request: string, params: Record<string, string> = {}, result?: object) => ({
  id: 'test',
  operations: { go: { request, params, ...(result ? { result } : {}) } },
});

describe('operation templates', () => {
  it('substitutes parameters as text, escaped, so they cannot inject XML', async () => {
    const { profile } = compileProfile(op('<show xmlns="urn:v"><cmd>{{command}}</cmd></show>', { command: 'string' }));
    const { ctx, sent } = fakeContext();
    await profile.operations!['go']!(ctx, { command: '</cmd><reboot/><cmd>' });
    expect(sent[0]).toBe('<show xmlns="urn:v"><cmd>&lt;/cmd&gt;&lt;reboot/&gt;&lt;cmd&gt;</cmd></show>');
  });

  it('substitutes attribute values and numbers, and drops elements for absent optional params', async () => {
    const { profile } = compileProfile(
      op('<get-x xmlns="urn:v" level="{{level}}"><name>{{name}}</name><count>{{count}}</count></get-x>', {
        level: 'string?',
        name: 'string',
        count: 'number?',
      }),
    );
    const { ctx, sent } = fakeContext();
    await profile.operations!['go']!(ctx, { name: 'a', count: 3 });
    await profile.operations!['go']!(ctx, { name: 'b', level: 'detail' });
    expect(sent).toEqual([
      '<get-x xmlns="urn:v"><name>a</name><count>3</count></get-x>',
      '<get-x xmlns="urn:v" level="detail"><name>b</name></get-x>',
    ]);
  });

  it('puts unqualified templates in the NETCONF namespace', async () => {
    const { profile } = compileProfile(op('<get-chassis-inventory/>'));
    const { ctx, sent } = fakeContext();
    await profile.operations!['go']!(ctx, {});
    expect(sent[0]).toBe(`<get-chassis-inventory xmlns="${NETCONF_NS}"/>`);
  });

  it('checks parameter types and names at call time', async () => {
    const { profile } = compileProfile(op('<a xmlns="urn:v">{{n}}</a>', { n: 'number' }));
    const { ctx } = fakeContext();
    await expect(profile.operations!['go']!(ctx, {})).rejects.toThrow(/n is required/);
    await expect(profile.operations!['go']!(ctx, { n: '1' })).rejects.toThrow(/must be a number/);
    await expect(profile.operations!['go']!(ctx, { n: 1, extra: 2 })).rejects.toThrow(/unknown parameter "extra"/);
  });

  it('extracts results as text, element, object or the whole reply', async () => {
    const reply = `<rpc-reply xmlns="${NETCONF_NS}"><out xmlns="urn:v"><line>a</line><line>b</line></out></rpc-reply>`;
    const run = async (as?: string) => {
      const { profile } = compileProfile(op('<x/>', {}, as === undefined ? { path: 'out' } : { path: 'out', as }));
      return profile.operations!['go']!(fakeContext(reply).ctx, {});
    };
    expect(await run('text')).toBe('ab');
    expect(((await run()) as XmlElement).name).toBe('out');
    expect(await run('object')).toEqual({ line: ['a', 'b'] });
  });

  it.each([
    ['placeholder inside other text', '<a xmlns="urn:v">show {{x}}</a>', { x: 'string' }, /whole text/],
    ['placeholder inside an attribute', '<a xmlns="urn:v" k="v-{{x}}"/>', { x: 'string' }, /whole value of attribute/],
    ['undeclared placeholder', '<a xmlns="urn:v">{{x}}</a>', {}, /not in params/],
    ['unused parameter', '<a xmlns="urn:v"/>', { x: 'string' }, /declared but not used/],
    ['malformed XML', '<a xmlns="urn:v">', {}, /request/],
    ['a DOCTYPE', '<!DOCTYPE a><a/>', {}, /DOCTYPE/],
  ])('rejects a template with %s at load time', (_label, request, params, message) => {
    expect(() => compileProfile(op(request, params as Record<string, string>))).toThrow(ProfileError);
    expect(() => compileProfile(op(request, params as Record<string, string>))).toThrow(message);
  });
});

describe('profile validation', () => {
  it.each([
    [{}, /needs an "id"/],
    [{ id: 'Bad Id' }, /needs an "id"/],
    [{ id: 'p', colour: 'red' }, /profile p: colour is not a known field/],
    [{ id: 'p', quirks: { fastMode: true } }, /quirks.fastMode is not a known field/],
    [{ id: 'p', quirks: { maxInFlight: 0 } }, /quirks.maxInFlight must be an integer from 1/],
    [{ id: 'p', workflow: { editTarget: 'startup' } }, /workflow.editTarget must be one of "running", "candidate"/],
    [{ id: 'p', quirks: { invalidXmlChars: 'ignore' } }, /quirks.invalidXmlChars must be one of "reject", "strip"/],
    [{ id: 'p', quirks: { paddedEmptyElements: 'yes' } }, /quirks.paddedEmptyElements must be one of "keep", "strip"/],
    [{ id: 'p', quirks: { subtreeFilter: 'sometimes' } }, /quirks.subtreeFilter must be one of "supported", "unsupported", "containers"/],
    [{ id: 'p', quirks: { subtreeFilter: 'containers' } }, /quirks.subtreeFilter "containers" needs quirks.subtreeFilterDepth/],
    [{ id: 'p', quirks: { subtreeFilterDepth: 2 } }, /quirks.subtreeFilterDepth is only used with quirks.subtreeFilter "containers"/],
    [{ id: 'p', quirks: { subtreeFilter: 'containers', subtreeFilterDepth: 0 } }, /quirks.subtreeFilterDepth must be an integer from 1/],
    [{ id: 'p', connection: { port: 99999 } }, /connection.port must be an integer/],
    [{ id: 'p', paths: { bad: 'no-slash' } }, /paths.bad/],
    [{ id: 'p', operations: { 'bad-name': { request: '<a/>' } } }, /must be an identifier/],
    [{ id: 'p', operations: { go: {} } }, /operations.go.request must be a string/],
  ])('rejects %j with a message naming the field', (raw, message) => {
    expect(() => compileProfile(raw)).toThrow(ProfileError);
    expect(() => compileProfile(raw)).toThrow(message);
  });

  it('checks subtreeFilter and subtreeFilterDepth after merging, so a child profile can set either', () => {
    const { spec } = compileProfile({ id: 'base', quirks: { subtreeFilter: 'containers', subtreeFilterDepth: 2 } });
    expect(compileProfile({ id: 'deeper', quirks: { subtreeFilterDepth: 3 } }, spec).profile.quirks).toEqual({
      subtreeFilter: 'containers',
      subtreeFilterDepth: 3,
    });
    expect(() => compileProfile({ id: 'whole', quirks: { subtreeFilter: 'unsupported' } }, spec)).toThrow(/subtreeFilterDepth is only used/);
  });

  it('detects from match rules, preferring more specific profiles', () => {
    const hello = { sessionId: 1, capabilities: new CapabilitySet([BASE_1_0, 'urn:x:conf?module=x-conf', 'urn:vendor:special:1.0']) };
    const general = compileProfile({ id: 'g', match: { anyModule: ['x-conf'] } }).profile;
    const specific = compileProfile({ id: 's', match: { anyModule: ['x-conf'], anyCapability: ['urn:vendor:*'] } }).profile;
    const other = compileProfile({ id: 'o', match: { allModules: ['x-conf', 'y-conf'] } }).profile;
    expect(general.detect!(hello)).toBeGreaterThan(0);
    expect(specific.detect!(hello)).toBeGreaterThan(general.detect!(hello));
    expect(other.detect!(hello)).toBe(0);
  });
});

describe('loading profiles', () => {
  it('loads the built-in profiles, and every one matches the published JSON Schema', async () => {
    const profiles = await builtinDeviceProfiles();
    expect(profiles.map((p) => p.id).sort()).toEqual(['lab', 'nokia-7210-sas', 'nokia-sros-md', 'sysrepo-netopeer2']);

    const ajv = new Ajv2020({ allErrors: true });
    const validate = ajv.compile(JSON.parse(await readFile(join(BUILTIN_PROFILES_DIR, 'profile.schema.json'), 'utf8')) as object);
    for (const id of profiles.map((p) => p.id)) {
      const raw = JSON.parse(await readFile(join(BUILTIN_PROFILES_DIR, `${id}.json`), 'utf8')) as unknown;
      expect(validate(raw), `${id}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });

  it('the JSON Schema rejects what the loader rejects', async () => {
    const ajv = new Ajv2020();
    const validate = ajv.compile(JSON.parse(await readFile(join(BUILTIN_PROFILES_DIR, 'profile.schema.json'), 'utf8')) as object);
    for (const bad of [
      { id: 'p', colour: 'red' },
      { id: 'p', quirks: { fastMode: true } },
      { id: 'p', workflow: { editTarget: 'startup' } },
      { id: 'p', operations: { 'bad-name': { request: '<a/>' } } },
      { id: 'p', operations: { go: { request: '<a/>', params: { x: 'date' } } } },
    ]) {
      expect(validate(bad), JSON.stringify(bad)).toBe(false);
      expect(() => compileProfile(bad)).toThrow(ProfileError);
    }
  });

  it('loads a user directory whose profiles extend each other and a built-in', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nn-profiles-'));
    await writeFile(join(dir, 'b-child.json'), JSON.stringify({ id: 'acme-edge', extends: 'acme-base', quirks: { maxInFlight: 1 } }));
    await writeFile(
      join(dir, 'a-base.json'),
      JSON.stringify({ id: 'acme-base', extends: 'nokia-sros-md', vendor: 'ACME', paths: { hostname: '/acme:system/hostname' } }),
    );
    const profiles = await loadDeviceProfiles(dir);
    const edge = profiles.find((p) => p.id === 'acme-edge')!;
    expect(edge.vendor).toBe('ACME');
    expect(edge.quirks).toEqual({ maxInFlight: 1 });
    expect(edge.paths).toEqual({ systemName: '/nokia-conf:configure/system/name', hostname: '/acme:system/hostname' });
    expect(Object.keys(edge.operations!)).toEqual(['cli']);
    expect(edge.detect).toBeDefined(); // match inherited from nokia-sros-md
  });

  it('reports extends cycles, unknown parents, duplicate ids and bad JSON with the file name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nn-profiles-'));
    await writeFile(join(dir, 'a.json'), JSON.stringify({ id: 'a', extends: 'b' }));
    await writeFile(join(dir, 'b.json'), JSON.stringify({ id: 'b', extends: 'a' }));
    await expect(loadDeviceProfiles(dir)).rejects.toThrow(/cycle/);

    await expect(loadDeviceProfile({ id: 'x', extends: 'nope' })).rejects.toThrow(/"nope" not found/);

    const dup = await mkdtemp(join(tmpdir(), 'nn-profiles-'));
    await writeFile(join(dup, 'one.json'), JSON.stringify({ id: 'same' }));
    await writeFile(join(dup, 'two.json'), JSON.stringify({ id: 'same' }));
    await expect(loadDeviceProfiles(dup)).rejects.toThrow(/duplicate profile id "same"/);

    const badFile = join(dup, 'broken.txt');
    await writeFile(badFile, '{ not json');
    await expect(loadDeviceProfile(badFile)).rejects.toThrow(/broken.txt: not valid JSON/);
  });

  it('loads a profile from a JSON string', async () => {
    const p = await loadDeviceProfile('{"id":"inline","workflow":{"editTarget":"running"}}');
    expect(p.workflow).toEqual({ editTarget: 'running' });
  });
});

describe('profile provenance (PROFILE-02, PROFILE-05)', () => {
  it('records where each profile came from', async () => {
    const builtin = (await builtinDeviceProfiles()).find((p) => p.id === 'nokia-sros-md')!;
    expect(builtin.source).toEqual({ type: 'builtin', file: '@node-net/netconf/profiles/nokia-sros-md.json' });

    const dir = await mkdtemp(join(tmpdir(), 'nn-profiles-'));
    const file = join(dir, 'acme.json');
    await writeFile(file, JSON.stringify({ id: 'acme', extends: 'nokia-sros-md' }));
    expect((await loadDeviceProfiles(dir))[0]!.source).toEqual({ type: 'file', file });
    expect((await loadDeviceProfile(file)).source).toEqual({ type: 'file', file });
    expect((await loadDeviceProfile('{"id":"inline"}')).source).toEqual({ type: 'inline' });
    expect((await loadDeviceProfile({ id: 'obj' })).source).toEqual({ type: 'inline' });
    expect(compileProfile({ id: 'compiled' }).profile.source).toBeUndefined();
  });

  it('keeps the match rules, merged from the parent when not overridden', async () => {
    const builtin = (await builtinDeviceProfiles()).find((p) => p.id === 'nokia-sros-md')!;
    expect(builtin.match).toEqual({ anyModule: ['nokia-conf'] });
    const child = await loadDeviceProfile({ id: 'child', extends: 'nokia-sros-md' });
    expect(child.match).toEqual(builtin.match);
    const own = await loadDeviceProfile({ id: 'own', match: { allModules: ['a', 'b'] } });
    expect(own.match).toEqual({ allModules: ['a', 'b'] });
    expect((await loadDeviceProfile({ id: 'none' })).match).toBeUndefined();
  });
});
