/**
 * One error root (design §5.7): every error class any entry point exports is
 * a NetconfError with a code of its own. Table-driven from package.json's
 * exports, so a new entry is covered without touching this file.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NetconfError } from '../src/errors.js';
import { x } from '../src/xml/index.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, unknown> };

/** The source module behind each published entry. */
function sourceOf(entry: string): string {
  if (entry === '.') return '../src/index.ts';
  if (entry === './testing') return '../src/testing/index.ts';
  return `../src/${entry.slice(2)}.ts`;
}

const entries = Object.keys(pkg.exports).filter((e) => e !== './package.json');

type ErrorClass = (abstract new (...args: never[]) => Error) & { readonly name: string };

async function errorClasses(entry: string): Promise<[string, ErrorClass][]> {
  const mod = (await import(sourceOf(entry))) as Record<string, unknown>;
  return Object.entries(mod).filter(
    (e): e is [string, ErrorClass] => typeof e[1] === 'function' && (e[1] as { prototype?: unknown }).prototype instanceof Error,
  );
}

/** Constructor arguments for the classes whose first parameter isn't a message. */
const ARGS: Readonly<Record<string, readonly unknown[]>> = {
  RpcError: [[], x('rpc-reply')],
  BaseNotificationError: [x('netconf-session-end'), 'field', 'problem'],
  CapabilityError: [':candidate', 'commit'],
  TimeoutError: ['rpc', 1],
  TransactionError: ['edit', undefined],
  LockDeniedError: ['running', 1, undefined],
  PartialLockDeniedError: [1, 1, undefined],
  SubscriptionOverflowError: [1, 1],
};

/** A class's `code`, read from an instance: codes are instance fields. */
function codeOf(cls: ErrorClass): string {
  const Ctor = cls as unknown as new (...args: unknown[]) => { code?: unknown };
  return String(new Ctor(...(ARGS[cls.name] ?? ['message'])).code);
}

describe('the error surface', () => {
  it('lists the entries under test', () => {
    expect(entries).toContain('.');
    expect(entries).toContain('./core');
    expect(entries).not.toContain('./operations/transaction');
  });

  it.each(entries)('every error class exported from %s extends NetconfError', async (entry) => {
    const classes = await errorClasses(entry);
    for (const [name, cls] of classes) {
      expect(cls.prototype instanceof NetconfError || cls === NetconfError, `${entry}: ${name}`).toBe(true);
    }
  });

  it('gives every exported error class a code of its own', async () => {
    const byClass = new Map<ErrorClass, string>();
    for (const entry of entries) for (const [, cls] of await errorClasses(entry)) byClass.set(cls, codeOf(cls));
    const byCode = new Map<string, string[]>();
    for (const [cls, code] of byClass) byCode.set(code, [...(byCode.get(code) ?? []), cls.name]);
    const shared = [...byCode].filter(([, names]) => names.length > 1);
    expect(shared).toEqual([]);
    for (const code of byCode.keys()) expect(code).toMatch(/^ERR_NETCONF(_[A-Z_]+)?$/);
    // The YANG data error is @node-net/netconf's own, and present.
    expect(byCode.get('ERR_NETCONF_YANG_DATA')).toEqual(['YangDataError']);
  });
});
