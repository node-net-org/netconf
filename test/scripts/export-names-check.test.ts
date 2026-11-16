/**
 * PKG-01: an exported name means one thing across every entry point. The
 * guard in `npm run check` (scripts/export-names-check.mjs) fails the build
 * when two entries export one name for different declarations; these tests
 * run it on small fixture packages.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const SCRIPT = join(import.meta.dirname, '../../scripts/export-names-check.mjs');
const dirs: string[] = [];

async function fixture(files: Record<string, string>, exportsMap: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'names-check-'));
  dirs.push(dir);
  const exports = Object.fromEntries(Object.entries(exportsMap).map(([entry, types]) => [entry, { types, default: types }]));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', exports }));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

async function check(dir: string): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, dir]);
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, out: e.stdout + e.stderr };
  }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('export-names-check (PKG-01)', () => {
  it('fails when two entries export the same name for different declarations, naming both', async () => {
    const dir = await fixture(
      { 'a.d.ts': 'export interface LoadOptions { readonly a: string }\n', 'b.d.ts': 'export interface LoadOptions { readonly b: number }\n' },
      { '.': './a.d.ts', './b': './b.d.ts' },
    );
    const { code, out } = await check(dir);
    expect(code).toBe(1);
    expect(out).toContain('clash      LoadOptions: .  vs  ./b');
  });

  it('passes when every entry re-exports the same declaration', async () => {
    const dir = await fixture(
      { 'a.d.ts': 'export interface Shared { readonly a: string }\n', 'b.d.ts': "export type { Shared } from './a.js';\n" },
      { '.': './a.d.ts', './b': './b.d.ts' },
    );
    const { code, out } = await check(dir);
    expect(code).toBe(0);
    expect(out).toContain('no clashes');
  });

  it('allows only the documented shadow: connect and withClient between . and ./core', async () => {
    const decl = (tag: string) => `export declare function connect(o: { ${tag}: string }): void;\n`;
    const allowed = await fixture({ 'i.d.ts': decl('i'), 'c.d.ts': decl('c') }, { '.': './i.d.ts', './core': './c.d.ts' });
    expect((await check(allowed)).code).toBe(0);
    const elsewhere = await fixture({ 'i.d.ts': decl('i'), 't.d.ts': decl('t') }, { '.': './i.d.ts', './testing': './t.d.ts' });
    const { code, out } = await check(elsewhere);
    expect(code).toBe(1);
    expect(out).toContain('clash      connect');
  });
});
