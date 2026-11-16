#!/usr/bin/env bash
# Start a Clixon NETCONF server in Docker for the RFC 9144 compare integration tests.
#   scripts/clixon.sh start   # SSH on 127.0.0.1:${CLIXON_PORT:-18400}, user netconf/netconf
#   scripts/clixon.sh stop
# netopeer2 doesn't implement ietf-nmda-compare; Clixon 7.6+ does. The image
# (scripts/clixon/Dockerfile) is built from source on first use, which takes a
# few minutes; set CLIXON_IMAGE to use another one.
set -euo pipefail
NAME=${CLIXON_NAME:-nn-clixon}
PORT=${CLIXON_PORT:-18400}
# Keep in step with CLIXON_VERSION's default in scripts/clixon/Dockerfile, which CI builds.
VERSION=7.9.0
IMAGE=${CLIXON_IMAGE:-nn-clixon:${VERSION}}
CONTEXT="$(cd "$(dirname "$0")/clixon" && pwd)"

case "${1:-start}" in
  start)
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "building $IMAGE (Clixon ${VERSION} from source)..."
      docker build -q --build-arg "CLIXON_VERSION=${VERSION}" -t "$IMAGE" "$CONTEXT" >/dev/null
    fi
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:830" "$IMAGE" >/dev/null
    ready=0
    for _ in $(seq 1 30); do
      # The backend's socket exists once it accepts sessions; sshd renames its process, so match by name only.
      if docker exec "$NAME" sh -c 'test -S /usr/local/var/run/example.sock && pgrep sshd >/dev/null' 2>/dev/null; then
        ready=1
        break
      fi
      sleep 1
    done
    if [ "$ready" -ne 1 ]; then
      echo "clixon didn't start; container log:" >&2
      docker logs "$NAME" >&2 || true
      exit 1
    fi
    echo "clixon ready on 127.0.0.1:${PORT} (SSH)"
    ;;
  stop)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 2
    ;;
esac
