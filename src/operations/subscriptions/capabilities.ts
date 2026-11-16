/** RFC 9196 notification capabilities: what the server can push, read from `/system-capabilities`. */

import type { RpcOptions } from '../../messages/index.js';
import { x, type XmlElement } from '../../xml/index.js';
import { get, subtree } from '../base.js';
import type { ExtensionContext } from '../extension.js';
import { qualifiedIdentity } from '../qualified.js';
import { hasYangLibrary, loadYangLibrary } from '../yang-library.js';
import { CHANGE_TYPES, leaf, type ChangeType } from './common.js';

/** The RFC 9196 modules' namespaces and names. */
export const SYSC = 'urn:ietf:params:xml:ns:yang:ietf-system-capabilities';
const NCAP = 'urn:ietf:params:xml:ns:yang:ietf-notification-capabilities';
const SYSC_MODULE = 'ietf-system-capabilities';

/** RFC 9196 `notification-support` bits: which kinds of change a level supports. */
export interface NotificationSupport {
  /** Changes to configuration (`config true`) nodes: the `config-changes` bit. */
  readonly config: boolean;
  /** Changes to state (`config false`) nodes: the `state-changes` bit. */
  readonly state: boolean;
}

/**
 * RFC 9196 notification capabilities (`subscription-capabilities`) at one
 * level: the system, or a datastore's selected nodes. A field the server
 * doesn't report is absent. Periods are in centiseconds, as in
 * `PeriodicOptions`.
 */
export interface NotificationCapabilities {
  /** At least this many data nodes fit in one update. */
  readonly maxNodesPerUpdate?: number;
  /** Which changes periodic updates are supported for. */
  readonly periodic?: NotificationSupport;
  /** The shortest periodic period the server supports. */
  readonly minimumUpdatePeriod?: number;
  /** The only periodic periods the server supports. */
  readonly supportedUpdatePeriods?: readonly number[];
  /** Which changes on-change updates are supported for (needs the yang-push `on-change` feature). */
  readonly onChange?: NotificationSupport;
  /** The shortest dampening period; above zero, dampening is mandatory. */
  readonly minimumDampeningPeriod?: number;
  /** The change types an on-change subscription may leave out (`excludedChanges`), or `none` or `all`. */
  readonly excludedChangeTypes?: readonly (ChangeType | 'none' | 'all')[];
}

/** RFC 9196 capabilities for the nodes a selector picks in one datastore, and the subtrees below them. */
export interface NodeCapabilities extends NotificationCapabilities {
  /** The node selector as the server sent it (a NACM node-instance-identifier); `/` is the whole datastore. */
  readonly selector: string;
}

/** RFC 9196 capabilities for one datastore. */
export interface DatastoreCapabilities {
  /** The datastore identity, module-qualified (RFC 7951): `ietf-datastores:operational`. */
  readonly datastore: string;
  /** Per-node entries, in the server's order, which is their precedence: the first that matches a node applies. */
  readonly nodes: readonly NodeCapabilities[];
}

/** The server's RFC 9196 `/system-capabilities`, from `client.content.subscriptions.capabilities()`. */
export interface SubscriptionCapabilities {
  /** System-level values: they apply where a datastore's node entries say nothing. */
  readonly system: NotificationCapabilities;
  /** One entry per datastore the server reports on, in its order. */
  readonly datastores: readonly DatastoreCapabilities[];
}

/** Read `/system-capabilities`, or undefined (reading nothing more) when the server doesn't implement ietf-system-capabilities. */
export async function readCapabilities(ctx: ExtensionContext, options: RpcOptions): Promise<SubscriptionCapabilities | undefined> {
  let implemented = ctx.serverCapabilities.helloModule(SYSC_MODULE) !== undefined;
  if (!implemented && hasYangLibrary(ctx)) {
    const library = await loadYangLibrary(ctx, options);
    implemented = [...library.datastores.flatMap((d) => d.modules), ...library.moduleSets.flatMap((m) => m.modules)].some((m) => m.name === SYSC_MODULE);
  }
  if (!implemented) return undefined;
  const reply = await ctx.invoke(get({ filter: subtree(x('system-capabilities', { xmlns: SYSC })) }), options);
  const root = reply.data?.child('system-capabilities', SYSC);
  const datastores = (root?.childrenNamed('datastore-capabilities', SYSC) ?? []).flatMap((d): DatastoreCapabilities[] => {
    const dsEl = d.child('datastore', SYSC);
    const datastore = dsEl === undefined ? undefined : qualifiedIdentity(dsEl.text(), dsEl, ctx.moduleOf);
    if (datastore === undefined) return [];
    const nodes = d.childrenNamed('per-node-capabilities', SYSC).flatMap((n): NodeCapabilities[] => {
      const selector = leaf(n, 'node-selector', SYSC);
      return selector === undefined || selector === '' ? [] : [Object.freeze({ selector, ...notificationCapabilities(n) })];
    });
    return [Object.freeze({ datastore, nodes: Object.freeze(nodes) })];
  });
  return Object.freeze({ system: Object.freeze(notificationCapabilities(root)), datastores: Object.freeze(datastores) });
}

const EXCLUDABLE: ReadonlySet<string> = new Set([...CHANGE_TYPES, 'none', 'all']);

/** The `subscription-capabilities` under an element, leaving out values that aren't well-formed. */
function notificationCapabilities(parent: XmlElement | undefined): NotificationCapabilities {
  const c = parent?.child('subscription-capabilities', NCAP);
  const out: Record<string, unknown> = {};
  if (c === undefined) return out;
  const uint32 = (text: string | undefined): number | undefined =>
    text !== undefined && /^\d+$/.test(text) && Number(text) <= 4294967295 ? Number(text) : undefined;
  const support = (name: string): NotificationSupport | undefined => {
    const text = leaf(c, name, NCAP);
    if (text === undefined) return undefined;
    const bits = text.split(/\s+/);
    return Object.freeze({ config: bits.includes('config-changes'), state: bits.includes('state-changes') });
  };
  const max = uint32(leaf(c, 'max-nodes-per-update', NCAP));
  if (max !== undefined && max >= 1) out['maxNodesPerUpdate'] = max;
  const periodic = support('periodic-notifications-supported');
  if (periodic !== undefined) out['periodic'] = periodic;
  const minimum = uint32(leaf(c, 'minimum-update-period', NCAP));
  if (minimum !== undefined) out['minimumUpdatePeriod'] = minimum;
  const periods = c.childrenNamed('supported-update-period', NCAP).flatMap((el) => {
    const n = uint32(el.text().trim());
    return n === undefined ? [] : [n];
  });
  if (periods.length > 0) out['supportedUpdatePeriods'] = Object.freeze(periods);
  const onChange = support('on-change-supported');
  if (onChange !== undefined) out['onChange'] = onChange;
  const dampening = uint32(leaf(c, 'minimum-dampening-period', NCAP));
  if (dampening !== undefined) out['minimumDampeningPeriod'] = dampening;
  const excluded = c.childrenNamed('supported-excluded-change-type', NCAP).flatMap((el) => {
    const text = el.text().trim();
    return EXCLUDABLE.has(text) ? [text] : [];
  });
  if (excluded.length > 0) out['excludedChangeTypes'] = Object.freeze(excluded);
  return out;
}
