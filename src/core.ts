/**
 * @node-net/netconf/core: the part of @node-net/netconf that needs nothing from Node.js:
 * the protocol, the client, the built-in device profiles, and the connection
 * interface with an in-memory pair (`connectionPair()`). It runs in any
 * JavaScript runtime, such as a browser or a worker, over a transport you
 * provide.
 *
 * In Node.js, import from `@node-net/netconf` instead: it re-exports all of this
 * and adds the SSH and TLS transports, call home, known_hosts, and loading
 * device profiles and YANG modules from files. Without Node.js, pass YANG
 * modules as a `ModuleSource`, such as `memorySource()` from `@node-net/yang/core`.
 * See [Outside Node.js](/guide/low-level#outside-node-js).
 *
 * @packageDocumentation
 */

// A guardrail (dependency-cruiser, ESLint and portable:check) keeps everything
// this file reaches free of Node built-ins and Node-only globals.

export {
  NetconfError,
  XmlError,
  FramingError,
  HelloError,
  TransportError,
  AuthenticationError,
  HostKeyError,
  CertificateError,
  TimeoutError,
  AbortError,
  SessionClosedError,
  ProtocolError,
  CapabilityError,
  SchemaUnavailableError,
  type NetconfErrorOptions,
  type TimeoutPhase,
  type AuthenticationReason,
  type AuthenticationErrorOptions,
} from './errors.js';

export { LOG_LEVELS, redactXml, type Logger, type LogLevel } from './logger.js';

export {
  connect,
  withClient,
  NetconfClient,
  DEFAULT_TIMEOUTS,
  type ConnectOptions,
  type CompareDatastoresOptions,
  type DatastoreSource,
  type ServerDatastore,
  type ServerDatastores,
  type ModuleNamespaceInfo,
  type NamespaceSource,
  type DeclaredFeature,
  type ModulesOptions,
  type ServerModule,
  type ServerModules,
  type ConfigureOptions,
  type ReadOptions,
  type ContentJsonFormat,
  type InvokeInput,
  type InvokeOptions,
  type ContentXmlFormat,
  type Timeouts,
  type TransportInfo,
  type DeviceOps,
  type YangOptions,
  ClientOps,
  ClientContent,
  reconnecting,
  type ReconnectOptions,
} from './client.js';
export { Reconnecting, type ReconnectingOptions, type RetryInfo, type RetryOptions } from './reconnect.js';
export { YangCache, YangDataError, type DataIssue, type ModuleSource, type ModuleText } from './yang/index.js';

export {
  openSession,
  Session,
  RPC_CHANNEL,
  DEFAULT_SESSION_TIMEOUTS,
  RpcError,
  CapabilitySet,
  parseCapability,
  NETCONF_NS,
  NOTIFICATION_NS,
  BASE_1_0,
  BASE_1_1,
  CAPABILITY_PREFIX,
  YANG_NS,
  MONITORING_NS,
  WITH_DEFAULTS_NS,
  DATASTORES_NS,
  ORIGIN_NS,
  NMDA_NS,
  type BaseVersion,
  type Capability,
  type HelloAdjustments,
  type ModuleCapability,
  type Notification,
  type RpcContext,
  type RpcGuard,
  type RpcErrorDetail,
  type RpcErrorSeverity,
  type RpcErrorTag,
  type RpcErrorType,
  type RpcOptions,
  type RpcReply,
  type ServerHello,
  type SessionEvents,
  type SessionMessage,
  type SessionOptions,
  type SessionQuirks,
  type SessionState,
  type SessionTimeouts,
  type SessionWarning,
  type StandardErrorTag,
} from './messages/index.js';

export {
  invoke,
  subtree,
  xpath,
  BASE_OPERATIONS,
  buildOperation,
  defineExtension,
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
  type CapabilityCheck,
  type CommitOptions,
  type ConfigSource,
  type ConfigTarget,
  type CopyConfigOptions,
  type Datastore,
  type EditConfigOptions,
  type Filter,
  type XPathFilter,
  type GetConfigOptions,
  type GetOptions,
  type OperationRequest,
  READ_AS_XML_HINT,
  type FormatOptions,
  type JsonDatastore,
  type JsonFormat,
  type JsonOptions,
  type ToJson,
  type ToJsonOptions,
  type ToXml,
  type ToXmlOptions,
  type XmlFormat,
  type YangJsonObject,
  type YangJsonValue,
} from './operations/index.js';

export {
  openChannel,
  FrameDecoder,
  DEFAULT_MAX_MESSAGE_BYTES,
  connectionPair,
  joinConnections,
  type ConnectionPairOptions,
  // A device profile's connection defaults name the SSH options; the type costs nothing at run time.
  type SshOptions,
  type Connection,
  type ConnectionFactory,
  type ConnectionPeer,
  type ConnectionReceiver,
  type ChannelHandler,
  type ChannelOptions,
  type DecoderOptions,
  type FramingMode,
  type MessageChannel,
} from './transport/index.js';

export {
  XmlElement,
  x,
  parseXml,
  serializeXml,
  toObject,
  XML_NS,
  DEFAULT_PARSE_LIMITS,
  MAX_PARSE_DEPTH,
  type XmlAttribute,
  type XmlElementInit,
  type XmlNode,
  type Attrs,
  type AttrValue,
  type Child,
  type QualifiedAttrValue,
  type XmlParseLimits,
  type XmlParseOptions,
  type SerializeOptions,
  type ToObjectOptions,
  type XmlObject,
  type XmlValue,
} from './xml/index.js';

// Candidate transactions: withCandidate() is a helper, not an extension, and
// configure() is built on it, so it lives here with configure()'s errors.
export {
  CONFIRM_MARGIN_MS,
  DEFAULT_CONFIRM_TIMEOUT,
  LockDeniedError,
  lockHolder,
  PendingCommit,
  TransactionError,
  withCandidate,
  type CandidateChangesOptions,
  type CandidateTx,
  type ConfigureStep,
  type ConfirmedCommitOptions,
  type ConfirmedTransaction,
  type DatastoreChange,
  type PendingCommitState,
  type TransactionOptions,
  type TransactionPhase,
  type TransactionTarget,
} from './operations/transaction.js';
export { ConfigTransaction, PathError, compileNamedPath, namedPath, parsePath, pathXPath, type NamedPathTemplate, type EditOperation, type ContentQuirks, type EditValue, type PathKey, type PathStep, type Workflow } from './content/index.js';
export {
  defineDeviceProfile,
  autoDetect,
  QUIRK_NAMES,
  ProfileError,
  builtinDeviceProfiles,
  type AutoDetect,
  type ConnectionDefaults,
  type DeviceContext,
  type DeviceMatch,
  type ProfileSource,
  type DeviceOperation,
  type DeviceProfile,
  type DeviceProfileSpec,
  type OperationSpec,
  type ProfileParamType,
  type Quirks,
  type YangSettings,
} from './devices/index.js';
