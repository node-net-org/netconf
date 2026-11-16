/**
 * The RFC 6241 base operations (§7), the first module of the operations layer
 * (design §8).
 *
 * Each builder returns the operation element plus the capabilities it needs.
 * invoke() checks those against the session's capabilities and sends the
 * request through RpcContext, the same seam every extension uses.
 * NetconfClient exposes these as methods (client.ops.editConfig(), ...).
 */

import { CapabilityError } from '../errors.js';
import { NETCONF_NS, YANG_NS, type RpcContext, type RpcOptions, type RpcReply } from '../messages/index.js';
import { x, XmlElement, type Child, type XmlNode } from '../xml/index.js';
import { isJsonFilter, isJsonInput, JSON_NEEDS_CLIENT, type YangJsonObject } from './json.js';

/**
 * Whether an operation is checked against the server's capabilities before
 * it is sent, given as `connect({ capabilityCheck })`:
 *
 * - `'strict'` (default): throw CapabilityError before sending an operation the server didn't advertise support for.
 * - `'warn'`: log a warning and send it anyway, for servers that under-advertise.
 * - `'off'`: don't check.
 */
export type CapabilityCheck = 'strict' | 'warn' | 'off';

/** Check a request's required capabilities, then send it. */
export async function invoke(
  ctx: RpcContext,
  req: OperationRequest,
  options: RpcOptions = {},
  check: CapabilityCheck = 'strict',
): Promise<RpcReply> {
  const name = req.element.name;
  for (const cap of req.requires) {
    if (ctx.serverCapabilities.has(cap) || check === 'off') continue;
    if (check === 'strict') throw new CapabilityError(cap, name);
    ctx.logger.warn?.(`${name} needs ${cap}, which the server didn't advertise; sending anyway`);
  }
  return ctx.rpc(req.element, options);
}

/** The RFC 6241 configuration datastores. */
export type Datastore = 'running' | 'candidate' | 'startup';

/** Where configuration comes from: a datastore, a URL (`:url`), or inline content (XML, or an RFC 7951 JSON object a client converts). */
export type ConfigSource =
  | Datastore
  | {
      /** A URL to load the configuration from (`:url`). */
      readonly url: string;
    }
  | {
      /** Inline configuration: XML, or an RFC 7951 JSON object. */
      readonly config: Child | YangJsonObject;
    };
/** Where configuration goes: a datastore or a URL (`:url`). */
export type ConfigTarget =
  | Datastore
  | {
      /** A URL to write the configuration to (`:url`). */
      readonly url: string;
    };

/** An XPath expression with the namespaces of its prefixes. */
export interface XPathFilter {
  /** Marks an XPath filter. */
  readonly type: 'xpath';
  /** The XPath expression, sent as the filter's `select` attribute. */
  readonly select: string;
  /** Prefix → namespace URI for every prefix used in `select`. */
  readonly namespaces: Readonly<Record<string, string>>;
}

/**
 * A `<get>` or `<get-config>` filter: a subtree filter, built with
 * {@link subtree}, or an XPath filter, built with {@link xpath}.
 * See [Filter selection](/guide/operations#filter-selection).
 */
export type Filter =
  | {
      /** Marks a subtree filter. */
      readonly type: 'subtree';
      /** The elements to select, each with its namespace. */
      readonly content: readonly XmlNode[];
    }
  | XPathFilter;

/** A subtree filter (RFC 6241 §6). Pass the elements to select, each with its namespace. */
export function subtree(...content: Child[]): Filter {
  return { type: 'subtree', content: x('filter', content).children };
}

/**
 * An XPath filter (RFC 6241 §8.9, needs `:xpath`).
 * @param namespaces Prefix → namespace URI for every prefix used in `select`.
 */
export function xpath(select: string, namespaces: Readonly<Record<string, string>> = {}): XPathFilter {
  return { type: 'xpath', select, namespaces };
}

/** An operation ready to send: its RPC element and the capabilities it needs. Built, not yet sent. */
export interface OperationRequest {
  /** The operation element that goes inside `<rpc>`. */
  readonly element: XmlElement;
  /** Capabilities the server must advertise, as short names like `':candidate'`. */
  readonly requires: readonly string[];
}

/** Options for `<get>`. */
export interface GetOptions {
  /**
   * A subtree filter (`subtree(...)`), an XPath filter (`xpath(...)`, needs
   * `:xpath`), or an RFC 7951 JSON object, which the client converts to a
   * subtree filter: an object is a containment node, `{}` or `null` selects
   * a whole node, and a leaf with a value is a content match.
   */
  readonly filter?: Filter | YangJsonObject;
}

/** Options for `<get-config>`. */
export interface GetConfigOptions {
  /** Default `'running'`. */
  readonly source?: Datastore;
  /** As for `get`: a subtree or XPath filter, or an RFC 7951 JSON object. */
  readonly filter?: Filter | YangJsonObject;
}

/**
 * A NETCONF edit operation: the values of the `operation` attribute
 * (RFC 6241 §7.2) that marks a node in `<edit-config>` content. RFC 6470's
 * `netconf-config-change` events report edits with the same values.
 */
export type EditOperation = 'merge' | 'replace' | 'create' | 'delete' | 'remove';

/** Options for `<edit-config>`. See [Write operations](/guide/operations#write-operations). */
export interface EditConfigOptions {
  /** The datastore to edit: `'running'` needs `:writable-running`, `'candidate'` needs `:candidate`. */
  readonly target: 'running' | 'candidate';
  /**
   * Configuration content, placed inside `<config>`: XML, or an RFC 7951
   * JSON object, which the client converts with the target's YANG schema
   * (RFC 7952 metadata `ietf-netconf:operation` and `yang:insert` become the
   * edit attributes). Give exactly one of `config` and `url`.
   */
  readonly config?: Child | YangJsonObject;
  /** Load the configuration from a URL (`:url`). */
  readonly url?: string;
  /**
   * The operation for content with no `operation` attribute of its own.
   * Server default `'merge'`; `'none'` changes only what is marked.
   */
  readonly defaultOperation?: 'merge' | 'replace' | 'none';
  /** `'test-only'` needs `:validate:1.1`; the others need `:validate`. */
  readonly testOption?: 'test-then-set' | 'set' | 'test-only';
  /** `'rollback-on-error'` needs `:rollback-on-error`. */
  readonly errorOption?: 'stop-on-error' | 'continue-on-error' | 'rollback-on-error';
}

/**
 * Options for `<copy-config>`.
 * See [Copying and deleting datastores](/guide/operations#copying-and-deleting-datastores).
 */
export interface CopyConfigOptions {
  /** What to copy: a datastore, a URL, or inline configuration. */
  readonly source: ConfigSource;
  /** Where to copy it: a datastore or a URL. Its whole configuration is replaced. */
  readonly target: ConfigTarget;
}

/**
 * Options for `<commit>` (RFC 6241 §8.3.4.1 and §8.4.5.1). `confirmTimeout`
 * and `persist` belong to a confirmed commit, so either without
 * `confirmed: true` throws a `TypeError` before anything is sent.
 * `persistId` alone is the confirming commit for a persistent confirmed
 * commit; with `confirmed: true` it extends one.
 */
export interface CommitOptions {
  /** Confirmed commit (`:confirmed-commit`): reverts unless confirmed within `confirmTimeout`. */
  readonly confirmed?: boolean;
  /**
   * Seconds before an unconfirmed commit reverts, from 1 to 4294967295.
   * Needs `confirmed: true`. Server default is 600.
   */
  readonly confirmTimeout?: number;
  /**
   * Make the confirmed commit survive this session ending
   * (`:confirmed-commit:1.1`). Needs `confirmed: true`.
   */
  readonly persist?: string;
  /** Confirm or extend a persistent confirmed commit started by another session (`:confirmed-commit:1.1`). */
  readonly persistId?: string;
}

export function get(options: GetOptions = {}): OperationRequest {
  return {
    element: op('get', filterElement(options.filter)),
    requires: filterRequires(options.filter),
  };
}

export function getConfig(options: GetConfigOptions = {}): OperationRequest {
  const source = options.source ?? 'running';
  return {
    element: op('get-config', x('source', x(source)), filterElement(options.filter)),
    requires: [...datastoreRequires(source), ...filterRequires(options.filter)],
  };
}

export function editConfig(options: EditConfigOptions): OperationRequest {
  const hasConfig = options.config !== undefined;
  const hasUrl = options.url !== undefined;
  if (hasConfig === hasUrl) throw new TypeError('editConfig needs exactly one of `config` and `url`');

  const requires = [options.target === 'running' ? ':writable-running' : ':candidate'];
  if (hasUrl) requires.push(':url');
  if (options.testOption === 'test-only') requires.push(':validate:1.1');
  else if (options.testOption !== undefined) requires.push(':validate');
  if (options.errorOption === 'rollback-on-error') requires.push(':rollback-on-error');

  return {
    element: op('edit-config',
      x('target', x(options.target)),
      options.defaultOperation !== undefined && x('default-operation', options.defaultOperation),
      options.testOption !== undefined && x('test-option', options.testOption),
      options.errorOption !== undefined && x('error-option', options.errorOption),
      hasUrl ? x('url', options.url) : x('config', xmlOnly(options.config)),
    ),
    requires,
  };
}

export function copyConfig(options: CopyConfigOptions): OperationRequest {
  const requires = [...sourceRequires(options.source), ...targetRequires(options.target)];
  return {
    element: op('copy-config', x('target', targetElement(options.target)), x('source', sourceElement(options.source))),
    requires: dedupe(requires),
  };
}

export function deleteConfig(target: 'startup' | { readonly url: string }): OperationRequest {
  return { element: op('delete-config', x('target', targetElement(target))), requires: targetRequires(target) };
}

export function lock(target: Datastore): OperationRequest {
  return { element: op('lock', x('target', x(target))), requires: datastoreRequires(target) };
}

export function unlock(target: Datastore): OperationRequest {
  return { element: op('unlock', x('target', x(target))), requires: datastoreRequires(target) };
}

export function commit(options: CommitOptions = {}): OperationRequest {
  if (options.confirmed !== true && (options.confirmTimeout !== undefined || options.persist !== undefined)) {
    throw new TypeError('commit: confirmTimeout and persist are only for a confirmed commit; pass confirmed: true');
  }
  const requires = [':candidate'];
  if (options.confirmed === true) requires.push(':confirmed-commit');
  if (options.persist !== undefined || options.persistId !== undefined) requires.push(':confirmed-commit:1.1');
  return {
    element: op('commit',
      options.confirmed === true && x('confirmed'),
      options.confirmTimeout !== undefined && x('confirm-timeout', positiveInt(options.confirmTimeout, 'confirmTimeout')),
      options.persist !== undefined && x('persist', options.persist),
      options.persistId !== undefined && x('persist-id', options.persistId),
    ),
    requires,
  };
}

export function cancelCommit(options: { readonly persistId?: string } = {}): OperationRequest {
  return {
    element: op('cancel-commit', options.persistId !== undefined && x('persist-id', options.persistId)),
    requires: [':confirmed-commit:1.1'],
  };
}

export function discardChanges(): OperationRequest {
  return { element: op('discard-changes'), requires: [':candidate'] };
}

export function validate(source: ConfigSource): OperationRequest {
  return {
    element: op('validate', x('source', sourceElement(source))),
    requires: dedupe([':validate', ...sourceRequires(source)]),
  };
}

export function killSession(sessionId: number): OperationRequest {
  return { element: op('kill-session', x('session-id', positiveInt(sessionId, 'sessionId'))), requires: [] };
}

export function closeSession(): OperationRequest {
  return { element: op('close-session'), requires: [] };
}

export { YANG_NS } from '../messages/index.js';

/**
 * Build a YANG 1.1 `<action>` (RFC 7950 §7.15.2). `target` is the data-node
 * tree from the top-level node down to the action element, with list keys
 * and the action's input inside it. JSON is converted by a client before
 * this is called.
 * @throws TypeError when `target` isn't one XML element.
 */
export function action(target: XmlElement | YangJsonObject): OperationRequest {
  if (isJsonInput(target)) throw new TypeError(JSON_NEEDS_CLIENT);
  if (!(target instanceof XmlElement)) {
    throw new TypeError('action: target must be one XML element (the data-node tree down to the action) or an RFC 7951 JSON object');
  }
  return { element: x('action', { xmlns: YANG_NS }, target), requires: [] };
}

// --- helpers ---------------------------------------------------------------

/** Content that must be XML by now: JSON is converted before a request is built. */
export function xmlOnly(content: Child | YangJsonObject | undefined): Child {
  if (isJsonInput(content)) throw new TypeError(JSON_NEEDS_CLIENT);
  return content;
}

function op(name: string, ...children: Child[]): XmlElement {
  return x(name, { xmlns: NETCONF_NS }, ...children);
}

function filterElement(filter: Filter | YangJsonObject | undefined): XmlElement | undefined {
  if (filter === undefined) return undefined;
  if (isJsonFilter(filter)) throw new TypeError(JSON_NEEDS_CLIENT);
  if (filter.type === 'subtree') return x('filter', { type: 'subtree' }, filter.content);
  const declarations: Record<string, string> = {};
  for (const [prefix, uri] of Object.entries(filter.namespaces)) declarations[`xmlns:${prefix}`] = uri;
  return x('filter', { type: 'xpath', select: filter.select, ...declarations });
}

function filterRequires(filter: Filter | YangJsonObject | undefined): string[] {
  return filter !== undefined && filter['type'] === 'xpath' ? [':xpath'] : [];
}

function datastoreRequires(ds: Datastore): string[] {
  if (ds === 'candidate') return [':candidate'];
  if (ds === 'startup') return [':startup'];
  return [];
}

function sourceElement(source: ConfigSource): XmlElement {
  if (typeof source === 'string') return x(source);
  if ('url' in source) return x('url', source.url);
  return x('config', xmlOnly(source.config));
}

function targetElement(target: ConfigTarget): XmlElement {
  return typeof target === 'string' ? x(target) : x('url', target.url);
}

function sourceRequires(source: ConfigSource): string[] {
  if (typeof source === 'string') return datastoreRequires(source);
  return 'url' in source ? [':url'] : [];
}

function targetRequires(target: ConfigTarget): string[] {
  if (typeof target !== 'string') return [':url'];
  if (target === 'running') return [':writable-running'];
  return datastoreRequires(target);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function positiveInt(n: number, name: string): string {
  if (!Number.isInteger(n) || n < 1 || n > 4294967295) throw new RangeError(`${name} must be an integer from 1 to 4294967295`);
  return String(n);
}
