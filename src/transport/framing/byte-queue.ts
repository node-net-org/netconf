/**
 * A FIFO of received bytes, kept mostly as the chunks they arrived in.
 * Appending copies nothing but small chunks (which are packed into blocks, so
 * a stream of tiny reads doesn't become a list of tiny arrays). A message
 * taken out whole is copied once, at the exact size, and only if it spans
 * chunks. So a large message costs linear time, not the quadratic time of
 * repeated concatenation (or of the fork's string regex), and never passes
 * through an ever-growing buffer.
 *
 * The queue keeps references to large appended arrays until their bytes are
 * consumed, so they must not be modified meanwhile.
 */
export class ByteQueue {
  /** Views of the bytes, in order; chunks[first] is the oldest still held. */
  private chunks: Uint8Array[] = [];
  private first = 0;
  /** Where the unconsumed bytes start in chunks[first]. */
  private head = 0;
  private total = 0;
  /** The block small chunks are packed into, while chunks' last view is of it. */
  private block: Uint8Array | undefined;
  private blockStart = 0;
  private blockEnd = 0;
  /** The last chunk is a view of the block, from blockStart to blockEnd. */
  private blockListed = false;
  /** Most bytes of arrays that kept views may hold alive; beyond it, chunks are copied. */
  private readonly pinLimit: number;
  /** Bytes of the arrays kept views hold alive, and the latest such array. */
  private pinned = 0;
  private lastPinned: ArrayBufferLike | undefined;
  /**
   * Where the last indexOf() got to: chunks[scanChunk] starts at scanBase
   * among the unconsumed bytes. A later search from at or past it starts
   * there, so searching a message that arrives in many reads is linear
   *. Appending doesn't move it; consuming resets it.
   */
  private scanChunk = 0;
  private scanBase = 0;

  /**
   * @param options.pinLimit A view keeps its whole array alive, not just its
   *   own bytes. Once the arrays behind kept views total this many bytes
   *   (counted until the queue is next empty), large chunks are copied instead.
   *   Default: no limit, which suits received bytes that are consumed soon.
   */
  constructor(options: { readonly pinLimit?: number } = {}) {
    this.pinLimit = options.pinLimit ?? Infinity;
  }

  get length(): number {
    return this.total;
  }

  append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.total += chunk.length;
    if (chunk.length >= SMALL) {
      // Later small chunks go after this one, so they start a new view.
      this.blockListed = false;
      this.chunks.push(this.pinLimit === Infinity ? chunk : this.keepOrCopy(chunk));
      return;
    }
    if (this.block === undefined || this.blockEnd + chunk.length > this.block.length) {
      this.block = new Uint8Array(BLOCK);
      this.blockStart = this.blockEnd = 0;
      this.blockListed = false;
    }
    if (!this.blockListed) {
      // The block's view becomes the last chunk; it grows as small chunks are packed in.
      this.blockStart = this.blockEnd;
      this.chunks.push(this.block.subarray(this.blockStart, this.blockEnd));
      this.blockListed = true;
    }
    this.block.set(chunk, this.blockEnd);
    this.blockEnd += chunk.length;
    this.chunks[this.chunks.length - 1] = this.block.subarray(this.blockStart, this.blockEnd);
  }

  /** The chunk itself, or a copy if keeping it would pass the pin limit. */
  private keepOrCopy(chunk: Uint8Array): Uint8Array {
    const array = chunk.buffer;
    if (array === this.lastPinned) return chunk;
    if (this.pinned + array.byteLength > this.pinLimit) return chunk.slice();
    this.pinned += array.byteLength;
    this.lastPinned = array;
    return chunk;
  }

  /** The byte at index `i` of the unconsumed bytes (0 ≤ i < length). */
  at(i: number): number {
    let k = this.first;
    let j = i + this.head;
    while (j >= this.chunks[k]!.length) {
      j -= this.chunks[k]!.length;
      k++;
    }
    return this.chunks[k]![j]!;
  }

  /**
   * Where `seq` first occurs in the unconsumed bytes, at or after `from`, or -1.
   * It may span chunks.
   */
  indexOf(seq: Uint8Array, from = 0): number {
    const firstByte = seq[0]!;
    let k = this.first;
    let base = -this.head; // index of chunks[k][0] among the unconsumed bytes
    if (this.scanChunk > k && this.scanBase <= from) {
      k = this.scanChunk;
      base = this.scanBase;
    }
    for (; k < this.chunks.length; k++) {
      const c = this.chunks[k]!;
      if (base + c.length <= from) {
        // Wholly before `from`: later searches from here on needn't walk it
        // again. Not the last chunk, which append() may still extend.
        if (k + 1 < this.chunks.length) {
          this.scanChunk = k + 1;
          this.scanBase = base + c.length;
        }
      } else {
        const start = Math.max(from - base, k === this.first ? this.head : 0);
        for (let i = c.indexOf(firstByte, start); i !== -1; i = c.indexOf(firstByte, i + 1)) {
          if (this.matches(k, i, seq)) return base + i;
        }
      }
      base += c.length;
    }
    return -1;
  }

  /** The first `n` unconsumed bytes as one array (n ≤ length): a view when they are in one chunk, else a copy. */
  bytes(n: number): Uint8Array {
    if (n === 0) return new Uint8Array(0);
    const c = this.chunks[this.first]!;
    if (this.head + n <= c.length) return c.subarray(this.head, this.head + n);
    const out = new Uint8Array(n);
    let off = 0;
    for (let k = this.first; off < n; k++) {
      const chunk = this.chunks[k]!;
      const start = k === this.first ? this.head : 0;
      const piece = chunk.subarray(start, Math.min(chunk.length, start + (n - off)));
      out.set(piece, off);
      off += piece.length;
    }
    return out;
  }

  consume(n: number): void {
    this.scanChunk = 0;
    this.scanBase = 0;
    let left = Math.min(n, this.total);
    this.total -= left;
    while (left > 0) {
      const rest = this.chunks[this.first]!.length - this.head;
      if (left < rest) {
        this.head += left;
        break;
      }
      left -= rest;
      this.first++;
      this.head = 0;
    }
    if (this.total === 0) {
      // Keep the current block for the next small chunks: its unused space is still free.
      this.chunks = [];
      this.first = this.head = 0;
      this.blockListed = false;
      this.pinned = 0;
      this.lastPinned = undefined;
      return;
    }
    // Step past emptied chunks, so the first chunk holds the next byte.
    while (this.head >= this.chunks[this.first]!.length) {
      this.head -= this.chunks[this.first]!.length;
      this.first++;
    }
    if (this.first > 1024 && this.first * 2 > this.chunks.length) {
      // Drop consumed chunks now and then, so the list doesn't grow without bound.
      this.chunks = this.chunks.slice(this.first);
      this.first = 0;
    }
  }

  /** Whether `seq` occurs starting at chunks[k][i], perhaps running into later chunks. */
  private matches(k: number, i: number, seq: Uint8Array): boolean {
    let chunk = this.chunks[k]!;
    let j = i;
    for (let s = 0; s < seq.length; s++, j++) {
      while (j >= chunk.length) {
        k++;
        if (k >= this.chunks.length) return false;
        j -= chunk.length;
        chunk = this.chunks[k]!;
      }
      if (chunk[j] !== seq[s]) return false;
    }
    return true;
  }
}

/** Chunks smaller than this are packed into blocks rather than kept as they are. */
const SMALL = 4096;
const BLOCK = 64 * 1024;
