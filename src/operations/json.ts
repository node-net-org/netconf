/**
 * RFC 7951 JSON (design §3.5): the types of the `format: 'json'` option that
 * reads returning YANG data accept, of JSON input (`config` and `filter`
 * given as JSON objects), and the conversion seams an extension uses to
 * offer both.
 *
 * The conversion itself (YANG schemas through @node-net/yang) is the client
 * facade's: this layer only describes it, so the Operations layer never
 * depends on a YANG implementation.
 */

import type { XmlElement } from '../xml/index.js';

/** A value in RFC 7951 JSON: what `JSON.parse` returns. */
export type YangJsonValue = string | number | boolean | null | YangJsonValue[] | { [member: string]: YangJsonValue };

/** An RFC 7951 JSON object: members named `module:name` at the top level. */
export type YangJsonObject = { [member: string]: YangJsonValue };

/** How RFC 7951 JSON output is produced. */
export interface JsonOptions {
  /**
   * Refuse to convert data without a YANG schema: reject with a
   * `SchemaUnavailableError` (no schema could be built) or a YANG data error
   * (the data doesn't match the schema), instead of converting that subtree
   * schema-less and reporting a warning. For JSON input (`config` or
   * `filter`), reject with `SchemaUnavailableError` instead of sending a
   * member no schema covers schema-less. Default: the connection's
   * `yang.requireSchema`, then the device profile's, then `false`.
   */
  readonly requireSchema?: boolean;
  /**
   * JSON input only: refuse JSON that doesn't match its YANG schema (unknown
   * nodes, values of the wrong type or out of range, missing list keys,
   * config-false nodes in an edit), rejecting with a YANG data error that
   * lists every problem. Default `true`. With `false`, a top-level member
   * that doesn't match is sent schema-less, with a warning.
   */
  readonly validate?: boolean;
  /**
   * JSON input only: the datastore whose schema types the input. Default:
   * the one the operation addresses (an edit's target, a `get-config`
   * filter's source, `operational` for `<get>`).
   */
  readonly datastore?: JsonDatastore;
}

/** The output options of a read that returns YANG data. */
export interface FormatOptions {
  /**
   * `'xml'`: the data as XML elements. `'json'`: an RFC 7951 JSON object.
   * The default depends on the layer: `'xml'` for `client.ops` reads (the
   * `<data>` element), `'json'` for `client.content` reads.
   */
  readonly format?: 'xml' | 'json';
  /** Options for `format: 'json'`. */
  readonly json?: JsonOptions;
}

/** `format: 'json'`, for the overloads whose result is JSON. */
export interface JsonFormat extends FormatOptions {
  readonly format: 'json';
}

/** No format, or `format: 'xml'`, for the overloads whose result is XML. */
export interface XmlFormat extends FormatOptions {
  readonly format?: 'xml';
}

/** A datastore, as a standard name or an identity (module namespace and name). */
export type JsonDatastore =
  | string
  | {
      /** The namespace of the module that defines the identity. */
      readonly namespace: string;
      /** The identity's name, such as `running`. */
      readonly name: string;
    };

/** Options of the conversion seam, `ExtensionContext.toJson`. */
export interface ToJsonOptions extends JsonOptions {
  /**
   * The datastore the data came from, which picks the schema: `running`,
   * `candidate`, `startup`, `operational` (the default), or an NMDA
   * datastore identity.
   */
  readonly datastore?: JsonDatastore;
  /**
   * Namespace prefixes declared above the data element (prefix → URI), for
   * prefixes used in values. Not needed for a parsed element, which carries
   * every declaration in scope where it was parsed (`inScope`); only for an
   * element built with `x()` whose values use a prefix declared elsewhere.
   */
  readonly scope?: ReadonlyMap<string, string>;
  /**
   * Text appended to the conversion's failure messages and schema-less
   * warnings, such as how to read the data another way. Reads that have a
   * `format` option pass `READ_AS_XML_HINT`.
   */
  readonly hint?: string;
  /**
   * Convert an RPC's or action's output instead: `data` is the reply (or
   * any element holding the output parameters), and the result is the
   * output parameters, named as inside the operation. The value is the
   * operation's data path, in the form `/ex:restart` or
   * `/ex:servers/server[name='a']/reset` (module prefix only where the
   * module changes). The datastore defaults to `operational`.
   */
  readonly operation?: string;
}

/** The `hint` of a read that has a `format` option: what to do when its data can't be typed. */
export const READ_AS_XML_HINT = "Read with format: 'xml' to get the data as the server sent it";

/** Converts YANG data in XML (a `<data>` element, or any element holding YANG data nodes) to RFC 7951 JSON. */
export type ToJson = (data: XmlElement, options?: ToJsonOptions) => Promise<YangJsonObject>;

/** Options of the input conversion seam, `ExtensionContext.toXml`. */
export interface ToXmlOptions extends JsonOptions {
  /** Subtree-filter content (RFC 6241 §6) rather than edit content. Default false. */
  readonly filter?: boolean;
  /**
   * Convert an RPC's or action's input parameters instead: the result is
   * the parameter elements, to go inside the operation element. The value
   * is the operation's data path, in the form of `ToJsonOptions.operation`.
   * The datastore defaults to `operational`.
   */
  readonly operation?: string;
  /**
   * Convert a whole action invocation instead: one top-level member, the
   * data-node tree down to the action with its input, as
   * `client.ops.action()` takes it. The datastore defaults to `operational`.
   */
  readonly action?: boolean;
}

/**
 * Converts an RFC 7951 JSON object to the XML elements it stands for: edit
 * content (with `nc:operation` and `yang:insert` from RFC 7952 metadata), or
 * with `filter`, subtree-filter content.
 */
export type ToXml = (json: YangJsonObject, options?: ToXmlOptions) => Promise<XmlElement[]>;

/**
 * True when `config` (or anything that would otherwise be XML) is an RFC
 * 7951 JSON object: a plain object. An XmlElement, a string, a scalar or an
 * array never is.
 */
export function isJsonInput(value: unknown): value is YangJsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * True when a `filter` is an RFC 7951 JSON object rather than a
 * `subtree()`/`xpath()` filter, whose `type` member no JSON filter has (its
 * top-level members are all `module:name`).
 */
export function isJsonFilter(filter: unknown): filter is YangJsonObject {
  return isJsonInput(filter) && !('type' in filter);
}

/** Splits `format` and `json` from a method's options; `fallback` is the format when none is given. */
export function splitFormat<T extends FormatOptions>(
  options: T,
  fallback: 'xml' | 'json' = 'xml',
): { readonly format: 'xml' | 'json'; readonly json: JsonOptions; readonly rest: Omit<T, 'format' | 'json'> } {
  const { format, json, ...rest } = options;
  if (format !== undefined && format !== 'xml' && format !== 'json') throw new TypeError(`format must be 'xml' or 'json', not ${JSON.stringify(format)}`);
  return { format: format ?? fallback, json: json ?? {}, rest };
}

/** The datastores whose schemas type an operation's JSON `config` and `filter`, when `json.datastore` doesn't say. */
export interface JsonInputDatastores {
  readonly config?: JsonDatastore;
  readonly filter?: JsonDatastore;
  /** An action's `target`: converted as a whole action invocation, with this datastore's schema. */
  readonly target?: JsonDatastore;
}

/** The message for JSON input that reached a request builder unconverted. */
export const JSON_NEEDS_CLIENT = 'RFC 7951 JSON input is converted by a NetconfClient (client.ops, client.content, or an extension context); a request builder takes only XML';

/**
 * Convert an operation's JSON input to XML before its request is built: a
 * JSON `config` (or `source: { config }`) to edit content, and a JSON
 * `filter` to a subtree filter. Anything else is returned unchanged, so XML
 * input costs nothing.
 */
export async function convertJsonArgs<T extends Readonly<Record<string, unknown>>>(toXml: ToXml, args: T, datastores: JsonInputDatastores, json: JsonOptions = {}): Promise<T> {
  let out: Record<string, unknown> | undefined;
  const set = (key: string, value: unknown): void => {
    out ??= { ...args };
    out[key] = value;
  };
  const { datastore, ...rest } = json;
  const config = args['config'];
  if (isJsonInput(config)) set('config', await toXml(config, { ...rest, datastore: datastore ?? datastores.config ?? 'running' }));
  const source = args['source'];
  if (isJsonInput(source) && isJsonInput((source as Readonly<Record<string, unknown>>)['config'])) {
    const inner = (source as { readonly config: YangJsonObject }).config;
    set('source', { config: await toXml(inner, { ...rest, datastore: datastore ?? datastores.config ?? 'running' }) });
  }
  const target = args['target'];
  if (datastores.target !== undefined && isJsonInput(target)) {
    const [element, ...more] = await toXml(target, { ...rest, action: true, datastore: datastore ?? datastores.target });
    if (element === undefined || more.length > 0) throw new TypeError('A JSON action target converts to exactly one element: the data-node tree down to the action');
    set('target', element);
  }
  const filter = args['filter'];
  if (isJsonFilter(filter)) {
    const content = await toXml(filter, { ...rest, filter: true, datastore: datastore ?? datastores.filter ?? 'operational' });
    set('filter', { type: 'subtree', content });
  }
  return (out ?? args) as T;
}
