"""The final FE batch — A3/A4/A5 + V3 + C18 + the C22 premiere slice (source pins;
the live behaviors are exercised in real Chromium by scripts/browser_smoke.py)."""

import os
import re

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


def test_a3_status_hud_announces_deltas_not_rereads():
    js = _read("static", "js", "orwellStatusPanel.js")
    assert "announceDeltas(" in js and 'id="os-announce"' in js
    # the live region is the dedicated announcer, not the display-toggled root
    assert 'el.setAttribute("aria-live", "polite")' not in js
    body = js[js.index("function announceDeltas"): js.index("function announceDeltas") + 900]
    assert "Head of Household:" in body and "On the block:" in body  # show terms, not enums


def test_v3_no_raw_phase_enum_in_the_hud():
    js = _read("static", "js", "orwellStatusPanel.js")
    assert "PHASE_LABELS" in js
    assert "phaseLabel(headerPhase(st))" in js  # ORW-740a: the label still goes through phaseLabel, over the header phase
    for label in ("Veto ceremony", "Eviction night", "Move-in day"):
        assert label in js, label


def test_a4_no_opacity_dimmed_text_in_huds():
    # explicit AA-checked colors replace the sub-AA opacity dims on TEXT rows
    sp = _read("static", "js", "orwellStatusPanel.js")
    assert "color-mix" in sp
    assert ".os-k { opacity" not in sp and ".os-out { opacity" not in sp


def test_a5_streaming_log_gated_by_aria_busy():
    js = _read("static", "js", "chat.js")
    assert "setAttribute('aria-busy', 'true')" in js
    assert "setAttribute('aria-busy', 'false')" in js


def test_c18_polling_pauses_hidden_and_backs_off():
    for f in ("orwellStatusPanel.js",):
        js = _read("static", "js", f)
        assert "document.hidden" in js, f
        assert "_pollDelay" in js and "Math.pow(2, _failures)" in js, f
        assert "setInterval(refresh" not in js, f


def test_c22_producers_reach_out_first_on_welcome_dismiss():
    # OOBE re-sequence (2026-06-20): the PRODUCERS reach out FIRST — now triggered when the WELCOME is
    # dismissed (route's onProceed), not after a photo. The player never types the opening word; the
    # kickoff auto-sends with the user bubble HIDDEN (via the synchronous hidden-cue seam) so the
    # first visible message is the producers'. The premiere then flows from the conversation.
    js = _read("static", "js", "orwellOnboarding.js")
    assert "I take my seat for the casting interview." not in js   # the pre-prompt is removed
    seg = js[js.index("window._orwellOpenGameAfterCasting"):]
    seg = seg[: seg.index("\n  };")]
    # #967 live re-fix: the kickoff dispatches through the shared `_sendCueWithBackoff` kernel (retries on
    # a busy stream / unready send seam) rather than a single-shot send. The kernel calls the hidden-cue
    # seam; the opener just hands it OPEN_GAME_LINE.
    assert "_sendCueWithBackoff" in seg                            # robust dispatch (no single-shot drop)
    assert "OPEN_GAME_LINE" in seg                                 # the producers' opener cue text
    assert "_openSent" in seg                                      # fired once
    # the hidden-cue seam + the legacy submit fallback live on the kernel
    kern = js[js.index("function _sendCueWithBackoff"):]
    kern = kern[: kern.index("\n  }\n")]
    assert "sendHiddenCue" in kern                                # hidden-cue seam (no flash)
    assert "setHideUserBubble" in kern                            # producers appear to reach out first (fallback)
    assert "handleChatSubmit" in kern                             # auto-sent (this single cutover)
    # The engine-side casting->premiere transition wording is verified by ENGINE tests
    # (lifecycleMoments / premiereDay1) — an FE test must not assert engine-prompt text, since
    # engine-only PRs skip the FE job and such a cross-layer assertion then breaks latently on main.
