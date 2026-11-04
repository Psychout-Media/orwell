"""Engine progression error-correction — the agent-loop stall-nudge.

The GM reliably narrates a beat (a competition, a ceremony, the premiere move-in) WITHOUT
ever calling advanceGame, freezing the season (the #1 playthrough blocker, robust even on
strong models). Per the owner's ruling we keep the dynamic DM and ERROR-CORRECT the omission:
when the live game sits in a phase that exists to be driven forward and the turn fired no
progression tool, nudge the model in-loop — non-disruptive first, escalating, capped, tunable.

Source-pins (the behavior runs against the real engine in the play-through harness).
"""
import os

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


def test_stall_nudge_config_present():
    js = _read("src", "agent_loop.py")
    assert "_ADVANCE_PHASES" in js
    # the phases that must be driven forward are covered
    for phase in ("premiere", "hoh-competition", "nominations", "veto-competition",
                  "veto-ceremony", "eviction", "jury-finale"):
        assert f'"{phase}"' in js, phase
    assert "_PROGRESSION_TOOLS" in js
    assert '"advanceGame"' in js and '"submitDecision"' in js
    # three graduated rungs: gentle → firmer → forceful
    assert "_ADVANCE_NUDGES = [" in js
    assert js.count("# 1 — gentle") == 1
    assert "STOP. The game is FROZEN" in js              # the forceful rung
    assert "_MAX_ADVANCE_NUDGES_PER_TURN" in js          # in-loop cap
    assert "_ADVANCE_STALL_LEVEL" in js                  # persisted cross-turn escalation


def test_stall_nudge_fires_only_for_live_game_at_a_beat_with_no_progress():
    js = _read("src", "agent_loop.py")
    # gated on a live season, an advance-phase, and NO progression tool this turn
    assert "_is_live_game = game_mode in (True, \"game\")" in js
    assert "_phase in _ADVANCE_PHASES" in js
    assert "_tool_names & _PROGRESSION_TOOLS" in js
    # the per-turn cap guards the loop; the persisted level sets message forcefulness
    assert "_turn_advance_nudges < _MAX_ADVANCE_NUDGES_PER_TURN" in js
    # NAR-1: the level is read/written under the SAME owner-keying resolver (`_belt_key`) so the
    # ladder actually persists single-tenant (`AUTH_ENABLED=false`) — see test_nar1_belt_key.py.
    assert "_ADVANCE_STALL_LEVEL.get(_sl_key, 0)" in js
    # nudging continues the loop (gives the model another step), it does not auto-advance
    assert "_ADVANCE_NUDGES[min(_level" in js
    assert '"content": _nudge' in js


def test_stall_escalation_resets_when_the_game_advances():
    js = _read("src", "agent_loop.py")
    # a fired progression tool clears the persisted escalation for that game. NAR-1: no longer
    # gated on `and owner` (that gate meant the reset never fired single-tenant, so a resolved
    # single-tenant stall left stale escalation for the NEXT lull check) — see test_nar1_belt_key.py.
    assert "if _is_live_game and block.tool_type in _PROGRESSION_TOOLS:" in js
    assert "_ADVANCE_STALL_LEVEL.pop(_belt_key(owner), None)" in js


def test_nudge_only_seizes_a_lull_not_substantive_play():
    # Pacing is engagement, not a turn count (owner ruling): substantive social play runs
    # indefinitely; we only nudge progression on a LULL that the model failed to seize. Pacing
    # rework 2026-07: a lull is now an EXPLICIT readiness signal (or an empty message) ONLY — the
    # old `_LULL_SHORT_CHARS` char-count heuristic is GONE (a short reply is not a lull), because it
    # mis-read ordinary brief social replies as "ready to advance" and drove the fast-forward feel.
    js = _read("src", "agent_loop.py")
    assert "_player_turn_is_lull" in js
    assert "_LULL_READY_RE" in js
    assert "_LULL_SHORT_CHARS" not in js  # the char-count lull heuristic was removed
    # the advance-nudge fires on a lull, OR a previewed-but-uncommitted outcome (#1), OR an
    # undelivered decision result (1b) — the latter two bypass the lull gate.
    assert "_want_advance = (_turn_advance_nudges < _MAX_ADVANCE_NUDGES_PER_TURN and (" in js
    assert "(not _progressed) and _is_lull and _stale" in js
    assert "if _want_advance and _phase in _ADVANCE_PHASES" in js
    # …and only once the beat has gone STALE (owner ruling 2026-06-18): a lull alone is not enough,
    # so good engaging play and a just-started beat are never shoved.
    assert "_ADVANCE_GRACE_TURNS" in js
    assert "_TURNS_SINCE_PROGRESS" in js
    assert "and _stale" in js


def test_previewed_but_uncommitted_ceremony_is_a_hard_stall(self_check=None):
    # Hand-off #1 (HIGH): previewing a ceremony OUTCOME (runCompetition) in an advance-phase and not
    # committing it (advanceGame) is a hard stall — it bypasses the lull/staleness gate and gets the
    # forceful commit nudge immediately, because the board now contradicts the narration.
    js = _read("src", "agent_loop.py")
    assert '_PREVIEW_TOOLS = {"runCompetition"}' in js
    assert "_PREVIEW_COMMIT_NUDGE" in js
    # ORDER-based, not `not _progressed`: last beat-tool == runCompetition ⇒ uncommitted preview.
    # (A turn that advances the roll AND then previews the next comp still left it uncommitted.)
    assert '_previewed_uncommitted = bool(_beat_seq) and _beat_seq[-1] == "runCompetition"' in js
    # the forceful nudge is chosen for the previewed case (not the gentle graduated one)
    assert "_nudge, _why = _PREVIEW_COMMIT_NUDGE" in js


def test_undelivered_decision_result_is_a_hard_stall():
    # Hand-off 1b: resolving a decision (submitDecision) but never advanceGame'ing AFTER it leaves the
    # result undelivered — the model narrated an invented/cross-week outcome ("you are the new HOH"
    # with the engine at last week's eviction). The ORDER of progression tools decides it, and it gets
    # the forceful deliver nudge regardless of lull (it fires even though the turn "progressed").
    js = _read("src", "agent_loop.py")
    assert "_DECISION_DELIVER_NUDGE" in js
    assert "_BEAT_TOOLS = _PROGRESSION_TOOLS | _PREVIEW_TOOLS" in js
    assert '_decision_undelivered = bool(_beat_seq) and _beat_seq[-1] == "submitDecision"' in js
    assert "elif _decision_undelivered:" in js


def test_l39b_safety_net_forces_an_advance_past_the_last_rung():
    # L39(b): a model that ignores every escalating TEXT nudge across turns leaves the season frozen
    # ("not a single beat advanced"). Past the last rung the FE pulls the engine lever ITSELF — the
    # same advanceGame the model was asked to call, one beat, deterministically resolved — then has
    # the model re-read and voice the REAL returned beat. NOT engine-authored content (the model still
    # narrates); the same "error-correct the omission" guardrail as _auto_record_scene, for progression.
    js = _read("src", "agent_loop.py")
    assert "_ADVANCE_FORCE_LEVEL" in js
    assert "_FORCED_ADVANCE_NUDGE" in js
    # fires only once the persisted level passes every text rung, and only for a PLAIN stall (a
    # previewed/undelivered outcome still gets its targeted text nudge — the model is one call away)
    assert "_level >= _ADVANCE_FORCE_LEVEL" in js
    assert "and not _previewed_uncommitted and not _decision_undelivered" in js
    # it pulls the engine lever directly (via the shared silent-commit helper) and resets the clock.
    # 0065 Part A/B: the FE-issued advance now threads the optional CAS token + idempotency key.
    assert "_oe3.advance_game(" in js
    assert "expected_beat_seq=_ch3.last_beat_seq(owner)" in js
    assert "FORCED advanceGame" in js
    # fail-open: a forced advance that errors falls through to the text nudge, never crashes the turn
    assert "silent advanceGame failed" in js


def test_l39b_force_level_is_past_the_last_text_rung():
    # The force threshold must sit strictly ABOVE the graduated text rungs, so the model always gets
    # the full escalation (gentle → firmer → forceful) BEFORE the FE ever pulls the lever for it.
    import importlib
    al = importlib.import_module("src.agent_loop")
    assert al._ADVANCE_FORCE_LEVEL == len(al._ADVANCE_NUDGES)
    assert al._ADVANCE_FORCE_LEVEL >= 3  # three graduated rungs come first


def test_consequence_loop_auto_records_engaged_scenes():
    # Feature 0055: substantive social play MUST fold into the hidden weights. The model under-calls
    # recordInteraction even when nudged, so when an ENGAGED turn touched a houseguest and recorded
    # nothing, the FE GUARANTEES the fold itself via a constrained extraction + recordInteraction.
    js = _read("src", "agent_loop.py")
    assert "_RECORD_TOOLS" in js
    for tool in ('"recordInteraction"', '"makeDeal"', '"surfaceInformationTo"'):
        assert tool in js, tool
    assert "_scene_touched_houseguest" in js
    assert "async def _auto_record_scene" in js
    # the auto-record proposes a model kind + validates ids, then records via the engine — 0065
    # routes it through the CAS helper so the back-fill carries the compare-and-swap beatSeq token.
    assert "_RECORD_KINDS" in js
    assert "_backfill_with_cas(owner, _oe.record_interaction, content[:400]" in js
    assert "_oe.record_interaction" in js
    # gated on engagement (not a lull, OR a lull message that still carries a real talk - Ryne 2026-11-04 "the talk still counts") + a houseguest scene + nothing recorded;
    # deliberately NOT gated on `_progressed` any more (a talk plus a model advance in one turn is still banked - test_bank_scene_on_progressed_turn.py)
    assert "(not _recorded) and ((not _is_lull) or _lull_message_carries_talk(messages))" in js
    assert "(not _progressed)\n                                and _turn_record_nudges" not in js
    assert "_scene_touched_houseguest(" in js
    assert "_want_record and _touched" in js
    assert "await _auto_record_scene(" in js
    # model-driven recording takes precedence (a fired record tool suppresses the auto path)
    assert "block.tool_type in _RECORD_TOOLS" in js


def test_scene_touched_houseguest_detection():
    import importlib
    al = importlib.import_module("src.agent_loop")
    house = ["Trevor Leach", "Dawn Reynolds", "Ada Sharma"]
    mk = lambda txt: [{"role": "user", "content": txt}]
    # narration names a houseguest → a scene happened
    assert al._scene_touched_houseguest("I pull Trevor aside and make my pitch.", mk("hi"), house)
    # the player's own line names one (first name) → scene
    assert al._scene_touched_houseguest("", mk("Let me find Dawn and work her for the veto."), house)
    # nobody named → not a houseguest scene
    assert not al._scene_touched_houseguest("I sit alone in the backyard and think.", mk("just thinking"), house)
    # no roster → never a false positive
    assert not al._scene_touched_houseguest("I talk to Trevor.", mk("hi"), [])


def test_lull_detection_engagement_vs_lull():
    # Behavioral: load the helper and check it reads engagement, not length-as-count.
    import importlib
    al = importlib.import_module("src.agent_loop")
    mk = lambda txt: [{"role": "user", "content": txt}]
    # lulls = an EXPLICIT readiness cue, or an empty turn (the char-count heuristic is gone)
    assert al._player_turn_is_lull(mk("let's go"))
    assert al._player_turn_is_lull(mk("what's next?"))
    assert al._player_turn_is_lull(mk("alright, I'm ready — bring it on"))
    assert al._player_turn_is_lull(mk(""))
    # a SHORT but non-ready reply is NO LONGER a lull (pacing rework 2026-07 — no length-as-count),
    # so an ordinary brief social reply keeps the scene going instead of marching the game forward
    assert not al._player_turn_is_lull(mk("ok"))
    assert not al._player_turn_is_lull(mk("yeah, sounds good"))
    # substantive social play is NOT a lull
    rich = ("I find Dawn away from the noise and make my case quietly: she barely knows me, "
            "Ava put me up as a number not a threat, and using the veto on me costs her nothing "
            "but buys someone who remembers it. I want to read how she takes that before I push.")
    assert not al._player_turn_is_lull(mk(rich))
