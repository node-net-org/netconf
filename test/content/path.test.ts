import { describe, expect, it } from 'vitest';
import { buildEdit, buildFilter, filterDepth, resolvePath, selectPath } from '../../src/content/path.js';
import { NETCONF_NS, parsePath, parseXml, PathError, serializeXml, x } from '../../src/index.js';

const NS: Record<string, string> = {
  'ietf-interfaces': 'urn:if',
  'ietf-ip': 'urn:ip',
  'nokia-conf': 'urn:nokia:conf',
};
const resolve = (p: string) => resolvePath(p, (m) => NS[m]);
const xml = (els: readonly ReturnType<typeof x>[]) => els.map((e) => serializeXml(e)).join('');

describe('parsePath', () => {
  it('parses modules, inherited modules, keys and leaf-list values', () => {
    expect(parsePath(`/ietf-interfaces:interfaces/interface[name="eth0"][ unit = '0' ]/ietf-ip:ipv4/addr[.="10.0.0.1"]`)).toEqual([
      { module: 'ietf-interfaces', name: 'interfaces', keys: [], value: undefined },
      { module: undefined, name: 'interface', keys: [{ name: 'name', value: 'eth0' }, { name: 'unit', value: '0' }], value: undefined },
      { module: 'ietf-ip', name: 'ipv4', keys: [], value: undefined },
      { module: undefined, name: 'addr', keys: [], value: '10.0.0.1' },
    ]);
  });

  it('keeps slashes and quotes inside quoted key values', () => {
    expect(parsePath(`/nokia-conf:configure/port[port-id="1/1/1"]`)[1]!.keys[0]!.value).toBe('1/1/1');
    expect(parsePath(`/m:a/b[k='say "hi"']`)[1]!.keys[0]!.value).toBe('say "hi"');
  });

  it('reads a value holding both quotes written as concat(), as @node-net/yang writes it in data paths', () => {
    const steps = parsePath(`/m:a/b[k=concat('it', "'", 's "x"')]/c[.=concat( '"', "'" )]`);
    expect(steps[1]!.keys[0]!.value).toBe(`it's "x"`);
    expect(steps[2]!.value).toBe(`"'`);
    // A subtree filter carries it as plain text; an XPath filter can't.
    expect(xml(buildFilter([resolvePath(`/ietf-interfaces:interfaces/interface[name=concat('a', "'", '"')]`, (m) => NS[m])]))).toContain(`<name>a'"</name>`);
  });

  it.each([
    ['', 'must start with /'],
    ['interfaces', 'must start with /'],
    ['/interfaces', 'first step must name its module'],
    ['/m:a/b[name=eth0]', 'quoted value'],
    ['/m:a/b[name="eth0"', "expected ']'"],
    ['/m:a/b[1]', 'positional'],
    ['/m:a/b[k="1"][k="2"]', 'given twice'],
    ['/m:a/b[k="1"][.="2"]', 'both key and value'],
    ['/m:a//b', 'expected a name'],
    ['/m:a/b[k="unterminated]', 'unterminated'],
    ["/m:a/b[k=concat('a' 'b')]", "expected ',' or ')'"],
    ["/m:a/b[k=concat('a', b)]", 'quoted value'],
  ])('rejects %j', (path, message) => {
    expect(() => parsePath(path)).toThrow(PathError);
    expect(() => parsePath(path)).toThrow(message);
  });

  it('reports unknown modules clearly', () => {
    expect(() => resolve('/acme-system:system')).toThrow(/Unknown YANG module "acme-system"/);
  });
});

describe('buildFilter', () => {
  it('builds a subtree filter with keys as content-match nodes', () => {
    const f = buildFilter([resolve('/ietf-interfaces:interfaces/interface[name="eth0"]/description')]);
    expect(xml(f)).toBe('<interfaces xmlns="urn:if"><interface><name>eth0</name><description/></interface></interfaces>');
  });

  it('merges several paths into one tree, switching namespace where the module changes', () => {
    const f = buildFilter([
      resolve('/ietf-interfaces:interfaces/interface[name="eth0"]/description'),
      resolve('/ietf-interfaces:interfaces/interface[name="eth0"]/ietf-ip:ipv4'),
      resolve('/ietf-interfaces:interfaces/interface[name="eth1"]'),
    ]);
    expect(xml(f)).toBe(
      '<interfaces xmlns="urn:if"><interface><name>eth0</name><description/><ipv4 xmlns="urn:ip"/></interface>' +
        '<interface><name>eth1</name></interface></interfaces>',
    );
  });

  it('escapes key values', () => {
    const f = buildFilter([resolve(`/ietf-interfaces:interfaces/interface[name="a<b&c"]`)]);
    expect(xml(f)).toContain('<name>a&lt;b&amp;c</name>');
  });
});

describe('filterDepth (subtreeFilter: containers)', () => {
  const cut = (path: string, depth: number): string => xml(buildFilter([filterDepth(resolve(path), depth)]));

  it('keeps the first depth steps of an unkeyed path', () => {
    expect(cut('/nokia-conf:configure/system/name/system-name', 2)).toBe('<configure xmlns="urn:nokia:conf"><system/></configure>');
    expect(cut('/nokia-conf:configure/system/name/system-name', 1)).toBe('<configure xmlns="urn:nokia:conf"/>');
  });

  it('continues through keyed steps right after the depth, then stops at the first unkeyed one', () => {
    const port = '<configure xmlns="urn:nokia:conf"><port><port-id>1/1/1</port-id></port></configure>';
    expect(cut('/nokia-conf:configure/port[port-id="1/1/1"]/ethernet/mtu', 1)).toBe(port);
    expect(cut('/nokia-conf:configure/port[port-id="1/1/1"]/ethernet/mtu', 2)).toBe(port);
    expect(cut('/nokia-conf:configure/router[router-name="Base"]/interface[interface-name="x"]/address', 2)).toBe(
      '<configure xmlns="urn:nokia:conf"><router><router-name>Base</router-name><interface><interface-name>x</interface-name></interface></router></configure>',
    );
  });

  it('a keyed step past an unkeyed one beyond the depth is not reached', () => {
    expect(cut('/nokia-conf:configure/service/vprn[service-name="a"]', 1)).toBe('<configure xmlns="urn:nokia:conf"/>');
    expect(cut('/nokia-conf:configure/service/vprn[service-name="a"]/interface', 2)).toBe(
      '<configure xmlns="urn:nokia:conf"><service><vprn><service-name>a</service-name></vprn></service></configure>',
    );
  });

  it('never goes past the path, and treats a depth below 1 as 1', () => {
    expect(cut('/nokia-conf:configure/system', 5)).toBe('<configure xmlns="urn:nokia:conf"><system/></configure>');
    expect(cut('/nokia-conf:configure/system', 0)).toBe('<configure xmlns="urn:nokia:conf"/>');
  });
});

describe('buildEdit', () => {
  it('merges values, puts keys first, and marks deletes with nc:operation', () => {
    const config = buildEdit([
      { path: resolve('/ietf-interfaces:interfaces/interface[name="eth0"]/description'), operation: 'merge', value: 'uplink' },
      { path: resolve('/ietf-interfaces:interfaces/interface[name="eth0"]/mtu'), operation: 'merge', value: 9000 },
      { path: resolve('/ietf-interfaces:interfaces/interface[name="eth9"]'), operation: 'remove' },
    ]);
    expect(xml(config)).toBe(
      '<interfaces xmlns="urn:if"><interface><name>eth0</name><description>uplink</description><mtu>9000</mtu></interface>' +
        `<interface xmlns:nc="${NETCONF_NS}" nc:operation="remove"><name>eth9</name></interface></interfaces>`,
    );
  });

  it('accepts element content and empty values', () => {
    const config = buildEdit([
      { path: resolve('/ietf-interfaces:interfaces/interface[name="eth0"]'), operation: 'replace', value: x('enabled', 'true') },
      { path: resolve('/nokia-conf:configure/flag'), operation: 'merge', value: null },
    ]);
    expect(xml(config)).toBe(
      `<interfaces xmlns="urn:if"><interface xmlns:nc="${NETCONF_NS}" nc:operation="replace"><name>eth0</name><enabled>true</enabled></interface></interfaces>` +
        '<configure xmlns="urn:nokia:conf"><flag/></configure>',
    );
  });

  it('rejects conflicting or malformed edits', () => {
    const p = resolve('/ietf-interfaces:interfaces/interface[name="eth0"]/description');
    expect(() => buildEdit([{ path: p, operation: 'merge', value: 'a' }, { path: p, operation: 'merge', value: 'b' }])).toThrow(/same node/);
    expect(() => buildEdit([{ path: p, operation: 'delete', value: 'a' }])).toThrow(/takes no value/);
    expect(() => buildEdit([{ path: p, operation: 'merge' }])).toThrow(/needs a value/);
  });
});

describe('selectPath', () => {
  const data = parseXml(
    '<data xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><interfaces xmlns="urn:if">' +
      '<interface><name>eth0</name><description>up</description></interface>' +
      '<interface><name>eth1</name><description>down</description></interface>' +
      '</interfaces><other xmlns="urn:x"/></data>',
  );

  it('selects by key, honouring namespaces', () => {
    expect(selectPath(data, resolve('/ietf-interfaces:interfaces/interface[name="eth1"]/description')).map((e) => e.text())).toEqual(['down']);
    expect(selectPath(data, resolve('/ietf-interfaces:interfaces/interface/name')).map((e) => e.text())).toEqual(['eth0', 'eth1']);
    expect(selectPath(data, resolve('/ietf-interfaces:interfaces/interface[name="eth7"]'))).toEqual([]);
  });
});
