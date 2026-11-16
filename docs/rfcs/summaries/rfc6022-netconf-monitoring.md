# RFC 6022: YANG Module for NETCONF Monitoring

This is a conceptual overview of RFC 6022: the ideas in the RFC and how they fit together. It does not reproduce the spec, and where the two differ, the RFC wins. For the RFC's priority and where it lands in the design, see [rfcs.md](../rfcs.md).

Published October 2010. Defines the `ietf-netconf-monitoring` YANG module (prefix `ncm`, namespace `urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring`) and the `<get-schema>` operation.

## The problem it solves

Base NETCONF tells a client very little about the server beyond the capabilities in the hello. RFC 6022 fills two gaps:

1. **Introspection**: what datastores exist and who has them locked, what sessions are open, and how busy the server has been.
2. **Schema discovery and retrieval**: which data models the server supports, and a way to **download their source** over the same NETCONF session, without a vendor website, FTP server or manual download.

It adds no new capability URI. A server shows support by advertising the module, like any other YANG module. The client then reads it with an ordinary `<get>`, and fetches schemas with the one new RPC, `<get-schema>`.

## The `/netconf-state` tree

Everything is read-only (`config false`), so it is read with `<get>`, not `<get-config>`.

```
netconf-state
├── capabilities/capability*        URIs currently in effect
├── datastores/datastore* [name]    running | candidate | startup
│   └── locks                       present only while locked
│       ├── global-lock             locked-by-session, locked-time
│       └── partial-lock* [lock-id] + select, locked-node (RFC 5717)
├── schemas/schema* [identifier version format]
│   ├── namespace
│   └── location*                   URI, or the literal "NETCONF"
├── sessions/session* [session-id]
│   ├── transport, username, source-host, login-time
│   └── in-rpcs, in-bad-rpcs, out-rpc-errors, out-notifications
└── statistics
    ├── netconf-start-time, in-bad-hellos, in-sessions, dropped-sessions
    └── in-rpcs, in-bad-rpcs, out-rpc-errors, out-notifications
```

A client should always request a **subtree**, for example `<netconf-state xmlns="…monitoring"><schemas/></netconf-state>`. An unfiltered `<get>` returns the whole operational tree of the device, which can be very large.

### Capabilities

The list of capabilities the server supports **now**. It may differ from the hello if capabilities have changed since the session started. RFC 6470's `netconf-capability-change` notification reports those changes.

### Datastores and locks

- The datastore names are a fixed enumeration of `running`, `candidate` and `startup`. NMDA datastores (`intended`, `operational`) are not in this list.
- `locks` exists only while the datastore is locked. It holds either one `global-lock` (from `<lock>`) or a list of `partial-lock` entries (from RFC 5717).
- `locked-by-session` is the NETCONF session ID of the holder. **`0` means a non-NETCONF session**, such as a CLI user holding a configuration lock.

This is the information a client needs when a `<lock>` fails with `lock-denied`: who holds the lock, since when, and whether `<kill-session>` could clear it. A holder of `0` can't be killed that way.

### Schemas

| Leaf | Meaning |
|------|---------|
| `identifier` | For YANG, the **module or submodule name**. For other formats it can be something like a file name. |
| `version` | For YANG, the **most recent `revision` date**, or `""` if there isn't one. Each version supported is a separate entry. |
| `format` | An identity: `yang`, `yin`, `xsd`, `rng` or `rnc`. YANG modules must be offered as `yang`, and may also be offered as `yin`. |
| `namespace` | The module's XML namespace. For a submodule, the namespace of the module it belongs to. |
| `location` | Where to fetch the source from: a URI (http, ftp, …), and/or the literal `NETCONF`, meaning "use `<get-schema>`". It should have at least one entry. |

`(identifier, version, format)` is the list key, and it is the same triple that `<get-schema>` takes.

### Sessions and statistics

- **Per session**:
  - `session-id`, the same value as in the hello.
  - `transport`, an identity: `netconf-ssh`, `netconf-tls`, or one of the obsolete SOAP/BEEP ones. The client returns it module-qualified, as RFC 7951 writes it (`ietf-netconf-monitoring:netconf-ssh`).
  - `username`, the identity the transport authenticated.
  - `source-host` and `login-time`.
  - Four counters: correct `<rpc>`s received, malformed ones, replies sent with `<rpc-error>`, and notifications sent.
- **Global**: the same four counters summed over all sessions, plus:
  - `netconf-start-time`
  - `in-sessions`: hellos sent with a session ID.
  - `in-bad-hellos`: sessions dropped because the client's hello was invalid.
  - `dropped-sessions`: sessions that ended abnormally, for example on idle timeout or transport loss. A `<close-session>` or `<kill-session>` doesn't count.

The sessions list is how a client finds a stale session to `<kill-session>`. `in-bad-hellos` and `in-bad-rpcs` are useful for diagnosing client bugs from the server side.

## `<get-schema>`

```xml
<rpc message-id="101" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
  <get-schema xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring">
    <identifier>ietf-interfaces</identifier>
    <version>2018-02-20</version>
    <format>yang</format>
  </get-schema>
</rpc>
```

```xml
<rpc-reply message-id="101" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
  <data xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring">module ietf-interfaces {
  ...
}</data>
</rpc-reply>
```

| Parameter | Required | Notes |
|-----------|----------|-------|
| `identifier` | Yes | Module or submodule name. |
| `version` | No | Revision date. |
| `format` | No | Identity name. Unprefixed works because `<get-schema>` sets the `ncm` default namespace. The RFC text says the default is `yang`. |

These are the errors:

| Condition | `error-tag` | `error-app-tag` |
|-----------|-------------|-----------------|
| No such schema | `invalid-value` | |
| More than one schema matches, for example `version` was left out and several revisions exist | `operation-failed` | `data-not-unique` |

Points a client should handle:

- **The reply is in `<data>`, in the monitoring namespace, not the base one.** This is a different element from the `<data>` returned by `<get>`.
- **YANG source comes back as text content.** Any `<`, `&` and so on are XML-escaped, or the server may use CDATA. A client must take the decoded text, not the raw XML. Formats such as `yin` and `xsd` may come back as **child elements** instead. In practice, netopeer2 sends them as escaped text too (a whole XML document, declaration included). The output is `anyxml`, so a client should accept either form; @node-net/netconf's `getSchema()` parses the text into the root element.
- **Send `version` whenever you know it.** The RFC contradicts itself here. The YANG module says leaving it out with several versions present is a `data-not-unique` error, while its §4.2 example shows the latest revision being returned. Server behaviour varies.
- **Copy the parameter name carefully.** Two of the RFC's own examples misspell it as `<identifer>`.
- To fetch a full module set, also fetch the **submodules** and **imported modules** listed in `schemas`. A module isn't usable without them.

## Where schema discovery fits with other RFCs

| Source | What it gives you |
|--------|-------------------|
| The hello (RFC 6020 §5.6.4) | YANG 1.0 modules as `?module=…&revision=…` capability URIs. |
| `/netconf-state/schemas` (this RFC) | Every schema with its locations. Works on any server that implements the module. |
| YANG library 1.0 (RFC 7895, `/modules-state`) | Modules, features, deviations and submodules, as one schema for the whole server. Advertised as `:yang-library:1.0?revision=…&module-set-id=…`. |
| YANG library 1.1 ([RFC 8525](./rfc8525-yang-library.md), `/yang-library`) | The same, plus **per-datastore schemas** for NMDA servers. Advertised as `:yang-library:1.1?revision=…&content-id=…`, a capability that RFC 8526 defines. |

**YANG 1.1 modules are not listed in the hello** (RFC 7950 §1.1). A server that implements any of them must implement the YANG library and advertise its capability (RFC 7950 §5.6.4). The same server can still list its YANG 1.0 modules in the hello, so the hello alone is an incomplete list.

A practical order is:

1. Discover modules from the YANG library if it's advertised, otherwise from the hello.
2. Check `/netconf-state/schemas` for a `NETCONF` location. YANG library `location` entries are URLs only, so `<get-schema>` availability is only visible here.
3. Fetch the source with `<get-schema>`.

## Security considerations

- `sessions/session/username` reveals who is connected and could help an attacker. Read access to `/netconf-state` should be restricted, for example with NACM (RFC 8341).
- The reported username is for **monitoring only**. Two servers can report the same username for different people, so it must not be used for access-control decisions.

## Where it lands in @node-net/netconf

| Concept | RFC | Module |
|---------|-----|--------|
| `getSchema({ identifier, version, format })`, returning the decoded source text (or, for XML formats, the schema document's root element, whether sent as elements or escaped text); `invalid-value` and `data-not-unique` arrive as `RpcError` tag and app tag | 6022 §3.1 | `operations/monitoring.ts`, entry point `@node-net/netconf/operations/monitoring` ([design §8](../../net-netconf-design.md#8-operations-layer-base-operations-and-extensions-operations)) |
| `schemas()`, `sessions()`, `datastores()` (global and partial locks) and `statistics()` as typed reads of `/netconf-state` subtrees | 6022 §2 | The same extension |
| Fetching YANG source to build the offline schema index | 6022 §3.1 | `nnc schema build` CLI (planned, [design §6.4](../../net-netconf-design.md)) |
| Resolving `lock-denied`: the holder's session ID (`0` means non-NETCONF) and `kill-session` | 6022 §2.1.2, 6241 | Caller docs and examples |
