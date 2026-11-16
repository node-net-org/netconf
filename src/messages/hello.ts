import { HelloError } from '../errors.js';
import { x, type XmlElement } from '../xml/index.js';
import { CapabilitySet } from './capabilities.js';
import { BASE_1_0, BASE_1_1, NETCONF_NS, type BaseVersion } from './constants.js';

/** What the server told us in its `<hello>` (RFC 6241 §8.1). */
export interface ServerHello {
  /** The session-id the server assigned. */
  readonly sessionId: number;
  /** The capabilities the server advertised. */
  readonly capabilities: CapabilitySet;
}

/** Capabilities we advertise unless told otherwise: both base versions, so 1.0-only servers still work. */
export const DEFAULT_CLIENT_CAPABILITIES: readonly string[] = [BASE_1_0, BASE_1_1];

const MAX_SESSION_ID = 4294967295;

/**
 * Validate and read a server hello.
 * @throws HelloError if it isn't a hello, has no capabilities, has no base
 *   capability, or has a missing or invalid session-id.
 */
export function parseServerHello(el: XmlElement): ServerHello {
  if (el.name !== 'hello' || el.ns !== NETCONF_NS) {
    throw new HelloError(`Expected <hello> in ${NETCONF_NS}, got <${el.name}> in ${JSON.stringify(el.ns)}`);
  }
  const caps = el.child('capabilities', NETCONF_NS);
  if (caps === undefined) throw new HelloError('Server hello has no <capabilities>');
  const capabilities = new CapabilitySet(caps.childrenNamed('capability', NETCONF_NS).map((c) => c.text()));
  if (capabilities.baseVersions.length === 0) {
    throw new HelloError('Server hello advertises no NETCONF base capability');
  }

  const sid = el.child('session-id', NETCONF_NS)?.text().trim();
  if (sid === undefined) throw new HelloError('Server hello has no <session-id>');
  if (!/^[1-9][0-9]*$/.test(sid) || Number(sid) > MAX_SESSION_ID) {
    throw new HelloError(`Server hello has an invalid session-id ${JSON.stringify(sid)}`);
  }
  return { sessionId: Number(sid), capabilities };
}

export function buildClientHello(capabilities: readonly string[] = DEFAULT_CLIENT_CAPABILITIES): XmlElement {
  return x('hello', { xmlns: NETCONF_NS }, x('capabilities', capabilities.map((c) => x('capability', c))));
}

/**
 * The base version both peers support (RFC 6242 §4.1): 1.1 with chunked
 * framing if both advertise it, otherwise 1.0 with EOM framing.
 * @throws HelloError if there is no common version.
 */
export function negotiateBaseVersion(client: CapabilitySet, server: CapabilitySet): BaseVersion {
  const common = server.baseVersions.filter((v) => client.baseVersions.includes(v));
  const best = common.at(-1);
  if (best === undefined) {
    throw new HelloError(
      `No common NETCONF base version (client: ${client.baseVersions.join(', ') || 'none'}; ` +
        `server: ${server.baseVersions.join(', ') || 'none'})`,
    );
  }
  return best;
}
