/**
 * The Node.js transports (design §5.1): SSH, TLS, call home, known_hosts and
 * the Node stream adapter. Only the Node entry (index.ts) and the call-home
 * facade import this barrel, so @node-net/netconf/core never reaches it.
 */

export { duplexConnection, type DuplexConnectionOptions } from './duplex.js';
export {
  ssh,
  callHomeSsh,
  DEFAULT_SSH_ALGORITHMS,
  type CallHomeSshOptions,
  type KeyboardInteractiveChallenge,
  type KeyboardInteractiveHandler,
  type Secret,
  type SshAlgorithmEdit,
  type SshAlgorithmLists,
  type SshAlgorithms,
  type SshCredentials,
  type SshEndpoint,
  type SshJumpHost,
  type SshOptions,
} from './ssh.js';
export { tls, callHomeTls, DEFAULT_TLS_CIPHERS, type CallHomeTlsOptions, type Pem, type TlsOptions } from './tls.js';
export {
  CALL_HOME_SSH_PORT,
  CALL_HOME_TLS_PORT,
  certificateOf,
  listenTcp,
  remoteOf,
  sshKeyType,
  type CallHomeCaller,
  type CallHomeRemote,
  type CallHomeTransport,
} from './call-home.js';
export {
  fingerprintOf,
  toVerifier,
  knownHosts,
  knownHostsFile,
  INSECURE_ACCEPT_ANY,
  type HostKeyInfo,
  type HostKeyPolicy,
  type HostKeyVerifier,
} from './host-keys.js';
export { sha256Fingerprint } from './fingerprint.js';
