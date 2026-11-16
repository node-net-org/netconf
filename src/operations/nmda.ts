/**
 * NMDA (RFC 8342) over NETCONF (RFC 8526): read and write any datastore by
 * identity with `<get-data>` and `<edit-data>`, and read `or:origin`
 * annotations (design §8).
 *
 * ```ts
 * import { nmda, origins } from '@node-net/netconf/operations/nmda';
 *
 * const client = await connect({ transport, extensions: [nmda] });
 * const data = await client.ops.nmda.getData({ datastore: 'operational', filter: subtree(x('interfaces', { xmlns: IF })), withOrigin: true });
 * const where = origins(data);   // element → 'ietf-origin:intended' | 'ietf-origin:learned' | …
 * ```
 *
 * Every error RFC 8526 specifies arrives as an RpcError with tag `invalid-value`
 * (an unsupported datastore, `with-origin` without the server's `origin` feature, …).
 *
 * @packageDocumentation
 */

import { CapabilityError } from '../errors.js';
import { NETCONF_NS, type RpcOptions, type RpcReply } from '../messages/index.js';
import { XmlElement, x, type Child } from '../xml/index.js';
import { xmlOnly, type Filter, type OperationRequest } from './base.js';
import { splitRpcOptions } from './args.js';
import { defineExtension, type ExtensionContext, type OperationDescriptor, type RequestArgs } from './extension.js';
import { convertJsonArgs, isJsonFilter, JSON_NEEDS_CLIENT, READ_AS_XML_HINT, splitFormat, type FormatOptions, type JsonFormat, type JsonOptions, type XmlFormat, type YangJsonObject } from './json.js';
import {
  DATASTORES_NS,
  NMDA_NS,
  ORIGIN_NS,
  STANDARD_DATASTORES,
  STANDARD_ORIGINS,
  datastoreIdentity,
  identityElement,
  originIdentity,
  type DatastoreRef,
  type Identity,
  type OriginRef,
} from './identities.js';
import { qualifiedIdentity, type ModuleOf } from './qualified.js';
import { WITH_DEFAULTS_MODES, defaultsHandling, type WithDefaultsMode } from './defaults-modes.js';

export {
  DATASTORES_NS,
  NMDA_NS,
  ORIGIN_NS,
  STANDARD_DATASTORES,
  STANDARD_ORIGINS,
  type DatastoreRef,
  type Identity,
  type OriginRef,
  type StandardDatastore,
  type StandardOrigin,
} from './identities.js';

/** The `:with-operational-defaults` capability (RFC 8526 §3.1.1.2): with-defaults on `<operational>`. */
export const WITH_OPERATIONAL_DEFAULTS = 'urn:ietf:params:netconf:capability:with-operational-defaults:1.0';

/** Options for `<get-data>` (RFC 8526 §3.1.1). See [nmda](/guide/extensions#nmda). */
export interface GetDataOptions {
  /** The datastore to read: a standard one by name (`'operational'`, `'intended'`, …) or another identity. */
  readonly datastore: DatastoreRef;
  /**
   * A subtree filter (`subtree(...)`), an XPath filter (`xpath(...)`, needs
   * `:xpath`), or an RFC 7951 JSON object, converted to a subtree filter with
   * the datastore's YANG schema.
   */
  readonly filter?: Filter | YangJsonObject;
  /** `true`: only configuration nodes. `false`: only state nodes. */
  readonly configFilter?: boolean;
  /** Keep configuration nodes whose origin is (or derives from) any of these. `operational` only. */
  readonly originFilter?: OriginRef | readonly OriginRef[];
  /** Keep configuration nodes whose origin is none of these. `operational` only; not with `originFilter`. */
  readonly negatedOriginFilter?: OriginRef | readonly OriginRef[];
  /** Levels returned below each selected node, 1–65535, or `'unbounded'` (the default). */
  readonly maxDepth?: number | 'unbounded';
  /** Annotate configuration nodes with `or:origin`. `operational` only, and the server's `origin` feature. */
  readonly withOrigin?: boolean;
  /** Default reporting (RFC 6243). On `operational` the server must also advertise `:with-operational-defaults`. */
  readonly withDefaults?: WithDefaultsMode;
}

/** Options for `<edit-data>` (RFC 8526 §3.1.2). See [nmda](/guide/extensions#nmda). */
export interface EditDataOptions {
  /** The writable datastore to change: `'running'`, `'candidate'`, `'startup'` or another datastore identity. */
  readonly datastore: DatastoreRef;
  /**
   * Content to apply: XML, or an RFC 7951 JSON object, converted with the
   * datastore's YANG schema as for `editConfig`. Give exactly one of `config` and `url`.
   */
  readonly config?: Child | YangJsonObject;
  /** JSON input options (see `JsonOptions`). Never sent. */
  readonly json?: JsonOptions;
  /** Load the content from a URL (`:url`). */
  readonly url?: string;
  /** `merge` (the server default), `replace` or `none`. */
  readonly defaultOperation?: 'merge' | 'replace' | 'none';
}

/** What `client.ops.nmda` holds. */
export interface NmdaOps {
  /**
   * `<get-data>`: resolves with the reply's `<data>` element, or with
   * `format: 'json'`, an RFC 7951 JSON object typed by the server's YANG
   * schema for the datastore. `withOrigin` origins become RFC 7952
   * `ietf-origin:origin` annotations. `format` and `json` are never sent.
   * @throws SchemaUnavailableError or a YANG data error with `format: 'json'`
   *   and `json.requireSchema`, when the data can't be typed.
   */
  getData(options: GetDataOptions & RpcOptions & JsonFormat): Promise<YangJsonObject>;
  /** `<get-data>`: resolves with the reply's `<data>` element. */
  getData(options: GetDataOptions & RpcOptions & XmlFormat): Promise<XmlElement>;
  /** `<get-data>`: resolves with `<data>`, or RFC 7951 JSON with `format: 'json'`. */
  getData(options: GetDataOptions & RpcOptions & FormatOptions): Promise<XmlElement | YangJsonObject>;
  /**
   * `<edit-data>`: always rollback-on-error. A JSON `config` is converted
   * with the datastore's YANG schema, as for `editConfig`.
   */
  editData(options: EditDataOptions & RpcOptions): Promise<RpcReply>;
}

// --- requests ---------------------------------------------------------------------------

const isOperationalDerived = (ds: Identity): boolean =>
  ds.namespace !== DATASTORES_NS || ds.name === 'operational';

function list<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

/**
 * maxDepth as given: a number, `'unbounded'`, or decimal text (`'2'`), which is
 * how its descriptor (type string) hands it to client.ops.run() and the CLI.
 * Text that isn't plain digits is left as is, so the range check refuses it.
 */
function depthOf(value: unknown): unknown {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
}

/** Build a `<get-data>` request from plain arguments. Sends nothing. */
export function getDataRequest(args: RequestArgs): OperationRequest {
  const ds = datastoreIdentity(args['datastore'] as DatastoreRef);
  const filter = args['filter'] as Filter | undefined;
  const configFilter = args['configFilter'];
  const origins = list(args['originFilter'] as OriginRef | readonly OriginRef[] | undefined).map(originIdentity);
  const negated = list(args['negatedOriginFilter'] as OriginRef | readonly OriginRef[] | undefined).map(originIdentity);
  const maxDepth = depthOf(args['maxDepth']);
  const withOrigin = args['withOrigin'] === true;
  const withDefaults = args['withDefaults'];

  if (origins.length > 0 && negated.length > 0) throw new TypeError('get-data: give originFilter or negatedOriginFilter, not both');
  if ((origins.length > 0 || negated.length > 0 || withOrigin) && !isOperationalDerived(ds)) {
    throw new TypeError(`get-data: origin filters and withOrigin need the operational datastore, not ${ds.name}`);
  }
  if (configFilter !== undefined && typeof configFilter !== 'boolean') throw new TypeError('get-data: configFilter must be a boolean');
  if (maxDepth !== undefined && maxDepth !== 'unbounded' && !(typeof maxDepth === 'number' && Number.isInteger(maxDepth) && maxDepth >= 1 && maxDepth <= 65535)) {
    throw new TypeError('get-data: maxDepth must be an integer from 1 to 65535, or "unbounded"');
  }
  if (withDefaults !== undefined && !(WITH_DEFAULTS_MODES as readonly unknown[]).includes(withDefaults)) {
    throw new TypeError(`get-data: withDefaults must be one of ${WITH_DEFAULTS_MODES.join(', ')}`);
  }

  const requires: string[] = [];
  let filterElement: XmlElement | undefined;
  if (filter?.type === 'subtree') {
    filterElement = x('subtree-filter', filter.content);
  } else if (filter?.type === 'xpath') {
    const declarations: Record<string, string> = {};
    for (const [prefix, uri] of Object.entries(filter.namespaces)) declarations[`xmlns:${prefix}`] = uri;
    filterElement = x('xpath-filter', declarations, filter.select);
    requires.push(':xpath');
  } else if (isJsonFilter(filter)) {
    throw new TypeError(JSON_NEEDS_CLIENT);
  } else if (filter !== undefined) {
    throw new TypeError('get-data: filter must be subtree(...), xpath(...) or an RFC 7951 JSON object');
  }
  if (withDefaults !== undefined) {
    requires.push(':with-defaults:1.0');
    if (ds.namespace === DATASTORES_NS && ds.name === 'operational') requires.push(WITH_OPERATIONAL_DEFAULTS);
  }

  return {
    element: x('get-data', { xmlns: NMDA_NS },
      identityElement('datastore', ds),
      filterElement,
      configFilter !== undefined && x('config-filter', String(configFilter)),
      origins.map((o) => identityElement('origin-filter', o)),
      negated.map((o) => identityElement('negated-origin-filter', o)),
      maxDepth !== undefined && x('max-depth', String(maxDepth)),
      withOrigin && x('with-origin'),
      // The with-defaults leaf comes from a grouping `uses`d by ietf-netconf-nmda, so it is in that namespace.
      withDefaults !== undefined && x('with-defaults', withDefaults as string),
    ),
    requires,
  };
}

/** Build an `<edit-data>` request from plain arguments. Sends nothing. */
export function editDataRequest(args: RequestArgs): OperationRequest {
  const ds = datastoreIdentity(args['datastore'] as DatastoreRef);
  const hasConfig = args['config'] !== undefined;
  const hasUrl = args['url'] !== undefined;
  if (hasConfig === hasUrl) throw new TypeError('edit-data needs exactly one of `config` and `url`');
  const defaultOperation = args['defaultOperation'];
  if (defaultOperation !== undefined && !['merge', 'replace', 'none'].includes(defaultOperation as string)) {
    throw new TypeError('edit-data: defaultOperation must be merge, replace or none');
  }
  return {
    element: x('edit-data', { xmlns: NMDA_NS },
      identityElement('datastore', ds),
      defaultOperation !== undefined && x('default-operation', defaultOperation as string),
      hasUrl ? x('url', String(args['url'])) : x('config', xmlOnly(args['config'] as Child | YangJsonObject)),
    ),
    requires: hasUrl ? [':url'] : [],
  };
}

// --- methods ------------------------------------------------------------------------------

async function getData(ctx: ExtensionContext, options: GetDataOptions & RpcOptions & FormatOptions): Promise<XmlElement | YangJsonObject> {
  const { format, json, rest } = splitFormat(options);
  const { rest: args, rpc } = splitRpcOptions(rest);
  const request = getDataRequest(await convertJsonArgs(ctx.toXml, args, { filter: datastoreIdentity(options.datastore) }, json));
  if (options.withDefaults !== undefined) checkMode(options.withDefaults, ctx);
  const reply = await ctx.invoke(request, rpc);
  const found = reply.element.child('data', NMDA_NS) ?? reply.element.child('data', NETCONF_NS);
  const data = found ?? new XmlElement({ name: 'data', ns: NMDA_NS });
  if (format === 'xml') return data;
  return ctx.toJson(data, { ...json, datastore: datastoreIdentity(options.datastore), hint: READ_AS_XML_HINT });
}

function checkMode(mode: WithDefaultsMode, ctx: ExtensionContext): void {
  if (ctx.capabilityCheck === 'off') return;
  const { supportedModes } = defaultsHandling(ctx.serverCapabilities);
  if (supportedModes.length === 0 || supportedModes.includes(mode)) return; // a missing capability is reported by invoke()
  if (ctx.capabilityCheck === 'strict') throw new CapabilityError(`with-defaults mode ${mode}`, 'get-data');
  ctx.logger.warn?.(`get-data with-defaults ${mode} isn't advertised by the server; sending anyway`);
}

// --- origins ------------------------------------------------------------------------------

/**
 * Every element's origin in a `<get-data>` reply made with `withOrigin`: its own
 * `or:origin`, or else the nearest annotated ancestor's (RFC 8526 §3.1.1.1).
 * Elements with no origin in their ancestry (state data, for example) are absent.
 *
 * Each origin is an identity, module-qualified as RFC 7951 writes it:
 * `ietf-origin:intended`, `ietf-origin:learned`, or another module's. Its
 * prefix resolves wherever the server declared it, up to `<rpc-reply>`.
 * `moduleOf` names a module the library doesn't know by heart: pass
 * `(ns) => client.content.moduleOf(ns)`.
 */
export function origins(root: XmlElement, options: { readonly moduleOf?: ModuleOf } = {}): Map<XmlElement, string> {
  const out = new Map<XmlElement, string>();
  const stack: { el: XmlElement; inherited: string | undefined }[] = [{ el: root, inherited: undefined }];
  while (stack.length > 0) {
    const { el, inherited } = stack.pop()!;
    const text = el.attr('origin', ORIGIN_NS);
    const origin = (text === undefined ? undefined : qualifiedIdentity(text, el, options.moduleOf)) ?? inherited;
    if (origin !== undefined) out.set(el, origin);
    for (const child of el.elements) stack.push({ el: child, inherited: origin });
  }
  return out;
}

/** The origin of one element below `root` (see {@link origins}). */
export function originOf(root: XmlElement, element: XmlElement, options: { readonly moduleOf?: ModuleOf } = {}): string | undefined {
  return origins(root, options).get(element);
}

// --- descriptors and the extension -------------------------------------------------------------

const DATASTORE_PARAM = {
  name: 'datastore',
  kind: 'positional',
  type: 'datastore',
  description: 'The datastore: running, candidate, startup, intended, operational, or another datastore identity',
  values: STANDARD_DATASTORES,
  required: true,
} as const;

const GET_DATA: OperationDescriptor = Object.freeze({
  name: 'get-data',
  namespace: NMDA_NS,
  method: 'getData',
  description: 'Read data from any NMDA datastore',
  mutates: false,
  requires: [':yang-library:1.1'],
  params: Object.freeze([
    DATASTORE_PARAM,
    { name: 'filter', kind: 'option', type: 'filter', description: 'A subtree filter (XML or RFC 7951 JSON), or an XPath filter (needs :xpath)' },
    { name: 'configFilter', kind: 'option', type: 'boolean', description: 'true: configuration nodes only; false: state nodes only' },
    { name: 'originFilter', kind: 'option', type: 'string', multiple: true, values: STANDARD_ORIGINS, description: 'Keep configuration nodes with these origins (operational only)' },
    { name: 'negatedOriginFilter', kind: 'option', type: 'string', multiple: true, values: STANDARD_ORIGINS, description: 'Drop configuration nodes with these origins (operational only)' },
    { name: 'maxDepth', kind: 'option', type: 'string', description: 'Levels below each selected node: 1-65535 or unbounded', default: 'unbounded' },
    { name: 'withOrigin', kind: 'option', type: 'boolean', description: 'Annotate configuration nodes with their origin (operational only)' },
    { name: 'withDefaults', kind: 'option', type: 'string', values: WITH_DEFAULTS_MODES, description: 'How to report default values (needs :with-defaults)', requires: [':with-defaults:1.0'] },
  ] as const),
});

const EDIT_DATA: OperationDescriptor = Object.freeze({
  name: 'edit-data',
  namespace: NMDA_NS,
  method: 'editData',
  description: 'Change configuration in an NMDA datastore (always rollback-on-error)',
  mutates: true,
  requires: [':yang-library:1.1'],
  params: Object.freeze([
    { ...DATASTORE_PARAM, description: 'The writable datastore to change' },
    { name: 'config', kind: 'positional', type: 'xml', description: 'The configuration content: XML, or RFC 7951 JSON (give this or url)' },
    { name: 'url', kind: 'option', type: 'string', description: 'Load the content from a URL', requires: [':url'] },
    { name: 'defaultOperation', kind: 'option', type: 'string', values: ['merge', 'replace', 'none'], description: 'The default operation for the content' },
  ] as const),
});

/** The NMDA extension (RFC 8342, 8526). Enable it with `connect({ extensions: [nmda] })`. */
export const nmda = defineExtension({
  id: 'nmda',
  description: 'RFC 8526: get-data and edit-data on any NMDA datastore',
  requires: [':yang-library:1.1'],
  descriptors: [GET_DATA, EDIT_DATA],
  requests: { 'get-data': getDataRequest, 'edit-data': editDataRequest },
  ops: (ctx): NmdaOps => ({
    getData: ((options: GetDataOptions & RpcOptions & FormatOptions) => getData(ctx, options)) as NmdaOps['getData'],
    editData: async (options) => {
      const { json, ...rest } = options;
      const { rest: args, rpc } = splitRpcOptions(rest);
      const ds = datastoreIdentity(options.datastore);
      return ctx.invoke(editDataRequest(await convertJsonArgs(ctx.toXml, args, { config: ds }, json)), rpc);
    },
  }),
});
