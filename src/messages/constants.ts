/** NETCONF base namespace (RFC 6241 §3.1). Every protocol message element lives here. */
export const NETCONF_NS = 'urn:ietf:params:xml:ns:netconf:base:1.0';

/** Base protocol capability for NETCONF 1.0 (RFC 6241 §8.1), with end-of-message framing. */
export const BASE_1_0 = 'urn:ietf:params:netconf:base:1.0';
/** Base protocol capability for NETCONF 1.1 (RFC 6241 §8.1), with chunked framing. */
export const BASE_1_1 = 'urn:ietf:params:netconf:base:1.1';

/** Prefix of every standard capability URN, such as `...:candidate:1.0`. */
export const CAPABILITY_PREFIX = 'urn:ietf:params:netconf:capability:';

/** A NETCONF base protocol version: `'1.1'` uses chunked framing, `'1.0'` end-of-message framing. */
export type BaseVersion = '1.0' | '1.1';

/** RFC 5277 notification namespace. `<notification>` messages live here. */
export const NOTIFICATION_NS = 'urn:ietf:params:xml:ns:netconf:notification:1.0';

/**
 * The YANG 1.1 namespace (RFC 7950 §5.3.1): home of the `<action>` operation
 * (§7.15.2) and of the `<non-unique>` and `<missing-choice>` error-info
 * elements (§15.1, §15.6).
 */
export const YANG_NS = 'urn:ietf:params:xml:ns:yang:1';

/** Namespace of the ietf-netconf-monitoring module (RFC 6022 §5); also its capability id. */
export const MONITORING_NS = 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring';

/** Namespace of the `<with-defaults>` parameter, the ietf-netconf-with-defaults module (RFC 6243 §5). */
export const WITH_DEFAULTS_NS = 'urn:ietf:params:xml:ns:yang:ietf-netconf-with-defaults';

/** Namespace of the ietf-datastores module, home of the datastore identities (RFC 8342 §7). */
export const DATASTORES_NS = 'urn:ietf:params:xml:ns:yang:ietf-datastores';

/** Namespace of the ietf-origin module: the origin identities and the `origin` annotation (RFC 8342 §7). */
export const ORIGIN_NS = 'urn:ietf:params:xml:ns:yang:ietf-origin';

/** Namespace of the ietf-netconf-nmda module: `<get-data>` and `<edit-data>` (RFC 8526 §3). */
export const NMDA_NS = 'urn:ietf:params:xml:ns:yang:ietf-netconf-nmda';
