/**
 * Fails when two entry points export the same name for different
 * declarations. A user who imports from `@node-net/netconf` and
 * `@node-net/netconf/operations/monitoring`, say, must never have to rename one
 * import because the two mean different things.
 *
 * Reads the built declarations: every `types` file in package.json `exports`.
 * A name re-exported by several entries is fine when every one resolves to
 * the same declaration. Run after `npm run build`.
 *
 * One exception, by design: `@node-net/netconf` redefines core's `connect`,
 * `withClient` and `reconnecting` to add Node's YANG directory reading
 * (src/index.ts). They take the same options and mean the same thing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// The package to check: this one, or the directory given (the script's own test uses a fixture).
const pkgDir = process.argv[2] === undefined ? join(dirname(fileURLToPath(import.meta.url)), '..') : resolve(process.argv[2]);
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

/** Entry name (`.`, `./core`, …) → absolute path of its `.d.ts`. */
const entries = new Map();
for (const [entry, target] of Object.entries(pkg.exports)) {
  if (typeof target === 'object' && target !== null && typeof target.types === 'string') {
    entries.set(entry, join(pkgDir, target.types));
  }
}

const program = ts.createProgram([...entries.values()], {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  noEmit: true,
  skipLibCheck: true,
});
const checker = program.getTypeChecker();

/** Names an entry may redefine over another's, as `name → the entries involved`. */
const SHADOWS = new Map([
  ['connect', ['.', './core']],
  ['withClient', ['.', './core']],
  ['reconnecting', ['.', './core']],
]);

/** A stable identity for a symbol's declarations: file and position of each. */
function identity(symbol) {
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const decls = target.declarations ?? [];
  return decls
    .map((d) => `${relative(pkgDir, d.getSourceFile().fileName)}:${d.getStart()}`)
    .sort()
    .join(',');
}

/** Exported name → Map(identity → entries exporting it with that identity). */
const byName = new Map();
for (const [entry, file] of entries) {
  const source = program.getSourceFile(file);
  if (source === undefined) {
    console.error(`missing    ${relative(pkgDir, file)} (run npm run build first)`);
    process.exit(1);
  }
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) continue;
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const name = symbol.getName();
    const id = identity(symbol);
    let ids = byName.get(name);
    if (ids === undefined) byName.set(name, (ids = new Map()));
    let list = ids.get(id);
    if (list === undefined) ids.set(id, (list = []));
    list.push(entry);
  }
}

const shadowed = ([name, ids]) => {
  const allowed = SHADOWS.get(name);
  return allowed !== undefined && [...ids.values()].flat().every((entry) => allowed.includes(entry));
};
const clashes = [...byName].filter(([name, ids]) => ids.size > 1 && !shadowed([name, ids])).sort(([a], [b]) => a.localeCompare(b));
if (clashes.length > 0) {
  for (const [name, ids] of clashes) {
    const where = [...ids.values()].map((list) => list.join(' + ')).join('  vs  ');
    console.error(`clash      ${name}: ${where}`);
  }
  console.error(
    'Each exported name must mean one thing across every entry point. Rename one of them (see design §5.9).',
  );
  process.exit(1);
}
console.log(`ok   export names: ${byName.size} names across ${entries.size} entries, no clashes`);
