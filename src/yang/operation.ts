/**
 * RPC and action parameters as RFC 7951 JSON (@node-net/yang), for
 * `client.content.invoke()` and `client.ops.action()`: input parameters, or a
 * whole action invocation tree, to XML, and a reply's output parameters to
 * JSON.
 *
 * An operation is named by its data path, in @node-net/yang's form: `/ex:restart`
 * for an RPC, `/ex:servers/server[name='a']/reset` for an action (the
 * module prefix only where the module changes, as in RFC 7951 member names).
 * Parameters are typed with the schema of the datastore given, the
 * operational one for actions (RFC 8342 §6), compiled lazily from the
 * operation's module and the modules the parameters name. Without a schema,
 * or with parameters that don't match it, the same fallback rules apply as
 * for data (encode.ts, convert.ts): schema-less with a warning, unless
 * `requireSchema` (or, for input, `validate`).
 */

import { decodeJson, decodeXml, encodeJson, encodeXml, YangDataError, type JsonValue, type Schema } from '@node-net/yang/core';
import { SchemaUnavailableError } from '../errors.js';
import type { XmlElement } from '../xml/index.js';
import { NamespaceScope } from '../xml/scope.js';
import { namespacesIn, type JsonObject } from './convert.js';
import { isPlainObject, issuesOf, MODULE_PREFIX, modulesIn, toElement } from './encode.js';
import { buildSchemaless, projectSchemaless } from './schemaless.js';
import { compile, compileErrors, implementedByNamespace, jsonNamespaces, pick, type SchemaContext } from './schemas.js';

/** The NETCONF base namespace, of `<ok>` and `<rpc-error>` (the adapter doesn't import the messages layer). */
const NETCONF_NS = 'urn:ietf:params:xml:ns:netconf:base:1.0';

/** Options for {@link encodeOperation}. */
export interface OperationInputOptions {
  /** The datastore whose schema types the parameters. */
  readonly datastore: string;
  readonly requireSchema: boolean;
  /** Refuse parameters that don't match the schema, rather than sending them schema-less. */
  readonly validate: boolean;
  /**
   * The operation's data path, when the JSON is its input parameters.
   * Without it, the JSON is a whole invocation tree: one top-level member,
   * from the top-level node down to the action, input included.
   */
  readonly operation?: string | undefined;
}

/** Options for {@link convertOperation}. */
export interface OperationOutputOptions {
  /** The operation's data path. */
  readonly operation: string;
  /** The datastore whose schema types the parameters. */
  readonly datastore: string;
  readonly requireSchema: boolean;
  /** A sentence appended to failure messages and schema-less warnings. */
  readonly hint?: string | undefined;
}

/** One step of an operation path: its name, and its module where the path names one. */
interface Step {
  readonly name: string;
  readonly module?: string;
}

/**
 * Convert RFC 7951 JSON to XML: an operation's input parameters (with
 * `operation`; the result is the parameter elements, to go inside the
 * operation element), or a whole invocation tree (the result is its one
 * top-level element).
 * @throws YangDataError (input that doesn't match the schema, with `validate`),
 *   SchemaUnavailableError (no schema, with `requireSchema`), or TypeError
 *   (input that isn't a JSON object, or an invocation tree that isn't one member)
 */
export async function encodeOperation(ctx: SchemaContext, json: unknown, options: OperationInputOptions): Promise<XmlElement[]> {
  const what = options.operation === undefined ? 'action target' : 'operation input';
  if (!isPlainObject(json)) throw new TypeError(`JSON ${what} must be an object of RFC 7951 members`);
  const members = Object.entries(json);
  let steps: readonly Step[] | undefined;
  let module: string | undefined;
  if (options.operation !== undefined) {
    steps = operationSteps(options.operation);
    module = steps[0]!.module;
    if (members.length === 0) return [];
  } else {
    if (members.length !== 1) throw new TypeError('A JSON action target is one tree: one top-level member, from the top-level node down to the action');
    module = MODULE_PREFIX.exec(members[0]![0])?.[1];
    if (module === undefined) throw new TypeError(`The top-level member of a JSON action target needs its module name, as in "module:${members[0]![0]}"`);
  }

  const library = await ctx.library();
  let reason: string | undefined;
  let schema: Schema | undefined;
  if (library === undefined) {
    reason = 'the server lists no YANG modules (no YANG library, and none in its hello)';
  } else {
    const implemented = new Set<string>();
    for (const set of library.moduleSets) for (const m of set.modules) implemented.add(m.name);
    if (!implemented.has(module!)) {
      reason = `the server implements no module ${module!}`;
    } else {
      const only = new Set<string>([module!]);
      for (const [key, value] of members) for (const m of modulesIn(key, value)) if (implemented.has(m)) only.add(m);
      const servers = await compile(ctx, library, [...only].sort());
      schema = pick(servers, options.datastore);
      if (schema === undefined || schema.module(module!) === undefined) {
        const problems = compileErrors(servers);
        reason = `no schema could be compiled for ${module!}${problems.length > 0 ? `: ${problems.slice(0, 3).join('; ')}` : ''}`;
        schema = undefined;
      }
    }
  }

  let mismatch: YangDataError | undefined;
  if (schema !== undefined) {
    const namespaces = jsonNamespaces(library);
    try {
      const tree = decodeJson(schema, json, { type: 'rpc', namespaces, ...(options.operation !== undefined ? { operation: options.operation } : {}) });
      const elements = encodeXml(tree, { namespaces }).map(toElement);
      return steps === undefined ? elements : parameters(elements, steps);
    } catch (err) {
      if (!(err instanceof YangDataError)) throw err;
      if (options.validate || options.requireSchema) throw err;
      mismatch = err;
    }
  } else if (options.requireSchema) {
    throw new SchemaUnavailableError(
      `No YANG schema for the JSON ${what} (${reason!}). Supply the modules with connect({ yang: { modules } }), or leave requireSchema off to send it schema-less`,
    );
  }

  const why = mismatch !== undefined ? `it doesn't match the schema and validate is off: ${issuesOf(mismatch)}` : reason!;
  ctx.warn(`JSON ${what} was sent without a YANG schema, because ${why}. Its values are sent as written, and prefixes in values are not declared`);
  if (steps === undefined) return buildSchemaless(members[0]![0], members[0]![1], ctx.namespaceOf);
  const ns = ctx.namespaceOf(module!);
  if (ns === undefined) throw new SchemaUnavailableError(`No namespace is known for module ${module!}, so its operation input can't be sent schema-less`);
  return members.flatMap(([key, value]) => buildSchemaless(key, value, ctx.namespaceOf, ns));
}

/**
 * Convert the output parameters in a reply (the children of `reply`, less
 * `<ok>` and `<rpc-error>`) to one RFC 7951 JSON object, its members named
 * as inside the operation: unqualified for the operation's own module.
 * @throws SchemaUnavailableError or YangDataError, only with `requireSchema`.
 */
export async function convertOperation(ctx: SchemaContext, reply: XmlElement, options: OperationOutputOptions): Promise<JsonObject> {
  const output = reply.elements.filter((c) => c.ns !== NETCONF_NS || (c.name !== 'ok' && c.name !== 'rpc-error'));
  if (output.length === 0) return {};
  const steps = operationSteps(options.operation);
  const module = steps[0]!.module!;
  const hint = options.hint === undefined || options.hint === '' ? '' : `. ${options.hint}`;

  const library = await ctx.library();
  let reason: string | undefined;
  let schema: Schema | undefined;
  if (library === undefined) {
    reason = 'the server lists no YANG modules (no YANG library, and none in its hello)';
  } else {
    const byNamespace = implementedByNamespace(library);
    if (![...byNamespace.values()].includes(module)) {
      reason = `the server implements no module ${module}`;
    } else {
      const only = new Set<string>([module]);
      for (const el of output) for (const ns of namespacesIn(el)) {
        const m = byNamespace.get(ns);
        if (m !== undefined) only.add(m);
      }
      const servers = await compile(ctx, library, [...only].sort());
      schema = pick(servers, options.datastore);
      if (schema === undefined || schema.module(module) === undefined) {
        const problems = compileErrors(servers);
        reason = `no schema could be compiled for ${module}${problems.length > 0 ? `: ${problems.slice(0, 3).join('; ')}` : ''}`;
        schema = undefined;
      }
    }
  }

  let mismatch: YangDataError | undefined;
  if (schema !== undefined) {
    const namespaces = jsonNamespaces(library);
    const scope = new Map(NamespaceScope.entries(reply.inScope));
    try {
      const tree = decodeXml(schema, output, { type: 'reply', operation: options.operation, scope, namespaces });
      return member(encodeJson(tree, { namespaces }), steps);
    } catch (err) {
      if (!(err instanceof YangDataError)) throw err;
      if (options.requireSchema) {
        if (hint !== '' && !err.message.endsWith(hint)) err.message += hint;
        throw err;
      }
      mismatch = err;
    }
  } else if (options.requireSchema) {
    throw new SchemaUnavailableError(
      `No YANG schema for the output of ${options.operation} (${reason!}). Supply the modules with connect({ yang: { modules } }), or leave requireSchema off for a schema-less conversion${hint}`,
    );
  }

  const why = mismatch !== undefined ? `it doesn't match the schema: ${issuesOf(mismatch)}` : reason!;
  ctx.warn(
    `JSON output: the output of ${options.operation} was converted without a YANG schema, because ${why}. ` +
      `Its values are text, and a list with one entry is not an array${hint}`,
  );
  return projectSchemaless(output, ctx.moduleOf, module);
}

/**
 * The steps of an operation path, predicates dropped: each step's name, and
 * its module where the step names one. The first step must name one.
 * @throws TypeError for a path that doesn't start with `/module:name`.
 */
function operationSteps(path: string): Step[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | undefined;
  let depth = 0;
  for (const ch of path) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
    } else if (ch === '/' && depth === 0) {
      tokens.push(current);
      current = '';
      continue;
    }
    if (depth === 0 && ch !== ']') current += ch;
  }
  tokens.push(current);
  if (tokens[0] !== '' || tokens.length < 2) throw new TypeError(`An operation path starts with /module:name, not ${JSON.stringify(path)}`);
  const steps = tokens.slice(1).map((t): Step => {
    const colon = t.indexOf(':');
    return colon < 0 ? { name: t } : { module: t.slice(0, colon), name: t.slice(colon + 1) };
  });
  if (steps[0]!.module === undefined) throw new TypeError(`An operation path's first step names its module: ${JSON.stringify(path)}`);
  return steps;
}

/** The parameter elements inside an encoded invocation tree: the operation element's children. */
function parameters(elements: readonly XmlElement[], steps: readonly Step[]): XmlElement[] {
  let level: readonly XmlElement[] = elements;
  for (const step of steps) {
    const next = level.find((el) => el.name === step.name);
    if (next === undefined) return [];
    level = next.elements;
  }
  return [...level];
}

/** The operation's member in an encoded reply tree: its output parameters. */
function member(json: JsonObject, steps: readonly Step[]): JsonObject {
  let value: JsonValue | undefined = json;
  for (const [i, step] of steps.entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const key: string = i === 0 || step.module !== undefined ? `${step.module!}:${step.name}` : step.name;
    value = (value)[key];
    if (Array.isArray(value)) value = value[0];
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value) : {};
}
