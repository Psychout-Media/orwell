#!/usr/bin/env python3
"""ORW-426: the repository is PUBLIC. Fail when a tracked file carries an internal address, a host name or a real user's home path (the card's Hard do-not, CLAUDE.md).

Never allowed: 10.0.1.x (the lab LAN), the lab's host names, a /home/<name> path for any name but the generic ones below.
Allowed (documented examples, test fixtures and the SSRF block lists): 192.168.0.0, .0.1, .0.2, 192.168.1.1, .1.20, .1.50, .1.100, and /home/user, /home/runner, /home/settings.
Prints path:line and the KIND of hit, never the line itself (a failing run must not republish what it found). Usage: check_no_internal_details.py [ROOT]   (exit 1 on a hit)."""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent)
SELF = {"ci/check_no_internal_details.py", "tests/unit/ciNoInternalDetails.test.ts"}
ALLOWED_192 = {"192.168.0.0", "192.168.0.1", "192.168.0.2", "192.168.1.1", "192.168.1.20", "192.168.1.50", "192.168.1.100"}
ALLOWED_HOME = {"user", "runner", "settings"}
RULES = [
    ("internal LAN address 10.0.1.x", re.compile(r"\b10\.0\.1\.\d{1,3}\b"), lambda m: False),
    ("private 192.168.x.y address", re.compile(r"\b192\.168\.\d{1,3}\.\d{1,3}\b"), lambda m: m.group(0) in ALLOWED_192),
    ("a real user's /home path", re.compile(r"/home/([A-Za-z0-9_.-]+)"), lambda m: m.group(1) in ALLOWED_HOME),
    ("internal host name", re.compile(r"\b(?:proxnode\d*|ubuntuide\d*|hnet00|rhinoide\d*|tradeagent)\b", re.I), lambda m: False),
]


def main() -> int:
    files = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-z"], capture_output=True, check=True).stdout.decode().split("\0")
    bad = []
    for f in filter(None, files):
        if f in SELF:
            continue
        p = ROOT / f
        try:
            data = p.read_bytes()
        except OSError:
            continue
        if b"\0" in data[:4096]:
            continue  # binary
        for n, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
            for kind, rx, allowed in RULES:
                for m in rx.finditer(line):
                    if not allowed(m):
                        bad.append(f"{f}:{n}: {kind}")
    for b in sorted(set(bad)):
        print(f"::error::{b}")
    if bad:
        print(f"{len(set(bad))} internal detail(s) in tracked files: the repository is public (ORW-426). Use <host>/<user> placeholders and an ORW card number; keep the evidence on the board.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
