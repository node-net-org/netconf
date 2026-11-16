# RFC 6243: With-defaults Capability for NETCONF

This is a conceptual overview of RFC 6243: the ideas in the RFC and how they fit together. It does not reproduce the spec, and where the two differ, the RFC wins. For the RFC's priority and where it lands in the design, see [rfcs.md](../rfcs.md).

Published June 2011. Defines the `:with-defaults:1.0` capability, the `ietf-netconf-with-defaults` YANG module and the `wd:default` XML attribute.

## The problem it solves

A YANG model gives many leaves a **default value**, for example `mtu` defaulting to `1500`. When a client reads configuration, should the server include leaves that are at their default? Base NETCONF ([RFC 6241](./rfc6241-netconf.md)) doesn't say, and servers disagree:

- Some report everything.
- Some leave out any leaf whose value equals the default.
- Some leave out only leaves the client never set.

This matters in two ways:

1. **Reading**: a client can't tell whether a missing leaf means "at its default" or "not supported", and can't get a complete picture of how the device is actually configured.
2. **Editing**: `create` fails if the node exists and `delete` fails if it doesn't. Whether a defaulted leaf "exists" depends on the server's policy, so the same `edit-config` can succeed on one server and fail on another.

RFC 6243 doesn't force one policy. Instead:

- The server **advertises** its policy, called its *basic mode*.
- The client can **override** what gets reported on each request with a `<with-defaults>` parameter.

## Key terms

| Term | Meaning |
|------|---------|
| **Schema default** | The `default` value in the data model. |
| **Explicitly set data** | A value set by a client (or other management interface) through an explicit operation, **even if it equals the schema default**. A value the server sets that differs from the default also counts. |
| **Default data** | A node the server treats as "not really there, the default is in use". Exactly which nodes count as default data depends on the basic mode. |

## The three basic modes

Every server that supports the capability picks **exactly one** basic mode. The basic mode decides what a plain `<get>`/`<get-config>` returns, and whether a defaulted node "exists" for `create`/`delete`.

| Basic mode | Which nodes are default data | Plain retrieval omits | `create` on a defaulted node | `delete` on a defaulted node |
|------------|------------------------------|-----------------------|------------------------------|------------------------------|
| **`report-all`** | None. Every node with a value exists. | Nothing | Fails, `data-exists` | Succeeds, and the default reappears at once |
| **`trim`** | Any node whose value **equals** the schema default | Nodes equal to their default, config and state | Succeeds | Fails, `data-missing` |
| **`explicit`** | Any node **not explicitly set** | Nodes the server defaulted. A node the client set to the default value **is** reported. State nodes are always reported. | Succeeds if the server set it, fails with `data-exists` if a client set it | Succeeds if a client set it, fails with `data-missing` if the server set it |

The difference between `trim` and `explicit` shows when a client sets a leaf to its default value, such as `mtu 1500`:

- **`trim`**: the write succeeds, but the value is **not stored**, so the leaf is back to being default data. A later read won't show it.
- **`explicit`**: the value is stored and reported, because the client set it.

The RFC says clients are expected to cope with all three modes.

## The capability

```
urn:ietf:params:netconf:capability:with-defaults:1.0?basic-mode=explicit&also-supported=report-all,report-all-tagged
```

| Parameter | Required | Meaning |
|-----------|----------|---------|
| `basic-mode` | Yes | `report-all`, `trim` or `explicit` |
| `also-supported` | No | A comma-separated list of the other retrieval modes the server accepts: `report-all`, `report-all-tagged`, `trim`, `explicit` |

In the hello, the `&` appears as `&amp;` because it's inside XML. The server must also advertise the `ietf-netconf-with-defaults` YANG module (namespace `urn:ietf:params:xml:ns:yang:ietf-netconf-with-defaults`) as a module capability. That is a **separate** URI from the protocol capability above.

## The `<with-defaults>` parameter

The YANG module adds one leaf, `with-defaults`, to the input of `<get>`, `<get-config>` and `<copy-config>`. It is in the **module's namespace**, not the base NETCONF namespace:

```xml
<rpc message-id="101" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
  <get-config>
    <source><running/></source>
    <with-defaults xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-with-defaults">report-all</with-defaults>
  </get-config>
</rpc>
```

There are four retrieval modes:

| Value | Returns |
|-------|---------|
| `report-all` | Everything, including all default data. |
| `trim` | Leaves out every node whose value equals its schema default, config and state. |
| `explicit` | Leaves out nodes the server defaulted, but includes nodes a client set to the default. Includes state nodes. |
| `report-all-tagged` | Like `report-all`, but each node the server considers default data has the attribute `wd:default="true"`. Which nodes are tagged depends on the server's basic mode: `report-all` servers never tag anything. |

The rules are:

- The server must accept its basic mode and anything in `also-supported`. Anything else gets an `invalid-value` error. A client should check the value against the capability before sending it.
- Without the parameter, the server uses its basic mode.
- Default handling happens **before** `<filter>`. With `report-all`, the filter sees the defaulted nodes too.
- It only affects the reply. It doesn't change what is stored.
- On `<copy-config>`, it only matters when the **target is a `<url>`**. If the target is a datastore, the server uses its basic mode and silently ignores the parameter.
- RFC 6243 only covers `get`, `get-config` and `copy-config`. Later operations define their own default handling. For example, `<get-data>` in RFC 8526 has a `with-defaults` parameter of its own.

### Example

Here, `mtu` defaults to `1500`. The client set `eth0` to `8192`, the client explicitly set `eth3` to `1500`, and the server defaulted `eth1`:

| Mode | `eth0` mtu | `eth1` mtu (server default) | `eth3` mtu (client set 1500) |
|------|------------|-----------------------------|------------------------------|
| `report-all` | 8192 | 1500 | 1500 |
| `trim` | 8192 | (omitted) | (omitted) |
| `explicit` | 8192 | (omitted) | 1500 |
| `report-all-tagged` on a `trim` server | 8192 | `1500` with `wd:default="true"` | `1500` with `wd:default="true"` |
| `report-all-tagged` on an `explicit` server | 8192 | `1500` with `wd:default="true"` | 1500 |

## The `wd:default` attribute

- **Namespace**: `urn:ietf:params:xml:ns:netconf:default:1.0`, conventionally with the prefix `wd`.
- **Type**: an XSD boolean. Both `true`/`false` and `1`/`0` must be accepted.
- **When it applies**: only on servers that list `report-all-tagged` in `also-supported`.

It works in both directions:

- **In replies**, it marks the nodes that are default data.
- **In `edit-config` and `copy-config` input**, a node tagged `wd:default="true"` means **"return this node to its default"**, which removes it from the datastore. The node must carry a value, and that value must equal the schema default, or the server returns `invalid-value`. The effective operation on the node must be `create`, `merge` or `replace`, or the server returns `invalid-value` again.

A `report-all` server has no default data, so it rejects the attribute in configuration input with `unknown-attribute`.

**In practice:** libyang-based servers (netopeer2) tag replies with the attribute in the YANG module's namespace, `urn:ietf:params:xml:ns:yang:ietf-netconf-with-defaults` (as `ncwd:default`), instead of the namespace above. A client reading tags should accept both. @node-net/netconf's `isDefault()` does.

## Effect on `edit-config`

Only the `create` and `delete` operations are affected, through the "does this node exist?" rules in the basic-mode table above. `merge`, `replace` and `remove` behave the same in every mode.

There is one inconsistency in the RFC. §2 says a `create` on an existing node fails with `data-exists`, which matches RFC 6241. §4.5.2 says `invalid-value`. A client should treat **either** tag as "already exists".

## Security considerations

The RFC adds no new risks beyond RFC 6241. It only changes how much data a read returns.

## Where it lands in @node-net/netconf

| Concept | RFC | Module |
|---------|-----|--------|
| Parsing `basic-mode` and `also-supported` from the capability URI | 6243 §4.3 | `messages/capabilities.ts` (`Capability.params`) |
| `withDefaults` option on `get`, `getConfig` and `copyConfig`, checked against the advertised modes | 6243 §3, §4.5.1 | `operations/with-defaults.ts`, entry point `@node-net/netconf/operations/with-defaults` (an augment of the base operations; [design §8](../../net-netconf-design.md#8-operations-layer-base-operations-and-extensions-operations)) |
| Reading `wd:default` on reply nodes | 6243 §6 | `isDefault(element)` from the same entry point |
| Treating both `data-exists` and `invalid-value` as "already exists" on `create` | 6243 §2, §4.5.2 | `messages/rpc-error.ts` (error typing; suggested, not yet implemented) |
