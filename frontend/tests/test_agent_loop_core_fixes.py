"""Core game-loop fixes (claude/agent-loop-core).

Three high-impact agent/game-loop bugs, diagnosed from a real engine log:

  Bug 1 — the input context budget was catastrophically small. A persisted-but-DEFAULT
          `agent_input_token_budget` (6000) was mistaken for an explicit user override and
          clamped a 128K-context model back to 6000, so a 9K–18K conversation got trimmed to a
          few hundred tokens every turn — the model never saw the conversation, so NPC
          names/cities re-improvised turn to turn. The effective budget must now derive from the
          MODEL'S real window, not the 6000 sentinel, while still trimming small models sanely.

  Bug 2 — the progression stall-nudge caused DOUBLE narration ("rewind"): a nudge re-prompted
          the model AFTER it had already narrated a scene, appending a SECOND scene to the same
          message. A turn must yield ONE narration; a forced/silent advance progresses STATE
          without re-narrating once a scene has been shown.

  Bug 3 — the auto-record extraction (feature 0055) returned empty/unparseable on reasoning
          models (`auto-record: no parseable JSON (len=0)`), so social play moved no weights. The
          non-streaming LLM read only `content`/`reasoning_content`, missing the `reasoning` /
          `thinking` fields some providers use, and the extraction's token cap was too small for a
          reasoning preamble. Fixed so an engaged scene reliably records.
"""
import asyncio
import importlib
import os

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


# ───────────────────────── Bug 1: context budget from the model window ─────────────────────────

def test_budget_scales_to_model_window_not_the_6000_default():
    """A 128K model gets a LARGE budget — never pinned at the 6000 default. It lands at the
    cost-bounded cap (0.6 * 128K capped to the hard max), an order of magnitude above 6000."""
    from src.context_budget import compute_input_token_budget, DEFAULT_BUDGET, DEFAULT_HARD_MAX
    # No explicit override at all.
    eff = compute_input_token_budget(DEFAULT_BUDGET, 128000, explicit=False)
    assert eff >= 5 * DEFAULT_BUDGET, f"expected the budget to scale to the 128K window, got {eff}"
    assert eff == DEFAULT_HARD_MAX, "a 128K window lands at the cost-bounded cap"


def test_persisted_default_is_not_treated_as_an_explicit_override():
    """THE ROOT CAUSE: the settings file routinely persists the whole default set, so
    `agent_input_token_budget` is PRESENT at its default 6000 and `is_setting_overridden`
    reports True. A configured value EQUAL to the default must NOT clamp a long-context model
    back to 6000 — it scales to the window exactly like the unset case."""
    from src.context_budget import compute_input_token_budget, DEFAULT_BUDGET
    eff = compute_input_token_budget(DEFAULT_BUDGET, 128000, explicit=True)  # explicit, but == default
    assert eff != DEFAULT_BUDGET, "a persisted-but-default value must not cap the window at 6000"
    assert eff >= 5 * DEFAULT_BUDGET
    # Identical to the unset case — the persisted default is not a real override.
    assert eff == compute_input_token_budget(DEFAULT_BUDGET, 128000, explicit=False)


def test_a_genuine_user_override_off_the_default_is_still_honoured():
    """A value the user actually MOVED off the default is honoured (clamped to the window)."""
    from src.context_budget import compute_input_token_budget
    assert compute_input_token_budget(20000, 128000, explicit=True) == 20000
    # …but never more than the model can hold.
    assert compute_input_token_budget(500000, 128000, explicit=True) == 128000


def test_long_convo_is_not_trimmed_to_a_few_hundred_tokens_on_a_128k_model():
    """End-to-end of the bug: a ~9K-token conversation on a 128K model must survive — the trim
    that flattened 9224 → 661 tokens every turn is gone."""
    from src.context_budget import compute_input_token_budget, DEFAULT_BUDGET
    from src.context_compactor import trim_for_context
    from src.model_context import estimate_tokens

    # Build a long narrative conversation (~9K+ tokens).
    msgs = [{"role": "system", "content": "You are the game master."}]
    for i in range(60):
        msgs.append({"role": "user", "content": "I pull a houseguest aside. " * 30})
        msgs.append({"role": "assistant", "content": "The houseguest leans in and answers. " * 30})
    before = estimate_tokens(msgs)
    assert before > 8000, f"fixture should be a long convo, got {before}"

    budget = compute_input_token_budget(DEFAULT_BUDGET, 128000, explicit=True)  # persisted-default case
    trimmed = trim_for_context(msgs, budget, reserve_tokens=1024)
    after = estimate_tokens(trimmed)
    # The whole conversation fits — NOT crushed to a few hundred tokens.
    assert after == before, "a 9K convo must not be trimmed on a 128K-window model"
    assert after > 5000


def test_small_local_model_still_trims_sanely():
    """Don't regress small-context models: an 8K model's budget is sized from ITS window, so a
    long convo still gets trimmed (just not to 600 tokens, and never above what 8K can hold)."""
    from src.context_budget import compute_input_token_budget, DEFAULT_BUDGET
    eff = compute_input_token_budget(DEFAULT_BUDGET, 8192, explicit=False)
    assert eff <= 8192, "never budget more than the model window"
    assert eff >= 4000, "an 8K model should still get a usable fraction of its window"


def test_unknown_window_falls_back_to_configured():
    """When the model window is unknown (0), keep the previous behaviour: use the configured value."""
    from src.context_budget import compute_input_token_budget, DEFAULT_BUDGET
    assert compute_input_token_budget(DEFAULT_BUDGET, 0, explicit=False) == DEFAULT_BUDGET
    assert compute_input_token_budget(12345, 0, explicit=True) == 12345


def test_default_hard_max_is_cost_bounded():
    """The auto-derived ceiling is bounded so a mid-size window can't blow the bill —
    but still far above the old 6000 cap. (ORW-219: a >=500K window now lifts the cap to
    0.60 x window; see tests/test_orw219_narrator_context.py.)"""
    from src.context_budget import DEFAULT_HARD_MAX, compute_input_token_budget
    assert 32000 <= DEFAULT_HARD_MAX <= 64000
    # A 400K-window model (below the long-window threshold) is still held to the cap.
    assert compute_input_token_budget(6000, 400_000, explicit=False) == DEFAULT_HARD_MAX


# ───────────────────────── Bug 2: one narration per turn (no rewind) ─────────────────────────

def test_one_narration_invariant_blocks_a_second_scene_after_a_visible_one():
    """Source-pin: once the model has shown a visible scene this turn (`_emitted_visible`), the
    advance path commits STATE silently and ENDS the turn — it never re-prompts for a second
    narration (the 'rewind'/double-scene bug)."""
    js = _read("src", "agent_loop.py")
    # the silent-commit helper exists and is used inside the advance block
    assert "_commit_advance_silently" in js
    # the gate: a visible scene already shown ⇒ commit silently then break (no re-prompt)
    assert "if _emitted_visible:" in js
    assert "await _commit_advance_silently(" in js
    # the silent commit progresses the engine WITHOUT a model re-prompt and resets the clock.
    # 0065 Part A/B: the FE-issued advance now threads the optional CAS token + idempotency key.
    assert "_oe3.advance_game(" in js
    assert "expected_beat_seq=_ch3.last_beat_seq(owner)" in js
    # NAR-1: keyed via `_belt_key` (was raw `owner`, gated `if owner:` — inert single-tenant).
    assert "_TURNS_SINCE_PROGRESS[_belt_key(owner)] = 0" in js
    # it ends the turn instead of continuing the loop (which is what re-narrated)
    assert "break  # one scene shown, state committed — done this turn" in js


def test_advance_nudge_is_still_capped_to_once_per_turn():
    """The per-turn advance cap is unchanged — at most one advance nudge fires per invocation."""
    import src.agent_loop as al
    importlib.reload(al)
    assert al._MAX_ADVANCE_NUDGES_PER_TURN == 1
    js = _read("src", "agent_loop.py")
    gates = _read("src", "agent_gates.py")
    # The cap now lives in the pure gates (want_advance / want_drain_eviction, ORW-228); the loop feeds both the per-turn counter.
    assert js.count("max_advance_nudges=_MAX_ADVANCE_NUDGES_PER_TURN") >= 2
    assert "turn_advance_nudges < max_advance_nudges" in gates


def test_silent_commit_does_not_append_the_forced_advance_narration_nudge():
    """When a scene was already shown, the FORCED-ADVANCE re-prompt must not read as "narrate the
    beat again" (the stuttering-narrator bug). The contract evolved with the reinject de-dup fix:
    the nudge is still appended, but under `_emitted_visible` it is prefixed with the
    `_CONTINUE_NEVER_REOPEN` directive so the model continues the shown scene instead of
    re-opening it."""
    js = _read("src", "agent_loop.py")
    nudge_assign = js.index("_fa_txt = _FORCED_ADVANCE_NUDGE")
    tail = js[nudge_assign:nudge_assign + 700]
    assert "if _emitted_visible:" in tail, (
        "the forced-advance nudge must carry a visible-scene guard")
    assert '_fa_txt = _CONTINUE_NEVER_REOPEN + "\\n\\n" + _fa_txt' in tail, (
        "a visible scene must wrap the forced re-prompt in the continue-never-reopen directive")
    assert 'messages.append({"role": "system", "content": _fa_txt})' in tail, (
        "the (possibly wrapped) nudge must still be appended")


# ───────────────────────── Bug 3: auto-record reliably records ─────────────────────────

def test_llm_call_reads_every_reasoning_field_variant():
    """The non-streaming parse must read `reasoning` / `thinking`, not only
    `content`/`reasoning_content` — else a reasoning model's JSON answer (delivered in the
    `reasoning` field by some providers) reads as empty, breaking auto-record (`len=0`)."""
    from src.llm_core import _openai_message_text
    assert _openai_message_text({"content": "hi"}) == "hi"
    assert _openai_message_text({"content": "", "reasoning_content": "rc"}) == "rc"
    assert _openai_message_text({"content": None, "reasoning": "via-reasoning"}) == "via-reasoning"
    assert _openai_message_text({"content": "", "thinking": "via-thinking"}) == "via-thinking"
    assert _openai_message_text({}) == ""


def test_auto_record_produces_a_recordInteraction_on_an_engaged_scene():
    """Feature 0055 guarantee: when the model narrated a player↔houseguest scene but recorded
    nothing, the FE extraction must call recordInteraction. Mock the extraction LLM and the engine
    so the test is deterministic and offline."""
    import src.agent_loop as al
    importlib.reload(al)

    house = [{"id": "npc:1", "name": "Trevor Leach"}, {"id": "npc:2", "name": "Dawn Reynolds"}]
    recorded = {}

    async def _fake_llm(**kwargs):
        # A reasoning model: a THINKING preamble, then the JSON answer last.
        return (
            "Let me reason about who the player engaged... they pitched Trevor.\n"
            '{"withIds":["npc:1"],"kind":"strategy",'
            '"content":"The player pitched a final-two to Trevor."}'
        )

    async def _fake_record(content, with_ids=None, kind=None, consequence=None, user=None, **kw):
        recorded.update({"content": content, "with_ids": with_ids, "kind": kind, "user": user})
        return {"ok": True}

    import src.llm_core as lc
    import src.orwell_engine as oe
    orig_llm, orig_rec = lc.llm_call_async, oe.record_interaction
    lc.llm_call_async = _fake_llm
    oe.record_interaction = _fake_record
    try:
        ok = asyncio.get_event_loop().run_until_complete(
            al._auto_record_scene(
                narration="I pull Trevor aside and pitch a final two; he seems into it.",
                last_user="Let me work Trevor for a final two.",
                house=house,
                endpoint_url="http://x", model="deepseek/deepseek-v4-pro",
                headers={}, owner="u1",
            )
        )
    finally:
        lc.llm_call_async = orig_llm
        oe.record_interaction = orig_rec

    assert ok is True
    assert recorded.get("with_ids") == ["npc:1"]
    assert recorded.get("kind") == "strategy"
    assert recorded.get("user") == "u1"
    assert "Trevor" in (recorded.get("content") or "")


def test_auto_record_is_robust_when_answer_is_in_the_reasoning_field():
    """Even when the provider routes the WHOLE answer into the `reasoning` field (content empty),
    the auto-record still records — because llm_call_async now reads it. Here we simulate that by
    having the mocked llm return the JSON as if it had come back via the reasoning channel."""
    import src.agent_loop as al
    importlib.reload(al)

    house = [{"id": "npc:2", "name": "Dawn Reynolds"}]
    recorded = {}

    async def _fake_llm(**kwargs):
        # Simulates _openai_message_text already having pulled the answer out of `reasoning`.
        return '{"withIds":["npc:2"],"kind":"bonding","content":"They bonded over the comp loss."}'

    async def _fake_record(content, with_ids=None, kind=None, consequence=None, user=None, **kw):
        recorded.update({"with_ids": with_ids, "kind": kind})
        return {"ok": True}

    import src.llm_core as lc
    import src.orwell_engine as oe
    orig_llm, orig_rec = lc.llm_call_async, oe.record_interaction
    lc.llm_call_async = _fake_llm
    oe.record_interaction = _fake_record
    try:
        ok = asyncio.get_event_loop().run_until_complete(
            al._auto_record_scene(
                narration="Dawn and I sit with the loss and talk it through.",
                last_user="Go comfort Dawn.", house=house,
                endpoint_url="http://x", model="m", headers={}, owner="u2",
            )
        )
    finally:
        lc.llm_call_async = orig_llm
        oe.record_interaction = orig_rec

    assert ok is True
    assert recorded.get("with_ids") == ["npc:2"]
    assert recorded.get("kind") == "bonding"


def test_auto_record_extraction_has_room_for_a_reasoning_preamble():
    """Source-pin: the extraction token cap is large enough for a reasoning model to think AND emit
    the (tiny) JSON — the 700-cap that got truncated mid-reasoning is gone."""
    js = _read("src", "agent_loop.py")
    # the _auto_record_scene extraction now uses a generous cap
    assert "max_tokens=1500" in js
    # and it no longer uses the too-small 700 cap there
    assert "temperature=0.2, max_tokens=700" not in js
