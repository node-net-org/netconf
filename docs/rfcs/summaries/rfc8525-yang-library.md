# RFC 8525: YANG Library

This is a conceptual overview of RFC 8525: the ideas in the RFC and how they fit together. It does not reproduce the spec, and where the two differ, the RFC wins. For the RFC's priority and where it lands in the design, see [rfcs.md](../rfcs.md).

Published March 2019. Obsoletes RFC 7895. Defines revision `2019-01-04` of the `ietf-yang-library` YANG module (prefix `yanglib`, namespace `urn:ietf:params:xml:ns:yang:ietf-yang-library`), the `/yang-library` tree and the `yang-library-update` notification. The NETCONF capability that goes with it, `:yang-library:1.1`, is defined in [RFC 8526](./rfc8526-netconf-nmda.md), not here.

## The problem it solves

A client needs to know which YANG modules a server implements, at which revision, with which features and deviations. Without that it can't build valid requests or interpret replies. There have been three answers to that question:

1. **Module capabilities in the hello** (YANG 1.0). Each module is a `?module=…&revision=…` URI in `<hello>`. This is sent on every session, can't be cached, and gets large on servers with hundreds of modules. RFC 7950 (§1.1, §5.6.4) moved YANG 1.1 modules out of the hello and into the YANG library.
2. **RFC 7895's `/modules-state`**. One flat module list with a `module-set-id` for caching. It assumes **every datastore has the same schema**.
3. **RFC 8525's `/yang-library`**. Under NMDA ([RFC 8342](./rfc8342-nmda.md)) that assumption breaks:
   - `<operational>` can hold `config false` modules that no configuration datastore has, such as hardware inventory.
   - A dynamic configuration datastore can have its own schema.
   - A server moving to NMDA may not implement every module in `<operational>` yet.

RFC 8525 keeps the module information but adds **datastores** and **datastore schemas**, so a client can ask "which modules apply to `<running>`?" and get a different answer from "which apply to `<operational>`?".

## The model

Every datastore has one schema. A schema is the **union of one or more module sets**. A module set is a named group of modules and submodules. Datastores can share a schema, and schemas can share module sets.

```
datastore ──has a──▶ schema ──union of──▶ module-set* ──contains──▶ module* + import-only-module*
```

Everything is `config false`, so the library lives only in `<operational>`.

```
yang-library
├── module-set* [name]
│   ├── name                          arbitrary
│   ├── module* [name]                implemented modules
│   │   ├── name, revision?           revision absent if the module has none
│   │   ├── namespace
│   │   ├── location*                 URLs to fetch the source, if any
│   │   ├── submodule* [name]         name, revision?, location*
│   │   ├── feature*                  supported features, incl. those in submodules
│   │   └── deviation*                -> ../../module/name (same module set)
│   └── import-only-module* [name revision]
│       ├── name, revision            revision is "" if the module has none
│       ├── namespace, location*
│       └── submodule* [name]
├── schema* [name]
│   ├── name                          arbitrary
│   └── module-set*                   -> ../../module-set/name
├── datastore* [name]
│   ├── name                          identity, e.g. ds:running, ds:operational
│   └── schema                        -> ../../schema/name
└── content-id                        changes whenever anything above changes

notification yang-library-update
└── content-id
```

### Module versus import-only module

| List | Key | Meaning |
|------|-----|---------|
| `module` | `name` | The server **implements** it (RFC 7950 §5.6.5): its data nodes, RPCs and notifications are reachable, with the listed features and deviations. Keyed by name only, so one revision per module set. |
| `import-only-module` | `name`, `revision` | The server only uses its **definitions** (typedefs, groupings, identities) because another module imports it. Several revisions of the same module may appear when importers ask for different revisions. |

`location` is a URL only. Unlike `/netconf-state/schemas` in [RFC 6022](./rfc6022-netconf-monitoring.md), there is no `NETCONF` value meaning "use `<get-schema>`". If `location` is absent, the server has no URL to offer.

### Which modules apply to a datastore

To get the schema of one datastore:

1. Find the `datastore` entry by its identity (`ds:running`, `ds:operational`, or a vendor identity for a dynamic datastore).
2. Follow its `schema` leaf to the `schema` entry.
3. Take the union of every `module-set` that schema lists.
4. The `module` entries are implemented, with their features and deviations. The `import-only-module` entries are not.

Appendix B of the RFC shows the common case. `ietf-interfaces` and `ietf-ip` are in a `config-modules` set. `ietf-hardware` is in a `state-modules` set. `<running>` and `<startup>` share a `config-schema` that has only `config-modules`. `<operational>` uses a `state-schema` that has both sets, so it holds one more module than the configuration datastores.

```xml
<schema>
  <name>state-schema</name>
  <module-set>config-modules</module-set>
  <module-set>state-modules</module-set>
</schema>
<datastore>
  <name>ds:operational</name>
  <schema>state-schema</schema>
</datastore>
```

Appendix C adds two further cases: a feature (`router-id`) enabled only in `<operational>`, so the leaf can be read but not configured, and a deviation module included only in `<operational>`'s schema.

Which module set a module is placed in carries **no meaning**. Only the resulting per-datastore union matters.

## Rules the server must follow

| Rule | Source |
|------|--------|
| `content-id` **must** change whenever anything else in `/yang-library` changes. The same content need not always give the same `content-id`. | §3, YANG |
| When `content-id` changes, the server sends `yang-library-update`. | §3 |
| A module implemented in several datastores is implemented at the **same revision** in all of them. | §2 objective 4 |
| A **schema** must be referentially complete: every import of every module in it is satisfied. A **module set** need not be. | YANG `schema`, `module-set` |
| If an implemented module appears in more than one module set of a schema, its revision, features and deviations must be identical. | YANG `schema/module-set` |
| There is one `datastore` entry per datastore. All conventional datastores (`running`, `candidate`, `startup`, `intended`) point to the **same** `schema` entry. | §3, YANG |
| A `deviation` must name a module in the same module set, and must not lead back to the deviated module, directly or indirectly. Clients should still survive a module that deviates itself. | YANG `deviation` |
| An NMDA server **should** also populate the deprecated `/modules-state`. | §1 |

The library describes **one protocol's** view. A server with NETCONF and RESTCONF may have a separate library for each.

There is an inconsistency in Appendix C. Its `state-schema` combines `config-state-modules` (which lists `ietf-routing` with no features) and `state-only-modules` (which lists `ietf-routing` with `multiple-ribs` and `router-id`). That breaks the "must be identical" rule above. The RFC doesn't say how to resolve it. A tolerant client shouldn't reject the library, and taking the union of the listed features matches what the example says it intends (the features are enabled in `<operational>`).

## The NETCONF capability

The capability is defined in RFC 8526 §2. Every NMDA NETCONF server must advertise it and implement at least this revision of the library:

```
urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=75a43df9bd56b92aacc156a2958fbe12312fb285
```

| Parameter | Required | Meaning |
|-----------|----------|---------|
| `revision` | Yes | The revision of `ietf-yang-library` the server implements. |
| `content-id` | Yes | The current value of `/yang-library/content-id`. |

RFC 7950 §5.6.4 defines the older form, `:yang-library:1.0?revision=…&module-set-id=…`, whose `module-set-id` mirrors `/modules-state/module-set-id`. RFC 8526 updates that section so a server may advertise `:1.1` and `/yang-library` **instead of** `:1.0` and `/modules-state`.

### Caching with `content-id`

The library can be large and rarely changes, so the client should:

1. Read `content-id` from the hello.
2. If a cached library for **this device** has the same `content-id`, use it without reading anything.
3. Otherwise read `/yang-library` once and cache it under that `content-id`.

`content-id` is only meaningful on the server that produced it, so the cache key must include the device. A changed `content-id` does not guarantee changed content. It only means "read again".

During a session, a change shows up as:

- a `yang-library-update` notification carrying the new `content-id`, for a client subscribed to notifications ([RFC 5277](./rfc5277-event-notifications.md)), and
- on servers that also implement RFC 6470, a `netconf-capability-change` notification, because the `:yang-library:1.1` capability value has changed.

```xml
<notification xmlns="urn:ietf:params:xml:ns:netconf:notification:1.0">
  <eventTime>2026-11-07T10:00:00Z</eventTime>
  <yang-library-update xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-library">
    <content-id>14782ab9bd56b92aacc156a2958fbe12312fb285</content-id>
  </yang-library-update>
</notification>
```

## Reading it

`/yang-library` is state data. Read it from `<operational>` with `<get-data>` ([RFC 8526](./rfc8526-netconf-nmda.md)), or with a `<get>` filtered to the subtree:

```xml
<get>
  <filter type="subtree">
    <yang-library xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-library"/>
  </filter>
</get>
```

## The deprecated `/modules-state` tree

RFC 7895's tree is kept in the module, marked `status deprecated`, together with its `yang-library-change` notification. The RFC says legacy clients will ignore `/yang-library` and NMDA-aware clients will ignore `/modules-state`.

| | `/modules-state` (7895, deprecated) | `/yang-library` (8525) |
|---|---|---|
| Datastores | None. One schema for all. | Per-datastore schemas |
| Module key | `name` + `revision` | `name` within a module set |
| Implemented or imported | `conformance-type`: `implement` or `import` | Separate `module` and `import-only-module` lists |
| Deviations | List of `name` + `revision` | Leaf-list of names |
| Source URL | `schema`, a single URI | `location`, a leaf-list |
| No revision | `revision` is `""` | `revision` absent (`""` for import-only) |
| Cache key | `module-set-id` | `content-id` |
| Change notification | `yang-library-change` | `yang-library-update` |

When an NMDA server fills `/modules-state`, the RFC recommends listing the modules whose `config true` nodes are configurable through the conventional datastores, plus the modules whose `config false` nodes `<get>` returns. That is a merged, datastore-blind view.

What a client should read:

| Server advertises | Read | Notes |
|-------------------|------|-------|
| `:yang-library:1.1` | `/yang-library` | Cache on `content-id`. Use per-datastore schemas. |
| `:yang-library:1.0` only | `/modules-state` | Cache on `module-set-id`. All datastores share one schema. |
| Neither | Module capabilities in the hello | YANG 1.0 servers only. |

Hello module capabilities and the library can coexist: a server may still list YANG 1.0 modules in the hello. When the library is available, it is the complete source.

## Security considerations

- `/yang-library` reveals the device type, vendor and software level through its modules, revisions, features and deviations. An attacker can use that to find servers with known bugs, for example an operation known to crash a particular implementation. Read access should be restricted, for example with NACM (RFC 8341).
- Some of this is already in the hello, but the library exposes more detail.

## Where it lands in @node-net/netconf

| Concept | RFC | Module |
|---------|-----|--------|
| Parsing `revision`, `content-id` and `module-set-id` from the `:yang-library` capability | 8526 §2, 7950 §5.6.4 | `messages/capabilities.ts` (`Capability.params`). `get(':yang-library')` matches any version, so pick `:yang-library:1.1` explicitly. |
| YANG 1.0 modules from the hello | 7950 §5.6.4 | `messages/capabilities.ts` (`CapabilitySet.helloModule()`, `ModuleCapability`) |
| `yangLibrary()`: read `/yang-library` and resolve each datastore to its implemented modules (features, deviations and submodules combined across module sets) and import-only modules | 8525 §3 | `operations/yang-library.ts`, entry point `@node-net/netconf/operations/yang-library` ([design §8](../../net-netconf-design.md#8-operations-layer-base-operations-and-extensions-operations)) |
| Caching the decoded library under `content-id` | 8525 §3, 8526 §2 | One read per session, shared by `yangLibrary()`, `client.content.loadModules()` and the extensions' support checks (`loadYangLibrary()`; `refresh: true` re-reads). The result is plain data for callers to persist per device and `content-id`. Refreshing on `yang-library-update` waits for the notifications extension. |
| Fallback to `/modules-state` on `:yang-library:1.0` servers | 7895, 8525 §4 | `operations/yang-library` ✅: on a server with `:yang-library:1.0` and not 1.1, `/modules-state` is read and returned in the same shape (`version: '1.0'`, one module set named `modules-state`, conformance-type `import` as import-only modules, `contentId` = module-set-id, no schemas or datastores). Integration-tested against netopeer2's real `/modules-state` with 1.1 hidden by a profile. |
| Resolving path module names to namespaces | 8525 §3 | `client.content.moduleNamespace()`: caller-supplied namespaces, then the profile, then hello modules, then the YANG library (`client.content.loadModules()`, loaded lazily by the path methods; 1.1 or 1.0), which only fills gaps ([design §5.5](../../net-netconf-design.md)). |
| Device detection by advertised module | 8525 §3 | `devices/device.ts` matches on hello modules only. Library modules are not considered yet. |
| Choosing modules to fetch for the offline schema index | 8525 §3, 6022 §3.1 | `nnc schema build` CLI (planned, [design §6.4](../../net-netconf-design.md)) |
