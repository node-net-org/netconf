#!/usr/bin/env node
// DEF, the defect server of the manual-testing lab.
//
// A fake NETCONF server over real SSH that misbehaves on demand, so nnc's and
// the library's reactions can be watched by hand. It plays one scenario per
// run; restart it to switch.
//
//   npm run lab:def -- --list                 the scenarios, with the rows they serve
//   npm run lab:def -- <scenario> [--port N]  serve it on 127.0.0.1:18500, user netconf / netconf
//
// Uses only the public API of the built library (npm run build first):
// FakeServer from @node-net/netconf/testing does the NETCONF side, ssh2 the SSH side.
// The host key is new on every run, so targets use "insecure-accept-any".
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import ssh2 from 'ssh2';
import { FrameDecoder, NETCONF_NS, x } from '@node-net/netconf';
import { FakeServer } from '@node-net/netconf/testing';

const { Server, utils } = ssh2;

const USERNAME = 'netconf';
const PASSWORD = 'netconf';
const DEFAULT_PORT = 18500;

const BASE_1_0 = 'urn:ietf:params:netconf:base:1.0';
const BASE_1_1 = 'urn:ietf:params:netconf:base:1.1';
const EX = 'urn:example:def';
const SN = 'urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications';
const BASE_CAPS = [BASE_1_0, BASE_1_1, 'urn:ietf:params:netconf:capability:writable-running:1.0'];
const SUBSCRIPTION_CAPS = [
  ...BASE_CAPS,
  'urn:ietf:params:netconf:capability:notification:1.0',
  'urn:ietf:params:netconf:capability:interleave:1.0',
  `${SN}?module=ietf-subscribed-notifications&revision=2019-09-09`,
];

// --- helpers for scenarios -------------------------------------------------------------

/** The data every well-behaved read returns. */
const sampleData = () => x('system', { xmlns: EX }, x('hostname', 'def'), x('location', 'lab1'));

/** An `<rpc-reply>` as text, with the request's message-id (or none, with `id` null). */
const replyText = (id, body) =>
  `<rpc-reply xmlns="${NETCONF_NS}"${id === null ? '' : ` message-id="${id}"`}>${body}</rpc-reply>`;

const rpcError = ({ type = 'application', tag = 'operation-failed', severity = 'error', message }) =>
  x('rpc-error',
    x('error-type', type),
    x('error-tag', tag),
    x('error-severity', severity),
    message !== undefined && x('error-message', message),
  );

const isRead = (op) => op?.name === 'get' || op?.name === 'get-config' || op?.name === 'get-data';

/** Chunked framing by hand, for scenarios that send a well-formed reply as raw bytes. */
const chunked = (text) => `\n#${Buffer.byteLength(text)}\n${text}\n##\n`;
const encoder = new TextEncoder();

/** A notification every `ms`, from the moment the session opens until it ends. */
const every = (ms, send) => (server, log) => {
  let n = 0;
  const timer = setInterval(() => {
    n++;
    send(server, n);
    log(`sent notification ${n}`);
  }, ms);
  return () => clearInterval(timer);
};

// --- scenarios ---------------------------------------------------------------------------
//
// Each one is data: what the server advertises, how it answers RPCs, and what
// it does on its own. Fields:
//   rows        the manual-testing plan rows it makes reachable
//   summary     what it does
//   try         what to type in nnc to see it (connect first, except where said)
//   capabilities, hello   FakeServer options (hello: false sends none)
//   handler     FakeServer handler: (rpc, { messageId, operation, server }) => result
//   ignoreClose never answer <close-session> (FakeServer always answers it, so DEF drops it first)
//   start       (server, log) => stop: runs once the client's hello has arrived

const SCENARIOS = [
  {
    name: 'normal',
    rows: [],
    summary: 'A well-behaved server: reads return a small <system>, everything else <ok/>. A baseline to compare the others with.',
    try: 'get-config running',
    handler: (_rpc, { operation }) => (isRead(operation) ? { data: sampleData() } : 'ok'),
  },

  // F7: framing defects. Each one ends the session.
  {
    name: 'bad-chunk-header',
    rows: ['F7'],
    summary: 'Answers any RPC with a chunk header that is not a number (\\n#abc\\n).',
    try: 'get (trace bytes shows the header)',
    handler: (_rpc, { server }) => {
      server.sendRaw('\n#abc\n<rpc-reply/>\n##\n');
    },
  },
  {
    name: 'chunk-over-limit',
    rows: ['F7', 'F3'],
    summary: 'Answers any RPC with a chunk header announcing 70 MiB, over the default maxMessageBytes (64 MiB), and sends no data.',
    try: 'get; then set a target maxMessageBytes and compare',
    handler: (_rpc, { server }) => {
      server.sendRaw(`\n#${70 * 1024 * 1024}\n`);
    },
  },
  {
    name: 'chunk-over-max',
    rows: ['F7'],
    summary: 'Answers any RPC with a chunk header of 4294967296, one more than RFC 6242 allows.',
    try: 'get',
    handler: (_rpc, { server }) => {
      server.sendRaw('\n#4294967296\n');
    },
  },
  {
    name: 'eom-after-chunked',
    rows: ['F7'],
    summary: 'Negotiates base:1.1, then frames its replies with the base:1.0 end-of-message marker ]]>]]> instead of chunks.',
    try: 'get (trace bytes shows the marker where a chunk header should be)',
    handler: (_rpc, { messageId, server }) => {
      server.sendRaw(`${replyText(messageId, `<data><system xmlns="${EX}"><hostname>def</hostname></system></data>`)}]]>]]>`);
    },
  },
  {
    name: 'eom-inside-chunk',
    rows: ['F7'],
    summary: 'A correct chunked reply whose content contains ]]>]]> (in an attribute value, where XML allows it). Chunked framing must carry it untouched.',
    try: 'get-config running (the value shows ]]>]]>)',
    handler: (_rpc, { messageId, operation, server }) => {
      if (!isRead(operation)) return 'ok';
      server.sendRaw(chunked(replyText(messageId, `<data><note xmlns="${EX}" text="a]]>]]>b">the attribute holds the EOM marker</note></data>`)));
    },
  },

  // D14: replies without a message-id.
  {
    name: 'no-message-id',
    rows: ['D14'],
    summary: 'Leaves message-id off its replies. Reads get <data>; other operations get a malformed-message rpc-error.',
    try: 'get-config running --timeout 5000 (strict: unmatched, warning, timeout); lock running (strict: matched, the error is shown). Then the same on lab-def-quirks (oldest)',
    handler: (_rpc, { operation, server }) => {
      if (isRead(operation)) {
        server.send(x('rpc-reply', { xmlns: NETCONF_NS }, x('data', sampleData())));
      } else {
        server.send(x('rpc-reply', { xmlns: NETCONF_NS }, rpcError({ type: 'rpc', tag: 'malformed-message', message: 'DEF: reply without a message-id' })));
      }
    },
  },

  // D11, D12: the 7210's quirks.
  {
    name: 'bel-in-error',
    rows: ['D11'],
    summary: 'Answers any RPC with an rpc-error whose message contains a BEL (0x07), which XML 1.0 does not allow, as the 7210 does.',
    try: 'get (lab-def: the session closes; lab-def-quirks: the error, BEL stripped)',
    // As text: the library's serializer refuses the BEL, as it should.
    handler: (_rpc, { messageId, server }) => {
      server.send(replyText(messageId,
        '<rpc-error><error-type>application</error-type><error-tag>operation-failed</error-tag><error-severity>error</error-severity>' +
        '<error-message>MINOR: CLI Command not allowed for this user.\u0007</error-message></rpc-error>'));
    },
  },
  {
    name: 'padded-empty',
    rows: ['D12'],
    summary: 'Reads return empty elements written across two lines (<access>, a line feed, 20 spaces, </access>), as the 7210 does, next to a leaf whose value is two spaces.',
    try: 'get-config running --xml (lab-def: <access> holds the padding; lab-def-quirks: <access/>; <banner> keeps its spaces in both)',
    handler: (_rpc, { messageId, operation, server }) => {
      if (!isRead(operation)) return 'ok';
      const padding = `\n${' '.repeat(20)}`;
      server.send(replyText(messageId,
        `<data><system xmlns="${EX}"><hostname>def</hostname><banner>  </banner>` +
        `<security><user><name>lab1</name><access>${padding}</access></user></security></system></data>`));
    },
  },

  // S7, S13: warnings.
  {
    name: 'warnings-only',
    rows: ['S7'],
    summary: 'Reads return <data> plus an rpc-error of severity warning. Other operations get only a warning: no <ok/>, no error.',
    try: 'get-config running; lock running',
    handler: (_rpc, { operation }) => {
      const warning = rpcError({ tag: 'operation-failed', severity: 'warning', message: 'DEF: this is only a warning' });
      return isRead(operation) ? { body: [warning, x('data', sampleData())] } : { body: [warning] };
    },
  },
  {
    name: 'stray-messages',
    rows: ['S13'],
    summary: 'Before each real reply, sends a reply for a message-id nobody asked for, and a message that is neither a reply nor a notification.',
    try: 'get (two session warnings, then the result)',
    handler: (_rpc, { operation, server }) => {
      server.send(replyText('999999', '<ok/>'));
      server.send(`<surprise xmlns="${EX}"/>`);
      return isRead(operation) ? { data: sampleData() } : 'ok';
    },
  },

  // S9, D16: silence.
  {
    name: 'no-hello',
    rows: ['S9'],
    summary: 'Accepts the SSH connection and the netconf subsystem, then never sends its hello.',
    try: 'connect lab-def (waits for the hello timeout, 30 s by default); target "timeouts": { "hello": 5000 } to shorten it',
    hello: false,
  },
  {
    name: 'no-reply',
    rows: ['S9'],
    summary: 'Never answers an RPC (but does answer <close-session>).',
    try: 'get --timeout 5000; get, then Ctrl-C',
  },
  {
    name: 'no-close-reply',
    rows: ['S9', 'D16'],
    summary: 'Answers RPCs normally but never answers <close-session>.',
    try: 'disconnect (lab-def: waits the 5 s close timeout; lab-def-quirks: closeTimeout 1 s)',
    handler: (_rpc, { operation }) => (isRead(operation) ? { data: sampleData() } : 'ok'),
    ignoreClose: true,
  },

  // S14, F3: size.
  {
    name: 'deep-reply',
    rows: ['S14'],
    summary: 'Reads return data nested 300 elements deep, past the default parseLimits.maxDepth (256).',
    try: 'get-config running; then a target "parseLimits": { "maxDepth": 400 }',
    handler: (_rpc, { messageId, operation, server }) => {
      if (!isRead(operation)) return 'ok';
      const depth = 300;
      server.send(replyText(messageId, `<data><n xmlns="${EX}">${'<n>'.repeat(depth - 1)}bottom${'</n>'.repeat(depth)}</data>`));
    },
  },
  {
    name: 'big-reply',
    rows: ['S14', 'F3', 'N9'],
    summary: 'Reads return a list of --entries entries (default 50000, about 4 MB and 200 000 elements): within the default limits.',
    try: 'get-config running; then a target with a low maxMessageBytes or parseLimits.maxNodes',
    handler: (_rpc, { operation }, options) => {
      if (!isRead(operation)) return 'ok';
      const entries = [];
      for (let i = 1; i <= options.entries; i++) {
        entries.push(x('entry', x('name', `entry-${i}`), x('value', String(i * 7)), x('enabled', i % 2 === 0 ? 'true' : 'false')));
      }
      return { data: x('table', { xmlns: EX }, entries) };
    },
  },

  // N13, M34: messages the client did not ask for.
  {
    name: 'notifications',
    rows: ['N13'],
    summary: 'Sends an RFC 5277 <notification> every --interval seconds (default 5) from the moment the session opens, without any subscription. RPCs behave normally.',
    try: 'connect, then start typing a command and wait',
    capabilities: [...BASE_CAPS, 'urn:ietf:params:netconf:capability:notification:1.0', 'urn:ietf:params:netconf:capability:interleave:1.0'],
    handler: (_rpc, { operation }) => (isRead(operation) ? { data: sampleData() } : 'ok'),
    start: (server, log, options) =>
      every(options.interval * 1000, (s, n) => s.notify(x('lab-event', { xmlns: EX }, x('sequence', String(n)))))(server, log),
  },
  {
    name: 'suspended',
    rows: ['M34'],
    summary: 'Supports RFC 8639 stream subscriptions. After establish-subscription it sends an event every --interval seconds; the 3rd is followed by subscription-suspended (insufficient-resources), and 2 intervals later subscription-resumed.',
    try: 'establish-subscription --stream NETCONF, then notifications --follow',
    capabilities: SUBSCRIPTION_CAPS,
    handler: (_rpc, { operation, server }, options, state) => {
      if (operation?.name === 'establish-subscription') {
        const id = ++state.lastId;
        state.stop?.();
        state.stop = subscriptionScript(server, id, options.interval * 1000, state.log);
        return { body: [x('id', { xmlns: SN }, String(id))] };
      }
      if (operation?.name === 'delete-subscription' || operation?.name === 'kill-subscription') {
        state.stop?.();
        state.stop = undefined;
        return 'ok';
      }
      return isRead(operation) ? { data: sampleData() } : 'ok';
    },
    start: (_server, _log, _options, state) => () => state.stop?.(),
  },
];

/** Events, then suspended, then (after a gap with no events) resumed, then events again. */
function subscriptionScript(server, id, ms, log) {
  const sn = (name, ...rest) => x(name, { xmlns: SN }, x('id', String(id)), ...rest);
  let tick = 0;
  let suspended = false;
  const timer = setInterval(() => {
    tick++;
    if (tick === 4) {
      server.notify(sn('subscription-suspended', x('reason', { 'xmlns:sn': SN }, 'sn:insufficient-resources')));
      suspended = true;
      log(`subscription ${id}: suspended`);
    } else if (tick === 6) {
      server.notify(sn('subscription-resumed'));
      suspended = false;
      log(`subscription ${id}: resumed`);
    } else if (!suspended) {
      server.notify(x('lab-event', { xmlns: EX }, x('sequence', String(tick))));
      log(`subscription ${id}: event ${tick}`);
    }
  }, ms);
  return () => clearInterval(timer);
}

// --- command line ------------------------------------------------------------------------

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    list: { type: 'boolean', short: 'l' },
    port: { type: 'string', short: 'p' },
    entries: { type: 'string' },
    interval: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const usage = 'usage: node scripts/defect-server.mjs <scenario> [--port N] [--entries N] [--interval S]\n       node scripts/defect-server.mjs --list';

if (opts.help) {
  console.log(usage);
  process.exit(0);
}

if (opts.list || positionals.length === 0) {
  const width = Math.max(...SCENARIOS.map((s) => s.name.length));
  for (const s of SCENARIOS) {
    console.log(`${s.name.padEnd(width)}  ${(s.rows.join(', ') || '-').padEnd(11)}  ${s.summary}`);
  }
  if (!opts.list) console.log(`\n${usage}`);
  process.exit(opts.list ? 0 : 2);
}

const scenario = SCENARIOS.find((s) => s.name === positionals[0]);
if (scenario === undefined || positionals.length > 1) {
  console.error(`unknown scenario "${positionals.join(' ')}": --list shows them`);
  process.exit(2);
}

const positive = (text, name, fallback) => {
  if (text === undefined) return fallback;
  const n = Number(text);
  if (!(Number.isInteger(n) && n > 0)) {
    console.error(`--${name} must be a positive integer`);
    process.exit(2);
  }
  return n;
};
const options = {
  port: positive(opts.port, 'port', DEFAULT_PORT),
  entries: positive(opts.entries, 'entries', 50000),
  interval: positive(opts.interval, 'interval', 5),
};

// --- SSH server ----------------------------------------------------------------------------

/**
 * An ed25519 host key that ssh2 can parse. ssh2's generateKeyPairSync now and
 * then returns a key its own parser rejects, so generate until one parses
 * (the same as the cli tests' generateKey()).
 */
function generateKey() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pair = utils.generateKeyPairSync('ed25519');
    if (!(utils.parseKey(pair.private) instanceof Error) && !(utils.parseKey(pair.public) instanceof Error)) return pair;
  }
  throw new Error('could not generate a parseable ed25519 key');
}

const hostKey = generateKey();
const fingerprint = (() => {
  const blob = utils.parseKey(hostKey.public).getPublicSSH();
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
})();

let connections = 0;
const stamp = () => new Date().toISOString().slice(11, 23);

const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
  const n = ++connections;
  const log = (message) => console.log(`${stamp()} [${n}] ${message}`);
  log('SSH connection');
  client.on('error', (err) => log(`SSH error: ${err.message}`));
  client.on('close', () => log('SSH connection closed'));
  client.on('authentication', (ctx) => {
    if (ctx.username === USERNAME && ctx.method === 'password' && ctx.password === PASSWORD) return ctx.accept();
    if (ctx.method !== 'none') log(`refused ${ctx.method} authentication for "${ctx.username}"`);
    ctx.reject(['password']);
  });
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('subsystem', (acceptSub, rejectSub, info) => {
        if (info.name !== 'netconf') {
          log(`refused subsystem "${info.name}"`);
          return rejectSub();
        }
        serveNetconf(acceptSub(), log);
      });
    });
  });
});

/** Run the scenario on one netconf channel. */
function serveNetconf(channel, log) {
  const state = { lastId: 0, stop: undefined, log };
  const handler = scenario.handler;
  const fake = new FakeServer({
    sessionId: connections,
    ...(scenario.capabilities !== undefined ? { capabilities: scenario.capabilities } : { capabilities: BASE_CAPS }),
    ...(scenario.hello === false ? { hello: false } : {}),
    // No handler: never reply (no-reply). FakeServer answers <close-session> itself.
    handler: (rpc, ctx) => {
      log(`rpc ${ctx.operation?.name ?? '(empty)'} message-id ${ctx.messageId ?? '(none)'}`);
      return handler === undefined ? undefined : handler(rpc, ctx, options, state);
    },
  });
  if (scenario.hello === false) log('hello withheld');

  let stop;
  void fake.clientHello.then((hello) => {
    const base11 = hello.child('capabilities')?.childrenNamed('capability').some((c) => c.text().trim() === BASE_1_1);
    log(`client hello: base ${base11 && fake.capabilities.has(BASE_1_1) ? '1.1 (chunked)' : '1.0 (end-of-message)'}`);
    stop = scenario.start?.(fake, log, options, state);
  });

  const fromClient = scenario.ignoreClose ? dropCloseSession(fake, (msg) => log(msg)) : (chunk) => fake.connection.write(chunk);
  channel.on('data', fromClient);

  const done = () => {
    stop?.();
    stop = undefined;
    for (const p of fake.problems.splice(0)) log(`server-side problem: ${p.message}`);
  };
  // What the fake server sends goes to the client; when it ends, so does the channel, and a dropped fake server drops it.
  fake.connection.receive({
    data: (chunk) => channel.write(chunk),
    end: () => channel.end(),
    close: () => {
      done();
      channel.destroy();
    },
  });
  channel.on('close', () => {
    done();
    fake.destroy();
  });
}

/**
 * A data listener for the SSH channel that forwards the client's messages to
 * FakeServer, except <close-session>, which it drops so that it is never
 * answered. It decodes the client's framing (end-of-message for the hello,
 * then chunked if both sides offer base:1.1) and frames each message again.
 */
function dropCloseSession(fake, log) {
  const decoder = new FrameDecoder();
  let chunkedFraming = false;
  let helloSeen = false;
  return (chunk) => {
    try {
      decoder.push(chunk);
      for (let msg = decoder.next(); msg !== undefined; msg = decoder.next()) {
        if (!helloSeen) {
          helloSeen = true;
          chunkedFraming = msg.includes(BASE_1_1) && fake.capabilities.has(BASE_1_1);
          fake.connection.write(encoder.encode(`${msg}]]>]]>`));
          if (chunkedFraming) decoder.setMode('chunked');
        } else if (/<(?:[\w.-]+:)?close-session\b/.test(msg)) {
          log('close-session received: not answering it');
        } else {
          fake.connection.write(encoder.encode(chunkedFraming ? chunked(msg) : `${msg}]]>]]>`));
        }
      }
    } catch (err) {
      log(`client framing problem: ${err.message}`);
      fake.destroy();
    }
  };
}

server.on('error', (err) => {
  console.error(`DEF: ${err.message}`);
  process.exit(1);
});
server.listen(options.port, '127.0.0.1', () => {
  console.log(`DEF scenario "${scenario.name}"${scenario.rows.length > 0 ? ` (rows ${scenario.rows.join(', ')})` : ''}`);
  console.log(`  ${scenario.summary}`);
  console.log(`  try: ${scenario.try}`);
  console.log(`listening on 127.0.0.1:${options.port}, user ${USERNAME} / ${PASSWORD}, host key ${fingerprint} (new each run)`);
  console.log('Ctrl-C to stop');
});

const shutdown = () => {
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
// A scenario that throws after its reply is under way must not take DEF down with it.
process.on('unhandledRejection', (err) => console.error(`${stamp()} scenario failed: ${err instanceof Error ? err.message : String(err)}`));
process.on('SIGTERM', shutdown);
