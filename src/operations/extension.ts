/**
 * Extensions (design §6, §8): the Extension shape, operation
 * descriptors, and augments.
 *
 * An extension is an optional, standard protocol feature (RFC 6243
 * with-defaults, later NMDA, notifications, ...) enabled per connection with
 * `connect({ extensions })`. It reaches the server only through the session's
 * RpcContext, the same seam the base operations use, so a third-party module
 * has exactly the access a built-in one has.
 *
 * An extension can contribute four things:
 * - `ops`: calls that send operations and hand back XML or a reply, reached
 *   as `client.ops.<id>.*` (Operations layer);
 * - `content`: calls that hand back decoded, typed data, reached as
 *   `client.content.<id>.*` (Content layer);
 * - `descriptors` + `requests`: its RPCs described as plain data, plus the
 *   builders that turn plain arguments into requests (for tools such as the CLI);
 * - `augments`: extra parameters on base operations, the way a YANG module
 *   augments another operation's RPC input (RFC 6243 adds `<with-defaults>` to
 *   `<get>`, `<get-config>` and `<copy-config>` this way).
 */

import type { Logger } from '../logger.js';
import type { CapabilitySet, RpcContext, RpcOptions, RpcReply } from '../messages/index.js';
import { invoke, type CapabilityCheck, type OperationRequest } from './base.js';
import type { ToJson, ToXml } from './json.js';
import type { ModuleOf } from './qualified.js';

// --- descriptors: plain data ------------------------------------------------------

/** How a tool should read an argument's value. */
export type OperationParamType =
  | 'string'
  | 'number'
  | 'boolean'
  /** XML content (an element, or XML text a tool parses first). */
  | 'xml'
  /** A filter: `subtree(...)` or `xpath(...)`. */
  | 'filter'
  /** An XPath expression with its namespaces: `xpath(expr, namespaces)` or `client.content.toXPath(path)`. */
  | 'xpath'
  /** A datastore name, from `values`. */
  | 'datastore'
  /** A datastore name, `{ url }` or `{ config }`. */
  | 'config-source'
  /** A datastore name or `{ url }`. */
  | 'config-target';

/** One argument of an operation. Plain data: safe to serialize to JSON. */
export interface ParamDescriptor {
  /** The option name in the library API (`confirmTimeout`). Tools derive their own spelling. */
  readonly name: string;
  /** Positional arguments come first, in descriptor order; options are named. */
  readonly kind: 'positional' | 'option';
  /** How to read the value: string, number, XML, filter, datastore name and so on. */
  readonly type: OperationParamType;
  /** A one-line description, for help text. */
  readonly description: string;
  /** The allowed values, when the set is fixed. */
  readonly values?: readonly string[];
  /** True when the argument must be given. */
  readonly required?: boolean;
  /** True when the argument can be given more than once; its value is then an array. */
  readonly multiple?: boolean;
  /** The value used when the argument is left out. */
  readonly default?: string | number | boolean;
  /** Capabilities needed whenever this argument is given. */
  readonly requires?: readonly string[];
  /** Capabilities needed only for particular values (`{ candidate: [':candidate'] }`). */
  readonly valueRequires?: Readonly<Record<string, readonly string[]>>;
  /** Set when an extension added this parameter to a base operation. */
  readonly extension?: string;
}

/**
 * One operation, described as plain data (no functions), so tools can build commands from it.
 *
 * Most operations are RPCs. An extension's `read` operation is a content
 * method that reads state (with a `<get>`, say) and decodes it, such as
 * monitoring's `sessions()`: it has no RPC element of its own, never changes
 * anything, and runs through the extension's content method, so
 * `client.ops.run()` resolves with the decoded result (plain data) instead of
 * an `RpcReply`.
 */
export interface OperationDescriptor {
  /**
   * The RPC element name, such as `get-config`; for a read, a name for what it
   * reads, such as `sessions`. Tools use it as the command name.
   */
  readonly name: string;
  /**
   * `'rpc'` (the default when absent): an RPC, built from the arguments and
   * sent. `'read'`: an extension method that reads and decodes state.
   */
  readonly kind?: 'rpc' | 'read';
  /**
   * Namespace of the RPC element, so a tool can recognise the operation in raw
   * XML; for a read, the namespace of the data it reads.
   */
  readonly namespace: string;
  /**
   * The method that runs it, relative to its layer: on `client.ops` for a base
   * operation (close-session's is the client's own `close()`), on `client.ops.<id>` for an extension's RPC, on
   * `client.content.<id>` for an extension's read (a read is always run
   * through it), and `call` (on `client.ops.device`) for a device profile operation.
   */
  readonly method: string;
  /** A one-line description, for help text. */
  readonly description: string;
  /** True if the operation can change server state (configuration, locks, sessions). */
  readonly mutates: boolean;
  /** Capabilities always needed. Arguments may add more (`ParamDescriptor.requires`). */
  readonly requires: readonly string[];
  /** The arguments: positional ones first, in order, then the named options. */
  readonly params: readonly ParamDescriptor[];
  /** The extension that provides it; absent for base operations. */
  readonly extension?: string;
  /** The device profile that provides it, by profile id; absent unless it is a profile operation. */
  readonly device?: string;
}

// --- extensions -----------------------------------------------------------------------

/**
 * What an extension's code can use: the session's RpcContext, plus the
 * client's capability-check policy and a helper that applies it.
 */
export interface ExtensionContext extends RpcContext {
  /** The client's `capabilityCheck` policy, which `invoke` applies to each request's required capabilities. */
  readonly capabilityCheck: CapabilityCheck;
  /**
   * The same object for every context on one session, and a different one for
   * each session: a WeakMap key for state that modules on a session share
   * (the YANG library read, for one). It gives no access to anything.
   */
  readonly sessionKey: object;
  /** Check a request's required capabilities under `capabilityCheck`, then send it. */
  invoke(request: OperationRequest, options?: RpcOptions): Promise<RpcReply>;
  /**
   * Convert YANG data in XML to RFC 7951 JSON with the client's YANG schemas,
   * as `format: 'json'` does on the client's own reads. An extension whose
   * operation returns datastore content offers `format: 'json'` through this.
   * Missing on a context not built by a client (it then rejects with a TypeError).
   */
  readonly toJson: ToJson;
  /**
   * Convert RFC 7951 JSON to XML (edit content, or with `filter`, subtree
   * filter content) with the client's YANG schemas, as JSON `config` and
   * `filter` are on the client's own operations. An extension whose
   * operation takes datastore content accepts JSON through this.
   * Missing on a context not built by a client (it then rejects with a TypeError).
   */
  readonly toXml: ToXml;
  /**
   * The module a namespace belongs to, as the session knows it (the
   * `namespaces` given to `connect()`, the device profile, the hello, the
   * YANG library once read), for module-qualified identities and paths in
   * what a reader returns. Missing on a context not built by a client: the
   * readers then fall back to well-known modules, then the namespace itself.
   */
  readonly moduleOf?: ModuleOf;
}

/**
 * Plain arguments for an operation, keyed as its descriptor's `params`. They
 * arrive untyped from tools, device profiles and `client.ops.run()`, so a
 * builder that takes them checks each value at run time.
 */
export type RequestArgs = Readonly<Record<string, unknown>>;

/**
 * Turns arguments (as described by a descriptor) into a request. `A` is the
 * arguments' type: {@link RequestArgs} by default, or your own, such as
 * `RequestBuilder<{ readonly name: string }>`.
 */
export type RequestBuilder<A extends object = RequestArgs> = (args: A) => OperationRequest;

/**
 * Call a builder from an extension's `requests` map, or the base operations',
 * with arguments already checked against its descriptor: the one place the
 * descriptor's checks stand in for the builder's parameter type.
 * @internal
 */
export function callRequestBuilder(build: RequestBuilder<never>, args: RequestArgs): OperationRequest {
  return (build as RequestBuilder)(args);
}

/**
 * Extra parameters an extension adds to a base operation, like a YANG
 * `augment` of an RPC's input.
 */
export interface Augment {
  /** The base operation's RPC name, such as `get-config`. */
  readonly operation: string;
  /** The parameters it adds, described as for the base operation's own. */
  readonly params: readonly ParamDescriptor[];
  /**
   * Add the parameters to a built request. Called only when at least one of
   * `params` was given. May throw (for example CapabilityError) before anything is sent.
   */
  apply(request: OperationRequest, args: RequestArgs, ctx: ExtensionContext): OperationRequest;
}

/**
 * An extension: an optional NETCONF feature enabled per connection with
 * `connect({ extensions: [...] })`. The library's own (such as `monitoring`
 * and `nmda`) are built with {@link defineExtension}, as yours can be.
 * See [Extensions](/guide/extensions) and
 * [Writing your own](/guide/extensions#writing-your-own).
 */
export interface Extension<Id extends string = string, Ops extends object = object, Content extends object = object> {
  /** Becomes `client.ops.<id>` and `client.content.<id>`, for the layers the extension contributes to. */
  readonly id: Id;
  /** A one-line summary of what the extension adds, for tools and help text. */
  readonly description?: string;
  /** Capabilities the server must advertise, checked after the hello under `capabilityCheck`. */
  readonly requires?: readonly string[];
  /** Capabilities added to our `<hello>`. */
  readonly clientCapabilities?: readonly string[];
  /**
   * Operations layer: called once per client, after the hello. The result
   * becomes `client.ops.<id>`: calls that send operations and hand back XML,
   * a reply, or a handle on what they started (a subscription, a lock).
   */
  ops?(ctx: ExtensionContext): Ops;
  /**
   * Content layer: called once per client, after the hello, with the same
   * context as `ops`. The result becomes `client.content.<id>`: calls that
   * hand back decoded, typed data. State shared with `ops` belongs in a
   * WeakMap keyed by `ctx.sessionKey`.
   */
  content?(ctx: ExtensionContext): Content;
  /**
   * Descriptors for the RPCs this extension adds (each needs a builder in
   * `requests`), and for its reads (`kind: 'read'`, run through the method of
   * `content` they name).
   */
  readonly descriptors?: readonly OperationDescriptor[];
  /**
   * Builders for the RPCs in `descriptors`, by RPC name. Each may type its
   * own arguments (`(args: { readonly name: string }) => …`): the client
   * calls it only with arguments whose names its descriptor lists, so give
   * the descriptor `required` and `type` to match, and check values a tool
   * could send wrongly.
   */
  readonly requests?: Readonly<Record<string, RequestBuilder<never>>>;
  /** Parameters this extension adds to base operations. */
  readonly augments?: readonly Augment[];
}

/**
 * Define an extension: the implementation of one or more NETCONF
 * capabilities. Keeps the id as a literal type and records which layers the
 * extension contributes to, so `client.ops.<id>` and `client.content.<id>`
 * are typed, and exist only where it has an `ops` or `content` section.
 */
export function defineExtension<const X extends Extension>(extension: X & { readonly [K in Exclude<keyof X, keyof Extension>]: never }): X {
  return extension;
}

/** The extensions' part of `client.ops`: each id with an `ops` section, mapped to what that section returns. */
export type OpsMap<E extends readonly Extension[]> = LayerMap<E, 'ops'>;

/** The extensions' part of `client.content`: each id with a `content` section, mapped to what that section returns. */
export type ContentMap<E extends readonly Extension[]> = LayerMap<E, 'content'>;

type LayerMap<E extends readonly Extension[], L extends 'ops' | 'content'> = [E[number]] extends [never]
  ? object
  : Simplify<UnionToIntersection<E[number] extends infer X ? (X extends Extension ? SectionOf<X, L> : never) : never>>;

/**
 * `{ readonly [id]: Section }` when the extension has that layer's section,
 * otherwise nothing. An extension typed only as `Extension` (its id unknown)
 * adds nothing, rather than an index signature that would type every name.
 */
type SectionOf<X extends Extension, L extends 'ops' | 'content'> = string extends X['id']
  ? object
  : L extends keyof X
  ? NonNullable<X[L]> extends (ctx: ExtensionContext) => infer S
    ? { readonly [K in X['id']]: S }
    : object
  : object;

type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void ? I : never;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

// --- helpers the client uses -------------------------------------------------------------

/**
 * Check a set of extensions for conflicts that don't depend on the server:
 * duplicate ids, an id that would hide a built-in member of a layer the
 * extension contributes to (`reserved`), two extensions adding the same
 * parameter to the same operation, or a descriptor without a builder.
 * @throws TypeError
 */
export function validateExtensions(
  extensions: readonly Extension[],
  baseParams: ReadonlyMap<string, ReadonlySet<string>>,
  reserved: { readonly ops: ReadonlySet<string>; readonly content: ReadonlySet<string> } = { ops: new Set(), content: new Set() },
): void {
  const ids = new Set<string>();
  const added = new Map<string, string>(); // "operation param" → extension id
  const described = new Map<string, string>(); // operation name → extension id
  for (const ext of extensions) {
    if (ids.has(ext.id)) throw new TypeError(`Two extensions have the id ${JSON.stringify(ext.id)}`);
    ids.add(ext.id);
    for (const layer of ['ops', 'content'] as const) {
      if (typeof ext[layer] === 'function' && reserved[layer].has(ext.id)) {
        throw new TypeError(`Extension id ${JSON.stringify(ext.id)} would hide client.${layer}.${ext.id}, which is built in`);
      }
    }
    for (const a of ext.augments ?? []) {
      const base = baseParams.get(a.operation);
      if (base === undefined) throw new TypeError(`Extension ${ext.id} augments ${a.operation}, which is not a base operation`);
      for (const p of a.params) {
        const key = `${a.operation} ${p.name}`;
        if (base.has(p.name)) throw new TypeError(`Extension ${ext.id} adds ${p.name} to ${a.operation}, which already has it`);
        const other = added.get(key);
        if (other !== undefined) throw new TypeError(`Extensions ${other} and ${ext.id} both add ${p.name} to ${a.operation}`);
        added.set(key, ext.id);
      }
    }
    for (const d of ext.descriptors ?? []) {
      if (baseParams.has(d.name)) throw new TypeError(`Extension ${ext.id} describes ${d.name}, which is a base operation`);
      const other = described.get(d.name);
      if (other !== undefined) throw new TypeError(`Extensions ${other} and ${ext.id} both describe ${d.name}`);
      described.set(d.name, ext.id);
      if (d.kind === 'read') {
        if (d.mutates) throw new TypeError(`Extension ${ext.id} describes ${d.name} as a read that mutates; a read never changes anything`);
        if (typeof ext.content !== 'function' || d.method === '') {
          throw new TypeError(`Extension ${ext.id} describes the read ${d.name} but has no content section to run it`);
        }
        // A read gets its arguments and the per-call options in one object, so their names can't overlap.
        const clash = d.params.find((p) => p.name === 'timeout' || p.name === 'signal');
        if (clash !== undefined) throw new TypeError(`Extension ${ext.id}: the read ${d.name} can't have a parameter named ${clash.name}, a per-call option`);
        continue;
      }
      if (typeof ext.requests?.[d.name] !== 'function') {
        throw new TypeError(`Extension ${ext.id} describes ${d.name} but has no request builder for it`);
      }
    }
  }
}

/**
 * Check each extension's required capabilities after the hello.
 * - `'strict'`: the first missing capability is returned as `{ extension, capability }`.
 * - `'warn'`: each is logged; returns undefined.
 * - `'off'`: no check.
 */
export function missingRequirement(
  extensions: readonly Extension[],
  capabilities: CapabilitySet,
  check: CapabilityCheck,
  logger: Logger,
): { extension: string; capability: string } | undefined {
  if (check === 'off') return undefined;
  for (const ext of extensions) {
    for (const cap of ext.requires ?? []) {
      if (capabilities.has(cap)) continue;
      if (check === 'strict') return { extension: ext.id, capability: cap };
      logger.warn?.(`Extension ${ext.id} needs ${cap}, which the server didn't advertise; enabling it anyway`);
    }
  }
  return undefined;
}

/** Apply every enabled augment of `operation` whose parameters were given. */
export function applyAugments(
  operation: string,
  request: OperationRequest,
  args: RequestArgs,
  extensions: readonly Extension[],
  ctx: ExtensionContext,
): OperationRequest {
  let req = request;
  for (const ext of extensions) {
    for (const a of ext.augments ?? []) {
      if (a.operation !== operation) continue;
      if (a.params.some((p) => args[p.name] !== undefined)) req = a.apply(req, args, ctx);
    }
  }
  return req;
}

const noJson: ToJson = () => Promise.reject(new TypeError('RFC 7951 JSON output needs a context built by a NetconfClient'));
const noXml: ToXml = () => Promise.reject(new TypeError('RFC 7951 JSON input needs a context built by a NetconfClient'));

const sessionKeys = new WeakMap<RpcContext, object>();

function sessionKeyOf(rpc: RpcContext): object {
  let key = sessionKeys.get(rpc);
  if (key === undefined) {
    key = Object.freeze({});
    sessionKeys.set(rpc, key);
  }
  return key;
}

/**
 * Build an ExtensionContext over an RpcContext. `requires` (an extension's own
 * required capabilities) is added to every request sent through `invoke`, so a
 * module enabled without its capabilities (`extensionCheck: 'off'`) still
 * refuses to send.
 */
export function extensionContext(
  rpc: RpcContext,
  capabilityCheck: CapabilityCheck,
  requires: readonly string[] = [],
  toJson: ToJson = noJson,
  toXml: ToXml = noXml,
  moduleOf?: ModuleOf,
): ExtensionContext {
  return {
    toJson,
    toXml,
    ...(moduleOf === undefined ? {} : { moduleOf }),
    sessionKey: sessionKeyOf(rpc),
    rpc: (operation, options) => rpc.rpc(operation, options),
    get serverCapabilities() {
      return rpc.serverCapabilities;
    },
    get sessionId() {
      return rpc.sessionId;
    },
    get logger() {
      return rpc.logger;
    },
    onNotification: (listener) => rpc.onNotification(listener),
    onClosed: (listener) => rpc.onClosed(listener),
    addRpcGuard: (guard) => rpc.addRpcGuard(guard),
    capabilityCheck,
    invoke: (request, options = {}) =>
      invoke(rpc, requires.length === 0 ? request : { ...request, requires: [...new Set([...requires, ...request.requires])] }, options, capabilityCheck),
  };
}
