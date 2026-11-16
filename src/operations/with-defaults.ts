/**
 * RFC 6243 with-defaults (design §8): choose how a server reports data nodes
 * that are at their default values.
 *
 * ```ts
 * import { withDefaults } from '@node-net/netconf/operations/with-defaults';
 *
 * const client = await connect({ transport, extensions: [withDefaults] });
 * client.content.withDefaults.basicMode;                         // e.g. 'explicit'
 * await client.ops.getConfig({ withDefaults: 'report-all' });    // include defaults
 * ```
 *
 * The extension augments `<get>`, `<get-config>` and `<copy-config>` with a
 * `<with-defaults>` parameter, the way the ietf-netconf-with-defaults YANG
 * module augments their input. On `<copy-config>`, servers honour it only
 * when the target is a URL (RFC 6243 §4.5.1); with a datastore target they
 * use their basic mode and ignore it.
 *
 * See [with-defaults](/guide/extensions#with-defaults).
 *
 * @packageDocumentation
 */

import { CapabilityError } from '../errors.js';
import { WITH_DEFAULTS_NS } from '../messages/index.js';
import { XmlElement, x } from '../xml/index.js';
import type { OperationRequest } from './base.js';
import { defineExtension, type Augment, type ExtensionContext, type ParamDescriptor } from './extension.js';
import { WITH_DEFAULTS_MODES, defaultsHandling, type WithDefaultsMode, type WithDefaultsContent } from './defaults-modes.js';

export {
  WITH_DEFAULTS_CAPABILITY,
  WITH_DEFAULTS_MODES,
  defaultsHandling,
  type WithDefaultsMode,
  type WithDefaultsContent,
} from './defaults-modes.js';

export { WITH_DEFAULTS_NS } from '../messages/index.js';
/** Namespace of the `wd:default` attribute on `report-all-tagged` replies (RFC 6243 §6). */
export const DEFAULT_ATTRIBUTE_NS = 'urn:ietf:params:xml:ns:netconf:default:1.0';


declare module './base.js' {
  interface GetOptions {
    /** How to report nodes at their default values (RFC 6243). Needs the with-defaults extension. */
    readonly withDefaults?: WithDefaultsMode;
  }
  interface GetConfigOptions {
    /** How to report nodes at their default values (RFC 6243). Needs the with-defaults extension. */
    readonly withDefaults?: WithDefaultsMode;
  }
  interface CopyConfigOptions {
    /**
     * How to report nodes at their default values (RFC 6243). Needs the
     * with-defaults extension. Servers honour it only for a URL target.
     */
    readonly withDefaults?: WithDefaultsMode;
  }
}

/**
 * True if an element in a `report-all-tagged` reply is marked as default data
 * (`wd:default="true"` or `"1"`, RFC 6243 §6).
 *
 * RFC 6243 puts the attribute in {@link DEFAULT_ATTRIBUTE_NS}. libyang-based
 * servers (netopeer2) put it in the YANG module's namespace,
 * {@link WITH_DEFAULTS_NS}, so both are accepted.
 */
export function isDefault(element: XmlElement): boolean {
  const value = element.attr('default', DEFAULT_ATTRIBUTE_NS) ?? element.attr('default', WITH_DEFAULTS_NS);
  return value === 'true' || value === '1';
}

const param: ParamDescriptor = Object.freeze({
  name: 'withDefaults',
  kind: 'option',
  type: 'string',
  description: 'How to report nodes at their default values (RFC 6243)',
  values: WITH_DEFAULTS_MODES,
  extension: 'withDefaults',
});

function augment(operation: string): Augment {
  return {
    operation,
    params: [param],
    apply: (request, args, ctx) => {
      const mode = args['withDefaults'];
      if (typeof mode !== 'string' || !(WITH_DEFAULTS_MODES as readonly string[]).includes(mode)) {
        throw new TypeError(`withDefaults must be one of ${WITH_DEFAULTS_MODES.join(', ')}`);
      }
      checkMode(operation, mode as WithDefaultsMode, ctx);
      return appendChild(request, x('with-defaults', { xmlns: WITH_DEFAULTS_NS }, mode));
    },
  };
}

function checkMode(operation: string, mode: WithDefaultsMode, ctx: ExtensionContext): void {
  if (ctx.capabilityCheck === 'off') return;
  const { basicMode, supportedModes } = defaultsHandling(ctx.serverCapabilities);
  if (supportedModes.includes(mode)) return;
  const what = basicMode === undefined ? ':with-defaults:1.0' : `with-defaults mode ${mode}`;
  if (ctx.capabilityCheck === 'strict') throw new CapabilityError(what, operation);
  ctx.logger.warn?.(`${operation} with-defaults ${mode} needs ${what}, which the server didn't advertise; sending anyway`);
}

function appendChild(request: OperationRequest, child: XmlElement): OperationRequest {
  const el = request.element;
  return {
    ...request,
    element: new XmlElement({
      name: el.name,
      ns: el.ns,
      prefix: el.prefix,
      attributes: el.attributes,
      declarations: el.declarations,
      inScope: el.inScope,
      children: [...el.children, child],
    }),
  };
}

/** The with-defaults extension. Enable it with `connect({ extensions: [withDefaults] })`. */
export const withDefaults = defineExtension({
  id: 'withDefaults',
  /** A one-line summary of the extension. */
  description: 'RFC 6243: choose how nodes at their default values are reported',
  requires: [':with-defaults:1.0'],
  augments: [augment('get'), augment('get-config'), augment('copy-config')],
  content: (ctx): WithDefaultsContent => defaultsHandling(ctx.serverCapabilities),
});
