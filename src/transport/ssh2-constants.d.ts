/** ssh2's internal constants module: only the default algorithm lists are used. */
declare module 'ssh2/lib/protocol/constants.js' {
  const constants: {
    readonly DEFAULT_KEX: readonly string[];
    readonly DEFAULT_SERVER_HOST_KEY: readonly string[];
    readonly DEFAULT_CIPHER: readonly string[];
    readonly DEFAULT_MAC: readonly string[];
    readonly DEFAULT_COMPRESSION: readonly string[];
  };
  export default constants;
}
