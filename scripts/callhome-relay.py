#!/usr/bin/env python3
"""Call-home relay for the netopeer2 test container (RFC 8071 integration tests).

Some hosts drop TCP from containers to the host, so netopeer2 can't call home
to a listener on the host directly. This relay runs inside the container:

  netopeer2 --call home--> 127.0.0.1:<home_port>   (inside the container)
  test host --connect----> 0.0.0.0:<host_port>     (published to the host)

It pairs each call-home connection with the next connection from the host,
oldest first, and copies bytes both ways until either side closes. A call
that no host connection takes within a second is closed (netopeer2 then dials
again), so a waiting call never blocks netopeer2's configuration. The test
harness then pipes its host connection into the library's call-home listener,
so the listener sees the device's bytes exactly as if it had accepted them.

Usage: callhome-relay.py <home_port>:<host_port> [<home_port>:<host_port> ...]
"""

import socket
import sys
import threading
from collections import deque

UNPAIRED_SECONDS = 1.0


def pump(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            s.close()


def splice(a, b):
    threading.Thread(target=pump, args=(a, b), daemon=True).start()
    threading.Thread(target=pump, args=(b, a), daemon=True).start()


def relay(home_port, host_port):
    calls, hosts = deque(), deque()
    lock = threading.Lock()

    def alive(conn):
        """False if the peer has closed (a call that gave up waiting for the host)."""
        try:
            return conn.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) != b''
        except BlockingIOError:
            return True
        except OSError:
            return False

    def pair():
        with lock:
            for queue in (calls, hosts):
                for conn in [c for c in queue if not alive(c)]:
                    queue.remove(conn)
                    conn.close()
            while calls and hosts:
                splice(calls.popleft(), hosts.popleft())

    def accept_loop(port, address, queue):
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((address, port))
        server.listen(16)
        while True:
            conn, _ = server.accept()
            with lock:
                queue.append(conn)
            pair()

    def drop_if_unpaired(conn):
        with lock:
            if conn in calls:
                calls.remove(conn)
                conn.close()

    def call_loop():
        # A call nobody on the host is waiting for is closed after UNPAIRED_SECONDS:
        # netopeer2 handles each call in a thread that blocks until the SSH/TLS
        # handshake starts, and while it blocks, edits to ietf-netconf-server time
        # out. Closed, the call fails fast and netopeer2 dials again later.
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(('127.0.0.1', home_port))
        server.listen(16)
        while True:
            conn, _ = server.accept()
            with lock:
                calls.append(conn)
            timer = threading.Timer(UNPAIRED_SECONDS, drop_if_unpaired, args=(conn,))
            timer.daemon = True
            timer.start()
            pair()

    threading.Thread(target=call_loop, daemon=True).start()
    threading.Thread(target=accept_loop, args=(host_port, '0.0.0.0', hosts), daemon=True).start()


if __name__ == '__main__':
    for spec in sys.argv[1:]:
        home, host = spec.split(':')
        relay(int(home), int(host))
    threading.Event().wait()
