"""L31 (FE half) — the premiere is a light, one-time, dismissible tutorial.

The engine drives the structured premiere (introductions round + gentler first-week cadence);
this is the FE framing: a quiet card shown during the engine's "premiere" moment (move-in, before
the meet-everyone gate lets the first HOH begin) that sets the weekly-rhythm expectation so a
brand-new player never has to prompt for it. It retires the instant that gate completes — NOT at
the week-2 boundary, since week 1 spans the whole HOH/noms/veto/eviction chain. It never replaces
the chat.

Source-pinned (the FE pytest lane has no DOM runtime; browser-smoke covers the live DOM). We pin
the gates (game-build, per-user dismiss, premiere-week), the module load, and the theme-token CSS.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


def test_l31_module_is_loaded_in_index():
    html = _read("static", "index.html")
    assert "orwellPremiereTutorial.js" in html


def test_l31_is_game_build_gated():
    js = _read("static", "js", "orwellPremiereTutorial.js")
    assert "data-game-build" in js
    # both the mount and the refresh bail out unless the game build is on
    assert js.count("isGameBuild()") >= 2


def test_l31_per_user_dismiss_persists_once():
    js = _read("static", "js", "orwellPremiereTutorial.js")
    # per-user key (E71 pattern) persisted in localStorage; shown once per account — derived
    # through the shared fail-closed helper (R5/#1416: window.orwellUserKey returns null with no
    # data-user, so the local fallback write is skipped rather than shared under an empty namespace).
    # The helper appends ":<user>" itself, so the base name has no trailing colon.
    assert 'window.orwellUserKey("orwell-premiere-tutorial-dismissed")' in js
    assert "localStorage.setItem" in js and "localStorage.getItem" in js
    assert "hasDismissed()" in js
    # #642: the guide composes the OrwellNotice kit — the dismiss control is the kit's corner ×
    # (dismissible:true) wired through onDismiss → the premiere's own (synced) dismiss persistence.
    assert "OrwellNoticeKit.create(" in js, "the guide must compose the OrwellNotice kit (#642)"
    assert "dismissible: true" in js
    assert "onDismiss" in js


def test_l31_shows_only_in_premiere_week():
    """The card is gated on the engine's `moment === "premiere"`, not `week === 1`.

    A week stays 1 through the entire HOH -> nominations -> veto -> veto ceremony -> eviction
    chain, so gating on the week left the card mounted long after the meet-everyone gate had
    completed and the first HOH had begun (the corroborated "stale premiere welcome card"
    finding, 2026-07-03 pre-ship audit — 4x hit across lanes). `moment` flips off "premiere" the
    instant that gate completes, so keying off it retires the card exactly on gate-complete
    instead of at the week-2 boundary.
    """
    js = _read("static", "js", "orwellPremiereTutorial.js")
    m = re.search(r"function isPremiereWeek\([^)]*\)\s*\{(.*?)\n  \}", js, re.S)
    assert m, "isPremiereWeek gate not found"
    body = m.group(1)
    # gate-complete signal: the engine's own "premiere" moment, not the week number
    assert 'moment === "premiere"' in body
    assert "week === 1" not in body, "must not regress to the week-based stale-card gate"
    assert "started" in body
    # it reads the same Vault-free projections the season HUD uses
    assert "/api/orwell/status" in js and "/api/orwell/state" in js


def _extract_is_premiere_week(js):
    m = re.search(r"function isPremiereWeek\([^)]*\)\s*\{.*?\n  \}", js, re.S)
    assert m, "isPremiereWeek gate not found"
    return m.group(0)


def _run_is_premiere_week(status, state):
    src = _extract_is_premiere_week(_read("static", "js", "orwellPremiereTutorial.js"))
    harness = (
        src
        + "\nconsole.log(JSON.stringify(isPremiereWeek(" + json.dumps(status) + ", " + json.dumps(state) + ")));\n"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(harness)
        path = f.name
    try:
        out = subprocess.run(["node", path], capture_output=True, text=True, timeout=20)
    finally:
        os.unlink(path)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_l31_card_retires_the_instant_the_meet_gate_completes():
    """Regression pin (the actual bug): once `moment` leaves "premiere" — the first HOH has begun —
    the card must retire even while `week` is still 1. This is the behavior the stale-card audit
    finding demanded; asserting it against the real, unmodified source (not a source-string pin)
    proves the fix rather than just the wording."""
    status = {"started": True, "week": 1}
    # Still week 1, still the premiere: the card should show.
    assert _run_is_premiere_week(status, {"started": True, "week": 1, "moment": "premiere"}) is True
    # Gate complete: the first HOH has begun. Still week 1 — this is exactly where the card used to
    # linger (DEEP-23: "persists into Week-1 veto ceremony").
    for moment in ("hoh-competition", "nominations", "veto-competition", "veto-ceremony", "eviction"):
        assert _run_is_premiere_week(status, {"started": True, "week": 1, "moment": moment}) is False, moment
    # Week has actually advanced — also not the premiere.
    assert _run_is_premiere_week(
        {"started": True, "week": 2}, {"started": True, "week": 2, "moment": "hoh-competition"}
    ) is False
    # Never during post-season.
    assert _run_is_premiere_week(status, {"started": True, "week": 1, "moment": "post-season"}) is False


def test_l31_walks_the_weekly_rhythm_without_prompting():
    js = _read("static", "js", "orwellPremiereTutorial.js")
    # J3-09 (UX audit): "Meet the house" is a prerequisite, not a phase in the weekly loop.
    # The tutorial copy now names the gate ("all fifteen houseguests") and then the four phases.
    assert "fifteen houseguests" in js, "tutorial must state the 15-houseguest gate condition"
    for beat in ["HOH", "Nominations", "Veto", "Eviction"]:
        assert beat in js, f"premiere card should name the {beat!r} beat"
    # it mounts itself on game state, never waits for the player to ask
    assert "orwell:gamechanged" in js
    assert "refresh" in js


def test_l31_css_is_theme_token_driven():
    js = _read("static", "js", "orwellPremiereTutorial.js")
    m = re.search(r"orwell-premiere-tutorial-css.*?textContent\s*=(.*?);\n", js, re.S)
    assert m, "tutorial CSS block not found"
    css = m.group(1)
    # #642: the card SHELL moved to the kit (.on-card.on-guide); only the premiere-specific inner
    # rules (the rhythm line + the CTA row) remain — still theme-token driven (the CTA uses
    # var(--accent)/var(--fg) mixes), and still no hard-coded hex.
    assert "var(--fg)" in css or "var(--accent" in css
    assert "#" not in css, "L31 tutorial CSS must be theme-token driven (no hex)"


def test_j2_13_offers_an_action_affordance():
    """J2-13: the tutorial must give a way to DO the first move, not only name the rhythm."""
    js = _read("static", "js", "orwellPremiereTutorial.js")
    # a CTA control + the seam that fills the composer and focuses it (the player still authors).
    assert "opt-go" in js, "premiere tutorial should carry a 'first move' CTA"
    assert "function firstMove" in js
    # it seeds the live composer (#message) and never auto-sends — ADR 0003 keeps the player author.
    assert 'getElementById("message")' in js
    assert ".focus()" in js
    # never clobber an in-progress draft
    assert "input.value.trim()" in js


def test_j2_10_entrance_staging_is_reduced_motion_guarded():
    """J2-10 / J1-20: the premiere card stages its arrival, and reduced-motion strips it.

    #642: the entrance staging (rise+fade) + its reduced-motion guard moved into the OrwellNotice
    kit (.on-card.on-anim-in, stripped under prefers-reduced-motion). The guide composes the kit,
    so the staging it inherits is reduced-motion-safe by construction — assert it on the kit."""
    js = _read("static", "js", "orwellPremiereTutorial.js")
    assert "OrwellNoticeKit.create(" in js, "the guide composes the kit (which owns the entrance)"
    kit = _read("static", "js", "orwellNotice.js")
    assert "on-anim-in" in kit, "the kit owns the mount entrance staging"
    assert "@keyframes on-in" in kit, "entrance keyframes missing in the kit"
    m = re.search(r"prefers-reduced-motion: reduce.*?animation: none.*?\}", kit, re.S)
    assert m, "the kit's reduced-motion media block must strip the entrance animation"
    assert "on-anim-in" in m.group(0), \
        "the kit entrance must be named in the prefers-reduced-motion block"


def test_j2_18_controls_meet_the_tap_floor():
    """J2-18 / WCAG 2.5.5: the premiere card's controls clear the 44px coarse-pointer floor.

    #642: the dismiss control is now the OrwellNotice kit's corner × (44px in the kit + style.css);
    the premiere keeps its own "Meet the house" CTA (>=44px). So the floor holds across both: the
    CTA in the premiere module, the dismiss in the kit."""
    js = _read("static", "js", "orwellPremiereTutorial.js")
    assert "min-height: 36px" not in js, "premiere control still below the 44px tap floor"
    assert "min-height: 44px" in js, "the premiere CTA should be >= 44px"
    kit = _read("static", "js", "orwellNotice.js")
    assert "min-width: 44px" in kit and "min-height: 44px" in kit, "the kit dismiss is >= 44px"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_orw479_the_welcome_card_is_a_day_one_card_even_while_the_phase_still_reads_premiere():
    # ORW-479: a player who went to bed before the first HOH wakes on Day 2 into a phase that still says "premiere"; the move-in welcome must not show again
    assert _run_is_premiere_week({"started": True, "week": 1, "dayNumber": 1}, {"started": True, "moment": "premiere"}) is True
    assert _run_is_premiere_week({"started": True, "week": 1, "dayNumber": 2}, {"started": True, "moment": "premiere"}) is False
    assert _run_is_premiere_week({"started": True, "week": 1}, {"started": True, "moment": "premiere", "dayNumber": 3}) is False
    assert _run_is_premiere_week({"started": True, "week": 1}, {"started": True, "moment": "premiere"}) is True, "no day in the projection: unchanged"
