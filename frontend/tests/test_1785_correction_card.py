"""#1785 AC3 — diegetic control-room correction card: source-pin tests.

Verifies that post-air corrections route through the single G15 dispatcher and
render as a control-room chyron with the approved copy.

No browser/app-boot tests — pure source-read + regex asserts.
"""
import os
import re
import subprocess
import sys
from pathlib import Path

from _ci_shard import nested_env

FE = Path(__file__).resolve().parents[1]
JS_DIR = FE / "static" / "js"
DECISION = (JS_DIR / "orwellDecision.js").read_text(encoding="utf-8")
PLATFORM = (JS_DIR / "platform.js").read_text(encoding="utf-8")
CHAT = (JS_DIR / "chat.js").read_text(encoding="utf-8")

ALL_JS = sorted((FE / "static").rglob("*.js"))
DISPATCH_RE = re.compile(r"new CustomEvent\(\s*['\"]orwell:gamechanged['\"]")


def test_correction_kind_exists_in_icon_map():
    """Assert 'correction': '📼' in _CHYRON_ICON."""
    assert "'correction': '\\u{1F4FC}'" in DECISION or '"correction": "\\u{1F4FC}"' in DECISION, \
        "correction kind must exist in _CHYRON_ICON map"


def test_correction_kind_exists_in_kicker_map():
    """Assert 'correction': 'Control Room' in _CHYRON_KICKER."""
    assert 'correction' in DECISION and 'Control Room' in DECISION
    # The kicker value must sit in the kicker map, not somewhere else in the file.
    # Locate the _CHYRON_KICKER assignment and check its content only.
    start = DECISION.find('const _CHYRON_KICKER = {')
    assert start != -1, "_CHYRON_KICKER assignment must exist in orwellDecision.js"
    end = DECISION.find('};', start)
    assert end != -1, "_CHYRON_KICKER block must have a closing '};'"
    kicker_body = DECISION[start:end + 2]
    assert "correction" in kicker_body and "Control Room" in kicker_body, \
        "correction must be a key in _CHYRON_KICKER with value 'Control Room'"


def test_correction_routes_through_single_g15_dispatcher():
    """Assert no ad-hoc CustomEvent('orwell:gamechanged'...) carries correction outside platform.js.

    The G15 invariant already enforces ONE dispatcher for the event itself;
    this test narrows the check: if any file other than platform.js carries
    a CustomEvent with a 'correction' detail field, it fails.
    """
    for f in ALL_JS:
        if f.name == "platform.js":
            continue
        src = f.read_text(encoding="utf-8")
        for m in DISPATCH_RE.finditer(src):
            # If the match contains 'correction' within ~200 chars of 'dispatchEvent'
            # or the event carries the correction detail, fail.
            context = src[max(0, m.start() - 100):m.end() + 100]
            assert "correction" not in context, (
                f"{f.name} has a CustomEvent('orwell:gamechanged') that mentions "
                f"correction — the correction detail must ONLY ride through the "
                f"single platform.js helper, never an ad-hoc dispatch."
            )


def test_orwell_gamechanged_accepts_correction_param():
    """Assert function signature accepts third param in platform.js."""
    m = re.search(r"export function orwellGameChanged\(([^)]+)\)", PLATFORM)
    assert m, "orwellGameChanged function must exist in platform.js"
    params = m.group(1)
    assert "correction" in params, (
        f"orwellGameChanged must accept third 'correction' param — "
        f"found: ({params})"
    )
    # Verify the third param is used in the detail
    assert "detail.correction" in PLATFORM or "detail['correction']" in PLATFORM, \
        "the correction param must be placed into the event detail"


def test_correction_listener_exists_in_decision_js():
    """Assert an 'orwell:gamechanged' listener in orwellDecision.js checks e.detail.correction."""
    # Find the addEventListener block for orwell:gamechanged
    m = re.search(r"addEventListener\(\s*['\"]orwell:gamechanged['\"]\s*,\s*\(\s*e\s*\)\s*=>\s*\{(.*?)\n\s*\}\);?", DECISION, re.S)
    assert m, "orwell:gamechanged listener must exist in orwellDecision.js"
    listener_body = m.group(1)
    assert "e.detail.correction" in listener_body or "e.detail && e.detail.correction" in listener_body, \
        "the listener must check e.detail.correction"
    # Must call _renderChyron with kind: 'correction'
    assert "correction" in listener_body and "_renderChyron" in listener_body, \
        "the listener must render a correction chyron"


def test_correction_card_uses_approved_copy():
    """Assert 'The control room reviewed the tape' appears as the card headline prefix."""
    assert "The control room reviewed the tape" in DECISION, \
        "correction chyron headline must use the approved copy"


def test_g15_gamechanged_stays_green():
    """Run test_g15_gamechanged.py and assert all tests pass."""
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "frontend/tests/test_g15_gamechanged.py", "-q"],
        capture_output=True, text=True, cwd=FE.parent,
        env=nested_env(os.environ),  # ORW-193 regression: never inherit ORWELL_CI_SHARD (0 tests collected -> exit 5)
    )
    assert result.returncode == 0, (
        f"test_g15_gamechanged.py must stay green:\n{result.stderr}\n{result.stdout}"
    )
