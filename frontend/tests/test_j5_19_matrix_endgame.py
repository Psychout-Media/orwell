"""J5-19 — the responsive-matrix endgame sweep exists and is guarded.

scripts/responsive_matrix.py's default stage_game() only creates a FRESH (turn-0) game, so the
endgame surfaces (#orwell-retro self-gates on recap.finished; the endgame decision card needs a
live finale pending) never render under it — leaving the endgame mobile UX asserted by source-
string tests only, never a viewport render. The opt-in finish_game() path fixes that.

These are CHEAP guard checks (import + source), NOT a live matrix run (that needs a real engine and
would race the shared sandbox). They prove the new path is present, opt-in (default OFF), and can
never alter the default fresh-game run.
"""
import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "responsive_matrix.py"


def _load(monkeypatch=None, **env):
    """Import the script module in isolation with a controlled environment (it reads its flags at
    import time only — no I/O), so we can assert the default vs. opt-in posture."""
    import os
    for k, v in env.items():
        os.environ[k] = v
    # Clear the opt-in/engine flags unless the caller set them, so the default-posture assertions
    # are independent of the ambient CI env.
    for k in ("ORWELL_MATRIX_FINISH", "ORWELL_MATRIX_ENGINE", "ORWELL_MATRIX_USER"):
        if k not in env:
            os.environ.pop(k, None)
    spec = importlib.util.spec_from_file_location("responsive_matrix_under_test", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_endgame_fixtures_exist():
    mod = _load()
    for fn in ("finish_game", "mount_endgame_card", "mount_retro", "remove_endgame_card",
               "_engine_tool", "_auto_resolve"):
        assert callable(getattr(mod, fn, None)), f"responsive_matrix.{fn} missing"


def test_finish_season_is_opt_in_and_off_by_default():
    """Default (no flag) → FINISH_SEASON is False AND finish_game() is a no-op (no engine call)."""
    mod = _load()
    assert mod.FINISH_SEASON is False, "the endgame pass must be OFF by default"
    # No engine URL + flag off → immediate (False, None); never touches the network.
    assert mod.finish_game() == (False, None)


def test_finish_flag_truthy_forms():
    assert _load(ORWELL_MATRIX_FINISH="1").FINISH_SEASON is True
    assert _load(ORWELL_MATRIX_FINISH="true").FINISH_SEASON is True
    # falsey spellings stay OFF (the guard mirrors the engine's flag convention).
    assert _load(ORWELL_MATRIX_FINISH="0").FINISH_SEASON is False
    assert _load(ORWELL_MATRIX_FINISH="false").FINISH_SEASON is False


def test_finish_game_noops_without_engine_even_when_flag_set():
    """Flag on but no engine URL → still a no-op (the second guard). Can't break the default run."""
    mod = _load(ORWELL_MATRIX_FINISH="1")  # ORWELL_MATRIX_ENGINE intentionally unset
    assert mod.ENGINE_URL == ""
    assert mod.finish_game() == (False, None)


def test_decision_card_is_in_game_surfaces():
    """The endgame decision card root (#orwell-decision-card) must be a measured surface so the
    overlap/tap sweep covers it — its .odec-* CHILDREN matched before, but not the card root."""
    mod = _load()
    assert "#orwell-decision-card" in mod.GAME_SURFACES


def test_auto_resolve_covers_every_pending_kind():
    """Every PendingDecisionView.kind a season can emit must map to a legal throwaway answer (or
    None for self-evict, which we never volunteer). Mirrors the committed s4ff.mjs harness."""
    mod = _load()
    two = [{"id": "a"}, {"id": "b"}]
    kinds = {
        "nominations": two, "veto-decision": two, "comp-intent": two, "comp-round": two,
        "houseguests-choice": two, "replacement": two, "eviction-vote": two, "tie-break": two,
        "final-eviction": two, "goodbye-message": two, "finale-statement": [],
        "finale-answer": [], "juror-question": [], "juror-vote": two,
    }
    for kind, opts in kinds.items():
        out = mod._auto_resolve({"kind": kind, "options": opts})
        assert out is not None and out.get("kind") == kind, f"no resolution for {kind}"
    # self-evict is deliberately NOT resolved (never walk the player out).
    assert mod._auto_resolve({"kind": "self-evict"}) is None


def test_finish_game_leaves_the_finale_interview_card_unanswered():
    """A pre-jury evictee REALLY holds the finale-interview card beside the retro; a driver that answers it hides a
    phone overlap from the base sweep. finish_game must capture it, never submit an answer for it."""
    import inspect
    src = inspect.getsource(_load().finish_game)
    assert "_auto_resolve(fp)" not in src, "the driver must not answer the live finale card"
    assert "endgame_pending = endgame_pending or fp" in src  # captured for the isolated endgame-card pass


def test_matrix_has_the_card_with_retro_pass_seed_independent():
    """The deterministic co-render pass: retro + the finale-interview card mounted TOGETHER (retro not suppressed), with a
    fixture so it never depends on the staged seed evicting the player pre-jury."""
    py = SCRIPT.read_text(encoding="utf-8")
    assert '"+card-with-retro"' in py and "_FINALE_INTERVIEW_FIXTURE" in py
    assert _load()._FINALE_INTERVIEW_FIXTURE["kind"] == "finale-interview"


def test_retro_yields_to_a_live_decision_card_on_the_narrow_tier():
    css = (SCRIPT.parents[1] / "static" / "js" / "orwellRetrospective.js").read_text(encoding="utf-8")
    assert "body:has(#orwell-decision-card) #orwell-retro:not(.ow-docked) { display: none !important; }" in css
