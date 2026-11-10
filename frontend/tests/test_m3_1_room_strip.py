"""M3-1 — the room strip (`docs/ROAD-TO-MARKET.md` §M3-1, idea 1): a slim strip of portrait
chips for who is in the player's CURRENT room, mounted above the composer from
`whereabouts.present`. Reuses the M2-2 monogram/badge kit (`OrwellMonogram.face`).

This gate covers the DoD verbatim:
  1. Vault-free proof — the module fetches ONLY known Vault-free routes and never references a
     hidden/secret-layer term (leak scan on accessed fields; template: the casting-leak gates).
  2. g15 no-new-dispatcher — this module only LISTENS for `orwell:gamechanged`, never dispatches
     it (mirrors `test_g15_gamechanged.py`'s single-dispatcher sweep, pinned for this file too).
  3. Pre-game collapse — the strip renders nothing before a game starts / before a room resolves.
  4. Kit wiring — composes `OrwellMonogram.face`/`rolesFrom` (M2-2), mounted + script-tagged.
  5. "Dimming on exit" — the pure `_diffPresence` diff helper, node-unit-tested against synthetic
     room rosters (roles only, no fixture identities per the repo's testing rules).
  6. The responsive-matrix registration (collapses gracefully on narrow viewports).
"""

import json
import os
import re
import shutil
import subprocess
import tempfile

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS_DIR = os.path.join(FRONTEND, "static", "js")
_NODE = shutil.which("node")


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


ROOM_STRIP = _read("static", "js", "orwellRoomStrip.js")


# ── 1. Vault-free proof ────────────────────────────────────────────────────────────────

# The only routes this module may ever call — every one is a documented Vault-free public
# projection (whereabouts 0049/C28, roster 0051, status the public ceremony board, state the
# shared HUD poller). No admin/debug/producer route may appear.
ALLOWED_ENDPOINTS = {
    "/api/orwell/state",
    "/api/orwell/whereabouts",
    "/api/orwell/roster",
    "/api/orwell/status",
}

# Terms that would only ever appear if hidden/secret-layer state leaked into a player-facing
# render module. None of these are legitimate field names on whereabouts()/roster()/status()/
# state() — the module must never reference them (accessed-field leak scan, casting-leak template).
FORBIDDEN_TERMS = [
    "vault", "secret", "trust", "affinity", "threat", "grudge", "soul", "confidence",
    "relationship", "producerVault", "readsVault", "confessional", "scheme",
    # "hidden" is deliberately excluded — a legitimate CSS keyword (overflow-y: hidden) collides
    # with it; the other terms carry no such false-positive surface.
]


def test_room_strip_calls_only_known_vault_free_endpoints():
    called = set(re.findall(r'getJSON\(\s*"([^"]+)"\s*\)', ROOM_STRIP))
    assert called, "expected the module to call at least one endpoint"
    assert called <= ALLOWED_ENDPOINTS, (
        f"orwellRoomStrip.js calls unexpected endpoint(s): {called - ALLOWED_ENDPOINTS} "
        f"— only Vault-free public projections are allowed"
    )
    # Sanity: the two DoD-named endpoints are actually present, not just permitted.
    assert "/api/orwell/whereabouts" in called
    assert "/api/orwell/state" in called


def _strip_line_comments(js):
    # The header/inline `//` comments legitimately EXPLAIN the Vault-free contract in prose
    # ("never a stat, relationship, or hidden element") — the leak scan below must apply to the
    # executable CODE only, not documentation praising the wall it upholds.
    return "\n".join(re.sub(r"//.*$", "", line) for line in js.splitlines())


ROOM_STRIP_CODE_ONLY = _strip_line_comments(ROOM_STRIP)


@pytest.mark.parametrize("term", FORBIDDEN_TERMS)
def test_room_strip_never_references_a_hidden_layer_term(term):
    assert term.lower() not in ROOM_STRIP_CODE_ONLY.lower(), (
        f"orwellRoomStrip.js's CODE references {term!r} — a player-facing render module must "
        f"never touch hidden/secret-layer state (the Vault Wall is enforced in code, not prompt "
        f"wording); comments explaining the Vault-free contract are fine, code is not"
    )


def test_room_strip_never_posts_anywhere():
    # Read-only render surface — never mutates game state (ADR 0003: augments, never replaces).
    assert "POST" not in ROOM_STRIP and "method:" not in ROOM_STRIP


def test_room_strip_only_reads_named_ref_and_roster_fields():
    """The accessed-field scan: every `.field` this module reads off a fetched payload is a
    known Vault-free field on WhereaboutsView/NamedRef, the roster card, or GameStateView.asleep
    — never a stat/relationship/emotional field. (id/name/status/portrait/room/present/asleep/
    started are the full known-safe set; anything else is a drift signal worth a human look.)"""
    known_safe = {
        "id", "name", "status", "portrait", "room", "present", "asleep", "started",
        "roster", "whereabouts",
    }
    # Field reads off the response objects this module names explicitly.
    reads = set(re.findall(r'\b(?:state|w|rc|card|person|p|h|rosterData|statusData|whereData)\.(\w+)', ROOM_STRIP))
    unexpected = reads - known_safe
    assert not unexpected, f"unexpected field read(s) on a fetched payload: {unexpected}"


# ── 2. g15 — listen only, never dispatch ───────────────────────────────────────────────

def test_room_strip_never_dispatches_gamechanged():
    assert "new CustomEvent" not in ROOM_STRIP, (
        "orwell:gamechanged has exactly ONE dispatcher (platform.js orwellGameChanged) — "
        "no module may mint its own CustomEvent"
    )


def test_room_strip_listens_for_gamechanged():
    assert re.search(r'addEventListener\(\s*["\']orwell:gamechanged["\']', ROOM_STRIP), (
        "the strip must refresh on the shared game-changed signal"
    )


def test_g15_global_sweep_still_finds_exactly_one_dispatcher():
    """Drift guard mirroring test_g15_gamechanged.py's global sweep — pinned here too so this
    file alone proves the new module doesn't break the "exactly one dispatcher" invariant."""
    dispatch_re = re.compile(r"new CustomEvent\(\s*['\"]orwell:gamechanged['\"]")
    all_js = sorted(p for p in os.listdir(JS_DIR) if p.endswith(".js"))
    hits = [f for f in all_js if dispatch_re.search(_read("static", "js", f))]
    assert hits == ["platform.js"], f"expected only platform.js to dispatch, found {hits}"


# ── 3. pre-game / no-room collapse ─────────────────────────────────────────────────────

def test_collapses_when_the_game_has_not_started():
    assert "if (!state || !state.started) { render(null)" in ROOM_STRIP


def test_collapses_when_whereabouts_has_no_room():
    assert "if (!w || !w.room) { render(null)" in ROOM_STRIP


def test_render_unmounts_the_notice_on_a_falsy_context():
    fn = ROOM_STRIP[ROOM_STRIP.index("function render(ctx) {"):]
    fn = fn[:fn.index("\n  async function tick")]
    assert 'if (!ctx || !ctx.room || !Array.isArray(ctx.present)) {' in fn
    assert "notice.hide()" in fn


def test_an_empty_room_shows_just_you_here_instead_of_unmounting():
    fn = ROOM_STRIP[ROOM_STRIP.index("function render(ctx) {"):]
    fn = fn[:fn.index("\n  async function tick")]
    assert "if (!chips.length) {" in fn
    # ORW-246 (Ryne): the strip stays during play. Only the falsy-context branch (pre-game / no room) hides; an empty room
    # renders a "Just you here" label, never a hollow box and never a vanished strip.
    assert fn.count("notice.hide()") == 1
    assert "Just you here" in fn


def test_game_build_gated_and_fails_open_on_poll_error():
    assert 'dataset.gameBuild !== "1"' in ROOM_STRIP
    assert "render(null)" in ROOM_STRIP
    # the catch branch fails open (never throws to the page)
    tick_fn = ROOM_STRIP[ROOM_STRIP.index("async function tick()"):]
    tick_fn = tick_fn[:tick_fn.index("function refreshNow")]
    assert "} catch (_) {" in tick_fn
    # ORW-246: a failed poll keeps the last-known strip instead of blanking it (only the pre-game/no-room paths render(null))
    catch_fn = tick_fn[tick_fn.index("} catch (_) {"):tick_fn.index("} finally {")]
    assert "render(null)" not in catch_fn


# ── 4. kit wiring (M2-2 reuse) ─────────────────────────────────────────────────────────

def test_composes_the_monogram_kit_for_faces_and_role_badges():
    assert "window.OrwellMonogram.face(card" in ROOM_STRIP
    assert "window.OrwellMonogram.rolesFrom(statusData)" in ROOM_STRIP


def test_turned_in_renders_a_moon_badge():
    assert "ors-moon" in ROOM_STRIP and "🌙" in ROOM_STRIP


def test_composes_the_notice_kit_for_its_above_composer_anchor():
    # #642: the ONE stacked above-composer zone is the kit's — a new affordance must compose it
    # rather than hand-roll insertBefore(.chat-input-bar) (test_on_notice_kit.py's ratchet gate).
    assert "window.OrwellNoticeKit.create(" in ROOM_STRIP
    assert 'kind: "guide"' in ROOM_STRIP
    assert "dismissible: false" in ROOM_STRIP


def test_never_hand_rolls_the_composer_bar_anchor():
    # The anti-fragmentation sweep (test_on_notice_kit.py) forbids a NEW insertBefore(bar) against
    # .chat-input-bar — pinned here too so this file alone proves the module's CODE never regrows
    # it (the module doc comment above references .chat-input-bar in PROSE explaining the kit).
    assert ".chat-input-bar" not in ROOM_STRIP_CODE_ONLY
    assert "insertBefore" not in ROOM_STRIP_CODE_ONLY


def test_chips_are_inert_no_click_handler():
    # ADR 0003: chips augment, never act — no click-to-scene affordance (M3-6 owns the dossier
    # door later). This module must not wire any click handler on a chip.
    assert 'addEventListener("click"' not in ROOM_STRIP
    assert ".onclick" not in ROOM_STRIP


def test_script_tag_is_registered_in_index_html():
    html = _read("static", "index.html")
    assert "orwellRoomStrip.js" in html


# ── 5. "dimming on exit" — the pure diff helper, node-unit-tested ─────────────────────

def _extract_diff_presence(js):
    start = js.index("function _diffPresence(")
    end = js.index("function firstName(", start)
    return js[start:end].strip()


def test_diff_presence_helper_is_self_contained():
    src = _extract_diff_presence(ROOM_STRIP)
    assert src.startswith("function _diffPresence(")
    for forbidden in ("fetch(", "document", "localStorage", "await ", "window", "setTimeout"):
        assert forbidden not in src, f"_diffPresence must not depend on {forbidden!r}"


def _run_diff(prev_entries, present):
    """Run the real `_diffPresence` under node. `prev_entries` is a list of [key, person, phase]
    triples (JSON can't carry a Map, so we rebuild one in the harness)."""
    src = _extract_diff_presence(ROOM_STRIP)
    harness = (
        src
        + "\nconst PREV = new Map(" + json.dumps(prev_entries) + ".map(e => [e[0], {person: e[1], phase: e[2]}]));"
        + "\nconst PRESENT = " + json.dumps(present) + ";"
        + "\nconst { chips, next } = _diffPresence(PREV, PRESENT);"
        + "\nconsole.log(JSON.stringify({"
        + "  chips: chips.map(c => ({ key: c.key, name: c.person && c.person.name, phase: c.phase })),"
        + "  nextKeys: Array.from(next.entries()).map(([k, v]) => [k, v.phase]),"
        + "}));\n"
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


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_a_fresh_room_renders_everyone_here():
    present = [{"id": "npc:1", "name": "Alpha"}, {"id": "npc:2", "name": "Bravo"}]
    result = _run_diff([], present)
    assert [c["phase"] for c in result["chips"]] == ["here", "here"]
    assert {c["name"] for c in result["chips"]} == {"Alpha", "Bravo"}


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_someone_who_left_dims_for_one_cycle_then_drops():
    prev = [["id:npc:1", {"id": "npc:1", "name": "Alpha"}, "here"]]
    # Cycle 1: Alpha is gone from `present` — held ONE more cycle, dimmed ("leaving").
    cycle1 = _run_diff(prev, [])
    assert cycle1["chips"] == [{"key": "id:npc:1", "name": "Alpha", "phase": "leaving"}]
    assert dict(cycle1["nextKeys"]) == {"id:npc:1": "leaving"}

    # Cycle 2: still absent — the grace cycle is over, the chip drops entirely.
    cycle2 = _run_diff(cycle1["nextKeys"] and
                        [[k, {"id": "npc:1", "name": "Alpha"}, p] for k, p in cycle1["nextKeys"]], [])
    assert cycle2["chips"] == []
    assert cycle2["nextKeys"] == []


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_someone_who_returns_before_the_grace_cycle_ends_is_here_again():
    # Alpha was already "leaving" (one grace cycle spent) but walks back in — must render "here",
    # not silently stay dimmed or get dropped.
    prev = [["id:npc:1", {"id": "npc:1", "name": "Alpha"}, "leaving"]]
    result = _run_diff(prev, [{"id": "npc:1", "name": "Alpha"}])
    assert result["chips"] == [{"key": "id:npc:1", "name": "Alpha", "phase": "here"}]


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_here_chips_render_before_leaving_chips():
    prev = [["id:npc:2", {"id": "npc:2", "name": "Bravo"}, "here"]]
    result = _run_diff(prev, [{"id": "npc:1", "name": "Alpha"}])
    assert [c["phase"] for c in result["chips"]] == ["here", "leaving"]
    assert result["chips"][0]["name"] == "Alpha"
    assert result["chips"][1]["name"] == "Bravo"


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_missing_id_falls_back_to_name_identity():
    prev = [["nm:Alpha", {"name": "Alpha"}, "here"]]
    result = _run_diff(prev, [{"name": "Alpha"}])
    assert result["chips"] == [{"key": "nm:Alpha", "name": "Alpha", "phase": "here"}]


# ── 6. responsive matrix registration (collapses gracefully on narrow viewports) ──────

def test_registered_in_the_responsive_matrix_overlap_sweep():
    matrix = _read("scripts", "responsive_matrix.py")
    assert '"#orwell-room-strip"' in matrix, (
        "the room strip must be registered in GAME_SURFACES so the overlap/overflow sweep "
        "covers it at every phone viewport tier (tiny-320 through wide-1440)"
    )


def test_strip_scrolls_horizontally_instead_of_forcing_page_overflow():
    # The chip row scrolls WITHIN itself at narrow widths rather than widening the page.
    assert "overflow-x: auto" in ROOM_STRIP
    assert "flex-wrap: nowrap" in ROOM_STRIP


def test_narrow_viewport_media_query_shrinks_the_strip():
    assert "@media (max-width: 480px)" in ROOM_STRIP
