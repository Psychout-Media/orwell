"""One shared way for a test to get a listen port (ORW-414): ask the kernel for a free one (bind port 0), never hard-code one.

Browser tests used to bind fixed ports (8796..8799, 8967, 8968, 8893...), so two of them could not run at once inside a CI shard and a
stray local server on the same port made them flaky. Every test stack (front end, engine, stub model, static fixture server) takes its port
from `free_port()` and passes it down (`--port`, `ORWELL_ENGINE_PORT`, a `base_url`). `test_orw414_no_fixed_browser_ports.py` fails on a new
hard-coded listen port in a browser test.

`free_port()` binds 127.0.0.1:0, reads the port, closes. The bind-close-reuse window is tiny and the kernel hands out a different ephemeral
port on each call, and this module also never returns the same port twice in one process.
"""
from __future__ import annotations

import socket
import threading

_lock = threading.Lock()
_handed_out: set[int] = set()


def free_port(host: str = "127.0.0.1") -> int:
    for _ in range(50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind((host, 0))
            port = s.getsockname()[1]
        with _lock:
            if port not in _handed_out:
                _handed_out.add(port)
                return port
    raise RuntimeError("could not find an unused local port")
