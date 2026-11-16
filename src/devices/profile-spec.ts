/**
 * JSON device profiles (design §6.4, level 3): validation, XML templates and
 * compilation into a DeviceProfile. Adding a device should need only a file.
 */

import { NetconfError } from '../errors.js';
import { parseXml, toObject, XmlElement, type XmlAttribute, type XmlNode } from '../xml/index.js';
import { compileNamedPath } from '../content/index.js';
import { NETCONF_NS } from '../messages/index.js';
import type { OperationDescriptor, ParamDescriptor } from '../operations/index.js';
import {
  matcher,
  QUIRK_NAMES,
  type DeviceOperation,
  type DeviceProfile,
  type DeviceProfileSpec,
  type OperationSpec,
  type ProfileParamType,
} from './device.js';

export type { DeviceProfileSpec, OperationSpec, ProfileParamType };

/** A profile file is invalid. The message names the profile and the field. */
export class ProfileError extends NetconfError {
  /** Always `'ProfileError'`. */
  override name = 'ProfileError';
  /** Always `'ERR_NETCONF_PROFILE'`. */
  override readonly code = 'ERR_NETCONF_PROFILE';
}

const TOP_LEVEL = new Set([
  '$schema', 'id', 'extends', 'vendor', 'description', 'status', 'testedWith', 'notes', 'match',
  'connection', 'quirks', 'capabilities', 'workflow', 'namespaces', 'paths', 'operations', 'yang',
]);

/**
 * Validate a parsed profile file and compile it.
 * @param base The resolved `extends` parent, if any.
 * @throws ProfileError naming the profile and field.
 */
export function compileProfile(raw: unknown, base?: DeviceProfileSpec): { spec: DeviceProfileSpec; profile: DeviceProfile } {
  const own = validateSpec(raw);
  const spec = base === undefined ? own : mergeSpecs(base, own);
  const where = (field: string): string => `profile ${spec.id}: ${field}`;

  const operations: Record<string, DeviceOperation> = {};
  const descriptors: Record<string, OperationDescriptor> = {};
  for (const [name, op] of Object.entries(spec.operations ?? {})) {
    const compiled = compileOperation(op, where(`operations.${name}`));
    operations[name] = compiled.run;
    descriptors[name] = describeOperation(name, op, compiled.namespace, spec.id);
  }
  // Checked after merging, so a child profile can set either of the pair.
  const containers = spec.quirks?.subtreeFilter === 'containers';
  if (containers && spec.quirks?.subtreeFilterDepth === undefined) {
    throw new ProfileError(where('quirks.subtreeFilter "containers" needs quirks.subtreeFilterDepth'));
  }
  if (!containers && spec.quirks?.subtreeFilterDepth !== undefined) {
    throw new ProfileError(where('quirks.subtreeFilterDepth is only used with quirks.subtreeFilter "containers"'));
  }
  for (const [name, path] of Object.entries(spec.paths ?? {})) {
    if (name === '' || /[()/]/.test(name) || name.startsWith('@')) {
      throw new ProfileError(where(`paths: the name ${JSON.stringify(name)} can't be empty, start with @ or hold (, ) or /`));
    }
    try {
      compileNamedPath(path);
    } catch (err) {
      throw new ProfileError(`${where(`paths.${name}`)}: ${(err as Error).message}`, { cause: err });
    }
  }

  const profile: DeviceProfile = {
    id: spec.id,
    ...(spec.vendor !== undefined ? { vendor: spec.vendor } : {}),
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    ...(spec.status !== undefined ? { status: spec.status } : {}),
    ...(spec.testedWith !== undefined ? { testedWith: spec.testedWith } : {}),
    ...(spec.match !== undefined ? { match: spec.match, detect: matcher(spec.match) } : {}),
    ...(spec.connection !== undefined ? { connection: spec.connection } : {}),
    ...(spec.quirks !== undefined ? { quirks: spec.quirks } : {}),
    ...(spec.capabilities !== undefined ? { capabilities: spec.capabilities } : {}),
    ...(spec.workflow !== undefined ? { workflow: spec.workflow } : {}),
    ...(spec.namespaces !== undefined ? { namespaces: spec.namespaces } : {}),
    ...(spec.paths !== undefined ? { paths: spec.paths } : {}),
    ...(spec.yang !== undefined ? { yang: spec.yang } : {}),
    operations,
    descriptors,
    definition: definitionOf(spec),
  };
  return { spec, profile };
}

/**
 * The effective definition a compiled profile keeps: a deep, frozen copy of the
 * merged spec, so nothing shares structure with a cached parent spec.
 */
function definitionOf(spec: DeviceProfileSpec): DeviceProfileSpec {
  const { $schema: _schema, ...definition } = structuredClone(spec) as DeviceProfileSpec & { extends?: string };
  delete definition.extends;
  return deepFreeze(definition);
}

/** @internal Freeze a plain JSON value and everything in it. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** A child profile overrides its parent key by key within each section. */
export function mergeSpecs(base: DeviceProfileSpec, child: DeviceProfileSpec): DeviceProfileSpec {
  const merged: Record<string, unknown> = { ...base, ...child };
  for (const key of ['connection', 'quirks', 'workflow', 'namespaces', 'paths', 'yang'] as const) {
    if (base[key] !== undefined || child[key] !== undefined) merged[key] = { ...base[key], ...child[key] };
  }
  if (base.operations !== undefined || child.operations !== undefined) {
    // A child operation with a request replaces the parent's whole operation,
    // so a new request never inherits the old params or result. One without a
    // request changes only the fields it gives (such as mutates).
    const ops: Record<string, OperationSpec> = { ...base.operations };
    for (const [name, op] of Object.entries(child.operations ?? {})) {
      ops[name] = op.request !== undefined ? op : { ...ops[name], ...op };
    }
    merged['operations'] = ops;
  }
  if (base.capabilities !== undefined || child.capabilities !== undefined) {
    merged['capabilities'] = {
      add: [...(base.capabilities?.add ?? []), ...(child.capabilities?.add ?? [])],
      remove: [...(base.capabilities?.remove ?? []), ...(child.capabilities?.remove ?? [])],
    };
  }
  delete merged['extends'];
  return merged as unknown as DeviceProfileSpec;
}

// --- validation ------------------------------------------------------------------

function validateSpec(raw: unknown): DeviceProfileSpec {
  if (!isObject(raw)) throw new ProfileError('A device profile must be a JSON object');
  const id = raw['id'];
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    throw new ProfileError('A device profile needs an "id" of lowercase letters, digits, ".", "_" or "-"');
  }
  const v = new Validator(`profile ${id}`);
  for (const key of Object.keys(raw)) if (!TOP_LEVEL.has(key)) v.fail(key, 'is not a known field');

  v.optional(raw, 'extends', 'string');
  v.optional(raw, 'vendor', 'string');
  v.optional(raw, 'description', 'string');
  v.oneOf(raw, 'status', ['verified', 'unverified']);
  v.stringArray(raw, 'notes');
  if (raw['testedWith'] !== undefined) {
    v.array(raw, 'testedWith').forEach((t, i) => {
      v.object(t, `testedWith[${i}]`, ['model', 'version']);
      v.required(t as Record<string, unknown>, 'model', 'string', `testedWith[${i}].`);
      v.required(t as Record<string, unknown>, 'version', 'string', `testedWith[${i}].`);
    });
  }

  if (raw['match'] !== undefined) {
    const m = v.object(raw['match'], 'match', ['anyCapability', 'anyModule', 'allModules']);
    for (const k of ['anyCapability', 'anyModule', 'allModules']) v.stringArray(m, k, 'match.');
  }
  if (raw['connection'] !== undefined) {
    const c = v.object(raw['connection'], 'connection', [
      'port', 'subsystem', 'command', 'keepaliveInterval', 'keepaliveCountMax', 'algorithms',
    ]);
    v.integer(c, 'port', 'connection.', 1, 65535);
    v.optional(c, 'subsystem', 'string', 'connection.');
    v.optional(c, 'command', 'string', 'connection.');
    v.integer(c, 'keepaliveInterval', 'connection.', 0);
    v.integer(c, 'keepaliveCountMax', 'connection.', 0);
    if (c['algorithms'] !== undefined) {
      const a = v.object(c['algorithms'], 'connection.algorithms', ['kex', 'serverHostKey', 'cipher', 'hmac', 'compress']);
      for (const k of Object.keys(a)) v.stringArray(a, k, 'connection.algorithms.');
    }
  }
  if (raw['quirks'] !== undefined) {
    const q = v.object(raw['quirks'], 'quirks', QUIRK_NAMES);
    v.integer(q, 'maxInFlight', 'quirks.', 1);
    v.oneOf(q, 'forceBaseVersion', ['1.0'], 'quirks.');
    v.oneOf(q, 'replyWithoutMessageId', ['strict', 'oldest'], 'quirks.');
    v.integer(q, 'closeTimeout', 'quirks.', 1);
    v.oneOf(q, 'invalidXmlChars', ['reject', 'strip'], 'quirks.');
    v.oneOf(q, 'paddedEmptyElements', ['keep', 'strip'], 'quirks.');
    v.oneOf(q, 'subtreeFilter', ['supported', 'unsupported', 'containers'], 'quirks.');
    v.integer(q, 'subtreeFilterDepth', 'quirks.', 1);
  }
  if (raw['capabilities'] !== undefined) {
    const c = v.object(raw['capabilities'], 'capabilities', ['add', 'remove']);
    v.stringArray(c, 'add', 'capabilities.');
    v.stringArray(c, 'remove', 'capabilities.');
  }
  if (raw['workflow'] !== undefined) {
    const w = v.object(raw['workflow'], 'workflow', ['editTarget', 'lock', 'validate', 'commit']);
    v.oneOf(w, 'editTarget', ['running', 'candidate'], 'workflow.');
    for (const k of ['lock', 'validate', 'commit']) v.optional(w, k, 'boolean', 'workflow.');
  }
  for (const section of ['namespaces', 'paths']) {
    if (raw[section] === undefined) continue;
    const o = v.object(raw[section], section);
    for (const k of Object.keys(o)) v.required(o, k, 'string', `${section}.`);
  }
  if (raw['yang'] !== undefined) {
    const y = v.object(raw['yang'], 'yang', ['modules', 'requireSchema']);
    v.stringArray(y, 'modules', 'yang.');
    v.optional(y, 'requireSchema', 'boolean', 'yang.');
  }
  if (raw['operations'] !== undefined) {
    const ops = v.object(raw['operations'], 'operations');
    for (const [name, op] of Object.entries(ops)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) v.fail(`operations.${name}`, 'must be an identifier');
      const o = v.object(op, `operations.${name}`, ['description', 'mutates', 'params', 'request', 'result']);
      v.optional(o, 'description', 'string', `operations.${name}.`);
      v.optional(o, 'mutates', 'boolean', `operations.${name}.`);
      // Without extends, every operation needs a request. With it, the request
      // may come from the parent; compileOperation checks the merged result.
      if (raw['extends'] === undefined) v.required(o, 'request', 'string', `operations.${name}.`);
      else v.optional(o, 'request', 'string', `operations.${name}.`);
      if (o['params'] !== undefined) {
        const p = v.object(o['params'], `operations.${name}.params`);
        for (const k of Object.keys(p)) {
          v.oneOf(p, k, ['string', 'number', 'boolean', 'string?', 'number?', 'boolean?'], `operations.${name}.params.`);
        }
      }
      if (o['result'] !== undefined) {
        const r = v.object(o['result'], `operations.${name}.result`, ['path', 'as']);
        v.optional(r, 'path', 'string', `operations.${name}.result.`);
        v.oneOf(r, 'as', ['text', 'element', 'object', 'reply'], `operations.${name}.result.`);
      }
    }
  }
  return raw as unknown as DeviceProfileSpec;
}

class Validator {
  constructor(private readonly where: string) {}

  fail(field: string, problem: string): never {
    throw new ProfileError(`${this.where}: ${field} ${problem}`);
  }

  object(value: unknown, field: string, allowed?: readonly string[]): Record<string, unknown> {
    if (!isObject(value)) this.fail(field, 'must be an object');
    if (allowed !== undefined) {
      for (const k of Object.keys(value)) {
        if (!allowed.includes(k)) this.fail(`${field}.${k}`, `is not a known field (expected one of ${allowed.join(', ')})`);
      }
    }
    return value;
  }

  array(obj: Record<string, unknown>, key: string, prefix = ''): unknown[] {
    const value = obj[key];
    if (!Array.isArray(value)) this.fail(prefix + key, 'must be an array');
    return value;
  }

  stringArray(obj: Record<string, unknown>, key: string, prefix = ''): void {
    if (obj[key] === undefined) return;
    const arr = this.array(obj, key, prefix);
    if (!arr.every((s) => typeof s === 'string')) this.fail(prefix + key, 'must be an array of strings');
  }

  required(obj: Record<string, unknown>, key: string, type: 'string' | 'boolean', prefix = ''): void {
    if (typeof obj[key] !== type) this.fail(prefix + key, `must be a ${type}`);
  }

  optional(obj: Record<string, unknown>, key: string, type: 'string' | 'boolean', prefix = ''): void {
    if (obj[key] !== undefined) this.required(obj, key, type, prefix);
  }

  integer(obj: Record<string, unknown>, key: string, prefix: string, min: number, max = Number.MAX_SAFE_INTEGER): void {
    const value = obj[key];
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      this.fail(prefix + key, `must be an integer from ${min} to ${max}`);
    }
  }

  oneOf(obj: Record<string, unknown>, key: string, allowed: readonly string[], prefix = ''): void {
    const value = obj[key];
    if (value === undefined) return;
    if (typeof value !== 'string' || !allowed.includes(value)) {
      this.fail(prefix + key, `must be one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}`);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// --- templates -------------------------------------------------------------------

const PLACEHOLDER = /^\s*\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/;

/**
 * Compile an operation template. Placeholders may only be a whole text node
 * or a whole attribute value, so a parameter can never add markup.
 */
function compileOperation(op: OperationSpec, where: string): { run: DeviceOperation; namespace: string } {
  if (typeof op.request !== 'string') throw new ProfileError(`${where}.request must be a string`);
  let template: XmlElement;
  try {
    template = parseXml(op.request, { defaultNamespace: NETCONF_NS });
  } catch (err) {
    throw new ProfileError(`${where}.request: ${(err as Error).message}`, { cause: err });
  }
  const params = op.params ?? {};
  const used = new Set<string>();
  checkTemplate(template, params, used, where);
  for (const name of Object.keys(params)) {
    if (!used.has(name)) throw new ProfileError(`${where}.params.${name} is declared but not used in the request`);
  }
  if (op.result?.path !== undefined && !/^[A-Za-z_][\w.-]*(\/[A-Za-z_][\w.-]*)*$/.test(op.result.path)) {
    throw new ProfileError(`${where}.result.path must be "/"-separated element names`);
  }
  const as = op.result?.as ?? (op.result?.path !== undefined ? 'element' : 'reply');

  const run: DeviceOperation = async (ctx, values) => {
    for (const [name, type] of Object.entries(params)) checkParam(name, type, values[name], where);
    for (const name of Object.keys(values)) {
      if (!(name in params)) throw new TypeError(`${where}: unknown parameter ${JSON.stringify(name)}`);
    }
    const request = fill(template, values);
    const reply = await ctx.rpc(request);
    if (as === 'reply') return reply;
    const target = op.result?.path === undefined ? reply.element : reply.element.path(op.result.path);
    if (as === 'element') return target;
    if (target === undefined) return undefined;
    return as === 'text' ? target.textContent() : toObject(target);
  };
  return { run, namespace: template.ns ?? '' };
}

/**
 * A profile operation as plain data, in the same form as BASE_OPERATIONS. Its
 * parameters are options; a type without `?` is required. `mutates` defaults
 * to true, so an operation nobody classified is treated as a write.
 */
function describeOperation(name: string, op: OperationSpec, namespace: string, profileId: string): OperationDescriptor {
  const params: ParamDescriptor[] = Object.entries(op.params ?? {}).map(([param, type]) =>
    Object.freeze({
      name: param,
      kind: 'option' as const,
      type: type.replace('?', '') as 'string' | 'number' | 'boolean',
      description: '',
      ...(type.endsWith('?') ? {} : { required: true }),
    }),
  );
  return Object.freeze({
    name,
    namespace,
    method: 'call',
    description: op.description ?? '',
    mutates: op.mutates ?? true,
    requires: Object.freeze([]),
    params: Object.freeze(params),
    device: profileId,
  });
}

function checkTemplate(el: XmlElement, params: Readonly<Record<string, ProfileParamType>>, used: Set<string>, where: string): void {
  const check = (text: string, context: string): void => {
    const m = PLACEHOLDER.exec(text);
    if (m !== null) {
      if (!(m[1]! in params)) throw new ProfileError(`${where}.request uses {{${m[1]}}}, which is not in params`);
      used.add(m[1]!);
    } else if (text.includes('{{')) {
      throw new ProfileError(`${where}.request: a placeholder must be the whole ${context}, not part of it`);
    }
  };
  for (const a of el.attributes) check(a.value, `value of attribute ${a.name}`);
  const texts = el.children.filter((c): c is string => typeof c === 'string');
  if (texts.length > 0 && el.elements.length > 0 && texts.some((t) => t.includes('{{'))) {
    throw new ProfileError(`${where}.request: a placeholder must be the whole text of an element with no child elements`);
  }
  for (const t of texts) check(t, `text of <${el.name}>`);
  for (const c of el.elements) checkTemplate(c, params, used, where);
}

function checkParam(name: string, type: ProfileParamType, value: unknown, where: string): void {
  const optional = type.endsWith('?');
  if (value === undefined || value === null) {
    if (!optional) throw new TypeError(`${where}: parameter ${name} is required`);
    return;
  }
  const base = optional ? type.slice(0, -1) : type;
  const ok = base === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === base;
  if (!ok) throw new TypeError(`${where}: parameter ${name} must be a ${base}`);
}

/** Substitute parameters. Elements/attributes whose optional parameter is absent are dropped. */
function fill(el: XmlElement, values: Readonly<Record<string, unknown>>): XmlElement {
  const valueOf = (text: string): { placeholder: boolean; value: string | undefined } => {
    const m = PLACEHOLDER.exec(text);
    if (m === null) return { placeholder: false, value: text };
    const v = values[m[1]!];
    // Parameter types were checked before fill(), so v is a string, number, boolean or absent.
    const value = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;
    return { placeholder: true, value };
  };
  const attributes: XmlAttribute[] = [];
  for (const a of el.attributes) {
    const { value } = valueOf(a.value);
    if (value !== undefined) attributes.push({ ...a, value });
  }
  const children: XmlNode[] = [];
  for (const c of el.children) {
    if (typeof c === 'string') {
      const { value } = valueOf(c);
      if (value !== undefined) children.push(value);
    } else {
      const textOnly = c.elements.length === 0 && c.children.length === 1 && typeof c.children[0] === 'string';
      if (textOnly && valueOf(c.children[0] as string).placeholder && valueOf(c.children[0] as string).value === undefined) {
        continue; // optional parameter absent: drop the element
      }
      children.push(fill(c, values));
    }
  }
  return new XmlElement({
    name: el.name,
    ns: el.ns,
    ...(el.prefix !== undefined ? { prefix: el.prefix } : {}),
    attributes,
    children,
    declarations: el.declarations,
    inScope: el.inScope,
  });
}
