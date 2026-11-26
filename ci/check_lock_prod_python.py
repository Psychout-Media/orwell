#!/usr/bin/env python3
"""ORW-955: every pin in frontend/requirements.lock.txt must install on the Python that PRODUCTION runs, not only on CI's.

Why: deploy (deploy/orwell-install.sh, deploy/orwell-update.sh) builds the venv from the box's system `python3` (Debian
bookworm: 3.11.2), while CI tests on 3.12. On 2026-11-26 the lock pinned soupsieve 4.0.0 (Requires-Python >=3.11.5): CI
was green, and the prod update failed at the dependency install and rolled itself back.

How: for each `name==version` line (with its environment marker, evaluated for the prod version) this reads the release's
Requires-Python from PyPI and fails when the prod version is outside it. A network error is a warning, never a failure.
The prod version lives in ci/prod_python_version (one line); change it when prod moves to a newer Python.
Usage: check_lock_prod_python.py [lock] (exit 1 on a pin prod cannot install)."""
from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path

try:
    from packaging.markers import Marker
    from packaging.specifiers import SpecifierSet
    from packaging.version import Version
except ImportError:  # every box with pip has a vendored copy
    from pip._vendor.packaging.markers import Marker  # type: ignore
    from pip._vendor.packaging.specifiers import SpecifierSet  # type: ignore
    from pip._vendor.packaging.version import Version  # type: ignore

ROOT = Path(__file__).resolve().parent.parent
PIN_RE = re.compile(r"^([A-Za-z0-9_.\-]+)(\[[^\]]*\])?==([^\s;]+)\s*(?:;\s*(.+))?$")


def prod_version() -> str:
    for line in (ROOT / "ci" / "prod_python_version").read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            return line
    raise SystemExit("ci/prod_python_version is empty")


def pins(lock: Path):
    for raw in lock.read_text().splitlines():
        line = raw.split(" #", 1)[0].strip()
        if not line or line.startswith(("#", "-")):
            continue
        m = PIN_RE.match(line)
        if m:
            yield m.group(1), m.group(3), m.group(4)


def requires_python(name: str, version: str):
    url = f"https://pypi.org/pypi/{name}/{version}/json"
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "orwell-ci-lock-check"}), timeout=20) as r:
        return (json.load(r).get("info") or {}).get("requires_python") or ""


def main() -> int:
    lock = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "frontend" / "requirements.lock.txt"
    pv = prod_version()
    env = {"python_version": ".".join(pv.split(".")[:2]), "python_full_version": pv, "sys_platform": "linux",
           "platform_system": "Linux", "os_name": "posix", "implementation_name": "cpython", "platform_python_implementation": "CPython",
           "platform_machine": "x86_64"}
    bad, checked, unreachable = [], 0, 0
    for name, version, marker in pins(lock):
        if marker and not Marker(marker).evaluate(env):
            continue  # this pin is for another Python; prod skips it
        try:
            rp = requires_python(name, version)
        except Exception as e:  # noqa: BLE001 - a network problem must not fail CI
            unreachable += 1
            print(f"::warning::lock check: could not read {name}=={version} from PyPI ({type(e).__name__}); not checked")
            continue
        checked += 1
        if rp and Version(pv) not in SpecifierSet(rp):
            bad.append(f"{name}=={version} needs Python {rp}")
    for b in bad:
        print(f"::error file=frontend/requirements.lock.txt::{b}, but production runs Python {pv} (ci/prod_python_version). "
              f"Pin the newest version that supports {pv} for prod with a python_full_version marker beside the newer pin.")
    print(f"lock vs prod Python {pv}: {checked} pin(s) checked, {unreachable} not reachable, {len(bad)} not installable on prod")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
