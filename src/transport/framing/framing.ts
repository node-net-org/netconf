/**
 * RFC 6242 message framing (design §5.2).
 *
 * - End-of-message (EOM) framing, `...]]>]]>`, for NETCONF base:1.0 and the hello exchange.
 * - Chunked framing, `\n#<len>\n<data>...\n##\n`, once both peers advertise base:1.1.
 *
 * The decoder is synchronous and pull-based: push() bytes in, then call next()
 * until it returns undefined. Pulling one message at a time lets the session
 * switch framing straight after the hello, before any later bytes are decoded.
 */

import { FramingError } from '../../errors.js';
import { ByteQueue } from './byte-queue.js';

/** RFC 6242 framing: `'eom'` (end-of-message, base:1.0 and the hello) or `'chunked'` (base:1.1). */
export type FramingMode = 'eom' | 'chunked';

export const EOM_DELIMITER = ']]>]]>';
/** RFC 6242 §4.2: chunk-size is 1..4294967295. */
export const MAX_CHUNK_SIZE = 4294967295;
/** The default largest message accepted, in bytes: 64 MiB. */
export const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

const UTF8_ENCODER = new TextEncoder();
const DELIM = UTF8_ENCODER.encode(EOM_DELIMITER);
const LF = 0x0a;
const HASH = 0x23;
const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;
const MAX_HEADER_DIGITS = 10; // 4294967295

/** Options for a {@link FrameDecoder}. */
export interface DecoderOptions {
  /** The framing to start in. Default `'eom'`. */
  readonly mode?: FramingMode;
  /**
   * Largest message accepted, in bytes of the message itself (chunk headers
   * and the end-of-message delimiter are not counted). A larger message is a
   * fatal FramingError, raised as soon as the limit is passed. However the
   * message is chunked and read, the decoder holds at most about twice this
   * for it while it arrives, plus one copy when it is handed over. Default
   * 64 MiB.
   */
  readonly maxMessageBytes?: number;
}

/**
 * Decodes RFC 6242 framed bytes into whole messages: push() bytes in, then
 * call next() until it returns undefined. See
 * [Decoding bytes you already have](/guide/low-level#decoding-bytes-you-already-have).
 */
export class FrameDecoder {
  private readonly queue = new ByteQueue();
  private readonly maxMessageBytes: number;
  private currentMode: FramingMode;
  private failure: FramingError | undefined;

  // EOM state: bytes already searched for the delimiter.
  private scanned = 0;

  // Chunked state. The current message's chunk payloads are collected in a
  // ByteQueue: small payloads are packed into blocks, and large ones are kept
  // as views of the received arrays until those arrays total maxMessageBytes,
  // then copied. So however a message is chunked and read, it holds at most
  // about twice maxMessageBytes while it arrives. (A view per chunk cost ~140 B
  // of heap each: millions of one-byte chunks, well under the limit, exhausted
  // the heap.)
  private chunkRemaining = 0;
  private readonly message: ByteQueue;
  /** Set when switching to chunked: tolerate stray whitespace left over from EOM framing. */
  private atSwitch = false;

  constructor(options: DecoderOptions = {}) {
    this.currentMode = options.mode ?? 'eom';
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.message = new ByteQueue({ pinLimit: this.maxMessageBytes });
  }

  /** The framing currently being decoded. */
  get mode(): FramingMode {
    return this.currentMode;
  }

  /** Bytes received but not yet returned as part of a message. */
  get bufferedBytes(): number {
    return this.queue.length + this.message.length;
  }

  /**
   * Switch framing for every byte not yet decoded. Only EOM → chunked is
   * meaningful (RFC 6242 §4.1), and only between messages.
   */
  setMode(mode: FramingMode): void {
    if (mode === this.currentMode) return;
    if (this.message.length > 0 || this.chunkRemaining > 0) {
      throw this.fail('Cannot change framing in the middle of a message');
    }
    this.currentMode = mode;
    this.scanned = 0;
    this.atSwitch = mode === 'chunked';
  }

  /** Add received bytes. The decoder may keep a reference to them until they are decoded, so don't modify them. */
  push(chunk: Uint8Array): void {
    if (this.failure) throw this.failure;
    this.queue.append(chunk);
  }

  /**
   * The next complete message, or undefined if more bytes are needed.
   * @throws FramingError; the decoder is unusable afterwards.
   */
  next(): string | undefined {
    if (this.failure) throw this.failure;
    return this.currentMode === 'eom' ? this.nextEom() : this.nextChunked();
  }

  private nextEom(): string | undefined {
    const q = this.queue;
    for (;;) {
      const idx = q.indexOf(DELIM, this.scanned);
      if (idx === -1) {
        this.scanned = Math.max(0, q.length - (DELIM.length - 1));
        if (q.length > this.maxMessageBytes + DELIM.length) {
          throw this.fail(`Message exceeds maxMessageBytes (${this.maxMessageBytes})`);
        }
        return undefined;
      }
      if (idx > this.maxMessageBytes) throw this.fail(`Message exceeds maxMessageBytes (${this.maxMessageBytes})`);
      const text = UTF8_DECODER.decode(q.bytes(idx));
      q.consume(idx + DELIM.length);
      this.scanned = 0;
      // An XML declaration must be the very first thing in a document, so drop
      // whitespace (typically the newline after the previous delimiter) and any
      // BOM. Trailing whitespace is insignificant and is dropped too. trim()
      // removes exactly JavaScript's whitespace, which includes the BOM, and
      // is far faster than a regex on a large message.
      const message = text.trim();
      if (message !== '') return message;
    }
  }

  private nextChunked(): string | undefined {
    const q = this.queue;
    for (;;) {
      if (this.chunkRemaining > 0) {
        if (q.length === 0) return undefined;
        const n = Math.min(this.chunkRemaining, q.length);
        if (this.message.length + n > this.maxMessageBytes) {
          throw this.fail(`Message exceeds maxMessageBytes (${this.maxMessageBytes})`);
        }
        // A view when the bytes are in one received chunk: the queue never reuses those.
        this.message.append(q.bytes(n));
        this.chunkRemaining -= n;
        q.consume(n);
        continue;
      }

      if (this.atSwitch && this.skipSwitchWhitespace()) continue;
      const len = q.length;
      if (len < 2) {
        if (len === 1 && q.at(0) !== LF) throw this.fail(this.badHeader());
        return undefined;
      }
      if (q.at(0) !== LF || q.at(1) !== HASH) throw this.fail(this.badHeader());
      this.atSwitch = false;
      if (len < 3) return undefined;

      if (q.at(2) === HASH) {
        // End-of-chunks: "\n##\n".
        if (len < 4) return undefined;
        if (q.at(3) !== LF) throw this.fail(this.badHeader());
        const length = this.message.length;
        if (length === 0) throw this.fail('End-of-chunks marker before any chunk');
        q.consume(4);
        const message = UTF8_DECODER.decode(this.message.bytes(length));
        this.message.consume(length);
        return message;
      }

      // Chunk header: "\n#<1-9><0-9>*\n".
      let i = 2;
      let size = 0;
      while (i < len) {
        const b = q.at(i);
        if (b === LF) break;
        if (b < DIGIT_0 || b > DIGIT_9 || (i === 2 && b === DIGIT_0) || i - 2 >= MAX_HEADER_DIGITS) {
          throw this.fail(this.badHeader());
        }
        size = size * 10 + (b - DIGIT_0);
        i++;
      }
      if (i === len) return undefined; // header not complete yet
      if (i === 2) throw this.fail(this.badHeader());
      if (size > MAX_CHUNK_SIZE) throw this.fail(`Chunk size ${size} exceeds ${MAX_CHUNK_SIZE}`);
      if (this.message.length + size > this.maxMessageBytes) {
        throw this.fail(`Message exceeds maxMessageBytes (${this.maxMessageBytes})`);
      }
      q.consume(i + 1);
      this.chunkRemaining = size;
    }
  }

  /**
   * Some servers leave a newline or spaces after the `]]>]]>` of their hello.
   * Straight after switching to chunked framing, skip whitespace that cannot
   * be the start of a chunk header. Returns true if anything was skipped.
   */
  private skipSwitchWhitespace(): boolean {
    const q = this.queue;
    let n = 0;
    while (n < q.length) {
      const b = q.at(n);
      if (b === 0x20 || b === 0x09 || b === 0x0d) n++;
      else if (b === LF && n + 1 < q.length && q.at(n + 1) !== HASH) n++;
      else break;
    }
    if (n === 0) return false;
    q.consume(n);
    return true;
  }

  private badHeader(): string {
    const sample = JSON.stringify(latin1(this.queue.bytes(Math.min(this.queue.length, 16))));
    return `Invalid chunked framing at ${sample}`;
  }

  private fail(message: string): FramingError {
    this.failure = new FramingError(message);
    return this.failure;
  }
}

// ignoreBOM keeps a leading byte-order mark in the text, as Node's Buffer did,
// so nextEom() decides what to strip. It is also V8's fast path for UTF-8.
const UTF8_DECODER = new TextDecoder('utf-8', { ignoreBOM: true });

/** Frame a message for EOM framing. */
export function encodeEom(message: string): Uint8Array {
  if (message.includes(EOM_DELIMITER)) {
    // The delimiter inside a message would end it early and let the rest be
    // read as a second message: a framing injection.
    throw new FramingError(`Message contains the end-of-message delimiter ${EOM_DELIMITER}`);
  }
  return UTF8_ENCODER.encode(`${message}\n${EOM_DELIMITER}`);
}

/** Frame a message for chunked framing. */
export function encodeChunked(message: string, chunkSize = MAX_CHUNK_SIZE): Uint8Array {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) {
    throw new RangeError(`chunkSize must be an integer from 1 to ${MAX_CHUNK_SIZE}`);
  }
  const body = UTF8_ENCODER.encode(message);
  if (body.length === 0) throw new FramingError('Cannot frame an empty message');
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let off = 0; off < body.length; off += chunkSize) {
    const piece = body.subarray(off, Math.min(off + chunkSize, body.length));
    const header = UTF8_ENCODER.encode(`\n#${piece.length}\n`);
    parts.push(header, piece);
    total += header.length + piece.length;
  }
  parts.push(END_OF_CHUNKS);
  return concat(parts, total + END_OF_CHUNKS.length);
}

export function encodeMessage(message: string, mode: FramingMode): Uint8Array {
  return mode === 'eom' ? encodeEom(message) : encodeChunked(message);
}

const END_OF_CHUNKS = UTF8_ENCODER.encode('\n##\n');

function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Bytes as latin1 text: for error samples, which are short. */
function latin1(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}
