/**
 * The edit side of `client.content.configure()` and `checkEdits()` (design
 * §6.4): the `<config>` a transaction sends, the check that its modules fit
 * the edit target, and the in-place workflow (running, or the candidate
 * without commit). The candidate workflow with commit is withCandidate()'s.
 * ClientContent delegates to this; nothing else uses it.
 */

import type { ClientModules } from './client-modules.js';
import type { ClientOps } from './client-ops.js';
import { PathError, type ConfigTransaction, type Workflow } from './content/index.js';
import { NETCONF_NS, type RpcOptions, type Session } from './messages/index.js';
import type { CapabilityCheck, ExtensionContext, JsonOptions, YangJsonValue } from './operations/index.js';
import type { ConfigureStep } from './operations/transaction.js';
import { cachedYangLibrary, findDatastore } from './operations/yang-library.js';
import { XmlElement } from './xml/index.js';

/** @internal What the configure helpers need from the client. */
export interface ConfigureInit {
  readonly session: Session;
  readonly ops: ClientOps;
  readonly capabilityCheck: CapabilityCheck;
  readonly ctx: ExtensionContext;
}

/**
 * Refuse a path edit whose modules the edit target can't hold: one the
 * session's YANG library implements in another datastore's schema but not
 * in the target's (a module only `operational` implements, say). Only that
 * evidence counts: a module the library doesn't implement anywhere (one
 * known from the hello, the profile or `connect({ namespaces })`, on a
 * server whose library is incomplete) is left for the server to check. Needs a
 * library read that lists datastores; the check reads nothing itself.
 * Follows `capabilityCheck`: 'strict' throws, 'warn' warns and sends,
 * 'off' skips.
 * @throws PathError
 */
export function checkTargetSchema(init: ConfigureInit, modules: ClientModules, paths: readonly string[], target: 'running' | 'candidate'): void {
  const { capabilityCheck, ctx, session } = init;
  if (capabilityCheck === 'off' || paths.length === 0) return;
  const library = cachedYangLibrary(ctx);
  if (library === undefined || library.datastores.length === 0) return;
  const ds = findDatastore(library, target);
  if (ds === undefined) return;
  const inTarget = new Set(ds.modules.map((m) => m.name));
  const elsewhere = new Map<string, string[]>();
  for (const other of library.datastores) {
    if (other === ds) continue;
    for (const m of other.modules) {
      if (inTarget.has(m.name)) continue;
      const names = elsewhere.get(m.name) ?? [];
      // A standard datastore by name (`operational`), another with its module.
      names.push(other.name.startsWith('ietf-datastores:') ? other.name.slice('ietf-datastores:'.length) : other.name);
      elsewhere.set(m.name, names);
    }
  }
  if (elsewhere.size === 0) return;
  for (const path of paths) {
    for (const step of modules.resolve(path, 'error')) {
      const others = elsewhere.get(step.moduleName);
      if (others === undefined) continue;
      const message =
        `configure: ${path} is in module ${step.moduleName}, which the server's YANG library implements in ` +
        `${others.join(' and ')} but not in ${target}, the datastore this edit goes to`;
      if (capabilityCheck === 'strict') throw new PathError(message);
      session.warn(`${message}; sending anyway`);
      break;
    }
  }
}

/**
 * A transaction's `<config>` content: its path edits, then its JSON edits
 * converted with the edit target's schema. JSON edits of the same
 * top-level member are merged first; a top-level node edited both ways is
 * refused.
 */
export async function editContent(ctx: ExtensionContext, txn: ConfigTransaction, datastore: 'running' | 'candidate', json: JsonOptions = {}): Promise<XmlElement[]> {
  const config = txn.build();
  if (txn.json.length === 0) return config;
  const groups = new Map<string, { operation: 'merge' | 'replace'; value: YangJsonValue }>();
  for (const edit of txn.json) {
    for (const [member, value] of Object.entries(edit.json)) {
      const prior = groups.get(member);
      if (prior === undefined) groups.set(member, { operation: edit.operation, value });
      else if (prior.operation !== edit.operation) throw new TypeError(`configure: ${member} is both merged and replaced as JSON; edit it one way`);
      else prior.value = mergeJson(prior.value, value);
    }
  }
  const taken = new Set(config.map((el) => `${el.ns ?? ''} ${el.name}`));
  for (const [member, { operation, value }] of groups) {
    const elements = await ctx.toXml({ [member]: value }, { ...json, datastore: json.datastore ?? datastore });
    for (const el of elements) {
      if (taken.has(`${el.ns ?? ''} ${el.name}`)) throw new TypeError(`configure: ${member} is edited both by path and as JSON; edit it one way`);
      config.push(operation === 'replace' ? withOperation(el, 'replace') : el);
    }
  }
  return config;
}

/**
 * Apply `config` in place: running, or the candidate without commit. Holds
 * the lock if the workflow asks, validates if it asks, discards the
 * candidate's changes on failure, and always unlocks.
 */
export async function applyInPlace(
  init: ConfigureInit,
  flow: Workflow,
  config: XmlElement[],
  rpc: RpcOptions,
  onStep: ((step: ConfigureStep) => void) | undefined,
): Promise<void> {
  const { session, ops: opsLayer } = init;
  // Running (or candidate without commit): edit in place, holding the lock if the workflow asks.
  const logger = session.logger;
  const ds = flow.editTarget;
  // Report each step that succeeds. The listener only observes: if it throws, log it and carry on.
  const step = (operation: ConfigureStep['operation'], datastore: ConfigureStep['datastore'] = ds): void => {
    try {
      onStep?.({ operation, datastore });
    } catch (err) {
      logger.warn?.('onStep listener threw', { err });
    }
  };
  if (flow.lock) {
    await opsLayer.lock(ds, rpc);
    step('lock');
  }
  try {
    try {
      await opsLayer.editConfig({ target: ds, config, ...rpc });
      step('edit-config');
      if (flow.validate) {
        await opsLayer.validate(ds, rpc);
        step('validate');
      }
    } catch (err) {
      if (ds === 'candidate') {
        await opsLayer.discardChanges().then(
          () => step('discard-changes', 'candidate'),
          (e: unknown) => logger.warn?.('discard-changes failed', { err: e }),
        );
      }
      throw err;
    }
  } finally {
    if (flow.lock) {
      await opsLayer.unlock(ds, { ...(rpc.timeout !== undefined ? { timeout: rpc.timeout } : {}) }).then(
        () => step('unlock'),
        (e: unknown) => logger.warn?.('unlock failed', { err: e }),
      );
    }
  }
}

/** JSON edits of one member, combined: objects member by member, arrays joined. */
function mergeJson(a: YangJsonValue, b: YangJsonValue): YangJsonValue {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (typeof a === 'object' && a !== null && !Array.isArray(a) && typeof b === 'object' && b !== null && !Array.isArray(b)) {
    const out: Record<string, YangJsonValue> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? mergeJson(out[k]!, v) : v;
    return out;
  }
  return b;
}

/** An element with the NETCONF `operation` attribute set. */
function withOperation(el: XmlElement, operation: string): XmlElement {
  const own = el.attr('operation', NETCONF_NS);
  if (own !== undefined && own !== operation) throw new TypeError(`configure: txn.replace() content already has operation ${own} on ${el.name}`);
  return new XmlElement({
    name: el.name,
    ns: el.ns,
    prefix: el.prefix,
    attributes: [...el.attributes.filter((a) => !(a.name === 'operation' && a.ns === NETCONF_NS)), { name: 'operation', ns: NETCONF_NS, prefix: 'nc', value: operation }],
    children: el.children,
    declarations: el.declarations,
    inScope: el.inScope,
  });
}
