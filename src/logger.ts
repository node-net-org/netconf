// Logging interface. A leaf module, like errors.ts, so every layer can log.

/**
 * Where the library logs, given as `connect({ logger })`. Every method is
 * optional, so `console`, a pino or winston adapter, or a partial object all
 * work. Nothing is logged unless a logger is supplied. See
 * [Logging and tracing](/guide/logging).
 */
export interface Logger {
  /** Every message sent and received, with its XML (redacted). */
  trace?(message: string, context?: Record<string, unknown>): void;
  /** Session events worth knowing when debugging, such as the session opening or the profile chosen. */
  debug?(message: string, context?: Record<string, unknown>): void;
  /** Informational messages; the library doesn't log at this level yet. */
  info?(message: string, context?: Record<string, unknown>): void;
  /** Something unexpected that didn't fail the call, such as a session `warning` or failed cleanup. */
  warn?(message: string, context?: Record<string, unknown>): void;
  /** An error the library can't report any other way, such as an event listener that threw. */
  error?(message: string, context?: Record<string, unknown>): void;
}

export const silentLogger: Logger = Object.freeze({});

/** Log levels, most verbose first. `silent` logs nothing. */
export const LOG_LEVELS = Object.freeze(['trace', 'debug', 'info', 'warn', 'error', 'silent'] as const);
/**
 * The least severe level a client passes to its logger; `'silent'` passes
 * nothing. See [Levels](/guide/logging#levels).
 */
export type LogLevel = (typeof LOG_LEVELS)[number];

const METHODS = ['trace', 'debug', 'info', 'warn', 'error'] as const;

/** Throw a TypeError unless `level` is one of {@link LOG_LEVELS}. */
export function checkLogLevel(level: unknown): asserts level is LogLevel {
  if (!(LOG_LEVELS as readonly unknown[]).includes(level)) {
    throw new TypeError(`Unknown log level ${JSON.stringify(level)}: expected one of ${LOG_LEVELS.join(', ')}`);
  }
}

/**
 * @internal A logger whose target and level can change while it is in use.
 *
 * `logger` is one object, handed to everything that logs, and changed in
 * place, never replaced, so references taken earlier follow every change. It
 * has a method only for the levels that are enabled and that the target
 * implements, so `if (logger.trace)` stays a free check: nothing is redacted
 * or formatted for a level nobody receives. A target method that throws is
 * ignored, so a broken logger never fails a request or the session.
 */
export class LogSwitch {
  readonly logger: Logger = {};
  private _target: Logger | undefined;
  private _level: LogLevel;

  constructor(target?: Logger, level: LogLevel = 'trace') {
    checkLogLevel(level);
    this._target = target;
    this._level = level;
    this.rebuild();
  }

  get target(): Logger | undefined {
    return this._target;
  }

  get level(): LogLevel {
    return this._level;
  }

  setTarget(target: Logger | undefined): void {
    this._target = target;
    this.rebuild();
  }

  setLevel(level: LogLevel): void {
    checkLogLevel(level);
    this._level = level;
    this.rebuild();
  }

  private rebuild(): void {
    const forwarder = this.logger as Record<string, unknown>;
    const target = this._target;
    const from = LOG_LEVELS.indexOf(this._level);
    METHODS.forEach((method, i) => {
      if (target !== undefined && i >= from && typeof target[method] === 'function') {
        // Pass on exactly the arguments given: console prints a missing context as `undefined`.
        forwarder[method] = (...args: [string, Record<string, unknown>?]): void => {
          try {
            target[method]!(...args);
          } catch {
            // A broken logger must not break the session, and can't be told it failed.
          }
        };
      } else {
        delete forwarder[method];
      }
    });
  }
}

/** Element local names whose content is secret. */
const SENSITIVE = /password|passphrase|secret|private-key|preshared|pre-shared|psk|community|key-string|cleartext|(?:^|-)token$|(?:^|-)key$/i;
/** Names the pattern above would catch that hold nothing secret. */
const NOT_SENSITIVE = /^public-key$/i;
/** `scheme://user:password@` in a URL: the userinfo is replaced. */
const URL_USERINFO = /\b([a-z][a-z\d+.-]*:\/\/)[^\s/?#@<>]+@/gi;

const isSensitive = (local: string): boolean => SENSITIVE.test(local) && !NOT_SENSITIVE.test(local);

/** The local name of the element a tag opens or closes (`<a:b x="1">` → `b`). */
function localNameOf(tag: string): string {
  const start = tag[1] === '/' ? 2 : 1;
  let end = start;
  while (end < tag.length && !/[\s/>]/.test(tag[end]!)) end++;
  const qname = tag.slice(start, end);
  return qname.slice(qname.lastIndexOf(':') + 1);
}

/** Index of the `>` that ends the tag starting at `from`, skipping quoted attribute values; -1 if none. */
function tagEnd(xml: string, from: number): number {
  let quote = '';
  for (let i = from + 1; i < xml.length; i++) {
    const c = xml[i];
    if (quote !== '') {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

/**
 * Default redaction for logged XML. All text inside an element whose local
 * name looks secret (such as `password`, `authentication-key`, `community`
 * or `token`; not `public-key`) is replaced with `***`, CDATA included and at
 * any depth. Elsewhere, URL userinfo (`ftp://user:pw@host`) becomes
 * `ftp://***@host`. Everything else is kept exactly as it was.
 *
 * It scans the text rather than parsing it, so it never throws: a malformed
 * message, which is often the one worth tracing, is still redacted. Message
 * bodies are only logged at trace level, and only through this function (or
 * one the caller supplies).
 */
export function redactXml(xml: string): string {
  /** Open elements, innermost last, and whether each is inside a secret. */
  const open: { name: string; secret: boolean }[] = [];
  /** How many of each name are open, so an unmatched close tag is ignored in O(1). */
  const counts = new Map<string, number>();
  const secret = (): boolean => open.at(-1)?.secret === true;
  const text = (t: string): string => (secret() ? (t.trim() === '' ? t : '***') : t.replace(URL_USERINFO, '$1***@'));
  const out: string[] = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      out.push(text(xml.slice(i)));
      break;
    }
    if (lt > i) out.push(text(xml.slice(i, lt)));
    if (xml.startsWith('<![CDATA[', lt)) {
      const close = xml.indexOf(']]>', lt + 9);
      const content = xml.slice(lt + 9, close === -1 ? xml.length : close);
      out.push('<![CDATA[', text(content), close === -1 ? '' : ']]>');
      i = close === -1 ? xml.length : close + 3;
      continue;
    }
    // Comments, processing instructions and declarations are copied as they are.
    const special = xml.startsWith('<!--', lt) ? '-->' : xml.startsWith('<?', lt) ? '?>' : xml.startsWith('<!', lt) ? '>' : undefined;
    if (special !== undefined) {
      const close = xml.indexOf(special, lt + 2);
      const stop = close === -1 ? xml.length : close + special.length;
      out.push(xml.slice(lt, stop));
      i = stop;
      continue;
    }
    const gt = tagEnd(xml, lt);
    const stop = gt === -1 ? xml.length : gt + 1;
    const tag = xml.slice(lt, stop);
    out.push(tag);
    i = stop;
    const name = localNameOf(tag);
    if (tag[1] === '/') {
      if ((counts.get(name) ?? 0) === 0) continue;
      for (let top = open.pop(); top !== undefined; top = open.pop()) {
        counts.set(top.name, counts.get(top.name)! - 1);
        if (top.name === name) break;
      }
    } else if (!tag.endsWith('/>') && gt !== -1) {
      open.push({ name, secret: secret() || isSensitive(name) });
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return out.join('');
}
