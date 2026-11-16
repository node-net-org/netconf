// Framing throughput on large replies: encode a message, cut the framed bytes
// into network-sized reads, and decode them again, in both framing modes.
//
//   npm run build && node scripts/bench-framing.mjs
//
// Prints the median of several runs in MB/s, so a change to the framing code
// can be compared with the numbers from before it (docs: PKG-06).

import { encodeMessage, FrameDecoder } from '../dist/transport/framing/index.js';

const MESSAGE_BYTES = 8 * 1024 * 1024;
const READ_BYTES = 16 * 1024;
const RUNS = 9;

function message() {
  const row = '<interface><name>ge-0/0/1</name><description>uplink to core – ü</description><enabled>true</enabled></interface>';
  const rows = [];
  for (let n = 0; n < MESSAGE_BYTES; n += row.length) rows.push(row);
  return `<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="1"><data>${rows.join('')}</data></rpc-reply>`;
}

function encode(text, mode) {
  const start = performance.now();
  const framed = encodeMessage(text, mode);
  return framed.length / 1e6 / ((performance.now() - start) / 1000);
}

function run(text, mode) {
  const framed = encodeMessage(text, mode);
  const decoder = new FrameDecoder({ mode, maxMessageBytes: 1024 * 1024 * 1024 });
  const start = performance.now();
  let got;
  for (let off = 0; off < framed.length; off += READ_BYTES) {
    decoder.push(framed.subarray(off, off + READ_BYTES));
    got ??= decoder.next();
  }
  got ??= decoder.next();
  const ms = performance.now() - start;
  if (got?.length !== text.length) throw new Error(`decoded ${got?.length} characters, expected ${text.length}`);
  return framed.length / 1e6 / (ms / 1000);
}

const text = message();
for (const mode of ['eom', 'chunked']) {
  run(text, mode); // warm up
  const median = (f) => Array.from({ length: RUNS }, f).sort((a, b) => a - b)[RUNS >> 1].toFixed(0);
  console.log(`${mode.padEnd(7)} encode ${median(() => encode(text, mode))} MB/s, decode ${median(() => run(text, mode))} MB/s`);
}
