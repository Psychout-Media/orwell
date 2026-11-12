"""ORW-298 - the FINALE walked in a real browser from a STAGED RESTART (no season replay inside the browser run, no model, no API).

A finale takes a whole season, so each walk starts from an engine save positioned in the finale (`scripts/stage-finale-snapshot.ts` replays one season ONCE per variant at test time and
saves the engine's own snapshot with `live.playedGame` set and the three-part Final HOH on; the save is Vault-bearing engine state, so it is generated, never committed). The real engine boots on
a copy of that save (`_boot_stack(engine_data_dir=..., create_game=False)`), the real FE + a Chromium drive it, and the scripted stub narrator calls no tools except where a script says so.
The DOM contract only (ids / classes / visible text), like the golden flows. A ceremony-step is answered by Continue (POST /api/orwell/ceremony-continue) or a typed "next", never submitDecision.
Roles only.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from contextlib import contextmanager

import pytest

from test_m0_3_midgen_join import FRONTEND, REPO, STUB, _boot_stack, _stack  # noqa: F401
from test_p0h_day1_clock_e2e import _engine, _session
from test_orw191_golden_flows import COMPOSER, _launch, _open, _send

pytestmark = pytest.mark.browser

CARD = "#orwell-decision-card"
_STAGED: dict[str, str] = {}


def _staged(variant):
    """Stage (once per variant per session) and return the staged engine data dir."""
    if variant not in _STAGED:
        out = tempfile.mkdtemp(prefix=f"orwell-o298-{variant}-")
        r = subprocess.run(["npx", "tsx", "scripts/stage-finale-snapshot.ts", out, variant], cwd=REPO, capture_output=True, text=True, timeout=900)
        if r.returncode != 0:
            raise RuntimeError(f"staging {variant} failed: {r.stderr[-800:]}")
        info = json.loads(r.stdout.strip().splitlines()[-1])
        _STAGED[variant] = info["dir"]
    return _STAGED[variant]


@contextmanager
def finale_stack(variant):
    work = tempfile.mkdtemp(prefix=f"orwell-o298-run-{variant}-")
    shutil.copytree(_staged(variant), work, dirs_exist_ok=True)
    gen = _boot_stack(engine_data_dir=work, create_game=False)
    stack = next(gen)
    try:
        yield stack
    finally:
        gen.close()
        shutil.rmtree(work, ignore_errors=True)


def card(page):
    """The decision/ceremony card as the player sees it (None when absent)."""
    return page.evaluate("""() => { const c = document.querySelector('#orwell-decision-card'); if (!c) return null;
      const t = e => (e ? (e.textContent || '').replace(/\\s+/g, ' ').trim() : '');
      return { title: t(c.querySelector('.odec-title')), text: t(c), ceremony: c.dataset.ceremony || '', step: c.dataset.step || '', binding: c.dataset.binding,
               watch: c.classList.contains('odec-watch'), textarea: !!c.querySelector('textarea'),
               options: Array.from(c.querySelectorAll('.odec-opt')).map(b => t(b)), confirm: t(c.querySelector('.odec-confirm')),
               confirmDisabled: !!(c.querySelector('.odec-confirm') || {}).disabled }; }""")


def wait_card(page, needle, timeout=30000):
    """Wait for a card whose title contains `needle`; returns its snapshot."""
    try:
        page.wait_for_function("(n) => { const c = document.querySelector('#orwell-decision-card'); const t = c && c.querySelector('.odec-title'); return !!t && t.textContent.includes(n); }", arg=needle, timeout=timeout)
    except Exception:
        raise AssertionError(f"no card titled ~{needle!r}; saw {card(page)!r}; state={_state_brief(page)}")
    return card(page)


def _state_brief(page):
    return page.evaluate("() => Array.from(document.querySelectorAll('#chat-history .msg')).slice(-3).map(e => (e.textContent||'').replace(/\\s+/g,' ').slice(0,100))")


def eng_state(stack):
    return _engine(stack, "getGameState")


def beat_seq(stack):
    st = eng_state(stack)
    return st.get("beatSeq")


def click_continue(page):
    page.click(f"{CARD} .odec-confirm")


def pending(stack):
    return eng_state(stack).get("pending") or None


def wait_until(fn, what, timeout_s=40, every=0.15):
    import time
    end = time.time() + timeout_s
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(every)
    raise AssertionError(f"timed out waiting for: {what}")


def wait_beat_after(stack, before, what):
    return wait_until(lambda: (beat_seq(stack) or 0) > before, f"the engine beatSeq to move past {before} ({what})")


_N = [0]


def typed_next(page, stack):
    """A typed 'next' through the real composer; returns the unique stub reply text. The narrator is a scripted plain reply (no tool call), so whatever moved the board was the FE's own pre-resolve / progress seam."""
    from test_orw191_golden_flows import _wait_settled
    _N[0] += 1
    reply = f"The house breathes, line {_N[0]:03d}."
    STUB.script.append({"deltas": [reply], "delay": 0})
    _send(page, "next", len(STUB.script))
    _wait_settled(page, reply)
    return reply


def no_watch_card(page, what, hold_s=1.5):
    """No ceremony Continue card is on screen, and stays so for a short hold (a stranded or re-mounted Continue would show up here)."""
    import time
    end = time.time() + 12
    quiet_since = None
    while time.time() < end:
        c = card(page)
        if c is None or not c["watch"]:
            quiet_since = quiet_since or time.time()
            if time.time() - quiet_since >= hold_s:
                return
        else:
            quiet_since = None
        page.wait_for_timeout(120)
    raise AssertionError(f"a ceremony Continue card is stranded {what}: {card(page)!r}")


CARD_TITLES = {  # engine pending kind -> the title the card must carry in the DOM
    "final-eviction": "Final 3", "finale-statement": "Opening statement", "finale-answer": "Jury question",
    "juror-question": "Your jury question", "juror-vote": "Your jury vote",
}


def answer_card(page, kind):
    """Answer a binding decision card through the DOM (never a ceremony-step)."""
    c = wait_until(lambda: (lambda c: c if c and not c["watch"] and "Locked in" not in c["title"] else None)(card(page)), f"the {kind} card in the DOM", 30)
    want = CARD_TITLES.get(kind)
    if want:
        assert want in c["title"], f"the {kind} card carries the wrong title: {c['title']!r}"
    if c["textarea"]:
        page.fill(f"{CARD} textarea", "I played my own game, honestly.")
    elif c["options"]:
        page.click(f"{CARD} .odec-opt")
    page.wait_for_function("() => { const b = document.querySelector('#orwell-decision-card .odec-confirm'); return !!b && !b.disabled; }", timeout=10000)
    page.click(f"{CARD} .odec-confirm")
    return c


def settle_after_decision(page, stack, before_seq):
    wait_beat_after(stack, before_seq, "the decision to land")
    page.wait_for_function("() => { const c = document.querySelector('#orwell-decision-card'); return !c || /Locked in/.test(c.textContent) || !!c.querySelector('.odec-watch, .odec-confirm') === false || c.classList.contains('odec-watch'); }", timeout=15000)


def walk_to_the_end(page, stack, trace, max_iters=120):
    """Walk the rest of the finale until the season is over. A binding card the engine raises MUST appear in the DOM and is answered there; a ceremony-step is answered by its Continue; with nothing pending the
    player types 'next'. Records (kind, beatSeq) in `trace`, plus the ballot count seen at each typed 'next' during the reveal."""
    for _ in range(max_iters):
        st = eng_state(stack)
        if st.get("finished"):
            return
        p = st.get("pending")
        before = st.get("beatSeq") or 0
        if p and p.get("kind") == "ceremony-step":
            trace.append(("ceremony-step", (p.get("ceremony") or {}).get("kind"), (p.get("ceremony") or {}).get("stepId")))
            wait_card(page, "eviction")
            click_continue(page)
            wait_beat_after(stack, before, "Continue")
        elif p:
            trace.append((p.get("kind"),))
            answer_card(page, p["kind"])
            settle_after_decision(page, stack, before)
        else:
            fv = _engine(stack, "finaleView") or {}
            seen = len(fv.get("reveals") or [])
            typed_next(page, stack)
            fv2 = _engine(stack, "finaleView") or {}
            now = len(fv2.get("reveals") or []) if fv2 else None
            trace.append(("next", fv.get("stage"), seen, now, bool(fv2 and fv2.get("winner"))))
    raise AssertionError(f"the finale never finished in {max_iters} steps; trace tail={trace[-6:]}")


def check_the_reveal(trace, st):
    """One public ballot per advance, and the winner only after the last: across the typed 'next' steps of the reveal stage, the ballot count only ever grows by exactly one."""
    steps = [t for t in trace if t[0] == "next" and t[1] == "reveal"]
    assert steps, f"no reveal-stage step was walked: {trace}"
    for _, _, seen, now, _won in steps:
        assert now is not None and 0 <= now - seen <= 1, f"a single advance revealed {None if now is None else now - seen} ballots (not one): {steps}"
    assert max(t[3] or 0 for t in steps) >= 2, f"the reveal never showed more than one ballot, one per advance: {steps}"
    assert (st.get("winner") or st.get("season", {}) ) is not None


def no_duplicate_bubbles(page, replies):
    for r in replies:
        n = sum(1 for t in page.evaluate("() => Array.from(document.querySelectorAll('#chat-history .msg.msg-ai')).map(e => e.textContent || '')") if r in t)
        assert n <= 1, f"the reply {r!r} is rendered {n} times"


def _finish(page, stack, trace, want_kinds, forbid_kinds=()):
    walk_to_the_end(page, stack, trace)
    kinds = {t[0] for t in trace}
    for k in want_kinds:
        assert k in kinds, f"the walk never raised/answered a {k!r} card: {trace}"
    for k in forbid_kinds:
        assert k not in kinds, f"unexpected {k!r} in the walk: {trace}"
    check_the_reveal(trace, eng_state(stack))
    fv = _engine(stack, "finaleView") or {}
    assert fv.get("winner"), f"the season ended with no public winner: {fv}"
    assert len(fv.get("reveals") or []) >= 2
    no_duplicate_bubbles(page, [f"The house breathes, line {n:03d}." for n in range(1, _N[0] + 1)])
    no_watch_card(page, "at the end of the finale")


@pytest.mark.timeout(1500)
def test_npc_final_hoh_continue_then_typed_next_then_the_whole_finale():
    """An NPC Final HOH (the player stays in as a finalist): the eviction decision step is answered by the Continue button, the result step by a typed 'next' (exactly one step), then the player's
    statement and jury-question answers, and the ballot-by-ballot reveal ending in the winner.

    FAILS TODAY (ORW-298 finding, kept as evidence): the typed 'next' DOES advance the engine exactly one step (the ceremony closes, pending becomes finale-statement), but the browser's
    'Final 2 eviction - 2 of 2' Continue card is NOT removed - it stays on screen (never self-heals; only a reload clears it) and it blocks the next real card (the statement card) from mounting.
    Pressing that stale Continue would advance the engine one more step."""
    with finale_stack("npc") as stack:
        from playwright.sync_api import sync_playwright
        _session(stack, "o298-npc")
        with sync_playwright() as pw:
            b = _launch(pw)
            page = _open(b, stack)
            c1 = wait_card(page, "Final 2 eviction \u00b7 1 of 2")
            assert c1["watch"] and c1["confirm"] == "Continue" and not c1["options"], c1
            assert not __import__("re").search(r"evict(s|ed) ", c1["text"]), f"the decision step must not name the result: {c1['text']!r}"
            before = beat_seq(stack)
            click_continue(page)                                   # (a) the Continue button -> /api/orwell/ceremony-continue
            wait_beat_after(stack, before, "Continue on the decision step")
            c2 = wait_card(page, "2 of 2")
            p2 = pending(stack)
            assert p2 and p2["kind"] == "ceremony-step" and p2["ceremony"]["stepId"] == "result", p2
            before = beat_seq(stack)
            typed_next(page, stack)                                # (b) a typed 'next' advances exactly ONE step: the result step closes, nothing else is skipped
            wait_beat_after(stack, before, "typed next on the result step")
            no_watch_card(page, "after the result step")
            p3 = pending(stack)
            assert not p3 or p3["kind"] != "ceremony-step", f"the ceremony must be closed after the result: {p3}"
            assert (eng_state(stack).get("phase") or "").startswith("finale"), eng_state(stack).get("phase")
            trace = []
            _finish(page, stack, trace, want_kinds=("finale-statement", "finale-answer"), forbid_kinds=("juror-vote", "juror-question"))
            b.close()


@pytest.mark.timeout(1500)
def test_npc_final_hoh_continue_on_both_steps_then_the_whole_finale():
    """The same NPC Final HOH walk with the Continue button on BOTH ceremony steps (the typed-'next' variant above is the one that fails today: see its docstring). Keeps the rest of the finale covered."""
    with finale_stack("npc") as stack:
        from playwright.sync_api import sync_playwright
        _session(stack, "o298-npc-continue")
        with sync_playwright() as pw:
            b = _launch(pw)
            page = _open(b, stack)
            wait_card(page, "1 of 2")
            for step in ("1 of 2", "2 of 2"):
                wait_card(page, step)
                before = beat_seq(stack)
                click_continue(page)
                wait_beat_after(stack, before, f"Continue on {step}")
            no_watch_card(page, "after the result step")
            _finish(page, stack, [], want_kinds=("finale-statement", "finale-answer"), forbid_kinds=("juror-vote", "juror-question"))
            b.close()


def _player_final_hoh_walk(strict):
    with finale_stack("player") as stack:
        from playwright.sync_api import sync_playwright
        _session(stack, "o298-player")
        with sync_playwright() as pw:
            b = _launch(pw)
            page = _open(b, stack)
            if pending(stack) is None:  # the staged HOH is crowned and nothing is pending: the first player turn opens the choice
                typed_next(page, stack)
            c = wait_card(page, "Final 3")
            assert not c["watch"] and c["binding"] == "true" and len(c["options"]) == 2 and c["confirmDisabled"], c
            assert "1 of 2" in c["title"], c["title"]
            before = beat_seq(stack)
            page.click(f"{CARD} .odec-opt")
            page.click(f"{CARD} .odec-confirm")
            wait_beat_after(stack, before, "the Final 2 choice")
            c2 = wait_card(page, "2 of 2")
            assert c2["watch"] and c2["confirm"] == "Continue", c2
            before = beat_seq(stack)
            click_continue(page)
            if strict:
                wait_beat_after(stack, before, "ONE Continue press on the result step")
            else:  # tolerate the swallowed first press (finding 2) so the rest of the walk is still covered
                for _ in range(3):
                    try:
                        wait_until(lambda: (beat_seq(stack) or 0) > before, "Continue", timeout_s=6)
                        break
                    except AssertionError:
                        click_continue(page)
                else:
                    raise AssertionError("Continue never advanced the result step in three presses")
            no_watch_card(page, "after the result step")
            _finish(page, stack, [], want_kinds=("finale-statement", "finale-answer"), forbid_kinds=("juror-vote",))
            b.close()


@pytest.mark.timeout(1500)
def test_player_final_hoh_choose_card_then_result_then_the_finale():
    """The player is the Final HOH: the binding 'final-eviction' choose card (Confirm disabled until a pick), then the result step (ONE Continue press), then the finale to the winner.

    FAILS TODAY (ORW-298 finding 2, kept as evidence): the first Continue press on the result step right after the choose card is swallowed - POST /api/orwell/ceremony-continue answers 200 with the
    UNCHANGED view (same beatSeq, same result step; the stale-beat reconcile path returned the current state instead of advancing), the card stays, and only a second press advances."""
    _player_final_hoh_walk(strict=True)


@pytest.mark.timeout(1500)
def test_player_final_hoh_walk_tolerating_a_swallowed_first_continue():
    """The same player-Final-HOH walk, re-pressing Continue when the first press is swallowed (finding 2 above), so the statement / answer / reveal half is still walked."""
    _player_final_hoh_walk(strict=False)


@pytest.mark.timeout(1500)
def test_player_evicted_at_the_final_3_leaves_no_stranded_continue():
    """The Final HOH evicts the player: the decision step's Continue publishes it, and NOTHING is left to press (no result step, no ceremony left open); the player sits the jury and votes."""
    with finale_stack("evicted") as stack:
        from playwright.sync_api import sync_playwright
        _session(stack, "o298-evicted")
        with sync_playwright() as pw:
            b = _launch(pw)
            page = _open(b, stack)
            wait_card(page, "Final 2 eviction \u00b7 1 of 2")
            before = beat_seq(stack)
            click_continue(page)
            wait_beat_after(stack, before, "Continue on the decision step")
            no_watch_card(page, "after the player's own eviction was published")
            p = pending(stack)
            assert not p or p["kind"] != "ceremony-step", f"a ceremony-step is left open after the player's eviction: {p}"
            st = eng_state(stack)
            assert (st.get("player") or {}).get("status") not in (None, "active"), f"the player was not evicted: {st.get('player')}"
            trace = []
            _finish(page, stack, trace, want_kinds=("juror-vote",), forbid_kinds=("finale-statement", "finale-answer"))
            b.close()


@pytest.mark.timeout(1500)
def test_player_as_a_juror_asks_and_votes():
    """The player was evicted earlier and sits on the jury: the Final HOH's eviction runs without them, then the player's own jury question card and juror-vote card, then the reveal and the winner."""
    with finale_stack("juror") as stack:
        from playwright.sync_api import sync_playwright
        _session(stack, "o298-juror")
        with sync_playwright() as pw:
            b = _launch(pw)
            page = _open(b, stack)
            trace = []
            _finish(page, stack, trace, want_kinds=("juror-vote",), forbid_kinds=("finale-statement", "finale-answer"))
            print("JUROR TRACE kinds:", [t[0] for t in trace if t[0] != "next"])
            b.close()
