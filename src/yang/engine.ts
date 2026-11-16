/**
 * The YANG machinery: everything in the adapter that needs @node-net/yang's code,
 * not only its types. Nothing imports this module statically. load.ts loads
 * it with import() the first time a conversion needs it, so a bundler puts
 * it (and @node-net/yang) in a chunk of its own, and an app that never converts
 * JSON never fetches it (design §12).
 *
 * It is also the boundary where @node-net/yang's YangDataError becomes
 * @node-net/netconf's (errors.ts), so every conversion rejects with a
 * NetconfError. Inside the adapter, @node-net/yang's class is used as is.
 */

import { YangDataError as NetYangDataError } from '@node-net/yang/core';
import { convertData as convert } from './convert.js';
import { diffData as diff } from './diff.js';
import { encodeData as encode } from './encode.js';
import { convertOperation as convertOp, encodeOperation as encodeOp } from './operation.js';
import { YangDataError } from './errors.js';
import { compile as compileSchemas } from './schemas.js';

/** @node-net/yang's YangDataError as @node-net/netconf's, with it as the cause; anything else as it is. */
function rewrap(err: unknown): unknown {
  return err instanceof NetYangDataError ? new YangDataError(err.message, err.issues, { cause: err }) : err;
}

function wrap<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args) =>
    fn(...args).catch((err: unknown) => {
      throw rewrap(err);
    });
}

export const convertData = wrap(convert);
export const diffData = wrap(diff);
export const encodeData = wrap(encode);
export const convertOperation = wrap(convertOp);
export const encodeOperation = wrap(encodeOp);
export const compile = wrap(compileSchemas);
// Module text and the hello's library: no instance data, so no YangDataError.
export { builtinSource, fromCapabilities } from '@node-net/yang/core';
