/**
 * The single-pass parser against the parser
 * it replaced: @rgrove/parse-xml plus the old conversion, kept as
 * reference-parse.ts. For any text, both must build the same XmlElement
 * (names, namespaces, prefixes, attributes, text, declarations and in-scope
 * namespaces), or both must throw an XmlError.
 *
 * The documents are built from fragments chosen for the rules a hand-written
 * parser gets wrong: entities and character references, CDATA, comments,
 * processing instructions, the XML declaration, namespace declarations and
 * prefixes, CR, CRLF and TAB in text and attribute values, non-BMP and
 * forbidden characters. Then they are mutated, so malformed text is compared
 * too.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { XmlError } from '../../src/errors.js';
import { parseXml, type XmlElement } from '../../src/xml/index.js';
import { referenceParseXml } from './reference-parse.js';

interface Plain {
  name: string;
  ns: string | undefined;
  prefix: string | undefined;
  attributes: { name: string; ns: string | undefined; prefix: string | undefined; value: string }[];
  children: (Plain | string)[];
  declarations: [string, string][];
  inScope: [string, string][];
}

function plain(el: XmlElement): Plain {
  return {
    name: el.name,
    ns: el.ns,
    prefix: el.prefix,
    attributes: el.attributes.map((a) => ({ name: a.name, ns: a.ns, prefix: a.prefix, value: a.value })),
    children: el.children.map((c) => (typeof c === 'string' ? c : plain(c))),
    declarations: [...el.declarations],
    inScope: [...el.inScope],
  };
}

type Outcome = { readonly tree: Plain } | { readonly error: string };

function outcome(parse: (text: string) => XmlElement, text: string): Outcome {
  try {
    return { tree: plain(parse(text)) };
  } catch (err) {
    if (err instanceof XmlError) return { error: 'XmlError' };
    throw err;
  }
}

function sameAsReference(text: string): void {
  const expected = outcome(referenceParseXml, text);
  const actual = outcome((t) => parseXml(t), text);
  expect(actual, JSON.stringify(text)).toEqual(expected);
}

// --- fragments ----------------------------------------------------------------------------------

const ELEMENT_NAMES = ['a', 'b', 'p:c', 'q:d', 'é', 'a.b-c_d', 'xml:e', '_', 'A1'];
// A non-BMP name character is an XML Name but not an NCName: both parsers refuse it.
const BAD_NAMES = ['\u{10000}x', '-x', '1a', 'a:b:c', ':a', 'a:', 'p:', '', 'x:y'];
const ATTR_NAMES = ['x', 'y', 'p:x', 'q:y', 'xml:lang', 'xmlns', 'xmlns:p', 'xmlns:q'];
const BAD_ATTR_NAMES = ['xml:space', 'xmlns:xml', 'xmlns:xmlns', 'xmlns:1', 'z:x', 'q:x'];
const URIS = ['urn:p', 'urn:q', 'urn:p', '', 'http://www.w3.org/XML/1998/namespace', 'http://www.w3.org/2000/xmlns/'];
const BAD_ATTR_VALUE_PARTS = ['<', '&', '&bogus;', '&#0;', '&#xD800;', '&#X41;', '&#x;', '\u0001', '\uD800'];
const ATTR_VALUE_PARTS = [
  'v',
  ' ',
  '\t',
  '\n',
  '\r',
  '\r\n',
  '&amp;',
  '&lt;',
  '&quot;',
  '&apos;',
  '&#10;',
  '&#x9;',
  '&#13;',
  '&#x1D11E;',
  '𝄞',
  '>',
  "'",
  '"',
  'default',
  'preserve',
  ' ',
  ...URIS,
];
const BAD_TEXT_PARTS = [
  '&#x110000;',
  '&#0;',
  '&nbsp;',
  '&',
  '&amp',
  ']]>',
  '<![CDATA[unclosed',
  '<!-- a--b -->',
  '<!--->',
  '<?xml x?>',
  '<?XmL?>',
  '<?pi',
  '<?',
  '<!',
  '<!x>',
  '<',
  '</',
  '\u0001',
  '\uD800',
  '\uDC00x',
  '\uFFFE',
];
const TEXT_PARTS = [
  'text',
  ' ',
  '  \n  ',
  '\t',
  '\r',
  '\r\n',
  '\n\r',
  ' ',
  ' ',
  '𝄞',
  '&amp;',
  '&lt;',
  '&gt;',
  '&#10;',
  '&#13;',
  '&#x1F600;',
  '&#x10FFFF;',
  '&#65;',
  '&#x41;',
  ']]',
  ']',
  '>',
  '<![CDATA[x\r\ny]]>',
  '<![CDATA[<a>&amp;]]>',
  '<![CDATA[]]>',
  '<!-- c -->',
  '<!---->',
  '<!-- \r\n -->',
  '<?pi data?>',
  '<?pi?>',
  '<?pi\r\nx?>',
  '<?xml-stylesheet href="x"?>',
  '﻿',
];
const PROLOGS = [
  '',
  '',
  '<?xml version="1.0"?>',
  '<?xml version="1.0" encoding="UTF-8"?>',
  "<?xml version='1.1' encoding='utf-8' standalone='no'?>",
  '<?xml version="1.0" standalone="yes" ?>',
  '<?xml version = "1.0" encoding = "x.y-z_1" ?>',
  '<?xml version="2.0"?>',
  '<?xml version="1.0" encoding="8bit"?>',
  '<?xml version="1.0" standalone="maybe"?>',
  '<?xml version="1.0"encoding="UTF-8"?>',
  '<?xml version="1.0" encoding="UTF-8" foo?>',
  '<?xml?>',
  '<?xml version="1.0"',
  '<?xml-stylesheet href="s"?>',
  '﻿',
  '﻿<?xml version="1.0"?>',
  ' <?xml version="1.0"?>',
  '<!-- pro -->',
  '\n<?pi x?>\n',
  'junk',
];
const EPILOGS = ['', '', '\n', ' <!-- end --> ', '<?pi?>', 'junk', '<b/>', '&amp;', ' ', '<!-- a--b -->'];

const pick = <T>(xs: readonly T[]): fc.Arbitrary<T> => fc.constantFrom(...xs);

/** Mostly `good`, sometimes `bad`: enough well-formed documents for the trees to be compared, and enough errors to compare. */
const mostly = <T>(good: readonly T[], bad: readonly T[]): fc.Arbitrary<T> => fc.oneof({ weight: 24, arbitrary: pick(good) }, { weight: 1, arbitrary: pick(bad) });

const attrValue = fc.array(mostly(ATTR_VALUE_PARTS, BAD_ATTR_VALUE_PARTS), { maxLength: 4 }).map((ps) => ps.join(''));
const attribute = fc
  .tuple(
    mostly(ATTR_NAMES, BAD_ATTR_NAMES),
    fc.constantFrom(' ', ' ', '  ', '\n', '\t', ''),
    fc.constantFrom('=', '=', ' = ', '=\r\n'),
    fc.constantFrom('"', "'"),
    attrValue,
    mostly(['urn:p', 'urn:q', 'urn:r'], URIS),
  )
  .map(([name, ws, eq, q, value, uri]) => {
    const v = name.startsWith('xmlns') ? uri : value;
    return { name, text: `${ws === '' ? '' : ws}${name}${eq}${q}${v.split(q).join(q === '"' ? '&quot;' : '&apos;')}${q}` };
  });
const attributes = fc
  .uniqueArray(attribute, { maxLength: 3, selector: (a) => a.name })
  .chain((as) => fc.boolean().map((dup) => (dup && as.length > 0 && Math.random() < 0.05 ? [...as, as[0]!] : as)))
  .map((as) => as.map((a) => (a.text.startsWith(a.name) ? ` ${a.text}` : a.text)).join(''));

const { element } = fc.letrec<{ element: string; content: string }>((tie) => ({
  element: fc
    .tuple(mostly(ELEMENT_NAMES, BAD_NAMES), attributes, fc.constantFrom('', '', ' ', '\n'), fc.option(tie('content'), { freq: 3 }), mostly(['', '', ' ', '\r\n'], ['x']))
    .map(([name, attrs, ws, content, endWs]) =>
      content === null ? `<${name}${attrs}${ws}/>` : `<${name}${attrs}${ws}>${content}</${endWs === 'x' ? 'x' : name}${endWs === 'x' ? '' : endWs}>`,
    ),
  content: fc
    .array(fc.oneof({ weight: 3, arbitrary: mostly(TEXT_PARTS, BAD_TEXT_PARTS) }, { weight: 2, arbitrary: tie('element') }), { maxLength: 5 })
    .map((parts) => parts.join('')),
}));

/** Usually a root declaring the prefixes the fragments use, around generated content. */
const root = fc.oneof(
  { weight: 3, arbitrary: element.map((e) => `<r xmlns:p="urn:p" xmlns:q="urn:q">${e}</r>`) },
  { weight: 1, arbitrary: element },
);
const document = fc
  .tuple(mostly(PROLOGS.slice(0, 7), PROLOGS.slice(7)), root, mostly(EPILOGS.slice(0, 5), EPILOGS.slice(5)))
  .map(([p, r, e]) => p + r + e);

/** A namespaced document that is usually well-formed, so the tree comparison does real work. */
const namespaced = fc
  .tuple(
    fc.tuple(fc.constantFrom('', ' xmlns="urn:d"'), fc.constantFrom('urn:p', 'urn:q')).map(([d, p]) => [`xmlns:p="${p}"${d}`, 'xmlns:q="urn:q"']),
    fc.array(
      fc.tuple(pick(['a', 'p:a', 'q:b', 'c']), fc.subarray(['x="1"', 'p:x="2"', 'q:y="3"', 'xmlns=""', 'xmlns:p="urn:p2"']), pick(TEXT_PARTS.slice(0, 20))),
      { maxLength: 6 },
    ),
  )
  .map(([decls, kids]) => {
    const inner = kids.map(([n, as, t]) => `<${n}${as.map((a) => ` ${a}`).join('')}>${t}<${n === 'c' ? 'p:z' : 'b'}/></${n}>`).join('\n  ');
    return `<r ${decls.join(' ')}>\n  ${inner}\n</r>`;
  });

const mutation: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({ kind: fc.constant('delete' as const), at: fc.nat(), length: fc.integer({ min: 1, max: 4 }) }),
  fc.record({ kind: fc.constant('insert' as const), at: fc.nat(), text: pick([...TEXT_PARTS, '"', "'", '=', '/', '>', ' ', 'xmlns:p="urn:p"', '</a>', '<a>']) }),
  fc.record({ kind: fc.constant('swap' as const), at: fc.nat(), length: fc.integer({ min: 1, max: 6 }) }),
);

type Mutation = { readonly kind: 'delete' | 'swap'; readonly at: number; readonly length: number } | { readonly kind: 'insert'; readonly at: number; readonly text: string };

function mutate(text: string, ms: readonly Mutation[]): string {
  let s = text;
  for (const m of ms) {
    const at = s.length === 0 ? 0 : m.at % (s.length + 1);
    if (m.kind === 'insert') s = s.slice(0, at) + m.text + s.slice(at);
    else if (m.kind === 'delete') s = s.slice(0, at) + s.slice(at + m.length);
    else s = s.slice(0, at) + s.slice(at, at + m.length).split('').reverse().join('') + s.slice(at + m.length);
  }
  return s;
}

describe('parseXml matches @rgrove/parse-xml and the old conversion (differential)', () => {
  it('on generated documents', () => {
    fc.assert(fc.property(document, sameAsReference), { numRuns: 3000 });
  });

  it('on namespaced, mostly well-formed documents', () => {
    fc.assert(fc.property(namespaced, sameAsReference), { numRuns: 1500 });
  });

  it('on mutated documents', () => {
    fc.assert(
      fc.property(fc.oneof(document, namespaced), fc.array(mutation, { minLength: 1, maxLength: 3 }), (text, ms) => sameAsReference(mutate(text, ms))),
      { numRuns: 3000 },
    );
  });

  it('on arbitrary text', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 60 }), sameAsReference), { numRuns: 2000 });
    fc.assert(fc.property(fc.string({ unit: fc.constantFrom('<', '>', '/', 'a', '!', '-', '?', '&', ';', '#', 'x', '"', '=', ' ', '[', ']', 'C'), maxLength: 30 }), sameAsReference), {
      numRuns: 3000,
    });
  });

  it('on fixed cases', () => {
    for (const text of [
      '<a/>',
      '<a></a>',
      '<a >x</a >',
      '<a\r\nb="1\r\n2\t3"\r\n/>',
      '<a b="&#10;&#9;&#13;">\r\nx\ry\r\n</a>',
      '<a><![CDATA[\r\n]]>&#13;</a>',
      '<a>x<!-- c -->y<?p?>z</a>',
      '<a> <b/> &#32; </a>',
      '<a> <b/></a>',
      '<p:a xmlns:p="urn:p" p:x="1" x="2"/>',
      '<a xmlns:p="urn:x" xmlns:q="urn:x" p:y="1" q:y="2"/>',
      '<a xmlns="urn:d"><b xmlns=""><c/></b></a>',
      '<a xml:lang="en" xml:space="preserve"/>',
      '<a xml:space="other"/>',
      '<a b="1" b="2"/>',
      '<a b="1"c="2"/>',
      '<a>]]></a>',
      '<a>&#x1F600;</a>',
      '﻿<?xml version="1.0"?><a/>',
      '<?xml version="1.0"?>\n<!-- c -->\n<a/>\n<?p x?>\n',
      '<a/><!-- a--b -->',
      '<\u{10000}/>',
      '<a>\u{1D11E}</a>',
    ]) {
      sameAsReference(text);
    }
  });
});
