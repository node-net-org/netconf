/**
 * XML-03: namespace declarations cost memory
 * once each. An element's in-scope namespaces link to its parent's instead of
 * copying them, so K declarations on a root with K declaring children no
 * longer cost K² map entries, and every element's `inScope` is still what a
 * full copy would have held, in the same order.
 */
import fc from 'fast-check';
import { inspect } from 'node:util';
import { GCProfiler, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FrozenMap } from '../../src/frozen-map.js';
import { namespacesIn, namespacesOfChildren } from '../../src/yang/convert.js';
import { parseXml, serializeXml, XmlElement, type XmlAttribute } from '../../src/xml/index.js';
import { NamespaceScope } from '../../src/xml/scope.js';
import { referenceSerializeXml } from './reference-serialize.js';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const MB = 1024 * 1024;
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** A root declaring `k` prefixes, then `k` children that each declare one more. */
function squareDocument(k: number): string {
  let text = '<data xmlns="urn:example:ns"';
  for (let i = 0; i < k; i++) text += ` xmlns:p${i}="urn:example:p${i}"`;
  text += '>';
  for (let i = 0; i < k; i++) text += `<c xmlns:q${i}="urn:example:q${i}"/>`;
  return `${text}</data>`;
}

/** Peak heap above the starting point while `work` runs, and heap still held after it with its result alive. */
function heap<T>(work: () => T): { result: T; peakMB: number; heldMB: number } {
  gc();
  const before = process.memoryUsage().heapUsed;
  const profiler = new GCProfiler();
  profiler.start();
  const result = work();
  const end = process.memoryUsage().heapUsed;
  const gcs = profiler.stop().statistics;
  const peak = Math.max(end, ...gcs.map((g) => g.beforeGC.heapStatistics.usedHeapSize));
  gc();
  return { result, peakMB: (peak - before) / MB, heldMB: (process.memoryUsage().heapUsed - before) / MB };
}

function* preorder(el: XmlElement): Generator<XmlElement> {
  yield el;
  for (const c of el.elements) yield* preorder(c);
}

describe('XML-03: namespace declarations cost memory once each', () => {
  // Before the fix, K=4000 (199 KB of text) peaked at 490 MB and held 439 MB
  // after parsing; serialising the tree peaked at another 505 MB.
  const K = 4000;
  const text = squareDocument(K);

  it('parsing K root declarations with K declaring children stays linear', () => {
    const { result, peakMB, heldMB } = heap(() => parseXml(text));
    expect(result.elements).toHaveLength(K);
    expect(heldMB).toBeLessThan(32);
    expect(peakMB).toBeLessThan(64);
    const last = result.elements[K - 1]!;
    expect(last.lookupNamespace(`q${K - 1}`)).toBe(`urn:example:q${K - 1}`);
    expect(last.lookupNamespace('p0')).toBe('urn:example:p0');
    expect(last.lookupNamespace('q0')).toBeUndefined();
  });

  it('serialising and collecting namespaces from that tree stay linear too', () => {
    const doc = parseXml(text);
    const written = heap(() => serializeXml(doc));
    expect(written.peakMB).toBeLessThan(64);
    expect(parseXml(written.result).elements).toHaveLength(K);
    const found = heap(() => namespacesIn(doc));
    expect(found.peakMB).toBeLessThan(64);
    expect(found.result.size).toBe(2 * K + 1);
  });

  it("collecting the children's namespaces together stays linear", () => {
    const doc = parseXml(text);
    const { result, peakMB, heldMB } = heap(() => namespacesOfChildren(doc.inScope, doc.elements));
    expect(result.size).toBe(2 * K + 1); // p*, q* and the element namespace
    expect(peakMB).toBeLessThan(64);
    expect(heldMB).toBeLessThan(8);
  });

  it('a namespace every child hides by rebinding its prefix is not counted', () => {
    const doc = parseXml('<data xmlns:p="urn:A" xmlns:r="urn:R"><c xmlns="urn:m" xmlns:p="urn:B"/><d xmlns="urn:m" xmlns:p="urn:C"/></data>');
    const union = (els: readonly XmlElement[]): Set<string> => new Set(els.flatMap((el) => [...namespacesIn(el)]));
    expect(namespacesOfChildren(doc.inScope, doc.elements)).toEqual(union(doc.elements));
    expect(namespacesOfChildren(doc.inScope, doc.elements).has('urn:A')).toBe(false);
    expect(namespacesOfChildren(doc.inScope, doc.elements.slice(0, 1))).toEqual(new Set(['urn:m', 'urn:B', 'urn:R']));
    const one = parseXml('<data xmlns:p="urn:A"><c xmlns:p="urn:B"/><e/></data>');
    expect(namespacesOfChildren(one.inScope, one.elements)).toEqual(new Set(['urn:A', 'urn:B']));
  });

  it("reading a child's whole scope (serialising or inspecting it on its own) keeps no copy of it", () => {
    // A child written on its own declares every prefix in scope, so its text
    // is as long as the scope; what must not happen is the scope staying
    // copied onto each child afterwards (446 MB held for all 4000).
    const doc = parseXml(text);
    const { result, heldMB } = heap(() => {
      let total = 0;
      for (const el of doc.elements.slice(0, 400)) total += el.toString().length + inspect(el).length + namespacesIn(el).size;
      return total;
    });
    expect(result).toBeGreaterThan(400 * K);
    expect(heldMB).toBeLessThan(8);
  });

  it('declarations count toward maxNodes as attributes', () => {
    // 11 elements, 11 declarations on the root (xmlns and p0-p9), one on each child

    expect(() => parseXml(squareDocument(10), { maxNodes: 32 })).not.toThrow();
    expect(() => parseXml(squareDocument(10), { maxNodes: 31 })).toThrow(/maxNodes/);
  });
});

describe('NamespaceScope is still a frozen Map', () => {
  const doc = parseXml('<a xmlns="u:d" xmlns:p="u:p"><b xmlns:q="u:q" xmlns:p="u:p2"><c/></b></a>');
  const scopeOf = (): ReadonlyMap<string, string> => parseXml('<a xmlns="u:d" xmlns:p="u:p"><b xmlns:q="u:q" xmlns:p="u:p2"/></a>').child('b')!.inScope;

  it('is a Map and a FrozenMap, frozen, and refuses writes', () => {
    const scope = doc.child('b')!.inScope as Map<string, string>;
    expect(scope).toBeInstanceOf(Map);
    expect(scope).toBeInstanceOf(FrozenMap);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(() => scope.set('x', 'u:x')).toThrow(/read-only/);
    expect(() => scope.delete('p')).toThrow(/read-only/);
    expect(() => scope.clear()).toThrow(/read-only/);
    expect(scope.get('p')).toBe('u:p2');
  });

  it('size, iteration and inspect give the flat map, in the old order', () => {
    const flat = new FrozenMap([
      ['', 'u:d'],
      ['xml', XML_NS],
      ['p', 'u:p2'],
      ['q', 'u:q'],
    ]);
    expect(scopeOf().size).toBe(4);
    expect([...scopeOf()]).toEqual([...flat]);
    expect([...scopeOf().keys()]).toEqual([...flat.keys()]);
    expect([...scopeOf().values()]).toEqual([...flat.values()]);
    expect([...scopeOf().entries()]).toEqual([...flat.entries()]);
    const seen: [string, string][] = [];
    scopeOf().forEach((uri, prefix, map) => {
      seen.push([prefix, uri]);
      expect(map).toBeInstanceOf(Map);
    });
    expect(seen).toEqual([...flat]);
    expect(inspect(scopeOf())).toBe(inspect(flat));
    expect(scopeOf().has('q')).toBe(true);
    expect(scopeOf().has('nope')).toBe(false);
  });

  it('once flattened, it is an ordinary Map underneath (Map.prototype, structuredClone)', () => {
    const scope = scopeOf();
    void scope.size;
    expect(Map.prototype.get.call(scope, 'q')).toBe('u:q');
    expect([...(structuredClone(scope) as Map<string, string>)]).toEqual([...scope]);
  });

  it('a child chained to a flattened parent reads through it', () => {
    const b = doc.child('b')!;
    const c = b.child('c')!;
    expect(c.inScope).toBe(b.inScope); // declares nothing: shared
    const deeper = parseXml('<a xmlns:p="u:p"><b xmlns:q="u:q"><c xmlns:r="u:r"/></b></a>');
    const bb = deeper.child('b')!;
    void bb.inScope.size; // flatten the middle link
    const cc = bb.child('c')!;
    expect(cc.lookupNamespace('p')).toBe('u:p');
    expect(cc.lookupNamespace('r')).toBe('u:r');
    expect([...cc.inScope.keys()]).toEqual(['', 'xml', 'p', 'q', 'r']);
  });

  it('added() gives what a scope adds to the one it was declared in, else undefined', () => {
    const b = doc.child('b')!;
    expect([...NamespaceScope.added(b.inScope, doc.inScope)!]).toEqual([
      ['p', 'u:p2'],
      ['q', 'u:q'],
    ]);
    expect(NamespaceScope.added(b.inScope, b.inScope)!.size).toBe(0);
    expect(NamespaceScope.added(doc.inScope, b.inScope)).toBeUndefined();
    expect(NamespaceScope.added(new Map(), doc.inScope)).toBeUndefined();
    expect(NamespaceScope.added(b.inScope, undefined)).toBeUndefined();
  });

  it('a redeclared prefix keeps its place, ahead of new ones declared before it', () => {
    const el = parseXml('<a xmlns:x="u:x" xmlns:y="u:y"><b xmlns:n="u:n" xmlns:y="u:y2" xmlns:x="u:x2"/></a>').child('b')!;
    expect([...el.declarations.keys()]).toEqual(['n', 'y', 'x']); // document order
    expect([...el.inScope]).toEqual([
      ['', ''],
      ['xml', XML_NS],
      ['x', 'u:x2'],
      ['y', 'u:y2'],
      ['n', 'u:n'],
    ]);
  });

  it('the defaultNamespace option is the start of the chain', () => {
    const el = parseXml('<a xmlns:p="u:p"><b/></a>', { defaultNamespace: 'u:nc' });
    expect(el.ns).toBe('u:nc');
    expect([...el.child('b')!.inScope]).toEqual([
      ['', 'u:nc'],
      ['xml', XML_NS],
      ['p', 'u:p'],
    ]);
  });
});

// --- the property: same scopes as a flat copy per element, same serialisation -------------------

interface Node {
  readonly decls: readonly (readonly [string, string])[];
  readonly name: number;
  readonly attr: number | null;
  readonly children: readonly Node[];
}

const PREFIXES = ['', 'a', 'b', 'c', 'd', 'e'];
const URIS = ['u:1', 'u:2', 'u:3', 'u:4', ''];

const tree: fc.Arbitrary<Node> = fc.letrec<{ node: Node }>((tie) => ({
  node: fc.record({
    decls: fc.array(fc.tuple(fc.constantFrom(...PREFIXES), fc.constantFrom(...URIS)), { maxLength: 4 }),
    name: fc.nat(),
    attr: fc.option(fc.nat()),
    children: fc.oneof({ depthSize: 'small' }, fc.constant([]), fc.array(tie('node'), { maxLength: 3 })),
  }),
})).node;

/** The document's text, and each element's in-scope map computed naively (a copy per element), in document order. */
function build(root: Node): { text: string; scopes: Map<string, string>[] } {
  const scopes: Map<string, string>[] = [];
  const write = (node: Node, parent: Map<string, string>): string => {
    const own = new Map<string, string>();
    for (const [prefix, uri] of node.decls) {
      if (own.has(prefix)) continue;
      own.set(prefix, prefix !== '' && uri === '' ? 'u:5' : uri);
    }
    const scope = new Map(parent);
    for (const [prefix, uri] of own) scope.set(prefix, uri);
    scopes.push(scope);
    const bound = [...scope.keys()].filter((p) => p !== '' && p !== 'xml');
    const prefix = bound.length === 0 ? undefined : bound[node.name % (bound.length + 1)];
    const name = prefix === undefined ? 'e' : `${prefix}:e`;
    let tag = name;
    for (const [p, uri] of own) tag += p === '' ? ` xmlns="${uri}"` : ` xmlns:${p}="${uri}"`;
    if (node.attr !== null && bound.length > 0) tag += ` ${bound[node.attr % bound.length]}:at="v"`;
    if (node.children.length === 0) return `<${tag}/>`;
    return `<${tag}>${node.children.map((c) => write(c, scope)).join('')}</${name}>`;
  };
  const text = write(
    root,
    new Map([
      ['', ''],
      ['xml', XML_NS],
    ]),
  );
  return { text, scopes };
}

describe('XML-03: inScope equals a flat copy per element (property)', () => {
  it('every element\'s inScope, size, get and lookupNamespace match the naive computation, however they are first read', () => {
    fc.assert(
      fc.property(tree, (root) => {
        const { text, scopes } = build(root);
        const elements = [...preorder(parseXml(text))];
        expect(elements).toHaveLength(scopes.length);
        const lookups = (): void => {
          elements.forEach((el, i) => {
            for (const p of [...PREFIXES, 'xml', 'zz']) {
              expect(el.inScope.get(p)).toBe(scopes[i]!.get(p));
              expect(el.inScope.has(p)).toBe(scopes[i]!.has(p));
              expect(el.lookupNamespace(p)).toBe(p === 'xml' ? XML_NS : scopes[i]!.get(p));
            }
          });
        };
        lookups(); // nothing flattened yet: chain walks
        elements.forEach((el, i) => {
          if (i % 2 === 1) expect([...el.inScope]).toEqual([...scopes[i]!]);
        });
        lookups(); // some links flattened
        elements.forEach((el, i) => {
          expect(el.inScope.size).toBe(scopes[i]!.size);
          expect([...el.inScope]).toEqual([...scopes[i]!]);
        });
      }),
      { numRuns: 1000 },
    );
  });

  it('serialisation and namespacesIn match the old full-copy versions, for parsed and hand-built trees', () => {
    fc.assert(
      fc.property(tree, fc.nat(), fc.constantFrom(...PREFIXES.slice(1)), fc.constantFrom(...URIS.slice(0, 4)), (root, pick, rebind, uri) => {
        const { text } = build(root);
        // Fresh parses for each side, so neither sees scopes the other flattened.
        const ours = parseXml(text);
        const theirs = parseXml(text);
        expect(serializeXml(ours)).toBe(referenceSerializeXml(theirs));
        expect(serializeXml(ours, { indent: 2 })).toBe(referenceSerializeXml(theirs, { indent: 2 }));
        const a = [...preorder(ours)];
        const b = [...preorder(theirs)];
        const i = pick % a.length;
        expect(serializeXml(a[i]!)).toBe(referenceSerializeXml(b[i]!));

        // A hand-built parent around a parsed element, which may bind one of
        // the parent scope's prefixes differently (its own prefix, or an
        // attribute's), so the child can't rely on the parent's bindings.
        const wrap = (el: XmlElement): XmlElement => {
          const attributes: XmlAttribute[] = [{ name: 'at', ns: uri, prefix: rebind, value: 'v' }];
          return new XmlElement({ name: 'w', ns: uri, prefix: pick % 2 === 0 ? rebind : undefined, inScope: el.inScope, declarations: el.declarations, attributes, children: el.children });
        };
        expect(serializeXml(wrap(a[i]!))).toBe(referenceSerializeXml(wrap(b[i]!)));

        const naive = new Set<string>();
        for (const el of preorder(parseXml(text))) {
          if (el.ns !== undefined && el.ns !== '') naive.add(el.ns);
          for (const [p, u] of new Map(el.inScope)) if (p !== '' && p !== 'xml' && u !== '') naive.add(u);
          for (const at of el.attributes) if (at.ns !== undefined) naive.add(at.ns);
        }
        expect(namespacesIn(parseXml(text))).toEqual(naive);
        const parsed = parseXml(text);
        const union = new Set(parseXml(text).elements.flatMap((el) => [...namespacesIn(el)]));
        expect(namespacesOfChildren(parsed.inScope, parsed.elements)).toEqual(union);
      }),
      { numRuns: 1000 },
    );
  });
});
