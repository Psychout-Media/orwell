"""#1154 / ADR 0016 §D — FORCE the engine call (`tool_choice`) at the closed-set beats where a missed
call is catastrophic. Now possible because the OOB narrator is GLM-4.7 (PR #1151), which HONORS
`tool_choice` (DeepSeek-V4 rejected `required` in always-thinking mode — `tool_choice` was therefore
DELIBERATELY never sent before this feature, per the 2026-06-21 conformance audit).

Two layers, both driven for real (the suite STUBS the LLM, so the live "does GLM actually honor the
forced call" check is OWED separately — these pin the WIRE + the gate):

  • llm_core: `tool_choice` reaches the OpenAI-style payload when passed, ALONGSIDE `tools`; and is
    ABSENT BY DEFAULT ⇒ byte-identical to before (the safety contract). Interop with the reasoning
    budget: forcing rides its own payload key and never perturbs `reasoning` (reasoning stays on its own
    channel — never the public bubble).
  • agent_loop: the pure `_forced_tool_choice_for_beat` gate fires at the right ENGINE-OWNED beats
    (comp → named advanceGame, #1319 — never a bare "required", since `runCompetition` is a no-op once
    a staged comp is already in progress; ceremony advance → named advanceGame; previewed-uncommitted →
    named advanceGame) and NOT on ordinary turns, never forces submitDecision, and is suppressed by an
    open player pending; plus the model-rejecter gate (DeepSeek-V4 never gets forced) and the
    kill-switch default.

Roles only (no names as data).
"""
import asyncio
import json

OR_URL = "https://openrouter.ai/api/v1/chat/completions"
OAI_URL = "https://api.openai.com/v1/chat/completions"

# A minimal OpenAI-style tool schema (the wire only cares that `tools` is non-empty so tool_choice is
# legal); never names a houseguest.
_TOOLS = [{
    "type": "function",
    "function": {"name": "advanceGame", "description": "advance the beat",
                 "parameters": {"type": "object", "properties": {}}},
}]


# ── llm_core capture harness (mirrors test_adr0010_reasoning_budget / test_1002) ────────────────────

class _FakeResp:
    status_code = 200

    async def aiter_lines(self):
        for ln in ['data: {"choices":[{"delta":{"content":"hi"}}]}', "data: [DONE]"]:
            yield ln

    async def aread(self):
        return b""


class _FakeStreamCM:
    def __init__(self, captured, payload):
        captured["payload"] = payload

    async def __aenter__(self):
        return _FakeResp()

    async def __aexit__(self, *a):
        return False


class _FakeClient:
    def __init__(self, captured):
        self._captured = captured

    def stream(self, method, url, json=None, headers=None, timeout=None):
        return _FakeStreamCM(self._captured, json)


def _capture_payload(monkeypatch, url, model, **stream_kwargs):
    """Drive stream_llm against a stubbed transport and return the JSON payload that hit the wire."""
    from src import llm_core as lc
    captured: dict = {}
    monkeypatch.setattr(lc, "_get_http_client", lambda: _FakeClient(captured))
    monkeypatch.setattr(lc, "_is_host_dead", lambda u: False)
    monkeypatch.setattr(lc, "note_model_activity", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_clear_host_dead", lambda *a, **k: None)

    async def drive():
        async for _ in lc.stream_llm(url, model, [{"role": "user", "content": "x"}], **stream_kwargs):
            pass

    asyncio.get_event_loop().run_until_complete(drive())
    return captured.get("payload") or {}


# ── (a) tool_choice is plumbed through to the OpenAI-style payload ──────────────────────────────────

def test_tool_choice_required_reaches_the_payload(monkeypatch):
    p = _capture_payload(monkeypatch, OR_URL, "z-ai/glm-4.7", tools=_TOOLS, tool_choice="required")
    assert p.get("tool_choice") == "required", p
    assert p.get("tools") == _TOOLS  # sent ALONGSIDE tools


def test_named_function_tool_choice_reaches_the_payload(monkeypatch):
    choice = {"type": "function", "function": {"name": "advanceGame"}}
    p = _capture_payload(monkeypatch, OR_URL, "z-ai/glm-4.7", tools=_TOOLS, tool_choice=choice)
    assert p.get("tool_choice") == choice, p


def test_tool_choice_is_not_sent_without_tools(monkeypatch):
    # A tool_choice with NO tools 400s on most providers — it is nested under `if tools`, so a
    # tool_choice passed with no tools must be dropped, not sent.
    p = _capture_payload(monkeypatch, OR_URL, "z-ai/glm-4.7", tools=None, tool_choice="required")
    assert "tool_choice" not in p, p
    assert "tools" not in p


# ── (b) absent by default ⇒ byte-identical request (THE safety contract) ────────────────────────────

def test_default_unset_is_byte_identical():
    """Proves the default (tool_choice unset) produces a payload byte-identical to one built with the
    arg OMITTED entirely — i.e. the new param adds NOTHING to the wire unless explicitly forced. This
    is the #1154 safety contract: absent ⇒ byte-identical to before this feature."""
    import pytest

    # Two captures: tools present + tool_choice EXPLICITLY None, vs the arg never passed at all. They
    # must serialize identically (and neither may contain a tool_choice key). Separate monkeypatch
    # contexts so the two stubbed transports don't collide.
    with pytest.MonkeyPatch().context() as mp1:
        p_default = _capture_payload(mp1, OR_URL, "z-ai/glm-4.7", tools=_TOOLS, tool_choice=None)
    with pytest.MonkeyPatch().context() as mp2:
        p_omitted = _capture_payload(mp2, OR_URL, "z-ai/glm-4.7", tools=_TOOLS)

    assert "tool_choice" not in p_default, p_default
    assert "tool_choice" not in p_omitted, p_omitted
    # Byte-identical: same keys, same serialized bytes.
    assert json.dumps(p_default, sort_keys=True) == json.dumps(p_omitted, sort_keys=True)


def test_default_unset_no_tools_is_byte_identical():
    # The no-tools turn (ordinary narration with tools filtered to empty) — the most common live shape —
    # must also be byte-identical with the arg defaulted vs omitted.
    import pytest
    with pytest.MonkeyPatch().context() as mp1:
        p_default = _capture_payload(mp1, OR_URL, "z-ai/glm-4.7", tools=None, tool_choice=None)
    with pytest.MonkeyPatch().context() as mp2:
        p_omitted = _capture_payload(mp2, OR_URL, "z-ai/glm-4.7", tools=None)
    assert "tool_choice" not in p_default and "tool_choice" not in p_omitted
    assert json.dumps(p_default, sort_keys=True) == json.dumps(p_omitted, sort_keys=True)


# ── (d) interop with reasoning `low` — reasoning stays on its OWN channel ────────────────────────────

def test_tool_choice_interop_with_reasoning_low(monkeypatch):
    """Forcing rides the `tool_choice` key; the reasoning budget rides `reasoning`. The two are
    independent — a forced call must NOT perturb the reasoning field (and vice-versa). Reasoning stays
    on its own payload channel, never bleeding into the tool directive (or, downstream, the public
    bubble — that split is enforced in chat.js, untouched here)."""
    p = _capture_payload(
        monkeypatch, OR_URL, "z-ai/glm-4.7",
        tools=_TOOLS, tool_choice="required",
        policy={"reasoning": {"effort": "low"}, "max_tokens": 4096},
    )
    # Both present, each on its own key. (OpenRouter's `reasoning` takes EITHER effort OR max_tokens,
    # never both — #1543 — so a valid budget rides as the model-aware `max_tokens` sub-budget; the point
    # here is that the reasoning channel and tool_choice stay independent, whatever the reasoning shape.)
    assert p.get("tool_choice") == "required", p
    assert (p.get("reasoning") or {}).get("max_tokens"), p
    # The directives don't bleed into each other.
    assert "reasoning" not in str(p.get("tool_choice"))
    assert "tool_choice" not in json.dumps(p.get("reasoning"))


def test_reasoning_low_without_forcing_has_no_tool_choice(monkeypatch):
    # The mirror: a reasoning-low turn that does NOT force must carry reasoning but NO tool_choice.
    p = _capture_payload(
        monkeypatch, OR_URL, "z-ai/glm-4.7",
        tools=_TOOLS, policy={"reasoning": {"effort": "low"}, "max_tokens": 4096})
    # reasoning on its own channel as the model-aware `max_tokens` sub-budget (OpenRouter one-param, #1543).
    assert (p.get("reasoning") or {}).get("max_tokens")
    assert "tool_choice" not in p


# ── (c) the gate fires at the right beats and NOT on ordinary turns ──────────────────────────────────

# #1411 — the beat→lever map is now ENGINE-SIGNALED (`requiredLeverForPhase`, src/engine/momentPrompts.ts):
# advanceGame at EXACTLY the five closed-set beats, else None. The FE gate no longer holds this map. For
# the pure-gate tests below we mirror the engine's rule so the existing beat-forcing assertions read as
# "at this framed beat the engine signals advanceGame, and the gate forces it". The byte-identity anchor
# for this mirror lives ENGINE-side (tests/unit/requiredLever.test.ts).
_CLOSED_SET_BEATS = {"hoh-competition", "veto-competition", "nominations", "veto-ceremony", "eviction"}
_UNSET = object()


def _engine_lever_for(framed_key):
    phase = (str(framed_key[1]).lower()
             if isinstance(framed_key, (tuple, list)) and len(framed_key) >= 2 else "")
    return "advanceGame" if phase in _CLOSED_SET_BEATS else None


def _gate(framed_key, fired, *, pending=False, required_lever=_UNSET):
    """Drive the pure gate. `required_lever` defaults to what the ENGINE would signal for the framed
    beat's phase (the map is now engine-owned); pass it explicitly to test the gate in isolation."""
    from src.agent_loop import _forced_tool_choice_for_beat
    lever = _engine_lever_for(framed_key) if required_lever is _UNSET else required_lever
    return _forced_tool_choice_for_beat(framed_key, set(fired), pending_open=pending, required_lever=lever)


_ADV = {"type": "function", "function": {"name": "advanceGame"}}


def test_comp_phase_forces_named_advance_when_nothing_fired():
    # #1319: hoh-competition/veto-competition with no advanceGame fired yet → force the NAMED call
    # directly (never a bare "required" — runCompetition is a no-op once a staged comp is already in
    # progress, so permitting it as an equally-valid forced choice let a turn spend its forced attempt
    # on a dead-end preview and never reveal a round — the staged play-by-play bug this test pins).
    assert _gate(("w1", "hoh-competition", "hoh-competition"), []) == _ADV
    assert _gate(("w2", "veto-competition", "veto-competition"), []) == _ADV


def test_comp_phase_previewed_uncommitted_still_forces_named_advance():
    # A model that ALSO calls runCompetition first (e.g. for narrative color) is unaffected — the
    # guarantee is only met once advanceGame itself fires this round.
    assert _gate(("w1", "hoh-competition", "x"), ["runCompetition"]) == _ADV


def test_comp_phase_already_advanced_does_not_force():
    # The engine call already happened this turn → the guarantee is met → no forcing.
    assert _gate(("w1", "hoh-competition", "x"), ["advanceGame"]) is None
    assert _gate(("w1", "hoh-competition", "x"), ["runCompetition", "advanceGame"]) is None


def test_comp_phase_in_progress_forces_every_turn_until_crowned():
    # #1319: the pure gate is stateless — each fresh call (mirroring a fresh user turn, since
    # tool_events resets every turn) with the SAME still-in-progress framed key re-forces the named
    # advanceGame, round after round, for as long as the phase stays a force-comp-phase with no tool
    # fired yet. This is the "every turn until the crown" guarantee — not just the first round.
    key = ("w1", "hoh-competition", "hoh-competition")
    for _ in range(5):  # STAGED_TARGET_ROUNDS-ish consecutive turns
        assert _gate(key, []) == _ADV
    # Once the engine crowns (phase flips away from the comp phase), forcing stops on its own.
    assert _gate(("w1", "nominations", "nominations"), []) == _ADV  # a DIFFERENT force (ceremony)


def test_ceremony_advance_phase_forces_named_advance():
    for phase in ("nominations", "veto-ceremony", "eviction"):
        assert _gate(("w1", phase, phase), []) == _ADV, phase


def test_ceremony_advance_phase_not_forced_once_advanced():
    assert _gate(("w1", "eviction", "x"), ["advanceGame"]) is None


def test_ordinary_social_phase_never_forces():
    # The common case — a lull / social turn / a non-force phase — must NEVER force.
    assert _gate(("w1", "social", "social"), []) is None
    assert _gate(("w1", "social", "lingering"), ["recordInteraction"]) is None
    # premiere / finale / twist-reveal are deliberately EXCLUDED (their own belts handle them).
    assert _gate(("w1", "premiere", "premiere"), []) is None
    assert _gate(("w1", "finale", "finale"), []) is None
    assert _gate(("w1", "twist-reveal", "twist-reveal"), []) is None


# ── J-3 (root a): a moment OVERRIDE (social hold / witnessed ceremony) suppresses phase-blind forcing ─
# chat_helpers overrides the framed MOMENT away from the raw phase in two cases the force gate must
# respect, or it re-opens the exact force-march the overrides exist to prevent:
#   • the social-runway HOLD  → moment="social" while phase is the next unresolved ceremony/comp;
#   • the witnessed-ceremony  → moment="nominations" AFTER the engine self-advanced phase to the NEXT
#     beat (e.g. "veto-competition", NARR-7) so the player WITNESSES the just-resolved noms.
# Forcing off the raw phase in either case force-advances the held/witnessed beat past the runway.

def test_social_hold_moment_suppresses_forcing_even_on_a_ceremony_phase():
    # The runway is HOLDING: moment="social", but phase is still the unresolved next ceremony/comp.
    # Forcing here would drag the player past their protected lingering window → suppress.
    assert _gate(("w1", "nominations", "social"), []) is None
    assert _gate(("w1", "veto-ceremony", "social"), []) is None
    assert _gate(("w1", "eviction", "social"), []) is None
    assert _gate(("w1", "hoh-competition", "social"), []) is None
    assert _gate(("w1", "veto-competition", "social"), []) is None


def test_witnessed_ceremony_moment_mismatch_suppresses_forcing():
    # The engine self-advanced phase past the ceremony (NARR-7); the FE re-frames the moment on the
    # just-resolved beat so the player witnesses it. The moment is a force-advance beat but does NOT
    # match the (already-rolled) phase → the model already has the beat to narrate; forcing would only
    # chase the NEXT phase's requirement → suppress.
    assert _gate(("w2", "veto-competition", "nominations"), []) is None
    assert _gate(("w2", "eviction", "veto-ceremony"), []) is None


def test_matching_ceremony_moment_still_forces():
    # The genuine, un-overridden case (moment == phase) is unchanged — forcing still fires.
    assert _gate(("w1", "nominations", "nominations"), []) == _ADV
    assert _gate(("w1", "eviction", "eviction"), []) == _ADV
    assert _gate(("w1", "hoh-competition", "hoh-competition"), []) == _ADV  # #1319: named, not "required"
    # And the 3-tuple back-compat shape (no moment element) still forces — an empty moment is neither
    # the social hold nor a mismatched ceremony override.
    assert _gate(("w1", "eviction"), []) == _ADV


def test_open_player_pending_suppresses_all_forcing():
    # An open player pending ⇒ the engine waits on the PLAYER (a card). The model must surface it, not
    # advance/run a comp past it — and we NEVER force submitDecision (that infers a binding choice).
    assert _gate(("w1", "eviction", "x", "goodbye-message"), [], pending=True) is None
    assert _gate(("w1", "hoh-competition", "x", "comp-intent"), [], pending=True) is None
    assert _gate(("w1", "nominations", "x", "nominations"), [], pending=True) is None
    # #1319: the round-1 `comp-round` pending (the player's binding compete/throw/play-safe pick,
    # liveSeason.ts `resolveHohBeat`/`resolveVetoComp`) is the literal case the root cause names —
    # forcing must stay fully suppressed while that card is open, exactly like every other pending.
    assert _gate(("w1", "hoh-competition", "x", "comp-round"), [], pending=True) is None
    assert _gate(("w2", "veto-competition", "x", "comp-round"), [], pending=True) is None


def test_never_forces_submit_decision():
    # Defensive: no input shape may ever yield a submitDecision force (the mandate: engine never speaks
    # for the player). Sweep every closed-set beat + a representative pending, AND the explicit case
    # where the engine (impossibly) NAMES submitDecision — the gate's hard guard must still refuse it.
    for phase in _CLOSED_SET_BEATS:
        for fired in ([], ["runCompetition"], ["advanceGame"]):
            for pend in (True, False):
                got = _gate(("w1", phase, phase), fired, pending=pend)
                if isinstance(got, dict):
                    assert got["function"]["name"] != "submitDecision", (phase, fired, pend)
    # The hard guard: even if the engine signal regressed to name submitDecision, the gate refuses.
    assert _gate(("w1", "eviction", "eviction"), [], required_lever="submitDecision") is None


# ── #1411: the gate forces WHATEVER THE ENGINE NAMES — no FE-held beat→lever map remains ────────────

def test_gate_forces_the_engine_named_lever_regardless_of_a_local_map():
    # The lever the ENGINE signals is forced verbatim — even at a phase string the retired FE map never
    # knew (proving the map is gone: the FE no longer classifies the phase itself).
    got = _gate(("w1", "some-future-closed-beat", "some-future-closed-beat"),
                [], required_lever="advanceGame")
    assert got == _ADV


def test_gate_never_forces_when_engine_names_no_lever_even_at_a_comp_phase():
    # The crux of #1411: at hoh-competition the OLD FE map would have forced advanceGame; now, when the
    # engine signals NO lever (requiredLever absent ⇒ None), the gate must NOT force — it obeys the
    # engine's signal, not a local phase classification.
    assert _gate(("w1", "hoh-competition", "hoh-competition"), [], required_lever=None) is None
    assert _gate(("w1", "eviction", "eviction"), [], required_lever=None) is None


def test_gate_already_fired_check_keys_on_the_named_lever():
    # The "guarantee met" suppression keys on the ENGINE-NAMED lever, not a hard-coded "advanceGame".
    assert _gate(("w1", "eviction", "eviction"), ["advanceGame"], required_lever="advanceGame") is None
    # A different named lever that already fired is likewise not re-forced.
    assert _gate(("w1", "premiere", "premiere"), ["createCharacter"], required_lever="createCharacter") is None
    # …but if it has NOT fired, the named lever is forced.
    assert _gate(("w1", "premiere", "premiere"), [], required_lever="createCharacter") \
        == {"type": "function", "function": {"name": "createCharacter"}}


def test_malformed_framed_key_is_safe():
    # Fail-open on a None / too-short / non-tuple framed key — never raise, never force. Via _gate (which
    # derives the engine lever from the key's phase), a malformed key yields no lever ⇒ no force.
    assert _gate(None, []) is None
    assert _gate(("just-week",), []) is None
    assert _gate("not-a-tuple", []) is None
    # And the gate itself never RAISES on a malformed key even when a lever is (defensively) named — its
    # internal isinstance guards default phase/moment to "" (no social/override suppression to read).
    from src.agent_loop import _forced_tool_choice_for_beat
    assert _forced_tool_choice_for_beat("not-a-tuple", set(), pending_open=False,
                                        required_lever="advanceGame") == _ADV


# ── the model-rejecter gate: DeepSeek-V4 (always-thinking) NEVER gets forced; GLM does ──────────────

def test_glm_honors_forcing_deepseek_v4_does_not():
    from src.agent_loop import _model_honors_forced_tool_choice
    assert _model_honors_forced_tool_choice("z-ai/glm-4.7") is True
    assert _model_honors_forced_tool_choice("openai/gpt-4o") is True
    # The documented rejecters (always-thinking DeepSeek) must be excluded.
    assert _model_honors_forced_tool_choice("deepseek/deepseek-v4-pro") is False
    assert _model_honors_forced_tool_choice("deepseek/deepseek-v4-flash") is False
    assert _model_honors_forced_tool_choice("deepseek/deepseek-r1") is False


# ── the runtime kill-switch default ─────────────────────────────────────────────────────────────────

def test_kill_switch_defaults_on():
    from src.settings import DEFAULT_SETTINGS
    assert DEFAULT_SETTINGS.get("force_tool_choice_at_beats") is True


# ── END-TO-END: the agent loop computes the force and passes tool_choice to the wire ────────────────
# Captures the kwargs the loop hands stream_llm_with_fallback (mirrors test_adr0010's policy capture),
# so we prove the WIRING — reading _LAST_FRAMED_BEAT_KEY, the kill-switch + model gates, and passing
# tool_choice through — not just the pure gate above.

def _drive_loop_capture_tool_choice(monkeypatch, *, model, framed_key, pending=None,
                                    force_setting=True, game_mode="game", owner="tester",
                                    required_lever=_UNSET):
    from src import agent_loop as al
    from routes import chat_helpers as ch
    from src import orwell_engine as oe

    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)

    _real_get_setting = al.get_setting

    def fake_get_setting(key, default=None):
        if key == "force_tool_choice_at_beats":
            return force_setting
        # keep real reasoning/policy resolution intact for the interop legs
        return _real_get_setting(key, default)

    monkeypatch.setattr(al, "get_setting", fake_get_setting)
    import src.tool_index as ti
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)

    # The framed beat the model is grounded on this turn (what apply_game_framing would have stashed).
    # #1154 no-auth: the loop resolves owner→"default" when None, and the store keys under that same
    # fallback — so mirror it here so an owner=None drive reads the key the gate will look for.
    _fk_owner = owner or "default"
    # #1411: the loop reads the ENGINE-SIGNALED required lever from `_LAST_FRAMED_REQUIRED_LEVER` (what
    # apply_game_framing stashes from `GameStateView.requiredLever`), not a FE-held map. Mirror it here:
    # default to what the engine would signal for the framed beat's phase, or force an explicit value.
    _lever = _engine_lever_for(framed_key) if required_lever is _UNSET else required_lever
    if framed_key is None:
        ch._LAST_FRAMED_BEAT_KEY.pop(_fk_owner, None)
    else:
        ch._LAST_FRAMED_BEAT_KEY[_fk_owner] = framed_key
    if _lever is None:
        ch._LAST_FRAMED_REQUIRED_LEVER.pop(_fk_owner, None)
    else:
        ch._LAST_FRAMED_REQUIRED_LEVER[_fk_owner] = _lever

    # The engine's open-pending check the force consults (None ⇒ no pending ⇒ forcing allowed).
    async def fake_status(user=None):
        return {"pending": pending} if pending is not None else {"pending": None}
    monkeypatch.setattr(oe, "game_status", fake_status)

    cap: dict = {}

    async def fake_stream(candidates, messages, **kwargs):
        # Capture the FIRST round's kwargs only (the force is computed per round).
        if "tool_choice" not in cap:
            cap.update(kwargs)
        yield 'data: {"delta": "hi"}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)

    async def drive():
        async for _ in al.stream_agent_loop(
            OR_URL, model,
            [{"role": "system", "content": "narrator"}, {"role": "user", "content": "what happens"}],
            max_rounds=1, game_mode=game_mode, owner=owner,
        ):
            pass

    try:
        asyncio.get_event_loop().run_until_complete(drive())
    finally:
        ch._LAST_FRAMED_BEAT_KEY.pop(_fk_owner, None)
        ch._LAST_FRAMED_REQUIRED_LEVER.pop(_fk_owner, None)
    return cap


def test_loop_forces_named_advance_at_a_comp_beat(monkeypatch):
    # #1319: a comp phase forces the NAMED advanceGame directly (never bare "required") so every
    # forced attempt guarantees a real round reveal, not a dead-end runCompetition preview.
    cap = _drive_loop_capture_tool_choice(
        monkeypatch, model="z-ai/glm-4.7", framed_key=("w1", "hoh-competition", "hoh-competition"))
    assert cap.get("tools"), "tools must be on the wire for forcing to be legal"
    assert cap.get("tool_choice") == {"type": "function", "function": {"name": "advanceGame"}}, cap.get("tool_choice")


def test_loop_forces_named_advance_at_a_ceremony_beat(monkeypatch):
    cap = _drive_loop_capture_tool_choice(
        monkeypatch, model="z-ai/glm-4.7", framed_key=("w1", "eviction", "eviction"))
    assert cap.get("tool_choice") == {"type": "function", "function": {"name": "advanceGame"}}, cap.get("tool_choice")


def test_loop_forces_under_no_auth_owner_none(monkeypatch):
    # #1154 no-auth fix: under AUTH_ENABLED=false the chat path has owner=None and the game lives under
    # the engine "default" sandbox. The gate must STILL engage (it previously short-circuited on the
    # `and owner` precondition, leaving forcing dead in the single-user / LAN posture). The framed beat
    # is keyed under "default" (what the fixed apply_game_framing stores when user is None), and the loop
    # resolves owner→"default" to read it.
    cap = _drive_loop_capture_tool_choice(
        monkeypatch, model="z-ai/glm-4.7",
        framed_key=("w1", "hoh-competition", "hoh-competition"), owner=None)
    assert cap.get("tool_choice") == {"type": "function", "function": {"name": "advanceGame"}}, cap.get("tool_choice")


def test_loop_does_not_force_on_an_ordinary_social_turn(monkeypatch):
    # The default live turn (a social/lingering moment) must pass tool_choice=None ⇒ byte-identical wire.
    cap = _drive_loop_capture_tool_choice(
        monkeypatch, model="z-ai/glm-4.7", framed_key=("w1", "social", "lingering"))
    assert cap.get("tool_choice") is None, cap.get("tool_choice")


def test_loop_does_not_force_when_pending_is_open(monkeypatch):
    # A force-candidate phase but an OPEN player pending ⇒ no forcing (the player owns the card).
    cap = _drive_loop_capture_tool_choice(
        monkeypatch, model="z-ai/glm-4.7", framed_key=("w1", "eviction", "eviction", "goodbye-message"),
        pending={"kind": "goodbye-message"})
    assert cap.get("tool_choice") is None, cap.get("tool_choice")


def test_loop_does_not_force_for_a_rejecter_model(monkeypatch):
    # DeepSeek-V4 400s on tool_choice — even at a force-candidate beat, the loop must NOT send it.
    cap = _drive_loop_capture_tool_choice(
        monkeypatch, model="deepseek/deepseek-v4-pro", framed_key=("w1", "eviction", "eviction"))
    assert cap.get("tool_choice") is None, cap.get("tool_choice")


def test_loop_kill_switch_off_disables_forcing(monkeypatch):
    # The runtime kill-switch OFF ⇒ no forcing even at a force-candidate beat (no redeploy needed).
    cap = _drive_loop_capture_tool_choice(
        monkeypatch, model="z-ai/glm-4.7", framed_key=("w1", "hoh-competition", "hoh-competition"),
        force_setting=False)
    assert cap.get("tool_choice") is None, cap.get("tool_choice")


def test_loop_non_game_chat_never_forces(monkeypatch):
    # Platform (non-game) chat is unchanged — _is_live_game False ⇒ no forcing path at all.
    cap = _drive_loop_capture_tool_choice(
        monkeypatch, model="z-ai/glm-4.7", framed_key=("w1", "hoh-competition", "hoh-competition"),
        game_mode=None)
    assert cap.get("tool_choice") is None, cap.get("tool_choice")


# ── BL-007: forced whereabouts on premiere/group free-play turns ──────────────────────────────────────
# Pure gate tests for `_forced_tool_choice_for_whereabouts`: forces `whereabouts` on free-play turns
# where the model lacks location grounding from the engine.

_WHEREABOUTS = {"type": "function", "function": {"name": "whereabouts"}}


def _whereabouts_gate(fired, *, game_mode="live", premiere_view=None, frozen_whereabouts=None, last_turn_called=False):
    from src.agent_loop import _forced_tool_choice_for_whereabouts
    return _forced_tool_choice_for_whereabouts(
        set(fired), game_mode=game_mode, premiere_view=premiere_view,
        frozen_whereabouts=frozen_whereabouts,
        last_turn_called_whereabouts=last_turn_called)


def test_whereabouts_gate_forces_on_active_premiere():
    # Trigger (a): premiere is active (not complete) → force whereabouts
    assert _whereabouts_gate([], premiere_view={"champagneCircle": "gathered", "total": 16}) == _WHEREABOUTS


def test_whereabouts_gate_forces_on_co_present_with_two_or_more():
    # Trigger (b): >=2 co-present others in the frozen whereabouts
    frozen = {"room": "living-room", "present": [{"id": "npc:1"}, {"id": "npc:2"}, {"id": "npc:3"}]}
    assert _whereabouts_gate([], frozen_whereabouts=frozen) == _WHEREABOUTS


def test_whereabouts_gate_does_not_force_on_solo_whereabouts():
    # Off-trigger: only 0-1 co-present
    frozen = {"room": "kitchen", "present": [{"id": "npc:1"}]}
    assert _whereabouts_gate([], frozen_whereabouts=frozen) is None
    frozen_empty = {"room": "storage", "present": []}
    assert _whereabouts_gate([], frozen_whereabouts=frozen_empty) is None
    assert _whereabouts_gate([], frozen_whereabouts=None) is None


def test_whereabouts_gate_does_not_force_when_already_called_this_turn():
    frozen = {"room": "living-room", "present": [{"id": "npc:1"}, {"id": "npc:2"}, {"id": "npc:3"}]}
    assert _whereabouts_gate(["whereabouts"], frozen_whereabouts=frozen) is None


def test_whereabouts_gate_anti_spam_does_not_force_two_turns_running():
    frozen = {"room": "living-room", "present": [{"id": "npc:1"}, {"id": "npc:2"}, {"id": "npc:3"}]}
    assert _whereabouts_gate([], frozen_whereabouts=frozen, last_turn_called=True) is None


def test_whereabouts_gate_does_not_force_outside_live_game():
    frozen = {"room": "living-room", "present": [{"id": "npc:1"}, {"id": "npc:2"}]}
    assert _whereabouts_gate([], game_mode=None, frozen_whereabouts=frozen) is None
    assert _whereabouts_gate([], game_mode="casting", frozen_whereabouts=frozen) is None


def test_whereabouts_gate_premiere_wins_over_present_count():
    # Both triggers hold → still force (latched by premiere)
    frozen_none = None
    assert _whereabouts_gate([], premiere_view={"total": 16}, frozen_whereabouts=frozen_none) == _WHEREABOUTS


# ── Gap #3: the CASTING-FINALIZE force (docs/design/undercall-seam-structural.md §4) ────────────────
# The one pre-game closed-set beat with exactly one legal lever: casting engine-`ready` AND
# `finalizable`, the season not started, the PLAYER explicitly signalled readiness — the same gates
# the reactive finalize fallback already requires, so no new authority: only WHEN the guaranteed
# createCharacter happens moves (proactive, on the wire). We still NEVER force submitDecision.

_CREATE = {"type": "function", "function": {"name": "createCharacter"}}


def _casting_gate(fired, *, ready=True, finalizable=True, started=False, signalled=True):
    from src.agent_loop import _forced_tool_choice_for_casting
    return _forced_tool_choice_for_casting(
        set(fired), ready=ready, finalizable=finalizable, started=started,
        player_signalled=signalled)


def test_casting_gate_forces_when_every_reactive_terminal_gate_holds():
    assert _casting_gate([]) == _CREATE


def test_casting_gate_requires_the_engine_terminal():
    # `ready` alone (name-only intake) must NEVER force — that would mint the floater the reactive
    # belt's `finalizable` gate exists to prevent. Neither may an un-ready intake.
    assert _casting_gate([], finalizable=False) is None
    assert _casting_gate([], ready=False) is None
    assert _casting_gate([], ready=False, finalizable=False) is None


def test_casting_gate_requires_the_player_signal():
    # The player never asked to start ⇒ never force (the interview keeps its own pace; the engine
    # never starts a game the player did not ask for).
    assert _casting_gate([], signalled=False) is None


def test_casting_gate_never_forces_once_started():
    assert _casting_gate([], started=True) is None


def test_casting_gate_met_guarantee_does_not_reforce():
    # createCharacter already fired this turn ⇒ the guarantee is met ⇒ no re-force on later rounds.
    assert _casting_gate(["createCharacter"]) is None
    assert _casting_gate(["updateCasting", "createCharacter"]) is None


def test_casting_gate_never_forces_submit_decision():
    got = _casting_gate([])
    assert got is None or got["function"]["name"] != "submitDecision"


# ── END-TO-END: the casting turn computes the force and passes tool_choice to the wire ──────────────


def _drive_casting_capture_tool_choice(monkeypatch, *, model="z-ai/glm-4.7", last_user,
                                       casting=None, started=False, force_setting=True,
                                       owner="tester-casting"):
    from src import agent_loop as al
    from src import orwell_engine as oe
    import src.tool_index as ti
    import src.tool_implementations as timpl

    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)

    _real_get_setting = al.get_setting

    def fake_get_setting(key, default=None):
        if key == "force_tool_choice_at_beats":
            return force_setting
        return _real_get_setting(key, default)

    monkeypatch.setattr(al, "get_setting", fake_get_setting)
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)

    # The engine casting view BOTH the pre-stream force and the post-turn reactive belt read.
    async def fake_gs(user=None):
        return {"started": started, "casting": casting}

    monkeypatch.setattr(oe, "get_game_state", fake_gs)

    # Keep the post-turn reactive casting belts hermetic (no network, no engine): the record belt
    # stands down and the reactive finalize's engine call is stubbed to a refused no-op.
    async def _no_record(*_a, **_k):
        return False

    monkeypatch.setattr(al, "_auto_record_casting", _no_record)

    async def _no_create(*_a, **_k):
        return {"error": "stubbed engine"}

    monkeypatch.setattr(timpl, "do_create_character", _no_create)
    # Fresh reactive-ladder state per drive (the stubbed refused create marches it otherwise).
    al._CASTING_STALL_LEVEL.pop(owner, None)
    al._CASTING_SUBSTANCE_LEVEL.pop(owner, None)

    cap: dict = {}

    async def fake_stream(candidates, messages, **kwargs):
        if "tool_choice" not in cap:
            cap.update(kwargs)
        yield 'data: {"delta": "hi"}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)

    async def drive():
        async for _ in al.stream_agent_loop(
            OR_URL, model,
            [{"role": "system", "content": "producer"}, {"role": "user", "content": last_user}],
            max_rounds=1, game_mode="casting", owner=owner,
        ):
            pass

    try:
        asyncio.get_event_loop().run_until_complete(drive())
    finally:
        al._CASTING_STALL_LEVEL.pop(owner, None)
        al._CASTING_SUBSTANCE_LEVEL.pop(owner, None)
    return cap


def test_casting_loop_forces_create_character_when_finalizable_and_player_ready(monkeypatch):
    cap = _drive_casting_capture_tool_choice(
        monkeypatch, last_user="Lock it in — put me in the house.",
        casting={"ready": True, "finalizable": True})
    assert cap.get("tools"), "tools must be on the wire for forcing to be legal"
    assert any((t.get("function") or {}).get("name") == "createCharacter"
               for t in cap.get("tools") or []), "createCharacter must be among the wire tools"
    assert cap.get("tool_choice") == _CREATE, cap.get("tool_choice")


def test_casting_loop_does_not_force_on_a_substantive_interview_answer(monkeypatch):
    # An ordinary interview turn (no readiness signal) is byte-identical: tool_choice=None. The
    # cheap regex gate rejects BEFORE any engine read — the common casting turn costs nothing.
    cap = _drive_casting_capture_tool_choice(
        monkeypatch,
        last_user="I grew up on a farm and I plan to build real bonds before I ever scheme.",
        casting={"ready": True, "finalizable": True})
    assert cap.get("tool_choice") is None, cap.get("tool_choice")


def test_casting_loop_does_not_force_before_the_interview_is_finalizable(monkeypatch):
    # Player asks to start but the intake is name-only (ready, NOT finalizable): never force — the
    # engine would refuse, and the substance ladder owns this case.
    cap = _drive_casting_capture_tool_choice(
        monkeypatch, last_user="put me in the house",
        casting={"ready": True, "finalizable": False})
    assert cap.get("tool_choice") is None, cap.get("tool_choice")


def test_casting_loop_kill_switch_and_rejecter_gate_apply(monkeypatch):
    cap = _drive_casting_capture_tool_choice(
        monkeypatch, last_user="put me in the house",
        casting={"ready": True, "finalizable": True}, force_setting=False)
    assert cap.get("tool_choice") is None
    cap = _drive_casting_capture_tool_choice(
        monkeypatch, model="deepseek/deepseek-v4-pro", last_user="put me in the house",
        casting={"ready": True, "finalizable": True})
    assert cap.get("tool_choice") is None


def test_orw142_bl007_block_computes_its_own_turn_tool_names():
    """ORW-142 (11-06 live playtest): the BL-007 whereabouts force read `_turn_tool_names_force`, a
    local assigned only inside the sibling lever-force / casting-finalize branches, so every premiere
    or group free-play turn raised UnboundLocalError, the blanket except logged "BL-007 whereabouts
    force skipped", and BL-007 never ran. The block must derive this turn's tool names itself."""
    import pathlib
    src = (pathlib.Path(__file__).resolve().parents[1] / "src" / "agent_loop.py").read_text(encoding="utf-8")
    start = src.index("# ── BL-007: force whereabouts on premiere/group free-play turns")
    end = src.index("# Primary target + any configured fallback models", start)
    block = src[start:end]
    assert "_turn_tool_names_force" not in block
    assert "tool_events" in block
    assert "_forced_tool_choice_for_whereabouts(" in block
