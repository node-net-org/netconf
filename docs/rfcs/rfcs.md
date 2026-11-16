# NETCONF-related RFCs: relevance to @node-net/netconf

Survey date: 2026-11-06. RFC numbers come from memory and were spot-checked against the IETF datatracker. **Verify** any row marked (?) before relying on it.

Importance tiers:

| Tier | Meaning |
|------|---------|
| **P0 – Core** | The library is not a NETCONF client without it. Implemented in the protocol stack (`transport/`, `messages/`, `operations/base`) for v1. |
| **P1 – Extension** | Standard optional capability. Shipped as an opt-in extension (`@node-net/netconf/operations/...`) in v1 or v1.x. |
| **P2 – Awareness** | Shapes error typing, defaults, option names or docs. Little or no dedicated code. |
| **P3 – Out of scope** | Recorded so the decision is explicit. |

## 1. Core protocol and transport

| RFC | Title | Tier | How we use it |
|-----|-------|------|---------------|
| **6241** | Network Configuration Protocol (NETCONF) | **P0** | The specification. Defines `<hello>`, capability exchange, `<rpc>`/`<rpc-reply>` with `message-id`, the `<rpc-error>` model (`error-type`, `error-tag`, `error-severity`, `error-app-tag`, `error-path`, `error-message`, `error-info`), the 9 base operations, and the standard capabilities `:writable-running`, `:candidate`, `:confirmed-commit:1.1`, `:rollback-on-error`, `:validate:1.1`, `:startup`, `:url`, `:xpath`. These drive `messages/` (`Session`, capabilities, `RpcError`) and `operations/base`. |
| **6242** | Using NETCONF over SSH | **P0** | `netconf` SSH subsystem, port 830, **end-of-message framing** (`]]>]]>`, base:1.0) and **chunked framing** (base:1.1), and the switch to chunked framing once both peers advertise base:1.1. Drives `transport/ssh` and `transport/framing`. The chunk-size limits (1..4294967295) are enforced as a security check. |
| 4741, 4742 | NETCONF 1.0, NETCONF over SSH 1.0 (obsoleted by 6241/6242) | **P0 (compat)** | Many devices still speak only `base:1.0`. We advertise both `base:1.0` and `base:1.1` and fall back to EOM framing. Nothing beyond what 6241/6242 already describe for 1.0 peers. **No summary**: 6242 fully specifies EOM framing, and the 1.0 capability differences (`:confirmed-commit:1.0`, `:validate:1.0`, no `remove`) are noted in the [6241 summary](./summaries/rfc6241-netconf.md). |
| **7589** | NETCONF over TLS with Mutual X.509 Authentication | **P1** | Second transport (`transport/tls`) on port 6513, using `node:tls`. Proves that the transport interface really is pluggable. Uses chunked/EOM framing the same as SSH. |
| 5539 | NETCONF over TLS (obsoleted by 7589) | P3 | Not implemented. |
| 4743, 4744 | NETCONF over SOAP, over BEEP | P3 | Dead transports; RFC 9900 (?) deprecates their port assignments. |
| **8071** | NETCONF Call Home and RESTCONF Call Home | **P1** | The device connects to the client (TCP 4334 for SSH, 4335 for TLS), and the client then acts as SSH/TLS *client* over the accepted socket. Needed for devices behind NAT. Implemented as a `CallHomeListener` that produces the same `Session` object, which works only because the transport receives an already-connected socket. |
| 9900 (?) | Updates to NETCONF Transport Port Numbers (Dec 2025) | P2 | Check that our default ports and docs match the current IANA assignments. |
| draft-ietf-netconf-over-quic | NETCONF over QUIC | P3 (watch) | Future transport. It's the test case for the `Connection` interface: adding it must not touch any layer above Transport. |

## 2. Data, datastores and content

| RFC | Title | Tier | How we use it |
|-----|-------|------|---------------|
| **6243** | With-defaults Capability | **P1** | A `withDefaults` option (`report-all`, `trim`, `explicit`, `report-all-tagged`) on `get`, `get-config` and `copy-config`, validated against the advertised `basic-mode` and `also-supported`. Small, and widely implemented. |
| **6022** | YANG Module for NETCONF Monitoring | **P1** | `<get-schema>` to fetch YANG source from the device, plus the `netconf-state` (sessions, schemas, statistics) and `kill-session` workflows. Also the legacy source of module discovery. |
| **8342** | Network Management Datastore Architecture (NMDA) | **P1** | Datastore identities (`ietf-datastores:running`, `intended`, `operational`, …). We model `Datastore` as an open type: one of the three classic names, or an NMDA identity string. |
| **8526** | NETCONF Extensions to Support NMDA | **P1** | `<get-data>` / `<edit-data>`, including `origin` filtering. Gated on the `urn:ietf:params:netconf:capability:yang-library:1.1` capability. |
| **8525** | YANG Library (obsoletes 7895) | **P1** | Module and datastore discovery for NMDA servers. The `content-id` from the hello capability lets callers cache schemas. |
| 7895 | YANG Module Library (obsoleted) | P2 | Fallback discovery on older devices (`modules-state`). |
| **5717** | Partial Lock RPC | P1 (low) | `<partial-lock>` / `<partial-unlock>`. Small opt-in extension; not many devices support it. |
| **9144** | Comparison of NMDA Datastores | P1 (low) | `<compare>` operation, a small opt-in extension. |
| 8808 | YANG Module for Factory Default Settings | P2 | `<factory-reset>` works through generic `rpc()`. Document it as an example; no dedicated code. |
| 7317 | YANG Data Model for System Management | P2 | `system-restart`, `system-shutdown` and `set-current-datetime` work through generic `rpc()`. Documented example only. |
| 9195 | File Format for YANG Instance Data | P2 | Candidate format for test fixtures. Optional. |
| 9196 | YANG Modules Describing Capabilities for Systems and Datastores | P2 | Lets the subscriptions module discover on-change support and subscription periods. |

## 3. Notifications and subscriptions

| RFC | Title | Tier | How we use it |
|-----|-------|------|---------------|
| **5277** | NETCONF Event Notifications | **P0 (routing) / P1 (API)** | The session layer **must** recognise `<notification>` messages (they carry no `message-id`) and route them away from the RPC correlator. That routing belongs to the messages layer (`Session`). `<create-subscription>` with stream, filter and start/stop time is the opt-in `operations/notifications` module, exposed as an `AsyncIterable`. Also defines the `:interleave` capability, which decides whether we may send other RPCs on a session that has an active subscription. |
| **6470** | NETCONF Base Notifications | P1 | Typed decoders for `netconf-config-change`, `netconf-capability-change`, `netconf-session-start/end` and `netconf-confirmed-commit`. Pure functions over parsed XML. |
| **8639** | Subscription to YANG Notifications | P1 | `establish-subscription`, `modify-`, `delete-`, `kill-subscription`, and subscription-state notifications. Module `operations/subscriptions`. |
| **8640** | Dynamic Subscription over NETCONF | P1 | Binds 8639 to NETCONF. Same extension. |
| **8641** | Subscription to YANG Datastores (YANG-Push) | P1 | Periodic and on-change datastore subscriptions, `push-update` / `push-change-update`. Built on the 8639 extension. |
| draft-ietf-netconf-adaptive-subscription | Adaptive Subscription | P3 (watch) | Must be addable as a module without changes to the protocol stack. |

## 4. Access control and security

| RFC | Title | Tier | How we use it |
|-----|-------|------|---------------|
| **8341** | NETCONF Access Control Model (NACM) (obsoletes 6536) | P2 | The server enforces it, not the client. We surface `access-denied` as a distinct, typed error-tag and document the behaviour. No extension. |
| **4251–4254** | SSH architecture, auth, transport, connection | P2 | Implemented by `ssh2`. They shape our security defaults: host-key verification is **mandatory**, and keyboard-interactive (RFC 4256) answers hidden prompts with the password or a caller's handler, never an echoing prompt with the password. |
| **8332**, **8709**, **9142** | rsa-sha2 signatures; Ed25519/Ed448 in SSH; SSH key-exchange method updates | P2 | Define the modern algorithm set. We pass `ssh2`'s defaults minus every legacy algorithm (`DEFAULT_SSH_ALGORITHMS`). Legacy algorithms (ssh-rsa and hmac-sha1/SHA-1, SHA-1 key exchange, CBC ciphers, DSA) can only be enabled explicitly, per connection or through a device profile, and the library logs a warning when they are. |
| 6187 | X.509v3 Certificates for SSH | P3 | `ssh2` does not support it. Use TLS (7589) for certificate auth. |
| **8446**, **9325** (BCP 195) | TLS 1.3; TLS recommendations | P2 | The TLS transport sets `minVersion: 'TLSv1.2'`, prefers 1.3, and requires a client certificate and server verification by default. |
| **9640–9645** | YANG crypto-types, truststore, keystore, tcp-, ssh-, tls-client-server groupings (Oct 2024) | P2 | Inspiration for the *shape* of our connection options (keepalives, host-key/trust-anchor lists, client identity). We don't implement the YANG. |
| draft-ietf-netconf-netconf-client-server | YANG for NETCONF clients and servers (RFC Editor queue) | P2 | Same as above, for call-home reconnect strategy and keepalive semantics. |

## 5. Modelling language and encodings

| RFC | Title | Tier | How we use it |
|-----|-------|------|---------------|
| **7950** / 6020 | YANG 1.1 / YANG 1.0 | P2 | The protocol stack stays **schema-agnostic** and moves XML, not YANG. YANG parsing, compiling and the XML ↔ JSON codecs live in the separate `@node-net/yang` package (`packages/net-yang`), which never depends on @node-net/netconf. Its RFC survey and scope are in [packages/net-yang/docs/rfcs.md](../../../net-yang/docs/rfcs.md). |
| 6991 | Common YANG Data Types | P2 | Reference for value formats such as `date-and-time` (used in 5277 start/stop times). |
| 6244 | Architecture for Network Management Using NETCONF and YANG | P2 | Informational background reading. |
| 7951 | JSON Encoding of YANG Data | P2 | RESTCONF uses it, NETCONF doesn't. Our optional "plain object" projection of replies borrows its conventions (`module:name` keys, arrays for lists) so the output is predictable. |
| 8040 / 8072 / 8650 | RESTCONF / YANG Patch / RESTCONF subscriptions | P3 | Different protocol. A future sibling package could reuse `errors` and the XML codec. |
| 8528, 8529 | Schema Mount; Network Instances | P3 | Data-model matters for callers; no protocol impact. |
| 8572 | Secure Zero Touch Provisioning | P3 | Out of scope. |
| 7758 | Time Capability (Experimental) | P3 | Out of scope. |

## 6. Active drafts to design for (not implement)

These drafts are the extensibility test. Each of them should be addable as an extension or transport **without modifying the layers below it**:

- `draft-ietf-netconf-privcand`: private candidate datastores (new capability, new datastore semantics).
- `draft-ietf-netconf-transaction-id`: ETag-like `txid` attributes on get/edit.
- `draft-ietf-netconf-list-pagination(-nc)`: pagination parameters on `get`/`get-data`.
- `draft-ietf-netconf-over-quic`: new transport.
- `draft-ietf-netmod-system-config`: the `system` datastore (a new NMDA identity, so it needs no code if `Datastore` is open-ended).

## Summary: what v1 must implement

1. **P0:** RFC 6241, RFC 6242 (both framings), 1.0 fallback, and 5277 notification routing.
2. **P1, v1.0:** 6243 with-defaults, 6022 get-schema, 8342/8526/8525 NMDA, 5277 create-subscription, 6470 decoders, 7589 TLS.
3. **P1, v1.x:** 8639/8640/8641 subscriptions and YANG-Push, 8071 call home, 5717, 9144.
4. Everything else feeds into defaults, error typing or documentation.

## Sources

- [IETF NETCONF WG datatracker](https://datatracker.ietf.org/wg/netconf/)
- [RFC 9900: Updates to NETCONF Transport Port Numbers](https://datatracker.ietf.org/doc/rfc9900/)
- [draft-ietf-netconf-netconf-client-server](https://www.ietf.org/archive/id/draft-ietf-netconf-netconf-client-server-39.html)
- [draft-ietf-netconf-privcand-08](https://datatracker.ietf.org/doc/html/draft-ietf-netconf-privcand-08)
- [draft-ietf-netconf-over-quic-06](https://datatracker.ietf.org/doc/html/draft-ietf-netconf-over-quic-06)
- [IETF 124 NETCONF chair slides](https://datatracker.ietf.org/meeting/124/materials/slides-124-netconf-0-chair-slides-01)
