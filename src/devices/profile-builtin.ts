/**
 * The built-in device profiles (design §6.4) and the compile steps loading
 * shares. The profiles/*.json files are the source; builtin-profiles.ts is
 * generated from them at build time (scripts/gen-builtin-profiles.mjs), so
 * the built-ins need no filesystem and work in any runtime.
 */

import { BUILTIN_PROFILE_FILES } from './builtin-profiles.js';
import type { DeviceProfile } from './device.js';
import { compileProfile, ProfileError, type DeviceProfileSpec } from './profile-spec.js';

/** The device profiles shipped with the package, compiled; ready for `autoDetect([...])`. */
export function builtinDeviceProfiles(): Promise<DeviceProfile[]> {
  return Promise.resolve(
    resolveAll(builtinFiles(), new Map()).map((r) => ({ ...r.profile, source: { type: 'builtin' as const, file: r.file } })),
  );
}

/** @internal The built-in profiles' specs by id, for `extends`. */
export function builtinSpecs(): Map<string, DeviceProfileSpec> {
  builtinCache ??= new Map(resolveAll(builtinFiles(), new Map()).map((r) => [r.spec.id, r.spec]));
  return builtinCache;
}

let builtinCache: Map<string, DeviceProfileSpec> | undefined;

function builtinFiles(): RawFile[] {
  return BUILTIN_PROFILE_FILES.map(({ name, json }) => ({ file: `@node-net/netconf/profiles/${name}`, raw: JSON.parse(json) as unknown }));
}

/** @internal A profile's raw JSON and where it came from. */
export interface RawFile {
  readonly file: string;
  readonly raw: unknown;
}

/** @internal Compile files in dependency order, so `extends` can point at any of them. */
export function resolveAll(files: readonly RawFile[], bases: Map<string, DeviceProfileSpec>): { spec: DeviceProfileSpec; profile: DeviceProfile; file: string }[] {
  const byId = new Map<string, RawFile>();
  for (const f of files) {
    const id = (f.raw as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') throw new ProfileError(`${f.file}: a device profile needs an "id"`);
    if (byId.has(id)) throw new ProfileError(`${f.file}: duplicate profile id ${JSON.stringify(id)}`);
    byId.set(id, f);
  }
  const done = new Map<string, { spec: DeviceProfileSpec; profile: DeviceProfile }>();
  const visiting = new Set<string>();
  const visit = (id: string): DeviceProfileSpec => {
    const finished = done.get(id);
    if (finished) return finished.spec;
    const f = byId.get(id);
    if (f === undefined) {
      const base = bases.get(id);
      if (base === undefined) throw new ProfileError(`Profile ${JSON.stringify(id)} not found`);
      return base;
    }
    if (visiting.has(id)) throw new ProfileError(`${f.file}: profiles extend each other in a cycle`);
    visiting.add(id);
    const parentId = (f.raw as { extends?: unknown }).extends;
    const parent = typeof parentId === 'string' ? visit(parentId) : undefined;
    const result = withFile(f.file, () => compileProfile(f.raw, parent));
    visiting.delete(id);
    done.set(id, result);
    return result.spec;
  };
  for (const id of byId.keys()) visit(id);
  return [...byId.entries()].map(([id, f]) => ({ ...done.get(id)!, file: f.file }));
}

/** @internal Compile one profile against known bases for `extends`. */
export function compileWithBases(raw: unknown, bases: ReadonlyMap<string, DeviceProfileSpec>, source: string | object): { spec: DeviceProfileSpec; profile: DeviceProfile } {
  const parentId = (raw as { extends?: unknown } | null)?.extends;
  let parent: DeviceProfileSpec | undefined;
  if (typeof parentId === 'string') {
    parent = bases.get(parentId);
    if (parent === undefined) throw new ProfileError(`extends: profile ${JSON.stringify(parentId)} not found`);
  }
  return withFile(typeof source === 'string' ? source : '(object)', () => compileProfile(raw, parent));
}

function withFile<T>(file: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ProfileError && !err.message.startsWith(file)) {
      throw new ProfileError(`${file}: ${err.message}`, { cause: err.cause });
    }
    throw err;
  }
}
