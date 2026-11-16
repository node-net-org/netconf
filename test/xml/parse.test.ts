import { describe, expect, it } from 'vitest';
import { parseXml, XmlError, XML_NS } from '../../src/index.js';

const NC = 'urn:ietf:params:xml:ns:netconf:base:1.0';

describe('parseXml: namespaces', () => {
  it('resolves default and prefixed namespaces to URIs', () => {
    const el = parseXml(
      `<rpc-reply xmlns="${NC}" xmlns:if="urn:if" message-id="7"><data><if:interfaces><if:name>ge0</if:name></if:interfaces></data></rpc-reply>`,
    );
    expect(el.name).toBe('rpc-reply');
    expect(el.ns).toBe(NC);
    expect(el.attr('message-id')).toBe('7');
    const ifs = el.path('data/interfaces')!;
    expect(ifs.ns).toBe('urn:if');
    expect(ifs.prefix).toBe('if');
    expect(ifs.child('name', 'urn:if')!.text()).toBe('ge0');
    expect(el.child('data', 'urn:other')).toBeUndefined();
  });

  it('lets a child undeclare the default namespace', () => {
    const el = parseXml('<a xmlns="urn:a"><b xmlns=""><c/></b></a>');
    expect(el.path('b')!.ns).toBe('');
    expect(el.path('b/c')!.ns).toBe('');
  });

  it('gives unprefixed attributes no namespace and prefixed ones their namespace', () => {
    const el = parseXml('<a xmlns="urn:a" xmlns:nc="urn:nc" x="1" nc:operation="delete"/>');
    expect(el.attr('x')).toBe('1');
    expect(el.attr('operation')).toBeUndefined();
    expect(el.attr('operation', 'urn:nc')).toBe('delete');
  });

  it('keeps namespace declarations so prefixes inside values stay resolvable', () => {
    const el = parseXml('<type xmlns:ianaift="urn:iana">ianaift:ethernetCsmacd</type>');
    expect(el.declarations.get('ianaift')).toBe('urn:iana');
  });

  it('predeclares the xml prefix', () => {
    const el = parseXml('<m xml:lang="en">hi</m>');
    expect(el.attr('lang', XML_NS)).toBe('en');
  });

  it('rejects an unbound prefix', () => {
    expect(() => parseXml('<p:a/>')).toThrow(XmlError);
    expect(() => parseXml('<a p:x="1"/>')).toThrow(/Unbound/);
  });

  it('rejects duplicate attributes after namespace resolution', () => {
    expect(() => parseXml('<a xmlns:p="urn:x" xmlns:q="urn:x" p:y="1" q:y="2"/>')).toThrow(/Duplicate/);
  });
});

describe('parseXml: character data', () => {
  it('decodes predefined entities and character references', () => {
    expect(parseXml('<a>&lt;&gt;&amp;&quot;&apos;&#65;&#x42;&#x1F600;</a>').text()).toBe('<>&"\'AB😀');
  });

  it('decodes entities in attribute values and normalises whitespace', () => {
    expect(parseXml('<a v="1&amp;2&#10;\tz"/>').attr('v')).toBe('1&2\n z');
  });

  it('keeps CDATA content literally', () => {
    expect(parseXml('<a>x<![CDATA[<b>&amp;]]>y</a>').text()).toBe('x<b>&amp;y');
  });

  it('drops whitespace-only text between elements but keeps it in leaf elements', () => {
    const el = parseXml('<a>\n  <b>  </b>\n  <c>v</c>\n</a>');
    expect(el.children).toHaveLength(2);
    expect(el.child('b')!.text()).toBe('  ');
  });

  it('normalises CRLF line endings', () => {
    expect(parseXml('<a>1\r\n2\r3</a>').text()).toBe('1\n2\n3');
  });

  it('ignores the XML declaration, comments and processing instructions', () => {
    const el = parseXml('<?xml version="1.0" encoding="UTF-8"?>\n<!-- c --><a><?pi x?><!-- d --><b/></a>');
    expect(el.elements.map((e) => e.name)).toEqual(['b']);
  });

  it('rejects undefined entities and bare ampersands', () => {
    expect(() => parseXml('<a>&nbsp;</a>')).toThrow(XmlError);
    expect(() => parseXml('<a x="&foo;"/>')).toThrow(XmlError);
  });

  it('rejects character references to characters XML forbids', () => {
    expect(() => parseXml('<a>&#0;</a>')).toThrow(XmlError);
    expect(() => parseXml('<a>&#xD800;</a>')).toThrow(XmlError);
  });
});

describe('parseXml: hardening', () => {
  it('rejects any DOCTYPE (XXE and entity expansion)', () => {
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY e "boom">]><a>&e;</a>')).toThrow(/DOCTYPE/);
    expect(() => parseXml('<!DOCTYPE a SYSTEM "file:///etc/passwd"><a/>')).toThrow(/DOCTYPE/);
    const lol = '<!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><l>&b;</l>';
    expect(() => parseXml(lol)).toThrow(XmlError);
  });

  it('rejects malformed documents', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(/Malformed/);
    expect(() => parseXml('')).toThrow(XmlError);
    expect(() => parseXml('just text')).toThrow(XmlError);
  });

  it('requires exactly one root and nothing else outside it', () => {
    expect(() => parseXml('<a/><b/>')).toThrow(XmlError);
    expect(() => parseXml('<a/>junk')).toThrow(XmlError);
    expect(parseXml('  <a/>  ').name).toBe('a');
  });

  it('enforces maxDepth', () => {
    const deep = '<a>'.repeat(20) + '</a>'.repeat(20);
    expect(() => parseXml(deep, { maxDepth: 10 })).toThrow(/maxDepth/);
    expect(parseXml(deep, { maxDepth: 20 }).name).toBe('a');
  });

  it('enforces maxNodes', () => {
    const wide = `<a>${'<b/>'.repeat(100)}</a>`;
    expect(() => parseXml(wide, { maxNodes: 50 })).toThrow(/maxNodes/);
  });

  it('treats __proto__, constructor and toString as ordinary names without polluting prototypes', () => {
    const el = parseXml('<a constructor="1" toString="2"><__proto__><polluted>x</polluted></__proto__></a>');
    expect(el.child('__proto__')!.child('polluted')!.text()).toBe('x');
    expect(el.attr('constructor')).toBe('1');
    expect(el.attr('toString')).toBe('2');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('keeps other JavaScript-ish names unchanged', () => {
    const el = parseXml('<a toString="1" valueOf="2"><hasOwnProperty>x</hasOwnProperty><toString/></a>');
    expect(el.elements.map((e) => e.name)).toEqual(['hasOwnProperty', 'toString']);
    expect(el.attr('toString')).toBe('1');
    expect(el.attr('valueOf')).toBe('2');
  });

  it('caps maxDepth at MAX_PARSE_DEPTH', () => {
    const deep = '<a>'.repeat(1100) + '</a>'.repeat(1100);
    expect(() => parseXml(deep, { maxDepth: 5000 })).toThrow(/maxDepth/);
  });

  it('reports absurd nesting as an XmlError rather than crashing', () => {
    const deep = '<a>'.repeat(200_000) + '</a>'.repeat(200_000);
    expect(() => parseXml(deep)).toThrow(XmlError);
  });

  it('rejects text before the root element', () => {
    expect(() => parseXml('junk<a/>')).toThrow(XmlError);
    expect(parseXml('\uFEFF<a/>').name).toBe('a');
  });
});

describe('parseXml: defaultNamespace', () => {
  it('puts unqualified elements in the given namespace, as if nested in a declaring parent', () => {
    const el = parseXml('<get><filter xmlns="urn:f"><a/></filter><b xmlns=""/></get>', { defaultNamespace: NC });
    expect(el.ns).toBe(NC);
    expect(el.path('filter/a')!.ns).toBe('urn:f');
    expect(el.child('b')!.ns).toBe('');
  });
});
