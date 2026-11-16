/**
 * The YANG adapter (design §3.5): RFC 7951 JSON output and input through
 * @node-net/yang. It sits outside the layer stack, like the XML library, and is
 * the only place that imports @node-net/yang; the client facade puts it to work.
 *
 * This barrel holds only what costs no YANG code: the cache, the JSON
 * selection helpers, annotation names, the error class and types. The
 * conversions themselves are in engine.ts, reached through loadYang(), so
 * they load on first use (design §12).
 */

export { YangCache } from './cache.js';
export { loadYang, type YangEngine } from './load.js';
export { ANNOTATION_MODULES_BY_NAME, ANNOTATION_NAMESPACES } from './annotations.js';
export { YangDataError, type DataIssue } from './errors.js';
export type { ConvertOptions, JsonObject } from './convert.js';
export type { DataDifference, DiffOptions } from './diff.js';
export type { EncodeOptions } from './encode.js';
export type { SchemaContext } from './schemas.js';
export { buildSchemaless, projectSchemaless, type ModuleOf, type NamespaceOf } from './schemaless.js';
export { isEmptyValue, selectJson, type JsonStep } from './select.js';
export type { ModuleSource, ModuleText, YangLibrary as SchemaLibrary } from '@node-net/yang/core';
