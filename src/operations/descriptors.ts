/**
 * Descriptors for the RFC 6241 base operations (design §8, nnc's docs/cli.md §7).
 *
 * BASE_OPERATIONS is plain data: tools such as the CLI build commands, help,
 * completion and the read-only guard from it, with no code per operation.
 * buildOperation() turns a descriptor's arguments into the same request the
 * matching `client.ops` method sends. Each `method` names a `client.ops`
 * method, except close-session's: it is the client's own `close()`.
 */

import { NETCONF_NS } from '../messages/index.js';
import * as base from './base.js';
import type { XmlElement } from '../xml/index.js';
import { callRequestBuilder, type OperationDescriptor, type ParamDescriptor, type RequestArgs, type RequestBuilder } from './extension.js';

const DATASTORES = ['running', 'candidate', 'startup'] as const;
const DATASTORE_REQUIRES = { candidate: [':candidate'], startup: [':startup'] } as const;

const filter: ParamDescriptor = {
  name: 'filter',
  kind: 'option',
  type: 'filter',
  description: 'Select part of the data: a subtree filter (XML or RFC 7951 JSON), or an XPath filter (needs :xpath)',
};

function datastore(name: string, description: string, values: readonly string[] = DATASTORES): ParamDescriptor {
  return { name, kind: 'positional', type: 'datastore', description, values, required: true, valueRequires: DATASTORE_REQUIRES };
}

function op(d: Omit<OperationDescriptor, 'namespace'> & { readonly namespace?: string }): OperationDescriptor {
  return Object.freeze({ namespace: NETCONF_NS, ...d, params: Object.freeze(d.params.map((p) => Object.freeze(p))) });
}

/**
 * The RFC 6241 base operations, described as plain data, in RFC 6241 §7
 * order: for tools that build commands, help text and completion from
 * descriptors, as the nnc CLI does, without connecting. A connected client's
 * `client.ops.list` starts with these, plus any parameters enabled extensions
 * add, then the extensions' and the device profile's operations; prefer it
 * once connected. Build a request with {@link buildOperation}, or run one with
 * `client.ops.run()`.
 */
export const BASE_OPERATIONS: readonly OperationDescriptor[] = Object.freeze([
  op({
    name: 'get',
    method: 'get',
    description: 'Read running configuration and state data',
    mutates: false,
    requires: [],
    params: [filter],
  }),
  op({
    name: 'get-config',
    method: 'getConfig',
    description: 'Read configuration from a datastore',
    mutates: false,
    requires: [],
    params: [
      { ...datastore('source', 'The datastore to read'), required: false, default: 'running' },
      filter,
    ],
  }),
  op({
    name: 'edit-config',
    method: 'editConfig',
    description: 'Change configuration in a datastore',
    mutates: true,
    requires: [],
    params: [
      {
        name: 'target',
        kind: 'positional',
        type: 'datastore',
        description: 'The datastore to change',
        values: ['running', 'candidate'],
        required: true,
        valueRequires: { running: [':writable-running'], candidate: [':candidate'] },
      },
      { name: 'config', kind: 'positional', type: 'xml', description: 'The configuration content: XML, or RFC 7951 JSON (give this or url)' },
      { name: 'url', kind: 'option', type: 'string', description: 'Load the configuration from a URL', requires: [':url'] },
      {
        name: 'defaultOperation',
        kind: 'option',
        type: 'string',
        description: 'The default operation for the content',
        values: ['merge', 'replace', 'none'],
      },
      {
        name: 'testOption',
        kind: 'option',
        type: 'string',
        description: 'Whether to validate before applying',
        values: ['test-then-set', 'set', 'test-only'],
        valueRequires: { 'test-then-set': [':validate'], set: [':validate'], 'test-only': [':validate:1.1'] },
      },
      {
        name: 'errorOption',
        kind: 'option',
        type: 'string',
        description: 'What to do when an edit fails',
        values: ['stop-on-error', 'continue-on-error', 'rollback-on-error'],
        valueRequires: { 'rollback-on-error': [':rollback-on-error'] },
      },
    ],
  }),
  op({
    name: 'copy-config',
    method: 'copyConfig',
    description: 'Replace a whole configuration with another',
    mutates: true,
    requires: [],
    params: [
      {
        name: 'target',
        kind: 'positional',
        type: 'config-target',
        description: 'Where the configuration goes: a datastore or a URL (:url)',
        required: true,
        valueRequires: { running: [':writable-running'], ...DATASTORE_REQUIRES },
      },
      {
        name: 'source',
        kind: 'positional',
        type: 'config-source',
        description: 'Where the configuration comes from: a datastore, a URL (:url) or inline content',
        required: true,
        valueRequires: DATASTORE_REQUIRES,
      },
    ],
  }),
  op({
    name: 'delete-config',
    method: 'deleteConfig',
    description: 'Delete the startup configuration, or a configuration at a URL',
    mutates: true,
    requires: [],
    params: [
      {
        name: 'target',
        kind: 'positional',
        type: 'config-target',
        description: 'startup, or a URL (:url)',
        values: ['startup'],
        required: true,
        valueRequires: { startup: [':startup'] },
      },
    ],
  }),
  op({
    name: 'lock',
    method: 'lock',
    description: 'Lock a datastore against changes from other sessions',
    mutates: true,
    requires: [],
    params: [datastore('target', 'The datastore to lock')],
  }),
  op({
    name: 'unlock',
    method: 'unlock',
    description: 'Release a lock held by this session',
    mutates: true,
    requires: [],
    params: [datastore('target', 'The datastore to unlock')],
  }),
  op({
    name: 'validate',
    method: 'validate',
    description: 'Check a configuration for errors without applying it',
    mutates: false,
    requires: [':validate'],
    params: [
      {
        name: 'source',
        kind: 'positional',
        type: 'config-source',
        description: 'The configuration to check: a datastore, a URL (:url) or inline content',
        required: true,
        valueRequires: DATASTORE_REQUIRES,
      },
    ],
  }),
  op({
    name: 'commit',
    method: 'commit',
    description: 'Commit the candidate configuration to running',
    mutates: true,
    requires: [':candidate'],
    params: [
      {
        name: 'confirmed',
        kind: 'option',
        type: 'boolean',
        description: 'Revert unless confirmed within confirmTimeout',
        default: false,
        requires: [':confirmed-commit'],
      },
      {
        name: 'confirmTimeout',
        kind: 'option',
        type: 'number',
        description: 'Seconds before an unconfirmed commit reverts (server default 600)',
        requires: [':confirmed-commit'],
      },
      {
        name: 'persist',
        kind: 'option',
        type: 'string',
        description: 'Make the confirmed commit survive this session ending',
        requires: [':confirmed-commit:1.1'],
      },
      {
        name: 'persistId',
        kind: 'option',
        type: 'string',
        description: 'Confirm or extend a persistent confirmed commit',
        requires: [':confirmed-commit:1.1'],
      },
    ],
  }),
  op({
    name: 'cancel-commit',
    method: 'cancelCommit',
    description: 'Cancel a confirmed commit in progress',
    mutates: true,
    requires: [':confirmed-commit:1.1'],
    params: [
      { name: 'persistId', kind: 'option', type: 'string', description: 'The persist id of a persistent confirmed commit' },
    ],
  }),
  op({
    name: 'discard-changes',
    method: 'discardChanges',
    description: 'Revert the candidate to the running configuration',
    mutates: true,
    requires: [':candidate'],
    params: [],
  }),
  op({
    name: 'kill-session',
    method: 'killSession',
    description: 'Force another NETCONF session to close',
    mutates: true,
    requires: [],
    params: [{ name: 'sessionId', kind: 'positional', type: 'number', description: 'The session to close', required: true }],
  }),
  op({
    name: 'close-session',
    method: 'close',
    description: 'Close this session',
    mutates: false,
    requires: [],
    params: [],
  }),
  op({
    namespace: base.YANG_NS,
    name: 'action',
    method: 'action',
    description: 'Invoke a YANG 1.1 action on a data node (RFC 7950 §7.15)',
    mutates: true,
    requires: [],
    params: [
      {
        name: 'target',
        kind: 'positional',
        type: 'xml',
        description: 'The data-node tree down to the action element, with its input: XML, or RFC 7951 JSON',
        required: true,
      },
    ],
  }),
]);

/**
 * Request builders for the base operations, by RPC name. Each takes its
 * operation's arguments, keyed as in its descriptor.
 */
export const BASE_REQUESTS: Readonly<Record<string, RequestBuilder<never>>> = Object.freeze({
  get: (a: base.GetOptions) => base.get(a),
  'get-config': (a: base.GetConfigOptions) => base.getConfig(a),
  'edit-config': (a: base.EditConfigOptions) => base.editConfig(a),
  'copy-config': (a: base.CopyConfigOptions) => base.copyConfig(a),
  'delete-config': (a: { readonly target: Parameters<typeof base.deleteConfig>[0] }) => base.deleteConfig(a.target),
  lock: (a: { readonly target: base.Datastore }) => base.lock(a.target),
  unlock: (a: { readonly target: base.Datastore }) => base.unlock(a.target),
  validate: (a: { readonly source: base.ConfigSource }) => base.validate(a.source),
  commit: (a: base.CommitOptions) => base.commit(a),
  'cancel-commit': (a: { readonly persistId?: string }) => base.cancelCommit(a),
  'discard-changes': () => base.discardChanges(),
  'kill-session': (a: { readonly sessionId: number }) => base.killSession(a.sessionId),
  'close-session': () => base.closeSession(),
  action: (a: { readonly target: XmlElement }) => base.action(a.target),
});

/**
 * Build a base operation's request from plain arguments, keyed as in its
 * descriptor in {@link BASE_OPERATIONS}: `buildOperation('lock', { target: 'candidate' })`.
 * Sends nothing; the result is the same element the matching `client.ops`
 * method sends, with the capabilities it needs. Content must already be XML
 * (JSON `config` or `filter` needs a client), and extensions' parameters are
 * not applied: use `client.ops.run()` for both.
 * @throws TypeError for an unknown operation, or arguments the operation can't take.
 */
export function buildOperation(name: string, args: RequestArgs = {}): base.OperationRequest {
  const build = Object.prototype.hasOwnProperty.call(BASE_REQUESTS, name) ? BASE_REQUESTS[name] : undefined;
  if (build === undefined) throw new TypeError(`No base operation named ${JSON.stringify(name)}`);
  return callRequestBuilder(build, args);
}
