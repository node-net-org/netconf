/**
 * Messages layer (design §3, §5.4): the NETCONF session. This barrel is the
 * layer's public surface for the layers above.
 */

export {
  openSession,
  Session,
  DEFAULT_SESSION_TIMEOUTS,
  RPC_CHANNEL,
  type HelloAdjustments,
  type Notification,
  type RpcContext,
  type RpcGuard,
  type RpcOptions,
  type RpcReply,
  type SessionEvents,
  type SessionMessage,
  type SessionOptions,
  type SessionState,
  type SessionTimeouts,
  type SessionWarning,
} from './session.js';
/** @internal For the client only: core and the root entry don't export these. */
export { openClientSession, logSwitchOf } from './session.js';
export { SESSION_QUIRK_NAMES, type SessionQuirks } from './quirks.js';
export {
  RpcError,
  parseRpcErrors,
  type RpcErrorDetail,
  type RpcErrorSeverity,
  type RpcErrorTag,
  type RpcErrorType,
  type StandardErrorTag,
} from './rpc-error.js';
export { CapabilitySet, parseCapability, type Capability, type ModuleCapability } from './capabilities.js';
export { type ServerHello } from './hello.js';
export { TypedEmitter } from './emitter.js';
export {
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
} from './constants.js';
