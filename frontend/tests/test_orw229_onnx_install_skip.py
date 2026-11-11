"""ORW-229 follow-up — every `npm ci` / `npm install` the updater runs skips onnxruntime-node's GPU download.

onnxruntime-node's postinstall downloads its CUDA / TensorRT execution providers from nuget on every `npm ci`
(about 45 s of a 55 s install on the dev box). The engine never loads them: fastembed runs onnxruntime on the CPU,
whose runtime ships inside the npm package. Proven on the dev box before this change: after a clean
`ONNXRUNTIME_NODE_INSTALL=skip npm ci` the engine boots with fastembed and `orwell-doctor.sh --status` reports
`embeddings: provider=fastembed, degraded=false` (see the PR). These tests pin that the updater (and the installer)
set the skip for every npm install they run, and that an operator's explicit value still wins.
Runs the REAL update script in the sandboxed box of test_orw229_update_fast_path.py. Name-agnostic: roles only.
"""
import re
from pathlib import Path

from test_orw229_update_fast_path import DEPLOY, FastBox, _combined, _recorded, fbox, pytestmark  # noqa: F401  (fixture + guard)

_INSTALLS = ("ci", "install")


def _told(box, after=0):
    """[(npm args, ONNXRUNTIME_NODE_INSTALL as that npm call saw it)] for the installs this box ran."""
    p = Path(f"{box.log}.onnx")
    rows = [tuple(line.split("\t", 1)) for line in p.read_text().splitlines()] if p.exists() else []
    return [(a, v) for a, v in rows[after:] if a.split(" ", 1)[0] in _INSTALLS]


def test_the_full_install_skips_the_gpu_download(fbox):
    fbox.put(src="2")
    r = fbox.run_update(ONNXRUNTIME_NODE_INSTALL="")          # nothing set by the caller (CI sets it globally)
    assert r.returncode == 0, _combined(r)
    told = _told(fbox)
    assert ("ci", "skip") in told and all(v == "skip" for _, v in told), told


def test_the_build_tools_restore_and_the_revert_skip_it_too(fbox):
    _recorded(fbox)
    n = len(_told(fbox))
    fbox.put(src="3", break_build=True)                       # chain: npm install, the build fails, the revert reinstalls
    r = fbox.run_update(ONNXRUNTIME_NODE_INSTALL="")
    assert r.returncode == 1, _combined(r)
    told = _told(fbox, n)
    args = [a for a, _ in told]
    assert any(a.startswith("install --include=dev") for a in args), args
    assert "ci --omit=dev --prefer-offline" in args, args
    assert all(v == "skip" for _, v in told), told


def test_an_operators_explicit_value_still_wins(fbox):
    fbox.put(src="2")
    r = fbox.run_update(ONNXRUNTIME_NODE_INSTALL="cuda12")
    assert r.returncode == 0, _combined(r)
    assert all(v == "cuda12" for _, v in _told(fbox)), _told(fbox)


def test_the_installer_skips_it_for_its_npm_ci_too():
    text = (DEPLOY / "orwell-install.sh").read_text()
    body = text[text.index("build_engine() {"):]
    body = body[:body.index("\n}\n")]
    first_ci = body.index("npm ci")
    assert re.search(r'ONNXRUNTIME_NODE_INSTALL="\$\{ONNXRUNTIME_NODE_INSTALL:-skip\}"', body[:first_ci + 80]), body[:first_ci + 80]
