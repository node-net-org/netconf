/**
 * ByteQueue against a plain array model: indexOf with
 * its scan cursor must find what a naive search finds, however the bytes
 * were appended (small reads packed into blocks, large ones kept as views)
 * and consumed, and whatever `from` the caller passes.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ByteQueue } from '../../src/transport/framing/byte-queue.js';

type Op =
  | { readonly kind: 'append'; readonly bytes: Uint8Array }
  | { readonly kind: 'consume'; readonly n: number }
  | { readonly kind: 'indexOf'; readonly seq: Uint8Array; readonly from: number };

function naiveIndexOf(bytes: readonly number[], seq: Uint8Array, from: number): number {
  outer: for (let i = Math.max(0, from); i + seq.length <= bytes.length; i++) {
    for (let j = 0; j < seq.length; j++) if (bytes[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

/** Bytes from a small alphabet, so the sequence searched for actually turns up. */
const bytesOf = (max: number): fc.Arbitrary<Uint8Array> =>
  fc.oneof(
    fc.uint8Array({ min: 0x5c, max: 0x5e, maxLength: max }),
    fc.integer({ min: 4096, max: 9000 }).map((n) => new Uint8Array(n).fill(0x41).map((b, i) => (i % 997 === 3 ? 0x5d : b))),
  );

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: bytesOf(40).map((bytes) => ({ kind: 'append' as const, bytes })) },
  { weight: 1, arbitrary: fc.nat(200).map((n) => ({ kind: 'consume' as const, n })) },
  {
    weight: 4,
    arbitrary: fc
      .tuple(fc.constantFrom(']]>]]>', ']]', ']', '\\]', ']A'), fc.nat(10000))
      .map(([s, from]) => ({ kind: 'indexOf' as const, seq: new TextEncoder().encode(s), from })),
  },
);

describe('ByteQueue', () => {
  it('indexOf finds what a naive search finds, across appends and consumes (fast-check)', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 60 }), (ops) => {
        const q = new ByteQueue();
        let model: number[] = [];
        let lastFrom = 0;
        for (const o of ops) {
          if (o.kind === 'append') {
            q.append(o.bytes);
            model = model.concat([...o.bytes]);
          } else if (o.kind === 'consume') {
            const n = Math.min(o.n, model.length);
            q.consume(n);
            model = model.slice(n);
            lastFrom = 0;
          } else {
            // Mostly searches that resume where the last one got to, as the EOM decoder's do.
            const from = o.from % 3 === 0 ? o.from % (model.length + 2) : Math.min(lastFrom + (o.from % 50), model.length + 1);
            lastFrom = from;
            expect(q.indexOf(o.seq, from)).toBe(naiveIndexOf(model, o.seq, from));
          }
          expect(q.length).toBe(model.length);
        }
      }),
      { numRuns: 1500 },
    );
  });

  it('searches a message that arrives in many reads in linear time', () => {
    const delim = new TextEncoder().encode(']]>]]>');
    const time = (reads: number): number => {
      const q = new ByteQueue();
      const read = new Uint8Array(4096).fill(0x41);
      const start = performance.now();
      let scanned = 0;
      for (let i = 0; i < reads; i++) {
        q.append(read);
        expect(q.indexOf(delim, scanned)).toBe(-1);
        scanned = q.length - (delim.length - 1);
      }
      return performance.now() - start;
    };
    // Every read is the same array, kept as a view, so this costs little memory.
    time(2000); // warm up
    const small = time(4000);
    const large = time(32_000);
    // 8× the reads: linear is 8× the time, quadratic 64×. Allow plenty of noise.
    expect(large / Math.max(small, 1)).toBeLessThan(24);
  });
});
