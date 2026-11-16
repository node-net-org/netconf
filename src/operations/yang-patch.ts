/**
 * Reading RFC 8072 YANG Patch content, shared by the extensions that receive one:
 * YANG-Push `push-change-update` (subscriptions) and `<compare>` differences.
 * Both use the `ietf-yang-patch` grouping inside their own module, so the
 * patch's elements are in that module's namespace; the decoder takes the
 * namespace from the `<yang-patch>` element itself.
 */

import type { XmlElement } from '../xml/index.js';

/** One YANG Patch edit (RFC 8072 §2.2). */
export interface PatchEdit {
  /** The edit's identifier, unique within the patch. */
  readonly editId: string;
  /** The YANG Patch operation: `create`, `delete`, `insert`, `merge`, `move`, `replace` or `remove`. */
  readonly operation: string;
  /**
   * The edited node, as the server wrote it. Its syntax and root vary by
   * server: netopeer2 sends a YANG path with list keys as predicates
   * (`/ietf-interfaces:interfaces/interface[name='eth0']`), which
   * `parsePath()` from @node-net/netconf reads; Clixon sends RESTCONF style
   * (`/clixon-example:table/parameter=a`).
   */
  readonly target: string;
  /** For `insert` and `move`: the list entry the target is placed `before` or `after`. */
  readonly point?: string;
  /** For `insert` and `move`: where the target goes, `before`, `after`, `first` or `last`. */
  readonly where?: string;
  /** The elements inside `<value>` (empty when there is none, as for delete and remove). */
  readonly value: readonly XmlElement[];
}

/** An RFC 8072 YANG Patch: an ordered list of edits to a datastore. */
export interface YangPatch<E extends PatchEdit = PatchEdit> {
  /** The patch's identifier, as the server chose it. */
  readonly patchId: string;
  /** The server's comment on the patch, if any. */
  readonly comment?: string;
  /** The edits, in the order they apply. */
  readonly edits: readonly E[];
}

const leaf = (el: XmlElement, name: string, ns: string): string | undefined => el.child(name, ns)?.text().trim();

/**
 * Decode a `<yang-patch>` element. `extra` adds fields read from each `<edit>`
 * (RFC 9144's `source-value`, for one). The result is frozen.
 */
export function decodeYangPatch<X extends object = Record<never, never>>(
  patch: XmlElement,
  extra?: (edit: XmlElement, ns: string) => X,
): YangPatch<PatchEdit & X> {
  const ns = patch.ns ?? '';
  const edits = patch.childrenNamed('edit', ns).map((edit): PatchEdit & X => {
    const point = leaf(edit, 'point', ns);
    const where = leaf(edit, 'where', ns);
    return Object.freeze({
      editId: leaf(edit, 'edit-id', ns) ?? '',
      operation: leaf(edit, 'operation', ns) ?? '',
      target: leaf(edit, 'target', ns) ?? '',
      ...(point !== undefined ? { point } : {}),
      ...(where !== undefined ? { where } : {}),
      value: Object.freeze([...(edit.child('value', ns)?.elements ?? [])]),
      ...(extra?.(edit, ns) ?? ({} as X)),
    }) as PatchEdit & X;
  });
  const comment = leaf(patch, 'comment', ns);
  return Object.freeze({
    patchId: leaf(patch, 'patch-id', ns) ?? '',
    ...(comment !== undefined ? { comment } : {}),
    edits: Object.freeze(edits),
  });
}
