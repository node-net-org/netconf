// Parse limits are enforced before any tree is built, and hostile
// text only ever produces an XmlError.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARSE_LIMITS, parseXml, XmlError, type XmlElement } from '../../src/index.js';

/** Elements, attributes and text runs in a parsed tree. */
function treeNodes(el: XmlElement): number {
  let n = 1 + el.attributes.length;
  for (const c of el.children) n += typeof c === 'string' ? 1 : treeNodes(c);
  return n;
}

/** How long `fn` took, in ms, and what it threw. */
function timed(fn: () => unknown): { ms: number; error: unknown } {
  const start = performance.now();
  try {
    fn();
    return { ms: performance.now() - start, error: undefined };
  } catch (error) {
    return { ms: performance.now() - start, error };
  }
}

describe('parseXml: limits are checked before the tree is built', () => {
  // First in the file, so the process's peak RSS is not yet raised by other tests.
  it('rejects 2M empty elements under maxNodes 100 at once, not after exhausting the heap', () => {
    // Before the fix this built the whole tree first: about 1.4 KB per element,
    // an OOM at 512 MB of heap.
    const text = `<r>${'<a/>'.repeat(2_000_000)}</r>`;
    const peakBefore = process.resourceUsage().maxRSS; // KiB
    const { ms, error } = timed(() => parseXml(text, { maxNodes: 100 }));
    const peakGrowth = (process.resourceUsage().maxRSS - peakBefore) * 1024;
    expect(error).toBeInstanceOf(XmlError);
    expect((error as Error).message).toBe('Document exceeds maxNodes (100)');
    expect(peakGrowth).toBeLessThan(64 * 1024 * 1024);
    expect(ms).toBeLessThan(500);
  });

  it('defaults to depth 256 and 1,000,000 nodes', () => {
    expect(DEFAULT_PARSE_LIMITS).toEqual({ maxDepth: 256, maxNodes: 1_000_000 });
  });

  it('rejects a flood over the default maxNodes before parsing it', () => {
    const text = `<r>${'<a/>'.repeat(1_000_001)}</r>`;
    const { ms, error } = timed(() => parseXml(text));
    expect((error as Error).message).toBe('Document exceeds maxNodes (1000000)');
    expect(ms).toBeLessThan(1000);
  });

  it('counts attributes, so one element with a million attributes is refused', () => {
    const attrs = Array.from({ length: 200_000 }, (_, i) => `a${i}=""`).join(' ');
    expect(() => parseXml(`<r ${attrs}/>`, { maxNodes: 1000 })).toThrow('Document exceeds maxNodes (1000)');
  });

  it('counts processing instructions and comments', () => {
    expect(() => parseXml(`<r>${'<?p?>'.repeat(100_000)}</r>`, { maxNodes: 1000 })).toThrow(/maxNodes/);
    expect(() => parseXml(`<r>${'<!---->'.repeat(100_000)}</r>`, { maxNodes: 1000 })).toThrow(/maxNodes/);
  });

  it('honours a maxDepth above 256, up to MAX_PARSE_DEPTH', () => {
    // The old parser also applied @rgrove/parse-xml's own limit of 256, so this failed.
    const deep = (n: number): string => '<a>'.repeat(n) + 'x' + '</a>'.repeat(n);
    let el = parseXml(deep(300), { maxDepth: 512 });
    for (let i = 1; i < 300; i++) el = el.child('a')!;
    expect(el.text()).toBe('x');
    expect(parseXml(deep(1024), { maxDepth: 1024 }).name).toBe('a');
    expect(() => parseXml(deep(300), { maxDepth: 299 })).toThrow('Element nesting exceeds maxDepth (299)');
  });

  it('rejects deep nesting before parsing, at the first level past maxDepth', () => {
    const deep = '<a>'.repeat(1_000_000) + '</a>'.repeat(1_000_000);
    const { ms, error } = timed(() => parseXml(deep));
    expect((error as Error).message).toBe('Element nesting exceeds maxDepth (256)');
    expect(ms).toBeLessThan(500);
  });

  it('counts exactly elements, attributes and text runs inside the root', () => {
    const text = '<?xml version="1.0"?>\n<a x="1"><b>t</b><c/></a>\n';
    // a, x, b, "t", c
    expect(treeNodes(parseXml(text, { maxNodes: 5 }))).toBe(5);
    expect(() => parseXml(text, { maxNodes: 4 })).toThrow(/maxNodes/);
  });

  it('does not count markup inside CDATA, comments or attribute values', () => {
    const text = `<r a="x>y" c='/>'><![CDATA[${'<b/>'.repeat(1000)}]]><!--${'<c/>'.repeat(1000)}--><d/></r>`;
    // r, a, c, the CDATA text, the comment, d
    expect(parseXml(text, { maxNodes: 6 }).child('d')).toBeDefined();
  });

  it("doesn't take '/>' inside a quoted attribute value for the end of an empty element", () => {
    const text = '<r a="/>"><b q=\'x/>\'><c/></b></r>';
    expect(() => parseXml(text, { maxDepth: 2 })).toThrow(/maxDepth/);
    expect(parseXml(text, { maxDepth: 3 }).path('b/c')).toBeDefined();
  });
});

// Well-formed documents that use every kind of markup the pre-scan has to
// recognise: attributes whose values hold '>' and '/>', comments, CDATA,
// processing instructions, entity and character references, and text with '>'.
const name = fc.constantFrom('a', 'b', 'c', 'if:x', 'd-e');
const attrValue = fc.constantFrom('', '1', '>', '/>', 'a&gt;b', "it's", '&#60;');
const textRun = fc.constantFrom('t', ' ', '\n  ', 'a > b', '&amp;', '&#x3c;', ']]');
const misc = fc.constantFrom('<!-- c > d -->', '<![CDATA[<x/> ]]>', '<?pi a > b?>');

const xmlTree: fc.Arbitrary<string> = fc.letrec<{ el: string }>((tie) => ({
  el: fc
    .tuple(
      name,
      fc.uniqueArray(fc.tuple(fc.constantFrom('p', 'q', 'r', 'xmlns:if'), attrValue), { selector: ([k]) => k, maxLength: 3 }),
      fc.array(fc.oneof({ depthSize: 'small' }, textRun, misc, tie('el')), { maxLength: 4 }),
      fc.constantFrom('"', "'"),
    )
    .map(([n, attrs, children, q]) => {
      const a = attrs.map(([k, v]) => ` ${k}=${q}${k === 'xmlns:if' ? 'urn:if' : v.replace(q, q === '"' ? '&quot;' : '&apos;')}${q}`).join('');
      // Every element declares the if prefix it may use.
      const decl = a.includes('xmlns:if') ? '' : ' xmlns:if="urn:if"';
      return children.length === 0 ? `<${n}${decl}${a}/>` : `<${n}${decl}${a}>${children.join('')}</${n}>`;
    }),
})).el;

const document = fc.tuple(fc.constantFrom('', '<?xml version="1.0"?>\n'), xmlTree, fc.constantFrom('', '\n', '<!-- end -->')).map((p) => p.join(''));

describe('property: the pre-scan never counts fewer nodes than the tree holds', () => {
  it('a document parses with maxNodes at its tree size or above, never below', () => {
    fc.assert(
      fc.property(document, (text) => {
        const el = parseXml(text, { maxNodes: Number.MAX_SAFE_INTEGER });
        const n = treeNodes(el);
        expect(() => parseXml(text, { maxNodes: n - 1 })).toThrow(/maxNodes/);
      }),
      { numRuns: 500 },
    );
  });

  it('a document parses with maxDepth at its depth, and is refused below it', () => {
    const depthOf = (el: XmlElement): number => 1 + Math.max(0, ...el.elements.map(depthOf));
    fc.assert(
      fc.property(document, (text) => {
        const depth = depthOf(parseXml(text, { maxNodes: Number.MAX_SAFE_INTEGER }));
        expect(parseXml(text, { maxDepth: depth, maxNodes: Number.MAX_SAFE_INTEGER })).toBeDefined();
        if (depth > 1) expect(() => parseXml(text, { maxDepth: depth - 1 })).toThrow(/maxDepth/);
      }),
      { numRuns: 300 },
    );
  });
});

/** Replace, insert or delete characters at random positions. */
function mutate(text: string, edits: { at: number; op: string; ch: string }[]): string {
  const out = [...text];
  for (const { at, op, ch } of edits) {
    const i = at % (out.length + 1);
    if (op === 'insert') out.splice(i, 0, ch);
    else if (op === 'delete') out.splice(i, 1);
    else if (i < out.length) out[i] = ch;
  }
  return out.join('');
}

const markupChar = fc.oneof(fc.constantFrom(...'<>/!?-[]"\'=&;: \nxa'), fc.string({ minLength: 1, maxLength: 1 }));

describe('property: hostile text only ever produces an XmlError', () => {
  const onlyXmlError = (text: string, limits: { maxNodes: number; maxDepth: number }): void => {
    try {
      parseXml(text, limits);
    } catch (err) {
      expect(err).toBeInstanceOf(XmlError);
    }
  };
  const limits = fc.record({ maxNodes: fc.integer({ min: 1, max: 40 }), maxDepth: fc.integer({ min: 1, max: 8 }) });

  it('arbitrary text', () => {
    fc.assert(
      fc.property(fc.array(markupChar, { maxLength: 200 }).map((cs) => cs.join('')), limits, onlyXmlError),
      { numRuns: 1000 },
    );
  });

  it('mutated well-formed documents', () => {
    const edit = fc.record({ at: fc.nat(), op: fc.constantFrom('set', 'insert', 'delete'), ch: markupChar });
    fc.assert(
      fc.property(document, fc.array(edit, { minLength: 1, maxLength: 5 }), limits, (text, edits, l) => onlyXmlError(mutate(text, edits), l)),
      { numRuns: 1000 },
    );
  });
});

describe('parse limits that are not numbers', () => {
  it('a NaN maxDepth or maxNodes refuses every document rather than switching the limit off', () => {
    expect(() => parseXml('<a/>', { maxDepth: Number.NaN })).toThrow(/maxDepth/);
    expect(() => parseXml('<a/>', { maxNodes: Number.NaN })).toThrow(/maxNodes/);
  });
});

describe('attribute names resolve without copying long namespace URIs', () => {
  it('many prefixed attributes sharing a 1 MB namespace URI parse in linear time', () => {
    const attrs = Array.from({ length: 2000 }, (_, i) => ` p:a${i}=""`).join('');
    const text = `<a xmlns:p="${'u'.repeat(1_000_000)}"${attrs}/>`;
    const start = performance.now();
    expect(parseXml(text).attributes).toHaveLength(2000);
    expect(performance.now() - start).toBeLessThan(1000); // quadratic took seconds at 200
    expect(() => parseXml(`<a xmlns:p="urn:x" xmlns:q="urn:x" p:y="1" q:y="2"/>`)).toThrow(/Duplicate/);
  });
});
