# RFC 8526: NETCONF Extensions to Support the Network Management Datastore Architecture

This is a conceptual overview of RFC 8526: the ideas in the RFC and how they fit together. It does not reproduce the spec, and where the two differ, the RFC wins. For the RFC's priority and where it lands in the design, see [rfcs.md](../rfcs.md).

Published March 2019. Updates RFC 6241 and RFC 7950. Defines the `ietf-netconf-nmda` YANG module (prefix `ncds`, namespace `urn:ietf:params:xml:ns:yang:ietf-netconf-nmda`), the `<get-data>` and `<edit-data>` operations, and the `:yang-library:1.1` and `:with-operational-defaults` capabilities.

## The problem it solves

The NMDA ([RFC 8342](./rfc8342-nmda.md)) adds datastores beyond the three of base NETCONF, most importantly `<intended>` and `<operational>`, and lets later specifications define more. Base NETCONF ([RFC 6241](./rfc6241-netconf.md)) can't address them:

- `<get-config>`, `<edit-config>` and friends name their datastore with a fixed XML **choice** (`<running/>`, `<candidate/>`, `<startup/>`). A new datastore needs a new element.
- `<get>` returns config and state together, with no way to ask where a value came from.

RFC 8526 switches to naming a datastore by **YANG identity** (the `datastore` identity from `ietf-datastores`, RFC 8342). Identities can be extended without changing the operations. It then:

1. Adds two operations, `<get-data>` and `<edit-data>`, that take a `datastore` identity.
2. Augments `<lock>`, `<unlock>` and `<validate>` with a `datastore` leaf.
3. Requires NMDA servers to publish the YANG library ([RFC 8525](./rfc8525-yang-library.md)), so a client can find out which datastores exist and which modules each one holds.

It does **not** change `<get>`, `<get-config>`, `<edit-config>`, `<copy-config>`, `<delete-config>` or `<commit>`. Those keep their original parameters.

## How a client knows the server is NMDA-capable

An NMDA-compliant NETCONF server **must**:

- implement the `ietf-netconf-nmda` module,
- support the `<operational>` datastore,
- implement `ietf-yang-library` at revision `2019-01-04` or later,
- advertise this capability in its hello (shown on two lines for readability):

```
urn:ietf:params:netconf:capability:yang-library:1.1?
  revision=<date>&content-id=<content-id-value>
```

| Parameter | Required | Meaning |
|-----------|----------|---------|
| `revision` | Yes | The revision date of the `ietf-yang-library` module the server implements. |
| `content-id` | Yes | The YANG library content identifier (RFC 8525). It changes when the library content changes. |

A client can cache the datastore and module lists and re-read them only when `content-id` in a new hello differs. The lists themselves come from reading the YANG library in `<operational>` (see [RFC 8525](./rfc8525-yang-library.md)).

The update to RFC 7950 §5.6.4 lets an NMDA server advertise `:yang-library:1.1` **instead of** `:yang-library:1.0`, and implement the `/yang-library` subtree **instead of** `/modules-state`. A client that only looks for `1.0` will miss an NMDA server.

### Module features

| Feature | Gates | When enabled |
|---------|-------|--------------|
| `origin` | `origin-filter`, `negated-origin-filter` and `with-origin` on `<get-data>` | Server supports the `origin` annotation. Optional. |
| `with-defaults` | The `with-defaults` parameter on `<get-data>` | Must be enabled for a session exactly when the server advertises `:with-defaults` (RFC 6243) on that session. |

`<get-data>`'s `xpath-filter` and `<edit-data>`'s `url` reuse the base module's `nc:xpath` and `nc:url` features, so they follow the existing `:xpath` and `:url` capabilities.

## Encoding datastores in XML

The `datastore` parameter has type `ds:datastore-ref`, an **identityref**. In XML it is a prefixed name, and the prefix must be bound to the `ietf-datastores` namespace in scope:

```xml
<get-data xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-nmda"
          xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores">
  <datastore>ds:operational</datastore>
</get-data>
```

The prefix is arbitrary; the namespace binding is what matters. Origin values (`or:intended`, `or:system`, …) are identityrefs too, bound to `urn:ietf:params:xml:ns:yang:ietf-origin`. Note that the new elements live in the `ietf-netconf-nmda` namespace, not the base NETCONF namespace, while `<rpc>` and `<rpc-reply>` stay in the base namespace. The reply's `<data>` element is also in the `ietf-netconf-nmda` namespace.

## The `<get-data>` operation

Like `<get-config>`, but from any datastore. All filters are **ANDed**. Ancestors of selected nodes, including list keys, are always included. An empty `<data/>` means nothing matched.

| Parameter | Type | Needs | What it does |
|-----------|------|-------|--------------|
| `datastore` | `ds:datastore-ref` | Mandatory | The source datastore. |
| `subtree-filter` | anydata | | Subtree filter, as in RFC 6241 §6, but as an explicit element instead of `<filter type="subtree">`. |
| `xpath-filter` | `yang:xpath1.0` | `nc:xpath` | XPath expression. Namespaces in scope on the `xpath-filter` element are the prefix bindings; the context node is the datastore root. One of the two filters at most. |
| `config-filter` | boolean | | `true`: only `config true` nodes. `false`: only `config false` nodes. Absent: no filtering. |
| `origin-filter` | `or:origin-ref`, repeatable | `origin`; datastore derived from `ds:operational` | Keep configuration nodes whose origin equals or derives from **any** value given. |
| `negated-origin-filter` | `or:origin-ref`, repeatable | as above | Keep configuration nodes whose origin is **none** of the values given (nor derived from them). Can't be combined with `origin-filter`. |
| `max-depth` | 1..65535 or `unbounded` | | Levels returned below **each selected node**. `1` means the selected nodes without children. Default `unbounded`. |
| `with-origin` | empty | `origin`; datastore derived from `ds:operational` | Add `or:origin` annotations to the reply. Never included unless asked for. |
| `with-defaults` | RFC 6243 mode | `with-defaults` feature | Default reporting, see below. |

Origin filters only apply to **configuration** nodes. System state nodes pass through untouched (use `config-filter` to drop them), and configuration nodes with no origin are treated as `or:unknown`.

### Example: origin filtering on `<operational>`

```xml
<rpc message-id="102" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
  <get-data xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-nmda"
            xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores"
            xmlns:or="urn:ietf:params:xml:ns:yang:ietf-origin">
    <datastore>ds:operational</datastore>
    <subtree-filter><bgp xmlns="http://example.com/ns/bgp"/></subtree-filter>
    <origin-filter>or:intended</origin-filter>
    <origin-filter>or:system</origin-filter>
    <with-origin/>
  </get-data>
</rpc>

<rpc-reply message-id="102" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
  <data xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-nmda">
    <bgp xmlns="http://example.com/ns/bgp"
         xmlns:or="urn:ietf:params:xml:ns:yang:ietf-origin"
         or:origin="or:intended">
      <peer>
        <name>2001:db8::2:3</name>
        <local-port or:origin="or:system">60794</local-port>
        <state>established</state>
      </peer>
    </bgp>
  </data>
</rpc-reply>
```

`<state>` is system state, so it survives the origin filter. Adding `<config-filter>true</config-filter>` removes it.

### Origin annotations in replies

- The annotation is the XML attribute `or:origin`, whose value is an origin identity.
- The server should report the origin that most accurately describes where the operational value came from (RFC 8342 §5.3.4).
- A child may **omit** the annotation when it equals its parent's. A client must inherit the nearest ancestor's origin, as `<name>` and `<peer>` do above.
- `with-origin` is support-optional (the `origin` feature).

### `with-defaults` on `<get-data>`

| Target | Behaviour |
|--------|-----------|
| Conventional datastores (`running`, `candidate`, `startup`, `intended`) | Supported whenever the server advertises `:with-defaults`. Same semantics as [RFC 6243](./rfc6243-with-defaults.md). |
| `<operational>` | Optional. Supported only if the server **also** advertises `urn:ietf:params:netconf:capability:with-operational-defaults:1.0`. Then any mode in `basic-mode` or `also-supported` is allowed. |
| Other datastores | Left to the specification of that datastore. |

On `<operational>` the modes behave differently from RFC 6243:

- **Absent, `explicit`, `report-all` or `report-all-tagged`**: all "in use" values are returned (RFC 8342 §5.3), including ones that equal a schema default. `report-all-tagged` additionally tags values that match the schema default with `wd:default`.
- **`trim`**: in-use values, minus any that match the schema default.

So `explicit` is no different from `report-all` on `<operational>`, and the server's basic mode does not apply.

## The `<edit-data>` operation

Like `<edit-config>`, but the target is any **writable** datastore named by identity. RFC 8526 doesn't list the writable datastores; that is defined by the NMDA (see [RFC 8342](./rfc8342-nmda.md)). Unsupported or read-only targets are rejected with `invalid-value`.

| Parameter | Needs | Meaning |
|-----------|-------|---------|
| `datastore` | Mandatory | Target datastore. |
| `default-operation` | | `merge` (default), `replace` or `none`, as in `<edit-config>`. |
| `config` | One of `config`/`url` is mandatory | Inline content. `anydata` rather than `<edit-config>`'s `anyxml`. |
| `url` | `nc:url` | Content fetched from a URL. |

```xml
<rpc message-id="104" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
  <edit-data xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-nmda"
             xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores">
    <datastore>ds:running</datastore>
    <config>
      <top xmlns="http://example.com/schema/1.2/config">
        <interface><name>Ethernet0/0</name><mtu>1500</mtu></interface>
      </top>
    </config>
  </edit-data>
</rpc>
```

The reply is `<ok/>`. Differences from `<edit-config>`:

- There is **no `error-option`**. The behaviour is always `rollback-on-error`: on any error the datastore is restored to its state before the operation.
- There is **no `test-option`**.
- With `:with-defaults`, `create`/`delete` on defaulted nodes follow RFC 6243 §4.5.2, as for `<edit-config>`. Non-conventional datastores define their own rules.

## Changes to existing operations

| Operation | Change | Limit |
|-----------|--------|-------|
| `<lock>`, `<unlock>` | New `datastore` leaf inside the `target` choice, alongside `<running/>` etc. | Writable datastores only. |
| `<validate>` | New `datastore` leaf inside the `source` choice. | Configuration datastores only. |
| Everything else in RFC 6241 | Unchanged. | |

The new leaf is in the `ietf-netconf-nmda` namespace inside the base-namespace `<target>`:

```xml
<lock>
  <target>
    <datastore xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-nmda"
               xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores">ds:candidate</datastore>
  </target>
</lock>
```

## Errors

Every error the RFC specifies uses `invalid-value`:

| Situation | `error-tag` |
|-----------|-------------|
| `<get-data>` on a datastore the server doesn't support | `invalid-value` |
| `with-origin` with a datastore not derived from `operational` | `invalid-value` |
| `with-defaults` where it isn't supported (e.g. `<operational>` without `:with-operational-defaults`) | `invalid-value` |
| `<edit-data>` on a datastore that is unsupported or not writable | `invalid-value` |
| `<lock>`/`<unlock>` on a datastore where it isn't supported | `invalid-value` |
| `<validate>` on a datastore where it isn't supported | `invalid-value` |
| `xpath-filter` that doesn't evaluate to a node-set | The operation fails; no tag is specified. |

`origin-filter` on a non-operational datastore is ruled out by a YANG `when` condition, not by a stated error, so the RFC gives no specific tag for it.

## Quirks in the RFC text

- The `<get-data>` example with `config-filter` (§3.1.1.4) and the `<edit-data>` example (§3.1.2.1) both use `message-id="103"`. They are separate examples, not one session. The `<edit-data>` example above uses `104`.
- The `<validate>` augmentation's description says "the specified **target** datastore", although the leaf is in the `source` choice.

## Security considerations

The RFC adds no new risks. The base NETCONF considerations (RFC 6241 §9) apply to `<get-data>` and `<edit-data>`, and NACM (RFC 8341) can restrict who may call them and what content they reach.

## Where it lands in @node-net/netconf

| Concept | RFC | Module |
|---------|-----|--------|
| Detecting NMDA: `:yang-library:1.1` and its `revision`/`content-id` params | 8526 §2 | `messages/capabilities.ts` (`CapabilitySet.get(':yang-library:1.1')`, `Capability.params`) |
| Checking `:with-operational-defaults`, `:xpath`, `:url` and the with-defaults mode before sending | 8526 §3.1.1.2, §4 | `operations/nmda.ts` ([design §8](../../net-netconf-design.md#8-operations-layer-base-operations-and-extensions-operations)), under `capabilityCheck`. The `origin` feature is only visible in the YANG library, so it is left to the server. |
| `getData({ datastore, filter, configFilter, originFilter, negatedOriginFilter, maxDepth, withOrigin, withDefaults })` and `editData({ datastore, defaultOperation, config \| url })`, with descriptors | 8526 §3.1 | `operations/nmda.ts`. `<get-data>`'s `with-defaults` leaf comes from a `uses`d grouping, so it is sent in the ietf-netconf-nmda namespace (verified against netopeer2). |
| Datastore identities as prefixed identityrefs with the prefix declared on the element itself | 8526 §3 | `operations/identities.ts`. Base operations keep `'running' \| 'candidate' \| 'startup'` |
| `lock`/`unlock`/`validate` on NMDA datastores via the `datastore` leaf | 8526 §3.2 | Planned. Today `lock()`/`unlock()` take the base `Datastore` only |
| Reading `or:origin` with inheritance from ancestors | 8526 §3.1.1.1 | `origins()` in `operations/nmda.ts` |
| Caching the YANG library by `content-id` | 8526 §2 | `operations/yang-library.ts` (per client; callers persist across sessions) |
| `read(path, { source: 'operational' })` | | `client-content.ts`: refused with a `TypeError` pointing at `client.ops.nmda.getData()`; `source: 'config+state'` sends `<get>` (design §5.9). Accepting NMDA datastores in `read()` would be an addition |
