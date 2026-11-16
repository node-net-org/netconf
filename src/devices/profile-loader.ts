/**
 * Loading device profiles from JSON files (design §6.4): the Node.js part of
 * profiles. User profiles load from any file or directory, may extend the
 * built-in ones, and name YANG module directories relative to their file.
 * Only the Node entry imports this; the built-ins themselves are portable
 * (profile-builtin.ts).
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeviceProfile, ProfileSource } from './device.js';
import { builtinSpecs, compileWithBases, resolveAll, type RawFile } from './profile-builtin.js';
import { deepFreeze, ProfileError, type DeviceProfileSpec } from './profile-spec.js';

/** The package's profiles directory, where the built-in profiles' JSON and the profile schema are. */
export const BUILTIN_PROFILES_DIR = fileURLToPath(new URL('../../profiles/', import.meta.url));

/** Options for `loadDeviceProfile()`. */
export interface ProfileLoadOptions {
  /** Profiles that `extends` may refer to, by id. Built-ins are always available. */
  readonly bases?: ReadonlyMap<string, DeviceProfileSpec>;
}

/**
 * Load one profile from a JSON file, a JSON string, or an already-parsed object.
 * @throws ProfileError
 */
export async function loadDeviceProfile(source: string | object, options: ProfileLoadOptions = {}): Promise<DeviceProfile> {
  const isFile = typeof source === 'string' && !isJsonText(source);
  const raw = typeof source === 'string' ? await readSource(source) : source;
  const bases = new Map([...builtinSpecs(), ...(options.bases ?? [])]);
  const from: ProfileSource = isFile ? { type: 'file', file: source } : { type: 'inline' };
  return withSource(compileWithBases(raw, bases, source).profile, from);
}

/**
 * Load every `*.json` profile in a directory. Profiles may extend each other
 * and the built-ins, in any order.
 */
export async function loadDeviceProfiles(dir: string): Promise<DeviceProfile[]> {
  const raws = await readDir(dir);
  const bases = new Map(builtinSpecs());
  return resolveAll(raws, bases).map((r) => withSource(r.profile, { type: 'file', file: r.file }));
}

// --- internals ---------------------------------------------------------------

async function readDir(dir: string): Promise<RawFile[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json') && !n.endsWith('.schema.json')).sort();
  return Promise.all(names.map(async (n) => ({ file: join(dir, n), raw: await readJson(join(dir, n)) })));
}

/** Record where a profile came from, and resolve its YANG module directories against its file. */
function withSource(profile: DeviceProfile, source: ProfileSource): DeviceProfile {
  const modules = profile.yang?.modules;
  if (modules === undefined || source.file === undefined) return { ...profile, source };
  const base = dirname(source.file);
  const yang = { ...profile.yang, modules: modules.map((m) => resolve(base, m)) };
  // The definition shows the directories the profile actually uses.
  const definition = profile.definition === undefined ? undefined : deepFreeze({ ...profile.definition, yang: { ...profile.definition.yang, modules: [...yang.modules] } });
  return { ...profile, source, yang, ...(definition !== undefined ? { definition } : {}) };
}

function isJsonText(source: string): boolean {
  return source.trimStart().startsWith('{');
}

async function readSource(source: string): Promise<unknown> {
  if (isJsonText(source)) return parseJson(source, '(string)');
  return readJson(source);
}

async function readJson(file: string): Promise<unknown> {
  return parseJson(await readFile(file, 'utf8'), file);
}

function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new ProfileError(`${where}: not valid JSON: ${(err as Error).message}`, { cause: err });
  }
}
