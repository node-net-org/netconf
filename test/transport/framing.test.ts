import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  encodeChunked,
  encodeEom,
  FrameDecoder,
  MAX_CHUNK_SIZE,
  type FramingMode,
} from '../../src/transport/framing/index.js';
import { FramingError, FrameDecoder as PublicFrameDecoder, type DecoderOptions } from '../../src/index.js';

/** Feed bytes to a decoder in the given pieces and collect every message. */
function decodeAll(decoder: FrameDecoder, pieces: Uint8Array[]): string[] {
  const out: string[] = [];
  for (const p of pieces) {
    decoder.push(p);
    for (let m = decoder.next(); m !== undefined; m = decoder.next()) out.push(m);
  }
  return out;
}

function splitAt(buf: Buffer, cuts: number[]): Buffer[] {
  const points = [...new Set(cuts.map((c) => c % (buf.length + 1)))].sort((a, b) => a - b);
  const out: Buffer[] = [];
  let prev = 0;
  for (const p of points) {
    out.push(buf.subarray(prev, p));
    prev = p;
  }
  out.push(buf.subarray(prev));
  return out;
}

const bytes = (s: string): Buffer => Buffer.from(s, 'latin1');

describe('EOM framing', () => {
  it('decodes consecutive messages and strips the whitespace between them', () => {
    const d = new FrameDecoder();
    expect(decodeAll(d, [bytes('<a/>]]>]]>\n<b/>]]>]]>')])).toEqual(['<a/>', '<b/>']);
  });

  it('finds a delimiter split across chunks', () => {
    const d = new FrameDecoder();
    expect(decodeAll(d, [bytes('<a/>]]'), bytes('>]]'), bytes('>')])).toEqual(['<a/>']);
  });

  it('skips empty messages and a leading BOM', () => {
    const d = new FrameDecoder();
    expect(decodeAll(d, [Buffer.from('\n]]>]]>\uFEFF<a/>]]>]]>', 'utf8')])).toEqual(['<a/>']);
  });

  it('decodes multi-byte UTF-8 split across chunks', () => {
    const msg = Buffer.from('<a>é😀</a>]]>]]>', 'utf8');
    const d = new FrameDecoder();
    expect(decodeAll(d, [...msg].map((b) => Uint8Array.of(b)))).toEqual(['<a>é😀</a>']);
  });

  it('encodes with a trailing delimiter', () => {
    expect(new TextDecoder().decode(encodeEom('<a/>'))).toBe('<a/>\n]]>]]>');
  });

  it('refuses to send a message containing the delimiter (framing injection)', () => {
    expect(() => encodeEom('<a>]]>]]><rpc/></a>')).toThrow(FramingError);
  });

  it('enforces maxMessageBytes without waiting for a delimiter', () => {
    const d = new FrameDecoder({ maxMessageBytes: 100 });
    d.push(Buffer.alloc(200, 0x41));
    expect(() => d.next()).toThrow(/maxMessageBytes/);
    // The decoder stays failed.
    expect(() => d.push(bytes('<a/>]]>]]>'))).toThrow(FramingError);
  });
});

describe('chunked framing', () => {
  it('decodes a multi-chunk message', () => {
    const d = new FrameDecoder({ mode: 'chunked' });
    // The example from RFC 6242 §4.2, shortened.
    expect(decodeAll(d, [bytes('\n#4\n<rpc\n#18\n message-id="102"\n\n#3\n/>\n\n##\n')])).toEqual([
      '<rpc message-id="102"\n/>\n',
    ]);
  });

  it('round-trips encoded messages, including with tiny chunks', () => {
    const d = new FrameDecoder({ mode: 'chunked' });
    const msg = '<a>héllo 😀</a>';
    expect(decodeAll(d, [encodeChunked(msg), encodeChunked(msg, 1), encodeChunked(msg, 3)])).toEqual([msg, msg, msg]);
  });

  it('counts chunk sizes in bytes, not characters', () => {
    expect(new TextDecoder().decode(encodeChunked('é'))).toBe('\n#2\né\n##\n');
  });

  it.each([
    ['missing leading LF', '#4\nabcd\n##\n'],
    ['leading zero', '\n#04\nabcd\n##\n'],
    ['zero size', '\n#0\n\n##\n'],
    ['non-digit size', '\n#4a\nabcd\n##\n'],
    ['empty size', '\n#\nabcd\n##\n'],
    ['end-of-chunks without a chunk', '\n##\n'],
    ['junk after end marker', '\n#1\na\n##x'],
    ['size with 11 digits', '\n#12345678901\n'],
  ])('rejects %s', (_label, input) => {
    const d = new FrameDecoder({ mode: 'chunked' });
    expect(() => decodeAll(d, [bytes(input)])).toThrow(FramingError);
  });

  it('rejects a chunk size above 4294967295', () => {
    const d = new FrameDecoder({ mode: 'chunked', maxMessageBytes: Number.MAX_SAFE_INTEGER });
    expect(() => decodeAll(d, [bytes(`\n#${MAX_CHUNK_SIZE + 1}\n`)])).toThrow(/exceeds/);
  });

  it('accepts the maximum chunk size header', () => {
    const d = new FrameDecoder({ mode: 'chunked', maxMessageBytes: Number.MAX_SAFE_INTEGER });
    expect(decodeAll(d, [bytes(`\n#${MAX_CHUNK_SIZE}\n`)])).toEqual([]);
  });

  it('rejects a chunk header promising more than maxMessageBytes before reading the data', () => {
    const d = new FrameDecoder({ mode: 'chunked', maxMessageBytes: 10 });
    expect(() => decodeAll(d, [bytes('\n#11\n')])).toThrow(/maxMessageBytes/);
  });

  it('applies maxMessageBytes across chunks', () => {
    const d = new FrameDecoder({ mode: 'chunked', maxMessageBytes: 10 });
    expect(() => decodeAll(d, [bytes('\n#6\naaaaaa\n#6\nbbbbbb\n##\n')])).toThrow(/maxMessageBytes/);
  });

  it('refuses to encode an empty message', () => {
    expect(() => encodeChunked('')).toThrow(FramingError);
  });
});

describe('switching from EOM to chunked after the hello', () => {
  it('decodes chunked bytes that arrived together with the hello', () => {
    const d = new FrameDecoder();
    d.push(bytes('<hello/>]]>]]>\n#5\n<ok/>\n##\n'));
    expect(d.next()).toBe('<hello/>');
    d.setMode('chunked');
    expect(d.next()).toBe('<ok/>');
  });

  it('tolerates whitespace left after the hello delimiter', () => {
    const d = new FrameDecoder();
    d.push(bytes('<hello/>]]>]]>\n\r\n  \n#5\n<ok/>\n##\n'));
    expect(d.next()).toBe('<hello/>');
    d.setMode('chunked');
    expect(d.next()).toBe('<ok/>');
  });

  it('tolerates a trailing newline arriving on its own before the first chunk', () => {
    const d = new FrameDecoder();
    expect(decodeAll(d, [bytes('<hello/>]]>]]>')])).toEqual(['<hello/>']);
    d.setMode('chunked');
    expect(decodeAll(d, [bytes('\n'), bytes('\n'), bytes('#5\n<ok/>\n##\n')])).toEqual(['<ok/>']);
  });

  it('is strict again after the first chunk header', () => {
    const d = new FrameDecoder({ mode: 'eom' });
    d.setMode('chunked');
    expect(decodeAll(d, [bytes('\n#1\na\n##\n')])).toEqual(['a']);
    expect(() => decodeAll(d, [bytes(' \n#1\na\n##\n')])).toThrow(FramingError);
  });

  it('refuses to switch in the middle of a chunked message', () => {
    const d = new FrameDecoder({ mode: 'chunked' });
    d.push(bytes('\n#3\nab'));
    expect(d.next()).toBeUndefined();
    expect(() => d.setMode('eom')).toThrow(FramingError);
  });
});

describe('property: any split of a framed stream decodes to the same messages', () => {
  // Messages as an XML layer would produce them: non-empty, no leading
  // whitespace, and (for EOM) never containing the delimiter.
  const message = fc
    .string({ unit: 'binary', minLength: 1, maxLength: 200 })
    .map((s) => `<m>${s}</m>`)
    .filter((s) => !s.includes(']]>]]>'));

  for (const mode of ['eom', 'chunked'] as FramingMode[]) {
    it(`${mode}`, () => {
      fc.assert(
        fc.property(
          fc.array(message, { minLength: 1, maxLength: 8 }),
          fc.array(fc.nat(), { maxLength: 20 }),
          fc.integer({ min: 1, max: 64 }),
          (msgs, cuts, chunkSize) => {
            const stream = Buffer.concat(
              msgs.map((m) => (mode === 'eom' ? encodeEom(m) : encodeChunked(m, chunkSize))),
            );
            const d = new FrameDecoder({ mode });
            expect(decodeAll(d, splitAt(stream, cuts))).toEqual(msgs);
            expect(d.bufferedBytes).toBe(0);
          },
        ),
        { numRuns: 300 },
      );
    });
  }
});

describe('property: large messages over reads of any size, small and large mixed', () => {
  // The decoder keeps large reads as they are and packs small ones (under
  // 4 KiB) into blocks, then searches and copies across those boundaries.
  // Cut long messages at random sizes either side of that line, so delimiters
  // and chunk headers land on every kind of boundary.
  const body = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 20_000 }).map((s) => `<m>${s}</m>`).filter((s) => !s.includes(']]>]]>'));
  const read = fc.oneof(fc.integer({ min: 1, max: 64 }), fc.integer({ min: 3_000, max: 9_000 }));

  for (const mode of ['eom', 'chunked'] as FramingMode[]) {
    it(`${mode}`, () => {
      fc.assert(
        fc.property(fc.array(body, { minLength: 1, maxLength: 4 }), fc.array(read, { minLength: 1, maxLength: 30 }), (msgs, reads) => {
          const stream = Buffer.concat(msgs.map((m) => (mode === 'eom' ? encodeEom(m) : encodeChunked(m, 5_000))));
          const pieces: Uint8Array[] = [];
          for (let off = 0, i = 0; off < stream.length; i++) {
            const n = reads[i % reads.length]!;
            pieces.push(new Uint8Array(stream.subarray(off, off + n)));
            off += n;
          }
          const d = new FrameDecoder({ mode });
          expect(decodeAll(d, pieces)).toEqual(msgs.map((m) => m.trim()));
          expect(d.bufferedBytes).toBe(0);
        }),
        { numRuns: 150 },
      );
    });
  }
});

describe('performance (fork defect e: quadratic buffering)', () => {
  it('decodes an 8 MiB message delivered in 1 KiB pieces in linear time', () => {
    const body = `<data>${'x'.repeat(8 * 1024 * 1024)}</data>`;
    for (const mode of ['eom', 'chunked'] as FramingMode[]) {
      const framed = mode === 'eom' ? encodeEom(body) : encodeChunked(body, 4096);
      const d = new FrameDecoder({ mode });
      const start = performance.now();
      const out: string[] = [];
      for (let off = 0; off < framed.length; off += 1024) {
        d.push(framed.subarray(off, off + 1024));
        const m = d.next();
        if (m !== undefined) out.push(m);
      }
      const ms = performance.now() - start;
      expect(out.length).toBe(1);
      expect(out[0] === body).toBe(true);
      // Quadratic buffering takes many seconds here; linear takes well under one.
      expect(ms).toBeLessThan(1500);
    }
  });
});

describe('FrameDecoder from the public API', () => {
  it('is the same class as the internal decoder', () => {
    expect(PublicFrameDecoder).toBe(FrameDecoder);
  });

  it('decodes a copy of a byte stream: an EOM hello, then chunked messages after setMode', () => {
    const options: DecoderOptions = { maxMessageBytes: 1024 };
    const decoder = new PublicFrameDecoder(options);
    expect(decoder.mode).toBe('eom');
    decoder.push(Buffer.from('<hello/>]]>]]>\n#3\n<a/\n#1\n>\n##\n'));
    expect(decoder.next()).toBe('<hello/>');
    decoder.setMode('chunked');
    expect(decoder.mode).toBe('chunked');
    expect(decoder.next()).toBe('<a/>');
    expect(decoder.next()).toBeUndefined();
    decoder.push(Buffer.from('\n#2\n<b'));
    expect(decoder.next()).toBeUndefined();
    expect(decoder.bufferedBytes).toBe(2);
  });

  it('throws FramingError on malformed framing, and again on every later call', () => {
    const decoder = new PublicFrameDecoder({ mode: 'chunked' });
    decoder.push(Buffer.from('\n#x\n'));
    expect(() => decoder.next()).toThrow(FramingError);
    expect(() => decoder.next()).toThrow(FramingError);
    expect(() => decoder.push(Buffer.from('more'))).toThrow(FramingError);
  });
});
