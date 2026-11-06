"""M2-3 (audit B2) — the premiere cast strip + the pre-HOH board reframe.

The status panel (`orwellStatusPanel.js`) gains, during the premiere only:
  1. a sixteen-tile cast STRIP built on the shared `OrwellMonogram.face()` kit, each tile lit
     (met) or unlit (not-yet-met) per the engine's Vault-free `premiere` projection — the
     met-progress gate made visible (0/15 -> 15/15);
  2. a pre-HOH board REFRAME — before the first HOH exists (week 1, no HOH crowned), the three
     dead "HOH -/ Noms -/ Veto -" rows read "First HOH tonight" instead of the em-dashes.

Constraints proven here: the tiles render ONLY roster / met / public-status data (Vault-free — no
hidden key or number crosses), clicking a tile FOCUSES the chat (ADR 0003: augment, never replace),
and the strip retires with the premiere block (docks off after the first HOH).

The FE pytest lane has no DOM runtime, so the DOM-touching render is source-pinned, and the two PURE
helpers (`isPreHoh`, `premiereUnmetIds`) are executed in node against fixtures (the real, unmodified
source) so the behavior — not just the wording — is asserted. Live DOM is covered by browser_smoke.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile

import pytest

FE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PANEL = os.path.join("static", "js", "orwellStatusPanel.js")


def _read(rel: str) -> str:
    with open(os.path.join(FE, rel), encoding="utf-8") as fh:
        return fh.read()


def _fn_body(src: str, name: str) -> str:
    """Slice a top-level `function name(...) { ... }` by brace-matching from its signature."""
    start = src.index("function " + name + "(")
    i = src.index("{", start)
    depth = 0
    for j in range(i, len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                return src[start : j + 1]
    raise AssertionError("unterminated function " + name)


# ── the strip is built on the shared monogram kit, from public roster cards only ── #

def test_strip_markup_and_kit_wiring_exist():
    src = _read(PANEL)
    # the strip container lives inside the premiere block (so it retires with it) …
    assert 'id="os-prem-strip"' in src
    assert "function renderPremiereStrip(" in src
    # … and is called from the premiere renderer.
    assert "renderPremiereStrip(el, state)" in src
    body = _fn_body(src, "renderPremiereStrip")
    # tiles are the shared OrwellMonogram.face() kit (the DoD component), not a bespoke face.
    assert "window.OrwellMonogram.face(" in body
    # sixteen tiles = the player + every house card (the full roster).
    assert "state.player" in body or "state && state.player" in body
    assert "state.house" in body or "state && state.house" in body


def test_strip_tile_data_is_vault_free():
    """The tile render reads ONLY the public roster card (id/name/status/portrait/isPlayer) and the
    premiere projection (remaining/complete/houseguest) — never a hidden stat, soul, or number."""
    src = _read(PANEL)
    body = _fn_body(src, "renderPremiereStrip")
    accessed = set(re.findall(r"\.(\w+)", body))
    # NB: `.hidden` here is the DOM property (strip.hidden = ...), not a Vault field — excluded.
    leaky = {"trust", "affinity", "threat", "stats", "physical", "mental", "social",
             "soul", "emotional", "confidence", "vault", "secret"}
    assert not (accessed & leaky), f"strip render reads hidden fields: {accessed & leaky}"
    # #1324: the render itself never fetches — it consults the ALREADY-loaded shared
    # OrwellMonogram portrait cache (orwellMonogram.js owns the one out-of-band fetch).
    assert "fetch(" not in body


# ── #1324: the strip resolves REAL portraits from the shared cache, never monogram-only ── #

def test_strip_no_longer_forces_the_monogram_only_fallback():
    """Regression pin for issue #1324: the premiere strip used to hard-code
    `portrait: null, forceMono: true`, so a tile could NEVER show a real portrait even after one
    was generated mid-premiere. The fix consults OrwellMonogram's shared portrait cache and lets
    face() pick a real portrait over the monogram fallback on its own (the sanctioned default)."""
    src = _read(PANEL)
    body = _fn_body(src, "renderPremiereStrip")
    assert "forceMono" not in body, "the strip must be able to upgrade to a real portrait"
    assert "portrait: null" not in body
    assert "OrwellMonogram.portraitFor" in body


def test_strip_tile_signature_includes_the_portrait_so_it_upgrades_mid_premiere():
    """The keyed-upsert repaint-only-on-change `sig` must fold in whether a cached portrait is
    present — otherwise a tile that loaded BEFORE the portrait landed would never repaint once
    generation finishes mid-premiere (the 'stays a monogram forever' half of #1324)."""
    src = _read(PANEL)
    body = _fn_body(src, "renderPremiereStrip")
    sig_line = next(ln for ln in body.splitlines() if ln.strip().startswith("const sig ="))
    assert "cached" in sig_line and "portrait" in sig_line, \
        f"tile sig must include the cached-portrait presence: {sig_line!r}"


def test_premiere_unmet_helper_is_vault_free():
    src = _read(PANEL)
    body = _fn_body(src, "premiereUnmetIds")
    accessed = set(re.findall(r"\.(\w+)", body))
    leaky = {"trust", "affinity", "threat", "stats", "physical", "mental", "social",
             "soul", "emotional", "confidence"}
    assert not (accessed & leaky), f"unmet derivation reads hidden fields: {accessed & leaky}"


# ── clicking a tile FOCUSES the chat, never replaces it (ADR 0003) ── #

def test_tile_click_focuses_chat_never_replaces():
    src = _read(PANEL)
    body = _fn_body(src, "renderPremiereStrip")
    assert 'addEventListener("click", focusChat)' in body
    focus = _fn_body(src, "focusChat")
    # focus the composer + scroll it into view — an AUGMENT. No navigation / no chat replacement.
    assert 'getElementById("message")' in focus
    assert ".focus()" in focus
    assert "scrollIntoView" in focus
    for banned in ("location", "innerHTML =", "location.href", "navigate"):
        assert banned not in focus, f"tile click must not {banned!r} (ADR 0003: never replace chat)"


# ── the pre-HOH board reframe copy + gate ── #

def test_prehoh_reframe_copy_and_markup():
    src = _read(PANEL)
    assert "First HOH tonight" in src
    assert 'id="os-prehoh"' in src
    assert 'id="os-board"' in src
    # the three em-dash rows still exist (they update underneath) — just hidden pre-HOH.
    for row in ("os-hoh", "os-noms", "os-veto"):
        assert row in src
    # render() toggles the board vs. the reframe line off isPreHoh.
    assert "isPreHoh(st)" in src


# ── node-executed BEHAVIOR of the two pure helpers (against the real source) ── #

def _node_eval(src_fns: str, call: str):
    harness = src_fns + "\nconsole.log(JSON.stringify(" + call + "));\n"
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
def test_prehoh_gate_behaviour():
    src = _read(PANEL)
    fn = _fn_body(src, "isPreHoh")
    # Week 1, no HOH yet, not finished -> the reframe is on.
    assert _node_eval(fn, 'isPreHoh({"week": 1})') is True
    assert _node_eval(fn, 'isPreHoh({"week": 1, "hoh": null})') is True
    # An HOH exists -> board, not the reframe.
    assert _node_eval(fn, 'isPreHoh({"week": 1, "hoh": {"id": "hg-3", "name": "n"}})') is False
    # Past week 1 (a later week always has a crowned HOH) -> board.
    assert _node_eval(fn, 'isPreHoh({"week": 2})') is False
    # Season over -> never the reframe.
    assert _node_eval(fn, 'isPreHoh({"week": 1, "finished": true})') is False


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_met_progress_gate_behaviour():
    """The strip's lit/unlit state is the met-progress gate: a houseguest in the premiere's
    `remaining` set is NOT yet met (unlit); everyone else is met (lit). Player is always met."""
    src = _read(PANEL)
    fn = _fn_body(src, "premiereUnmetIds")
    # 0/N met: three still to meet -> all three ids are unmet.
    prem_start = {"remaining": [
        {"houseguest": {"id": "hg-1", "name": "a"}},
        {"houseguest": {"id": "hg-2", "name": "b"}},
        {"houseguest": {"id": "hg-3", "name": "c"}},
    ]}
    unmet = _node_eval(fn, "premiereUnmetIds(" + json.dumps(prem_start) + ")")
    assert set(unmet) == {"hg-1", "hg-2", "hg-3"}
    # progress: one met -> only the two remaining are unmet.
    prem_mid = {"remaining": [
        {"houseguest": {"id": "hg-2", "name": "b"}},
        {"houseguest": {"id": "hg-3", "name": "c"}},
    ]}
    assert set(_node_eval(fn, "premiereUnmetIds(" + json.dumps(prem_mid) + ")")) == {"hg-2", "hg-3"}
    # 15/15 met -> nothing left, every tile lights up.
    assert _node_eval(fn, 'premiereUnmetIds({"remaining": []})') == []
    # a name-only ref (no id) still keys off the name (defensive fallback).
    assert _node_eval(fn, 'premiereUnmetIds({"remaining": [{"houseguest": {"name": "z"}}]})') == ["z"]
    # absent / malformed projection -> empty (fail-soft, never throws).
    assert _node_eval(fn, "premiereUnmetIds(null)") == []
    assert _node_eval(fn, 'premiereUnmetIds({"complete": true})') == []


# ── the strip retires with the premiere block (docks off after the first HOH) ── #

def test_strip_hides_when_premiere_absent():
    # CHAMPAGNE CIRCLE (feature 0111, owner ruling 2026-07-14): the whole house is met at the toast, so the
    # roster strip shows THROUGHOUT the premiere (no `complete` gate) and retires only when the engine drops
    # the `premiere` field (the first HOH begins ⇒ the `!prem` guard fires).
    src = _read(PANEL)
    body = _fn_body(src, "renderPremiereStrip")
    # absent OR no kit -> hide the strip and tear its tiles down via the shared helper.
    assert "!prem" in body                     # absent-premiere guard
    assert "prem.complete" not in body         # NO complete gate anymore (roster shows all premiere)
    assert "!window.OrwellMonogram" in body    # no-kit guard
    assert "clearPremiereStrip(el)" in body
    # the shared teardown both hides the strip AND removes every tile (button + its click listener).
    clear = _fn_body(src, "clearPremiereStrip")
    assert "strip.hidden = true" in clear
    assert "_stripTiles.delete(k)" in clear
    # the parent #os-premiere block is itself hidden by renderPremiere when premiere is absent (outer retire) …
    prem = _fn_body(src, "renderPremiere")
    assert "prem.complete" not in prem         # the outer block no longer gates on complete either
    assert "wrap.hidden = true" in prem
    # … and renderPremiere ALSO tears the strip down on its early hide paths (no stale tiles linger).
    assert "clearPremiereStrip(el)" in prem


def test_empty_strip_stays_hidden_against_the_flex_default():
    """The `.os-prem-strip` rule sets display:flex, which would override the UA [hidden]{display:none};
    an explicit `[hidden]{display:none!important}` keeps an empty strip (no premiere / no cards) from
    rendering as a blank flex row."""
    src = _read(PANEL)
    assert ".os-prem-strip[hidden]" in src
    assert re.search(r"\.os-prem-strip\[hidden\]\s*\{\s*display:\s*none\s*!important", src)


def test_strip_is_capped_at_sixteen_tiles_and_deduped():
    """The strip is player + up to 15 houseguests; an oversized/duplicated public roster must not
    exceed sixteen tiles or repeat an id."""
    src = _read(PANEL)
    body = _fn_body(src, "renderPremiereStrip")
    assert "cards.length >= 16" in body          # the hard cap
    assert "cardKeys" in body                     # the id-dedupe guard


def test_met_lighting_honors_the_name_fallback():
    """premiereUnmetIds keys by id-or-name; the tile lighting must check BOTH so a name-only
    `remaining` ref doesn't wrongly light an id-carrying roster card as met."""
    src = _read(PANEL)
    body = _fn_body(src, "renderPremiereStrip")
    # BOTH lookups must survive: the id path (key = String(card.id)) and the name fallback.
    assert "const key = String(card.id)" in body
    assert "unmet.has(key)" in body
    assert "unmet.has(String(card.name))" in body


def test_strip_is_the_unlit_class_gate():
    src = _read(PANEL)
    # the not-yet-met class the CSS dims — the visible "lights up" gate.
    assert "os-tile-unmet" in src
    assert ".os-tile-unmet" in src  # the CSS rule exists


# ── ORW-196: during the staged entrances the engine's `remaining` holds anonymous ordinal placeholders; the strip dims un-arrived houseguests via `met` ── #

@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_unarrived_roster_tiles_are_dimmed_from_the_met_list_during_entrances():
    fn = _fn_body(_read(PANEL), "premiereUnmetIds")
    roster = [{"id": "npc:1", "name": "n1"}, {"id": "npc:2", "name": "n2"}, {"id": "npc:3", "name": "n3"}]
    prem = {
        "complete": False,
        "met": [{"houseguest": {"id": "npc:1", "name": "n1"}}],
        # anonymous ordinal placeholders: they can NOT be joined to roster ids
        "remaining": [{"houseguest": {"id": "unarrived:1", "name": "(not yet arrived)"}},
                      {"houseguest": {"id": "unarrived:2", "name": "(not yet arrived)"}}],
        "entrance": {"stage": "entrances"},
    }
    unmet = _node_eval(fn, "premiereUnmetIds(" + json.dumps(prem) + "," + json.dumps(roster) + ")")
    assert set(unmet) == {"npc:2", "npc:3"}, "the two houseguests not in `met` are dimmed"
    # once everyone has arrived (toast), every tile is lit
    prem_done = {"complete": True, "remaining": [], "met": [{"houseguest": {"id": r["id"], "name": r["name"]}} for r in roster]}
    assert _node_eval(fn, "premiereUnmetIds(" + json.dumps(prem_done) + "," + json.dumps(roster) + ")") == []
    # the name key also matches (id-or-name, like the tile lighting)
    assert _node_eval(fn, "premiereUnmetIds(" + json.dumps({"met": [{"houseguest": {"name": "n2"}}]}) + "," + json.dumps(roster) + ")") == ["npc:1", "npc:3"]
    # no roster argument => the old `remaining`-id behaviour (back-compat)
    assert _node_eval(fn, "premiereUnmetIds(" + json.dumps(prem) + ")") == ["unarrived:1", "unarrived:2"]


def test_the_strip_passes_the_roster_so_unarrived_tiles_dim():
    src = _read(PANEL)
    assert "premiereUnmetIds(prem, cards.filter((c) => !c.isPlayer)" in src
    assert "ALWAYS" not in _fn_body(src, "premiereUnmetIds")
