/** Character-level XML rules shared by the parser and the serializer. */

const NAME_START =
  'A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D' +
  '\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';
// The combining-mark range U+0300–U+036F is part of the XML NameChar production.
const NAME_CHAR = `${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;

/** XML "NCName": a name with no colon. Element, attribute and prefix names must match. */
// eslint-disable-next-line no-misleading-character-class -- combining marks are valid NameChars
const NC_NAME = new RegExp(`^[${NAME_START}][${NAME_CHAR}]*$`);

/** Any code point that XML 1.0 does not allow in a document, including lone surrogates. */
const INVALID_CHAR = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;

export function isNcName(name: string): boolean {
  return NC_NAME.test(name);
}

export function findInvalidChar(text: string): number {
  const m = INVALID_CHAR.exec(text);
  return m === null ? -1 : m.index;
}

/**
 * Escape character data. `>` is always escaped, so serialised text can never
 * contain `]]>` and therefore never the EOM delimiter `]]>]]>`.
 */
export function escapeText(text: string): string {
  return text.replace(/[&<>\r]/g, (c) => TEXT_ESCAPES[c]!);
}

/** Escape an attribute value for use inside double quotes. Whitespace is escaped so it survives normalisation. */
export function escapeAttr(value: string): string {
  return value.replace(/[&<>"\t\n\r]/g, (c) => ATTR_ESCAPES[c]!);
}

const TEXT_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\r': '&#13;' };
const ATTR_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\t': '&#9;',
  '\n': '&#10;',
  '\r': '&#13;',
};
