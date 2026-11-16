/**
 * YANG modules read from directories on disk: the one YANG feature that needs
 * Node.js. Only the Node entry imports this, and hands it to the client as
 * its way to read `yang.modules` directories.
 */

import { fileSource, type ModuleSource } from '@node-net/yang';

export function directorySource(dirs: readonly string[]): ModuleSource {
  return fileSource(dirs);
}
