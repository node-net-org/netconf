# Clixon NETCONF server for integration tests (scripts/clixon.sh).
#
# Clixon 7.6+ implements RFC 9144 <compare>, which netopeer2 doesn't. Its
# Docker Hub image stops at 7.3, so this builds a pinned release from source:
# cligen, clixon (no RESTCONF) and its example application (clixon-example
# YANG, running/candidate/startup), with the YANG library switched on.
# NETCONF is the sshd netconf subsystem on port 830, user netconf/netconf
# (TEST-ONLY credentials).
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS build
# CI builds with this default; scripts/clixon.sh passes the same version.
ARG CLIXON_VERSION=7.9.0
RUN apk add --no-cache git make build-base gcc flex bison curl-dev openssl-dev shadow
WORKDIR /src
RUN git clone --depth 1 --branch ${CLIXON_VERSION} https://github.com/clicon/cligen.git \
 && cd cligen && ./configure --prefix=/usr/local --sysconfdir=/etc && make && make install && make DESTDIR=/out install
RUN git clone --depth 1 --branch ${CLIXON_VERSION} https://github.com/clicon/clixon.git \
 && cd clixon && ./configure --prefix=/usr/local --sysconfdir=/etc --with-cligen=/usr/local --without-restconf \
 && make && make install && make install-include && make DESTDIR=/out install && make DESTDIR=/out install-include
RUN cd clixon/example/main && make && make DESTDIR=/out install \
 && mkdir -p /out/usr/local/etc/clixon \
 && sed 's#<CLICON_YANG_LIBRARY>false</CLICON_YANG_LIBRARY>#<CLICON_YANG_LIBRARY>true</CLICON_YANG_LIBRARY>#' example.xml \
    > /out/usr/local/etc/clixon/example.xml \
 && grep -q '<CLICON_YANG_LIBRARY>true</CLICON_YANG_LIBRARY>' /out/usr/local/etc/clixon/example.xml

FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN apk add --no-cache openssh flex bison openssl \
 && adduser -D -H clicon \
 && adduser -s /bin/sh -D netconf && adduser netconf clicon && echo 'netconf:netconf' | chpasswd \
 && ssh-keygen -A \
 && echo 'Subsystem netconf /usr/local/bin/clixon_netconf -f /usr/local/etc/clixon/example.xml' >> /etc/ssh/sshd_config \
 && echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config
COPY --from=build /out/ /
EXPOSE 830
CMD ["/bin/sh", "-c", "/usr/local/sbin/clixon_backend -s init -l e -f /usr/local/etc/clixon/example.xml && exec /usr/sbin/sshd -D -e -p 830"]
