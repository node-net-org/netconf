/**
 * XML-02, XML-03, XML-04: every parsed element knows the
 * namespace declarations in scope where it was parsed, so a prefix used inside
 * a value keeps its meaning after the element is taken out of its document.
 */
import { describe, expect, it } from 'vitest';
import { parseXml, serializeXml, x, XmlElement } from '../../src/index.js';

const IANAIFT = 'urn:ietf:params:xml:ns:yang:iana-if-type';
const IF = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
const NC = 'urn:ietf:params:xml:ns:netconf:base:1.0';

/** A reply that declares ianaift only on <rpc-reply>, two levels above where it is used. */
const REPLY = `<rpc-reply message-id="7" xmlns="${NC}" xmlns:ianaift="${IANAIFT}"><data><interfaces xmlns="${IF}"><interface><name>eth0</name><type>ianaift:ethernetCsmacd</type></interface></interfaces></data></rpc-reply>`;

describe('XML-02/03: in-scope namespaces on parsed elements', () => {
  it('a prefix declared on an ancestor resolves from any element below it, however it was reached', () => {
    const data = parseXml(REPLY).child('data')!;
    const iface = data.child('interfaces')!.child('interface')!;
    expect(data.lookupNamespace('ianaift')).toBe(IANAIFT);
    expect(iface.lookupNamespace('ianaift')).toBe(IANAIFT);
    expect(iface.child('type')!.lookupNamespace('ianaift')).toBe(IANAIFT);
  });

  it('inScope holds the element\'s own and its ancestors\' declarations, the nearest winning', () => {
    const root = parseXml(`<a xmlns="u:a" xmlns:p="u:p1"><b xmlns:p="u:p2" xmlns:q="u:q"><c/></b></a>`);
    const c = root.child('b')!.child('c')!;
    expect(c.inScope.get('p')).toBe('u:p2');
    expect(c.inScope.get('q')).toBe('u:q');
    expect(c.inScope.get('')).toBe('u:a');
    expect(c.lookupNamespace('')).toBe('u:a');
    expect(c.lookupNamespace('nope')).toBeUndefined();
    // own declarations stay just the element's own
    expect([...c.declarations]).toEqual([]);
    expect([...root.child('b')!.declarations]).toEqual([['p', 'u:p2'], ['q', 'u:q']]);
  });

  it('a child that declares nothing shares its parent\'s scope rather than copying it', () => {
    const root = parseXml(`<a xmlns:p="u:p"><b><c/></b></a>`);
    const b = root.child('b')!;
    expect(b.inScope).toBe(root.inScope);
    expect(b.child('c')!.inScope).toBe(root.inScope);
  });

  it('the xml prefix is always bound', () => {
    expect(x('a').lookupNamespace('xml')).toBe('http://www.w3.org/XML/1998/namespace');
  });

  it('an element built with x() has only its own declarations in scope', () => {
    const built = x('item', { xmlns: 'u:a', 'xmlns:p': 'u:p' }, x('kind', 'p:fast'));
    expect(built.lookupNamespace('p')).toBe('u:p');
    expect(built.child('kind')!.lookupNamespace('p')).toBeUndefined();
  });

  it('in-scope namespaces cannot be changed', () => {
    const iface = parseXml(REPLY).child('data')!.child('interfaces')!.child('interface')!;
    expect(() => (iface.inScope as Map<string, string>).set('ianaift', 'u:other')).toThrow(TypeError);
  });
});

describe('XML-04: serialising an element apart from its document', () => {
  it('declares the prefixes it inherited, so the value still resolves in the output', () => {
    const iface = parseXml(REPLY).child('data')!.child('interfaces')!.child('interface')!;
    const text = serializeXml(iface);
    expect(text).toContain(`xmlns:ianaift="${IANAIFT}"`);
    const again = parseXml(text);
    expect(again.child('type')!.lookupNamespace('ianaift')).toBe(IANAIFT);
    expect(iface.toString()).toBe(text);
  });

  it('writes a whole document as before: inside its own document nothing extra is declared', () => {
    // (the serialiser writes prefixed declarations before the default one)
    const doc = `<a xmlns:p="u:p" xmlns="u:a"><b><c>p:x</c></b></a>`;
    expect(serializeXml(parseXml(doc))).toBe(doc);
    expect(serializeXml(parseXml(REPLY)).match(/xmlns:ianaift=/g)).toHaveLength(1);
  });

  it('keeps the prefix when the element is put inside new XML, such as an edit', () => {
    const iface = parseXml(REPLY).child('data')!.child('interfaces')!.child('interface')!;
    const edit = x('config', { xmlns: NC }, x('interfaces', { xmlns: IF }, iface));
    const sent = parseXml(serializeXml(edit));
    const type = sent.path('interfaces/interface/type')!;
    expect(type.text()).toBe('ianaift:ethernetCsmacd');
    expect(type.lookupNamespace('ianaift')).toBe(IANAIFT);
  });

  it('never rebinds an inherited prefix that a qualified attribute would also like to use', () => {
    const el = new XmlElement({
      name: 'kind',
      ns: 'u:a',
      attributes: [{ name: 'origin', ns: 'u:other', prefix: 'p', value: 'v' }],
      children: ['p:fast'],
      inScope: new Map([['p', 'u:p']]),
    });
    const again = parseXml(serializeXml(el));
    expect(again.lookupNamespace('p')).toBe('u:p');
    expect(again.attributes).toHaveLength(1);
    expect(again.attributes[0]!.ns).toBe('u:other');
    expect(again.attributes[0]!.prefix).not.toBe('p');
  });

  it('an element\'s own declarations win over the scope it was given', () => {
    const el = new XmlElement({ name: 'a', ns: 'u:a', declarations: new Map([['p', 'u:mine']]), inScope: new Map([['p', 'u:theirs']]) });
    expect(el.lookupNamespace('p')).toBe('u:mine');
    expect(serializeXml(el)).toBe('<a xmlns:p="u:mine" xmlns="u:a"/>');
  });
});
