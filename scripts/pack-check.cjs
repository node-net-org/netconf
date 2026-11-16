/**
 * Checks what `npm pack` would publish: the compiled library, the profiles with
 * their schema, the README and the LICENSE, and nothing else (no sources, tests,
 * build-info files, or other packages). Run after `npm run build`.
 *
 * Then checks that the published declarations stand alone: nothing marked
 * `@internal` and no log switch in any `.d.ts`, no `.d.ts` imports
 * ssh2 (which ships no types; @types/ssh2 is only a devDependency here), and a
 * scratch consumer that has only the runtime dependencies and @types/node
 * typechecks every entry point with `skipLibCheck` off.
 */
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pkgDir = path.join(__dirname, '..');
const pkg = require(path.join(pkgDir, 'package.json'));

const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts=false'], {
  cwd: pkgDir,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
// npm prints the prepack/postpack script lines before the JSON on some versions.
const files = JSON.parse(out.slice(out.indexOf('['))).flatMap((p) => p.files.map((f) => f.path));

const required = ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts', 'dist/testing/index.js', 'profiles/profile.schema.json'];
const forbidden = [/^src\//, /^test\//, /^scripts\//, /\.test\.(js|d\.ts)$/, /\.tsbuildinfo$/, /(^|\/)node_modules\//, /^(cli|site|packages)\//];

const missing = required.filter((f) => !files.includes(f));
const unexpected = files.filter((f) => forbidden.some((re) => re.test(f)));
if (!files.some((f) => f.startsWith('profiles/') && f.endsWith('.json') && f !== 'profiles/profile.schema.json')) {
  missing.push('profiles/*.json (a built-in profile)');
}

if (missing.length > 0 || unexpected.length > 0) {
  for (const f of missing) console.error(`missing    ${f}`);
  for (const f of unexpected) console.error(`unexpected ${f}`);
  process.exit(1);
}
console.log(`ok   npm pack: ${files.length} files`);

// --- The declarations name no package without types of its own. ---
const importsSsh2 = /\b(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]ssh2(?:\/[^'"]*)?['"]/;
const leaking = files.filter((f) => f.endsWith('.d.ts') && importsSsh2.test(fs.readFileSync(path.join(pkgDir, f), 'utf8')));
if (leaking.length > 0) {
  for (const f of leaking) console.error(`imports ssh2 ${f}`);
  console.error("Published declarations must not import 'ssh2': it ships no types. Use the library's own types.");
  process.exit(1);
}

// --- The declarations hold the public API only (stripInternal). ---
// `@internal` members are stripped at build time; the log switch the client
// shares with its session is in no public type at all.
const internal = /@internal\b|[lL]ogSwitch/;
const exposing = files.filter((f) => f.endsWith('.d.ts') && internal.test(fs.readFileSync(path.join(pkgDir, f), 'utf8')));
if (exposing.length > 0) {
  for (const f of exposing) console.error(`internal   ${f}`);
  console.error('Published declarations must not contain @internal members or the log switch. Is stripInternal on?');
  process.exit(1);
}
console.log('ok   declarations: public API only (no @internal members, no log switch)');

// --- A consumer with skipLibCheck off, without @types/ssh2. ---
// node_modules holds symlinks to this package, its runtime dependencies and
// @types/node; preserveSymlinks keeps TypeScript resolving inside it, so the
// repository's own node_modules (with @types/ssh2) is never reached. That is
// wherever @types/node resolves from: the repository's, or the workspace's.
const typesNode = path.dirname(require.resolve('@types/node/package.json', { paths: [pkgDir] }));
const repoModules = path.resolve(typesNode, '..', '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-net-netconf-consumer-'));
try {
  const nm = path.join(dir, 'node_modules');
  // Links a package and, transitively, its runtime dependencies (flat, as npm
  // would hoist them), each found from where the package itself lives.
  const link = (name, target) => {
    const at = path.join(nm, name);
    if (fs.existsSync(at)) return;
    const real = fs.realpathSync(target);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(real, at, 'dir');
    const deps = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8')).dependencies ?? {};
    for (const dep of Object.keys(deps)) {
      link(dep, path.dirname(require.resolve(`${dep}/package.json`, { paths: [real, repoModules] })));
    }
  };
  link(pkg.name, pkgDir);
  link('@types/node', typesNode);

  const entries = Object.keys(pkg.exports).filter((e) => e !== './package.json');
  const lines = entries.map((e, i) => `import * as entry${i} from '${pkg.name}${e === '.' ? '' : e.slice(1)}';`);
  lines.push(
    `import { ssh, type CallHomeSshListen, type SshAlgorithms } from '${pkg.name}';`,
    `export const all = [${entries.map((_, i) => `entry${i}`).join(', ')}];`,
    `const algorithms: SshAlgorithms = { kex: ['curve25519-sha256'], serverHostKey: { append: 'ssh-rsa', remove: ['ssh-dss'] } };`,
    `export const transport = ssh({ host: 'h', username: 'u', password: 'p', hostKey: 'insecure-accept-any', algorithms });`,
    `export const listen: CallHomeSshListen = { algorithms: { cipher: { prepend: ['aes256-gcm@openssh.com'] } } };`,
    `// The option is typed, not any.`,
    `// @ts-expect-error a category is a list or an edit`,
    `export const wrong: SshAlgorithms = { kex: 5 };`,
  );
  fs.writeFileSync(path.join(dir, 'consumer.ts'), lines.join('\n') + '\n');
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'nodenext',
        moduleResolution: 'nodenext',
        target: 'es2022',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        preserveSymlinks: true,
        types: ['node'],
      },
      files: ['consumer.ts'],
    }),
  );
  const tsc = require.resolve('typescript/bin/tsc', { paths: [pkgDir] });
  try {
    execFileSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    process.stderr.write(String(err.stdout ?? '') + String(err.stderr ?? ''));
    console.error('A consumer with skipLibCheck off and no @types/ssh2 does not typecheck.');
    process.exit(1);
  }
  console.log(`ok   declarations: ${entries.length} entry points typecheck for a consumer without @types/ssh2`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
