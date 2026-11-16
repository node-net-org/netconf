/**
 * Transport layer (design §3, §5.1, §5.2): connections and RFC 6242 framing.
 * This barrel is the layer's public surface for the messages layer, and it is
 * portable: nothing here needs Node.js. The SSH, TLS, call-home and
 * known_hosts transports are in ./node.ts, which only the Node entry imports.
 */

export type { Connection, ConnectionFactory, ConnectionPeer, ConnectionReceiver } from './types.js';
export { connectionPair, type ConnectionPairOptions } from './memory.js';
export { joinConnections } from './join.js';
export { openChannel, type ChannelHandler, type ChannelOptions, type MessageChannel } from './channel.js';
export { DEFAULT_MAX_MESSAGE_BYTES, FrameDecoder, type DecoderOptions, type FramingMode } from './framing/index.js';
// Types only: a device profile's connection defaults name the SSH options, which costs nothing at run time.
export type { SshOptions } from './ssh.js';
