/**
 * RFC 6243 default-handling modes, shared by the with-defaults and nmda
 * modules. Kept apart from with-defaults.ts, whose `declare module` augments
 * the base option types: importing this file must not add `withDefaults` to
 * getConfig() and friends.
 */

import type { CapabilitySet } from '../messages/index.js';

/** The `:with-defaults:1.0` capability (RFC 6243 §4). */
export const WITH_DEFAULTS_CAPABILITY = 'urn:ietf:params:netconf:capability:with-defaults:1.0';

/** The four retrieval modes (RFC 6243 §3). */
export type WithDefaultsMode = 'report-all' | 'trim' | 'explicit' | 'report-all-tagged';
/** The four retrieval modes, as a list. */
export const WITH_DEFAULTS_MODES: readonly WithDefaultsMode[] = Object.freeze(['report-all', 'trim', 'explicit', 'report-all-tagged']);

/** What `client.content.withDefaults` holds: the server's default handling, from its capability. */
export interface WithDefaultsContent {
  /** The server's basic mode, or undefined if it doesn't advertise `:with-defaults`. */
  readonly basicMode: WithDefaultsMode | undefined;
  /** Every mode the server accepts: its basic mode, then `also-supported`. */
  readonly supportedModes: readonly WithDefaultsMode[];
}

/** Read the basic mode and the modes a server accepts from its capabilities. */
export function defaultsHandling(capabilities: CapabilitySet): WithDefaultsContent {
  const cap = capabilities.get(WITH_DEFAULTS_CAPABILITY);
  if (cap === undefined) return { basicMode: undefined, supportedModes: [] };
  const basic = asMode(cap.params.get('basic-mode'));
  const also = (cap.params.get('also-supported') ?? '').split(',').map((m) => asMode(m.trim()));
  const supported = [...new Set([basic, ...also])].filter((m): m is WithDefaultsMode => m !== undefined);
  return { basicMode: basic, supportedModes: Object.freeze(supported) };
}

function asMode(value: string | undefined): WithDefaultsMode | undefined {
  return (WITH_DEFAULTS_MODES as readonly (string | undefined)[]).includes(value) ? (value as WithDefaultsMode) : undefined;
}
