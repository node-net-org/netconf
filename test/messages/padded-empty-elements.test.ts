import { describe, expect, it } from 'vitest';
import { BASE_1_0, BASE_1_1, NETCONF_NS, openSession, parseXml, serializeXml, x, type SessionQuirks } from '../../src/index.js';
import { stripPaddedEmptyElements } from '../../src/messages/quirks.js';
import { FakeServer } from '../../src/testing/index.js';

const strip = (xml: string): { xml: string; emptied: number } => {
  const { element, emptied } = stripPaddedEmptyElements(parseXml(xml));
  return { xml: serializeXml(element), emptied };
};

describe('stripPaddedEmptyElements (the paddedEmptyElements: strip quirk)', () => {
  it('empties the 7210 padding: a line feed and the closing tag indentation', () => {
    const padded = `<e><access>\n${' '.repeat(20)}</access></e>`;
    expect(strip(padded)).toEqual({ xml: '<e><access/></e>', emptied: 1 });
  });

  it.each([
    ['LF', '\n'],
    ['CR LF', '\r\n'],
    ['CR', '\r'],
    ['LF and tabs', '\n\t\t'],
    ['spaces around LF', '  \n  '],
  ])('empties whitespace containing a line break (%s)', (_name, ws) => {
    expect(strip(`<a>${ws}</a>`)).toEqual({ xml: '<a/>', emptied: 1 });
  });

  it.each([
    ['one space', ' '],
    ['spaces', '    '],
    ['a tab', '\t'],
    ['text', 'foo'],
    ['text padded with spaces', '  foo  '],
    ['text padded with line breaks', '\nfoo\n'],
    ['a non-breaking space with a line break', ' \n'],
  ])('keeps %s', (_name, text) => {
    const xml = `<a>${text}</a>`;
    expect(strip(xml)).toEqual({ xml: serializeXml(parseXml(xml)), emptied: 0 });
  });

  it('leaves empty elements and elements with children alone, and reuses unchanged subtrees', () => {
    const el = parseXml('<a><b/><c></c><d><e>x</e></d></a>');
    const { element, emptied } = stripPaddedEmptyElements(el);
    expect(emptied).toBe(0);
    expect(element).toBe(el);
  });

  it('empties nested padding throughout the tree and keeps names, namespaces, prefixes and attributes', () => {
    const xml = '<p:a xmlns:p="urn:p" k="v"><p:b>\n </p:b><c xmlns="urn:c" z="1"><d>\n</d><e>1</e></c></p:a>';
    expect(strip(xml)).toEqual({ xml: '<p:a xmlns:p="urn:p" k="v"><p:b/><c xmlns="urn:c" z="1"><d/><e>1</e></c></p:a>', emptied: 2 });
  });
});

describe('the paddedEmptyElements quirk in a session', () => {
  const handler = (): { data: ReturnType<typeof x> } => ({
    data: x('port', { xmlns: 'urn:lab' }, x('access', `\n${' '.repeat(20)}`), x('name', '  \n')),
  });

  async function reply(quirks?: SessionQuirks): Promise<string> {
    const server = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1], handler });
    const connection = await server.transport()(new AbortController().signal);
    const session = await openSession(connection, quirks === undefined ? {} : { onHello: () => ({ quirks }) });
    try {
      const r = await session.rpc(x('get-config', { xmlns: NETCONF_NS }, x('source', x('running'))));
      return serializeXml(r.data!.elements[0]!);
    } finally {
      await session.close();
    }
  }

  it("keeps the padding by default ('keep')", async () => {
    expect(await reply()).toBe(`<port xmlns="urn:lab"><access>\n${' '.repeat(20)}</access><name>  \n</name></port>`);
    expect(await reply({ paddedEmptyElements: 'keep' })).toContain('<access>\n');
  });

  it("empties padded elements in received replies with 'strip'", async () => {
    expect(await reply({ paddedEmptyElements: 'strip' })).toBe('<port xmlns="urn:lab"><access/><name/></port>');
  });
});
