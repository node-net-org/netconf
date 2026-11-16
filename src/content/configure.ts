/**
 * Path-based configuration changes, applied with each device's workflow
 * (design §6.4): which datastore to edit, whether to lock, validate and commit.
 */

import { isJsonInput, type Datastore, type YangJsonObject } from '../operations/index.js';
import type { Child, XmlElement } from '../xml/index.js';
import { parseNamedPathCall } from './named-path.js';
import { buildEdit, parsePath, type PathEdit, type ResolvedStep } from './path.js';

/** How a device applies configuration (a device profile's `workflow`). */
export interface Workflow {
  /** Datastore to edit. */
  readonly editTarget: Extract<Datastore, 'running' | 'candidate'>;
  /** Lock the target while editing. */
  readonly lock: boolean;
  /** `<validate>` before committing (candidate only). */
  readonly validate: boolean;
  /** `<commit>` after editing (candidate only). */
  readonly commit: boolean;
}

/** A scalar becomes text (booleans as `true`/`false`); elements become children; `null` an empty element. */
export type EditValue = Exclude<Child, undefined>;

/** A whole-subtree JSON edit: `txn.merge(json)` or `txn.replace(json)`. */
export interface JsonEdit {
  readonly operation: 'merge' | 'replace';
  readonly json: YangJsonObject;
}

interface PendingEdit {
  readonly path: string;
  readonly operation: PathEdit['operation'];
  readonly value?: EditValue;
}

/**
 * Collects edits for one `<edit-config>`. Paths may be `@name` aliases from
 * the device profile, given every parameter they take. A malformed path throws when the edit is added; module
 * namespaces (and aliases) are resolved when the transaction is built, so the
 * client can learn them from the YANG library first.
 */
export class ConfigTransaction {
  private readonly edits: PendingEdit[] = [];
  private readonly jsonEdits: JsonEdit[] = [];

  /** @internal */
  constructor(private readonly resolve: (path: string) => ResolvedStep[]) {}

  /** Merge a value into the configuration (creates the node if needed). */
  set(path: string, value: EditValue): this {
    return this.add(path, 'merge', value);
  }

  /**
   * Replace the node at `path` and everything under it with `value`; or,
   * given only an RFC 7951 JSON object, replace each of its top-level
   * members (sent with the NETCONF `replace` operation).
   */
  replace(path: string, value: EditValue): this;
  replace(json: YangJsonObject): this;
  replace(pathOrJson: string | YangJsonObject, value?: EditValue): this {
    if (typeof pathOrJson !== 'string') return this.addJson('replace', pathOrJson, value);
    return this.add(pathOrJson, 'replace', value);
  }

  /**
   * Merge an RFC 7951 JSON object into the configuration, as JSON `config`
   * on edit-config is: converted with the YANG schema of the workflow's edit
   * target, its RFC 7952 metadata (`ietf-netconf:operation`, `yang:insert`)
   * becoming the edit attributes. Mixes with path edits, as long as they
   * don't share a top-level node.
   */
  merge(json: YangJsonObject): this {
    return this.addJson('merge', json, undefined);
  }

  /** Create the node; the server reports `data-exists` if it already exists. */
  create(path: string, value: EditValue): this {
    return this.add(path, 'create', value);
  }

  /** Delete the node; the server reports `data-missing` if it doesn't exist. */
  delete(path: string): this {
    return this.add(path, 'delete');
  }

  /** Delete the node if it exists (idempotent). */
  remove(path: string): this {
    return this.add(path, 'remove');
  }

  /** How many edits have been added so far, path and JSON edits alike. */
  get size(): number {
    return this.edits.length + this.jsonEdits.length;
  }

  /** @internal The JSON edits so far. */
  get json(): readonly JsonEdit[] {
    return this.jsonEdits;
  }

  /** @internal The paths edited so far, as given. */
  get paths(): readonly string[] {
    return this.edits.map((e) => e.path);
  }

  /** @internal The `<config>` content. Throws PathError for a path that doesn't resolve. */
  build(): XmlElement[] {
    return buildEdit(
      this.edits.map((e): PathEdit => {
        const path = this.resolve(e.path);
        return e.value === undefined ? { path, operation: e.operation } : { path, operation: e.operation, value: e.value };
      }),
    );
  }

  private addJson(operation: JsonEdit['operation'], json: unknown, extra: unknown): this {
    if (extra !== undefined) throw new TypeError(`txn.${operation}(json) takes one RFC 7951 JSON object; for a path, use txn.${operation === 'merge' ? 'set' : 'replace'}(path, value)`);
    if (!isJsonInput(json)) throw new TypeError(`txn.${operation}() needs an RFC 7951 JSON object, such as { "module:container": { ... } }`);
    this.jsonEdits.push({ operation, json });
    return this;
  }

  private add(path: string, operation: PathEdit['operation'], value?: EditValue): this {
    // Syntax errors surface here, where the edit is made.
    if (path.startsWith('@')) parseNamedPathCall(path);
    else parsePath(path);
    this.edits.push(value === undefined ? { path, operation } : { path, operation, value });
    return this;
  }
}

/** Fill in a workflow from explicit options, the profile, and what the server supports. */
export function resolveWorkflow(
  explicit: Partial<Workflow>,
  profile: Partial<Workflow> | undefined,
  supports: (capability: string) => boolean,
): Workflow {
  const editTarget = explicit.editTarget ?? profile?.editTarget ?? (supports(':candidate') ? 'candidate' : 'running');
  const candidate = editTarget === 'candidate';
  return {
    editTarget,
    lock: explicit.lock ?? profile?.lock ?? true,
    validate: candidate && (explicit.validate ?? profile?.validate ?? supports(':validate')),
    commit: candidate && (explicit.commit ?? profile?.commit ?? true),
  };
}
