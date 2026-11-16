/** Building the subscription RPCs from plain arguments (RFC 8639, 8641), and reading their refusals. */

import { RpcError } from '../../messages/index.js';
import { x, type XmlElement } from '../../xml/index.js';
import { rfc3339 } from '../args.js';
import type { Filter, OperationRequest } from '../base.js';
import type { RequestArgs } from '../extension.js';
import { datastoreIdentity, DATASTORES_NS, type DatastoreRef, type Identity } from '../identities.js';
import { CHANGE_TYPES, MAX_ID, SN, SN_MODULE, YP, YP_MODULE, type ChangeType } from './common.js';
import type { OnChangeOptions, PeriodicOptions } from './types.js';

function centiseconds(value: unknown, what: string, min: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > MAX_ID) {
    throw new TypeError(`${what} must be a whole number of centiseconds from ${min} to ${MAX_ID}`);
  }
  return value;
}

function subscriptionId(value: unknown, op: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_ID) {
    throw new TypeError(`${op}: id must be an integer from 0 to ${MAX_ID}`);
  }
  return value;
}

/** A filter element in the stream or datastore form: `stream-subtree-filter`, `datastore-xpath-filter`, … */
function filterElement(filter: unknown, kind: 'stream' | 'datastore', op: string): XmlElement | undefined {
  if (filter === undefined) return undefined;
  const ns = kind === 'stream' ? SN : YP;
  const f = filter as Filter;
  if (typeof f === 'object' && f !== null && f.type === 'subtree') {
    return x(`${kind}-subtree-filter`, { xmlns: ns }, f.content);
  }
  if (typeof f === 'object' && f !== null && f.type === 'xpath') {
    if (typeof f.select !== 'string' || f.select.trim() === '') throw new TypeError(`${op}: the XPath filter is empty`);
    const declarations: Record<string, string> = {};
    for (const [prefix, uri] of Object.entries(f.namespaces ?? {})) declarations[`xmlns:${prefix}`] = uri;
    return x(`${kind}-xpath-filter`, { xmlns: ns, ...declarations }, f.select);
  }
  throw new TypeError(`${op}: filter must be subtree(...) or xpath(...)`);
}

function datastoreElement(ref: unknown): { element: XmlElement; identity: Identity } {
  const identity = datastoreIdentity(ref as DatastoreRef);
  const prefix = identity.namespace === DATASTORES_NS ? 'ds' : 'dsid';
  return { element: x('datastore', { xmlns: YP, [`xmlns:${prefix}`]: identity.namespace }, `${prefix}:${identity.name}`), identity };
}

function periodicElement(periodic: unknown, op: string): XmlElement {
  if (typeof periodic !== 'object' || periodic === null) throw new TypeError(`${op}: periodic must be { period, anchorTime? }`);
  const p = periodic as Partial<PeriodicOptions>;
  const period = centiseconds(p.period, `${op}: periodic.period`, 1);
  if (period === undefined) throw new TypeError(`${op}: periodic needs a period (centiseconds)`);
  const anchor = rfc3339(p.anchorTime, `${op}: periodic.anchorTime`);
  return x('periodic', { xmlns: YP }, x('period', String(period)), anchor !== undefined && x('anchor-time', anchor));
}

function onChangeElement(onChange: unknown, op: string): XmlElement {
  if (typeof onChange !== 'object' || onChange === null) throw new TypeError(`${op}: onChange must be { dampeningPeriod?, syncOnStart?, excludedChanges? }`);
  const o = onChange as OnChangeOptions;
  const dampening = centiseconds(o.dampeningPeriod, `${op}: onChange.dampeningPeriod`, 0);
  if (o.syncOnStart !== undefined && typeof o.syncOnStart !== 'boolean') throw new TypeError(`${op}: onChange.syncOnStart must be a boolean`);
  const excluded = o.excludedChanges ?? [];
  if (!Array.isArray(excluded) || excluded.some((c) => !(CHANGE_TYPES as readonly unknown[]).includes(c))) {
    throw new TypeError(`${op}: onChange.excludedChanges must list ${CHANGE_TYPES.join(', ')}`);
  }
  return x('on-change', { xmlns: YP },
    dampening !== undefined && x('dampening-period', String(dampening)),
    o.syncOnStart !== undefined && x('sync-on-start', String(o.syncOnStart)),
    [...new Set<ChangeType>(excluded)].map((c) => x('excluded-change', c)),
  );
}

/** Turn the flat descriptor arguments (period, onChange, …) into the nested options. */
function nest(args: RequestArgs): RequestArgs {
  const out: Record<string, unknown> = { ...args };
  if (args['period'] !== undefined || args['anchorTime'] !== undefined) {
    if (args['periodic'] !== undefined) throw new TypeError('establish-subscription: give periodic or period, not both');
    out['periodic'] = { period: args['period'], ...(args['anchorTime'] !== undefined ? { anchorTime: args['anchorTime'] } : {}) };
  }
  if (args['onChange'] === true || args['dampeningPeriod'] !== undefined || args['syncOnStart'] !== undefined || args['excludedChange'] !== undefined) {
    out['onChange'] = {
      ...(args['dampeningPeriod'] !== undefined ? { dampeningPeriod: args['dampeningPeriod'] } : {}),
      ...(args['syncOnStart'] !== undefined ? { syncOnStart: args['syncOnStart'] } : {}),
      ...(args['excludedChange'] !== undefined ? { excludedChanges: [args['excludedChange']].flat() } : {}),
    };
  } else if (args['onChange'] === false) {
    delete out['onChange'];
  }
  for (const k of ['period', 'anchorTime', 'dampeningPeriod', 'syncOnStart', 'excludedChange']) delete out[k];
  return out;
}

/** An establish request, with what the subscription it creates needs to know. */
export interface Established {
  readonly request: OperationRequest;
  readonly kind: 'stream' | 'datastore';
  readonly stream?: string;
  readonly datastore?: Identity;
  readonly trigger?: 'periodic' | 'on-change';
  readonly stopTime?: string;
  readonly replay: boolean;
  /** The capabilities to check against the YANG library: module, then features. */
  readonly needs: { readonly module: 'sn' | 'yp'; readonly features: readonly string[]; readonly snFeatures: readonly string[] };
}

export function buildEstablish(input: RequestArgs): Established {
  const op = 'establish-subscription';
  const args = nest(input);
  const { stream, datastore, filter, replayStartTime, periodic, onChange } = args as Record<string, unknown>;
  const stopTime = rfc3339(args['stopTime'], `${op}: stopTime`);
  const snFeatures: string[] = [];
  const f = filter as Filter | undefined;
  if (f?.type === 'subtree') snFeatures.push('subtree');
  if (f?.type === 'xpath') snFeatures.push('xpath');

  if ((stream === undefined) === (datastore === undefined)) throw new TypeError(`${op}: give a stream or a datastore`);
  if (stream !== undefined) {
    if (typeof stream !== 'string' || stream === '') throw new TypeError(`${op}: stream must be a name`);
    if (periodic !== undefined || onChange !== undefined) throw new TypeError(`${op}: periodic and onChange are for datastore subscriptions`);
    const replay = rfc3339(replayStartTime, `${op}: replayStartTime`);
    if (replay !== undefined) snFeatures.push('replay');
    if (replay !== undefined && stopTime !== undefined && Date.parse(stopTime) <= Date.parse(replay)) {
      throw new TypeError(`${op}: stopTime must be later than replayStartTime`);
    }
    return {
      request: {
        element: x(op, { xmlns: SN },
          x('stream', stream),
          filterElement(filter, 'stream', op),
          replay !== undefined && x('replay-start-time', replay),
          stopTime !== undefined && x('stop-time', stopTime),
        ),
        requires: [],
      },
      kind: 'stream',
      stream,
      ...(stopTime !== undefined ? { stopTime } : {}),
      replay: replay !== undefined,
      needs: { module: 'sn', features: [], snFeatures },
    };
  }

  if (replayStartTime !== undefined) throw new TypeError(`${op}: replayStartTime is for stream subscriptions`);
  if ((periodic === undefined) === (onChange === undefined)) throw new TypeError(`${op}: a datastore subscription needs periodic or onChange (one of them)`);
  const ds = datastoreElement(datastore);
  const trigger = periodic !== undefined ? periodicElement(periodic, op) : onChangeElement(onChange, op);
  return {
    request: {
      element: x(op, { xmlns: SN }, ds.element, filterElement(filter, 'datastore', op), stopTime !== undefined && x('stop-time', stopTime), trigger),
      requires: [],
    },
    kind: 'datastore',
    datastore: ds.identity,
    trigger: periodic !== undefined ? 'periodic' : 'on-change',
    ...(stopTime !== undefined ? { stopTime } : {}),
    replay: false,
    needs: { module: 'yp', features: onChange !== undefined ? ['on-change'] : [], snFeatures },
  };
}

/** Build an `<establish-subscription>` request from plain arguments. Sends nothing. */
export function establishSubscriptionRequest(args: RequestArgs): OperationRequest {
  return buildEstablish(args).request;
}

/**
 * Build a `<modify-subscription>` request. For a datastore subscription give
 * `datastore`, and `period` or `dampeningPeriod` to change the trigger.
 */
export function modifySubscriptionRequest(args: RequestArgs): OperationRequest {
  const op = 'modify-subscription';
  const id = subscriptionId(args['id'], op);
  const stopTime = rfc3339(args['stopTime'], `${op}: stopTime`);
  if (args['datastore'] === undefined) {
    if (args['filter'] === undefined) throw new TypeError(`${op}: a stream subscription's modify needs a filter (RFC 8639 makes it mandatory)`);
    if (args['period'] !== undefined || args['dampeningPeriod'] !== undefined) throw new TypeError(`${op}: period and dampeningPeriod are for datastore subscriptions`);
    return {
      element: x(op, { xmlns: SN }, x('id', String(id)), filterElement(args['filter'], 'stream', op), stopTime !== undefined && x('stop-time', stopTime)),
      requires: [],
    };
  }
  if (args['period'] !== undefined && args['dampeningPeriod'] !== undefined) throw new TypeError(`${op}: give period or dampeningPeriod, not both`);
  const period = centiseconds(args['period'], `${op}: period`, 1);
  const dampening = centiseconds(args['dampeningPeriod'], `${op}: dampeningPeriod`, 0);
  const anchor = rfc3339(args['anchorTime'], `${op}: anchorTime`);
  if (anchor !== undefined && period === undefined) throw new TypeError(`${op}: anchorTime needs period`);
  return {
    element: x(op, { xmlns: SN },
      x('id', String(id)),
      datastoreElement(args['datastore']).element,
      filterElement(args['filter'], 'datastore', op),
      stopTime !== undefined && x('stop-time', stopTime),
      period !== undefined && x('periodic', { xmlns: YP }, x('period', String(period)), anchor !== undefined && x('anchor-time', anchor)),
      dampening !== undefined && x('on-change', { xmlns: YP }, x('dampening-period', String(dampening))),
    ),
    requires: [],
  };
}

/** Build a `<delete-subscription>` request. */
export function deleteSubscriptionRequest(args: RequestArgs): OperationRequest {
  return { element: x('delete-subscription', { xmlns: SN }, x('id', String(subscriptionId(args['id'], 'delete-subscription')))), requires: [] };
}

/** Build a `<kill-subscription>` request. */
export function killSubscriptionRequest(args: RequestArgs): OperationRequest {
  return { element: x('kill-subscription', { xmlns: SN }, x('id', String(subscriptionId(args['id'], 'kill-subscription')))), requires: [] };
}

/** Build a YANG-Push `<resync-subscription>` request (on-change subscriptions). */
export function resyncSubscriptionRequest(args: RequestArgs): OperationRequest {
  return { element: x('resync-subscription', { xmlns: YP }, x('id', String(subscriptionId(args['id'], 'resync-subscription')))), requires: [] };
}

/**
 * The reason identity of a subscription RPC's refusal, from `error-app-tag`
 * (RFC 8640 §2.4.3), module-qualified as RFC 7951 writes it:
 * `ietf-subscribed-notifications:no-such-subscription`,
 * `ietf-yang-push:period-unsupported`, … A bare name is taken as
 * ietf-subscribed-notifications', and the `sn`/`yp` prefixes servers use
 * are written out. Undefined if the error doesn't carry one.
 */
export function subscriptionErrorReason(err: unknown): string | undefined {
  if (!(err instanceof RpcError)) return undefined;
  for (const e of err.errors) {
    const tag = e.appTag;
    if (tag === undefined) continue;
    const colon = tag.indexOf(':');
    const module = colon < 0 ? undefined : tag.slice(0, colon);
    const name = tag.slice(colon + 1);
    if (module === undefined || module === SN_MODULE || module === 'sn') return `${SN_MODULE}:${name}`;
    if (module === YP_MODULE || module === 'yp') return `${YP_MODULE}:${name}`;
  }
  return undefined;
}
