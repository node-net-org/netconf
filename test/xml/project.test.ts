import { describe, expect, it } from 'vitest';
import { parseXml, toObject } from '../../src/index.js';

describe('toObject', () => {
  const data = parseXml(
    '<data xmlns="urn:if"><interface><name>a</name><mtu>1500</mtu></interface>' +
      '<interface><name>b</name></interface><hostname>r1</hostname></data>',
  );

  it('makes arrays only for repeated names by default', () => {
    expect(toObject(data)).toEqual({
      interface: [{ name: 'a', mtu: '1500' }, { name: 'b' }],
      hostname: 'r1',
    });
  });

  it("wraps every child in an array with arrays: 'always'", () => {
    expect(toObject(parseXml('<l><e><n>1</n></e></l>'), { arrays: 'always' })).toEqual({ e: [{ n: ['1'] }] });
  });

  it('never parses numbers (values stay strings)', () => {
    expect(toObject(parseXml('<a><n>007</n></a>'))).toEqual({ n: '007' });
  });

  it('includes attributes on request', () => {
    expect(toObject(parseXml('<a k="v">t</a>'), { attributes: true })).toEqual({ '@': { k: 'v' }, '#text': 't' });
  });

  it('treats __proto__ as a plain key', () => {
    const obj = toObject(parseXml('<a><__proto__><polluted>yes</polluted></__proto__></a>')) as Record<string, unknown>;
    expect(Object.keys(obj)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
