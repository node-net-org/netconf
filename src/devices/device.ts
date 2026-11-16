/**
 * Device profiles (design §6, §6.4, §7).
 *
 * A profile tells @node-net/netconf how a kind of device differs from the RFCs and
 * what it offers beyond them. Profiles are usually JSON files compiled by
 * profile-spec.ts; TypeScript profiles (defineDeviceProfile) produce the same object.
 */

import { CONTENT_QUIRK_NAMES, type ContentQuirks, type Workflow } from '../content/index.js';
import { SESSION_QUIRK_NAMES, type RpcContext, type ServerHello, type SessionQuirks } from '../messages/index.js';
import type { OperationDescriptor } from '../operations/index.js';
import type { SshOptions } from '../transport/index.js';

/**
 * Known deviations from the RFCs (design §7). Each is a named switch defined
 * and tested by the layer it affects; a profile can only turn switches on.
 * A profile sets one flat object; NetconfClient hands each layer its part.
 */
export type Quirks = SessionQuirks & ContentQuirks;

/**
 * The name of every quirk a profile can set, for tools that list quirks or
 * check a profile's quirk names. See [Quirks](/profiles/quirks).
 */
export const QUIRK_NAMES: readonly (keyof Quirks)[] = [...SESSION_QUIRK_NAMES, ...CONTENT_QUIRK_NAMES];

/** Connection settings a profile can default. Spread into ssh(): `ssh({ ...profile.connection, host, ... })`. */
export type ConnectionDefaults = Partial<
  Pick<SshOptions, 'port' | 'subsystem' | 'command' | 'keepaliveInterval' | 'keepaliveCountMax' | 'algorithms'>
>;

/** Detection rules. All given groups must match. */
export interface DeviceMatch {
  /** Any of these capability URIs (query ignored). A trailing `*` matches a prefix. */
  readonly anyCapability?: readonly string[];
  /** Any of these YANG modules advertised. */
  readonly anyModule?: readonly string[];
  /** All of these YANG modules advertised. */
  readonly allModules?: readonly string[];
}

/** What a profile operation can use: the session's RpcContext. No connection, no framing. */
export type DeviceContext = RpcContext;

/** A profile operation written in code: sends its RPCs through `ctx` and returns the result. */
export type DeviceOperation = (ctx: DeviceContext, params: Readonly<Record<string, unknown>>) => Promise<unknown>;

/**
 * How a kind of device differs from the RFCs and what it offers beyond them:
 * detection rules, connection defaults, quirks, capability corrections, the
 * edit workflow, named paths and the device's own operations. Load one from
 * JSON with `loadDeviceProfile()`, take a built-in one, or write one with
 * {@link defineDeviceProfile}; pass it to `connect({ profile })`, or several
 * through {@link autoDetect}. See [Device profiles](/profiles/).
 */
export interface DeviceProfile {
  /** The profile's unique name, such as `nokia-7210-sas`. */
  readonly id: string;
  /** The vendor, for people reading the profile. */
  readonly vendor?: string;
  /** What devices and software the profile covers, for people reading it. */
  readonly description?: string;
  /**
   * `'verified'` once tested against a real device; see `testedWith`.
   * Auto-detecting an `'unverified'` profile logs a warning.
   */
  readonly status?: 'verified' | 'unverified';
  /** The device models and software versions the profile was tested against. */
  readonly testedWith?: readonly {
    /** The device model. */
    readonly model: string;
    /** The software version. */
    readonly version: string;
  }[];
  /** Score how well a server hello matches this profile; 0 means no match. */
  readonly detect?: (hello: ServerHello) => number;
  /** A JSON profile's match rules (merged with its parent's when it extends one), which `detect` scores. */
  readonly match?: DeviceMatch;
  /** Where a loaded profile came from. Unset for a profile made in code with defineDeviceProfile(). */
  readonly source?: ProfileSource;
  /**
   * Defaults for `ssh()`, such as the port. They are needed before the hello, so
   * they only apply when you spread them into `ssh()` yourself.
   */
  readonly connection?: ConnectionDefaults;
  /** Switches for the device's known deviations from the RFCs. See [Quirks](/profiles/quirks). */
  readonly quirks?: Quirks;
  /** Corrections to the capabilities the server advertises; capability checks use the corrected set. */
  readonly capabilities?: {
    /** Capability URIs to treat as advertised. */
    readonly add?: readonly string[];
    /** Capability URIs to treat as not advertised. */
    readonly remove?: readonly string[];
  };
  /**
   * How `set()`, `remove()` and `configure()` apply changes on this device.
   * Anything left out comes from what the server advertises.
   */
  readonly workflow?: Partial<Workflow>;
  /** Module name → namespace, for modules the device uses but the server doesn't advertise. */
  readonly namespaces?: Readonly<Record<string, string>>;
  /** Named paths, usable as `@name` wherever a path is accepted. */
  readonly paths?: Readonly<Record<string, string>>;
  /** The device's own operations by name, called with `client.ops.device.call(name, params)`. */
  readonly operations?: Readonly<Record<string, DeviceOperation>>;
  /**
   * Each operation described as plain data, by operation name. JSON profiles
   * always have them. An operation without one is described conservatively:
   * no parameters, and `mutates: true`.
   */
  readonly descriptors?: Readonly<Record<string, OperationDescriptor>>;
  /** YANG schemas for RFC 7951 JSON output (`format: 'json'`). */
  readonly yang?: YangSettings;
  /**
   * The effective JSON definition this profile was compiled from, in the
   * profile file format: `extends` merged away, `$schema` left out, YANG module
   * directories resolved. It holds each operation's `request` template and
   * `result` rule, so tools can show what an operation sends without running
   * it. Deeply frozen. Unset for a profile made in code with defineDeviceProfile().
   */
  readonly definition?: DeviceProfileSpec;
}

/** A device profile's YANG settings, for RFC 7951 JSON output. */
export interface YangSettings {
  /**
   * Directories of YANG modules the device uses but the server can't serve
   * with `<get-schema>`. In a profile file they are relative to the file.
   */
  readonly modules?: readonly string[];
  /** Refuse to convert data without a YANG schema, unless the connection or the call says otherwise. */
  readonly requireSchema?: boolean;
}

/** The type of a profile operation's parameter; a trailing `?` makes it optional. */
export type ProfileParamType = 'string' | 'number' | 'boolean' | 'string?' | 'number?' | 'boolean?';

/**
 * A profile file's operation: a vendor RPC as an XML template.
 * See [`operations`](/profiles/writing#operations).
 */
export interface OperationSpec {
  /** What the operation does, shown in tools such as the CLI. */
  readonly description?: string;
  /**
   * Whether the operation can change device state. Left out, it counts as
   * possibly changing state, so tools treat it as a write.
   */
  readonly mutates?: boolean;
  /** Each parameter's type, by name. */
  readonly params?: Readonly<Record<string, ProfileParamType>>;
  /**
   * The operation element as XML. `{{param}}` may be a whole text node or attribute value.
   * Required, except in a profile that `extends` another and only changes other fields.
   */
  readonly request?: string;
  /** What to return from the reply. Left out, the whole reply. */
  readonly result?: {
    /** `/`-separated local names, relative to `<rpc-reply>`. */
    readonly path?: string;
    /** Default: `'element'` with a path, `'reply'` without. */
    readonly as?: 'text' | 'element' | 'object' | 'reply';
  };
}

/**
 * The JSON shape of a device profile file. See profiles/profile.schema.json
 * and [Writing a profile](/profiles/writing).
 */
export interface DeviceProfileSpec {
  /** The JSON schema, for editor checking and autocomplete; ignored when loading. */
  readonly $schema?: string;
  /** The profile's unique name. The only required field. */
  readonly id: string;
  /** The `id` of a profile to build on; each section is merged key by key. */
  readonly extends?: string;
  /** The vendor, for people reading the profile. */
  readonly vendor?: string;
  /** What devices and software the profile covers, for people reading it. */
  readonly description?: string;
  /** `'verified'` once tested against a real device. Auto-detecting an `'unverified'` profile logs a warning. */
  readonly status?: 'verified' | 'unverified';
  /** The device models and software versions the profile was tested against. */
  readonly testedWith?: readonly {
    /** The device model. */
    readonly model: string;
    /** The software version. */
    readonly version: string;
  }[];
  /** Anything surprising found while testing, for people reading the profile. */
  readonly notes?: readonly string[];
  /** Rules for auto-detection from the server's hello. See [`match`](/profiles/writing#match). */
  readonly match?: DeviceMatch;
  /** Defaults for `ssh()`. See [`connection`](/profiles/writing#connection). */
  readonly connection?: ConnectionDefaults;
  /** Switches for the device's known deviations from the RFCs. See [Quirks](/profiles/quirks). */
  readonly quirks?: Quirks;
  /** Corrections to the capabilities the server advertises. */
  readonly capabilities?: {
    /** Capability URIs to treat as advertised. */
    readonly add?: readonly string[];
    /** Capability URIs to treat as not advertised. */
    readonly remove?: readonly string[];
  };
  /** How changes are applied on this device. See [`workflow`](/profiles/writing#workflow). */
  readonly workflow?: Partial<Workflow>;
  /** Module name → namespace, for modules the device uses but the server doesn't advertise, or advertises wrongly. */
  readonly namespaces?: Readonly<Record<string, string>>;
  /** Named paths, usable as `@name`. See [`paths`](/profiles/writing#paths). */
  readonly paths?: Readonly<Record<string, string>>;
  /** Vendor RPCs as XML templates, by name. See [`operations`](/profiles/writing#operations). */
  readonly operations?: Readonly<Record<string, OperationSpec>>;
  /** YANG schemas for RFC 7951 JSON conversion. See [`yang`](/profiles/writing#yang). */
  readonly yang?: YangSettings;
}

/**
 * Define a device profile in TypeScript, for behaviour a JSON profile can't
 * describe. Use it as `connect({ profile })` or in `autoDetect([...])`.
 */
export function defineDeviceProfile(profile: DeviceProfile): DeviceProfile {
  return profile;
}

/** Where a loaded profile came from: shipped with the package, a file, or a JSON string or object. */
export interface ProfileSource {
  /** `'builtin'` (shipped with the package), `'file'`, or `'inline'` (a JSON string or object). */
  readonly type: 'builtin' | 'file' | 'inline';
  /** The file it was loaded from (builtin and file). */
  readonly file?: string;
}

/** Choose a profile after the hello, by the highest detect() score. */
export interface AutoDetect {
  /** The profiles to choose from. */
  readonly autoDetect: readonly DeviceProfile[];
  /** Used when nothing matches. */
  readonly fallback?: DeviceProfile;
}

/**
 * Let the client choose a profile after the hello: the one whose `detect()`
 * scores highest, else `fallback`. Pass the result as `connect({ profile })`.
 * Settings needed before the hello, such as the port, don't apply.
 * See [Choosing a profile](/profiles/#choosing-a-profile).
 */
export function autoDetect(profiles: readonly DeviceProfile[], fallback?: DeviceProfile): AutoDetect {
  return fallback === undefined ? { autoDetect: profiles } : { autoDetect: profiles, fallback };
}

export function pickProfile(choice: AutoDetect, hello: ServerHello): DeviceProfile | undefined {
  let best: DeviceProfile | undefined;
  let bestScore = 0;
  for (const p of choice.autoDetect) {
    const score = p.detect?.(hello) ?? 0;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best ?? choice.fallback;
}

/** Build a detect() from match rules. More specific rules score higher, so they win ties. */
export function matcher(match: DeviceMatch): (hello: ServerHello) => number {
  return ({ capabilities }) => {
    let score = 1;
    if (match.anyCapability !== undefined) {
      const ok = match.anyCapability.some((pattern) =>
        pattern.endsWith('*')
          ? [...capabilities].some((c) => c.id.startsWith(pattern.slice(0, -1)))
          : capabilities.has(pattern),
      );
      if (!ok) return 0;
      score++;
    }
    if (match.anyModule !== undefined) {
      if (!match.anyModule.some((m) => capabilities.hasHelloModule(m))) return 0;
      score++;
    }
    if (match.allModules !== undefined) {
      if (!match.allModules.every((m) => capabilities.hasHelloModule(m))) return 0;
      score += match.allModules.length;
    }
    return score;
  };
}

/** A profile's operations, bound to a session. */
export interface DeviceHandle {
  readonly profile: DeviceProfile;
  /** Call a profile operation by name. */
  call(name: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
  /** Names of the profile's operations. */
  readonly operations: readonly string[];
  /** The profile's operations as plain data, in the same form as `BASE_OPERATIONS`, marked with the profile id. */
  readonly descriptors: readonly OperationDescriptor[];
}

/** Describe a profile operation, falling back to the safe assumption that it changes state. */
export function describeDeviceOperation(profile: DeviceProfile, name: string): OperationDescriptor {
  const own = Object.prototype.hasOwnProperty.call(profile.descriptors ?? {}, name) ? profile.descriptors![name] : undefined;
  // A profile operation is always run with client.ops.device.call(), never as an extension read.
  const { kind: _kind, ...described } = own ?? { namespace: '', description: '', mutates: true, requires: [], params: [] };
  return Object.freeze({
    ...described,
    name,
    method: 'call',
    device: profile.id,
  });
}

export function bindDevice(profile: DeviceProfile, ctx: DeviceContext): DeviceHandle {
  const ops = profile.operations ?? {};
  return {
    profile,
    operations: Object.keys(ops),
    descriptors: Object.freeze(Object.keys(ops).map((name) => describeDeviceOperation(profile, name))),
    call: async (name, params = {}) => {
      const op = Object.prototype.hasOwnProperty.call(ops, name) ? ops[name] : undefined;
      if (op === undefined) {
        throw new TypeError(`Profile ${profile.id} has no operation ${JSON.stringify(name)}`);
      }
      return op(ctx, params);
    },
  };
}
