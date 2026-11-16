/**
 * Selecting the node a YANG path names from converted RFC 7951 JSON, as a
 * RESTCONF GET of that resource would return it (RFC 8040 §3.5.3, §4.3).
 */

import type { JsonValue } from '@node-net/yang/core';

type JsonObject = { [member: string]: JsonValue };

/** One step of a resolved path: its module and name, and the predicates that pick entries. */
export interface JsonStep {
  readonly moduleName: string;
  readonly name: string;
  readonly keys: readonly { readonly name: string; readonly value: string }[];
  readonly value?: string | undefined;
}

/**
 * The target of `steps` in `root`, as `{ 'module:name': value }`: a list's
 * (or leaf-list's) matching entries as an array, a container as an object, a
 * leaf as its value. `{}` when nothing matches.
 *
 * Predicates compare each key's JSON value by its text, or as a decimal
 * number, so `[mtu="1500"]` matches the number 1500 and `[ratio="1.50"]` the
 * decimal64 `"1.5"`. An entry that isn't in an array (a schema-less
 * subtree with a single entry) counts as a one-entry list.
 */
export function selectJson(root: JsonObject, steps: readonly JsonStep[]): JsonObject {
  if (steps.length === 0) return root;
  let current: { readonly obj: JsonObject; readonly module: string | undefined }[] = [{ obj: root, module: undefined }];
  let matched: JsonValue[] = [];
  let fromArray = false;
  for (const [i, step] of steps.entries()) {
    const last = i === steps.length - 1;
    const next: { obj: JsonObject; module: string }[] = [];
    matched = [];
    fromArray = false;
    const candidates: { readonly entry: JsonValue; readonly module: string }[] = [];
    for (const { obj, module } of current) {
      const value = obj[`${step.moduleName}:${step.name}`] ?? (module === step.moduleName ? obj[step.name] : undefined);
      if (value === undefined) continue;
      // An empty leaf's value is [null]: one value, not a list of entries.
      const isList = Array.isArray(value) && !isEmptyValue(value);
      if (isList) fromArray = true;
      for (const entry of isList ? value : [value]) candidates.push({ entry, module: step.moduleName });
    }
    // Exact matches first; only if there are none, string values that are the same decimal number.
    let chosen = candidates.filter((c) => matches(c.entry, step, false));
    if (chosen.length === 0) chosen = candidates.filter((c) => matches(c.entry, step, true));
    for (const { entry, module } of chosen) {
      if (last) matched.push(entry);
      else if (isObject(entry)) next.push({ obj: entry, module });
    }
    if (!last) {
      if (next.length === 0) return {};
      current = next;
    }
  }
  if (matched.length === 0) return {};
  const target = steps[steps.length - 1]!;
  const value = fromArray || matched.length > 1 ? matched : matched[0]!;
  return { [`${target.moduleName}:${target.name}`]: value };
}

function matches(entry: JsonValue, step: JsonStep, loose: boolean): boolean {
  if (step.value !== undefined) return same(entry, step.value, loose);
  if (step.keys.length === 0) return true;
  if (!isObject(entry)) return false;
  return step.keys.every((k) => {
    const v = entry[k.name];
    return v !== undefined && same(v, k.value, loose);
  });
}

/**
 * A value against a predicate's text. JSON holds canonical forms (decimal64
 * `"1.5"`, an integer `7`) while a path may say `1.50` or `07`, so a number
 * always compares as a decimal number. A string compares exactly, and as a
 * decimal number only when `loose` (no entry matched exactly): a string key
 * `"01"` never takes the place of `"1"`.
 */
function same(value: JsonValue, wanted: string, loose: boolean): boolean {
  const text = textOf(value);
  if (text === undefined) return false;
  if (text === wanted) return true;
  if (typeof value !== 'number' && !loose) return false;
  const a = canonicalDecimal(text);
  return a !== undefined && a === canonicalDecimal(wanted);
}

/** A decimal number's canonical text (no sign for positives, no leading or trailing zeros), or undefined if it isn't one. */
function canonicalDecimal(s: string): string | undefined {
  const m = /^\s*([+-]?)(\d+)(?:\.(\d+))?\s*$/.exec(s);
  if (m === null) return undefined;
  const int = m[2]!.replace(/^0+(?=\d)/, '');
  const frac = (m[3] ?? '').replace(/0+$/, '');
  const body = frac === '' ? int : `${int}.${frac}`;
  return m[1] === '-' && body !== '0' ? `-${body}` : body;
}

/** A scalar's text: strings as they are, numbers and booleans as JSON writes them, `[null]` (empty) as ''. */
function textOf(v: JsonValue): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isEmptyValue(v)) return '';
  return undefined;
}

/** The value of a YANG `empty` leaf, `[null]`. */
export function isEmptyValue(v: JsonValue): boolean {
  return Array.isArray(v) && v.length === 1 && v[0] === null;
}

function isObject(v: JsonValue): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
