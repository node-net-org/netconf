/**
 * RFC 6022 NETCONF monitoring (design §8): fetch schemas with `<get-schema>`,
 * and read the server's schemas, sessions, datastore locks and statistics
 * from `/netconf-state`.
 *
 * ```ts
 * import { monitoring } from '@node-net/netconf/operations/monitoring';
 *
 * const client = await connect({ transport, extensions: [monitoring] });
 * const yang = await client.ops.monitoring.getSchema({ identifier: 'ietf-interfaces', version: '2018-02-20' });
 * const holder = (await client.content.monitoring.datastores()).find((d) => d.name === 'running')?.globalLock?.sessionId;
 * ```
 *
 * `<get-schema>` failures are ordinary RpcErrors: tag `invalid-value` when the
 * server has no such schema, and tag `operation-failed` with app tag
 * `data-not-unique` when the request matches several (give `version`).
 *
 * @packageDocumentation
 */

import { ProtocolError } from '../errors.js';
import { MONITORING_NS, NETCONF_NS, type RpcOptions } from '../messages/index.js';
import { parseXml, x, type XmlElement } from '../xml/index.js';
import { get, subtree, type OperationRequest } from './base.js';
import { splitRpcOptions } from './args.js';
import { defineExtension, type ExtensionContext, type OperationDescriptor } from './extension.js';
import { qualifiedIdentity, qualifiedPath, type ModuleOf } from './qualified.js';

export { MONITORING_NS } from '../messages/index.js';

/** Schema formats (RFC 6022 §2.1.3). YANG and RNC are text; YIN, XSD and RNG are XML. */
export type SchemaFormat = 'yang' | 'yin' | 'xsd' | 'rng' | 'rnc';
/** Every {@link SchemaFormat}, for tools that list or check them. */
export const SCHEMA_FORMATS: readonly SchemaFormat[] = Object.freeze(['yang', 'yin', 'xsd', 'rng', 'rnc']);
type XmlSchemaFormat = 'yin' | 'xsd' | 'rng';

/** Options for `<get-schema>` (RFC 6022 §3.1). See [monitoring](/guide/extensions#monitoring). */
export interface GetSchemaOptions extends RpcOptions {
  /** Module or submodule name. */
  readonly identifier: string;
  /** Revision date. Give it whenever you know it: servers differ when several revisions exist. */
  readonly version?: string;
  /** Server default (YANG) when left out. */
  readonly format?: SchemaFormat;
}

/** One schema the server offers: an entry of RFC 6022 `/netconf-state/schemas`. */
export interface SchemaInfo {
  /** The module or submodule name, as `<get-schema>` takes it. */
  readonly identifier: string;
  /** Revision date, or `''` if the schema has none. */
  readonly version: string;
  /** The format identity, module-qualified (RFC 7951): `'ietf-netconf-monitoring:yang'`. */
  readonly format: string;
  /** The XML namespace the module defines, or `''` if the server sent none. */
  readonly namespace: string;
  /** URIs, or `'NETCONF'` when the schema can be fetched with `<get-schema>`. */
  readonly locations: readonly string[];
}

/** One open NETCONF session: an entry of RFC 6022 `/netconf-state/sessions`. */
export interface SessionInfo {
  /** The session's id, as `<kill-session>` takes it. */
  readonly sessionId: number;
  /**
   * The transport identity, module-qualified (RFC 7951), such as
   * `'ietf-netconf-monitoring:netconf-ssh'`; another module's identity keeps
   * its own module name. `''` if the server sent none it could resolve.
   */
  readonly transport: string;
  /** The user the session authenticated as, or `''` if the server sent none. */
  readonly username: string;
  /** The client's host name or address, when the server reports it. */
  readonly sourceHost?: string;
  /** When the session started, as the server sent it (a YANG `date-and-time`), or `''`. */
  readonly loginTime: string;
  /** Correct `<rpc>` messages received on the session. */
  readonly inRpcs?: number;
  /** Messages received on the session that weren't a correct `<rpc>`. */
  readonly inBadRpcs?: number;
  /** `<rpc-reply>` messages sent on the session that held an `<rpc-error>`. */
  readonly outRpcErrors?: number;
  /** Notifications sent on the session. */
  readonly outNotifications?: number;
}

/** A lock on a datastore: who holds it and since when. */
export interface LockInfo {
  /** The holder's session-id. `0` means a non-NETCONF holder, such as a CLI user, which `<kill-session>` can't clear. */
  readonly sessionId: number;
  /** When the lock was taken, as the server sent it (a YANG `date-and-time`), or `''`. */
  readonly lockedTime: string;
}

/** A partial lock (RFC 5717) on part of a datastore. */
export interface PartialLockInfo extends LockInfo {
  /** The lock's id, as `<partial-unlock>` takes it. */
  readonly lockId: number;
  /** The select expressions, as sent: XPath, whose prefixes are the server's. */
  readonly select: readonly string[];
  /** The locked nodes, as RFC 7951 instance-identifiers: `/ietf-interfaces:interfaces/interface[name='eth0']`. */
  readonly lockedNodes: readonly string[];
}

/** One datastore and its locks: an entry of RFC 6022 `/netconf-state/datastores`. */
export interface DatastoreInfo {
  /** The datastore: `'running'`, `'candidate'` or `'startup'`. */
  readonly name: string;
  /** Present while the datastore is locked with `<lock>`. */
  readonly globalLock?: LockInfo;
  /** Partial locks (RFC 5717). */
  readonly partialLocks: readonly PartialLockInfo[];
}

/**
 * Server-wide counters: RFC 6022 `/netconf-state/statistics`. Each is absent
 * when the server doesn't report it. Counts are since the server started.
 */
export interface Statistics {
  /** When the NETCONF server started, as it sent it (a YANG `date-and-time`). */
  readonly netconfStartTime?: string;
  /** Sessions dropped because the client sent an invalid hello. */
  readonly inBadHellos?: number;
  /** Sessions started (counted when the server sends its hello). */
  readonly inSessions?: number;
  /** Sessions that ended abnormally, other than by `<close-session>` or `<kill-session>`. */
  readonly droppedSessions?: number;
  /** Correct `<rpc>` messages received. */
  readonly inRpcs?: number;
  /** Messages received that weren't a correct `<rpc>`. */
  readonly inBadRpcs?: number;
  /** `<rpc-reply>` messages sent that held an `<rpc-error>`. */
  readonly outRpcErrors?: number;
  /** Notifications sent. */
  readonly outNotifications?: number;
}

/** What `client.ops.monitoring` holds. */
export interface MonitoringOps {
  /** `<get-schema>`: the schema source as text (YANG, RNC). */
  getSchema(options: GetSchemaOptions & { readonly format?: 'yang' | 'rnc' }): Promise<string>;
  /** `<get-schema>` for an XML format: the schema's root element (such as YIN's `<module>`). */
  getSchema(options: GetSchemaOptions & { readonly format: XmlSchemaFormat }): Promise<XmlElement>;
  /** `<get-schema>`: the schema as text, or its root element for an XML format. */
  getSchema(options: GetSchemaOptions): Promise<string | XmlElement>;
}

/** What `client.content.monitoring` holds: the server's monitoring state, decoded. */
export interface MonitoringContent {
  /** The schemas the server offers (`/netconf-state/schemas`). */
  schemas(options?: RpcOptions): Promise<SchemaInfo[]>;
  /** The open NETCONF sessions (`/netconf-state/sessions`). */
  sessions(options?: RpcOptions): Promise<SessionInfo[]>;
  /** The datastores and who has them locked (`/netconf-state/datastores`). */
  datastores(options?: RpcOptions): Promise<DatastoreInfo[]>;
  /** Server-wide counters (`/netconf-state/statistics`). */
  statistics(options?: RpcOptions): Promise<Statistics>;
}

// --- <get-schema> ---------------------------------------------------------------

const GET_SCHEMA: OperationDescriptor = Object.freeze({
  name: 'get-schema',
  namespace: MONITORING_NS,
  method: 'getSchema',
  description: 'Fetch a schema (such as a YANG module) from the server',
  mutates: false,
  requires: [MONITORING_NS],
  params: Object.freeze([
    { name: 'identifier', kind: 'positional', type: 'string', description: 'Module or submodule name', required: true },
    { name: 'version', kind: 'option', type: 'string', description: 'Revision date' },
    { name: 'format', kind: 'option', type: 'string', description: 'Schema format (server default yang)', values: SCHEMA_FORMATS },
  ] as const),
});

/** Build a `<get-schema>` request from plain arguments. Sends nothing. */
export function getSchemaRequest(args: Readonly<Record<string, unknown>>): OperationRequest {
  const { identifier, version, format } = args;
  if (typeof identifier !== 'string' || identifier === '') throw new TypeError('get-schema needs an identifier');
  if (version !== undefined && typeof version !== 'string') throw new TypeError('get-schema version must be a string');
  if (format !== undefined && !(SCHEMA_FORMATS as readonly unknown[]).includes(format)) {
    throw new TypeError(`get-schema format must be one of ${SCHEMA_FORMATS.join(', ')}`);
  }
  return {
    element: x('get-schema', { xmlns: MONITORING_NS },
      x('identifier', identifier),
      version !== undefined && x('version', version),
      format !== undefined && x('format', format as string),
    ),
    requires: [],
  };
}

async function getSchema(ctx: ExtensionContext, options: GetSchemaOptions): Promise<string | XmlElement> {
  const { rpc, rest: args } = splitRpcOptions(options);
  const reply = await ctx.invoke(getSchemaRequest(args), rpc);
  // RFC 6022 puts <data> in the monitoring namespace; accept the base namespace too.
  const data = reply.element.child('data', MONITORING_NS) ?? reply.element.child('data', NETCONF_NS);
  if (data === undefined) throw new ProtocolError(`get-schema reply for ${options.identifier} has no <data> element`);
  const format = options.format ?? 'yang';
  if (format === 'yang' || format === 'rnc') return data.textContent();
  // XML formats: servers send the document either as child elements or as
  // escaped text (netopeer2 does the latter). Return its root element either way.
  const root = data.elements[0];
  if (root !== undefined) return root;
  const text = data.textContent().trim();
  if (text === '') throw new ProtocolError(`get-schema reply for ${options.identifier} is empty`);
  return parseXml(text);
}

// --- /netconf-state reads ---------------------------------------------------------

async function readState(ctx: ExtensionContext, part: string, options: RpcOptions = {}): Promise<XmlElement | undefined> {
  const reply = await ctx.invoke(get({ filter: subtree(x('netconf-state', { xmlns: MONITORING_NS }, x(part))) }), options);
  return reply.data?.child('netconf-state', MONITORING_NS)?.child(part, MONITORING_NS);
}

const leaf = (el: XmlElement, name: string): string | undefined => el.child(name, MONITORING_NS)?.text().trim();
const leaves = (el: XmlElement, name: string): string[] =>
  el.childrenNamed(name, MONITORING_NS).map((c) => c.text().trim());
/** An identityref leaf, module-qualified (`ncm:netconf-ssh` → `ietf-netconf-monitoring:netconf-ssh`). */
function identity(el: XmlElement, name: string, moduleOf: ModuleOf | undefined): string | undefined {
  const child = el.child(name, MONITORING_NS);
  return child === undefined ? undefined : qualifiedIdentity(child.text(), child, moduleOf);
}

function count(el: XmlElement, name: string): number | undefined {
  const text = leaf(el, name);
  if (text === undefined || !/^\d+$/.test(text)) return undefined;
  return Number(text);
}

/** Copy only the defined values, so optional fields are absent rather than undefined. */
function defined<T extends object>(obj: T): T {
  return Object.freeze(Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))) as T;
}

function parseSchemas(schemas: XmlElement | undefined, moduleOf: ModuleOf | undefined): SchemaInfo[] {
  const out: SchemaInfo[] = [];
  for (const s of schemas?.childrenNamed('schema', MONITORING_NS) ?? []) {
    const identifier = leaf(s, 'identifier');
    const format = identity(s, 'format', moduleOf);
    if (identifier === undefined || format === undefined) continue;
    out.push(Object.freeze({
      identifier,
      version: leaf(s, 'version') ?? '',
      format,
      namespace: leaf(s, 'namespace') ?? '',
      locations: Object.freeze(leaves(s, 'location')),
    }));
  }
  return out;
}

function parseSessions(sessions: XmlElement | undefined, moduleOf: ModuleOf | undefined): SessionInfo[] {
  const out: SessionInfo[] = [];
  for (const s of sessions?.childrenNamed('session', MONITORING_NS) ?? []) {
    const sessionId = count(s, 'session-id');
    if (sessionId === undefined) continue;
    out.push(defined<SessionInfo>({
      sessionId,
      transport: identity(s, 'transport', moduleOf) ?? '',
      username: leaf(s, 'username') ?? '',
      sourceHost: leaf(s, 'source-host'),
      loginTime: leaf(s, 'login-time') ?? '',
      inRpcs: count(s, 'in-rpcs'),
      inBadRpcs: count(s, 'in-bad-rpcs'),
      outRpcErrors: count(s, 'out-rpc-errors'),
      outNotifications: count(s, 'out-notifications'),
    } as SessionInfo));
  }
  return out;
}

function parseDatastores(datastores: XmlElement | undefined, moduleOf: ModuleOf | undefined): DatastoreInfo[] {
  const out: DatastoreInfo[] = [];
  for (const d of datastores?.childrenNamed('datastore', MONITORING_NS) ?? []) {
    const name = leaf(d, 'name');
    if (name === undefined) continue;
    const locks = d.child('locks', MONITORING_NS);
    const global = locks?.child('global-lock', MONITORING_NS);
    const globalLock = global === undefined ? undefined : lockOf(global);
    const partialLocks: PartialLockInfo[] = [];
    for (const p of locks?.childrenNamed('partial-lock', MONITORING_NS) ?? []) {
      const lock = lockOf(p);
      const lockId = count(p, 'lock-id');
      if (lock === undefined || lockId === undefined) continue;
      partialLocks.push(Object.freeze({
        ...lock,
        lockId,
        select: Object.freeze(leaves(p, 'select')),
        lockedNodes: Object.freeze(lockedNodes(p, moduleOf)),
      }));
    }
    out.push(defined<DatastoreInfo>({ name, globalLock, partialLocks: Object.freeze(partialLocks) } as DatastoreInfo));
  }
  return out;
}

/** A partial lock's locked nodes as RFC 7951 paths; one that can't be parsed is kept as the server sent it. */
function lockedNodes(lock: XmlElement, moduleOf: ModuleOf | undefined): string[] {
  return lock.childrenNamed('locked-node', MONITORING_NS).map((el) => {
    try {
      return qualifiedPath(el.text(), el, moduleOf);
    } catch {
      return el.text().trim();
    }
  });
}

function lockOf(el: XmlElement): LockInfo | undefined {
  const sessionId = count(el, 'locked-by-session');
  if (sessionId === undefined) return undefined;
  return Object.freeze({ sessionId, lockedTime: leaf(el, 'locked-time') ?? '' });
}

function parseStatistics(stats: XmlElement | undefined): Statistics {
  if (stats === undefined) return Object.freeze({});
  return defined<Statistics>({
    netconfStartTime: leaf(stats, 'netconf-start-time'),
    inBadHellos: count(stats, 'in-bad-hellos'),
    inSessions: count(stats, 'in-sessions'),
    droppedSessions: count(stats, 'dropped-sessions'),
    inRpcs: count(stats, 'in-rpcs'),
    inBadRpcs: count(stats, 'in-bad-rpcs'),
    outRpcErrors: count(stats, 'out-rpc-errors'),
    outNotifications: count(stats, 'out-notifications'),
  } as Statistics);
}
/**
 * The /netconf-state reads, described so tools can run them
 * (`client.ops.run('monitoring-sessions')`). Read names are hyphenated, which
 * device profile operation names can't be, so the two never clash.
 */
const READS: readonly OperationDescriptor[] = Object.freeze(
  ([
    ['schemas', 'The schemas the server offers (/netconf-state/schemas)'],
    ['sessions', 'The open NETCONF sessions (/netconf-state/sessions)'],
    ['datastores', 'The datastores, and who has them locked (/netconf-state/datastores)'],
    ['statistics', 'Server-wide counters (/netconf-state/statistics)'],
  ] as const).map(([method, description]) =>
    Object.freeze({
      name: `monitoring-${method}`,
      kind: 'read',
      namespace: MONITORING_NS,
      method,
      description,
      mutates: false,
      requires: Object.freeze([MONITORING_NS]),
      params: Object.freeze([]),
    }),
  ),
);

// --- the extension ---------------------------------------------------------------------

/** The RFC 6022 monitoring extension. Enable it with `connect({ extensions: [monitoring] })`. */
export const monitoring = defineExtension({
  id: 'monitoring',
  description: 'RFC 6022: fetch schemas, and read sessions, locks and statistics',
  requires: [MONITORING_NS],
  descriptors: [GET_SCHEMA, ...READS],
  requests: { 'get-schema': getSchemaRequest },
  ops: (ctx): MonitoringOps => ({
    getSchema: ((options: GetSchemaOptions) => getSchema(ctx, options)) as MonitoringOps['getSchema'],
  }),
  content: (ctx): MonitoringContent => ({
    schemas: async (options) => parseSchemas(await readState(ctx, 'schemas', options), ctx.moduleOf),
    sessions: async (options) => parseSessions(await readState(ctx, 'sessions', options), ctx.moduleOf),
    datastores: async (options) => parseDatastores(await readState(ctx, 'datastores', options), ctx.moduleOf),
    statistics: async (options) => parseStatistics(await readState(ctx, 'statistics', options)),
  }),
});
