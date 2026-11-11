"""Ledger L15 (FE source gate) — the Cast panel never goes dark during generation.

Pins the orwellCast.js behaviors that stop "all photos vanished + the connection looked dropped":
  • the gate poll (refreshGate) does NOT hide the cast button / close the panel on a non-ok or
    ambiguous /state answer — only a definitive `started:false` does;
  • render() consumes the server's live `generation` record (poll fast while a run is active) and
    treats a `stale` payload as a keep-the-faces signal, never an empty grid;
  • the "Generating N of M…" copy reads the live run record when present.

Source-level assertions (like test_g22) — CODE identifiers, never comment prose. Roles only.
"""

import os
import re

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel):
    with open(os.path.join(FRONTEND, rel), encoding="utf-8") as f:
        return f.read()


def _block(text, start, end):
    i = text.index(start)
    j = text.index(end, i)
    return text[i:j]


def _js():
    return _read("static/js/orwellCast.js")


# ── the gate poll never hides the cast on a transient/ambiguous state read ──────────────────

def test_refresh_gate_only_acts_on_a_definitive_state():
    gate = _block(_js(), "async function refreshGate()", "// --- the panel")
    # A non-ok response short-circuits (no hide, no close): ORW-165 — the shared store REJECTS a non-ok read and the
    # catch below leaves the button exactly as it was.
    assert 'OrwellGame.get("state")' in gate
    assert "catch (_) { /* engine hiccup: leave the button as it was (fail-open) */ }" in gate
    # An unreadable / ambiguous body short-circuits too — only a real boolean `started` decides.
    assert 'typeof st.started !== "boolean"' in gate
    assert "return; // ambiguous" in gate
    # The hide/close still happens for a genuine not-live state.
    assert "togglePanel(false)" in gate


# ── render consumes the live generation record + the stale flag ─────────────────────────────

def test_render_reads_the_live_generation_record():
    body = _block(_js(), "function render(data) {", "async function refreshRoster")
    assert "data.generation" in body, "render reads the server's live generation record"
    assert "gen.active" in body, "the fast cadence keys on a genuinely active run"
    # The cadence picks the fast delay while generating OR while a stale roster is being served.
    assert re.search(r"_pollDelay\s*=\s*\(generating\s*\|\|\s*data\.stale\)\s*\?\s*FAST_POLL_MS", body), \
        "a generating OR stale payload keeps the fast cadence"


def test_render_treats_a_stale_payload_as_keep_the_faces():
    body = _block(_js(), "function render(data) {", "async function refreshRoster")
    # The ONLY grid-wipe path is the explicit empty roster; a stale payload always carries the
    # last-good cards, so it upserts in place and never blanks the cast.
    empty_branch = _block(body, "if (!roster.length)", 'empty.style.display = "none"')
    assert "_cards.clear()" in empty_branch
    # No other clear path exists in render (the keyed upsert owns the rest).
    assert body.count("_cards.clear()") == 1


def test_generating_copy_prefers_the_live_run_record():
    body = _block(_js(), "function render(data) {", "async function refreshRoster")
    assert "Generating " in body and "of " in body, "the live 'Generating N of M…' copy exists"
    assert "gen.done" in body and "gen.total" in body, "it reads the live run counts"


# ── render() never RESURRECTS a closed window (the CI browser-smoke overlap fix) ─────────────

def test_render_does_not_resurrect_a_closed_panel():
    # The race: a roster fetch begun while the panel was OPEN resolves AFTER the player closed it
    # (the close stops the poll, but an in-flight request still settles). render()→ensurePanel()
    # would re-MOUNT #orwell-cast, leaving a slotted, focused window overlapping the sidebar — it
    # intercepted #session-sort-btn under Playwright (PR #388). render() must bail when closed.
    body = _block(_js(), "function render(data) {", "async function refreshRoster")
    head = body[: body.index("const el = ensurePanel()")]
    assert "if (!_open) return;" in head, "render() must drop a stale result instead of re-mounting a closed panel"


def test_refresh_roster_serves_last_good_and_backs_off():
    body = _block(_js(), "async function refreshRoster()", "function scheduleNextPoll")
    # Under failure: count it (poll backoff) and keep the last-good cast on screen (keyed upsert).
    assert "_failures++" in body
    # A non-blocking loading affordance rides over the existing content (never a blank hang).
    assert "setLoading(true)" in body and "setLoading(false)" in body
