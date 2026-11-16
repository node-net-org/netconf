import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseXml, serializeXml, x, XmlElement, XmlError } from '../../src/index.js';

const NC = 'urn:ietf:params:xml:ns:netconf:base:1.0';

describe('x() builder + serializeXml', () => {
  it('builds a typical NETCONF request', () => {
    const rpc = x('rpc', { xmlns: NC, 'message-id': 101 },
      x('get-config',
        x('source', x('running')),
        x('filter', { type: 'subtree' }, x('interfaces', { xmlns: 'urn:if' })),
      ),
    );
    expect(serializeXml(rpc)).toBe(
      `<rpc xmlns="${NC}" message-id="101"><get-config><source><running/></source>` +
        '<filter type="subtree"><interfaces xmlns="urn:if"/></filter></get-config></rpc>',
    );
  });

  it('skips null, undefined and false children and attributes, and flattens arrays', () => {
    const on = false;
    const el = x('a', { keep: 'y', drop: undefined, gone: null }, on && x('no'), null, [x('b'), ['t', 3]]);
    expect(serializeXml(el)).toBe('<a keep="y"><b/>t3</a>');
  });

  it('emits qualified attributes with a declared prefix', () => {
    const el = x('config', { xmlns: 'urn:a' },
      x('item', { operation: { ns: NC, prefix: 'nc', value: 'delete' } }));
    expect(serializeXml(el)).toBe(`<config xmlns="urn:a"><item xmlns:nc="${NC}" nc:operation="delete"/></config>`);
  });

  it('generates a prefix when none is given', () => {
    const el = x('a', { v: { ns: 'urn:q', value: 1 } });
    expect(serializeXml(el)).toBe('<a xmlns:ns0="urn:q" ns0:v="1"/>');
  });

  it('declares extra prefixes for use inside values', () => {
    const el = x('type', { 'xmlns:ianaift': 'urn:iana' }, 'ianaift:ethernetCsmacd');
    expect(serializeXml(el)).toBe('<type xmlns:ianaift="urn:iana">ianaift:ethernetCsmacd</type>');
  });

  it('undeclares the default namespace for a no-namespace child', () => {
    const child = new XmlElement({ name: 'b', ns: '' });
    expect(serializeXml(x('a', { xmlns: 'urn:a' }, child))).toBe('<a xmlns="urn:a"><b xmlns=""/></a>');
  });

  it('escapes text and attributes', () => {
    const el = x('a', { v: '"<&>\n\t' }, '<&>]]>]]>');
    const s = serializeXml(el);
    expect(s).toBe('<a v="&quot;&lt;&amp;&gt;&#10;&#9;">&lt;&amp;&gt;]]&gt;]]&gt;</a>');
    expect(s).not.toContain(']]>]]>');
  });

  it('adds an XML declaration on request', () => {
    expect(serializeXml(x('a'), { declaration: true })).toBe('<?xml version="1.0" encoding="UTF-8"?><a/>');
  });

  it('rejects invalid names (no markup injection through names)', () => {
    expect(() => serializeXml(x('a b'))).toThrow(XmlError);
    expect(() => serializeXml(x('a><evil/'))).toThrow(XmlError);
    expect(() => serializeXml(x('a', { 'x"y': 1 }))).toThrow(XmlError);
    expect(() => serializeXml(x('p:a'))).toThrow(XmlError);
  });

  it('rejects characters XML cannot represent', () => {
    expect(() => serializeXml(x('a', '\u0000'))).toThrow(/U\+0000/);
    expect(() => serializeXml(x('a', { v: '\u0001' }))).toThrow(XmlError);
    expect(() => serializeXml(x('a', '\uD800'))).toThrow(XmlError);
  });
});

describe('round trip', () => {
  it('parse → serialize → parse preserves namespaces, attributes, text and order', () => {
    const src =
      `<rpc-reply xmlns="${NC}" xmlns:if="urn:if" xmlns:ianaift="urn:iana" message-id="9">` +
      '<data><if:interfaces><if:interface><if:name>a&amp;b</if:name><if:type>ianaift:ethernetCsmacd</if:type></if:interface>' +
      '<if:interface><if:name>c</if:name></if:interface></if:interfaces><x xmlns="" y="1"/></data></rpc-reply>';
    const once = parseXml(src);
    const twice = parseXml(serializeXml(once));
    expect(twice).toEqual(once);
    expect(twice.declarations.get('ianaift')).toBe('urn:iana');
  });

  it('holds for arbitrary text and attribute values (property)', () => {
    // Strings of XML-legal characters, including markup-like and delimiter-like content.
    const xmlChar = fc.oneof(
      fc.constantFrom('<', '>', '&', '"', "'", ']', ']]>', ']]>]]>', '\t', '\n', 'é', '😀', ' '),
      fc.string({ unit: 'grapheme', maxLength: 4 }),
    );
    const xmlText = fc.array(xmlChar, { maxLength: 12 }).map((p) => p.join(''))
      .filter((s) => !/[^\t\n\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(s));
    fc.assert(
      fc.property(xmlText, xmlText, (text, attr) => {
        const out = serializeXml(x('a', { v: attr }, text));
        expect(out).not.toContain(']]>]]>');
        const back = parseXml(out);
        expect(back.attr('v')).toBe(attr);
        expect(back.text()).toBe(text.trim() === '' && text !== '' ? text : text);
      }),
    );
  });
});

describe('serializeXml indent', () => {
  const tree = x('data', { xmlns: 'urn:a' },
    x('interfaces',
      x('interface', x('name', 'eth0'), x('enabled', 'true'), x('description')),
    ),
  );

  it('puts each child element on its own line, text-only elements on one line', () => {
    expect(serializeXml(tree, { indent: 2 })).toBe([
      '<data xmlns="urn:a">',
      '  <interfaces>',
      '    <interface>',
      '      <name>eth0</name>',
      '      <enabled>true</enabled>',
      '      <description/>',
      '    </interface>',
      '  </interfaces>',
      '</data>',
    ].join('\n'));
  });

  it('accepts an indent string, and puts the declaration on its own line', () => {
    expect(serializeXml(x('a', x('b')), { indent: '\t', declaration: true }))
      .toBe('<?xml version="1.0" encoding="UTF-8"?>\n<a>\n\t<b/>\n</a>');
  });

  it('is compact without indent, or with indent 0 or ""', () => {
    const compact = '<data xmlns="urn:a"><interfaces><interface><name>eth0</name><enabled>true</enabled><description/></interface></interfaces></data>';
    expect(serializeXml(tree)).toBe(compact);
    expect(serializeXml(tree, { indent: 0 })).toBe(compact);
    expect(serializeXml(tree, { indent: '' })).toBe(compact);
  });

  it('drops whitespace between child elements and re-indents parsed input', () => {
    const parsed = parseXml('<a>\n      <b>1</b>\n   <c> 2 </c>\n</a>');
    expect(serializeXml(parsed, { indent: 2 })).toBe('<a>\n  <b>1</b>\n  <c> 2 </c>\n</a>');
  });

  it('leaves mixed content and its whitespace exactly as it is', () => {
    const el = x('p', x('q', ' lead ', x('b', 'x'), ' tail '));
    expect(serializeXml(el, { indent: 2 })).toBe('<p>\n  <q> lead <b>x</b> tail </q>\n</p>');
  });

  it('round-trips element content, ignoring the added whitespace', () => {
    const back = parseXml(serializeXml(tree, { indent: 2 }));
    expect(serializeXml(parseXml(serializeXml(back, { indent: 2 })))).toBe(serializeXml(back));
    expect(back.path('interfaces/interface/name')?.text()).toBe('eth0');
  });
});

describe('XmlElement display', () => {
  it('toString() is the compact serialisation', () => {
    const el = x('a', { xmlns: 'urn:a' }, x('b', '1'));
    expect(String(el)).toBe('<a xmlns="urn:a"><b>1</b></a>');
  });

  it('util.inspect (console.log) shows indented XML', async () => {
    const { inspect } = await import('node:util');
    const el = x('a', { xmlns: 'urn:a' }, x('b', '1'));
    expect(inspect(el)).toBe('<a xmlns="urn:a">\n  <b>1</b>\n</a>');
    expect(inspect({ reply: el })).toContain('<b>1</b>');
  });

  it('inspect does not throw for an element that cannot be serialised', async () => {
    const { inspect } = await import('node:util');
    const bad = new XmlElement({ name: 'bad name', ns: '' });
    expect(inspect(bad)).toMatch(/^XmlElement <bad name> \(not serialisable: /);
    expect(() => String(bad)).toThrow(XmlError);
  });
});
