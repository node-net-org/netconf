import { describe, expect, it } from 'vitest';
import { parseXml, XmlElement } from '../../src/index.js';

// Casts stand in for plain JS callers; vitest runs as strict-mode ESM, so
// writes to frozen data throw instead of failing silently.
describe('XmlElement: immutability', () => {
  it('shares no writable map between elements without declarations', () => {
    const a = new XmlElement({ name: 'a', ns: '' });
    const b = parseXml('<b/>');
    const decls = a.declarations as Map<string, string>;
    expect(() => decls.set('x', 'urn:x')).toThrow(TypeError);
    expect(() => decls.delete('x')).toThrow(TypeError);
    expect(() => decls.clear()).toThrow(TypeError);
    expect(b.declarations.size).toBe(0);
  });

  it('copies declarations it is given, and freezes the copy', () => {
    const given = new Map([['ex', 'urn:ex']]);
    const el = new XmlElement({ name: 'a', ns: '', declarations: given });
    given.set('other', 'urn:other');
    expect([...el.declarations]).toEqual([['ex', 'urn:ex']]);
    expect(() => (el.declarations as Map<string, string>).set('y', 'urn:y')).toThrow(TypeError);
  });

  it('freezes parsed declarations', () => {
    const el = parseXml('<a xmlns="urn:a" xmlns:ex="urn:ex"/>');
    expect(el.declarations.get('ex')).toBe('urn:ex');
    expect(() => (el.declarations as Map<string, string>).set('ex', 'urn:changed')).toThrow(TypeError);
    expect(el.declarations.get('ex')).toBe('urn:ex');
  });

  it('copies and freezes the attributes it is given', () => {
    const attr = { name: 'id', ns: undefined, value: '1' };
    const el = new XmlElement({ name: 'a', ns: '', attributes: [attr] });
    attr.value = '2';
    expect(el.attributes[0]!.value).toBe('1');
    expect(() => {
      (el.attributes[0] as { value: string }).value = '3';
    }).toThrow(TypeError);
  });
});
