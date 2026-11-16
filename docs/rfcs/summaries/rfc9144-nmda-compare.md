# RFC 9144: Comparison of Network Management Datastore Architecture (NMDA) Datastores

This is a conceptual overview of RFC 9144: the ideas in the RFC and how they fit together. It does not reproduce the spec, and where the two differ, the RFC wins. For the RFC's priority and where it lands in the design, see [rfcs.md](../rfcs.md).

Published December 2021. Defines the `ietf-nmda-compare` YANG module (prefix `cmp`, namespace `urn:ietf:params:xml:ns:yang:ietf-nmda-compare`), which has a single RPC, `<compare>`. It works over NETCONF and RESTCONF.

## The problem it solves

[NMDA (RFC 8342)](./rfc8342-nmda.md) separates the configuration you asked for from what the device is actually running:

- `running` and `intended` hold the configuration as written and as validated.
- `operational` holds what is **in use**, which can differ: a configured interface whose line card isn't installed, a value the device couldn't apply, or a resource still being set up.

Finding those differences by hand means fetching both datastores and diffing two large trees on the client. `<compare>` asks the **device** to do the diff and return only the differences.

The main uses are:

- **`intended` against `operational`**: "which of my configuration isn't in effect?"
- **`running` against `intended`**: what template expansion or inactive configuration changed. They are often identical.
- **`candidate` against `running`**: the pending changes before a commit, on servers that expose `candidate` as an NMDA datastore.

## The RPC

```xml
<rpc message-id="1" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
  <compare xmlns="urn:ietf:params:xml:ns:yang:ietf-nmda-compare"
           xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores">
    <source>ds:intended</source>
    <target>ds:operational</target>
    <xpath-filter xmlns:if="urn:ietf:params:xml:ns:yang:ietf-interfaces">/if:interfaces</xpath-filter>
  </compare>
</rpc>
```

| Input | Meaning |
|-------|---------|
| `source`, `target` | Datastore identities, such as `ds:intended` and `ds:operational`. Both must be datastores the server supports, as listed in the YANG library ([RFC 8525](./rfc8525-yang-library.md)). |
| `all` | Compare **all** data nodes. Without it, only **configuration** (`config true`) nodes are compared, so state such as counters doesn't show up as differences against `operational`. |
| `report-origin` | Include the `origin` annotation of `operational` values (RFC 8342), to see where each value came from. RFC 9144 defines no feature for it: the module has no features at all, and a server that can't do it refuses the request. |
| `subtree-filter` or `xpath-filter` | Compare only part of the tree. Strongly advised on a real device. |

## The reply

Either an empty `<no-matches/>`, which the RFC defines as "the filter did not match anything and nothing was compared" (it says nothing about identical datastores; Clixon sends `<no-matches/>` for those too), or a `<differences>` container holding a **YANG Patch** (RFC 8072):

```xml
<rpc-reply message-id="1" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
  <differences xmlns="urn:ietf:params:xml:ns:yang:ietf-nmda-compare">
    <yang-patch>
      <patch-id>interfaces</patch-id>
      <edit>
        <edit-id>1</edit-id>
        <operation>delete</operation>
        <target>/ietf-interfaces:interfaces/interface=eth3</target>
        <source-value>
          <interface xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces">
            <name>eth3</name><enabled>true</enabled>
          </interface>
        </source-value>
      </edit>
    </yang-patch>
  </differences>
</rpc-reply>
```

How to read it:

- **The patch turns `source` into `target`.** Each edit says what you would do to the source to get the target. In the example, `eth3` is configured in `intended`, but **absent** from `operational`, so the edit is `delete`.
- **`value`** is the node as it is in the target, for `create`, `replace` and similar edits.
- **`source-value`** is an addition to YANG Patch: the node as it is in the source. With both, a client can show "was X, is Y" without fetching anything else.
- **`target` paths are RESTCONF-style** (`/module:node/list=key`). RFC 9144 doesn't say which root they are relative to under a filter. Its example (filter `/if:interfaces`, target `/ietf-interfaces:interface=eth0/enabled`) and Clixon both make them relative to the node the filter selects, with the module name moved onto the first remaining step. Treat them as text, not as absolute paths.

## Points a client should handle

- **Differences between `intended` and `operational` are often expected.** An interface without hardware, or a protocol still converging, appears as a difference. A compare is a report, not an error.
- **Use a filter.** An unfiltered compare against `operational` with `all` asks the device to diff its entire state.
- **The server decides how to group edits.** The same difference may come back as one `replace` of a container or several leaf edits.
- **Check support first.** The module is YANG 1.1, so it is found through the YANG library, not the hello, and only NMDA servers have it. The RFC itself says nothing about discovery.
- **Errors aren't specified.** RFC 9144 names no error tags. Clixon 7.9 answers `operation-not-supported` for inputs it doesn't implement (`all`, `report-origin`, `subtree-filter`) and `operation-failed` for a datastore it doesn't have or an identity that isn't a datastore.

## Implementations

Of the open-source servers checked in November 2026, only **Clixon** (7.6 and later) implements `<compare>`. It ships a later revision of the module (2024-04-16, which adds a `reference-point` input for private candidates, gated by a feature). netopeer2/sysrepo (through 2.8/5.2), yuma123, and the public documentation for ConfD/NSO, SR Linux, cRPD and cEOS show no support.

## Security considerations

- A compare reads both datastores, so NACM (RFC 8341) applies to both. Nodes the client can't read in either datastore are left out.
- Comparing large trees costs the server memory and time, which a client could abuse. Servers may limit it.

## Where it lands in @node-net/netconf

| Concept | RFC | Module |
|---------|-----|--------|
| `compare({ source, target, all, reportOrigin, filter })`, resolving with `{ noMatches, patchId, comment, edits }`; each edit has `value` and `sourceValue` | 9144 | `operations/compare` ✅ ([design §8](../../net-netconf-design.md)) |
| Datastore identities for `source` and `target` | 8342 | nmda's `DatastoreRef`: the standard names or any `{ name, namespace }` identity. Not checked against the YANG library's datastores, which Clixon doesn't list |
| YANG Patch decoding with `source-value` | 9144, 8072 | `operations/yang-patch`, shared with `subscriptions` (YANG-Push `push-change-update`) |
| Module check through the YANG library | 9144, 8525 | `compare()` reads the YANG library once per client and refuses with `CapabilityError` if ietf-nmda-compare isn't listed. There is no feature to check |
| `origin` annotations on reported values | 8342 | Kept on the value elements; `origins()` from `nmda` reads them |
