/**
 * `client.ops` (design §3.1, §6): the Operations layer of a NetconfClient.
 *
 * The RFC 6241 base operations, the catalogue of every operation the client
 * can run (`list`) and `run()` to run one from plain arguments, the device
 * profile's own operations (`device`), and each enabled extension's
 * operations under its id. Every call here sends an operation and hands back
 * XML, the reply, or a handle on what it started.
 */

import type { DeviceHandle } from './devices/index.js';
import { CapabilityError } from './errors.js';
import { NETCONF_NS, type RpcOptions, type RpcReply, type Session } from './messages/index.js';
import {
  applyAugments,
  type base as ops,
  BASE_REQUESTS,
  invoke,
  type CapabilityCheck,
  type Extension,
  type ExtensionContext,
  type OperationDescriptor,
  type OperationRequest,
  type RequestArgs,
  convertJsonArgs,
  isJsonInput,
  READ_AS_XML_HINT,
  splitFormat,
  type FormatOptions,
  type JsonDatastore,
  type JsonFormat,
  type JsonInputDatastores,
  type JsonOptions,
  type ToJson,
  type ToXml,
  type XmlFormat,
  type YangJsonObject,
} from './operations/index.js';
import { splitRpcOptions } from './operations/args.js';
import { callRequestBuilder } from './operations/extension.js';
import { XmlElement } from './xml/index.js';

/** `client.ops.device`: the operations the device profile defines, run against the connected device. */
export interface DeviceOps {
  /**
   * Run a device profile operation by name, with its parameters. Resolves
   * with what the operation returns (text, an element, an object or the reply).
   * @throws TypeError when no profile is in use or it has no such operation.
   */
  call(name: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/** @internal What ClientOps needs from the client that builds it. */
export interface ClientOpsInit {
  readonly session: Session;
  readonly capabilityCheck: CapabilityCheck;
  readonly extensions: readonly Extension[];
  readonly ctx: ExtensionContext;
  readonly device: DeviceHandle | undefined;
  readonly list: readonly OperationDescriptor[];
  /** Each extension's content section, by id: a read runs through it. */
  readonly content: Readonly<Record<string, object>>;
  /** Closes the client (for `run('close-session')`). */
  readonly close: () => Promise<void>;
  /** The client's RFC 7951 JSON conversion. */
  readonly toJson: ToJson;
  /** The client's RFC 7951 JSON input conversion. */
  readonly toXml: ToXml;
}

/** JSON input options on an operation that takes a JSON `config` (see `JsonOptions`). They are never sent. */
export interface JsonInput {
  /** How a JSON `config` is converted to XML. */
  readonly json?: JsonOptions;
}

/**
 * `client.ops`: the Operations layer. The RFC 6241 base operations as
 * methods, every operation the client can run as data (`list`, `run()`), the
 * device profile's operations (`device`), and each enabled extension's
 * operations under its id. Each call sends an operation and hands back XML,
 * the reply, or a handle on what it started; an `<rpc-error>` rejects with an
 * `RpcError`. See [Operations](/guide/operations).
 */
export class ClientOps {
  /**
   * Every operation this client can run, described as plain data: the base
   * operations (with options added by enabled extensions), then each enabled
   * extension's own operations and reads, then the device profile's
   * operations. Run one with {@link run}.
   */
  readonly list: readonly OperationDescriptor[];
  /** The device profile's own operations. Always present; without a profile, `call()` refuses every name. */
  readonly device: DeviceOps;
  readonly #init: ClientOpsInit;
  readonly #byName: ReadonlyMap<string, OperationDescriptor>;

  /** @internal Built by NetconfClient. */
  constructor(init: ClientOpsInit) {
    this.#init = init;
    this.list = init.list;
    this.#byName = new Map(init.list.map((d) => [d.name, d]));
    const device = init.device;
    this.device = Object.freeze({
      call: async (name: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> => {
        if (device === undefined) throw new TypeError(`No device profile operation ${JSON.stringify(name)}: no device profile is in use`);
        return device.call(name, params);
      },
    });
  }

  /**
   * `<get>`: running configuration and state data. Resolves with the `<data>`
   * element, or with `format: 'json'`, an RFC 7951 JSON object of the data,
   * typed by the server's YANG schema (on an NMDA server, the operational
   * datastore's). `format` and `json` are never sent.
   *
   * ```ts
   * const data = await client.ops.get({ filter, format: 'json' });
   * // { 'ietf-interfaces:interfaces':
   * //     { interface: [{ name: 'eth0', enabled: true, ... }] } }
   * ```
   * @throws SchemaUnavailableError or a YANG data error with `format: 'json'`
   *   and `json.requireSchema`, when the data can't be typed.
   */
  get(options: ops.GetOptions & RpcOptions & JsonFormat): Promise<YangJsonObject>;
  get(options?: ops.GetOptions & RpcOptions & XmlFormat): Promise<XmlElement>;
  get(options?: ops.GetOptions & RpcOptions & FormatOptions): Promise<XmlElement | YangJsonObject>;
  async get(options: ops.GetOptions & RpcOptions & FormatOptions = {}): Promise<XmlElement | YangJsonObject> {
    const { format, json, rest } = splitFormat(options);
    const reply = await this.#exec('get', rest, json);
    if (format === 'xml') return dataOf(reply);
    return this.#init.toJson(dataOf(reply), { ...json, datastore: 'operational', hint: READ_AS_XML_HINT });
  }

  /**
   * `<get-config>`: configuration from a datastore (default running).
   * Resolves with the `<data>` element, or with `format: 'json'`, an RFC 7951
   * JSON object of the data, typed by the server's YANG schema for that
   * datastore. `format` and `json` are never sent.
   * @throws SchemaUnavailableError or a YANG data error with `format: 'json'`
   *   and `json.requireSchema`, when the data can't be typed.
   */
  getConfig(options: ops.GetConfigOptions & RpcOptions & JsonFormat): Promise<YangJsonObject>;
  getConfig(options?: ops.GetConfigOptions & RpcOptions & XmlFormat): Promise<XmlElement>;
  getConfig(options?: ops.GetConfigOptions & RpcOptions & FormatOptions): Promise<XmlElement | YangJsonObject>;
  async getConfig(options: ops.GetConfigOptions & RpcOptions & FormatOptions = {}): Promise<XmlElement | YangJsonObject> {
    const { format, json, rest } = splitFormat(options);
    const reply = await this.#exec('get-config', rest, json);
    if (format === 'xml') return dataOf(reply);
    return this.#init.toJson(dataOf(reply), { ...json, datastore: rest.source ?? 'running', hint: READ_AS_XML_HINT });
  }

  /**
   * `<edit-config>`. `config` is XML, or an RFC 7951 JSON object, converted
   * with the YANG schema of the target datastore: RFC 7952 metadata
   * `ietf-netconf:operation` becomes the `operation` attribute, and
   * `yang:insert` with `yang:key` or `yang:value` positions an entry of an
   * ordered-by-user list. `json` options are never sent.
   *
   * ```ts
   * await client.ops.editConfig({
   *   target: 'candidate',
   *   config: {
   *     'ietf-interfaces:interfaces': {
   *       interface: [{ name: 'eth0', description: 'uplink' }],
   *     },
   *   },
   * });
   * ```
   * @throws a YANG data error when JSON `config` doesn't match the schema (every problem, with its path),
   *   or SchemaUnavailableError when there is no schema and `json.requireSchema` is set.
   */
  async editConfig(options: ops.EditConfigOptions & JsonInput & RpcOptions): Promise<RpcReply> {
    const { json, ...rest } = options;
    return this.#exec('edit-config', rest, json);
  }

  /** `<copy-config>`. Inline `source: { config }` may be an RFC 7951 JSON object, converted as for `editConfig`. */
  async copyConfig(options: ops.CopyConfigOptions & JsonInput & RpcOptions): Promise<RpcReply> {
    const { json, ...rest } = options;
    return this.#exec('copy-config', rest, json);
  }

  /** `<delete-config>`: delete the startup datastore or a URL (`:url`). `running` can't be deleted. */
  async deleteConfig(target: 'startup' | { readonly url: string }, options: RpcOptions = {}): Promise<RpcReply> {
    return this.#exec('delete-config', { ...options, target });
  }

  /**
   * `<lock>`: lock a whole datastore against changes by other sessions,
   * until {@link unlock} or this session ends.
   * See [Locking](/guide/operations#locking).
   */
  async lock(target: ops.Datastore, options: RpcOptions = {}): Promise<RpcReply> {
    return this.#exec('lock', { ...options, target });
  }

  /** `<unlock>`: release a lock this session holds on a datastore. */
  async unlock(target: ops.Datastore, options: RpcOptions = {}): Promise<RpcReply> {
    return this.#exec('unlock', { ...options, target });
  }

  /**
   * `<commit>`: make the candidate the running configuration (`:candidate`),
   * optionally as a confirmed commit that reverts unless confirmed.
   * See [Committing the candidate](/guide/operations#committing-the-candidate)
   * and [Confirmed commits](/guide/operations#confirmed-commits).
   */
  async commit(options: ops.CommitOptions & RpcOptions = {}): Promise<RpcReply> {
    return this.#exec('commit', options);
  }

  /**
   * `<cancel-commit>`: cancel a pending confirmed commit, reverting to the
   * configuration before it (`:confirmed-commit:1.1`). Give `persistId` to
   * cancel a persistent one from another session.
   */
  async cancelCommit(options: { readonly persistId?: string } & RpcOptions = {}): Promise<RpcReply> {
    return this.#exec('cancel-commit', options);
  }

  /** `<discard-changes>`: reset the candidate to the running configuration (`:candidate`). */
  async discardChanges(options: RpcOptions = {}): Promise<RpcReply> {
    return this.#exec('discard-changes', options);
  }

  /**
   * `<validate>`: check a configuration without applying it (`:validate`).
   * Inline `{ config }` may be an RFC 7951 JSON object, converted as for `editConfig`.
   * See [Validating](/guide/operations#validating).
   */
  async validate(source: ops.ConfigSource, options: JsonInput & RpcOptions = {}): Promise<RpcReply> {
    const { json, ...rest } = options;
    return this.#exec('validate', { ...rest, source }, json);
  }

  /**
   * `<action>`: invoke a YANG 1.1 action on a data node (RFC 7950 §7.15).
   * `target` is the data-node tree from the top-level node down to the
   * action element, with list keys and the action's input inside it. It may
   * be an RFC 7951 JSON object of that tree, converted with the server's
   * schema (the operational datastore's). Read the action's output from the
   * reply's `output`. To name the action by path and get typed output, use
   * `client.content.invoke()`.
   *
   * ```ts
   * const reply = await client.ops.action({
   *   'ex:servers': { server: [{ name: 'a', reset: { delay: 3 } }] },
   * });
   * // [<finished-at>…</finished-at>]
   * reply.output;
   * ```
   * @throws TypeError when `target` isn't an XML element or a JSON object.
   */
  async action(target: XmlElement | YangJsonObject, options: JsonInput & RpcOptions = {}): Promise<RpcReply> {
    if (!(target instanceof XmlElement) && !isJsonInput(target)) {
      throw new TypeError('action: target must be an XML element (the data-node tree down to the action) or an RFC 7951 JSON object');
    }
    const { json, ...rest } = options;
    return this.#exec('action', { ...rest, target }, json);
  }

  /** Force another session to close (RFC 6241 §7.9). */
  async killSession(sessionId: number, options: RpcOptions = {}): Promise<RpcReply> {
    return this.#exec('kill-session', { ...options, sessionId });
  }

  /**
   * Run any operation in {@link list} from plain arguments, keyed as in its
   * descriptor: `run('get-config', { source: 'running' })`. Options added by
   * enabled extensions apply, and capabilities are checked, just as for the
   * matching method. `close-session` closes the client and resolves with
   * undefined.
   *
   * Base and extension operations resolve with the `RpcReply`. An extension's
   * read (`kind: 'read'`) runs its content method,
   * `client.content.<id>.<method>({ ...args, ...options })`, and resolves with
   * the decoded result. A device profile operation runs exactly as
   * `device.call(name, args)` and resolves with what that returns (text, an
   * element, an object or the reply), so the result is typed `unknown`;
   * per-call `options` don't apply to it.
   * @throws TypeError for an unknown operation or argument.
   */
  async run(name: string, args: Readonly<Record<string, unknown>> = {}, options: RpcOptions = {}): Promise<unknown> {
    if (name === 'close-session') {
      await this.#init.close();
      return undefined;
    }
    const descriptor = this.#byName.get(name);
    if (descriptor?.device !== undefined) return this.device.call(name, args);
    if (descriptor?.kind === 'read') {
      checkArgs(descriptor, args);
      checkReadArgs(descriptor, args);
      const { session, capabilityCheck } = this.#init;
      for (const cap of descriptor.requires) {
        if (session.serverCapabilities.has(cap) || capabilityCheck === 'off') continue;
        if (capabilityCheck === 'strict') throw new CapabilityError(cap, name);
        session.logger.warn?.(`${name} needs ${cap}, which the server didn't advertise; reading anyway`);
      }
      const methods = this.#init.content[descriptor.extension!] as Record<string, (options: object) => Promise<unknown>>;
      return methods[descriptor.method]!({ ...args, ...options });
    }
    return this.#send(name, args, options);
  }

  /** Run a method's operation: split the RPC options from the operation's arguments. */
  #exec(name: string, options: object, json?: JsonOptions): Promise<RpcReply> {
    const { rpc, rest: args } = splitRpcOptions(options);
    return this.#send(name, json === undefined ? args : { ...args, json }, rpc);
  }

  /** Build an operation (base or extension), apply enabled augments, check capabilities and send it. */
  async #send(name: string, input: RequestArgs & { readonly json?: JsonOptions }, options: RpcOptions): Promise<RpcReply> {
    const descriptor = this.#byName.get(name);
    if (descriptor === undefined) throw new TypeError(`No operation named ${JSON.stringify(name)} on this client`);
    const { json, ...rest } = input;
    const given = checkArgs(descriptor, rest);
    const args = await convertJsonArgs(this.#init.toXml, given, inputDatastores(name, given), json);
    const { session, extensions, ctx, capabilityCheck } = this.#init;
    let req: OperationRequest;
    if (descriptor.extension === undefined) {
      req = applyAugments(name, callRequestBuilder(BASE_REQUESTS[name]!, args), args, extensions, ctx);
    } else {
      const ext = extensions.find((e) => e.id === descriptor.extension);
      req = callRequestBuilder(ext!.requests![name]!, args);
    }
    // The descriptor's own requirements too: an extension enabled without its capabilities must not send.
    const requires = [...new Set([...descriptor.requires, ...req.requires])];
    return invoke(session, { ...req, requires }, options, capabilityCheck);
  }
}

/** Names on `client.ops` an extension id must not take. */
export const OPS_MEMBERS: ReadonlySet<string> = new Set([...Object.getOwnPropertyNames(ClientOps.prototype), 'list', 'device']);

/** The datastores whose schemas type an operation's JSON input. */
function inputDatastores(name: string, args: Readonly<Record<string, unknown>>): JsonInputDatastores {
  const target = args['target'];
  const ds = args['datastore'] as JsonDatastore | undefined;
  switch (name) {
    case 'edit-config':
      return { config: typeof target === 'string' ? target : 'running' };
    case 'copy-config':
      return { config: typeof target === 'string' ? target : 'running' };
    case 'get-config':
      return { filter: typeof args['source'] === 'string' ? args['source'] : 'running' };
    case 'get':
      return { filter: 'operational' };
    case 'compare':
      return args['source'] === undefined ? {} : { filter: args['source'] as JsonDatastore };
    case 'action':
      return { target: 'operational' };
    case 'get-data':
    case 'edit-data':
      return ds === undefined ? {} : { config: ds, filter: ds };
    default:
      return {};
  }
}

function dataOf(reply: RpcReply): XmlElement {
  return reply.data ?? new XmlElement({ name: 'data', ns: NETCONF_NS });
}

/** Refuse arguments an operation doesn't describe, before anything is sent. Returns them, checked. */
function checkArgs(descriptor: OperationDescriptor, args: RequestArgs): RequestArgs {
  const known = new Set(descriptor.params.map((p) => p.name));
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || known.has(key)) continue;
    throw new TypeError(
      `${descriptor.name} has no option ${JSON.stringify(key)}. If an extension adds it, pass that extension in connect({ extensions })`,
    );
  }
  return args;
}

/**
 * A read has no request builder to check its arguments, so check them here:
 * required ones present, and boolean, number and string ones of that type.
 */
function checkReadArgs(descriptor: OperationDescriptor, args: Readonly<Record<string, unknown>>): void {
  for (const p of descriptor.params) {
    const value = args[p.name];
    if (value === undefined) {
      if (p.required === true) throw new TypeError(`${descriptor.name} needs ${p.name}`);
      continue;
    }
    const expected = p.type === 'boolean' || p.type === 'number' || p.type === 'string' ? p.type : undefined;
    const values = p.multiple === true && Array.isArray(value) ? value : [value];
    if (expected !== undefined && values.some((v) => typeof v !== expected)) {
      throw new TypeError(`${descriptor.name}: ${p.name} must be a ${expected}${p.multiple === true ? ' (or an array of them)' : ''}`);
    }
  }
}
