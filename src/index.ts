/**
 * @node-net/netconf: a NETCONF client for Node.js.
 *
 * Import from `@node-net/netconf` in Node.js. It has everything in
 * `@node-net/netconf/core` (the protocol, the client, the built-in device profiles
 * and the connection interface) plus what needs Node.js: the SSH and TLS
 * transports, call home, known_hosts, `duplexConnection()` for a Node stream
 * of your own, and loading device profiles from files. Its connect() and
 * withClient() and reconnecting() can also read YANG modules from directories.
 *
 * Import from `@node-net/netconf/core` instead when the code must run outside
 * Node.js, such as in a browser or a worker, over a transport you provide.
 * See [Outside Node.js](/guide/low-level#outside-node-js).
 *
 * @packageDocumentation
 */

import type { ClientHost } from './client-yang.js';
import { openClient, reconnectWith, withOpenClient, type ConnectOptions, type NetconfClient, type ReconnectOptions } from './client.js';
import type { Reconnecting } from './reconnect.js';
import type { ContentMap, Extension, OpsMap } from './operations/index.js';
import { directorySource } from './yang/files.js';

// connect() and withClient() below shadow core's: a module's own exports win over `export *`.
export * from './core.js';

/** What Node.js offers the client beyond the core: reading YANG module directories. */
const NODE: ClientHost = { directories: directorySource };

/**
 * Connect to a NETCONF server: open the connection, start the NETCONF session
 * (hello, framing), and apply the device profile. Resolves once the client is
 * ready for RPCs.
 */
export function connect<const E extends readonly Extension[] = []>(
  options: ConnectOptions<E>,
): Promise<NetconfClient<OpsMap<E>, ContentMap<E>>> {
  return openClient(options, NODE);
}

/**
 * Connect, run `fn`, and always close the client afterwards, whether `fn`
 * succeeds or throws.
 */
export function withClient<const E extends readonly Extension[] = [], T = unknown>(
  options: ConnectOptions<E>,
  fn: (client: NetconfClient<OpsMap<E>, ContentMap<E>>) => Promise<T>,
): Promise<T> {
  return withOpenClient(options, NODE, fn);
}

/**
 * Connect, and connect again with backoff each time the session is lost,
 * for as long as you iterate. The same as @node-net/netconf/core's
 * `reconnecting()`, with Node's YANG directory reading (see `connect`).
 * See [Reconnecting](/guide/connecting#reconnecting).
 */
export function reconnecting<const E extends readonly Extension[] = []>(
  options: ReconnectOptions<E>,
): Reconnecting<NetconfClient<OpsMap<E>, ContentMap<E>>> {
  return reconnectWith(options, NODE);
}

export {
  listenCallHome,
  CallHomeListener,
  CALL_HOME_SSH_PORT,
  CALL_HOME_TLS_PORT,
  type CallHomeCall,
  type CallHomeCaller,
  type CallHomeConnectOptions,
  type CallHomeDevice,
  type CallHomeEvents,
  type CallHomeOptions,
  type CallHomeRemote,
  type CallHomeSshListen,
  type CallHomeTlsListen,
  type CallHomeTransport,
} from './call-home.js';

export {
  ssh,
  tls,
  DEFAULT_SSH_ALGORITHMS,
  DEFAULT_TLS_CIPHERS,
  duplexConnection,
  type DuplexConnectionOptions,
  type Pem,
  type TlsOptions,
  knownHosts,
  knownHostsFile,
  fingerprintOf,
  sha256Fingerprint,
  toVerifier,
  INSECURE_ACCEPT_ANY,
  type HostKeyInfo,
  type HostKeyPolicy,
  type HostKeyVerifier,
  type Secret,
  type KeyboardInteractiveChallenge,
  type KeyboardInteractiveHandler,
  type SshAlgorithmEdit,
  type SshAlgorithmLists,
  type SshAlgorithms,
  type SshEndpoint,
  type SshJumpHost,
} from './transport/node.js';

export { loadDeviceProfile, loadDeviceProfiles, BUILTIN_PROFILES_DIR, type ProfileLoadOptions } from './devices/profile-loader.js';
