"""ORW-232 slice 1 (Ryne's playtest: the first HOH felt awkward - transitions in and out not role-played, it sat in its own text boxes, and it was only 2-3 boxes of who was eliminated and who won; prod logs showed
three comp rounds pre-resolved in 0.2 seconds with "wins Head of Household" never voiced): the FE hands the narrator the competition the engine walked, in ENGINE ORDER, as facts to voice as ONE continuous scene
(lead-in, every round as a beat, the winner by name, the walk back inside). The engine decides everything. Roles only."""
import asyncio
import importlib

ch = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


LOG = [
    ("comp-elimination", "Houseguest One, Houseguest Two are out; 5 remain"),
    ("comp-elimination", "Houseguest Three is out; 4 remain"),
    ("comp-elimination", "Houseguest Four, Houseguest Five are out; 2 remain"),
    ("hoh-competition", "Houseguest Six wins Head of Household"),
]


def test_the_steer_carries_every_round_in_engine_order_and_the_winner():
    t = ch._competition_scene_steer(LOG)
    assert t.index("Houseguest One") < t.index("Houseguest Three") < t.index("Houseguest Four"), "rounds must stay in engine order"
    for need in ("1. Houseguest One", "2. Houseguest Three", "3. Houseguest Four"):
        assert need in t
    assert "WINNER: Houseguest Six wins Head of Household" in t, "the winner is always handed over (and must be voiced)"


def test_the_steer_asks_for_one_continuous_scene_not_a_list_or_a_burst():
    low = ch._competition_scene_steer(LOG).lower()
    for need in ("one continuous scene", "lead-in", "every round", "in the order given", "walk back inside", "winner, by name"):
        assert need in low, need
    assert "never merge them into a list" in low and "never skip a round" in low


def test_the_steer_without_a_crown_yet_still_orders_the_rounds_and_names_no_winner():
    t = ch._competition_scene_steer(LOG[:2])
    assert "WINNER:" not in t and "1. Houseguest One" in t and "2. Houseguest Three" in t


FIVE = [("comp-elimination", f"Houseguest R{n} is out; {6 - n} remain") for n in range(1, 6)] + [("hoh-competition", "Houseguest Six wins Head of Household")]


def _segment_rig(monkeypatch, user):
    """A competition of 5 rounds + the crown behind a stubbed engine; each call to the returned `run(msg)` is ONE player message through the pre-resolve."""
    ch.clear_social_runway(user)
    ch._COMP_PAUSED.pop(ch._runway_key(user), None)
    ch._SCHEDULE_STEER.pop(ch._runway_key(user), None)
    seq = list(FIVE)
    base = {"phase": "hoh-competition", "week": 1, "beatSeq": 1}

    async def fake_status(user=None, **kw):
        return {"beatSeq": 1, "pending": None}

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        k, c = seq.pop(0)
        return {"event": {"beat": k, "content": c}, "beatSeq": 2}

    async def fake_state(user=None, **kw):
        return dict(base, phase="nominations" if not seq else "hoh-competition")

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    async def fake_staging(*a, **k):  # the background competition-fiction author reads the staging view; never let it reach a real engine client (it records into the process-wide last_engine_error, which test_orwell_engine_client asserts on)
        return None

    monkeypatch.setattr(orwell_engine, "competition_staging_view", fake_staging)

    def run(msg):
        _run(ch._pre_resolve_npc_ceremony(user, dict(base), retry=False, player_msg=msg))
        return ch._SCHEDULE_STEER.get(ch._runway_key(user)) or ""
    return run, seq


def test_the_competition_pauses_after_every_round_and_the_rest_stays_unrun(monkeypatch):
    # ORW-232 slice 3 (Ryne 2026-11-10: "never one message, always a full play by play"): ONE round per message (was two in slice 2). Re-pinned deliberately.
    run, seq = _segment_rig(monkeypatch, "u232s")
    steer = run("run it, who won?")
    assert "1. Houseguest R1" in steer
    assert "Houseguest R2" not in steer, "the second round has not been run"
    assert "WINNER" not in steer, "no winner is handed over mid-competition"
    assert "PAUSE" in steer and "ENDS here" in steer and "changes nothing about the result" in steer
    assert len(seq) == 5, "only ONE round was walked in the engine; the rest is unrun (rounds are never released together)"
    assert ch._COMP_PAUSED.get(ch._runway_key("u232s")), "the pause is remembered"


def test_any_next_message_continues_the_competition_one_round_at_a_time(monkeypatch):
    run, seq = _segment_rig(monkeypatch, "u232t")
    run("run it")
    steer = run("Hey, I'm rooting for you two!")  # NOT a readiness phrase: any message continues a paused competition
    assert "THE COMPETITION CONTINUES" in steer and "answering what they said" in steer
    assert "1. Houseguest R2" in steer and "R1" not in steer and "R3" not in steer
    assert "PAUSE" in steer and "WINNER" not in steer
    assert len(seq) == 4


def test_the_crown_comes_in_its_own_message_with_the_winner_and_the_walk_back(monkeypatch):
    run, seq = _segment_rig(monkeypatch, "u232u")
    for msg in ("run it", "go team", "wow", "keep going", "last one?"):
        steer = run(msg)
        assert "WINNER" not in steer, "no message before the crown hands over the winner"
    assert len(seq) == 1, "five rounds, five messages; only the crown is left"
    steer = run("and?")
    assert "THE COMPETITION CONTINUES" in steer
    assert "WINNER: Houseguest Six wins Head of Household" in steer, "the winner is ALWAYS handed over at the end"
    assert "PAUSE" not in steer and "walk back inside" in steer
    assert not seq and not ch._COMP_PAUSED.get(ch._runway_key("u232u")), "the competition is finished: no stale pause"


def test_a_competition_never_resolves_in_one_message(monkeypatch):
    """Ryne 2026-11-10: even 'run it' / 'let's go' / a readiness phrase walks ONE round, never the whole competition."""
    for i, msg in enumerate(("run it", "let's go", "I'm ready, start the competition now", "who won?")):
        run, seq = _segment_rig(monkeypatch, f"u232one{i}")
        run(msg)
        assert len(seq) >= 5, f"{msg!r} resolved more than one round"
        assert not any(k == "hoh-competition" for k, _c in FIVE[:1])


# ── the per-round box is compacted (real JS executed in Node, like test_l42) ───────────────────
import json as _json
import os as _os
import shutil as _shutil
import subprocess as _subprocess

import pytest as _pytest

_STATIC = _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))), "static", "js")


def _outcome(tool, output):
    node = _shutil.which("node")
    if not node:
        _pytest.skip("node not available")
    mod = _os.path.join(_STATIC, "orwellToolBeats.js").replace("\\", "/")
    script = (f"import('file://{mod}').then(m => {{ const c = {_json.dumps([[tool, output]])}; "
              f"console.log(JSON.stringify(c.map(([t,o]) => m.orwellBeatOutcome(t,o)))); }});")
    p = _subprocess.run([node, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=30)
    assert p.returncode == 0, p.stderr
    return _json.loads(p.stdout.strip().splitlines()[-1])[0]


def test_a_round_box_is_compacted_to_a_progress_line():
    out = _outcome("advanceGame", {"event": {"beat": "comp-elimination", "content": "Houseguest One, Houseguest Two are out; 5 remain"}})
    assert out == "🧗 The competition: 5 remain"
    assert "Houseguest One" not in out, "who fell is prose now, not a box"


def test_the_crown_keeps_its_full_outcome():
    out = _outcome("advanceGame", {"event": {"beat": "hoh-competition", "content": "Houseguest Six wins Head of Household"}})
    assert "Houseguest Six wins Head of Household" in out


def test_a_paused_turn_holds_the_models_own_advance_and_submit(monkeypatch):
    """Live run 2026-11-10: the pass paused after two rounds, but the narrator called submitDecision in the SAME turn and chain-advanced the rest of the competition and the winner through the pause."""
    import json
    from src import tool_implementations as ti
    run, seq = _segment_rig(monkeypatch, "u232v")
    run("run it")
    assert ch.comp_pause_holds("u232v")
    called = {"n": 0}

    async def boom(*a, **k):
        called["n"] += 1
        return {}

    monkeypatch.setattr(orwell_engine, "advance_game", boom)
    monkeypatch.setattr(orwell_engine, "submit_decision", boom, raising=False)
    out = _run(ti.do_submit_decision(json.dumps({"kind": "comp-round", "intent": "compete"}), owner="u232v"))
    assert json.loads(out["output"])["held"] is True and "PAUSED" in json.loads(out["output"])["note"]
    out2 = _run(ti.do_advance_game("{}", owner="u232v"))
    assert json.loads(out2["output"])["held"] is True
    assert called["n"] == 0, "the engine is not touched while the pause is fresh"


def test_the_hold_lifts_when_the_next_framed_turn_begins(monkeypatch):
    run, seq = _segment_rig(monkeypatch, "u232w")
    run("run it")
    assert ch.comp_pause_holds("u232w")
    run("okay go on")  # the next player message: a fresh pass starts, last turn's hold is gone (and this pass pauses again, setting its own)
    assert len(seq) == 4


def test_a_fresh_pause_also_stops_the_stall_nudge(monkeypatch):
    """Live run 2026-11-10 (second build): with the model's tools held, the FE's OWN stall-nudge ('committed advanceGame silently, stall L0') finished the competition inside the paused turn. The agent loop's nudges
    read production_is_holding(); a fresh competition pause now counts as one."""
    run, seq = _segment_rig(monkeypatch, "u232x")
    assert not ch.production_is_holding("u232x")
    run("run it")
    assert ch.production_is_holding("u232x"), "the nudges must treat a fresh pause as a hold"
    for msg in ("go on", "and on", "more", "still", "and the winner?"):  # each framed turn clears the old pause and, pausing again, sets a new one; five rounds, then the crown: after it nothing holds
        run(msg)
    assert not ch.production_is_holding("u232x"), "the competition finished: no stale hold"


def test_every_fe_silent_advance_belt_respects_a_fresh_pause():
    """Live run 3 (2026-11-10): after the model's tools were held, the 'decision-deliver' belt (the model called submitDecision, so the FE 'delivered' it) committed advanceGame silently and finished the competition through the pause.
    All silent-advance belts (stall / decision-deliver / preview-commit) share _commit_advance_silently, which now stands down while a pause is fresh (source pin: it is the ONLY place the FE issues those advances)."""
    import pathlib
    src = pathlib.Path(__file__).resolve().parents[1].joinpath("src", "agent_loop.py").read_text()
    i = src.index("async def _commit_advance_silently")
    head = src[i:i + 2600]
    assert "comp_pause_holds(owner)" in head and "return True" in head[head.index("comp_pause_holds(owner)"):head.index("comp_pause_holds(owner)") + 300]
    assert src.count("async def _commit_advance_silently") == 1


def test_the_final_segment_asks_for_everything_including_the_winner_in_one_reply():
    """Live run 4: the last segment's rounds and the winner were spread over two replies (the winner landed late). The unpaused steer now asks for short rounds and the winner in THIS reply."""
    t = ch._competition_scene_steer(LOG)
    assert "lands in THIS reply" in t and "do not carry any round or the winner over" in t
    assert "lands in THIS reply" not in ch._competition_scene_steer(LOG[:2], paused=True), "a paused segment ends mid-competition on purpose"
