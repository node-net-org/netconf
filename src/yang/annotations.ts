/**
 * Annotation namespaces the client names without any schema. Kept apart
 * from schemas.ts, which imports @node-net/yang, so the client facade can use them
 * without loading the YANG machinery (see load.ts).
 */

/** Namespaces of annotations that belong to no data module, for naming them in JSON. */
export const ANNOTATION_NAMESPACES: Readonly<Record<string, string>> = Object.freeze({
  'urn:ietf:params:xml:ns:netconf:base:1.0': 'ietf-netconf',
  'urn:ietf:params:xml:ns:yang:ietf-netconf-with-defaults': 'ietf-netconf-with-defaults',
  'urn:ietf:params:xml:ns:yang:ietf-origin': 'ietf-origin',
});

/** Module name → namespace, for the edit annotations and the annotation modules, whatever the server lists. */
export const ANNOTATION_MODULES_BY_NAME: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(Object.entries(ANNOTATION_NAMESPACES).map(([ns, m]) => [m, ns])),
  yang: 'urn:ietf:params:xml:ns:yang:1',
});
