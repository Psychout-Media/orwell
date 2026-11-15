"""M4-1 — the houseguest dossier (road-to-market audit C4 + idea 12).

Cast tiles used to be dead ends: a portrait, a name, a status, nothing else. This is the "who is
this person, and what has actually happened between us" surface — public persona + met/last-seen
+ WITNESSED history beats + public deals/alliances with the player. The content contract (DoR)
is facts and sources ONLY, never a weight/number/hidden edge (the Vault Wall; the player forms
their own reads).

Gate shape, mirroring the casting-leak gate template (test_casting_leak_gate.py): seed the
engine's public projections with a UNIQUE, unambiguous Vault-shaped sentinel planted alongside
legitimate public fields, drive the REAL route, and assert the sentinel never crosses — while the
legitimate fields DO. Also pins: the kit composition (F-3 ratchet), the ONE shared open-dossier
handler contract, the empty state, and the cast window's paging→full-grid replacement (the C4
"2×2-dots" finding).
"""
import importlib
import os
import re

from fastapi import FastAPI
from fastapi.testclient import TestClient

orwell_engine = importlib.import_module("src.orwell_engine")
orwell_routes = importlib.import_module("routes.orwell_routes")

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS_DIR = os.path.join(FRONTEND, "static", "js")

# A unique, unambiguous marker — if this shows up anywhere in a dossier response it is
# unambiguously a Vault leak (mirrors CASTING_SENTINEL's role in test_casting_leak_gate.py).
VAULT_SENTINEL = "ZZ-VAULT-SECRET-do-not-render-ZZ"


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


def _client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app)


# A state payload shaped like a real getGameState response, but with Vault-only fields planted
# on EVERY object the dossier touches (a houseguest card, a deal, an alliance) — the fields a
# real HouseguestCard/DealView/AllianceView projection would NEVER carry, standing in for "some
# future field leaked onto the Vault-free projection by accident".
def _seeded_state():
    return {
        "started": True,
        "player": {"id": "player", "name": "The Player", "status": "active"},
        "house": [
            {
                "id": "npc:1", "name": "Alex", "status": "active",
                "archetype": "The Strategist", "strategyStyle": "social", "vocation": "Chef",
                "hometown": "Austin", "age": 29, "demeanor": "wry", "biography": "Loves puzzles.",
                # Vault-shaped fields that must NEVER reach the FE
                "trustOfPlayer": 0.87, "threatLevel": 42, "secretGoal": VAULT_SENTINEL,
                "confidence": 0.61, "distortion": 0.2,
            },
            {"id": "npc:2", "name": "Bo", "status": "evicted", "secretGoal": VAULT_SENTINEL},
        ],
        "deals": [
            {
                "id": "d1",
                "parties": [{"id": "player", "name": "The Player"}, {"id": "npc:1", "name": "Alex"}],
                "kind": "safety", "terms": "Won't nominate each other", "status": "open",
                "trustDelta": -0.4, "hiddenNote": VAULT_SENTINEL,
            },
        ],
        "alliances": [
            {
                "id": "a1", "name": "The Vault Alliance",
                "members": [{"id": "player", "name": "The Player"}, {"id": "npc:1", "name": "Alex"}],
                "youAreFounder": True, "secretCohesion": 0.55, "hiddenNote": VAULT_SENTINEL,
            },
        ],
    }


def _seeded_visible_state():
    return {
        "visibleEvents": [
            {"id": "e1", "ts": 5, "type": "conversation", "initiator": "npc:1",
             "witnessSet": ["player", "npc:1"], "content": "Alex pulls you aside in the kitchen.",
             "hidden": False, "reveal": True},
            {"id": "e2", "ts": 2, "type": "conversation", "initiator": "player",
             "witnessSet": ["player", "npc:2"], "content": "You chat with Bo by the pool.",
             "hidden": False},
            {"id": "e3", "ts": 9, "type": "house-event", "initiator": "npc:1",
             "witnessSet": ["player", "npc:1", "npc:2"], "content": "Alex hosts game night.",
             "hidden": False},
        ],
        # M4-1 deliberately does NOT render `knowledge` (confidence/distortion beliefs are the
        # M4-2 Memory Wall's surface) — plant a sentinel here too, to prove it is never touched.
        "knowledge": [
            {"id": "k1", "content": VAULT_SENTINEL, "pathway": "told-by:npc:3",
             "subject": "npc:1", "confidence": 0.4, "ts": 1},
        ],
    }


def _wire(monkeypatch, state=None, vis=None, vis_raises=False):
    async def fake_state(user=None, timeout=None):
        return state if state is not None else _seeded_state()

    async def fake_vis(user=None):
        if vis_raises:
            raise RuntimeError("engine hiccup")
        return vis if vis is not None else _seeded_visible_state()

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_visible_state", fake_vis)


# ─────────────────────────────────────────────────────────────────────────────
# 1. The route itself — the Vault-freedom leak test (the casting-leak gate template)
# ─────────────────────────────────────────────────────────────────────────────

def test_dossier_route_never_leaks_a_vault_shaped_field(monkeypatch):
    _wire(monkeypatch)
    r = _client().get("/api/orwell/dossier/npc:1")
    assert r.status_code == 200
    body = r.json()
    blob = r.text
    # THE GATE: no sentinel, anywhere in the response, in any form.
    assert VAULT_SENTINEL not in blob, "the dossier route leaked a Vault-shaped field"
    for banned_key in ("trustOfPlayer", "threatLevel", "confidence", "distortion",
                       "trustDelta", "hiddenNote", "secretCohesion", "secretGoal"):
        assert banned_key not in blob, f"leaked field name {banned_key!r} in the dossier response"
    # The legitimate facts DID come through (the fix isn't "render nothing").
    assert body["found"] is True
    assert body["name"] == "Alex"
    assert body["persona"]["archetype"] == "The Strategist"
    assert body["persona"]["biography"] == "Loves puzzles."
    assert any(b["content"] == "Alex pulls you aside in the kitchen." for b in body["history"])
    assert body["deals"][0]["terms"] == "Won't nominate each other"
    assert body["alliances"][0]["name"] == "The Vault Alliance"


def test_dossier_route_never_touches_the_knowledge_beliefs_surface(monkeypatch):
    """M4-1 is explicitly scoped to WITNESSED events — belief/confidence facts are the M4-2
    Memory Wall's surface. Prove the route doesn't even echo a `knowledge` entry's content."""
    _wire(monkeypatch)
    r = _client().get("/api/orwell/dossier/npc:1")
    assert VAULT_SENTINEL not in r.text


def test_dossier_route_scopes_history_to_the_named_houseguest(monkeypatch):
    """A beat that never involved npc:2 (Alex-only) must not show up on npc:2's dossier, and
    vice versa — the route narrows the player's ALREADY-witnessed set, it doesn't broaden it."""
    _wire(monkeypatch)
    alex = _client().get("/api/orwell/dossier/npc:1").json()
    bo = _client().get("/api/orwell/dossier/npc:2").json()
    alex_contents = {b["content"] for b in alex["history"]}
    bo_contents = {b["content"] for b in bo["history"]}
    assert "Alex pulls you aside in the kitchen." in alex_contents
    assert "Alex pulls you aside in the kitchen." not in bo_contents  # Bo wasn't in that scene
    assert "You chat with Bo by the pool." in bo_contents
    assert "You chat with Bo by the pool." not in alex_contents      # Alex wasn't in that scene
    assert "Alex hosts game night." in alex_contents and "Alex hosts game night." in bo_contents


def test_dossier_route_scopes_deals_and_alliances_to_the_named_houseguest(monkeypatch):
    _wire(monkeypatch)
    bo = _client().get("/api/orwell/dossier/npc:2").json()
    assert bo["deals"] == []       # the only deal is with Alex (npc:1), not Bo
    assert bo["alliances"] == []   # the only alliance is with Alex, not Bo


def test_dossier_route_unknown_id_is_an_honest_not_found(monkeypatch):
    _wire(monkeypatch)
    r = _client().get("/api/orwell/dossier/npc:does-not-exist")
    assert r.status_code == 200
    assert r.json() == {"found": False}


def test_dossier_route_pregame_is_not_found(monkeypatch):
    _wire(monkeypatch, state={"started": False})
    r = _client().get("/api/orwell/dossier/npc:1")
    assert r.json() == {"found": False}


def test_dossier_route_fails_open_on_engine_error(monkeypatch):
    async def boom(user=None, timeout=None):
        raise RuntimeError("engine down")

    monkeypatch.setattr(orwell_engine, "get_game_state", boom)
    r = _client().get("/api/orwell/dossier/npc:1")
    assert r.status_code == 200
    assert r.json() == {"found": False}


def test_dossier_route_history_read_failure_still_renders_persona(monkeypatch):
    """A visible-state read failure must degrade to an empty history, not a whole-route failure —
    the persona/deals/alliances sections are independently useful."""
    _wire(monkeypatch, vis_raises=True)
    r = _client().get("/api/orwell/dossier/npc:1")
    body = r.json()
    assert body["found"] is True
    assert body["history"] == []
    assert body["met"] is False


def test_dossier_route_met_is_false_with_no_witnessed_beats(monkeypatch):
    _wire(monkeypatch, vis={"visibleEvents": [], "knowledge": []})
    r = _client().get("/api/orwell/dossier/npc:1").json()
    assert r["met"] is False
    assert r["history"] == []


def test_dossier_route_history_is_newest_first(monkeypatch):
    _wire(monkeypatch)
    r = _client().get("/api/orwell/dossier/npc:1").json()
    tss = [b["ts"] for b in r["history"]]
    assert tss == sorted(tss, reverse=True)


def test_dossier_route_player_card_resolves(monkeypatch):
    """The player's own cast tile resolves too (isPlayer:true) — it must never crash or 404."""
    _wire(monkeypatch)
    r = _client().get("/api/orwell/dossier/player")
    assert r.status_code == 200
    body = r.json()
    assert body["found"] is True
    assert body["isPlayer"] is True


# ─────────────────────────────────────────────────────────────────────────────
# 2. The backend allowlist helpers — a poisoned dict never survives the allowlist
# ─────────────────────────────────────────────────────────────────────────────

def test_public_persona_is_an_explicit_allowlist():
    poisoned = {
        "archetype": "Villain", "trustOfPlayer": 0.9, "secretGoal": VAULT_SENTINEL,
        "physicalCharacteristics": {"x": 1}, "voice": "raspy",
    }
    out = orwell_routes._public_persona(poisoned)
    assert out == {"archetype": "Villain"}


def test_public_deal_is_an_explicit_allowlist():
    poisoned = {
        "id": "d1", "parties": [{"id": "player", "name": "P"}], "kind": "safety",
        "terms": "t", "status": "open", "trustDelta": -0.4, "hiddenNote": VAULT_SENTINEL,
    }
    out = orwell_routes._public_deal(poisoned)
    assert set(out.keys()) == {"id", "parties", "kind", "terms", "status"}


def test_public_deal_deep_allowlists_nested_party_refs():
    """Nested NamedRefs must be rebuilt from id/name ONLY — a ref carrying a non-public field
    used to serialize VERBATIM into the player-facing route (review P1, PR #1242)."""
    poisoned = {
        "id": "d1", "kind": "safety", "terms": "t", "status": "open",
        "parties": [{"id": "npc:1", "name": "A", "trust": 0.93, "hiddenNote": VAULT_SENTINEL}],
    }
    out = orwell_routes._public_deal(poisoned)
    assert out["parties"] == [{"id": "npc:1", "name": "A"}]
    # a plain-string ref survives as a public id/name pair (FE reads .name)
    assert orwell_routes._public_ref("npc:2") == {"id": "npc:2", "name": "npc:2"}


def test_public_alliance_is_an_explicit_allowlist():
    poisoned = {
        "id": "a1", "name": "n", "members": [], "youAreFounder": True,
        "secretCohesion": 0.5, "hiddenNote": VAULT_SENTINEL,
    }
    out = orwell_routes._public_alliance(poisoned)
    assert set(out.keys()) == {"id", "name", "members", "youAreFounder"}


def test_public_alliance_deep_allowlists_nested_member_refs():
    poisoned = {
        "id": "a1", "name": "n", "youAreFounder": False,
        "members": [{"id": "npc:3", "name": "B", "loyalty": 0.7, "hiddenNote": VAULT_SENTINEL}],
    }
    out = orwell_routes._public_alliance(poisoned)
    assert out["members"] == [{"id": "npc:3", "name": "B"}]


def test_public_beat_is_an_explicit_allowlist():
    poisoned = {
        "id": "e1", "ts": 1, "type": "conversation", "content": "hi",
        "witnessSet": ["player", "npc:1"], "hidden": False, "reveal": True,
        "secretNote": VAULT_SENTINEL,
    }
    out = orwell_routes._public_beat(poisoned)
    assert set(out.keys()) == {"id", "ts", "type", "content"}


# ─────────────────────────────────────────────────────────────────────────────
# 3. The FE module — kit composition (F-3 ratchet), the shared handler contract,
#    Vault-adjacent-token absence, the empty state, and dependency-lightness.
# ─────────────────────────────────────────────────────────────────────────────

# Concrete Vault-shaped PROPERTY ACCESSES that must never appear in the render-only FE modules —
# a static companion to the route-level leak test. Scoped to `.field`-style access on the exact
# hidden-layer field names (KnowledgeFact's confidence/distortion/hops/source, and the poisoned
# names used in the route-level sentinel test above), NOT prose word-matching — this file's own
# doc comments legitimately discuss "the Vault Wall" / "a hidden edge" while never READING one.
FORBIDDEN_PROPERTY_ACCESS = (
    "confidence", "distortion", "hops", "trustOfPlayer", "threatLevel", "secretGoal",
    "secretCohesion", "trustDelta", "hiddenNote", "sourceEventId", "originalContent",
)


def test_dossier_composes_the_window_kit():
    js = _read("static", "js", "orwellDossier.js")
    assert "window.OrwellWindowKit.create(" in js
    # F-3 ratchet: never hand-roll drag/slot/dock registration directly.
    for banned in ("makeWindowDraggable(", "OrwellSlots.register(", "modalManager.register(",
                   "Modals.register("):
        assert banned not in js, f"orwellDossier.js: {banned} regrew — compose the kit"


def test_dossier_exports_one_shared_open_handler():
    js = _read("static", "js", "orwellDossier.js")
    assert "window.OrwellDossier = { open }" in js or re.search(
        r"window\.OrwellDossier\s*=\s*\{\s*open\s*\}", js)


def test_dossier_has_the_designed_empty_state():
    js = _read("static", "js", "orwellDossier.js")
    assert "You haven't crossed paths yet" in js


def test_dossier_fetches_only_the_one_dossier_route():
    """The whole Vault-freedom argument for this module rests on it having exactly ONE data
    source. If it ever fetches a second route directly, that route's Vault-freedom would need
    re-auditing too — so pin it to one."""
    js = _read("static", "js", "orwellDossier.js")
    urls = re.findall(r'getJSON\(\s*"([^"]+)"', js) + re.findall(r'fetch\(\s*"([^"]+)"', js)
    assert urls, "expected at least one fetch"
    for u in urls:
        assert u.startswith("/api/orwell/dossier/"), f"unexpected fetch target {u!r}"


def test_dossier_and_factline_never_access_a_vault_shaped_field():
    for fname in ("orwellDossier.js", "orwellFactLine.js"):
        js = _read("static", "js", fname)
        for field in FORBIDDEN_PROPERTY_ACCESS:
            assert not re.search(r"\." + field + r"\b", js), (
                f"{fname} accesses `.{field}` — the dossier renders facts and sources only, "
                "never a hidden edge or a weight/number."
            )


def test_factline_is_dependency_light_and_render_only():
    js = _read("static", "js", "orwellFactLine.js")
    assert "fetch(" not in js, "orwellFactLine must be render-only (no data access)"
    assert "window.OrwellFactLine" in js
    assert "function row(" in js


def test_factline_never_formats_a_raw_number():
    """The row() contract takes already-qualitative text/source strings — it must have no
    numeric-formatting path (toFixed / percentage math) that could let a raw confidence number
    slip through as a caller mistake."""
    js = _read("static", "js", "orwellFactLine.js")
    assert "toFixed" not in js
    assert "Math.round" not in js


def test_index_loads_the_kit_and_factline_before_the_dossier():
    html = _read("static", "index.html")
    assert "orwellWindow.js" in html and "orwellDossier.js" in html
    assert html.index("orwellWindow.js") < html.index("orwellDossier.js")
    assert "orwellFactLine.js" in html
    assert html.index("orwellFactLine.js") < html.index("orwellDossier.js")


# ─────────────────────────────────────────────────────────────────────────────
# 4. The cast-window tile hook (M3-6-ready) + the paging→full-grid replacement
# ─────────────────────────────────────────────────────────────────────────────

def test_cast_tiles_open_the_dossier():
    js = _read("static", "js", "orwellCast.js")
    assert "OrwellDossier.open(" in js
    # Keyboard-operable door, not a mouse-only click target (idea 6 / M3-6 DoD).
    assert 'role", "button"' in js or "role', 'button'" in js
    assert "tabIndex = 0" in js
    assert "Enter" in js and '" "' in js  # the Space-key literal in the keydown guard


def test_cast_window_paging_replaced_by_a_full_grid():
    """Audit C4's '2×2-dots' finding: the cast roster used to be a horizontally-paged,
    scroll-snapped 2x2 gallery with click-through dots. It must now be a single wrapping grid —
    every houseguest visible without paging (the window scrolls vertically instead)."""
    js = _read("static", "js", "orwellCast.js")
    for gone in ("grid-auto-flow: column", "scroll-snap-type", "oc-dots", "oc-dot-cur",
                 "bindGallery", "syncGallery", "pageMetrics", "oc-at-end"):
        assert gone not in js, f"orwellCast.js still carries the paging affordance {gone!r}"
    assert "grid-template-columns: repeat(var(--oc-cols)" in js


def test_cast_window_still_responsive_by_column_count():
    """The M4-1 rewrite reuses --oc-cols + the SAME @container breakpoints (240/480/620) that
    test_977_cast_window_resizable.py pins — now driving wrap-columns instead of page-columns."""
    js = _read("static", "js", "orwellCast.js")
    assert re.search(r"@container[^{]*max-width:\s*240px", js)
    assert re.search(r"@container[^{]*min-width:\s*480px", js)
    assert re.search(r"@container[^{]*min-width:\s*620px", js)
    assert re.search(r"--oc-cols:\s*\d", js)


def test_cast_and_dossier_js_are_syntactically_valid():
    """Cheap belt-and-braces alongside the `node --check` gate the agent runs separately —
    catches an unterminated template literal (a stray backtick inside a CSS comment) even if
    this suite ever runs somewhere `node` isn't on PATH."""
    import subprocess
    import shutil

    node = shutil.which("node")
    if not node:
        return  # node --check is covered by CI/the harness's own gate; skip quietly here
    for fname in ("orwellCast.js", "orwellDossier.js", "orwellFactLine.js"):
        path = os.path.join(JS_DIR, fname)
        r = subprocess.run([node, "--check", path], capture_output=True, text=True)
        assert r.returncode == 0, f"{fname} failed node --check:\n{r.stderr}"
