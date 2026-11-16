/**
 * YANG data in XML → RFC 7951 JSON, typed by the server's YANG schema
 * (@node-net/yang). An output step above the Operations layer: it runs after a
 * read's reply arrives and never changes what is sent.
 *
 * The schema is compiled lazily, from only the modules the data uses (every
 * namespace in it, so modules that augment others come along) plus the
 * modules that deviate them. Each top-level member of the data is converted
 * on its own: fully typed, or, when it can't be typed and `requireSchema` is
 * off, schema-less (schemaless.ts), with a warning.
 */

import { decodeXml, encodeJson, YangDataError, type DataTree, type JsonValue, type Schema } from '@node-net/yang/core';
import { SchemaUnavailableError } from '../errors.js';
import type { XmlElement } from '../xml/index.js';
import { NamespaceScope } from '../xml/scope.js';
import { projectSchemaless, type ModuleOf } from './schemaless.js';
import { compile, compileErrors, implementedByNamespace, implementedNames, jsonNamespaces, pick, type SchemaContext } from './schemas.js';

export type JsonObject = { [member: string]: JsonValue };

export interface ConvertOptions {
  /** The datastore the data came from: `running`, `operational`, or a qualified identity `module:name`. */
  readonly datastore: string;
  readonly requireSchema: boolean;
  /** Prefixes declared above the data element. */
  readonly scope?: ReadonlyMap<string, string> | undefined;
  /** A sentence appended to failure messages and schema-less warnings (ToJsonOptions.hint). */
  readonly hint?: string | undefined;
}

/** Modules that define annotations (`md:annotation`) these reads return: compiled when the server has them, so the annotations are typed. */
const ANNOTATION_MODULES = ['ietf-origin', 'ietf-netconf-with-defaults'];

/**
 * Convert the children of a `<data>` element (or any element holding YANG
 * data nodes) to one RFC 7951 JSON object.
 * @throws SchemaUnavailableError or YangDataError, only with `requireSchema`.
 */
export async function convertData(ctx: SchemaContext, data: XmlElement, options: ConvertOptions): Promise<JsonObject> {
  const elements = data.elements;
  if (elements.length === 0) return {};
  const scope = new Map([...(options.scope ?? []), ...NamespaceScope.entries(data.inScope)]);
  const library = await ctx.library();
  const implemented: ReadonlyMap<string, string> = library === undefined ? new Map<string, string>() : implementedByNamespace(library);
  const namespaces = jsonNamespaces(library);
  const decodeOptions = { scope, namespaces };

  const typed: XmlElement[] = [];
  const untyped: { readonly el: XmlElement; readonly reason: string; readonly error?: YangDataError }[] = [];
  let schema: Schema | undefined;
  const known: Decoded = {};

  if (library === undefined) {
    for (const el of elements) untyped.push({ el, reason: 'the server lists no YANG modules (no YANG library, and none in its hello)' });
  } else {
    const only = new Set<string>();
    const candidates: XmlElement[] = [];
    for (const el of elements) {
      const module = implemented.get(el.ns ?? '');
      if (module === undefined) {
        untyped.push({ el, reason: `no module the server lists has the namespace ${el.ns ?? '(none)'}` });
        continue;
      }
      candidates.push(el);
    }
    for (const ns of namespacesOfChildren(data.inScope, candidates)) {
      const m = implemented.get(ns);
      if (m !== undefined) only.add(m);
    }
    if (candidates.length > 0) {
      const names = implementedNames(library);
      for (const m of ANNOTATION_MODULES) if (names.has(m)) only.add(m);
      const servers = await compile(ctx, library, [...only].sort());
      schema = pick(servers, options.datastore);
      const problems = compileErrors(servers);
      const failedFrom = untyped.length;
      const decodable: XmlElement[] = [];
      for (const el of candidates) {
        const module = implemented.get(el.ns ?? '')!;
        if (schema === undefined || schema.module(module) === undefined) {
          const why = problems.length > 0 ? `: ${problems.slice(0, 3).join('; ')}` : '';
          untyped.push({ el, reason: `no schema could be compiled for ${module}${why}` });
        } else {
          decodable.push(el);
        }
      }
      if (decodable.length > 0) {
        // Decode them all at once. Only if that fails is each
        // member decoded on its own, to find which ones don't match.
        try {
          known.together = decodeXml(schema!, decodable, decodeOptions);
          typed.push(...decodable);
        } catch (err) {
          if (!(err instanceof YangDataError)) throw err;
          known.alone = [];
          for (const el of decodable) {
            try {
              known.alone.push(decodeXml(schema!, [el], decodeOptions));
              typed.push(el);
            } catch (e) {
              if (!(e instanceof YangDataError)) throw e;
              untyped.push({ el, reason: `it doesn't match the schema: ${issuesOf(e)}`, error: e });
            }
          }
          // Every member decoded alone, so together they clash: that error stands for the clash.
          if (typed.length === decodable.length) known.clash = err;
        }
      }
      // Report the candidates that failed in their order in the data, whichever way they failed.
      const failed = untyped.splice(failedFrom).sort((a, b) => candidates.indexOf(a.el) - candidates.indexOf(b.el));
      untyped.push(...failed);
    }
  }

  const hint = options.hint === undefined || options.hint === '' ? '' : `. ${options.hint}`;
  if (untyped.length > 0 && options.requireSchema) {
    const first = untyped[0]!;
    if (first.error !== undefined) throw withHint(first.error, hint);
    const what = untyped.map((u) => `${memberOf(u.el, ctx.moduleOf)} (${u.reason})`).join('; ');
    throw new SchemaUnavailableError(`No YANG schema for ${what}. Supply the modules with connect({ yang: { modules } }), or leave requireSchema off for a schema-less conversion${hint}`);
  }

  // Typed members first, from one tree so that siblings merge as the schema says.
  const out: JsonObject =
    typed.length === 0 ? {} : encodeTyped(schema!, typed, known, decodeOptions, namespaces, options.requireSchema, ctx, hint);
  if (untyped.length > 0) {
    const projected = projectSchemaless(untyped.map((u) => u.el), ctx.moduleOf);
    for (const [key, value] of Object.entries(projected)) out[key] = value;
    for (const u of untyped) {
      // A missing schema can be supplied; data that doesn't match one can't be fixed here.
      const supply = u.error === undefined ? '. Supply its modules with yang.modules (in connect() or a device profile) to type it' : '';
      ctx.warn(
        `JSON output: ${memberOf(u.el, ctx.moduleOf)} was converted without a YANG schema, because ${u.reason}. ` +
          `Its values are text, and a list with one entry is not an array${supply}${hint}`,
      );
    }
  }
  return out;
}

/** What convertData already decoded, so that encoding never decodes it again. */
interface Decoded {
  /** The typed members decoded together: the common path, one decode in all. */
  together?: DataTree;
  /** Each typed member decoded on its own (in `typed` order), when decoding them together failed. */
  alone?: DataTree[];
  /** Why decoding them together failed, when each decoded on its own: they clash. */
  clash?: YangDataError;
}

/**
 * Encode the members that decoded on their own. Together they can still
 * clash (a server that sends the same container twice): then, unless
 * `requireSchema`, each is encoded on its own and the results merged, a
 * repeated container's members combined and a repeated list's entries joined.
 */
function encodeTyped(
  schema: Schema,
  typed: readonly XmlElement[],
  known: Decoded,
  decodeOptions: { readonly scope: ReadonlyMap<string, string>; readonly namespaces: Readonly<Record<string, string>> },
  namespaces: Readonly<Record<string, string>>,
  requireSchema: boolean,
  ctx: SchemaContext,
  hint: string,
): JsonObject {
  if (known.together !== undefined) return encodeJson(known.together, { namespaces });
  let clash = known.clash;
  if (clash === undefined) {
    // Some members didn't match the schema: decode the ones that did, together.
    try {
      return encodeJson(decodeXml(schema, typed, decodeOptions), { namespaces });
    } catch (err) {
      if (!(err instanceof YangDataError)) throw err;
      clash = err;
    }
  }
  if (requireSchema) throw withHint(clash, hint);
  ctx.warn(`JSON output: the data's top-level members clash (${issuesOf(clash)}), so each was converted on its own and the results merged`);
  const out: JsonObject = {};
  // Reached only after decoding them together failed, so each was decoded alone.
  for (const tree of known.alone!) merge(out, encodeJson(tree, { namespaces }));
  return out;
}

/**
 * Append the read's hint to a YANG data error's message. @node-net/yang builds the
 * message from `issues`, so the class and `issues` stay as they are.
 */
function withHint(err: YangDataError, hint: string): YangDataError {
  if (hint !== '' && !err.message.endsWith(hint)) err.message += hint;
  return err;
}

function merge(into: JsonObject, from: JsonObject): void {
  for (const [key, value] of Object.entries(from)) {
    const prior = into[key];
    if (prior === undefined) into[key] = value;
    else if (Array.isArray(prior) && Array.isArray(value)) into[key] = [...prior, ...value];
    else if (isObject(prior) && isObject(value)) merge(prior, value);
    else into[key] = value;
  }
}

function isObject(v: JsonValue | undefined): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function issuesOf(err: YangDataError): string {
  const shown = err.issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`);
  return shown.join('; ') + (err.issues.length > 3 ? ` (and ${err.issues.length - 3} more)` : '');
}

function memberOf(el: XmlElement, moduleOf: ModuleOf): string {
  const ns = el.ns ?? '';
  const module = ns === '' ? undefined : (moduleOf(ns) ?? ns);
  return module === undefined ? el.name : `${module}:${el.name}`;
}

/**
 * Every namespace used by an element and its descendants: their own and their
 * attributes', and those they declare, which prefixed values (identityref,
 * instance-identifier) refer to. A module may appear only there, such as
 * iana-if-type, whose identities are an interface's type.
 */
export function namespacesIn(el: XmlElement, found = new Set<string>()): Set<string> {
  addNamespaces(el, found, undefined);
  return found;
}

/**
 * {@link namespacesIn} of each of `children`, together: the children of an
 * element whose in-scope namespaces are `parentScope`, such as a `<data>`
 * element. The same set as their union, without reading each child's whole
 * scope, which repeats the parent's for every child.
 */
export function namespacesOfChildren(parentScope: ReadonlyMap<string, string>, children: readonly XmlElement[], found = new Set<string>()): Set<string> {
  // The parent's namespaces, each with how many of its prefixes are bound to it.
  let parentUris: Map<string, number> | undefined;
  // How many children declared below the parent, and for how many of them
  // each of the parent's namespaces is hidden: every prefix bound to it rebound.
  let below = 0;
  const hidden = new Map<string, number>();
  for (const el of children) {
    const added = NamespaceScope.added(el.inScope, parentScope);
    if (added === undefined) {
      addNamespaces(el, found, undefined);
      continue;
    }
    below++;
    if (parentUris === undefined) {
      parentUris = new Map();
      for (const [prefix, uri] of NamespaceScope.entries(parentScope)) if (counts(prefix, uri)) parentUris.set(uri, (parentUris.get(uri) ?? 0) + 1);
    }
    let rebound: Map<string, number> | undefined;
    for (const [prefix, uri] of added) {
      const was = parentScope.get(prefix);
      if (was === undefined || was === uri || !counts(prefix, was)) continue;
      (rebound ??= new Map()).set(was, (rebound.get(was) ?? 0) + 1);
    }
    for (const [uri, n] of rebound ?? []) if (n === parentUris.get(uri)) hidden.set(uri, (hidden.get(uri) ?? 0) + 1);
    addNamespaces(el, found, parentScope);
  }
  for (const uri of parentUris?.keys() ?? []) if ((hidden.get(uri) ?? 0) < below) found.add(uri);
  return found;
}

/**
 * Adds the namespaces of `el` and its descendants. With `parentScope`, the
 * scope `el`'s is declared in, only what `el`'s scope adds to it: the caller
 * counts the rest. Reading every element's whole scope is quadratic in the
 * number of declarations.
 */
function addNamespaces(el: XmlElement, found: Set<string>, parentScope: ReadonlyMap<string, string> | undefined): void {
  if (el.ns !== undefined && el.ns !== '') found.add(el.ns);
  const scope = (parentScope && NamespaceScope.added(el.inScope, parentScope)) ?? NamespaceScope.entries(el.inScope);
  for (const [prefix, uri] of scope) if (counts(prefix, uri)) found.add(uri);
  for (const a of el.attributes) if (a.ns !== undefined) found.add(a.ns);
  for (const c of el.elements) addNamespaces(c, found, el.inScope);
}

/** Whether a prefix's binding names a namespace the data may use: not the default namespace, `xml` or an undeclaration. */
function counts(prefix: string, uri: string): boolean {
  return prefix !== '' && prefix !== 'xml' && uri !== '';
}

