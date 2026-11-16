/**
 * MESSAGES-20: changing the logger and log level on an open client.
 * MESSAGES-21: the session's `message` event.
 * Against the fake server.
 */
import { describe, expect, it, vi } from 'vitest';
import { BASE_1_0, BASE_1_1, connect, LOG_LEVELS, openSession, x, type ConnectOptions, type Logger, type NetconfClient, type SessionMessage } from '../src/index.js';
import { LogSwitch } from '../src/logger.js';
import { FakeServer } from '../src/testing/index.js';

const SECRET = x('user', { xmlns: 'urn:u' }, x('name', 'admin'), x('password', 'hunter2'));

async function open(options: Partial<ConnectOptions> = {}): Promise<{ fake: FakeServer; client: NetconfClient }> {
  const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1, 'urn:ietf:params:netconf:capability:writable-running:1.0'], handler: () => ({ data: [] }) });
  const client = await connect({ transport: fake.transport(), ...options });
  return { fake, client };
}

/** A logger that records `level message` for every call, and the XML of trace calls. */
function recorder(): { logger: Required<Logger>; lines: string[]; xml: string[] } {
  const lines: string[] = [];
  const xml: string[] = [];
  const at = (level: string) => (message: string, context?: Record<string, unknown>) => {
    lines.push(`${level} ${message}`);
    if (level === 'trace' && typeof context?.['xml'] === 'string') xml.push(context['xml']);
  };
  return { logger: { trace: at('trace'), debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, lines, xml };
}

describe('change the logger and log level on an open client (MESSAGES-20)', () => {
  it('AC1: levels run trace, debug, info, warn, error, silent; a level passes itself and above', () => {
    expect(LOG_LEVELS).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'silent']);
    const { logger } = recorder();
    const sw = new LogSwitch(logger);
    const has = (): string[] => Object.keys(sw.logger).sort();
    expect(has()).toEqual(['debug', 'error', 'info', 'trace', 'warn']);
    sw.setLevel('info');
    expect(has()).toEqual(['error', 'info', 'warn']);
    sw.setLevel('error');
    expect(has()).toEqual(['error']);
    sw.setLevel('silent');
    expect(has()).toEqual([]);
  });

  it('AC2: logLevel defaults to trace, and connect() honours it', async () => {
    const a = recorder();
    const { client } = await open({ logger: a.logger });
    expect(client.logLevel).toBe('trace');
    expect(a.xml.length).toBeGreaterThan(0); // the hellos were traced
    await client.close();

    const b = recorder();
    const { client: quiet } = await open({ logger: b.logger, logLevel: 'warn' });
    await quiet.ops.get();
    expect(b.lines.filter((l) => l.startsWith('trace') || l.startsWith('debug'))).toEqual([]);
    expect(quiet.logLevel).toBe('warn');
    await quiet.close();
  });

  it('AC3: setLogger() switches logging on an open client, including for references taken earlier', async () => {
    const { client } = await open();
    const held = client.session.logger; // what extensions and operations already hold
    await client.ops.get();
    const r = recorder();
    client.setLogger(r.logger);
    expect(client.logger).toBe(r.logger);
    await client.ops.get();
    expect(r.xml.some((m) => m.includes('<get'))).toBe(true);
    held.warn?.('from an earlier reference');
    expect(r.lines).toContain('warn from an earlier reference');

    client.setLogger(undefined);
    expect(client.logger).toBeUndefined();
    const before = r.lines.length;
    await client.ops.get();
    expect(r.lines.length).toBe(before);
    await client.close();
  });

  it('AC4: setLogLevel() takes effect at once; an unknown level throws and changes nothing', async () => {
    const r = recorder();
    const { client } = await open({ logger: r.logger, logLevel: 'warn' });
    await client.ops.get();
    expect(r.xml).toEqual([]);
    client.setLogLevel('trace');
    await client.ops.get();
    expect(r.xml.some((m) => m.includes('<get'))).toBe(true);
    expect(() => client.setLogLevel('loud' as never)).toThrow(TypeError);
    expect(client.logLevel).toBe('trace');
    await expect(open({ logLevel: 'loud' as never })).rejects.toThrow(TypeError);
    await client.close();
  });

  it('AC4: openSession() with an unknown level rejects and closes the connection', async () => {
    const fake = new FakeServer({ capabilities: [BASE_1_0, BASE_1_1] });
    const connection = await fake.transport()(AbortSignal.timeout(5_000));
    const close = vi.spyOn(connection, 'close');
    await expect(openSession(connection, { logLevel: 'loud' as never })).rejects.toThrow(TypeError);
    expect(close).toHaveBeenCalled();
  });

  it('AC5: logger and logLevel report what was set', async () => {
    const r = recorder();
    const { client } = await open({ logger: r.logger, logLevel: 'debug' });
    expect(client.logger).toBe(r.logger);
    expect(client.logger).not.toBe(client.session.logger);
    expect(client.logLevel).toBe('debug');
    await client.close();
  });

  it('AC6: with tracing off, message bodies are not redacted', async () => {
    const redact = vi.fn((xml: string) => xml);
    const r = recorder();
    const { client } = await open({ logger: r.logger, logLevel: 'debug', redact });
    await client.ops.editConfig({ target: 'running', config: SECRET });
    expect(redact).not.toHaveBeenCalled();
    expect('trace' in client.session.logger).toBe(false);
    client.setLogLevel('trace');
    await client.ops.get();
    expect(redact).toHaveBeenCalled();
    await client.close();
  });

  it('AC7: a logger that throws does not fail the request or the session', async () => {
    const boom = (): never => {
      throw new Error('logger broke');
    };
    const { client } = await open({ logger: { trace: boom, debug: boom, warn: boom, error: boom } });
    await expect(client.ops.get()).resolves.toBeDefined();
    expect(client.session.state).toBe('open');
    await client.close();
  });

  it('AC7: forwards exactly the arguments given, and calls the target as a method', () => {
    const calls: unknown[][] = [];
    const target = {
      prefix: 'p',
      info(this: { prefix: string }, ...args: unknown[]) {
        calls.push([this.prefix, ...args]);
      },
    };
    const sw = new LogSwitch(target);
    sw.logger.info?.('no context');
    sw.logger.info?.('with', { a: 1 });
    expect(calls).toEqual([['p', 'no context'], ['p', 'with', { a: 1 }]]);
  });

  it('setLogger() never changes the logger objects it is given', async () => {
    const first = recorder();
    const { client } = await open({ logger: first.logger, logLevel: 'error' });
    client.setLogger(recorder().logger);
    expect(Object.keys(first.logger).sort()).toEqual(['debug', 'error', 'info', 'trace', 'warn']);
    await client.close();
  });
});

describe('watch the NETCONF messages a session sends and receives (MESSAGES-21)', () => {
  it('AC1, AC4: emits each message sent and received, in order, with direction and xml', async () => {
    const { client } = await open();
    const seen: SessionMessage[] = [];
    client.session.on('message', (m) => seen.push(m));
    await client.ops.get();
    expect(seen.map((m) => m.direction)).toEqual(['send', 'receive']);
    expect(seen[0]!.xml).toMatch(/<rpc [^>]*message-id="1"[^>]*><get\/?>/);
    expect(seen[1]!.xml).toContain('<rpc-reply');
    await client.close();
  });

  it('AC2: the xml is redacted, by default and with a custom redact', async () => {
    const { client } = await open();
    const seen: string[] = [];
    client.session.on('message', (m) => seen.push(m.xml));
    await client.ops.editConfig({ target: 'running', config: SECRET });
    expect(seen[0]).toContain('<password>***</password>');
    expect(seen.join('')).not.toContain('hunter2');
    await client.close();

    const { client: custom } = await open({ redact: (xml) => xml.replace('admin', 'REDACTED') });
    const out: string[] = [];
    custom.session.on('message', (m) => out.push(m.xml));
    await custom.ops.editConfig({ target: 'running', config: SECRET });
    expect(out[0]).toContain('REDACTED');
    await custom.close();
  });

  it('AC3: a listener receives only what passes while it is attached', async () => {
    const { client } = await open();
    await client.ops.get();
    const seen: SessionMessage[] = [];
    const off = client.session.on('message', (m) => seen.push(m));
    await client.ops.get();
    off();
    await client.ops.get();
    expect(seen).toHaveLength(2);
    await client.close();
  });

  it('AC4: messages flow whatever the logger or level', async () => {
    const { client } = await open({ logger: recorder().logger, logLevel: 'silent' });
    const seen: SessionMessage[] = [];
    client.session.on('message', (m) => seen.push(m));
    await client.ops.get();
    expect(seen).toHaveLength(2);
    await client.close();
  });

  it('AC5: with no listener and no tracing, messages are not redacted', async () => {
    const redact = vi.fn((xml: string) => xml);
    const { client } = await open({ redact });
    await client.ops.get();
    expect(redact).not.toHaveBeenCalled();
    const off = client.session.on('message', () => undefined);
    await client.ops.get();
    expect(redact).toHaveBeenCalledTimes(2);
    off();
    await client.ops.get();
    expect(redact).toHaveBeenCalledTimes(2);
    await client.close();
  });

  it('AC5: with both tracing and a listener, each message is redacted once', async () => {
    const redact = vi.fn((xml: string) => xml);
    const { client } = await open({ logger: recorder().logger, redact });
    redact.mockClear();
    client.session.on('message', () => undefined);
    await client.ops.get();
    expect(redact).toHaveBeenCalledTimes(2);
    await client.close();
  });

  it('AC6: a throwing listener does not stop others or affect the session', async () => {
    const r = recorder();
    const { client } = await open({ logger: r.logger, logLevel: 'error' });
    const seen: SessionMessage[] = [];
    client.session.on('message', () => {
      throw new Error('listener broke');
    });
    client.session.on('message', (m) => seen.push(m));
    await expect(client.ops.get()).resolves.toBeDefined();
    expect(seen).toHaveLength(2);
    expect(r.lines.some((l) => l.startsWith("error A 'message' listener threw"))).toBe(true);
    expect(client.session.state).toBe('open');
    await client.close();
  });
});
