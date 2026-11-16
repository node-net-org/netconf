/**
 * Content-layer quirks (design §7): known ways devices deviate in how the
 * path API may fetch data. Each is a named switch implemented and tested
 * here; a device profile can only turn switches on.
 */
export interface ContentQuirks {
  /**
   * Whether path reads (`read()`, `readValue()`) may send a subtree filter:
   * - `'supported'` (default): send a filter selecting just the path.
   * - `'unsupported'`: fetch the whole datastore without a filter and select
   *   the path locally, for devices that reject or mistranslate filters.
   * - `'containers'`: send a filter cut short (see `subtreeFilterDepth`) and
   *   select the rest of the path locally, for devices that accept filters
   *   only down to certain levels.
   */
  readonly subtreeFilter?: 'supported' | 'unsupported' | 'containers';
  /**
   * With `subtreeFilter: 'containers'` (and required by it): how far the
   * filter goes. It keeps the first `subtreeFilterDepth` steps of the path,
   * then any keyed list entries right after them, and stops at the first
   * step without keys past that.
   */
  readonly subtreeFilterDepth?: number;
}

export const CONTENT_QUIRK_NAMES: readonly (keyof ContentQuirks)[] = ['subtreeFilter', 'subtreeFilterDepth'];
