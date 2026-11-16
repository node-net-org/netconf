import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { CapabilitySet } from '../../src/messages/capabilities.js';
import { buildClientHello, negotiateBaseVersion, parseServerHello } from '../../src/messages/hello.js';
import { BASE_1_0, BASE_1_1, HelloError, NETCONF_NS, parseXml, serializeXml } from '../../src/index.js';

const hello = (body: string): string => `<hello xmlns="${NETCONF_NS}">${body}</hello>`;
const caps = (...uris: string[]): string =>
  `<capabilities>${uris.map((u) => `<capability>${u}</capability>`).join('')}</capabilities>`;

describe('CapabilitySet', () => {
  const set = new CapabilitySet([
    BASE_1_0,
    BASE_1_1,
    'urn:ietf:params:netconf:capability:candidate:1.0',
    'urn:ietf:params:netconf:capability:confirmed-commit:1.1',
    'urn:ietf:params:netconf:capability:with-defaults:1.0?basic-mode=explicit&also-supported=report-all,trim',
    'urn:ietf:params:xml:ns:yang:ietf-interfaces?module=ietf-interfaces&revision=2018-02-20&features=arbitrary-names,pre-provisioning',
    '  http://example.com/vendor/1.0  ',
  ]);

  it('matches full URIs, ignoring query parameters', () => {
    expect(set.has('urn:ietf:params:netconf:capability:candidate:1.0')).toBe(true);
    expect(set.has('urn:ietf:params:netconf:capability:with-defaults:1.0')).toBe(true);
    expect(set.has('http://example.com/vendor/1.0')).toBe(true);
  });

  it('matches short names, with or without a version', () => {
    expect(set.has(':candidate')).toBe(true);
    expect(set.has(':confirmed-commit')).toBe(true);
    expect(set.has(':confirmed-commit:1.1')).toBe(true);
    expect(set.has(':confirmed-commit:1.0')).toBe(false);
    expect(set.has(':startup')).toBe(false);
    expect(set.has(':base:1.1')).toBe(true);
  });

  it('exposes query parameters', () => {
    expect(set.get(':with-defaults')!.params.get('basic-mode')).toBe('explicit');
    expect(set.get(':with-defaults')!.params.get('also-supported')).toBe('report-all,trim');
  });

  it('indexes advertised YANG modules', () => {
    expect(set.helloModule('ietf-interfaces')).toEqual({
      name: 'ietf-interfaces',
      namespace: 'urn:ietf:params:xml:ns:yang:ietf-interfaces',
      revision: '2018-02-20',
      features: ['arbitrary-names', 'pre-provisioning'],
      deviations: [],
    });
    expect(set.hasHelloModule('nokia-conf')).toBe(false);
  });

  it('lists base versions', () => {
    expect(set.baseVersions).toEqual(['1.0', '1.1']);
  });

  it('lists hello modules as an array', () => {
    expect(set.helloModules.map((m) => m.name)).toContain('ietf-interfaces');
  });

  it('cannot be modified through what it returns', () => {
    const mod = set.helloModules[0]!;
    const name = mod.name;
    // Casts stand in for plain JS; vitest runs as strict-mode ESM.
    expect(() => {
      (mod as { name: string }).name = 'other';
    }).toThrow(TypeError);
    expect(() => (mod.features as string[]).push('x')).toThrow(TypeError);
    expect(set.helloModule(name)!.name).toBe(name);

    const cap = set.get(':with-defaults')!;
    expect(() => {
      (cap as { id: string }).id = 'x';
    }).toThrow(TypeError);
    const params = cap.params as Map<string, string>;
    expect(() => params.set('basic-mode', 'trim')).toThrow(TypeError);
    expect(() => params.delete('basic-mode')).toThrow(TypeError);
    expect(() => params.clear()).toThrow(TypeError);
    expect(cap.params.get('basic-mode')).toBe('explicit');
  });

  it('prints and serialises as its advertised URIs, not its internal indexes', () => {
    expect(JSON.parse(JSON.stringify(set))).toEqual(set.toArray());
    const printed = inspect(set);
    expect(printed).toMatch(new RegExp(`^CapabilitySet\\(${set.size}\\) \\[`));
    expect(printed).toContain('urn:ietf:params:netconf:base:1.1');
    expect(printed).not.toMatch(/byId|ModulesByName/);
  });
});

describe('parseServerHello', () => {
  it('reads session-id and capabilities', () => {
    const h = parseServerHello(parseXml(hello(caps(BASE_1_0, BASE_1_1) + '<session-id>4</session-id>')));
    expect(h.sessionId).toBe(4);
    expect(h.capabilities.baseVersions).toEqual(['1.0', '1.1']);
  });

  it('returns a set even when only one capability is advertised (fork defect d)', () => {
    const h = parseServerHello(parseXml(hello(caps(BASE_1_0) + '<session-id>1</session-id>')));
    expect(h.capabilities).toBeInstanceOf(CapabilitySet);
    expect(h.capabilities.toArray()).toEqual([BASE_1_0]);
  });

  it.each([
    ['not a hello', `<rpc xmlns="${NETCONF_NS}"/>`],
    ['wrong namespace', `<hello xmlns="urn:other">${caps(BASE_1_0)}<session-id>1</session-id></hello>`],
    ['no capabilities', hello('<session-id>1</session-id>')],
    ['no base capability', hello(caps('urn:x') + '<session-id>1</session-id>')],
    ['no session-id', hello(caps(BASE_1_0))],
    ['session-id 0', hello(caps(BASE_1_0) + '<session-id>0</session-id>')],
    ['non-numeric session-id', hello(caps(BASE_1_0) + '<session-id>abc</session-id>')],
    ['session-id above uint32', hello(caps(BASE_1_0) + '<session-id>4294967296</session-id>')],
  ])('rejects a hello with %s', (_label, xml) => {
    expect(() => parseServerHello(parseXml(xml))).toThrow(HelloError);
  });
});

describe('client hello and negotiation', () => {
  it('advertises both base versions by default and no session-id', () => {
    expect(serializeXml(buildClientHello())).toBe(
      `<hello xmlns="${NETCONF_NS}"><capabilities><capability>${BASE_1_0}</capability>` +
        `<capability>${BASE_1_1}</capability></capabilities></hello>`,
    );
  });

  it('picks 1.1 when both support it, otherwise 1.0', () => {
    const both = new CapabilitySet([BASE_1_0, BASE_1_1]);
    expect(negotiateBaseVersion(both, both)).toBe('1.1');
    expect(negotiateBaseVersion(both, new CapabilitySet([BASE_1_0]))).toBe('1.0');
    expect(negotiateBaseVersion(new CapabilitySet([BASE_1_0]), both)).toBe('1.0');
  });

  it('fails when there is no common version', () => {
    expect(() => negotiateBaseVersion(new CapabilitySet([BASE_1_0]), new CapabilitySet([BASE_1_1]))).toThrow(
      HelloError,
    );
  });
});
