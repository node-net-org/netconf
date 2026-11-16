/**
 * RFC 7951 JSON → YANG data in XML, typed by the server's YANG schema
 * (@node-net/yang): the input side of design §3.5. A step before the Operations
 * layer builds a request: edit content (`config`) or a subtree filter.
 *
 * As for output, the schema is compiled lazily from only the modules the
 * JSON names (member names at any depth, and identityref-like values), and
 * each top-level member is converted on its own. Unlike output, a member
 * that doesn't match its schema is never sent schema-less unless the caller
 * asks (`validate: false`): it rejects with every problem found. A member no
 * schema covers is sent schema-less with a warning, unless `requireSchema`.
 */

import { decodeJson, encodeXml, YangDataError, type DataIssue, type Schema, type XmlChild } from '@node-net/yang/core';
import { SchemaUnavailableError } from '../errors.js';
import { XmlElement, type XmlNode } from '../xml/index.js';
import { encodeFilter } from './filter.js';
import { buildSchemaless } from './schemaless.js';
import { compile, compileErrors, jsonNamespaces, pick, type SchemaContext } from './schemas.js';

export interface EncodeOptions {
  /** The datastore the input addresses: `running`, `candidate`, `operational`, or a qualified identity `module:name`. */
  readonly datastore: string;
  readonly requireSchema: boolean;
  /** Refuse a member that doesn't match its schema (the default), rather than sending it schema-less. */
  readonly validate: boolean;
  /** Subtree-filter content rather than edit content. */
  readonly filter: boolean;
}

export const MODULE_PREFIX = /^([A-Za-z_][A-Za-z0-9_.-]*):[A-Za-z_][A-Za-z0-9_.-]*$/;

/** True for a plain object: the form RFC 7951 JSON input takes (never an XmlElement, an array or a Filter class). */
export function isPlainObject(v: unknown): v is Readonly<Record<string, unknown>> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Convert an RFC 7951 JSON object to the XML elements it stands for.
 * @throws YangDataError (input that doesn't match the schema), SchemaUnavailableError
 *   (no schema, with `requireSchema`), or TypeError (input that isn't an object, or a
 *   schema-less member naming an unknown module)
 */
export async function encodeData(ctx: SchemaContext, json: unknown, options: EncodeOptions): Promise<XmlElement[]> {
  if (!isPlainObject(json)) throw new TypeError('JSON input must be an object of RFC 7951 members, such as { "module:container": { ... } }');
  const members = Object.entries(json);
  if (members.length === 0) return [];
  const what = options.filter ? 'filter' : 'input';

  const library = await ctx.library();
  const implemented = new Map<string, string>();
  for (const set of library?.moduleSets ?? []) for (const m of set.modules) if (m.namespace !== undefined && !implemented.has(m.name)) implemented.set(m.name, m.namespace);

  type Plan = { readonly key: string; readonly value: unknown; reason?: string; error?: YangDataError };
  const plans: Plan[] = members.map(([key, value]) => ({ key, value }));
  let schema: Schema | undefined;

  if (library === undefined) {
    for (const p of plans) p.reason = 'the server lists no YANG modules (no YANG library, and none in its hello)';
  } else {
    const only = new Set<string>();
    const candidates: Plan[] = [];
    for (const p of plans) {
      const module = MODULE_PREFIX.exec(p.key)?.[1];
      if (module === undefined) {
        // Not a qualified member: @node-net/yang reports it, as the schema-less path can't name it either.
        p.error = new YangDataError([{ code: 'unknown-node', message: `top-level member '${p.key}' has no module name`, path: `/${p.key}`, severity: 'error' }]);
        continue;
      }
      if (!implemented.has(module)) {
        p.reason = `the server implements no module ${module}`;
        continue;
      }
      candidates.push(p);
      for (const m of modulesIn(p.key, p.value)) if (implemented.has(m)) only.add(m);
    }
    if (candidates.length > 0) {
      const servers = await compile(ctx, library, [...only].sort());
      schema = pick(servers, options.datastore);
      const problems = compileErrors(servers);
      for (const p of candidates) {
        const module = MODULE_PREFIX.exec(p.key)![1]!;
        if (schema === undefined || schema.module(module) === undefined) {
          p.reason = `no schema could be compiled for ${module}${problems.length > 0 ? `: ${problems.slice(0, 3).join('; ')}` : ''}`;
        }
      }
    }
  }

  const namespaces = jsonNamespaces(library);
  const out: XmlElement[] = [];
  const failures: DataIssue[] = [];
  const untyped: Plan[] = [];
  for (const p of plans) {
    if (p.error === undefined && p.reason === undefined) {
      try {
        out.push(...typed(schema!, p.key, p.value, options.filter, namespaces));
        continue;
      } catch (err) {
        if (!(err instanceof YangDataError)) throw err;
        p.error = err;
      }
    }
    if (p.error !== undefined && (options.validate || options.requireSchema)) {
      failures.push(...p.error.issues);
      continue;
    }
    if (p.reason !== undefined && options.requireSchema) {
      throw new SchemaUnavailableError(
        `No YANG schema for JSON ${what} ${p.key} (${p.reason}). Supply the modules with connect({ yang: { modules } }), or leave requireSchema off to send it schema-less`,
      );
    }
    untyped.push(p);
    out.push(...buildSchemaless(p.key, p.value, ctx.namespaceOf));
  }
  if (failures.length > 0) throw new YangDataError(failures);
  for (const p of untyped) {
    const why = p.error !== undefined ? `it doesn't match the schema and validate is off: ${issuesOf(p.error)}` : p.reason!;
    ctx.warn(`JSON ${what}: ${p.key} was sent without a YANG schema, because ${why}. Its values are sent as written, and prefixes in values are not declared`);
  }
  return out;
}

/** Converts one member with the schema. */
function typed(schema: Schema, key: string, value: unknown, filter: boolean, namespaces: Readonly<Record<string, string>>): XmlElement[] {
  if (filter) return encodeFilter(schema, key, value);
  const tree = decodeJson(schema, { [key]: value }, { edit: true, namespaces });
  return encodeXml(tree, { namespaces }).map(toElement);
}

/** Every module named in member names (at any depth, metadata excepted) and in `module:identity`-like string values. */
export function modulesIn(key: string, value: unknown, found = new Set<string>()): Set<string> {
  const m = MODULE_PREFIX.exec(key.startsWith('@') ? '' : key);
  if (m !== null) found.add(m[1]!);
  if (typeof value === 'string') {
    const v = MODULE_PREFIX.exec(value);
    if (v !== null) found.add(v[1]!);
  } else if (Array.isArray(value)) {
    for (const v of value) modulesIn('', v, found);
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) if (!k.startsWith('@')) modulesIn(k, v, found);
  }
  return found;
}

export function issuesOf(err: YangDataError): string {
  const shown = err.issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`);
  return shown.join('; ') + (err.issues.length > 3 ? ` (and ${err.issues.length - 3} more)` : '');
}

/** @node-net/yang's plain elements as @node-net/netconf's XmlElement. */
export function toElement(el: { readonly name: string; readonly ns?: string | undefined; readonly prefix?: string | undefined; readonly attributes?: readonly { readonly name: string; readonly ns: string | undefined; readonly prefix?: string | undefined; readonly value: string }[] | undefined; readonly children?: readonly XmlChild[] | undefined; readonly declarations?: ReadonlyMap<string, string> | undefined }): XmlElement {
  const children: XmlNode[] = (el.children ?? []).map((c) => (typeof c === 'string' ? c : toElement(c)));
  return new XmlElement({
    name: el.name,
    ns: el.ns ?? '',
    attributes: (el.attributes ?? []).map((a) => ({ name: a.name, ns: a.ns, ...(a.prefix !== undefined ? { prefix: a.prefix } : {}), value: a.value })),
    children,
    ...(el.declarations !== undefined && el.declarations.size > 0 ? { declarations: new Map(el.declarations) } : {}),
  });
}
