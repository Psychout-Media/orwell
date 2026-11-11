"""ORW-155 (SOURCE-PIN): only the newest bubbles keep their own backdrop blur; older ones drop it (a long season would otherwise carry ~one blur layer per message)."""
import os
import re

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSS = open(os.path.join(FRONTEND, "static", "style.css"), encoding="utf-8").read()
TAIL = CSS[CSS.index("ORW-155 (perf)"):]


def test_older_ai_and_user_bubbles_drop_the_blur():
    for sel in ("msg-ai", "msg-user"):
        m = re.search(rf"body\.theme-frosted \.{sel}:not\(:nth-last-child\(-n\+(\d+)\)\)\s*\{{([^}}]*)\}}", TAIL)
        assert m, f"{sel}: no old-bubble rule"
        assert int(m.group(1)) >= 8, "keep enough recent bubbles blurred for the on-screen window"
        assert "backdrop-filter: none" in m.group(2) and "-webkit-backdrop-filter: none" in m.group(2)


def test_old_received_bubbles_get_a_firmer_scrim_so_contrast_holds_without_blur():
    m = re.search(r"\.msg-ai:not\(:nth-last-child\(-n\+\d+\)\)\s*\{([^}]*)\}", TAIL)
    alpha = float(re.search(r"--ai-scrim-alpha:\s*([0-9.]+)", m.group(1)).group(1))
    assert alpha > 0.46


def test_the_pinned_newest_bubble_blur_rules_are_untouched():
    assert "backdrop-filter: blur(18px) saturate(120%) !important;" in CSS
    assert "backdrop-filter: blur(18px) saturate(170%) !important;" in CSS
