/**
 * Session quirks (design §7): known ways servers deviate from RFC 6241 in the
 * messages layer. Each is a named switch implemented and tested here; a
 * device profile can only turn switches on.
 */

import { XmlElement } from '../xml/index.js';

/**
 * Switches for known ways a server deviates from RFC 6241 in the messages
 * layer, usually set by a device profile. See [Session quirks](/profiles/quirks#session-quirks).
 */
export interface SessionQuirks {
  /** Most RPCs in flight at once. 1 for servers that mishandle pipelined requests. */
  readonly maxInFlight?: number;
  /** Advertise only base:1.0, for servers whose chunked framing is broken. Applies before the hello, so it needs an explicit profile. */
  readonly forceBaseVersion?: '1.0';
  /**
   * An `<rpc-reply>` without a message-id:
   * - `'strict'` (default): match it only if it carries errors and exactly one RPC is pending.
   * - `'oldest'`: match it to the oldest pending RPC.
   */
  readonly replyWithoutMessageId?: 'strict' | 'oldest';
  /** Milliseconds to wait for the `<close-session>` reply. */
  readonly closeTimeout?: number;
  /**
   * Characters that XML 1.0 does not allow in a received message:
   * - `'reject'` (default): the message is malformed XML, and the session closes.
   * - `'strip'`: remove them before parsing, for servers that copy raw CLI
   *   output (such as a BEL) into their replies.
   */
  readonly invalidXmlChars?: 'reject' | 'strip';
  /**
   * Text in an element with no child elements that is only whitespace and
   * contains a line break, such as `<access>\n····</access>`:
   * - `'keep'` (default): it is the element's value.
   * - `'strip'`: it is the server's indentation, from writing an empty
   *   element across two lines, and is removed so the element is empty.
   *   Whitespace without a line break, and any text with a visible
   *   character, is kept. A string leaf whose whole value is blank lines
   *   would read as empty, so only turn this on for servers known to pad.
   */
  readonly paddedEmptyElements?: 'keep' | 'strip';
}

export const SESSION_QUIRK_NAMES: readonly (keyof SessionQuirks)[] = [
  'maxInFlight',
  'forceBaseVersion',
  'replyWithoutMessageId',
  'closeTimeout',
  'invalidXmlChars',
  'paddedEmptyElements',
];

// Everything outside the XML 1.0 Char production (§2.2): C0 controls other than
// TAB, LF and CR; unpaired surrogates; U+FFFE and U+FFFF.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Remove the characters XML 1.0 does not allow (the `invalidXmlChars: 'strip'`
 * quirk). Returns the cleaned text and how many characters were removed.
 */
export function stripInvalidXmlChars(text: string): { text: string; removed: number } {
  let removed = 0;
  const cleaned = text.replace(INVALID_XML_CHARS, () => {
    removed++;
    return '';
  });
  return { text: cleaned, removed };
}

/** Only XML whitespace (S production), including at least one line break. */
const PADDING = /^[ \t\r\n]*[\r\n][ \t\r\n]*$/;

/**
 * Empty the elements whose only content is whitespace with a line break (the
 * `paddedEmptyElements: 'strip'` quirk). Unchanged subtrees are reused.
 * Returns the element and how many elements were emptied.
 */
export function stripPaddedEmptyElements(element: XmlElement): { element: XmlElement; emptied: number } {
  let emptied = 0;
  const walk = (el: XmlElement): XmlElement => {
    if (el.children.length === 0) return el;
    if (el.children.every((c) => typeof c === 'string')) {
      if (!PADDING.test(el.children.join(''))) return el;
      emptied++;
      return rebuild(el, []);
    }
    let changed = false;
    const children = el.children.map((c) => {
      if (typeof c === 'string') return c;
      const next = walk(c);
      if (next !== c) changed = true;
      return next;
    });
    return changed ? rebuild(el, children) : el;
  };
  return { element: walk(element), emptied };
}

function rebuild(el: XmlElement, children: XmlElement['children']): XmlElement {
  return new XmlElement({
    name: el.name,
    ns: el.ns,
    ...(el.prefix !== undefined ? { prefix: el.prefix } : {}),
    attributes: el.attributes,
    children,
    declarations: el.declarations,
    inScope: el.inScope,
  });
}
