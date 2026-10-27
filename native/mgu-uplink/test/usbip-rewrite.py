#!/usr/bin/env python3
# A usbip proxy (listen port -> 127.0.0.1:3240) that rewrites the f_rndis
# gadget's control interface descriptor, 02/02/ff, into Android's RNDIS
# class, e0/01/03, in what the device sends. vm-gadget.sh plug rndis-e0
# attaches through it. A descriptor reply arrives whole in one read.
import socket
import sys
import threading

FROM = bytes([9, 4, 0, 0, 1, 0x02, 0x02, 0xFF])
TO = bytes([9, 4, 0, 0, 1, 0xE0, 0x01, 0x03])


def pump(src, dst, rewrite):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            if rewrite and FROM in data:
                print(f"rewrote {data.count(FROM)} RNDIS control interface descriptor(s)", flush=True)
                data = data.replace(FROM, TO)
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def main():
    port = int(sys.argv[1])
    ls = socket.socket()
    ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    ls.bind(("127.0.0.1", port))
    ls.listen()
    while True:
        c, _ = ls.accept()
        s = socket.create_connection(("127.0.0.1", 3240))
        for sock in (c, s):
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        threading.Thread(target=pump, args=(c, s, False), daemon=True).start()
        threading.Thread(target=pump, args=(s, c, True), daemon=True).start()


main()
