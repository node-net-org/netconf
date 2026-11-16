/**
 * Named paths with parameters (design §6.4).
 *
 * A device profile's `paths` give names to YANG paths. A path may hold
 * `{{param}}` placeholders, which the caller fills in:
 *
 *   "ifDescription": "/ietf-interfaces:interfaces/interface[name={{ifName}}]/description"
 *
 *   @ifDescription(ifName=eth0)     named
 *   @ifDescription(eth0)            positional: in the order the placeholders first appear
 *   @ifDescription                  every interface's description (a read only)
 *   @interface(eth0)/description    more of the path after the reference
 *
 * Where a placeholder sits decides how its value is written and whether it may be left out:
 *
 * - The whole value of a predicate, `[name={{p}}]` or `[name="{{p}}"]`: the
 *   value is quoted as needed. A read may leave it out, which drops the
 *   predicate, so the path selects every entry. Changes need every parameter,
 *   since an edit without its list keys isn't the edit that was meant.
 * - Part of a quoted value, `[port-id="1/1/{{port}}"]`: the value goes in as
 *   it is, and may not hold that quote.
 * - Anywhere else, such as a step's name: the value must be a YANG identifier
 *   part (letters, digits, `_`, `-`, `.`).
 *
 * A parameter used anywhere but as a whole predicate value must always be given.
 */

import { PathError, parsePath } from './path.js';

/** A `@name` or `@name(args)` reference, as parsed. */
export interface NamedPathCall {
  readonly name: string;
  /** Values given by position, in order. */
  readonly positional: readonly string[];
  /** Values given as `param=value`. */
  readonly named: ReadonlyMap<string, string>;
  /** The rest of the path after the reference, `/description` in `@interface(eth0)/description`; `''` if none. */
  readonly suffix: string;
}

type Placement = 'predicate' | 'quoted-part' | 'name';

interface Placeholder {
  readonly param: string;
  /** The placeholder's own span in the template, `{{param}}` including the braces. */
  readonly start: number;
  readonly end: number;
  readonly placement: Placement;
  /** For `predicate`: the quote around the placeholder, if the template wrote one. */
  readonly quote?: '"' | "'";
  /** For `predicate`: the whole predicate's span, `[`…`]`, dropped when the parameter is left out. */
  readonly predicate?: { readonly start: number; readonly end: number };
  /** For `quoted-part`: the quote the value sits in. */
  readonly within?: '"' | "'";
}

/** A named path's template, parsed and checked. */
export interface NamedPathTemplate {
  /** The template as written, with its `{{param}}` placeholders. */
  readonly path: string;
  /** Parameter names, in the order they first appear. */
  readonly params: readonly string[];
  /** The parameters a read may leave out: every use is a whole predicate value. */
  readonly optional: ReadonlySet<string>;
  /** @internal */
  readonly placeholders: readonly Placeholder[];
}

/** How expansion treats a parameter that wasn't given. */
export type MissingParams = 'drop' | 'error';

const PARAM = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME_VALUE = /^[A-Za-z0-9_.-]+$/;

/**
 * Parse a named path's template: find its placeholders, decide where each
 * sits, and check the path is valid with sample values.
 * @throws PathError for a malformed placeholder or path.
 */
export function compileNamedPath(path: string): NamedPathTemplate {
  const fail = (at: number, msg: string): never => {
    throw new PathError(`Invalid path ${JSON.stringify(path)} at position ${at}: ${msg}`);
  };
  const placeholders: Placeholder[] = [];
  // The predicate being read: where it starts, where its value starts, and a whole-value placeholder in it.
  let predicateStart = -1;
  let afterEquals = -1;
  let pendingPredicate: { param: string; start: number; end: number; quote?: '"' | "'" } | undefined;
  let quote: '"' | "'" | undefined;
  let quoteStart = -1;
  let quoted: Placeholder[] = [];

  const placeholderAt = (i: number): { param: string; end: number } => {
    const close = path.indexOf('}}', i + 2);
    if (close === -1) return fail(i, 'unterminated {{');
    const param = path.slice(i + 2, close).trim();
    if (!PARAM.test(param)) fail(i, `${JSON.stringify(param)} isn't a valid parameter name`);
    return { param, end: close + 2 };
  };

  let i = 0;
  while (i < path.length) {
    const ch = path[i]!;
    if (quote !== undefined) {
      if (ch === quote) {
        // The quoted value is complete: a lone placeholder filling it is a whole predicate value.
        const content = path.slice(quoteStart + 1, i);
        const only = quoted.length === 1 && content === path.slice(quoted[0]!.start, quoted[0]!.end);
        if (only && afterEquals !== -1 && path.slice(afterEquals, quoteStart).trim() === '') {
          pendingPredicate = { param: quoted[0]!.param, start: quoted[0]!.start, end: quoted[0]!.end, quote };
        } else {
          placeholders.push(...quoted);
        }
        quoted = [];
        quote = undefined;
        i++;
        continue;
      }
      if (path.startsWith('{{', i)) {
        const { param, end } = placeholderAt(i);
        quoted.push({ param, start: i, end, placement: 'quoted-part', within: quote });
        i = end;
        continue;
      }
      i++;
      continue;
    }
    if (predicateStart !== -1) {
      if (ch === '"' || ch === "'") {
        quote = ch;
        quoteStart = i;
        i++;
        continue;
      }
      if (ch === '=' && afterEquals === -1) {
        afterEquals = i + 1;
        i++;
        continue;
      }
      if (ch === ']') {
        if (pendingPredicate !== undefined) {
          placeholders.push({
            param: pendingPredicate.param,
            start: pendingPredicate.start,
            end: pendingPredicate.end,
            placement: 'predicate',
            ...(pendingPredicate.quote !== undefined ? { quote: pendingPredicate.quote } : {}),
            predicate: { start: predicateStart, end: i + 1 },
          });
        }
        predicateStart = -1;
        afterEquals = -1;
        pendingPredicate = undefined;
        i++;
        continue;
      }
      if (path.startsWith('{{', i)) {
        const { param, end } = placeholderAt(i);
        const before = afterEquals === -1 ? undefined : path.slice(afterEquals, i).trim();
        const closing = path.indexOf(']', end);
        if (closing === -1) fail(predicateStart, "expected ']'");
        const after = path.slice(end, closing).trim();
        if (before === '' && after === '') {
          pendingPredicate = { param, start: i, end };
        } else if (afterEquals !== -1) {
          fail(i, `write {{${param}}} in a predicate value as the whole value, or inside quotes`);
        } else {
          placeholders.push({ param, start: i, end, placement: 'name' });
        }
        i = end;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '[') {
      predicateStart = i;
      i++;
      continue;
    }
    if (path.startsWith('{{', i)) {
      const { param, end } = placeholderAt(i);
      placeholders.push({ param, start: i, end, placement: 'name' });
      i = end;
      continue;
    }
    i++;
  }
  if (quote !== undefined) fail(quoteStart, 'unterminated quoted value');
  if (predicateStart !== -1) fail(predicateStart, "expected ']'");

  placeholders.sort((a, b) => a.start - b.start);
  const params = [...new Set(placeholders.map((p) => p.param))];
  const optional = new Set(params.filter((p) => placeholders.every((h) => h.param !== p || h.placement === 'predicate')));
  const template: NamedPathTemplate = { path, params, optional, placeholders };
  // Check the path itself, with every parameter given a sample value.
  parsePath(substitute(template, new Map(params.map((p) => [p, 'x'])), 'error', path));
  return template;
}

/**
 * Parse `@name` or `@name(args)`, optionally followed by more of the path:
 * `@interface(eth0)/description`. Arguments are separated by commas; each is
 * `value` (by position, before any named one) or `param=value`. A value is
 * quoted with `"` or `'` when it holds a comma, a parenthesis, `=`, a quote or
 * spaces at either end.
 * @throws PathError for malformed arguments, or a suffix that isn't a path.
 */
export function parseNamedPathCall(given: string): NamedPathCall {
  if (!given.startsWith('@')) throw new PathError(`${JSON.stringify(given)} isn't a named path: it must start with @`);
  const fail = (at: number, msg: string): never => {
    throw new PathError(`Invalid named path ${JSON.stringify(given)} at position ${at}: ${msg}`);
  };
  const nameEnd = /[(/]|$/.exec(given.slice(1))!.index + 1;
  const name = given.slice(1, nameEnd);
  if (name === '') fail(1, given[nameEnd] === '(' ? 'expected a name before (' : 'expected a name after @');
  const positional: string[] = [];
  const named = new Map<string, string>();
  const call = (suffixAt: number): NamedPathCall => {
    const suffix = given.slice(suffixAt);
    if (suffix !== '' && !suffix.startsWith('/')) fail(suffixAt, "expected '/' or the end after ')'");
    // The suffix's own syntax; the expanded whole is resolved when used.
    if (suffix !== '') parsePath(suffix, { continues: true });
    return { name, positional, named, suffix };
  };
  if (given[nameEnd] !== '(') return call(nameEnd);

  const open = nameEnd;
  const body = given.slice(open + 1);
  let i = 0;
  const at = (): number => open + 1 + i;
  const skipWs = (): void => {
    while (i < body.length && /\s/.test(body[i]!)) i++;
  };
  const value = (): string => {
    skipWs();
    const q = body[i];
    if (q === '"' || q === "'") {
      const end = body.indexOf(q, i + 1);
      if (end === -1) fail(at(), `unterminated ${q}`);
      const v = body.slice(i + 1, end);
      i = end + 1;
      skipWs();
      return v;
    }
    const startAt = i;
    while (i < body.length && !',()"\''.includes(body[i]!)) i++;
    const v = body.slice(startAt, i).trim();
    if (v === '') fail(open + 1 + startAt, 'expected a value');
    if (body[i] === '"' || body[i] === "'" || body[i] === '(') fail(at(), `quote a value that holds ${body[i]}`);
    return v;
  };
  skipWs();
  if (body[i] === ')') return call(at() + 1);
  for (;;) {
    skipWs();
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(body.slice(i));
    if (m !== null) {
      const param = m[1]!;
      if (named.has(param)) fail(at(), `${param} given twice`);
      i += m[0].length;
      named.set(param, value());
    } else {
      if (named.size > 0) fail(at(), 'values given by position must come before named ones');
      positional.push(value());
    }
    if (i >= body.length) fail(at(), "expected ')' at the end of the arguments");
    if (body[i] === ')') return call(at() + 1);
    if (body[i] !== ',') fail(at(), "expected ',' or ')'");
    i++;
  }
}

/**
 * Fill in a named path's parameters from a call.
 * @param missing `'drop'` drops the predicate of a whole-value parameter left
 *   out (reads); `'error'` needs every parameter (changes).
 * @throws PathError for an unknown or missing parameter, or a value that can't go where its placeholder is.
 */
export function expandNamedPath(template: NamedPathTemplate, call: NamedPathCall, missing: MissingParams): string {
  const label = `@${call.name}`;
  const usage = template.params.length === 0 ? 'takes no parameters' : `takes ${template.params.join(', ')}`;
  if (call.positional.length > template.params.length) {
    throw new PathError(`${label} ${usage}, but ${call.positional.length} values were given`);
  }
  const values = new Map<string, string>();
  call.positional.forEach((v, i) => values.set(template.params[i]!, v));
  for (const [param, v] of call.named) {
    if (!template.params.includes(param)) throw new PathError(`${label} has no parameter ${param} (it ${usage})`);
    if (values.has(param)) throw new PathError(`${label}: ${param} given both by position and by name`);
    values.set(param, v);
  }
  const absent = template.params.filter((p) => !values.has(p));
  const required = missing === 'error' ? absent : absent.filter((p) => !template.optional.has(p));
  if (required.length > 0) {
    const why =
      missing === 'error'
        ? 'a change must name every list entry it edits'
        : 'each is used outside a whole predicate value, so it can\'t be left out';
    throw new PathError(`${label} needs ${required.join(', ')}: ${why}`);
  }
  return substitute(template, values, missing, label) + call.suffix;
}

/**
 * Write a named-path reference for `read()`, `set()` and the rest, quoting
 * values as needed: `namedPath('ifDescription', { ifName: 'eth0' })` gives
 * `@ifDescription(ifName="eth0")`. A leading `@` on the name is accepted
 * and dropped, so `namedPath('@ifDescription', …)` gives the same.
 * @throws PathError if a value holds both kinds of quote.
 */
export function namedPath(name: string, params: Readonly<Record<string, string | number>> = {}): string {
  if (name.startsWith('@')) name = name.slice(1);
  const args = Object.entries(params).map(([k, v]) => {
    if (!PARAM.test(k)) throw new PathError(`${JSON.stringify(k)} isn't a valid parameter name`);
    return `${k}=${quoteValue(String(v), `parameter ${k}`)}`;
  });
  return args.length === 0 ? `@${name}` : `@${name}(${args.join(',')})`;
}

function substitute(template: NamedPathTemplate, values: ReadonlyMap<string, string>, missing: MissingParams, label: string): string {
  const { path, placeholders } = template;
  let out = '';
  let at = 0;
  for (const h of placeholders) {
    const v = values.get(h.param);
    if (h.placement === 'predicate') {
      if (v === undefined) {
        // Only reads get here ('drop'): leave the predicate out.
        if (missing !== 'drop') throw new PathError(`${label} needs ${h.param}`);
        out += path.slice(at, h.predicate!.start);
        at = h.predicate!.end;
        continue;
      }
      if (h.quote !== undefined) {
        if (v.includes(h.quote)) throw new PathError(`${label}: the value of ${h.param} can't hold ${h.quote}, the quote around it in the path`);
        out += path.slice(at, h.start) + v;
      } else {
        out += path.slice(at, h.start) + quoteValue(v, `the value of ${h.param}`, label);
      }
    } else if (h.placement === 'quoted-part') {
      if (v!.includes(h.within!)) throw new PathError(`${label}: the value of ${h.param} can't hold ${h.within}, the quote around it in the path`);
      out += path.slice(at, h.start) + v!;
    } else {
      if (!NAME_VALUE.test(v!)) {
        throw new PathError(`${label}: the value of ${h.param} (${JSON.stringify(v)}) must be letters, digits, '_', '-' or '.', since it goes into a name in the path`);
      }
      out += path.slice(at, h.start) + v!;
    }
    at = h.end;
  }
  return out + path.slice(at);
}

/** `"value"`, or `'value'` if it holds `"`. */
function quoteValue(v: string, what: string, label?: string): string {
  if (!v.includes('"')) return `"${v}"`;
  if (!v.includes("'")) return `'${v}'`;
  throw new PathError(`${label === undefined ? '' : `${label}: `}${what} holds both ' and ", which a path can't express`);
}
