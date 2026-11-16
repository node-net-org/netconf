/**
 * A minimal ssh-agent (draft-miller-ssh-agent) on a Unix socket, holding one
 * ed25519 key: enough for ssh2's agent authentication in tests, without
 * depending on OpenSSH being installed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';
import { ed25519KeyPair } from './ssh-server.js';

export interface TestSshAgent {
  readonly socketPath: string;
  /** The key's public half, OpenSSH format, for the server to accept. */
  readonly publicKey: string;
  /** Sign requests served. */
  readonly signatures: () => number;
  close(): Promise<void>;
}

const string = (b: Buffer): Buffer => Buffer.concat([u32(b.length), b]);
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

export async function startSshAgent(): Promise<TestSshAgent> {
  const pair = ed25519KeyPair();
  const key = utils.parseKey(pair.private);
  if (key instanceof Error) throw key;
  const blob = key.getPublicSSH();
  const dir = mkdtempSync(join(tmpdir(), 'nn-agent-'));
  const socketPath = join(dir, 'agent.sock');
  let signatures = 0;
  const server: Server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('error', () => undefined);
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const msg = buf.subarray(4, 4 + buf.readUInt32BE(0));
        buf = buf.subarray(4 + msg.length);
        let reply: Buffer;
        if (msg[0] === 11) {
          // REQUEST_IDENTITIES → IDENTITIES_ANSWER
          reply = Buffer.concat([Buffer.from([12]), u32(1), string(blob), string(Buffer.from('test'))]);
        } else if (msg[0] === 13) {
          // SIGN_REQUEST: string key, string data, uint32 flags → SIGN_RESPONSE
          const keyLen = msg.readUInt32BE(1);
          const dataLen = msg.readUInt32BE(5 + keyLen);
          const data = msg.subarray(9 + keyLen, 9 + keyLen + dataLen);
          const sig = key.sign(data);
          signatures++;
          reply = Buffer.concat([Buffer.from([14]), string(Buffer.concat([string(Buffer.from('ssh-ed25519')), string(sig)]))]);
        } else {
          reply = Buffer.from([5]); // FAILURE
        }
        sock.write(Buffer.concat([u32(reply.length), reply]));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    publicKey: pair.public,
    signatures: () => signatures,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        }),
      ),
  };
}
