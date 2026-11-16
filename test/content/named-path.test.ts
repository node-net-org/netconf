import { afterEach, describe, expect, it } from 'vitest';
import { compileNamedPath, expandNamedPath, parseNamedPathCall } from '../../src/content/named-path.js';
import { compileProfile } from '../../src/devices/profile-spec.js';
import { BASE_1_0, BASE_1_1, connect, defineDeviceProfile, namedPath, PathError, serializeXml, type NetconfClient } from '../../src/index.js';
import { FakeServer } from '../../src/testing/index.js';

const IF = '/ietf-interfaces:interfaces/interface';
const expand = (template: string, call: string, missing: 'drop' | 'error' = 'drop'): string =>
  expandNamedPath(compileNamedPath(template), parseNamedPathCall(call), missing);

describe('compileNamedPath', () => {
  it('lists parameters in the order they first appear, and which a read may leave out', () => {
    const t = compileNamedPath('/m:a/b[x={{one}}][y="{{two}}"]/c[z="pre-{{three}}"]/{{four}}/d[k={{one}}]');
    expect(t.params).toEqual(['one', 'two', 'three', 'four']);
    expect([...t.optional]).toEqual(['one', 'two']);
  });

  it('takes a path without placeholders, and spaces inside the braces', () => {
    expect(compileNamedPath('/m:a/b').params).toEqual([]);
    expect(compileNamedPath('/m:a/b[k={{ p }}]').params).toEqual(['p']);
  });

  it('counts a leaf-list value predicate as a whole value', () => {
    expect([...compileNamedPath('/m:a/servers[.={{server}}]').optional]).toEqual(['server']);
  });

  it('counts a quoted value with anything besides the placeholder as part of a value', () => {
    expect([...compileNamedPath('/m:a/b[k=" {{p}}"]').optional]).toEqual([]);
  });

  it('refuses a malformed placeholder, an unquoted partial value, or a path that is invalid', () => {
    expect(() => compileNamedPath('/m:a/b[k={{p]')).toThrow(/unterminated \{\{/);
    expect(() => compileNamedPath('/m:a/b[k={{9p}}]')).toThrow(/valid parameter name/);
    expect(() => compileNamedPath('/m:a/b[k=x{{p}}]')).toThrow(/whole value, or inside quotes/);
    expect(() => compileNamedPath('/m:a/b[k={{p}}')).toThrow(/expected '\]'/);
    expect(() => compileNamedPath('m:a/b[k={{p}}]')).toThrow(PathError);
  });
});

describe('parseNamedPathCall', () => {
  it('parses a bare name, positional and named values, and quoted values', () => {
    expect(parseNamedPathCall('@sys')).toEqual({ name: 'sys', positional: [], named: new Map(), suffix: '' });
    expect(parseNamedPathCall('@r()')).toEqual({ name: 'r', positional: [], named: new Map(), suffix: '' });
    expect(parseNamedPathCall('@r(0.0.0.0/0, 192.0.2.254)').positional).toEqual(['0.0.0.0/0', '192.0.2.254']);
    const c = parseNamedPathCall(`@r(a, b = "x, y", c='say "hi"')`);
    expect(c.positional).toEqual(['a']);
    expect(Object.fromEntries(c.named)).toEqual({ b: 'x, y', c: 'say "hi"' });
  });

  it('refuses positional after named, repeats, stray quotes and an unclosed list', () => {
    expect(() => parseNamedPathCall('@r(a=1, 2)')).toThrow(/by position must come before/);
    expect(() => parseNamedPathCall('@r(a=1, a=2)')).toThrow(/a given twice/);
    expect(() => parseNamedPathCall('@r(a"b)')).toThrow(/quote a value/);
    expect(() => parseNamedPathCall('@r(a')).toThrow(/expected '\)'/);
    expect(() => parseNamedPathCall('@r(a,)')).toThrow(/expected a value/);
    expect(() => parseNamedPathCall('@(a)')).toThrow(/expected a name/);
  });

  it('takes more of the path after the reference', () => {
    expect(parseNamedPathCall('@interface(eth0)/description')).toEqual({ name: 'interface', positional: ['eth0'], named: new Map(), suffix: '/description' });
    expect(parseNamedPathCall('@interface/description').suffix).toBe('/description');
    expect(parseNamedPathCall('@interface()/ietf-ip:ipv4/address[ip="10.0.0.1"]').suffix).toBe('/ietf-ip:ipv4/address[ip="10.0.0.1"]');
    // a ) inside a quoted value doesn't end the arguments
    const c = parseNamedPathCall(`@r("a)/b")/c`);
    expect(c.positional).toEqual(['a)/b']);
    expect(c.suffix).toBe('/c');
  });

  it('refuses a suffix that is not a path', () => {
    expect(() => parseNamedPathCall('@r(a)b')).toThrow(/expected '\/' or the end after '\)'/);
    expect(() => parseNamedPathCall('@r(a)/')).toThrow(/Invalid path "\/".*expected a name/);
    expect(() => parseNamedPathCall('@r/b[')).toThrow(/Invalid path "\/b\["/);
    expect(() => parseNamedPathCall('@/b')).toThrow(/expected a name after @/);
  });
});

describe('expandNamedPath', () => {
  const T = `${IF}[name={{ifName}}]/description`;

  it('quotes a whole predicate value, by position or by name', () => {
    expect(expand(T, '@d(eth0)')).toBe(`${IF}[name="eth0"]/description`);
    expect(expand(T, '@d(ifName=eth0)')).toBe(`${IF}[name="eth0"]/description`);
    expect(expand(T, `@d('say "hi"')`)).toBe(`${IF}[name='say "hi"']/description`);
  });

  it('drops the predicate of a whole value left out, for a read', () => {
    expect(expand(T, '@d')).toBe(`${IF}/description`);
    expect(expand(`${IF}[name={{ifName}}]`, '@i/description')).toBe(`${IF}/description`);
    expect(expand('/m:r/route[prefix={{p}}][next-hop={{h}}]', '@r(10.0.0.0/8)')).toBe('/m:r/route[prefix="10.0.0.0/8"]');
    expect(expand('/m:a/b[k="{{p}}"]', '@x')).toBe('/m:a/b');
  });

  it('needs every parameter for a change', () => {
    expect(() => expand(T, '@d', 'error')).toThrow(/@d needs ifName: a change must name every list entry/);
    expect(expand(T, '@d(eth0)', 'error')).toBe(`${IF}[name="eth0"]/description`);
  });

  it('needs a parameter used outside a whole predicate value, even for a read', () => {
    expect(() => expand('/nokia-conf:configure/port[port-id="1/1/{{port}}"]', '@p')).toThrow(/@p needs port: each is used outside a whole predicate value/);
    expect(() => expand('/m:a/{{leaf}}', '@p')).toThrow(/needs leaf/);
    // Used both ways: the non-predicate use makes it required.
    expect(() => expand('/m:a/b[k={{p}}]/c[n="x{{p}}"]', '@p')).toThrow(/needs p/);
  });

  it('puts part of a quoted value in as it is, and a name only if it is a name', () => {
    expect(expand('/nokia-conf:configure/port[port-id="1/1/{{port}}"]', '@p(3)')).toBe('/nokia-conf:configure/port[port-id="1/1/3"]');
    expect(() => expand('/m:a/b[k="x{{p}}"]', '@p(a"b)')).toThrow(PathError);
    expect(() => expand('/m:a/b[k="x{{p}}"]', `@p('a"b')`)).toThrow(/can't hold "/);
    expect(expand('/m:a/{{leaf}}', '@p(mtu)')).toBe('/m:a/mtu');
    expect(() => expand('/m:a/{{leaf}}', '@p(x/y)')).toThrow(/must be letters, digits/);
  });

  it("can't inject path syntax through a value", () => {
    expect(expand(T, `@d('x"]/../y[a="b')`)).toBe(`${IF}[name='x"]/../y[a="b']/description`);
    expect(() => expand(T, `@d(ifName="a'b\\"")`)).toThrow(PathError);
  });

  it('refuses unknown parameters, too many values and a value given twice', () => {
    expect(() => expand(T, '@d(name=eth0)')).toThrow(/@d has no parameter name \(it takes ifName\)/);
    expect(() => expand(T, '@d(eth0, eth1)')).toThrow(/takes ifName, but 2 values were given/);
    expect(() => expand('/m:a', '@d(x)')).toThrow(/takes no parameters/);
    expect(() => expand(T, '@d(eth0, ifName=eth1)')).toThrow(/given both by position and by name/);
  });
});

describe('namedPath()', () => {
  it('writes a reference with quoted values', () => {
    expect(namedPath('sys')).toBe('@sys');
    expect(namedPath('@sys')).toBe('@sys');
    expect(namedPath('@d', { ifName: 'eth0' })).toBe('@d(ifName="eth0")');
    expect(namedPath('d', { ifName: 'eth0' })).toBe('@d(ifName="eth0")');
    expect(namedPath('e', { id: 7, note: 'say "hi"' })).toBe(`@e(id="7",note='say "hi"')`);
    expect(() => namedPath('e', { note: `'"` })).toThrow(PathError);
    const t = compileNamedPath(`${IF}[name={{ifName}}]/description`);
    expect(expandNamedPath(t, parseNamedPathCall(namedPath('d', { ifName: 'a,b)' })), 'drop')).toBe(`${IF}[name="a,b)"]/description`);
  });
});

describe('profile paths with parameters', () => {
  it('are checked when the profile loads', () => {
    expect(() => compileProfile({ id: 'p', paths: { bad: '/m:a/b[k=x{{p}}]' } })).toThrow(/paths\.bad.*whole value, or inside quotes/);
    expect(() => compileProfile({ id: 'p', paths: { ok: '/m:a/b[k={{p}}]' } })).not.toThrow();
    expect(() => compileProfile({ id: 'p', paths: { 'a(b)': '/m:a' } })).toThrow(/can't be empty, start with @ or hold \(, \) or \//);
    expect(() => compileProfile({ id: 'p', paths: { 'a/b': '/m:a' } })).toThrow(/can't be empty, start with @ or hold/);
    expect(() => compileProfile({ id: 'p', paths: { '@a': '/m:a' } })).toThrow(/start with @/);
  });
});

describe('client.content with named-path parameters', () => {
  let clients: NetconfClient[] = [];
  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()));
    clients = [];
  });

  const IF_NS = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
  const device = defineDeviceProfile({
    id: 'test',
    paths: {
      ifDescription: `${IF}[name={{ifName}}]/description`,
      interface: `${IF}[name={{ifName}}]`,
    },
  });

  async function open() {
    const fake = new FakeServer({
      capabilities: [BASE_1_0, BASE_1_1, 'urn:ietf:params:netconf:capability:writable-running:1.0', `${IF_NS}?module=ietf-interfaces&revision=2018-02-20`],
      handler: () => ({ data: [] }),
    });
    const client = await connect({ transport: fake.transport(), profile: device });
    clients.push(client);
    return { fake, client };
  }

  it('expands for reads, filters and XPath, dropping a whole predicate left out', async () => {
    const { client } = await open();
    expect(client.content.expandPath('@ifDescription(eth0)')).toBe(`${IF}[name="eth0"]/description`);
    expect(client.content.expandPath('@ifDescription')).toBe(`${IF}/description`);
    expect(client.content.expandPath('/m:as-given')).toBe('/m:as-given');
    expect(client.content.toXPath('@interface(eth0)').select).toBe("/ietf-interfaces:interfaces/ietf-interfaces:interface[ietf-interfaces:name='eth0']");
    expect(client.content.resolvePath('@interface').map((s) => s.name)).toEqual(['interfaces', 'interface']);
    expect(client.content.namedPathTemplate('interface')?.params).toEqual(['ifName']);
    expect(client.content.namedPathTemplate('nope')).toBeUndefined();
  });

  it('sends the expanded filter on read()', async () => {
    const { fake, client } = await open();
    await client.content.read('@ifDescription(ifName=eth0)', { format: 'xml' });
    const sent = serializeXml(fake.requests.at(-1)!.elements[0]!);
    expect(sent).toContain('<name>eth0</name>');
    expect(sent).toContain('<description/>');
  });

  it('refuses a change with a parameter left out, before anything is sent', async () => {
    const { fake, client } = await open();
    const before = fake.requests.length;
    await expect(client.content.set('@ifDescription', 'x')).rejects.toThrow(/@ifDescription needs ifName: a change must name every list entry/);
    await expect(client.content.remove('@interface')).rejects.toThrow(/needs ifName/);
    await expect(client.content.configure((txn) => txn.set('@interface(', 1))).rejects.toThrow(PathError);
    expect(fake.requests.length).toBe(before);
  });

  it('applies a change with every parameter given', async () => {
    const { fake, client } = await open();
    await client.content.set('@ifDescription(eth0)', 'uplink');
    const edit = fake.requests.map((r) => r.elements[0]!).find((e) => e.name === 'edit-config')!;
    const sent = serializeXml(edit);
    expect(sent).toContain('<name>eth0</name>');
    expect(sent).toContain('<description>uplink</description>');
  });

  it('applies a change to a path that carries on after the reference', async () => {
    const { fake, client } = await open();
    expect(client.content.expandPath('@interface(eth0)/description')).toBe(`${IF}[name="eth0"]/description`);
    await client.content.set('@interface(eth0)/description', 'uplink 10');
    const edit = fake.requests.map((r) => r.elements[0]!).find((e) => e.name === 'edit-config')!;
    const sent = serializeXml(edit);
    expect(sent).toContain('<name>eth0</name>');
    expect(sent).toContain('<description>uplink 10</description>');
    await expect(client.content.set('@interface/description', 'x')).rejects.toThrow(/needs ifName/);
  });

  it('reports an unknown name without its arguments', async () => {
    const { client } = await open();
    expect(() => client.content.expandPath('@missing(eth0)')).toThrow(/No path named "@missing"/);
  });
});
