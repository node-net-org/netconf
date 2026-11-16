/**
 * RFC 9144 NMDA datastore comparison (design §8): ask the server how two
 * datastores differ, instead of fetching both and diffing them here.
 *
 * ```ts
 * import { compare } from '@node-net/netconf/operations/compare';
 *
 * const client = await connect({ transport, extensions: [compare] });
 * const diff = await client.ops.compare.datastores({
 *   source: 'running',
 *   target: 'candidate',
 *   filter: client.content.toXPath('/ietf-interfaces:interfaces'),
 * });
 * if (diff.noMatches) console.log('no differences');
 * for (const edit of diff.edits) console.log(edit.operation, edit.target, edit.value, edit.sourceValue);
 * ```
 *
 * The differences are a YANG Patch (RFC 8072) that would turn `source` into
 * `target`: `create` for a node only in the target, `delete` (or `remove`)
 * for one only in the source, `replace` for a changed one. `value` is the
 * node as in the target and `sourceValue` the node as in the source. The
 * server decides how to group edits (one replace of a container, or one per
 * leaf), and how to write `target`: RFC 9144 doesn't fix its root, and
 * Clixon makes it relative to the filter's selected node, so it is kept as
 * the server's text.
 *
 * `<no-matches/>` means nothing was compared. RFC 9144 defines it as "the
 * filter matched nothing"; Clixon also sends it when the datastores are
 * identical. Either way there are no differences to report.
 *
 * The module (ietf-nmda-compare) is YANG 1.1, so it is found in the YANG
 * library, not the hello: the first datastores() call reads the library (once per
 * client) and refuses with CapabilityError if the module isn't there.
 * `client.ops.run('compare', …)`, which tools such as the CLI use,
 * checks only the hello's capabilities and lets the server refuse.
 *
 * RFC 9144 names no error tags. Clixon 7.9 refuses `all`, `report-origin`
 * and subtree filters with `operation-not-supported`, and a datastore it
 * doesn't have with `operation-failed`.
 *
 * See [compare](/guide/extensions#compare).
 *
 * @packageDocumentation
 */

import { AbortError, CapabilityError, ProtocolError } from '../errors.js';
import type { RpcOptions } from '../messages/index.js';
import { x, type XmlElement, type XmlNode } from '../xml/index.js';
import type { Filter, OperationRequest } from './base.js';
import { raceSignal } from './abort.js';
import { splitRpcOptions } from './args.js';
import { defineExtension, type ExtensionContext, type OperationDescriptor } from './extension.js';
import { STANDARD_DATASTORES, datastoreIdentity, identityElement, type DatastoreRef } from './identities.js';
import { loadYangLibrary } from './yang-library.js';
import { decodeYangPatch, type PatchEdit } from './yang-patch.js';
import { convertJsonArgs, isJsonFilter, JSON_NEEDS_CLIENT, type JsonOptions, type YangJsonObject } from './json.js';

export type { DatastoreRef, Identity, StandardDatastore } from './identities.js';
export type { PatchEdit } from './yang-patch.js';

/** Namespace of the ietf-nmda-compare module (`<compare>`). */
export const NMDA_COMPARE_NS = 'urn:ietf:params:xml:ns:yang:ietf-nmda-compare';
/** The module's name, as the YANG library lists it. */
export const NMDA_COMPARE_MODULE = 'ietf-nmda-compare';

/** What `client.ops.compare.datastores()` compares: two datastores, and optionally a filter. */
export interface CompareOptions {
  /** The datastore the patch starts from. */
  readonly source: DatastoreRef;
  /** The datastore the patch leads to. */
  readonly target: DatastoreRef;
  /**
   * Compare every data node. Without it, when one side is `operational` and
   * the other holds only configuration, state data is left out.
   */
  readonly all?: boolean;
  /** Include `or:origin` annotations from `operational` in the values. */
  readonly reportOrigin?: boolean;
  /**
   * Compare only part of the datastores: `subtree(...)`, `xpath(...)` /
   * `client.content.toXPath(path)` (needs `:xpath`), or an RFC 7951 JSON
   * object, converted to a subtree filter with the source datastore's schema.
   */
  readonly filter?: Filter | YangJsonObject;
  /** JSON input options for a JSON `filter` (see `JsonOptions`). Never sent. */
  readonly json?: JsonOptions;
}

/** One difference. */
export interface CompareEdit extends PatchEdit {
  /**
   * The node as it is in the source, for replace, delete, remove, merge and
   * move edits. Empty when the server sent none (Clixon sends the removed
   * node of a delete in `value` instead).
   */
  readonly sourceValue: readonly XmlElement[];
}

/** How two datastores differ, as the server reported it: an RFC 8072 YANG Patch from source to target. */
export interface CompareResult {
  /** True when the server answered `<no-matches/>`: nothing was compared, so there are no edits. */
  readonly noMatches: boolean;
  /** The patch-id of the differences (absent for no-matches). */
  readonly patchId?: string;
  /** The server's comment on the differences, if any. */
  readonly comment?: string;
  /** The differences, in the server's order (empty for no-matches). */
  readonly edits: readonly CompareEdit[];
}

/** What `client.ops.compare` holds. */
export interface CompareOps {
  /**
   * `<compare>` (RFC 9144): ask the server how `target` differs from
   * `source`. Compare with `client.content.compareDatastores()`, which reads
   * both configuration datastores and diffs them here, on any server.
   */
  datastores(options: CompareOptions & RpcOptions): Promise<CompareResult>;
}

// --- requests -------------------------------------------------------------------------

function flag(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new TypeError(`compare: ${name} must be a boolean`);
  return value;
}

function filterElement(filter: unknown): { element: XmlElement | undefined; requires: string[] } {
  if (filter === undefined) return { element: undefined, requires: [] };
  if (isJsonFilter(filter)) throw new TypeError(JSON_NEEDS_CLIENT);
  const f = (typeof filter === 'object' && filter !== null ? filter : {}) as { readonly type?: unknown; readonly content?: unknown; readonly select?: unknown; readonly namespaces?: unknown };
  if (f.type === 'subtree' && Array.isArray(f.content)) {
    return { element: x('subtree-filter', f.content as readonly XmlNode[]), requires: [] };
  }
  if (f.type === 'xpath' && typeof f.select === 'string') {
    if (f.select.trim() === '') throw new TypeError('compare: the XPath filter is empty');
    const declarations: Record<string, string> = {};
    for (const [prefix, uri] of Object.entries((f.namespaces ?? {}) as Readonly<Record<string, string>>)) declarations[`xmlns:${prefix}`] = uri;
    return { element: x('xpath-filter', declarations, f.select), requires: [':xpath'] };
  }
  throw new TypeError('compare: filter must be subtree(...), xpath(...) or client.content.toXPath(path)');
}

/** Build a `<compare>` request from plain arguments. Sends nothing. */
export function compareRequest(args: Readonly<Record<string, unknown>>): OperationRequest {
  const source = datastoreIdentity(args['source'] as DatastoreRef);
  const target = datastoreIdentity(args['target'] as DatastoreRef);
  const all = flag(args['all'], 'all');
  const reportOrigin = flag(args['reportOrigin'], 'reportOrigin');
  const filter = filterElement(args['filter']);
  return {
    element: x('compare', { xmlns: NMDA_COMPARE_NS },
      identityElement('source', source),
      identityElement('target', target),
      all && x('all'),
      reportOrigin && x('report-origin'),
      filter.element,
    ),
    requires: filter.requires,
  };
}

// --- replies --------------------------------------------------------------------------

/** Read a `<compare>` reply: `<no-matches/>` or `<differences>`. */
export function parseCompareReply(reply: XmlElement): CompareResult {
  if (reply.child('no-matches', NMDA_COMPARE_NS) !== undefined) return Object.freeze({ noMatches: true, edits: Object.freeze([]) });
  const differences = reply.child('differences', NMDA_COMPARE_NS);
  if (differences === undefined) throw new ProtocolError('compare reply has neither <no-matches/> nor <differences>');
  const patch = differences.elements.find((e) => e.name === 'yang-patch');
  if (patch === undefined) throw new ProtocolError('compare reply has <differences> but no <yang-patch>');
  const decoded = decodeYangPatch(patch, (edit, ns): { sourceValue: readonly XmlElement[] } => ({
    sourceValue: Object.freeze([...(edit.child('source-value', ns)?.elements ?? [])]),
  }));
  return Object.freeze({ noMatches: false, ...decoded });
}

// --- support --------------------------------------------------------------------------

type Support = 'yes' | 'no';

async function readSupport(ctx: ExtensionContext, options: RpcOptions): Promise<Support> {
  if (ctx.serverCapabilities.helloModule(NMDA_COMPARE_MODULE) !== undefined) return 'yes';
  if (!ctx.serverCapabilities.has(':yang-library:1.1')) return 'no';
  const library = await loadYangLibrary(ctx, options);
  const modules = [...library.datastores.flatMap((d) => d.modules), ...library.moduleSets.flatMap((s) => s.modules)];
  return modules.some((m) => m.name === NMDA_COMPARE_MODULE) ? 'yes' : 'no';
}

/**
 * The read is shared by every datastores() call waiting for it, so it runs without
 * any one caller's AbortSignal (each caller stops waiting when its own signal
 * aborts). The first caller's timeout bounds the read, and the compare itself
 * then has the full timeout again.
 */
function sharedReadOptions(options: RpcOptions): RpcOptions {
  return options.timeout !== undefined ? { timeout: options.timeout } : {};
}

// --- descriptor and the extension --------------------------------------------------------

const DATASTORE_DESCRIPTION = 'running, candidate, startup, intended or operational';

const COMPARE: OperationDescriptor = Object.freeze({
  name: 'compare',
  namespace: NMDA_COMPARE_NS,
  method: 'datastores',
  description: 'Show how two NMDA datastores differ (RFC 9144)',
  mutates: false,
  requires: [':yang-library:1.1'],
  params: Object.freeze([
    Object.freeze({ name: 'source', kind: 'positional', type: 'datastore', values: STANDARD_DATASTORES, required: true, description: `The datastore to compare from: ${DATASTORE_DESCRIPTION}` } as const),
    Object.freeze({ name: 'target', kind: 'positional', type: 'datastore', values: STANDARD_DATASTORES, required: true, description: `The datastore to compare with: ${DATASTORE_DESCRIPTION}` } as const),
    Object.freeze({ name: 'all', kind: 'option', type: 'boolean', description: 'Compare all data nodes, not only those both datastores can hold' } as const),
    Object.freeze({ name: 'reportOrigin', kind: 'option', type: 'boolean', description: 'Include origin annotations from operational' } as const),
    Object.freeze({ name: 'filter', kind: 'option', type: 'filter', description: 'Compare only part of the datastores: a subtree filter (XML or RFC 7951 JSON), or an XPath filter (needs :xpath)' } as const),
  ]),
});

/** The RFC 9144 compare extension. Enable it with `connect({ extensions: [compare] })`. */
export const compare = defineExtension({
  id: 'compare',
  /** A one-line summary of the extension. */
  description: 'RFC 9144: compare two NMDA datastores on the device',
  requires: [':yang-library:1.1'],
  descriptors: [COMPARE],
  requests: { compare: compareRequest },
  ops: (ctx): CompareOps => {
    let support: Promise<Support> | undefined;
    const supported = (options: RpcOptions): Promise<Support> => {
      if (support === undefined) {
        const reading = readSupport(ctx, sharedReadOptions(options));
        support = reading;
        // A failed read isn't kept, so the next compare tries again.
        reading.catch(() => {
          if (support === reading) support = undefined;
        });
      }
      return support;
    };
    return {
      datastores: async (options) => {
        const { rpc, rest } = splitRpcOptions(options);
        const { json, ...given } = rest;
        const args = await convertJsonArgs(ctx.toXml, given, { filter: datastoreIdentity(given.source) }, json);
        const request = compareRequest(args);
        // Capabilities the hello settles are checked first, so a refusal sends nothing at all.
        if (ctx.capabilityCheck === 'strict') {
          for (const cap of [':yang-library:1.1', ...request.requires]) {
            if (!ctx.serverCapabilities.has(cap)) throw new CapabilityError(cap, 'compare');
          }
        }
        if (ctx.capabilityCheck !== 'off') {
          let found: Support;
          try {
            found = await raceSignal(supported(rpc), rpc.signal, 'compare');
          } catch (err) {
            if (ctx.capabilityCheck === 'strict' || err instanceof AbortError) throw err;
            ctx.logger.warn?.(`compare couldn't read the YANG library to check for ${NMDA_COMPARE_MODULE}; sending anyway`, { err });
            found = 'yes';
          }
          if (found === 'no') {
            if (ctx.capabilityCheck === 'strict') throw new CapabilityError(NMDA_COMPARE_MODULE, 'compare');
            ctx.logger.warn?.(`compare needs the ${NMDA_COMPARE_MODULE} module, which the server's YANG library doesn't list; sending anyway`);
          }
        }
        const reply = await ctx.invoke(request, rpc);
        return parseCompareReply(reply.element);
      },
    };
  },
});
