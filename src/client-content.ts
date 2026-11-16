/**
 * `client.content` (design §3.1, §6.4): the Content layer of a NetconfClient.
 *
 * Reading and configuring by YANG path, resolving modules, and each enabled
 * extension's decoded readers under its id. Every call here takes paths or
 * hands back typed values and parsed objects; underneath, it runs the
 * Operations layer (`client.ops`).
 */

import { applyInPlace, checkTargetSchema, editContent } from './client-configure.js';
import { ClientModules, type DeclaredFeature, type ModulesOptions, type ServerDatastores, type ServerModules } from './client-modules.js';
import type { ClientOps } from './client-ops.js';
import { ConfigTransaction, buildFilter, filterDepth, pathXPath, resolveWorkflow, selectPath } from './content/index.js';
import type { NamedPathTemplate, ResolvedStep, Workflow } from './content/index.js';
import type { DeviceProfile } from './devices/index.js';
import type { ModuleNamespaceInfo, ModuleNamespaces, NamespaceSource } from './module-namespaces.js';
import { CapabilityError } from './errors.js';
import type { RpcOptions, Session } from './messages/index.js';
import { splitRpcOptions } from './operations/args.js';
import { withCandidate, type CandidateChangesOptions, type ConfigureStep, type ConfirmedCommitOptions, type DatastoreChange, type PendingCommit } from './operations/transaction.js';
import {
  splitFormat,
  isJsonInput,
  READ_AS_XML_HINT,
  type base as ops,
  type CapabilityCheck,
  type ExtensionContext,
  type FormatOptions,
  type JsonOptions,
  type ToJsonOptions,
  type ToXmlOptions,
  type YangJsonObject,
  type YangJsonValue,
} from './operations/index.js';
import { XmlElement } from './xml/index.js';
import { isEmptyValue, selectJson } from './yang/index.js';

/** Options for read(): the RPC options, and any options that enabled extensions add to get and get-config. */
export interface ReadOptions extends RpcOptions, Omit<ops.GetConfigOptions, 'source' | 'filter'> {
  /**
   * A configuration datastore, read with `<get-config>` (default
   * `'running'`), or `'config+state'` for `<get>`: running configuration
   * and state data together. The NMDA `<operational>` datastore is read with
   * `client.ops.nmda.getData({ datastore: 'operational' })`, not here.
   */
  readonly source?: ops.Datastore | 'config+state';
}

/** No format, or `format: 'json'`: the Content layer's default, for the overloads whose result is JSON. */
export interface ContentJsonFormat extends FormatOptions {
  readonly format?: 'json';
}

/** `format: 'xml'`, for the Content-layer overloads whose result is XML. */
export interface ContentXmlFormat extends FormatOptions {
  readonly format: 'xml';
}

/** An RPC's or action's input parameters for `invoke()`: XML elements, or an RFC 7951 JSON object. */
export type InvokeInput = XmlElement | readonly XmlElement[] | YangJsonObject;

/** Options for `invoke()`: the per-call RPC options. `format` and `json` are never sent. */
export type InvokeOptions = RpcOptions;

/** The hint on invoke()'s JSON conversion failures and warnings. */
const INVOKE_AS_XML_HINT = "Invoke with format: 'xml' to get the output as the server sent it";

/**
 * Options for `configure()`: the workflow steps (`editTarget`, `lock`,
 * `validate`, `commit`), which override the device profile's, plus the
 * per-call options. See [How changes are applied](/guide/content#how-changes-are-applied).
 */
export interface ConfigureOptions extends RpcOptions, Partial<Workflow> {
  /**
   * Called as each workflow request succeeds (lock, discard-changes,
   * edit-config, validate, commit, unlock), including cleanup after a
   * failure. A failed request isn't reported: the rejection says where it
   * failed. A listener that throws is logged and ignored.
   */
  readonly onStep?: (step: ConfigureStep) => void;
  /**
   * Apply with a confirmed commit (RFC 6241 §8.4) through withCandidate():
   * configure() then resolves with the PendingCommit to confirm() or cancel().
   * Needs the candidate workflow with commit; anything else is refused before
   * sending. `timeout` is in seconds; `persist` needs `:confirmed-commit:1.1`.
   */
  readonly confirmed?: true | ConfirmedCommitOptions;
  /** Options for the transaction's JSON edits (`txn.merge(json)`, `txn.replace(json)`); see `JsonOptions`. */
  readonly json?: JsonOptions;
}

export type { ModuleNamespaceInfo, NamespaceSource } from './module-namespaces.js';
export type { DatastoreSource, DeclaredFeature, ModulesOptions, ServerDatastore, ServerDatastores, ServerModule, ServerModules } from './client-modules.js';

/** Options for `compareDatastores()`. */
export interface CompareDatastoresOptions extends CandidateChangesOptions {
  /** The datastore the changes start from. */
  readonly source: ops.Datastore;
  /** The datastore the changes lead to. */
  readonly target: ops.Datastore;
}

/** @internal What ClientContent needs from the client that builds it. */
export interface ClientContentInit {
  readonly session: Session;
  readonly ops: ClientOps;
  readonly profile: DeviceProfile | undefined;
  readonly capabilityCheck: CapabilityCheck;
  /** The session's module namespaces, shared with the JSON conversion. */
  readonly moduleNamespaces: ModuleNamespaces;
  readonly ctx: ExtensionContext;
  /** The YANG-typed comparison of two datastores' data (the client's ClientYang.diff). */
  readonly diff: (from: XmlElement, to: XmlElement, datastore: ops.Datastore) => Promise<DatastoreChange[]>;
  /** Each module's declared features from its compiled source (the client's ClientYang.declaredFeatures). */
  readonly declaredFeatures: (
    selector: { readonly datastore?: { readonly name: string; readonly namespace: string }; readonly schema?: string },
    modules: readonly string[],
  ) => Promise<ReadonlyMap<string, readonly DeclaredFeature[]>>;
}

/**
 * `client.content`: the Content layer. Read and change configuration by YANG
 * path (`read()`, `set()`, `configure()`), compare datastores, list the server's
 * datastores and modules, convert between XML and JSON, and each enabled
 * extension's decoded readers under its id. Reads resolve with RFC 7951 JSON
 * by default. See [Content](/guide/content).
 */
export class ClientContent {
  readonly #init: ClientContentInit;
  /** Modules, datastores and path resolution. */
  readonly #modules: ClientModules;

  /** @internal Built by NetconfClient. */
  constructor(init: ClientContentInit) {
    this.#init = init;
    this.#modules = new ClientModules(init);
  }

  /**
   * Read the nodes a YANG path selects, as RFC 7951 JSON by default.
   *
   * ```ts
   * const eth0 = '/ietf-interfaces:interfaces/interface[name="eth0"]';
   * await client.content.read(eth0);
   * // { 'ietf-interfaces:interface': [{ name: 'eth0', enabled: true, ... }] }
   * // a named path from the device profile
   * await client.content.read('@systemName');
   * // a named path with a parameter
   * await client.content.read('@interface(eth0)');
   * // ...left out: every interface
   * await client.content.read('@interface');
   * // the elements, as the server sent them
   * await client.content.read(eth0, { format: 'xml' });
   * ```
   * @returns The target node as RESTCONF returns it (RFC 8040):
   *   `{ 'module:name': value }`, a list's matching entries as an array, a
   *   container as an object and a leaf as its typed value; `{}` if none.
   *   With `format: 'xml'`, every matching element (an empty array if none).
   * @throws SchemaUnavailableError or a YANG data error with
   *   `json.requireSchema`, when the data can't be typed. Its message
   *   suggests `format: 'xml'`.
   */
  read(path: string, options: ReadOptions & ContentXmlFormat): Promise<XmlElement[]>;
  read(path: string, options?: ReadOptions & ContentJsonFormat): Promise<YangJsonObject>;
  read(path: string, options?: ReadOptions & FormatOptions): Promise<XmlElement[] | YangJsonObject>;
  async read(path: string, options: ReadOptions & FormatOptions = {}): Promise<XmlElement[] | YangJsonObject> {
    if ((options.source as string | undefined) === 'operational') {
      throw new TypeError(
        "read(): source 'operational' is the NMDA <operational> datastore; read it with client.ops.nmda.getData({ datastore: 'operational' }), or use source 'config+state' for <get>",
      );
    }
    const { format, json, rest } = splitFormat(options, 'json');
    await this.#modules.ensure([path], splitRpcOptions(rest).rpc);
    const steps = this.resolvePath(path);
    const sent = this.#filterFor(steps);
    const filter = sent === undefined ? {} : { filter: sent };
    const { source, ...others } = rest;
    const opsLayer = this.#init.ops;
    // The Operations layer reads XML; the Content layer owns the conversion.
    const data =
      source === 'config+state'
        ? await opsLayer.get({ ...others, ...filter })
        : await opsLayer.getConfig({ ...others, source: source ?? 'running', ...filter });
    if (format === 'xml') return selectPath(data, steps);
    // <get> returns configuration and state, which the operational schema types.
    const datastore = source === 'config+state' ? 'operational' : (source ?? 'running');
    const converted = await this.#init.ctx.toJson(data, { ...json, datastore, hint: READ_AS_XML_HINT });
    return selectJson(converted, steps);
  }

  /**
   * The filter read() sends for a path or `@alias`, after the profile's
   * subtreeFilter quirk: the whole path by default, trimmed to
   * `subtreeFilterDepth` with `'containers'`, or undefined with `'unsupported'`
   * (read() then fetches the datastore and selects locally). Sends nothing.
   * @throws PathError for a malformed path or an unknown module.
   */
  readFilter(path: string): ops.Filter | undefined {
    return this.#filterFor(this.resolvePath(path));
  }

  /**
   * Read the first node a path selects, or undefined if there is none: its
   * typed RFC 7951 value by default (a number, string, boolean or `[null]`
   * for a leaf, an object for a container), or with `format: 'xml'`, its
   * trimmed text.
   *
   * ```ts
   * const mtu = '/ietf-interfaces:interfaces/interface[name="eth0"]/mtu';
   * await client.content.readValue(mtu); // 1500
   * await client.content.readValue(mtu, { format: 'xml' }); // '1500'
   * ```
   */
  readValue(path: string, options: ReadOptions & ContentXmlFormat): Promise<string | undefined>;
  readValue(path: string, options?: ReadOptions & ContentJsonFormat): Promise<YangJsonValue | undefined>;
  readValue(path: string, options?: ReadOptions & FormatOptions): Promise<string | YangJsonValue | undefined>;
  async readValue(path: string, options: ReadOptions & FormatOptions = {}): Promise<string | YangJsonValue | undefined> {
    const { format } = splitFormat(options, 'json');
    if (format === 'xml') return (await this.read(path, { ...options, format: 'xml' }))[0]?.text().trim();
    const found = Object.values(await this.read(path, { ...options, format: 'json' }))[0];
    // A list's (or leaf-list's) entries are an array: the first is the first node. An empty leaf's [null] is its value.
    return Array.isArray(found) && !isEmptyValue(found) ? found[0] : found;
  }

  /**
   * Invoke the RPC or YANG 1.1 action a path names, and resolve with its
   * output parameters. A path of one step names an RPC (`/ex:restart`). A
   * longer one names an action on that data node
   * (`/ex:servers/server[name="a"]/reset`), sent as an `<action>` holding
   * the ancestors and their keys (RFC 7950 §7.15.2). Paths, named paths and
   * module resolution work as for `read()`.
   *
   * `input` is the input parameters: XML elements, or an RFC 7951 JSON
   * object whose members are named as inside the operation, converted with
   * the server's schema. The output is an RFC 7951 JSON object named the
   * same way by default, or with `format: 'xml'` the output elements.
   *
   * ```ts
   * const path = '/ex:servers/server[name="a"]/reset';
   * // { 'finished-at': '2026-11-15T04:40:00Z' }
   * await client.content.invoke(path, { delay: 3 });
   * ```
   * @throws TypeError for a path whose last step has a predicate, or input
   *   that isn't XML or a JSON object; PathError for an unknown module.
   */
  invoke(path: string, input: InvokeInput | undefined, options: InvokeOptions & ContentXmlFormat): Promise<XmlElement[]>;
  invoke(path: string, input?: InvokeInput, options?: InvokeOptions & ContentJsonFormat): Promise<YangJsonObject>;
  invoke(path: string, input?: InvokeInput, options?: InvokeOptions & FormatOptions): Promise<XmlElement[] | YangJsonObject>;
  async invoke(path: string, input?: InvokeInput, options: InvokeOptions & FormatOptions = {}): Promise<XmlElement[] | YangJsonObject> {
    const { format, json, rest } = splitFormat(options, 'json');
    const rpc = splitRpcOptions(rest).rpc;
    await this.#modules.ensure([path], rpc);
    const steps = this.#modules.resolve(path, 'error');
    const last = steps[steps.length - 1]!;
    if (last.keys.length > 0 || last.value !== undefined) {
      throw new TypeError(`invoke(): the last step of ${JSON.stringify(path)} names the RPC or action, so it takes no predicate`);
    }
    const operation = operationPath(steps);
    let params: readonly XmlElement[];
    if (input === undefined) params = [];
    else if (input instanceof XmlElement) params = [input];
    else if (Array.isArray(input) && input.every((el) => el instanceof XmlElement)) params = input;
    else if (isJsonInput(input)) params = await this.#init.ctx.toXml(input, { ...json, operation });
    else throw new TypeError('invoke(): input must be XML elements or an RFC 7951 JSON object of the input parameters');

    let tree = new XmlElement({ name: last.name, ns: last.ns, children: [...params] });
    for (let i = steps.length - 2; i >= 0; i--) {
      const step = steps[i]!;
      const keys = step.keys.map((k) => new XmlElement({ name: k.name, ns: step.ns, children: [k.value] }));
      const value = step.value === undefined ? [] : [step.value];
      tree = new XmlElement({ name: step.name, ns: step.ns, children: [...keys, ...value, tree] });
    }
    const reply = steps.length === 1 ? await this.#init.session.rpc(tree, rpc) : await this.#init.ops.action(tree, rpc);
    if (format === 'xml') return [...reply.output];
    return this.#init.ctx.toJson(reply.element, { ...json, operation, hint: INVOKE_AS_XML_HINT });
  }

  /**
   * Convert YANG data in XML to RFC 7951 JSON, by the same rules and schemas
   * as `format: 'json'`: a `<data>` element, or any element holding YANG data
   * nodes, such as a transaction's read, a raw RPC reply's data or a
   * notification's content. `datastore` (default `'operational'`) picks the
   * schema; `scope` gives prefixes declared above `data` (such as on its
   * `<rpc-reply>`), for prefixes used in values.
   *
   * ```ts
   * const reply = await client.session.rpc(x('get', { xmlns: NETCONF_NS }));
   * const json = await client.content.toJson(reply.data!);
   * ```
   * @throws SchemaUnavailableError or a YANG data error with `requireSchema`.
   */
  toJson(data: XmlElement, options: ToJsonOptions = {}): Promise<YangJsonObject> {
    return this.#init.ctx.toJson(data, options);
  }

  /**
   * Convert RFC 7951 JSON to XML by the same rules and schemas as JSON
   * `config` on edit-config: the elements an edit would send (RFC 7952
   * metadata `ietf-netconf:operation` and `yang:insert` becoming the edit
   * attributes), or with `filter: true`, subtree-filter content. The inverse
   * of `toJson()`. `datastore` (default `'running'`) picks the schema.
   * Sends nothing but any schema reads it needs.
   *
   * ```ts
   * const config = await client.content.toXml({
   *   'ietf-interfaces:interfaces': {
   *     interface: [{ name: 'eth0', enabled: false }],
   *   },
   * });
   * await client.session.rpc(
   *   x('edit-config', { xmlns: NETCONF_NS },
   *     x('target', x('running')),
   *     x('config', config)),
   * );
   * ```
   * @throws a YANG data error when the JSON doesn't match the schema, SchemaUnavailableError
   *   with `requireSchema` when there is none, or TypeError when it isn't a JSON object.
   */
  toXml(json: YangJsonObject, options: ToXmlOptions = {}): Promise<XmlElement[]> {
    return this.#init.ctx.toXml(json, options);
  }

  /**
   * How two configuration datastores differ: the changes that turn `source`
   * into `target`, or an empty array when they hold the same configuration.
   * Both are read with `<get-config>` (pipelined, with the same `filter`) and
   * compared here with the server's YANG schema, so it works on any server
   * that has both datastores, with no RFC 9144 `<compare>` support needed.
   *
   * ```ts
   * const changes = await client.content.compareDatastores({
   *   source: 'running',
   *   target: 'startup',
   * });
   * for (const c of changes) {
   *   console.log(c.operation, c.path, c.previous, '→', c.value);
   * }
   * // replace /ietf-interfaces:interfaces/interface[name='eth0']/mtu 1500 → 9000
   * ```
   * List entries are matched by their keys and leaf-list entries by value,
   * so one inserted entry is one `create`. Unlike `ops.compare.datastores()`
   * (the server's own comparison, as a YANG Patch), the changes are RFC 7951
   * JSON with data paths, the same on every server.
   * @throws CapabilityError (by the client's capability policy) for
   *   `candidate` without `:candidate` or `startup` without `:startup`;
   *   SchemaUnavailableError when the data can't be typed with the server's
   *   YANG schema, or a YANG data error when it doesn't match it. There is no
   *   schema-less comparison: without keys, list entries could only be
   *   matched by position.
   */
  async compareDatastores(options: CompareDatastoresOptions): Promise<DatastoreChange[]> {
    const { source, target, filter, json, ...rpc } = options;
    for (const [name, ds] of [['source', source], ['target', target]] as const) {
      if (ds !== 'running' && ds !== 'candidate' && ds !== 'startup') {
        throw new TypeError(`compareDatastores: ${name} must be 'running', 'candidate' or 'startup'`);
      }
    }
    const read = (ds: ops.Datastore): Promise<XmlElement> =>
      this.#init.ops.getConfig({
        source: ds,
        ...(filter !== undefined ? { filter } : {}),
        ...(json !== undefined ? { json } : {}),
        ...splitRpcOptions(rpc).rpc,
      });
    const [from, to] = await Promise.all([read(source), read(target)]);
    return this.#init.diff(from, to, target);
  }

  /**
   * What has been changed in the candidate and not yet committed: exactly
   * `compareDatastores({ source: 'running', target: 'candidate', ...options })`.
   * Another session can change either datastore between the reads, or after
   * them; inside `withCandidate()`, `txn.getCandidateChanges()` reads them under
   * the transaction's locks.
   *
   * ```ts
   * await client.ops.editConfig({ target: 'candidate', config });
   * console.log(await client.content.getCandidateChanges());
   * ```
   */
  getCandidateChanges(options: CandidateChangesOptions = {}): Promise<DatastoreChange[]> {
    return this.compareDatastores({ ...options, source: 'running', target: 'candidate' });
  }

  /**
   * Make configuration changes in one `<edit-config>`, applied with the
   * device's workflow: lock, edit, validate, commit, unlock. A candidate
   * workflow with commit runs through `withCandidate()`:
   * it locks running and the candidate, discards on failure, always unlocks,
   * and rejects with a TransactionError (LockDeniedError for a held lock).
   *
   * ```ts
   * const IFS = '/ietf-interfaces:interfaces';
   * await client.content.configure((txn) => {
   *   txn.set(`${IFS}/interface[name="eth0"]/description`, 'uplink');
   *   txn.remove(`${IFS}/interface[name="eth9"]`);
   * });
   * ```
   * `txn.merge(json)` and `txn.replace(json)` add whole RFC 7951 JSON subtrees,
   * converted with the edit target's YANG schema before anything is locked
   * or sent (`json` options apply). A top-level node can't be edited by both
   * a path and JSON.
   * Options override the profile's workflow, which overrides the defaults
   * (candidate if supported, with lock, validate and commit).
   */
  configure(build: (txn: ConfigTransaction) => unknown, options: ConfigureOptions & { readonly confirmed: true | ConfirmedCommitOptions }): Promise<PendingCommit | undefined>;
  configure(build: (txn: ConfigTransaction) => unknown, options?: ConfigureOptions): Promise<void>;
  async configure(build: (txn: ConfigTransaction) => unknown, options: ConfigureOptions = {}): Promise<PendingCommit | undefined | void> {
    if (options.onStep !== undefined && typeof options.onStep !== 'function') throw new TypeError('configure: onStep must be a function');
    const txn = new ConfigTransaction((p) => this.#modules.resolve(p, 'error'));
    await build(txn);
    if (txn.size === 0) return undefined;
    const { session, profile, capabilityCheck } = this.#init;
    const caps = session.serverCapabilities;
    const flow = resolveWorkflow(options, profile?.workflow, (c) => caps.has(c));
    // `confirmed: false` (from untyped callers) means no confirmed commit.
    const confirmed = (options.confirmed as unknown) === false ? undefined : options.confirmed;
    // A confirmed commit needs the candidate workflow with commit: refuse anything else before sending.
    if (confirmed !== undefined && (flow.editTarget !== 'candidate' || !flow.commit)) {
      if (!caps.has(':candidate')) throw new CapabilityError(':candidate', 'configure with confirmed');
      throw new TypeError(
        `configure: a confirmed commit needs the candidate workflow with commit, but this one ${flow.editTarget === 'running' ? 'edits running' : 'has commit turned off'}`,
      );
    }
    const rpc = splitRpcOptions(options).rpc;
    await this.#modules.ensure(txn.paths, rpc);
    checkTargetSchema(this.#init, this.#modules, txn.paths, flow.editTarget);
    const config = await editContent(this.#init.ctx, txn, flow.editTarget, options.json);
    // Candidate with commit: the transaction module's lock, discard, edit, validate, commit, unlock.
    if (flow.editTarget === 'candidate' && flow.commit) {
      const txOptions = {
        ...rpc,
        ...(options.onStep !== undefined ? { onStep: options.onStep } : {}),
        lock: flow.lock,
        validate: flow.validate,
        capabilityCheck,
      };
      if (confirmed !== undefined) {
        const { pending } = await withCandidate(session, (txn) => txn.editConfig({ config }), { ...txOptions, confirmed });
        return pending;
      }
      await withCandidate(session, (txn) => txn.editConfig({ config }), txOptions);
      return undefined;
    }

    // Running (or candidate without commit): edit in place.
    await applyInPlace(this.#init, flow, config, rpc, options.onStep);
    return undefined;
  }

  /**
   * Check a configure() callback's changes without applying them: rejects with
   * the PathError configure() would give (a malformed path, an unknown module
   * or `@name`, two changes to the same node, a value given to remove). Sends
   * no edit and takes no lock; like configure(), it may read the YANG library
   * once to resolve a module only the library lists.
   */
  async checkEdits(build: (txn: ConfigTransaction) => unknown, options: RpcOptions & Pick<ConfigureOptions, 'editTarget' | 'json'> = {}): Promise<void> {
    const txn = new ConfigTransaction((p) => this.#modules.resolve(p, 'error'));
    await build(txn);
    if (txn.size === 0) return;
    await this.#modules.ensure(txn.paths, splitRpcOptions(options).rpc);
    const caps = this.#init.session.serverCapabilities;
    const flow = resolveWorkflow(options, this.#init.profile?.workflow, (c) => caps.has(c));
    checkTargetSchema(this.#init, this.#modules, txn.paths, flow.editTarget);
    await editContent(this.#init.ctx, txn, flow.editTarget, options.json);
  }

  /** Set one value: `configure((txn) => txn.set(path, value), options)`. With `confirmed`, resolves with the PendingCommit. */
  set(path: string, value: Parameters<ConfigTransaction['set']>[1], options: ConfigureOptions & { readonly confirmed: true | ConfirmedCommitOptions }): Promise<PendingCommit | undefined>;
  set(path: string, value: Parameters<ConfigTransaction['set']>[1], options?: ConfigureOptions): Promise<void>;
  async set(path: string, value: Parameters<ConfigTransaction['set']>[1], options: ConfigureOptions = {}): Promise<PendingCommit | undefined | void> {
    return this.configure((txn) => txn.set(path, value), options as ConfigureOptions & { readonly confirmed: true });
  }

  /** Delete one node if it exists: `configure((txn) => txn.remove(path), options)`. With `confirmed`, resolves with the PendingCommit. */
  remove(path: string, options: ConfigureOptions & { readonly confirmed: true | ConfirmedCommitOptions }): Promise<PendingCommit | undefined>;
  remove(path: string, options?: ConfigureOptions): Promise<void>;
  async remove(path: string, options: ConfigureOptions = {}): Promise<PendingCommit | undefined | void> {
    return this.configure((txn) => txn.remove(path), options as ConfigureOptions & { readonly confirmed: true });
  }

  /**
   * Resolve a path or `@alias` against the module namespaces (see
   * moduleNamespace()). Sends nothing.
   * A named path's parameters are filled in as for a read (see expandPath()).
   * @throws PathError for a malformed path or an unknown module.
   */
  resolvePath(path: string): ResolvedStep[] {
    return this.#modules.resolve(path, 'drop');
  }

  /**
   * The YANG path a named path stands for, with its parameters filled in; any
   * other path as given. As for a read, a parameter that is a whole predicate
   * value may be left out, dropping its predicate; `set()`, `remove()` and
   * `configure()` need every parameter. Sends nothing.
   *
   * ```ts
   * // "ifDescription":
   * //   "/ietf-interfaces:interfaces/interface[name={{ifName}}]/description"
   * client.content.expandPath('@ifDescription(eth0)');
   * // '/ietf-interfaces:interfaces/interface[name="eth0"]/description'
   * client.content.expandPath('@ifDescription');
   * // '/ietf-interfaces:interfaces/interface/description'
   * ```
   * @throws PathError for an unknown name, or parameters that don't fit.
   */
  expandPath(path: string): string {
    return this.#modules.expand(path, 'drop');
  }

  /** The named path's template, compiled once. */
  namedPathTemplate(name: string): NamedPathTemplate | undefined {
    return this.#modules.namedPathTemplate(name);
  }

  /**
   * A module's namespace: from `connect({ namespaces })`, then the device
   * profile's `namespaces`, then the server's hello, then its YANG library if
   * the session has read it. Sends nothing; see loadModules().
   *
   * A namespace belongs to its module, so one lookup serves every datastore:
   * the library's modules come from every datastore's schema. Whether a
   * datastore has the module is a separate question, which
   * `modules({ datastore })` answers.
   */
  moduleNamespace(module: string): string | undefined {
    return this.#modules.namespaceOf(module);
  }

  /**
   * The module a namespace belongs to, by the same lookup as
   * moduleNamespace(), or `undefined` if no source knows it. Sends nothing.
   * Pass it to decoders used on their own, such as
   * `decodeBaseNotification(n, { moduleOf: (ns) => client.content.moduleOf(ns) })`,
   * so the identities and paths they return name the session's modules.
   */
  moduleOf(namespace: string): string | undefined {
    return this.#modules.moduleOf(namespace);
  }

  /**
   * Every module the session knows, name → namespace, each with the
   * namespace `moduleNamespace()` gives. Modules from `connect({ namespaces
   * })`, the device profile and the hello come first, then the ones only the
   * YANG library lists, once the session has read it. Sends nothing; see
   * loadModules().
   *
   * It isn't a list of one datastore's modules: the library's entries come
   * from every datastore's schema and module set, and the other sources have
   * no datastore. For the modules a datastore has, use
   * `modules({ datastore })`.
   *
   * With `source`, that source's whole list instead, as with
   * `moduleNamespacesInfo()`: every module it names with the namespace it
   * gives, whether or not an earlier source beats it.
   *
   * ```ts
   * client.content.moduleNamespaces().get('ietf-interfaces');
   * // 'urn:ietf:params:xml:ns:yang:ietf-interfaces'
   * client.content.moduleNamespaces({ source: 'hello' });
   * ```
   */
  moduleNamespaces(options: { readonly source?: NamespaceSource } = {}): ReadonlyMap<string, string> {
    return this.#modules.namespaces(options.source);
  }

  /**
   * `moduleNamespaces()`, with where each namespace came from, and the
   * namespaces later sources gave that it overrode: what a device profile
   * corrected in the hello, say. Sends nothing. Like `moduleNamespaces()`,
   * it spans every datastore; `modules({ datastore })` lists one.
   *
   * With `source`, that source's whole list instead, in its own order: every
   * module it names with the namespace it gives, whether or not an earlier
   * source beats it. `overrides` then lists only disagreements within the
   * source (two YANG library module sets, say). `library` is empty until the
   * session has read the library; see loadModules().
   *
   * ```ts
   * client.content.moduleNamespacesInfo().get('acme-system');
   * // { namespace: 'urn:acme:system', source: 'profile',
   * //   overrides: [{ source: 'hello', namespace: 'urn:acme:sys' }] }
   * client.content.moduleNamespacesInfo({ source: 'hello' }).get('acme-system');
   * // { namespace: 'urn:acme:sys', source: 'hello' }
   * ```
   */
  moduleNamespacesInfo(options: { readonly source?: NamespaceSource } = {}): ReadonlyMap<string, ModuleNamespaceInfo> {
    return this.#modules.namespacesInfo(options.source);
  }

  /**
   * Learn module namespaces from the server's YANG library (RFC 8525
   * `/yang-library`, or RFC 7895 `/modules-state` on a `:yang-library:1.0`
   * server), so paths can use modules the hello doesn't list (every YANG 1.1
   * module). The session reads its library once, shared with the yangLibrary
   * extension; later calls send nothing unless `refresh` is set, and a failed
   * read is tried again next time. Resolves with `moduleNamespaces()`: every
   * module the session knows, the library's added, from every datastore's
   * schema. On a server that
   * advertises no YANG library it sends nothing.
   *
   * `read()`, `configure()`, `set()` and `remove()` call this by themselves
   * when a path names an unknown module; `toXPath()` and `resolvePath()` are
   * synchronous, so call it first for those.
   */
  async loadModules(options: RpcOptions & { readonly refresh?: boolean } = {}): Promise<ReadonlyMap<string, string>> {
    return this.#modules.load(options);
  }

  /**
   * The datastores the server has, from one source, never merged:
   *
   * - `source: 'yang-library'`: on a server with `:yang-library:1.1` (NMDA,
   *   RFC 8525), its `/yang-library/datastore` list, in library order, with
   *   each datastore's schema. The library is the server's complete list.
   * - `source: 'capabilities'`: on any other server (no YANG library, or only
   *   `:yang-library:1.0`, whose RFC 7895 list has no datastores), and on one
   *   whose library lists none: `running`, then `candidate` with
   *   `:candidate`, then `startup` with `:startup` (RFC 6241). Nothing is
   *   sent.
   *
   * Capabilities are the ones after the device profile's corrections. The
   * library read is the session's shared one (as `loadModules()`); later
   * calls send nothing unless `refresh` is set, and a failed read rejects.
   *
   * ```ts
   * const { source, datastores } = await client.content.datastores();
   * datastores.some((d) => d.name === 'ietf-datastores:candidate');
   * ```
   */
  async datastores(options: RpcOptions & { readonly refresh?: boolean } = {}): Promise<ServerDatastores> {
    return this.#modules.datastores(options);
  }

  /**
   * The YANG modules the server has for one datastore (default `running`) or
   * one YANG library schema, with the features it supports. From one source,
   * never merged:
   *
   * - `source: 'yang-library'`: on a server with `:yang-library:1.1` or
   *   `:yang-library:1.0`, its library. With datastores listed, the
   *   datastore's schema (or the schema named); a datastore or schema it
   *   doesn't list is rejected. Without (RFC 7895, or a 1.1 library that lists
   *   none), every module set is one schema serving every datastore.
   * - `source: 'capabilities'`: on any other server, and on one whose library
   *   lists no modules, the module capabilities in the hello, after the
   *   device profile's corrections. Nothing is sent.
   *
   * Implemented modules come first, then import-only ones. `module` keeps one
   * module by name. `declared: true` reads and compiles each implemented
   * module's source (the client's YANG sources: given directories, the
   * profile, the bundled IETF modules, `<get-schema>`) and adds every feature
   * it declares, with whether the server supports it.
   *
   * ```ts
   * const { modules } = await client.content.modules({ module: 'ietf-netconf' });
   * modules[0]?.features.includes('candidate');
   * ```
   * @throws TypeError when both `datastore` and `schema` are given; SchemaUnavailableError for a datastore or schema the server doesn't list.
   */
  async modules(options: ModulesOptions = {}): Promise<ServerModules> {
    return this.#modules.modules(options);
  }

  /**
   * The XPath for a YANG path or `@alias`: an instance-identifier with module
   * names as prefixes and their namespaces, ready for anything that takes an
   * XPath, such as an XPath filter or an RFC 5717 partial-lock select.
   *
   * ```ts
   * client.content.toXPath('/ietf-interfaces:interfaces/interface[name="eth0"]');
   * // xpath(
   * //   "/ietf-interfaces:interfaces/ietf-interfaces:interface"
   * //     + "[ietf-interfaces:name='eth0']",
   * //   { 'ietf-interfaces': 'urn:ietf:params:xml:ns:yang:ietf-interfaces' },
   * // )
   * ```
   * @throws PathError for a malformed path or an unknown module.
   */
  toXPath(path: string): ops.XPathFilter {
    return pathXPath(this.resolvePath(path));
  }

  /**
   * The subtreeFilter quirk: some servers can only return a whole datastore,
   * or accept a filter only down to certain levels.
   */
  #filterFor(steps: ResolvedStep[]): ops.Filter | undefined {
    const quirks = this.#init.profile?.quirks;
    const mode = quirks?.subtreeFilter ?? 'supported';
    if (mode === 'unsupported') return undefined;
    const sent = mode === 'containers' ? filterDepth(steps, quirks?.subtreeFilterDepth ?? 1) : steps;
    return { type: 'subtree', content: buildFilter([sent]) };
  }

}

/** Names on `client.content` an extension id must not take. */
export const CONTENT_MEMBERS: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(ClientContent.prototype));

/**
 * An operation's data path in @node-net/yang's form, for the JSON conversion:
 * module prefixes only where the module changes, keys in single quotes
 * (double where the value holds one).
 */
function operationPath(steps: readonly ResolvedStep[]): string {
  const quote = (v: string): string => (v.includes("'") ? `"${v}"` : `'${v}'`);
  let module = '';
  return steps
    .map((step) => {
      const name = step.moduleName === module ? step.name : `${step.moduleName}:${step.name}`;
      module = step.moduleName;
      const keys = step.keys.map((k) => `[${k.name}=${quote(k.value)}]`).join('');
      const value = step.value === undefined ? '' : `[.=${quote(step.value)}]`;
      return `/${name}${keys}${value}`;
    })
    .join('');
}
