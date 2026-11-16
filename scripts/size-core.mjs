// What a browser app pays for @node-net/netconf/core: a minified, code-split ESM
// bundle (rolldown, platform browser) of two apps, built from dist/:
//
// - core: dist/core.js as the entry, every export kept. It loads nothing it
//   doesn't need until a call asks for it.
// - json-read: connect() and one content.read() in the default JSON format,
//   so the YANG machinery has to load.
//
// For each, what loads up front (the entry chunk and the chunks it imports
// statically) and what loads on demand, minified and gzip (level 9), per chunk, and the largest contributors to
// each chunk by package (and by module with --modules). A module's share is
// its own rendered code minified on its own (no compression, so nothing is
// dropped as unused), scaled to the chunk's minified size.
//
//   npm run size -w @node-net/netconf                 # print the table
//   npm run size -w @node-net/netconf -- --modules    # also the biggest modules
//   npm run size -w @node-net/netconf -- --json       # machine-readable
//   npm run size:check -w @node-net/netconf           # fail if over BUDGET below
//
// The budget is what the core app loads up front, gzip, measured when the YANG
// machinery became lazy plus a small margin, raised to
// 47,200 when reconnecting(), content.invoke() and ops.action() joined the
// core (about 0.2 KB gzip; the YANG engine stays on demand). Raise it
// deliberately, with the reason in the commit, never to make check pass.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { rolldown } from 'rolldown';
import { minifySync } from 'rolldown/experimental';

/**
 * @node-net/yang modules allowed in what core loads up front: the error class core
 * exports (YangDataError) and what it imports. Everything else of @node-net/yang's
 * belongs in the on-demand chunks.
 */
const UP_FRONT_NET_YANG = new Set(['@node-net/yang/dist/errors.js', '@node-net/yang/dist/location.js']);

/** Gzip bytes the core app may load up front (its entry chunk and the chunks that imports). */
export const BUDGET = { app: 'core', gzip: 47_200 };

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

const APPS = {
  core: `export * from ${JSON.stringify(DIST + 'core.js')};\n`,
  'json-read': [
    `import { connect } from ${JSON.stringify(DIST + 'core.js')};`,
    'export async function read(connection) {',
    '  const client = await connect({ connection });',
    "  return client.content.read('/ietf-interfaces:interfaces');",
    '}',
    '',
  ].join('\n'),
};

/** The package a module belongs to: @node-net/netconf, @node-net/yang, or a node_modules package. */
function packageOf(id) {
  const nm = id.lastIndexOf('/node_modules/');
  if (nm !== -1) {
    const rest = id.slice(nm + 14).split('/');
    return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  }
  const m = /\/packages\/([^/]+)\//.exec(id);
  return m ? m[1] : id;
}

function minifiedLength(id, module) {
  if (!module.code) return module.renderedLength;
  try {
    return Buffer.byteLength(minifySync(id, module.code, { compress: false, mangle: true }).code);
  } catch {
    return module.renderedLength;
  }
}

async function measure(name, source) {
  const dir = mkdtempSync(join(tmpdir(), 'nn-size-'));
  try {
    const entry = join(dir, `${name}.mjs`);
    writeFileSync(entry, source);
    const bundle = await rolldown({ input: entry, platform: 'browser', logLevel: 'silent' });
    const { output } = await bundle.generate({ format: 'esm', minify: true });
    await bundle.close();
    const chunks = output
      .filter((o) => o.type === 'chunk')
      .map((c) => {
        const min = Buffer.byteLength(c.code);
        const gzip = gzipSync(c.code, { level: 9 }).length;
        const rendered = Object.entries(c.modules).map(([id, m]) => ({ id, length: minifiedLength(id, m) }));
        const total = rendered.reduce((n, m) => n + m.length, 0) || 1;
        const byPackage = new Map();
        for (const m of rendered) byPackage.set(packageOf(m.id), (byPackage.get(packageOf(m.id)) ?? 0) + m.length);
        const scale = (n) => Math.round((n / total) * min);
        return {
          fileName: c.fileName,
          imports: c.imports,
          chunk: c.isEntry ? 'initial' : c.fileName.replace(/-[\w-]{8}\.js$/, '').replace(/\.js$/, ''),
          min,
          gzip,
          packages: [...byPackage].map(([p, n]) => ({ name: p, min: scale(n) })).sort((a, b) => b.min - a.min),
          modules: rendered
            .map((m) => ({ name: m.id.replace(/^.*\/packages\//, '').replace(/^.*\/node_modules\//, ''), min: scale(m.length) }))
            .sort((a, b) => b.min - a.min),
        };
      })
      .sort((a, b) => (a.chunk === 'initial' ? -1 : b.chunk === 'initial' ? 1 : b.min - a.min));
    // Up front: the entry and every chunk it imports statically (shared
    // modules a bundler splits out); the rest load on demand.
    const byFile = new Map(chunks.map((c) => [c.fileName, c]));
    const upFront = new Set();
    const visit = (c) => {
      if (upFront.has(c)) return;
      upFront.add(c);
      for (const f of c.imports) if (byFile.has(f)) visit(byFile.get(f));
    };
    visit(chunks[0]);
    for (const c of chunks) c.load = upFront.has(c) ? 'up front' : 'on demand';
    const sum = (list) => list.reduce((t, c) => ({ min: t.min + c.min, gzip: t.gzip + c.gzip }), { min: 0, gzip: 0 });
    return { app: name, upFront: sum([...upFront]), onDemand: sum(chunks.filter((c) => !upFront.has(c))), chunks };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

export async function measureAll() {
  const results = [];
  for (const [name, source] of Object.entries(APPS)) results.push(await measure(name, source));
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = await measureAll();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const { app, upFront, onDemand, chunks } of results) {
      console.log(`\n${app}: up front ${kb(upFront.min)} minified, ${kb(upFront.gzip)} gzip; on demand ${kb(onDemand.min)}, ${kb(onDemand.gzip)} gzip`);
      for (const c of chunks) {
        console.log(`  ${c.chunk.padEnd(18)} ${c.load.padEnd(10)} ${kb(c.min).padStart(10)} ${kb(c.gzip).padStart(10)} gzip`);
        for (const p of c.packages.slice(0, 5)) console.log(`    ${p.name.padEnd(22)} ${kb(p.min).padStart(10)}`);
        if (process.argv.includes('--modules')) for (const m of c.modules.slice(0, 12)) console.log(`      ${m.name.padEnd(60)} ${kb(m.min).padStart(10)}`);
      }
    }
  }
  if (process.argv.includes('--check')) {
    const failures = [];
    for (const { app, chunks } of results) {
      const stray = chunks
        .filter((c) => c.load === 'up front')
        .flatMap((c) => c.modules.map((m) => m.name))
        .filter((name) => name.startsWith('@node-net/yang/') && !UP_FRONT_NET_YANG.has(name));
      if (stray.length > 0) failures.push(`${app} loads @node-net/yang code up front: ${stray.join(', ')}`);
    }
    if (failures.length > 0) {
      console.error(`\nsize:check: ${failures.join('; ')}. The YANG machinery must be reached only through src/yang/load.ts (design §12).`);
      process.exit(1);
    }
    const { upFront } = results.find((r) => r.app === BUDGET.app);
    if (upFront.gzip > BUDGET.gzip) {
      console.error(
        `\nsize:check: @node-net/netconf/core loads ${upFront.gzip} B gzip up front, over the budget of ${BUDGET.gzip} B. ` +
          'Find what grew with npm run size -w @node-net/netconf -- --modules. If the growth is wanted, raise BUDGET in scripts/size-core.mjs and say why.',
      );
      process.exit(1);
    }
    console.log(`\nsize:check: @node-net/netconf/core loads ${upFront.gzip} B gzip up front, within the budget of ${BUDGET.gzip} B`);
  }
}
