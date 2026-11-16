/**
 * Content layer (design §3, §3.5, §6.4): YANG paths and path-based
 * configuration changes. This barrel is the layer's public surface.
 */

export {
  parsePath,
  resolvePath,
  buildFilter,
  pathXPath,
  buildEdit,
  filterDepth,
  selectPath,
  PathError,
  type EditOperation,
  type ModuleResolver,
  type PathEdit,
  type PathKey,
  type PathStep,
  type ResolvedStep,
} from './path.js';
export {
  compileNamedPath,
  expandNamedPath,
  namedPath,
  parseNamedPathCall,
  type MissingParams,
  type NamedPathCall,
  type NamedPathTemplate,
} from './named-path.js';
export { ConfigTransaction, resolveWorkflow, type EditValue, type Workflow } from './configure.js';
export { CONTENT_QUIRK_NAMES, type ContentQuirks } from './quirks.js';
