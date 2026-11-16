// Parse and conversion cost on large replies: time and memory for parseXml,
// toJson, many small conversions against a large YANG library, and
// end-of-message decoding from 4 KiB reads. The ns cases are hostile
// namespace declarations: K on the root, then K children declaring one more
// each (which once took memory quadratic in K), and parse + serialise.
//
//   npm run bench:parse                      # every case
//   npm run bench:parse -- --sizes 8,64      # parse sizes in MB
//   npm run bench:parse -- --only parse,eom  # case groups: parse, ns, tojson, small, eom
//
// Each case runs in its own child process (with --expose-gc), so its memory
// figures aren't mixed with another case's:
// - peak RSS: the high-water RSS during the work (reset just before it, on
//   Linux) minus the RSS just before it, i.e. what the work added at its peak. ×input is that
//   divided by the input's size in bytes.
// - heap / arrayBuffers: what is still held after the work, with its result
//   alive and after a full GC, i.e. what the result itself costs.
// Times are the median of several runs (one run for inputs of 64 MB or more).

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GCProfiler } from 'node:v8';

const SELF = fileURLToPath(import.meta.url);
const MB = 1024 * 1024;

// --- the parent: run each case in a child and print a table ------------------------------------

if (process.argv[2] !== '--case') {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const sizes = arg('--sizes', '8,64,256').split(',').map(Number);
  const only = new Set(arg('--only', 'parse,ns,tojson,small,eom').split(','));
  const cases = [];
  if (only.has('parse')) for (const shape of ['config', 'flat']) for (const mb of sizes) cases.push(`parse:${shape}:${mb}`);
  if (only.has('ns')) cases.push('ns:parse:4000', 'ns:parse:100000', 'ns:serialize:100000');
  if (only.has('tojson')) cases.push('tojson:16');
  if (only.has('small')) cases.push('small:2000');
  if (only.has('eom')) cases.push('eom:64', 'chunked:64');

  console.log(`node ${process.version}, ${new Date().toISOString().slice(0, 10)}`);
  console.log('case                    input MB      nodes   time ms   MB/s  peak heap MB  ×input  peak RSS MB  held heap MB  held AB MB');
  for (const c of cases) {
    const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=32768', SELF, '--case', c], {
      encoding: 'utf8',
      maxBuffer: 1 << 20,
    });
    const line = child.stdout.trim().split('\n').at(-1) ?? '';
    if (child.status !== 0 || !line.startsWith('{')) {
      console.log(`${c.padEnd(22)}  failed: ${(child.stderr.trim().split('\n').find((l) => /Error|heap/.test(l)) ?? `exit ${child.status}`).slice(0, 80)}`);
      continue;
    }
    const r = JSON.parse(line);
    const cols = [
      c.padEnd(22),
      r.inputMB.toFixed(1).padStart(9),
      (r.nodes === undefined ? '' : String(r.nodes)).padStart(10),
      r.ms.toFixed(r.ms < 10 ? 3 : 0).padStart(9),
      (r.inputMB / (r.ms / 1000)).toFixed(0).padStart(6),
      r.peakHeapMB.toFixed(0).padStart(13),
      (r.peakHeapMB / r.inputMB).toFixed(1).padStart(7),
      r.peakRssMB.toFixed(0).padStart(12),
      r.heldHeapMB.toFixed(0).padStart(13),
      r.heldAbMB.toFixed(0).padStart(11),
    ];
    console.log(cols.join(' ') + (r.note ? `   ${r.note}` : ''));
  }
  process.exit(0);
}

// --- a child: one case --------------------------------------------------------------------------

const [kind, shapeOrN, sizeArg] = process.argv[3].split(':');
const dist = (p) => new URL(`../dist/${p}`, import.meta.url).href;
const { parseXml } = await import(dist('xml/index.js'));

const mem = () => {
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage();
};
/**
 * Peak RSS since the last resetPeak(). On Linux, writing 5 to clear_refs
 * resets the kernel's high-water mark (VmHWM), so building the input doesn't
 * count; elsewhere it's the process's lifetime peak.
 */
const resetPeak = () => {
  try {
    writeFileSync('/proc/self/clear_refs', '5');
  } catch {
    // not Linux: the lifetime peak
  }
};
const maxRssBytes = () => {
  try {
    const kb = /VmHWM:\s+(\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8'))?.[1];
    if (kb !== undefined) return Number(kb) * 1024;
  } catch {
    // not Linux
  }
  return process.resourceUsage().maxRSS * 1024;
};
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

/** Run `work` `runs` times (keeping only the last result), and measure it. */
async function measure(inputBytes, runs, work) {
  const before = mem();
  resetPeak();
  const held = { result: undefined }; // only the last run's result stays alive
  const times = [];
  let peakHeap = 0;
  for (let i = 0; i < runs; i++) {
    held.result = undefined;
    if (i > 0) globalThis.gc();
    const profiler = new GCProfiler();
    profiler.start();
    const start = performance.now();
    held.result = await work();
    times.push(performance.now() - start);
    const used = process.memoryUsage().heapUsed;
    const gcs = profiler.stop().statistics;
    peakHeap = Math.max(peakHeap, used, ...gcs.map((g) => g.beforeGC.heapStatistics.usedHeapSize));
  }
  const after = mem();
  return {
    result: held.result,
    inputMB: inputBytes / MB,
    ms: median(times),
    peakRssMB: (maxRssBytes() - before.rss) / MB,
    peakHeapMB: (peakHeap - before.heapUsed) / MB,
    heldHeapMB: (after.heapUsed - before.heapUsed) / MB,
    heldAbMB: (after.arrayBuffers - before.arrayBuffers) / MB,
  };
}

const NC = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const IF = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
const IP = 'urn:ietf:params:xml:ns:yang:ietf-ip';
const IANA = 'urn:ietf:params:xml:ns:yang:iana-if-type';

/** A pretty-printed get-config reply of interfaces, as servers send them: indentation, namespaces, an identityref. */
function configReply(bytes) {
  const rows = [];
  let n = 0;
  for (let size = 0; size < bytes; n++) {
    const row = `
      <interface>
        <name>ge-0/0/${n}</name>
        <description>uplink ${n} to core &amp; edge – ü</description>
        <type xmlns:ianaift="${IANA}">ianaift:ethernetCsmacd</type>
        <enabled>true</enabled>
        <ipv4 xmlns="${IP}">
          <enabled>true</enabled>
          <mtu>1500</mtu>
          <address>
            <ip>10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}</ip>
            <prefix-length>24</prefix-length>
          </address>
        </ipv4>
      </interface>`;
    rows.push(row);
    size += row.length;
  }
  return `<rpc-reply xmlns="${NC}" message-id="101">
  <data>
    <interfaces xmlns="${IF}">${rows.join('')}
    </interfaces>
  </data>
</rpc-reply>`;
}

/** A compact reply of one long flat list of short leaves. */
function flatReply(bytes) {
  const rows = [];
  for (let n = 0, size = 0; size < bytes; n++) {
    const row = `<route>10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}/32</route>`;
    rows.push(row);
    size += row.length;
  }
  return `<rpc-reply xmlns="${NC}" message-id="101"><data><routes xmlns="urn:example:routes">${rows.join('')}</routes></data></rpc-reply>`;
}

function countNodes(el) {
  let n = 1 + el.attributes.length;
  for (const c of el.children) n += typeof c === 'string' ? 1 : countNodes(c);
  return n;
}

const out = {};

if (kind === 'parse') {
  const mb = Number(sizeArg);
  const text = shapeOrN === 'config' ? configReply(mb * MB) : flatReply(mb * MB);
  parseXml(configReply(64 * 1024)); // warm up
  const r = await measure(text.length, mb >= 64 ? 1 : 5, () => parseXml(text, { maxNodes: Infinity }));
  Object.assign(out, r, { nodes: countNodes(r.result) });
} else if (kind === 'ns') {
  const { serializeXml } = await import(dist('xml/index.js'));
  const k = Number(sizeArg);
  let text = '<data xmlns="urn:example:ns"';
  for (let i = 0; i < k; i++) text += ` xmlns:p${i}="urn:example:p${i}"`;
  text += '>';
  for (let i = 0; i < k; i++) text += `<c xmlns:q${i}="urn:example:q${i}"/>`;
  text += '</data>';
  parseXml(configReply(64 * 1024)); // warm up
  if (shapeOrN === 'parse') {
    const r = await measure(text.length, 3, () => parseXml(text));
    Object.assign(out, r, { nodes: countNodes(r.result), note: `${k} root declarations × ${k} declaring children` });
  } else {
    const doc = parseXml(text);
    const r = await measure(text.length, 3, () => serializeXml(doc));
    Object.assign(out, r, { note: `serialise the parsed tree (${k} × ${k})` });
  }
} else if (kind === 'eom' || kind === 'chunked') {
  const { encodeMessage, FrameDecoder } = await import(dist('transport/framing/index.js'));
  const mb = Number(shapeOrN);
  const text = flatReply(mb * MB);
  const framed = encodeMessage(text, kind);
  const READ = 4096;
  const r = await measure(framed.length, 3, () => {
    const decoder = new FrameDecoder({ mode: kind, maxMessageBytes: 1024 * MB });
    let got;
    for (let off = 0; off < framed.length; off += READ) {
      decoder.push(framed.subarray(off, off + READ));
      got ??= decoder.next();
    }
    got ??= decoder.next();
    if (got?.length !== text.length) throw new Error(`decoded ${got?.length} characters, expected ${text.length}`);
    return got;
  });
  Object.assign(out, r, { note: `${Math.ceil(framed.length / READ)} reads of ${READ} B` });
} else {
  // toJson: convertData with a client-shaped schema context (client-yang.ts).
  const { convertData } = await import(dist('yang/convert.js'));
  const { YangCache } = await import(dist('yang/cache.js'));
  const { toSchemaLibrary } = await import(dist('client-yang.js'));
  const { memorySource } = await import('@node-net/yang/core');
  const fixtures = new URL('../test/fixtures/yang/json/', import.meta.url);
  const text = (f) => readFileSync(new URL(f, fixtures), 'utf8');
  const EJ = 'urn:example:json';
  const EA = 'urn:example:aug';

  // The server's YANG library as @node-net/netconf reads it: the two fixture
  // modules plus `filler` modules no reply uses, as on a large router.
  const filler = kind === 'small' ? Number(shapeOrN) : 50;
  const mod = (name, namespace) => ({ name, revision: '2026-11-09', namespace, locations: [], features: [], deviations: [], submodules: [] });
  const modules = [mod('ex-json', EJ), mod('ex-aug', EA)];
  for (let i = 0; i < filler; i++) modules.push({ ...mod(`vendor-module-${i}`, `urn:example:vendor:module-${i}`), features: ['f1', 'f2'] });
  const library = {
    version: '1.1',
    contentId: 'bench-1',
    moduleSets: [{ name: 'all', modules, importOnlyModules: [] }],
    schemas: [{ name: 'all', moduleSets: ['all'] }],
    datastores: ['running', 'candidate', 'startup', 'operational'].map((d) => ({ name: `ietf-datastores:${d}`, schema: 'all', modules, importOnlyModules: [] })),
  };
  const source = memorySource([text('ex-json@2026-11-09.yang'), text('ex-aug@2026-11-09.yang')]);
  const ctx = {
    // As client-yang.ts: the session's library read (shared, so the same object each time), then toSchemaLibrary.
    library: async () => toSchemaLibrary(library),
    source,
    sourceKey: 'bench',
    moduleOf: (ns) => ({ [EJ]: 'ex-json', [EA]: 'ex-aug' })[ns],
    namespaceOf: () => undefined,
    warn: (m) => {
      throw new Error(`unexpected schema-less conversion: ${m}`);
    },
    cache: new YangCache(),
  };
  const item = (n) =>
    `<item><name>i${n}</name><count>-5</count><size>${n}</size><big>18446744073709551615</big><ratio>1.50</ratio><on>true</on><flag/><kind xmlns:ej="${EJ}">ej:fast</kind><note>note ${n}</note><tag>x</tag><tag>y</tag><extra xmlns="${EA}">e</extra></item>`;
  const opts = { datastore: 'running', requireSchema: true };

  if (kind === 'tojson') {
    const mb = Number(shapeOrN);
    const items = [];
    for (let n = 0, size = 0; size < mb * MB; n++) {
      const row = item(n);
      items.push(row);
      size += row.length;
    }
    const xml = `<data xmlns="${NC}"><top xmlns="${EJ}">${items.join('')}</top></data>`;
    const data = parseXml(xml, { maxNodes: Infinity });
    await convertData(ctx, parseXml(`<data xmlns="${NC}"><top xmlns="${EJ}">${item(0)}</top></data>`), opts); // compile + warm up
    const r = await measure(xml.length, 3, () => convertData(ctx, data, opts));
    if (r.result['ex-json:top'].item.length !== items.length) throw new Error('wrong item count');
    Object.assign(out, r, { nodes: countNodes(data), note: `${items.length} list entries; parse excluded` });
  } else {
    const CALLS = 2000;
    const data = parseXml(`<data xmlns="${NC}"><top xmlns="${EJ}">${item(1)}</top></data>`);
    await convertData(ctx, data, opts); // compile + warm up
    const r = await measure(data.toString().length * CALLS, 5, async () => {
      let last;
      for (let i = 0; i < CALLS; i++) last = await convertData(ctx, data, opts);
      return last;
    });
    Object.assign(out, r, { note: `${CALLS} one-entry conversions, ${modules.length}-module library: ${((r.ms * 1000) / CALLS).toFixed(1)} µs each` });
  }
}

delete out.result;
console.log(JSON.stringify(out));
