# @node-net/netconf

A modern, RFC-compliant NETCONF client for Node.js, written in TypeScript.

**📖 Documentation: [net-netconf.abrahams.nz](https://net-netconf.abrahams.nz)**

> **Status: early development (0.x).** The protocol stack (RFC 6241/6242), the SSH and TLS transports, all base operations, the YANG path API, JSON device profiles and the extensions below work, and are tested against netopeer2. The API may still change before 1.0.

- **The whole protocol:** SSH and TLS, both framings, pipelining, confirmed commits, YANG 1.1 actions, call home, reconnecting with backoff, and typed rpc-errors. Three runtime dependencies, one of them its sibling @node-net/yang.
- **YANG paths with no schema files:** read and write any model the server advertises, by path.
- **YANG data as JSON:** `format: 'json'` returns RFC 7951 JSON, typed by the server's own YANG schema (`<get-schema>`, or modules you supply).
- **Devices as data:** detection, quirks, configuration workflow, named paths and vendor RPCs live in JSON profiles, not code.
- **Opt-in extensions:** NMDA, YANG library, monitoring, with-defaults, notifications, subscriptions and YANG-Push, partial lock, and datastore compare.
- **Safe by default:** host keys are always verified, secrets are never stored or logged, and nothing emits an `'error'` event that could crash your process.

## Install

```sh
npm install @node-net/netconf
```

Node.js 22.12 or later. The package is ESM, and CommonJS code can load it with `require()`.

## Example

```ts
import { connect, ssh, knownHostsFile, subtree, x, RpcError } from '@node-net/netconf';

const IF = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';

await using client = await connect({
  transport: ssh({
    host: 'router1.example.net',
    username: 'admin',
    password: () => process.env.ROUTER_PASSWORD!, // read only when connecting
    hostKey: knownHostsFile(),                     // or 'SHA256:…'; verification is mandatory
  }),
});

// Read
const data = await client.ops.getConfig({ filter: subtree(x('interfaces', { xmlns: IF })) });
for (const intf of data.path('interfaces')?.childrenNamed('interface') ?? []) {
  console.log(intf.child('name')?.text());
}

// Change the candidate datastore and commit
await client.ops.lock('candidate');
try {
  await client.ops.editConfig({
    target: 'candidate',
    config: x('interfaces', { xmlns: IF },
      x('interface', x('name', 'eth0'), x('description', 'uplink'))),
  });
  await client.ops.validate('candidate');
  await client.ops.commit();
} catch (err) {
  if (err instanceof RpcError) console.error(err.tag, err.first.path, err.first.message);
  await client.ops.discardChanges();
  throw err;
} finally {
  await client.ops.unlock('candidate');
}
// `await using` sends <close-session> and closes SSH here, even after an error.
```

Or skip writing XML, and work by YANG path:

```ts
const IF = '/ietf-interfaces:interfaces/interface[name="eth0"]';

await client.content.readValue(`${IF}/description`);
await client.content.read(IF);                          // RFC 7951 JSON: { 'ietf-interfaces:interface': [{ name: 'eth0', enabled: true, … }] }
await client.content.set(`${IF}/description`, 'uplink'); // lock, edit, validate, commit, unlock; discards on failure
```

Next: [getting started](https://net-netconf.abrahams.nz/guide/getting-started), [connecting](https://net-netconf.abrahams.nz/guide/connecting) (SSH keys and agents, jump hosts, TLS), and [Content](https://net-netconf.abrahams.nz/guide/content) (reading and writing by YANG path).

## Device profiles

Device differences live in JSON profiles, not code: detection rules, connection defaults, quirks, how to apply config, named paths, and vendor RPCs as injection-safe XML templates.

```ts
import { autoDetect, builtinDeviceProfiles, loadDeviceProfiles } from '@node-net/netconf';

const profile = autoDetect([...(await loadDeviceProfiles('./my-profiles')), ...(await builtinDeviceProfiles())]);
const client = await connect({ transport, profile });
await client.ops.device.call('cli', { command: 'show version' });
await client.content.readValue('@systemName'); // a named path from the profile
```

| Built-in profile | Device | Status |
|---|---|---|
| `nokia-7210-sas` | Nokia 7210 SAS, classic CLI | verified read-only (TiMOS B-25.9.R5) |
| `nokia-sros-md` | Nokia SR OS, model-driven or mixed mode | unverified |
| `sysrepo-netopeer2` | netopeer2 on sysrepo | verified |

To add a device, see [writing a profile](https://net-netconf.abrahams.nz/profiles/writing). Contributions are welcome.

## Extensions

NETCONF capabilities beyond RFC 6241's own are implemented by opt-in extensions, each imported from its own entry point:

```ts
import { withDefaults } from '@node-net/netconf/operations/with-defaults';

const client = await connect({ transport, extensions: [withDefaults] });
await client.ops.getConfig({ withDefaults: 'report-all' });
```

| Extension | RFC |
|---|---|
| [`monitoring`](https://net-netconf.abrahams.nz/guide/extensions#monitoring) | 6022 |
| [`with-defaults`](https://net-netconf.abrahams.nz/guide/extensions#with-defaults) | 6243 |
| [`nmda`](https://net-netconf.abrahams.nz/guide/extensions#nmda) | 8342, 8526 |
| [`yang-library`](https://net-netconf.abrahams.nz/guide/extensions#yang-library) | 8525, 7895 |
| [`compare`](https://net-netconf.abrahams.nz/guide/extensions#compare) | 9144 |
| [`partial-lock`](https://net-netconf.abrahams.nz/guide/extensions#partial-lock) | 5717 |
| [`notifications`](https://net-netconf.abrahams.nz/guide/notifications) | 5277 |
| [`subscriptions`](https://net-netconf.abrahams.nz/guide/notifications#rfc-8639-subscriptions-and-yang-push) (with YANG-Push, and RFC 9196 capabilities) | 8639, 8640, 8641, 9196 |

Two helpers sit beside them and aren't passed to `extensions`: [`base-notifications`](https://net-netconf.abrahams.nz/guide/notifications#base-notifications-rfc-6470) (RFC 6470) decodes the base notifications, and [`withCandidate()`](https://net-netconf.abrahams.nz/guide/transactions), imported from `@node-net/netconf`, runs a locked candidate transaction (RFC 6241) with cleanup.

Also: [call home](https://net-netconf.abrahams.nz/guide/call-home) (RFC 8071), a [fake server for your tests](https://net-netconf.abrahams.nz/guide/testing), and the [framed message channel](https://net-netconf.abrahams.nz/guide/low-level) for protocol tools. See [RFC support](https://net-netconf.abrahams.nz/rfc-support) for the full list.

## The CLI

`nnc` is an interactive NETCONF client for watching the protocol: it sends operations, traces bytes, frames or XML, connects to production devices read-only, and runs scripts with exit codes. It's the [`@node-net/nnc`](https://github.com/node-net-org/nnc) package. See [the CLI docs](https://net-netconf.abrahams.nz/cli/).

## Development

```sh
npm install
npm run check              # lint, typecheck, layer rules, tests (with coverage floors), build, smoke and pack checks, runtime audit
npm run check:full         # check, plus TypeScript 7, both integration servers, every Node.js line, full audit (Docker)
npm run deps:report        # outdated dependencies and audit findings

scripts/netopeer2.sh start # netopeer2 in Docker: SSH on 127.0.0.1:18300, TLS on 19300 (test-only certificates)
npm run test:integration
scripts/netopeer2.sh stop

scripts/clixon.sh start    # Clixon 7.9 (RFC 9144 compare), built from source on first use: SSH on 127.0.0.1:18400
CLIXON_PORT=18400 npm run test:integration
scripts/clixon.sh stop

npm run lab:def            # the defect server: a NETCONF server that misbehaves on purpose, on 127.0.0.1:18500
```

The compare tests need Clixon, because netopeer2 doesn't implement RFC 9144; they are skipped unless `CLIXON_PORT` is set.

`npm run live:check` runs a read-only check against a real device: one login, then hello and profile detection, `<get>`, `<get-config>` and the profile's named paths. Host, user, jump host, pinned host key and password file all come from `~/.config/net-netconf/live-device.json` (or `$NET_NETCONF_CONFIG`). No device or user names belong in this repository; see the comment at the top of `scripts/live-check.mjs` for the format.

`npm run layers` enforces the architecture ([design §3.2](docs/net-netconf-design.md#32-dependency-rules)): dependencies only point down the RFC 6241 layers (transport, messages, operations, content), no layer imports a device profile or the client, and TypeScript device profiles can only use the public API.

### Checks and releases

There is no CI for changes: what gates a change is these checks, run locally before it lands. Only releases run on GitHub.

- **`npm run check` runs before every landing:** lint, typecheck, layer rules, tests, build, and the smoke, portability, size, pack and export-name checks. The unit tests run with V8 coverage, and fail if coverage of `src/transport`, `src/xml` or `src/messages` drops below its floor (`vitest.config.ts`). Last is the runtime audit: `npm audit --omit=dev` fails the check on any known vulnerability in the runtime dependencies. If the registry can't be reached, the audit is skipped with a loud warning and the check still passes, so it works offline. `NN_REQUIRE_AUDIT=1` makes that skip a failure.
- **`npm run check:full`** (`scripts/check-full.sh`, Docker required) runs `check` with the audit required, then:
  - TypeScript 7: a typecheck with `typescript@7.0.2`, while the repository builds with 6.0 (design §12).
  - The integration suites against netopeer2 and Clixon, each in Docker under its own container name and ports (28300 and up, 28400). It stops them when the run ends, however it ends. A taken port fails the step. Lab servers on 18300, 18400 and 18500 are left alone.
  - `scripts/check-node.sh 22 24 26` (below).
  - The full `npm audit`, development dependencies included, which is reported but never fails.

  It ends with a pass, FAIL or skipped line per step, and fails if any step did. It takes about 25 minutes, most of it the Node.js lines. `--quick` skips those lines, and `--only integration,ts7` runs just the steps named. Without Docker it stops at once.
- **When to run `check:full`:** before landing any change to dependencies, transports, framing or parsing, timing, the release workflow or these check scripts, and whenever unsure. Use `--quick` to iterate, then run it in full. `npm run live:check` (a real device) is never part of either.
- `scripts/install-hooks.sh` installs an opt-in git pre-push hook that runs `npm run check` (`--uninstall` removes it).
- **Updates:** `npm run deps:report` lists outdated dependencies, with in-range updates apart from those needing a range change, and summarises the runtime and full audits.
- The release workflow's actions are pinned to full commit SHAs with the release in a comment, and the netopeer2 image to a digest in `scripts/netopeer2.sh`. Bump netopeer2 by hand: run the integration suite against the new image, then update the version comment there and `testedWith` in `profiles/sysrepo-netopeer2.json`.
- **Every Node.js LTS line that `engines` allows must pass the whole check.** `scripts/check-node.sh` runs `npm install` and `npm run check` for each line in a clean `node:<line>` container, with a copy of the working tree, and reports pass or fail per line (`scripts/check-node.sh 26` checks one). When a new line is promoted to LTS, add it to the script's default lines; when one reaches end of life, drop it and raise `engines`.
- On Node 26, ssh2 1.17 (the latest release) uses its pure-JS crypto, because its optional native binding doesn't compile against Node 26's V8. That's accepted: everything passes, and the cost is a slower SSH handshake (about 3× slower: a median of 125 ms against 43 ms with the binding on Node 24, over loopback; the extra time is a one-off cost per connection). Take an ssh2 release that builds on Node 26 when there is one.
- **Releases:** `npm version patch` (or `minor`, `major`), then `git push --follow-tags`. The tag starts `.github/workflows/release.yml`, which runs `check` and publishes to npm through trusted publishing, so no npm token exists anywhere. Each version carries a provenance statement linking it to its commit. `prepublishOnly` refuses to publish while the `@node-net/yang` version this depends on isn't on npm yet.

### Documentation

- [docs/](docs/) holds the maintainer notes: the [design](docs/net-netconf-design.md), the [RFC survey](docs/rfcs/rfcs.md), and the plan for [integrating @node-net/yang](docs/net-yang-integration-plan.md), now historical.
- The documentation site, [net-netconf.abrahams.nz](https://net-netconf.abrahams.nz), is built from its own repository. Its API reference comes from this package's TSDoc comments.

## Licence

MIT
