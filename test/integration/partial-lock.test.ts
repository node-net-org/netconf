/**
 * The partial-lock extension (OPS-22) has no integration test: no open-source
 * NETCONF server implements RFC 5717.
 *
 * - netopeer2 2.1.49 doesn't advertise :partial-lock, and answers
 *   <partial-lock> with "No module with namespace … in the context".
 * - yuma123 netconfd 2.13 (Debian bookworm) advertises :partial-lock:1.0 and
 *   ietf-netconf-partial-lock, but fails every <partial-lock> with
 *   operation-failed "invalid internal value": its select values reach XPath
 *   evaluation uncompiled (xpath1.c, plock.c). The code is the same in 2.15.
 *
 * The extension is covered by test/operations/partial-lock.test.ts against the
 * fake server. Replace these placeholders when a server is available.
 */
import { describe, it } from 'vitest';

describe('partial-lock extension against a real server', () => {
  it.todo('locks a subtree and shows it in monitoring datastores()');
  it.todo("refuses another session's overlapping partial-lock and global lock with the holder's session-id");
  it.todo("grants another session's non-overlapping partial lock");
  it.todo('releases the lock on partial-unlock, on dispose and when the session closes');
});
