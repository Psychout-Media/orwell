"""2026-07-03 pre-ship audit — transient-animation lane (TRANS-12 / VM-5).

Ceremony beat outcomes (HOH crown, nomination reveal, veto result, eviction vote
reveal — anything the L42 `orwellBeatOutcome()` line surfaces) used to swap into the
live tool-thread row via a raw `innerHTML` replace with zero motion: the exact
instant a "still working" row flips to the real outcome text had no transition, so
the show's biggest beats landed as a silent, instant state change ("hard pop").

`chat.js` now tags that row `ow-ceremony-reveal` whenever it is rendering a real
`_outcome` (never on a plain "done"/"failed" swap), and `style.css` gives that class
a brief staged entrance (fade + settle) on the row's header — reduced-motion strips
it back to the exact original instant swap. Presentation only: no game state, no
ordering change, no engine-outcome change.

Source-pinned (CSS/JS-as-text) like the other FE chrome gates — the pytest lane has
no DOM runtime; the render behaviour is verified by browser_smoke.py.
"""
import re
from pathlib import Path

FE = Path(__file__).resolve().parents[1]
JS_DIR = FE / "static" / "js"
CHAT_JS = (JS_DIR / "chat.js").read_text(encoding="utf-8")
CSS = (FE / "static" / "style.css").read_text(encoding="utf-8")


def _css_rule(selector_literal: str, text: str) -> str:
    """Extract a full (brace-balanced) CSS block — handles nested braces so it
    works for both a flat rule and an @keyframes block with per-step rules."""
    idx = text.find(selector_literal)
    assert idx != -1, f"no CSS rule found for {selector_literal!r}"
    open_brace = text.find("{", idx)
    depth = 1
    i = open_brace + 1
    while depth and i < len(text):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
        i += 1
    return text[idx:i]


def test_chat_js_tags_only_real_outcomes_with_reveal_class():
    """The reveal class rides the SAME `_outcome` gate as the L42 outcome text —
    never a generic 'done'/'failed' swap — so ordinary tool beats stay untouched."""
    # M2-5: the outcome branch may carry companion classes (ow-slate-outcome, the
    # persistent slate-type marker) — the pin holds the GATE (_outcome ? reveal : ''),
    # not the exact class list.
    # ORW-264: the className is built by the shared orwellToolBeats.js orwellBeatNodeView; chat.js asks for the reveal.
    tb = (Path(__file__).resolve().parent.parent / "static" / "js" / "orwellToolBeats.js").read_text(encoding="utf-8")
    assert re.search(
        r"outcome\s*\?\s*\(reveal\s*\?\s*['\"]\s*ow-ceremony-reveal['\"]\s*:\s*['\"]['\"]\)",
        tb,
    ), "the shared builder must add ow-ceremony-reveal only when an outcome exists"
    assert "reveal: true" in CHAT_JS


def test_chat_js_clears_the_reveal_marker_after_animation():
    """The marker must not linger forever on the node (it would re-trigger on any
    later className touch) — cleared on animationend with a reduced-motion-safe
    timeout belt, mirroring the existing flashRow pattern in orwellStatusPanel.js."""
    assert "ow-ceremony-reveal" in CHAT_JS
    assert re.search(r"classList\.remove\(['\"]ow-ceremony-reveal['\"]\)", CHAT_JS), (
        "must remove the ow-ceremony-reveal marker after it fires"
    )
    assert "animationend" in CHAT_JS.split("ow-ceremony-reveal")[1][:400] or \
        re.search(r"addEventListener\(['\"]animationend['\"]", CHAT_JS), (
        "must clear the marker off animationend (with a setTimeout belt)"
    )


def test_css_defines_the_ceremony_reveal_entrance():
    rule = _css_rule(".agent-thread-node.ow-ceremony-reveal .agent-thread-header", CSS)
    assert "animation" in rule, "the reveal class must drive a CSS animation on the header"
    assert "ow-ceremony-reveal-in" in rule


def test_css_keyframes_are_a_gentle_settle_not_a_teleport():
    assert "@keyframes ow-ceremony-reveal-in" in CSS
    kf = _css_rule("@keyframes ow-ceremony-reveal-in", CSS)
    assert "opacity: 0" in kf, "must start hidden so the reveal actually reveals"
    assert "opacity: 1" in kf, "must settle to fully visible"


def test_reduced_motion_strips_the_reveal_to_an_instant_swap():
    """A11y hard rule: prefers-reduced-motion must fully disable the new animation,
    restoring the original (pre-fix) instant swap for users who opt out of motion."""
    rm_idx = CSS.find("@media (prefers-reduced-motion: reduce)")
    found = False
    while rm_idx != -1:
        block_start = CSS.find("{", rm_idx)
        depth = 1
        i = block_start + 1
        while depth and i < len(CSS):
            if CSS[i] == "{":
                depth += 1
            elif CSS[i] == "}":
                depth -= 1
            i += 1
        block = CSS[block_start:i]
        if "ow-ceremony-reveal" in block and "animation: none" in block:
            found = True
            break
        rm_idx = CSS.find("@media (prefers-reduced-motion: reduce)", rm_idx + 1)
    assert found, (
        "a prefers-reduced-motion block must force `animation: none` on "
        ".agent-thread-node.ow-ceremony-reveal .agent-thread-header"
    )


def test_reuses_the_kits_shared_entrance_easing():
    """Consistency with the rest of the motion system (orwellSheet.js / the DWE
    kits) rather than a bespoke curve."""
    rule = _css_rule(".agent-thread-node.ow-ceremony-reveal .agent-thread-header", CSS)
    assert "cubic-bezier(0.22, 0.61, 0.36, 1)" in rule
