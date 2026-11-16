import { describe, expect, it } from 'vitest';
import { stripInvalidXmlChars } from '../../src/messages/quirks.js';

describe('stripInvalidXmlChars (the invalidXmlChars: strip quirk)', () => {
  it.each([
    ['NUL', '\u0000'],
    ['BEL', '\u0007'],
    ['BS', '\u0008'],
    ['VT', '\u000B'],
    ['FF', '\u000C'],
    ['SO', '\u000E'],
    ['US', '\u001F'],
    ['U+FFFE', '￾'],
    ['U+FFFF', '￿'],
    ['an unpaired high surrogate', '\uD800'],
    ['an unpaired low surrogate', '\uDC00'],
  ])('removes %s', (_name, ch) => {
    expect(stripInvalidXmlChars(`a${ch}b`)).toEqual({ text: 'ab', removed: 1 });
  });

  it('keeps every character XML 1.0 allows', () => {
    const allowed = 'tab\there\nlf\rcr space ~ \u007F \u0085 é ퟿  � \u{1F600} \u{10FFFF}';
    expect(stripInvalidXmlChars(allowed)).toEqual({ text: allowed, removed: 0 });
  });

  it('removes a high surrogate at the end and a low surrogate at the start', () => {
    expect(stripInvalidXmlChars('\uDC00x\uD800')).toEqual({ text: 'x', removed: 2 });
  });

  it('counts every removal', () => {
    expect(stripInvalidXmlChars('\u0007a\u0007\u0001b')).toEqual({ text: 'ab', removed: 3 });
  });
});
