/**
 * The error the YANG conversions reject with, as @node-net/netconf exports it. It
 * is @node-net/netconf's own NetconfError subclass. engine.ts wraps @node-net/yang's error
 * in it at the boundary, so only @node-net/yang's types are imported here and
 * exporting the class doesn't bring in the YANG machinery.
 */

import type { DataIssue } from '@node-net/yang/core';
import { NetconfError, type NetconfErrorOptions } from '../errors.js';

export type { DataIssue };

/**
 * YANG data that doesn't match the schema, in either direction: XML from
 * the server that can't be typed (with `requireSchema`), or JSON that can't be
 * encoded. `issues` lists every problem found, each with its data path, and
 * `cause` is the YANG library's own error.
 */
export class YangDataError extends NetconfError {
  /** Always `'YangDataError'`. */
  override name = 'YangDataError';
  /** Always `'ERR_NETCONF_YANG_DATA'`. */
  override readonly code = 'ERR_NETCONF_YANG_DATA';
  /** Every problem found, not only the first; warnings may be among them. */
  readonly issues: readonly DataIssue[];

  constructor(message: string, issues: readonly DataIssue[], options?: NetconfErrorOptions) {
    super(message, options);
    this.issues = issues;
  }
}
