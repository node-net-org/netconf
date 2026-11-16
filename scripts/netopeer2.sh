#!/usr/bin/env bash
# Start a netopeer2 NETCONF server in Docker for integration tests.
#   scripts/netopeer2.sh start   # SSH on 127.0.0.1:${NETOPEER2_PORT:-18300}, user netconf/netconf
#                                # TLS on 127.0.0.1:${NETOPEER2_TLS_PORT:-PORT+1000} (RFC 7589)
#   scripts/netopeer2.sh stop
#   NETOPEER2_LAB=1 scripts/netopeer2.sh start   # also the lab models (NPX, see lab() below)
# The TLS endpoint uses the TEST-ONLY certificates in test/fixtures/tls: the
# server presents server.pem, and any client certificate signed by ca.pem is
# accepted, its CN becoming the NETCONF user (cert-to-name common-name).
# NACM gives the netconf user an explicit permit-all rule, which also covers
# nodes marked nacm:default-deny-all (the NACM tree itself, kill-session).
#
# Call home (RFC 8071): some hosts drop TCP from containers to the host, so a
# relay inside the container (scripts/callhome-relay.py) takes netopeer2's
# calls on 127.0.0.1:4334 (SSH) and :4335 (TLS) and pairs each with a
# connection from the host on 127.0.0.1:${NETOPEER2_CALLHOME_PORT:-PORT+2000}
# (SSH) or PORT+3000 (TLS). The tests configure netopeer2 to call home.
set -euo pipefail
NAME=${NETOPEER2_NAME:-nn-netopeer2}
PORT=${NETOPEER2_PORT:-18300}
TLS_PORT=${NETOPEER2_TLS_PORT:-$((PORT + 1000))}
CH_SSH_PORT=${NETOPEER2_CALLHOME_PORT:-$((PORT + 2000))}
CH_TLS_PORT=${NETOPEER2_CALLHOME_TLS_PORT:-$((PORT + 3000))}
RELAY="$(cd "$(dirname "$0")" && pwd)/callhome-relay.py"
# Pinned by digest: the integration tests assert this build's quirks. It holds
# netopeer2 2.1.49, sysrepo 2.2.36 and libyang 2.1.30 (built 2023-02-01; the
# image's :latest as of 2026-11-14). No automation sees this line, so bump it
# by hand: run the integration suite against the new image, then update these
# versions and testedWith in profiles/sysrepo-netopeer2.json.
IMAGE=${NETOPEER2_IMAGE:-sysrepo/sysrepo-netopeer2@sha256:36cc1d841c97f118d62f775024d60fb1ce210c3bca6b32135c1a9e5a358a1cc9}
FIXTURES="$(cd "$(dirname "$0")/../test/fixtures/tls" && pwd)"
YANG="$(cd "$(dirname "$0")/../test/fixtures/yang" && pwd)"
LAB_ENTRIES=${NETOPEER2_LAB_ENTRIES:-500}

# NETOPEER2_LAB=1: the manual-testing lab target NPX.
# Installs iana-if-type (the image's own copy), nn-lab and sysrepo's oven example,
# loads seed data for ietf-interfaces and nn-lab plus NETOPEER2_LAB_ENTRIES list
# entries, and runs sysrepo-plugind with the oven plugin for live state, RPCs and
# the oven-ready notification. The automated suite runs without it.
lab() {
  docker cp "$YANG/." "$NAME:/tmp/nn-yang/"
  docker exec -e LAB_ENTRIES="$LAB_ENTRIES" "$NAME" sh -c 'set -e
sysrepoctl -i /opt/dev/sysrepo/tests/files/iana-if-type.yang
sysrepoctl -i /tmp/nn-yang/nn-lab.yang -s /tmp/nn-yang
sysrepoctl -i /opt/dev/sysrepo/examples/plugin/oven.yang
sysrepocfg --import=/tmp/nn-yang/interfaces.xml -d running -f xml -m ietf-interfaces
sysrepocfg --import=/tmp/nn-yang/nn-lab.xml -d running -f xml -m nn-lab
{
  echo "<lab xmlns=\"urn:net-netconf:lab\">"
  i=1
  while [ "$i" -le "$LAB_ENTRIES" ]; do
    echo "<entry><id>$i</id><description>lab entry $i, padding the reply so it pages and can reach maxMessageBytes</description></entry>"
    i=$((i + 1))
  done
  echo "</lab>"
} > /tmp/nn-yang/entries.xml
sysrepocfg --edit=/tmp/nn-yang/entries.xml -d running -f xml -m nn-lab
sysrepocfg --copy-from=running -d startup -m ietf-interfaces
sysrepocfg --copy-from=running -d startup -m nn-lab
sysrepo-plugind -P /opt/dev/sysrepo/build/examples/oven.so
sysrepo-plugind -v warning -p /tmp/plugind.pid'
  for _ in $(seq 1 30); do
    docker exec "$NAME" test -s /tmp/plugind.pid 2>/dev/null && return 0
    sleep 1
  done
  echo "sysrepo-plugind did not start" >&2
  return 1
}

case "${1:-start}" in
  start)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:830" -p "127.0.0.1:${TLS_PORT}:6513" \
      -p "127.0.0.1:${CH_SSH_PORT}:9334" -p "127.0.0.1:${CH_TLS_PORT}:9335" "$IMAGE" >/dev/null
    for _ in $(seq 1 30); do
      docker exec "$NAME" sh -c 'pgrep -x netopeer2-server >/dev/null' 2>/dev/null && break
      sleep 1
    done
    docker exec "$NAME" sh -c 'cat > /tmp/nacm.xml <<XML
<nacm xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-acm">
  <write-default>permit</write-default>
  <exec-default>permit</exec-default>
  <groups>
    <group><name>nn-admin</name><user-name>netconf</user-name></group>
  </groups>
  <rule-list>
    <name>nn-admin-all</name>
    <group>nn-admin</group>
    <rule>
      <name>permit-all</name>
      <module-name>*</module-name>
      <access-operations>*</access-operations>
      <action>permit</action>
    </rule>
  </rule-list>
</nacm>
XML
sysrepocfg --edit=/tmp/nacm.xml -d running -f xml -m ietf-netconf-acm'
    docker exec "$NAME" mkdir -p /tmp/nn-tls
    for f in ca.pem server.pem server.key; do docker cp "$FIXTURES/$f" "$NAME:/tmp/nn-tls/$f"; done
    docker exec "$NAME" sh -c 'cd /tmp/nn-tls
der() { openssl "$@" -outform DER | base64 -w0; }
FP=$(openssl x509 -in ca.pem -noout -fingerprint -sha256 | cut -d= -f2)
cat > ks.xml <<XML
<keystore xmlns="urn:ietf:params:xml:ns:yang:ietf-keystore"><asymmetric-keys><asymmetric-key>
  <name>nn-tls-key</name><algorithm>rsa2048</algorithm>
  <public-key>$(der pkey -in server.key -pubout)</public-key>
  <private-key>$(der pkcs8 -topk8 -nocrypt -in server.key)</private-key>
  <certificates><certificate><name>nn-tls-cert</name><cert>$(der x509 -in server.pem)</cert></certificate></certificates>
</asymmetric-key></asymmetric-keys></keystore>
XML
cat > ts.xml <<XML
<truststore xmlns="urn:ietf:params:xml:ns:yang:ietf-truststore"><certificates>
  <name>nn-ca</name><certificate><name>nn-ca-cert</name><cert>$(der x509 -in ca.pem)</cert></certificate>
</certificates></truststore>
XML
cat > srv.xml <<XML
<netconf-server xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-server"><listen><endpoint>
  <name>nn-tls</name>
  <tls>
    <tcp-server-parameters><local-address>0.0.0.0</local-address><local-port>6513</local-port></tcp-server-parameters>
    <tls-server-parameters>
      <server-identity><keystore-reference><asymmetric-key>nn-tls-key</asymmetric-key><certificate>nn-tls-cert</certificate></keystore-reference></server-identity>
      <client-authentication>
        <required/>
        <ca-certs>nn-ca</ca-certs>
        <cert-maps><cert-to-name>
          <id>1</id>
          <fingerprint>04:$FP</fingerprint>
          <map-type xmlns:x509c2n="urn:ietf:params:xml:ns:yang:ietf-x509-cert-to-name">x509c2n:common-name</map-type>
        </cert-to-name></cert-maps>
      </client-authentication>
    </tls-server-parameters>
  </tls>
</endpoint></listen></netconf-server>
XML
sysrepocfg --edit=ks.xml -d running -f xml -m ietf-keystore
sysrepocfg --edit=ts.xml -d running -f xml -m ietf-truststore
sysrepocfg --edit=srv.xml -d running -f xml -m ietf-netconf-server'
    docker cp "$RELAY" "$NAME:/tmp/callhome-relay.py"
    docker exec -d "$NAME" python3 /tmp/callhome-relay.py 4334:9334 4335:9335
    if [ "${NETOPEER2_LAB:-0}" = 1 ]; then lab; fi
    echo "netopeer2 ready on 127.0.0.1:${PORT} (SSH) and 127.0.0.1:${TLS_PORT} (TLS);" \
      "call-home relay on 127.0.0.1:${CH_SSH_PORT} (SSH) and 127.0.0.1:${CH_TLS_PORT} (TLS)"
    if [ "${NETOPEER2_LAB:-0}" = 1 ]; then echo "lab models installed (NPX): iana-if-type, nn-lab, oven"; fi
    ;;
  stop)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 2
    ;;
esac
