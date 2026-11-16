/**
 * identityrefs and instance-identifiers decoded the
 * RFC 7951 way, with module names in place of the server's prefixes,
 * resolving prefixes declared anywhere above the value.
 */
import { describe, expect, it } from 'vitest';
import { parseXml, x } from '../../src/index.js';
import { moduleName, qualifiedIdentity, qualifiedPath, WELL_KNOWN_MODULES } from '../../src/operations/index.js';

const NCM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring';

/** The first <v> in a document whose root declares `decls`. */
const value = (decls: string, inner = ''): ReturnType<typeof parseXml> =>
  parseXml(`<r ${decls}><mid${inner}><v/></mid></r>`).child('mid')!.child('v')!;

describe('qualifiedIdentity', () => {
  it('writes the module name in place of the prefix, wherever the prefix was declared', () => {
    const el = value(`xmlns:ncm="${NCM}"`);
    expect(qualifiedIdentity('ncm:netconf-ssh', el)).toBe('ietf-netconf-monitoring:netconf-ssh');
    expect(qualifiedIdentity('  ncm:netconf-ssh\n', el)).toBe('ietf-netconf-monitoring:netconf-ssh');
  });

  it('keeps two identities with the same name in different modules apart', () => {
    const el = value(`xmlns:ncm="${NCM}" xmlns:acme="urn:acme:transport"`);
    const moduleOf = (ns: string): string | undefined => (ns === 'urn:acme:transport' ? 'acme-transport' : undefined);
    const standard = qualifiedIdentity('ncm:netconf-ssh', el, moduleOf);
    const vendor = qualifiedIdentity('acme:netconf-ssh', el, moduleOf);
    expect(standard).toBe('ietf-netconf-monitoring:netconf-ssh');
    expect(vendor).toBe('acme-transport:netconf-ssh');
    expect(standard).not.toBe(vendor);
  });

  it('means the same whatever prefix the server chose', () => {
    expect(qualifiedIdentity('a:netconf-ssh', value(`xmlns:a="${NCM}"`))).toBe(qualifiedIdentity('zz9:netconf-ssh', value(`xmlns:zz9="${NCM}"`)));
  });

  it('prefers the session\'s module for a namespace, then a well-known one, then the namespace itself', () => {
    const el = value(`xmlns:x="urn:x" xmlns:ncm="${NCM}"`);
    expect(qualifiedIdentity('x:thing', el, () => 'ex-module')).toBe('ex-module:thing');
    expect(qualifiedIdentity('ncm:yang', el)).toBe('ietf-netconf-monitoring:yang');
    expect(qualifiedIdentity('x:thing', el)).toBe('urn:x:thing');
    expect(WELL_KNOWN_MODULES[NCM]).toBe('ietf-netconf-monitoring');
    expect(moduleName('urn:x')).toBe('urn:x');
  });

  it('takes an unprefixed value from the default namespace in effect (RFC 7950 §9.10.3)', () => {
    expect(qualifiedIdentity('netconf-ssh', value(`xmlns="${NCM}"`))).toBe('ietf-netconf-monitoring:netconf-ssh');
  });

  it('is undefined for an undeclared prefix or an empty name', () => {
    const el = value(`xmlns:ncm="${NCM}"`);
    expect(qualifiedIdentity('nope:netconf-ssh', el)).toBeUndefined();
    expect(qualifiedIdentity('ncm:', el)).toBeUndefined();
    expect(qualifiedIdentity('netconf-ssh', x('v'))).toBeUndefined();
  });

  it('keeps a malformed name as the server sent it, so it is reported rather than replaced', () => {
    expect(qualifiedIdentity('ncm:not a name', value(`xmlns:ncm="${NCM}"`))).toBe('ietf-netconf-monitoring:not a name');
  });
});

describe('qualifiedPath', () => {
  const el = value('xmlns:a="urn:a" xmlns:b="urn:b"');
  const moduleOf = (ns: string): string | undefined => ({ 'urn:a': 'mod-a', 'urn:b': 'mod-b' })[ns];

  it('writes module names on the first node and where the module changes, keys unprefixed', () => {
    expect(qualifiedPath(`/a:x/a:y[ a:k1 = "v]1" ][a:k2='/x"y']/b:z`, el, moduleOf)).toBe(`/mod-a:x/y[k1='v]1'][k2='/x"y']/mod-b:z`);
  });

  it('keeps a leaf-list value and a position, and quotes a value holding a single quote with double quotes', () => {
    expect(qualifiedPath("/a:x/a:ll[.='v 1']", el, moduleOf)).toBe("/mod-a:x/ll[.='v 1']");
    expect(qualifiedPath('/a:x/a:ll[ 3 ]', el, moduleOf)).toBe('/mod-a:x/ll[3]');
    expect(qualifiedPath(`/a:x[a:k="it's"]`, el, moduleOf)).toBe(`/mod-a:x[k="it's"]`);
    expect(qualifiedPath("/a:x[a:k='']", el, moduleOf)).toBe("/mod-a:x[k='']");
  });

  it('resolves prefixes declared on the value\'s own element or any ancestor', () => {
    expect(qualifiedPath('/a:x/c:y', value('xmlns:a="urn:a"', ' xmlns:c="urn:c"'), moduleOf)).toBe('/mod-a:x/urn:c:y');
  });

  it.each([
    ['', /empty path/],
    ['/', /expected an identifier/],
    ['/x', /expected a prefixed node name/],
    ['/c:x', /undeclared prefix "c"/],
    ['/a:x/', /expected an identifier/],
    ['/a:x[a:k=v]', /expected a quoted string/],
    ["/a:x[a:k='v", /unterminated string/],
    ["/a:x[a:k='v'", /expected "\]"/],
    ['/a:x[0]', /positive integer/],
    ["/a:x[a:k='1'][a:k='2']", /duplicate key "k"/],
    ["/a:x[a:k='1'][2]", /position can't follow/],
    ["/a:x[2][a:k='1']", /unexpected predicate/],
    ["/a:x[.='a'][.='b']", /unexpected predicate/],
    ['/a:x y', /expected "\/"/],
  ])('rejects %j', (path, message) => {
    expect(() => qualifiedPath(path, el)).toThrow(TypeError);
    expect(() => qualifiedPath(path, el)).toThrow(message);
  });
});
