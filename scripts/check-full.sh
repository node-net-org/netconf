#!/usr/bin/env bash
# The full check: everything `npm run check` runs, plus the checks too slow or
# too heavy for every landing. Run it before landing any change to dependencies,
# transports, framing or parsing, timing, CI files or these scripts, and whenever
# unsure (README, "Development").
#   npm run check:full                      # every step (about 25 minutes)
#   npm run check:full -- --quick           # without the Node.js lines
#   npm run check:full -- --only ts7,integration
# Steps:
#   check         npm run check, with the runtime audit required (it fails offline)
#   ts7           typecheck with TypeScript 7.0.2
#   integration   npm run test:integration against netopeer2 and Clixon in Docker
#   node-lines    scripts/check-node.sh 22 24 26 (skipped by --quick)
#   audit-full    npm audit with development dependencies: reported, never fails
# Docker is required; without it the run stops before any step. Every step runs
# even when an earlier one failed, and a pass/FAIL line per step ends the run.
#
# The integration servers are this run's own: containers nn-checkfull-*-<pid>
# on ports 28300 (netopeer2 SSH, with TLS on 29300 and call home on 30300 and
# 31300) and 28400 (Clixon), or CHECK_FULL_NETOPEER2_PORT / CHECK_FULL_CLIXON_PORT.
# A taken port fails the step; it is never borrowed. The containers are removed
# when the run ends, however it ends. Lab servers (18300, 18400, lab:def on
# 18500) are left alone, and no step connects to a real device.
# The do_* functions (and cleanup, from a trap) run indirectly.
# shellcheck disable=SC2317
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

ALL_STEPS=(check ts7 integration node-lines audit-full)
QUICK=0
ONLY=""
usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --only) ONLY="${2:-}"; shift ;;
    --only=*) ONLY="${1#--only=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "check:full: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

STEPS=()
if [ -n "$ONLY" ]; then
  IFS=, read -r -a STEPS <<<"$ONLY"
  for s in "${STEPS[@]}"; do
    [[ " ${ALL_STEPS[*]} " == *" $s "* ]] || { echo "check:full: no step named '$s' (steps: ${ALL_STEPS[*]})" >&2; exit 2; }
  done
else
  STEPS=("${ALL_STEPS[@]}")
fi

LOGS=$(mktemp -d -t check-full.XXXXXX)
N2_PORT=${CHECK_FULL_NETOPEER2_PORT:-28300}
CX_PORT=${CHECK_FULL_CLIXON_PORT:-28400}
N2_NAME="nn-checkfull-netopeer2-$$"
CX_NAME="nn-checkfull-clixon-$$"

cleanup() {
  NETOPEER2_NAME=$N2_NAME scripts/netopeer2.sh stop >/dev/null 2>&1 || true
  CLIXON_NAME=$CX_NAME scripts/clixon.sh stop >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'echo; echo "check:full: interrupted" >&2; exit 130' INT TERM

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "check:full: FAIL: Docker is required (integration servers and Node.js lines) and isn't available." >&2
  echo "Start Docker, or check that this user can reach it (docker info), then run again." >&2
  exit 2
fi

declare -A RESULT TIME
selected() { [[ " ${STEPS[*]} " == *" $1 "* ]]; }

# step NAME COMMAND...: run one step, logging to $LOGS/NAME.log, and record its result.
step() {
  local name=$1; shift
  local log="$LOGS/$name.log" start=$SECONDS
  echo "== $name (log: $log)"
  if "$@" >"$log" 2>&1; then RESULT[$name]=pass; else RESULT[$name]=FAIL; fi
  TIME[$name]=$((SECONDS - start))
  echo "   $name: ${RESULT[$name]} in $((TIME[$name] / 60))m$((TIME[$name] % 60))s"
  if [ "${RESULT[$name]}" = FAIL ]; then tail -n 25 "$log" | sed 's/^/   | /'; fi
}

do_check() { NN_REQUIRE_AUDIT=1 npm run check; }

do_ts7() {
  npx --yes -p typescript@7.0.2 tsc --noEmit -p .
}

# Fails, naming the port, if anything is listening on 127.0.0.1:PORT. It binds
# and closes; it never connects, so whatever holds the port isn't disturbed.
port_free() {
  # shellcheck disable=SC2016 # JavaScript, not shell
  node -e '
    const s = require("node:net").createServer();
    s.once("error", () => { console.error(`port ${process.argv[1]} is taken`); process.exit(1); });
    s.listen(Number(process.argv[1]), "127.0.0.1", () => s.close());
  ' "$1"
}

do_integration() {
  local p
  for p in "$N2_PORT" $((N2_PORT + 1000)) $((N2_PORT + 2000)) $((N2_PORT + 3000)) "$CX_PORT"; do
    port_free "$p" || return 1
  done
  NETOPEER2_NAME=$N2_NAME NETOPEER2_PORT=$N2_PORT scripts/netopeer2.sh start || return 1
  CLIXON_NAME=$CX_NAME CLIXON_PORT=$CX_PORT scripts/clixon.sh start || return 1
  NETOPEER2_PORT=$N2_PORT NETOPEER2_TLS_PORT=$((N2_PORT + 1000)) \
    NETOPEER2_CALLHOME_PORT=$((N2_PORT + 2000)) NETOPEER2_CALLHOME_TLS_PORT=$((N2_PORT + 3000)) \
    CLIXON_PORT=$CX_PORT npm run test:integration
  local rc=$?
  cleanup
  return "$rc"
}

do_node_lines() { CHECK_NODE_LOGS="$LOGS/node-lines" scripts/check-node.sh 22 24 26; }

# Reported, never failing: development advisories are for the next update.
do_audit_full() {
  # shellcheck disable=SC2016 # JavaScript, not shell
  node --input-type=module -e '
    import { npmAudit, formatCounts } from "./scripts/npm-audit.mjs";
    const r = npmAudit({ omitDev: false });
    if (r.status === "ok" || r.status === "vulnerable") {
      console.log(`${r.total} known (${formatCounts(r.counts)})`);
      for (const p of r.packages) console.log(`  ${p.severity.padEnd(9)} ${p.name}`);
    } else {
      console.log(`not run: ${r.detail}`);
    }
  '
}

total_start=$SECONDS
for s in "${ALL_STEPS[@]}"; do
  if ! selected "$s"; then continue; fi
  case $s in
    check) step check do_check ;;
    ts7) step ts7 do_ts7 ;;
    integration) step integration do_integration ;;
    node-lines)
      if [ "$QUICK" = 1 ]; then RESULT[node-lines]="skipped (--quick)"; echo "== node-lines: skipped (--quick)"
      else step node-lines do_node_lines; fi ;;
    audit-full)
      echo "== audit-full (log: $LOGS/audit-full.log)"
      do_audit_full >"$LOGS/audit-full.log" 2>&1
      RESULT[audit-full]="report: $(head -n 1 "$LOGS/audit-full.log")" ;;
  esac
done

echo
echo "check:full summary ($(( (SECONDS - total_start) / 60 ))m$(( (SECONDS - total_start) % 60 ))s)"
failed=0
for s in "${ALL_STEPS[@]}"; do
  selected "$s" || continue
  t=""
  [ -n "${TIME[$s]:-}" ] && t=" ($((TIME[$s] / 60))m$((TIME[$s] % 60))s)"
  printf '  %-12s %s%s\n' "$s" "${RESULT[$s]}" "$t"
  [ "${RESULT[$s]}" = FAIL ] && failed=1
done
echo "logs: $LOGS"
if [ "$failed" = 1 ]; then echo "check:full: FAIL"; else echo "check:full: pass"; fi
exit "$failed"
