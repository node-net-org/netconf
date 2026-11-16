// Hostile framing input stays bounded and only ever produces a FramingError.

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { encodeChunked, encodeEom, FrameDecoder, type FramingMode } from '../../src/transport/framing/index.js';
import { FramingError } from '../../src/index.js';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

/** Heap plus array buffers: payload bytes live outside the JS heap. */
function memory(): number {
  gc();
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
}

const encoder = new TextEncoder();

describe('chunked framing: many tiny chunks', () => {
  it('holds about the payload in memory, however small the chunks', () => {
    // 2M one-byte chunks. One view per chunk cost ~115 B each: ~230 MB here.
    const CHUNKS = 2_000_000;
    const PER_PIECE = 10_000;
    const piece = encoder.encode('\n#1\nx'.repeat(PER_PIECE));
    const d = new FrameDecoder({ mode: 'chunked' });
    const before = memory();
    for (let i = 0; i < CHUNKS / PER_PIECE; i++) {
      d.push(piece);
      expect(d.next()).toBeUndefined();
    }
    const grown = memory() - before;
    expect(d.bufferedBytes).toBe(CHUNKS);
    expect(grown).toBeLessThan(4 * CHUNKS + 8 * 1024 * 1024);

    d.push(encoder.encode('\n##\n'));
    const message = d.next();
    expect(message?.length).toBe(CHUNKS);
    expect(d.bufferedBytes).toBe(0);
  });

  it('holds at most about twice maxMessageBytes when reads mix one large chunk with many tiny ones', () => {
    // Each read: one 4 KiB chunk (kept as a view, which keeps the whole read
    // alive) and 20,000 one-byte chunks, so a read is ~4x its payload. Views
    // of every read would hold ~21 MB for ~4.8 MB of message.
    const max = 8 * 1024 * 1024;
    const d = new FrameDecoder({ mode: 'chunked', maxMessageBytes: max });
    const before = memory();
    let payload = 0;
    for (let i = 0; i < 200; i++) {
      d.push(encoder.encode(`\n#4096\n${'y'.repeat(4096)}${'\n#1\nx'.repeat(20_000)}`));
      expect(d.next()).toBeUndefined();
      payload += 4096 + 20_000;
    }
    expect(d.bufferedBytes).toBe(payload);
    expect(memory() - before).toBeLessThan(2 * max);
  });

  it('refuses one-byte chunks past maxMessageBytes with a FramingError', () => {
    const d = new FrameDecoder({ mode: 'chunked', maxMessageBytes: 1000 });
    d.push(encoder.encode('\n#1\nx'.repeat(1000)));
    expect(d.next()).toBeUndefined();
    d.push(encoder.encode('\n#1\nx'));
    expect(() => d.next()).toThrow(FramingError);
    expect(() => d.next()).toThrow(/maxMessageBytes \(1000\)/);
  });

  it('decodes alternating tiny and large chunks exactly', () => {
    const parts: string[] = [];
    for (let i = 0; i < 50; i++) parts.push(String(i % 10), 'y'.repeat(5000));
    const framed = parts.map((p) => `\n#${encoder.encode(p).length}\n${p}`).join('') + '\n##\n';
    const d = new FrameDecoder({ mode: 'chunked' });
    d.push(encoder.encode(framed));
    expect(d.next()).toBe(parts.join(''));
  });

  it('decodes a message whose chunks split a multi-byte character', () => {
    const bytes = encoder.encode('<m>ü€😀</m>');
    const framed = [...bytes].map((b) => `\n#1\n${String.fromCharCode(b)}`).join('') + '\n##\n';
    const d = new FrameDecoder({ mode: 'chunked' });
    d.push(Uint8Array.from(framed, (c) => c.charCodeAt(0)));
    expect(d.next()).toBe('<m>ü€😀</m>');
  });
});

/** Push the pieces and pull every message; return the error thrown, if any. */
function drain(mode: FramingMode, pieces: Uint8Array[], maxMessageBytes: number): unknown {
  const d = new FrameDecoder({ mode, maxMessageBytes });
  try {
    for (const p of pieces) {
      d.push(p);
      while (d.next() !== undefined);
    }
    return undefined;
  } catch (err) {
    return err;
  }
}

function split(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
  const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
  const out: Uint8Array[] = [];
  let prev = 0;
  for (const p of points) {
    out.push(bytes.subarray(prev, p));
    prev = p;
  }
  out.push(bytes.subarray(prev));
  return out;
}

/** Replace, insert or delete bytes at random positions. */
const mutation = fc.array(
  fc.record({ at: fc.nat(), op: fc.constantFrom('set', 'insert', 'delete'), byte: fc.integer({ min: 0, max: 255 }) }),
  { minLength: 1, maxLength: 6 },
);

function mutate(bytes: Uint8Array, edits: { at: number; op: string; byte: number }[]): Uint8Array {
  const out = [...bytes];
  for (const { at, op, byte } of edits) {
    const i = at % (out.length + 1);
    if (op === 'insert') out.splice(i, 0, byte);
    else if (op === 'delete') out.splice(i, 1);
    else if (i < out.length) out[i] = byte;
  }
  return Uint8Array.from(out);
}

// Bytes that matter to the grammars, so random input reaches past the first check.
const framingByte = fc.oneof(
  fc.integer({ min: 0, max: 255 }),
  fc.constantFrom(...encoder.encode('\n#0123456789]>\n#\n##\n')),
);

describe('property: hostile bytes only ever produce a FramingError', () => {
  for (const mode of ['eom', 'chunked'] as FramingMode[]) {
    it(`${mode}: arbitrary bytes, split anywhere`, () => {
      fc.assert(
        fc.property(fc.array(framingByte, { maxLength: 400 }), fc.array(fc.nat(), { maxLength: 10 }), fc.integer({ min: 1, max: 64 }), (bytes, cuts, max) => {
          const err = drain(mode, split(Uint8Array.from(bytes), cuts), max);
          if (err !== undefined) expect(err).toBeInstanceOf(FramingError);
        }),
        { numRuns: 500 },
      );
    });

    it(`${mode}: valid frames, mutated and split anywhere`, () => {
      const message = fc.string({ minLength: 1, maxLength: 80 }).map((s) => `<m>${s}</m>`).filter((s) => !s.includes(']]>]]>'));
      fc.assert(
        fc.property(
          fc.array(message, { minLength: 1, maxLength: 4 }),
          fc.integer({ min: 1, max: 16 }),
          mutation,
          fc.array(fc.nat(), { maxLength: 10 }),
          (msgs, chunkSize, edits, cuts) => {
            const frames = msgs.map((m) => (mode === 'eom' ? encodeEom(m) : encodeChunked(m, chunkSize)));
            const stream = mutate(Uint8Array.from(frames.flatMap((f) => [...f])), edits);
            const err = drain(mode, split(stream, cuts), 256);
            if (err !== undefined) expect(err).toBeInstanceOf(FramingError);
          },
        ),
        { numRuns: 500 },
      );
    });
  }
});
