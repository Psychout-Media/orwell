"""FE agent-loop fixes from the 2026-06-26 BB-nerd-auditor synthesis (Lane A).

Three disjoint, in-loop error-correction belts — each surfaces / steers an engine-authored beat the
model skipped, and NEVER authors content:

* F2 (#1017) — empty-response dead-end. A TRUE-empty live-game turn surfaced only a bare operator
  string ("switch to a different model") with no in-game recourse. The fix surfaces an in-character
  producer line AND a `truncated`-type retry affordance (the existing `Continue ▸` pattern). The
  FEPY-2 reasoning-recovery branch (load-bearing for Flash) stays unchanged, and the non-game
  workspace path still emits the verbatim operator string.

* F8 (#1015) — nomination ceremony never narrated (NPC HOH self-advances the phase, so the moment
  fragment never surfaces and "nominations" wasn't in the steered set). The fix GENERALIZES the
  `_eviction_reveal_steer` into a ceremony-narration belt that steers the model to voice a
  just-resolved `nominations` / `veto-ceremony` beat — the engine already authored the content; the
  belt corrects the omission and never invents noms.

* #1033 (F-4 / F-2) — casting-seam stall guardrail. The L39-family forced finalize already escapes a
  stuck casting cold-start; #1033 adds surfacing the engine's new `createRefusedReason` on a refused
  createCharacter so the loop has a diagnosis instead of silently re-looping.

Every automated gate stubs the LLM, so the steers' live narration quality is live-verified (per the
audit). These pin the pure helpers (fail-before/pass-after) + the source wiring.
"""
import importlib
import json
from pathlib import Path

agent_loop = importlib.import_module("src.agent_loop")

FE = Path(__file__).resolve().parents[1]
AGENT_SRC = (FE / "src" / "agent_loop.py").read_text(encoding="utf-8")


def _frame(chunk: str):
    """Parse the single `data: {...}` SSE frame out of a chunk string."""
    assert chunk.startswith("data: ")
    return json.loads(chunk[len("data: "):].strip())


# ── F2 (#1017): the empty-response dead-end now has in-game recourse ─────────── #

def test_true_empty_live_game_turn_emits_producer_line_and_retry_affordance():
    """A live-game turn with no body, no reasoning, no tools surfaces an in-character producer line
    (NOT the operator 'switch models' string) AND a retry affordance the player can tap. The body and
    the retry are SEPARATE frames (the callsite yields the retry) so each chunk stays parseable."""
    final, chunk, retry, _fr = agent_loop._empty_response_fallback("", "", [], game_mode=True)
    # In-character recovery — NOT the bare operator dead-end.
    assert final == agent_loop._EMPTY_PRODUCER_LINE
    assert "send your move again" in final.lower()
    assert "switch to a different model" not in final.lower()
    assert chunk is not None
    body = _frame(chunk)
    assert body["delta"] == agent_loop._EMPTY_PRODUCER_LINE
    assert not body.get("thinking")  # body channel, never the reasoning accordion
    assert retry is True, "the true-empty live-game case must signal a one-tap retry affordance"


def test_true_empty_casting_turn_also_gets_in_game_recourse():
    """Casting (a framed pre-game turn) is also game_mode-truthy — it must not dead-end either."""
    final, chunk, retry, _fr = agent_loop._empty_response_fallback("", "", [], game_mode="casting")
    assert final == agent_loop._EMPTY_PRODUCER_LINE
    assert retry is True


def test_true_empty_non_game_turn_keeps_the_operator_string():
    """A workspace (non-game) turn keeps the verbatim operator guidance for a power user — they CAN
    switch models. No game_mode ⇒ the old behaviour, byte-for-byte (and no retry chip)."""
    final, chunk, retry, _fr = agent_loop._empty_response_fallback("", "", [])
    assert "empty response" in final
    assert "switch to a different model" in final.lower()
    assert _frame(chunk).get("delta") == final
    assert retry is False


def test_fepy2_reasoning_recovery_unchanged_even_in_game_mode():
    """The FEPY-2 branch (answer routed entirely to the reasoning channel) is load-bearing for Flash
    and must be untouched: an empty body WITH reasoning re-emits the reasoning as a body delta,
    regardless of game_mode — never the producer line, never a retry affordance."""
    final, chunk, retry, _fr = agent_loop._empty_response_fallback(
        # DeepSeek/Flash named explicitly: P2-16 flipped the UNKNOWN-model default to the safe
        # False (no re-emit), so the load-bearing FEPY-2 shape is asserted on its known family.
        "", "Here is the real answer.", [], game_mode=True, model="deepseek/deepseek-v4-flash")
    assert final == "Here is the real answer."
    assert _frame(chunk)["delta"] == "Here is the real answer."
    assert retry is False
    assert agent_loop._EMPTY_PRODUCER_LINE not in final


def test_nonempty_body_unchanged_in_game_mode():
    final, chunk, retry, _fr = agent_loop._empty_response_fallback("real body", "reasoning", [],
                                                                   game_mode=True)
    assert final == "real body" and chunk is None and retry is False


def test_empty_fallback_callsite_passes_game_mode_and_yields_retry():
    idx = AGENT_SRC.find("_fallback_retry, _from_reasoning = _empty_response_fallback(")
    assert idx != -1, "the callsite must unpack the retry + from_reasoning flags"
    window = AGENT_SRC[idx:idx + 2000]
    assert "game_mode=game_mode" in window, "the empty-response fallback must be game-aware"
    assert "model=actual_model" in window, "the empty-response fallback must be model-aware (A4)"
    # the retry affordance is yielded as its OWN frame (a separate `truncated` chip)
    assert "if _fallback_retry:" in window
    assert '"type": "truncated"' in window


# ── F8 (#1015): the ceremony-narration belt ─────────────────────────────────── #

def test_ceremony_steer_voices_nominations_without_inventing_noms():
    steer = agent_loop._ceremony_narration_steer("nominations", "HOH nominates A and B for eviction.")
    low = steer.lower()
    assert "nomination ceremony" in low
    # it hands back the ENGINE's own content (the nominees) and forbids invention
    assert "HOH nominates A and B for eviction." in steer
    assert "never invent" in low
    # voice it NOW, before any other scene — the eviction-reveal belt's discipline
    assert "before" in low and ("other scene" in low or "advance again" in low)


def test_ceremony_steer_recognises_the_veto_ceremony():
    steer = agent_loop._ceremony_narration_steer("veto-ceremony", "Veto holder saves A; C goes up.")
    assert "veto ceremony" in steer.lower()
    assert "Veto holder saves A; C goes up." in steer


def test_ceremony_steer_safe_with_empty_content():
    """No engine content (an older beat shape) ⇒ still a valid note, just no quoted line — never crashes
    and never fabricates a ceremony."""
    steer = agent_loop._ceremony_narration_steer("nominations", "")
    assert "nomination ceremony" in steer.lower()
    assert "you must voice" not in steer.lower()  # nothing to quote, so no quote clause


def test_nomination_beat_is_in_the_steered_set():
    """The root cause of #1015: 'nominations' was absent from the steered set. It (and the veto
    ceremony) must now be covered."""
    assert "nominations" in agent_loop._CEREMONY_NARRATE_BEATS
    assert "veto-ceremony" in agent_loop._CEREMONY_NARRATE_BEATS


def test_ceremony_belt_is_wired_at_the_advance_tool_result_site():
    """The belt fires on an advanceGame tool result whose returned beat is a ceremony beat — the same
    site as the eviction-reveal steer, so an NPC-HOH ceremony the model breezed past gets steered."""
    assert "_CEREMONY_NARRATE_BEATS" in AGENT_SRC
    assert "_ceremony_narration_steer(_ev_beat, _ev_content)" in AGENT_SRC
    # it must be guarded so it does not collide with the eviction-stage steer (elif, not a second if)
    idx = AGENT_SRC.find("_ev_beat in _EVICTION_STAGE_BEATS")
    window = AGENT_SRC[idx:idx + 500]
    assert "elif _ev_beat in _CEREMONY_NARRATE_BEATS" in window


# ── #1033 (F-4 / F-2): the casting-seam stall guardrail surfaces the reason ──── #

def test_casting_incomplete_steer_surfaces_the_engine_refused_reason():
    """#1033: when the engine refuses createCharacter it now hands back a plain-language reason; the
    steer must surface it so a stuck cold-start loop has a diagnosis (not a silent re-loop)."""
    reason = "the interview still needs the player's backstory and why they came to play"
    steer = agent_loop._casting_incomplete_steer(["backstory", "motivation"], reason)
    assert reason in steer
    # and it still names the concrete field gaps + steers to ask/file, never fabricate
    low = steer.lower()
    assert "backstory" in low and "updatecasting" in low
    assert "do not call createcharacter" in low


def test_casting_incomplete_steer_backcompat_without_a_reason():
    """An older engine (or a refusal with no reason string) ⇒ the steer still works exactly as before
    — the reason clause is simply absent."""
    steer = agent_loop._casting_incomplete_steer(["archetype"])
    assert "the game's reason:" not in steer.lower()
    assert "archetype" in steer.lower()


def test_forced_create_refusal_passes_the_reason_into_the_steer():
    """The forced-finalize fallback reads `createRefusedReason` off the engine view and threads it
    into the steer — so the casting-seam escape surfaces WHY it refused."""
    assert 'str(_eng.get("createRefusedReason") or "")' in AGENT_SRC
    assert "_casting_incomplete_steer(" in AGENT_SRC and "_refused_reason)" in AGENT_SRC


def test_casting_force_finalize_stall_escape_still_present():
    """#1033 (F-4): the casting cold-start MUST have a forced-finalize escape analogous to L39b — a
    stuck loop where createCharacter never fires force-progresses (or surfaces a diagnostic)."""
    assert "_CASTING_FORCE_LEVEL" in AGENT_SRC
    assert "FORCED createCharacter" in AGENT_SRC
