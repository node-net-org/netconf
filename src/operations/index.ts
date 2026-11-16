/**
 * Operations layer (design §3, §8): the RFC 6241 base operations, their
 * descriptors, and the protocol-module (Extension) mechanism. This barrel is
 * the layer's public surface. Each extension has its own entry point,
 * `@node-net/netconf/operations/<module>`, and is not re-exported here.
 */

export * as base from './base.js';
export {
  invoke,
  subtree,
  xpath,
  type CapabilityCheck,
  type CommitOptions,
  type ConfigSource,
  type ConfigTarget,
  type CopyConfigOptions,
  type Datastore,
  type EditConfigOptions,
  type EditOperation,
  type Filter,
  type XPathFilter,
  type GetConfigOptions,
  type GetOptions,
  type OperationRequest,
} from './base.js';
export {
  convertJsonArgs,
  isJsonFilter,
  isJsonInput,
  splitFormat,
  READ_AS_XML_HINT,
  type FormatOptions,
  type JsonDatastore,
  type JsonFormat,
  type JsonInputDatastores,
  type JsonOptions,
  type ToJson,
  type ToJsonOptions,
  type ToXml,
  type ToXmlOptions,
  type XmlFormat,
  type YangJsonObject,
  type YangJsonValue,
} from './json.js';
export { BASE_OPERATIONS, BASE_REQUESTS, buildOperation } from './descriptors.js';
export { moduleName, qualifiedIdentity, qualifiedPath, WELL_KNOWN_MODULES, type ModuleOf } from './qualified.js';
export {
  defineExtension,
  validateExtensions,
  missingRequirement,
  applyAugments,
  extensionContext,
  type Augment,
  type Extension,
  type ExtensionContext,
  type OpsMap,
  type ContentMap,
  type OperationDescriptor,
  type ParamDescriptor,
  type OperationParamType,
  type RequestArgs,
  type RequestBuilder,
} from './extension.js';
