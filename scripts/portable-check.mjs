// @node-net/netconf/core and @node-net/netconf/testing must run in any JavaScript runtime
// (PKG-06). After a build, this:
//
// 1. bundles them for the browser platform with no aliases or externals, and
//    fails on any import that can't be resolved or loaded there (a Node
//    built-in, ssh2's native code);
// 2. runs the bundle in a context with only web-platform globals (no Buffer,
//    process or require) and connects to a FakeServer over an in-memory
//    connection: hello, get-config, close.
//
//   npm run build && node scripts/portable-check.mjs

import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const entry = fileURLToPath(new URL('./portable-smoke.mjs', import.meta.url));

const problems = [];
let output;
try {
  const bundle = await rolldown({
    input: entry,
    platform: 'browser',
    onLog(level, log) {
      // An import that can't be resolved for the browser is left external with a warning: that is a failure here.
      if (level === 'warn' || log.code === 'UNRESOLVED_IMPORT') problems.push(`${log.code ?? level}: ${log.message}`);
    },
  });
  ({ output } = await bundle.generate({ format: 'iife' }));
  await bundle.close();
} catch (err) {
  problems.push(`bundle failed: ${err.message}`);
}
if (problems.length > 0) fail('@node-net/netconf/core does not bundle for the browser', problems);

const code = output[0].code;
const leftovers = [...code.matchAll(/(?:require\(|from\s*)["'](node:[\w/]+|ssh2)["']/g)].map((m) => m[1]);
if (leftovers.length > 0) fail('the browser bundle still imports Node modules', leftovers);

// Web-platform globals only. The JavaScript built-ins (Promise, Map, Uint8Array, …) come with the context itself.
const context = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  structuredClone,
  TextEncoder,
  TextDecoder,
  URL,
  AbortController,
  AbortSignal,
  Event,
  EventTarget,
  DOMException,
  performance,
  atob,
  btoa,
});
vm.runInContext(code, context, { filename: 'portable-bundle.js' });
for (const name of ['Buffer', 'process', 'require']) {
  if (vm.runInContext(`typeof ${name}`, context) !== 'undefined') fail(`the check context has ${name}`, []);
}

let result;
try {
  result = await vm.runInContext('portableSmoke()', context);
} catch (err) {
  fail('the smoke run failed without Node globals', [err.stack ?? String(err)]);
}
const expect = (ok, what) => {
  if (!ok) fail(`smoke: ${what}`, [JSON.stringify(result)]);
};
expect(result.capabilities >= 2, 'the server hello was read');
expect(result.version === '1.1', 'base:1.1 was negotiated (chunked framing)');
expect(result.config.startsWith('<data'), 'get-config returned <data>');
expect(result.profiles >= 3, 'the built-in profiles loaded without a filesystem');
expect(result.directories === 'refused', 'YANG module directories are refused with a TypeError');

const kib = (Buffer.byteLength(code) / 1024).toFixed(0);
console.log(`portable:check ok: @node-net/netconf/core bundles for the browser (${kib} KiB unminified) and runs without Node globals`);

function fail(message, details) {
  console.error(`portable:check: ${message}`);
  for (const d of details) console.error(`  ${d}`);
  process.exit(1);
}
