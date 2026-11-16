/**
 * YANG identities used by the NMDA modules (RFC 8342): datastores and origins,
 * and the XML plumbing for identityref values (`ds:running`, `or:intended`).
 *
 * These are the identities a request names (inputs). Identities a reader
 * returns are module-qualified strings (`ietf-datastores:running`), decoded
 * by ./qualified.ts.
 */

import { DATASTORES_NS, ORIGIN_NS } from '../messages/index.js';
import { x, type XmlElement } from '../xml/index.js';

export { DATASTORES_NS, ORIGIN_NS, NMDA_NS } from '../messages/index.js';
/** The ietf-yang-library module (`/yang-library`). */
export const YANG_LIBRARY_NS = 'urn:ietf:params:xml:ns:yang:ietf-yang-library';

/** A YANG identity: its name and the namespace of the module that defines it. */
export interface Identity {
  /** The identity's name, without a prefix: `running`. */
  readonly name: string;
  /** The XML namespace of the module that defines it. */
  readonly namespace: string;
}

/** The standard NMDA datastores (RFC 8342 §6). */
export type StandardDatastore = 'running' | 'candidate' | 'startup' | 'intended' | 'operational';
/** The names of the standard NMDA datastores. */
export const STANDARD_DATASTORES: readonly StandardDatastore[] = Object.freeze(['running', 'candidate', 'startup', 'intended', 'operational']);
/** A datastore: a standard one by name, or any other datastore identity. */
export type DatastoreRef = StandardDatastore | Identity;

/** The standard origins (RFC 8342 §5.3.4). */
export type StandardOrigin = 'intended' | 'dynamic' | 'system' | 'learned' | 'default' | 'unknown';
/** The names of the standard origins. */
export const STANDARD_ORIGINS: readonly StandardOrigin[] = Object.freeze(['intended', 'dynamic', 'system', 'learned', 'default', 'unknown']);
/** An origin: a standard one by name, or any other origin identity. */
export type OriginRef = StandardOrigin | Identity;

/** Turn a datastore or origin reference into an identity. Throws TypeError for an unknown standard name. */
export function toIdentity(ref: string | Identity, standard: readonly string[], namespace: string, what: string): Identity {
  if (typeof ref === 'string') {
    if (!standard.includes(ref)) throw new TypeError(`Unknown ${what} ${JSON.stringify(ref)}; use one of ${standard.join(', ')} or { name, namespace }`);
    return { name: ref, namespace };
  }
  if (typeof ref !== 'object' || ref === null || typeof ref.name !== 'string' || typeof ref.namespace !== 'string' || ref.name === '' || ref.namespace === '') {
    throw new TypeError(`A ${what} must be one of ${standard.join(', ')} or { name, namespace }`);
  }
  if (!/^[A-Za-z_][\w.-]*$/.test(ref.name)) throw new TypeError(`Invalid ${what} identity name ${JSON.stringify(ref.name)}`);
  return { name: ref.name, namespace: ref.namespace };
}

export const datastoreIdentity = (ref: DatastoreRef): Identity => toIdentity(ref, STANDARD_DATASTORES, DATASTORES_NS, 'datastore');
export const originIdentity = (ref: OriginRef): Identity => toIdentity(ref, STANDARD_ORIGINS, ORIGIN_NS, 'origin');

/**
 * An element whose text is an identityref, with its prefix declared on the
 * element itself so it is in scope wherever the element is placed:
 * `<datastore xmlns:ds="…ietf-datastores">ds:running</datastore>`.
 */
export function identityElement(tag: string, identity: Identity): XmlElement {
  const prefix = identity.namespace === DATASTORES_NS ? 'ds' : identity.namespace === ORIGIN_NS ? 'or' : 'id';
  return x(tag, { [`xmlns:${prefix}`]: identity.namespace }, `${prefix}:${identity.name}`);
}
