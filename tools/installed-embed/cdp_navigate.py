#!/usr/bin/env python3
"""Tiny stdlib-only CDP Page.navigate helper for the installed-embed PoC."""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
import os
import socket
import struct
import sys
import time
import urllib.request
from urllib.parse import urlparse


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=2) as r:
        return json.loads(r.read().decode("utf-8"))


def wait_for_page(port: int, timeout: float) -> dict:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            tabs = get_json(f"http://127.0.0.1:{port}/json/list")
            for tab in tabs:
                if tab.get("type") == "page" and tab.get("webSocketDebuggerUrl"):
                    return tab
            last = f"no page targets in {tabs!r}"
        except Exception as e:  # noqa: BLE001 - diagnostic helper
            last = repr(e)
        time.sleep(0.2)
    raise RuntimeError(f"No CDP page target on port {port}: {last}")


def ws_connect(ws_url: str) -> socket.socket:
    u = urlparse(ws_url)
    if u.scheme != "ws":
        raise ValueError(f"Only ws:// is supported, got {ws_url}")
    host = u.hostname or "127.0.0.1"
    port = u.port or 80
    path = u.path or "/"
    if u.query:
        path += "?" + u.query
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode("ascii")
    s = socket.create_connection((host, port), timeout=3)
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    )
    s.sendall(request.encode("ascii"))
    response = b""
    while b"\r\n\r\n" not in response:
        chunk = s.recv(4096)
        if not chunk:
            raise RuntimeError("CDP websocket closed during handshake")
        response += chunk
    header = response.decode("iso-8859-1", errors="replace")
    if " 101 " not in header.split("\r\n", 1)[0]:
        raise RuntimeError(f"CDP websocket handshake failed: {header.splitlines()[0] if header else header}")
    if expected.lower() not in header.lower():
        raise RuntimeError("CDP websocket accept key mismatch")
    return s


def ws_send_json(s: socket.socket, payload: dict):
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    mask = os.urandom(4)
    if len(data) < 126:
        header = bytes([0x81, 0x80 | len(data)])
    elif len(data) < 65536:
        header = bytes([0x81, 0x80 | 126]) + struct.pack("!H", len(data))
    else:
        header = bytes([0x81, 0x80 | 127]) + struct.pack("!Q", len(data))
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    s.sendall(header + mask + masked)


def ws_recv_json(s: socket.socket, wanted_id: int, timeout: float) -> dict:
    s.settimeout(timeout)
    deadline = time.time() + timeout
    while time.time() < deadline:
        b1b2 = s.recv(2)
        if len(b1b2) < 2:
            raise RuntimeError("short websocket frame")
        b1, b2 = b1b2
        opcode = b1 & 0x0F
        masked = bool(b2 & 0x80)
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack("!H", s.recv(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", s.recv(8))[0]
        mask = s.recv(4) if masked else b""
        data = b""
        while len(data) < length:
            chunk = s.recv(length - len(data))
            if not chunk:
                raise RuntimeError("websocket closed mid-frame")
            data += chunk
        if masked:
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        if opcode == 0x8:
            raise RuntimeError("websocket close frame")
        if opcode != 0x1:
            continue
        msg = json.loads(data.decode("utf-8"))
        if msg.get("id") == wanted_id:
            return msg
    raise TimeoutError(f"No CDP response for id={wanted_id}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9333)
    ap.add_argument("--url", required=True)
    ap.add_argument("--timeout", type=float, default=10.0)
    args = ap.parse_args()
    tab = wait_for_page(args.port, args.timeout)
    ws_url = tab["webSocketDebuggerUrl"]
    s = ws_connect(ws_url)
    try:
        ws_send_json(s, {"id": 1, "method": "Page.enable"})
        enabled = ws_recv_json(s, 1, args.timeout)
        ws_send_json(s, {"id": 2, "method": "Page.navigate", "params": {"url": args.url}})
        nav = ws_recv_json(s, 2, args.timeout)
    finally:
        try:
            s.close()
        except Exception:
            pass
    print(json.dumps({"targetId": tab.get("id"), "fromTitle": tab.get("title"), "fromUrl": tab.get("url"), "enabled": enabled, "navigate": nav}, indent=2, sort_keys=True))
    if "error" in nav:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
