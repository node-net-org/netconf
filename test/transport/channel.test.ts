/**
 * The framed message channel, used directly through the public API (TRANSPORT-09):
 * no Session, so the hello and message-ids are the caller's job.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BASE_1_0,
  BASE_1_1,
  DEFAULT_MAX_MESSAGE_BYTES,
  FramingError,
  type NetconfError,
  NETCONF_NS,
  openChannel,
  SessionClosedError,
  type Connection,
  type FramingMode,
  type MessageChannel,
} from '../../src/index.js';
import { FakeServer } from '../../src/testing/index.js';

const hello = (caps: readonly string[]): string =>
  `<hello xmlns="${NETCONF_NS}"><capabilities>${caps.map((c) => `<capability>${c}</capability>`).join('')}</capabilities></hello>`;
const rpc = (id: string, body = '<get/>'): string => `<rpc xmlns="${NETCONF_NS}" message-id="${id}">${body}</rpc>`;

/** Open a channel on a fake server's connection, recording what arrives and how it ends. */
async function open(server = new FakeServer(), options?: { maxMessageBytes?: number }) {
  const connection: Connection = await server.transport()(new AbortController().signal);
  const writes = vi.spyOn(connection, 'write');
  const messages: string[] = [];
  const ends: NetconfError[] = [];
  const channel: MessageChannel = openChannel(
    connection,
    { message: (text) => messages.push(text), end: (reason) => ends.push(reason) },
    options,
  );
  return { server, channel, messages, ends, writes };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
const send = (channel: MessageChannel, text: string): void => channel.write(channel.encode(text));

describe('the framed message channel (public API)', () => {
  it('is exported with its types and default size limit', () => {
    expect(typeof openChannel).toBe('function');
    expect(DEFAULT_MAX_MESSAGE_BYTES).toBe(64 * 1024 * 1024);
    const mode: FramingMode = 'eom';
    expect(mode).toBe('eom');
  });

  it('sends nothing until the caller writes', async () => {
    const { channel, writes, messages } = await open();
    await tick();
    expect(messages).toHaveLength(1); // the server's hello arrived
    expect(writes).not.toHaveBeenCalled();
    send(channel, hello([BASE_1_0]));
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('starts in end-of-message framing and delivers each whole message, in order', async () => {
    const { server, channel, messages } = await open(new FakeServer({ capabilities: [BASE_1_0] }));
    expect(channel.framing).toBe('eom');
    await tick();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/<hello[\s>]/);

    send(channel, hello([BASE_1_0]));
    await server.clientHello;
    send(channel, rpc('7'));
    send(channel, rpc('8'));
    await tick();
    expect(server.requests.map((r) => r.attr('message-id'))).toEqual(['7', '8']);
    expect(messages.slice(1).map((m) => /message-id="(\d+)"/.exec(m)?.[1])).toEqual(['7', '8']);
  });

  it('delivers a message split across many writes, and several messages in one write, whole', async () => {
    const { server, messages } = await open(new FakeServer({ hello: false }));
    const a = rpc('1').replace('<rpc ', '<rpc-reply ').replace('</rpc>', '</rpc-reply>');
    for (const ch of `${a}]]>]]>`) server.sendRaw(ch);
    server.sendRaw(`${a}]]>]]>${a}]]>]]>`);
    await tick();
    expect(messages).toEqual([a, a, a]);
  });

  it('useChunkedFraming() switches both directions from the next message', async () => {
    const { server, channel, messages } = await open();
    send(channel, hello([BASE_1_0, BASE_1_1]));
    await server.clientHello;
    expect(server.version).toBe('1.1');

    channel.useChunkedFraming();
    expect(channel.framing).toBe('chunked');
    expect(new TextDecoder().decode(channel.encode('<x/>'))).toBe('\n#4\n<x/>\n##\n');
    send(channel, rpc('9'));
    await tick();
    expect(server.requests.at(-1)?.attr('message-id')).toBe('9');
    expect(messages.at(-1)).toMatch(/message-id="9"/); // the chunked reply was decoded
  });

  it('encode() refuses ]]>]]> in end-of-message framing, before anything is written', async () => {
    const { channel, writes } = await open();
    expect(() => channel.encode(`<x>]]>]]></x>`)).toThrow(FramingError);
    expect(writes).not.toHaveBeenCalled();
  });

  it('ends the channel with a FramingError when a message is larger than maxMessageBytes', async () => {
    const { server, ends, messages } = await open(new FakeServer({ hello: false }), { maxMessageBytes: 100 });
    server.sendRaw(`<big>${'x'.repeat(200)}</big>]]>]]>`);
    await tick();
    expect(messages).toEqual([]);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toBeInstanceOf(FramingError);
  });

  it('calls end exactly once, with a typed error, when the server closes the connection', async () => {
    const { server, ends } = await open();
    server.end();
    server.destroy();
    await tick();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toBeInstanceOf(SessionClosedError);
  });

  it('calls end with a FramingError when the framing breaks', async () => {
    const { server, channel, ends } = await open();
    send(channel, hello([BASE_1_0, BASE_1_1]));
    await server.clientHello;
    channel.useChunkedFraming();
    server.sendRaw('\n#zz\n');
    await tick();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toBeInstanceOf(FramingError);
  });

  it('never calls end or message after destroy()', async () => {
    const { server, channel, ends, messages } = await open(new FakeServer({ hello: false }));
    channel.destroy();
    server.sendRaw('<late/>]]>]]>');
    server.destroy();
    await tick();
    expect(messages).toEqual([]);
    expect(ends).toEqual([]);
  });

  it('close() closes the connection and never calls end', async () => {
    const { channel, ends } = await open();
    await channel.close();
    await channel.close(); // idempotent
    await tick();
    expect(ends).toEqual([]);
  });
});
