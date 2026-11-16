/** The subscriptions extension's reads: `support()` (cached per session), `streams()`, `list()`. */

import { CapabilityError } from '../../errors.js';
import type { RpcOptions } from '../../messages/index.js';
import { x, type XmlElement } from '../../xml/index.js';
import { raceSignal } from '../abort.js';
import { get, subtree } from '../base.js';
import type { ExtensionContext } from '../extension.js';
import type { StreamInfo } from '../notifications.js';
import { qualifiedIdentity } from '../qualified.js';
import { hasYangLibrary, loadYangLibrary } from '../yang-library.js';
import { leaf, SN, SN_MODULE, YP, YP_MODULE } from './common.js';
import type { ModuleSupport, ReceiverInfo, SubscriptionInfo, SubscriptionSupport } from './types.js';

// --- support ---------------------------------------------------------------------------------------

async function readSupport(ctx: ExtensionContext, options: RpcOptions & { readonly refresh?: boolean }): Promise<SubscriptionSupport> {
  const caps = ctx.serverCapabilities;
  const fromHello = (name: string): ModuleSupport | undefined => {
    const m = caps.helloModule(name);
    return m === undefined ? undefined : Object.freeze({ ...(m.revision !== undefined ? { revision: m.revision } : {}), features: Object.freeze([...m.features]) });
  };
  let sn = fromHello(SN_MODULE);
  let yp = fromHello(YP_MODULE);
  if ((sn === undefined || yp === undefined) && hasYangLibrary(ctx)) {
    const library = await loadYangLibrary(ctx, options);
    const modules = [...library.datastores.flatMap((d) => d.modules), ...library.moduleSets.flatMap((s) => s.modules)];
    const find = (name: string): ModuleSupport | undefined => {
      const m = modules.find((mod) => mod.name === name);
      return m === undefined ? undefined : Object.freeze({ ...(m.revision !== undefined ? { revision: m.revision } : {}), features: Object.freeze([...m.features]) });
    };
    sn ??= find(SN_MODULE);
    yp ??= find(YP_MODULE);
  }
  return Object.freeze({ ...(sn !== undefined ? { subscribedNotifications: sn } : {}), ...(yp !== undefined ? { yangPush: yp } : {}) });
}

/** Apply `capabilityCheck` to one thing establish needs. */
export function require_(ctx: ExtensionContext, ok: boolean, capability: string, what: string): void {
  if (ok || ctx.capabilityCheck === 'off') return;
  if (ctx.capabilityCheck === 'strict') throw new CapabilityError(capability, what);
  ctx.logger.warn?.(`${what} needs ${capability}, which the server doesn't report; continuing anyway`);
}

// --- reads -----------------------------------------------------------------------------------------

function count(el: XmlElement, name: string): number | undefined {
  const text = leaf(el, name, SN);
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined;
}

export async function readStreams(ctx: ExtensionContext, options: RpcOptions): Promise<StreamInfo[]> {
  const reply = await ctx.invoke(get({ filter: subtree(x('streams', { xmlns: SN })) }), options);
  const list = reply.data?.child('streams', SN);
  return (list?.childrenNamed('stream', SN) ?? []).flatMap((s) => {
    const name = leaf(s, 'name', SN);
    if (name === undefined) return [];
    const info: Record<string, unknown> = { name, replaySupport: s.child('replay-support', SN) !== undefined };
    for (const [key, el] of [['description', 'description'], ['replayLogCreationTime', 'replay-log-creation-time'], ['replayLogAgedTime', 'replay-log-aged-time']] as const) {
      const value = leaf(s, el, SN);
      if (value !== undefined) info[key] = value;
    }
    return [Object.freeze(info as unknown as StreamInfo)];
  });
}

export async function readSubscriptions(ctx: ExtensionContext, options: RpcOptions): Promise<SubscriptionInfo[]> {
  const reply = await ctx.invoke(get({ filter: subtree(x('subscriptions', { xmlns: SN })) }), options);
  const list = reply.data?.child('subscriptions', SN);
  return (list?.childrenNamed('subscription', SN) ?? []).flatMap((s) => {
    const id = count(s, 'id');
    if (id === undefined) return [];
    const dsEl = s.child('datastore', YP);
    const datastore = dsEl === undefined ? undefined : qualifiedIdentity(dsEl.text(), dsEl, ctx.moduleOf);
    const receivers = (s.child('receivers', SN)?.childrenNamed('receiver', SN) ?? []).map((r): ReceiverInfo => {
      const info: Record<string, unknown> = { name: leaf(r, 'name', SN) ?? '' };
      const sent = count(r, 'sent-event-records');
      const excluded = count(r, 'excluded-event-records');
      const state = leaf(r, 'state', SN);
      if (sent !== undefined) info['sentEventRecords'] = sent;
      if (excluded !== undefined) info['excludedEventRecords'] = excluded;
      if (state !== undefined) info['state'] = state;
      return Object.freeze(info as unknown as ReceiverInfo);
    });
    const stream = leaf(s, 'stream', SN);
    const stopTime = leaf(s, 'stop-time', SN);
    return [Object.freeze({
      id,
      ...(stream !== undefined ? { stream } : {}),
      ...(datastore !== undefined ? { datastore } : {}),
      ...(stopTime !== undefined ? { stopTime } : {}),
      receivers: Object.freeze(receivers),
    })];
  });
}

/** The shape of `client.content.subscriptions.support`. */
export type SupportReader = (options?: RpcOptions & { readonly refresh?: boolean }) => Promise<SubscriptionSupport>;

/** Each session's support read, shared by its ops (establish checks it) and its content (support()). */
const supportCaches = new WeakMap<object, { cached: Promise<SubscriptionSupport> | undefined }>();

/** The session's `support()`: read once from the YANG library, then cached for every caller on the session. */
export function supportReader(ctx: ExtensionContext): SupportReader {
  let cache = supportCaches.get(ctx.sessionKey);
  if (cache === undefined) {
    cache = { cached: undefined };
    supportCaches.set(ctx.sessionKey, cache);
  }
  const shared = cache;
  return (options = {}) => {
    if (shared.cached === undefined || options.refresh === true) {
      // Shared by every caller, so it doesn't carry one caller's signal; each caller's own signal is raced below.
      const { timeout } = options;
      const reading = readSupport(ctx, { ...(timeout !== undefined ? { timeout } : {}), ...(options.refresh === true ? { refresh: true } : {}) });
      shared.cached = reading;
      reading.catch(() => {
        if (shared.cached === reading) shared.cached = undefined;
      });
    }
    return raceSignal(shared.cached, options.signal, 'support');
  };
}
