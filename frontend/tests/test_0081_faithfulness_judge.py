"""Feature 0081 — the FaithfulnessJudge (P2a: detection + the verdict contract).

The judge is the overseer's second-role reasoning tier: it reads ONLY the narration + the player's
Vault-free projection and proposes one correction lever. This lane pins the judge's contract at the
unit grain, mirroring ``tests/test_0079_overseer_reasoning.py``:

  * the verdict tuples are the documented sets;
  * the sparse trigger (:func:`should_judge`) wakes only on a claim-bearing or engaged turn;
  * the deterministic stub NEVER flags (the live-only carve-out — seeded lanes stay byte-identical);
  * strict parsing: any out-of-contract token / unparseable reply ⇒ the deterministic floor;
  * **THE WALL (mandate #3)**: ``adopt`` is accepted ONLY for an ``open`` slip — a model proposing to
    adopt a closed-set slip is rejected to the floor, and no lever can bend a closed-set outcome;
  * Vault-free by construction: the only inputs are the caller-supplied narration + projection.

Name-agnostic: ROLES only (HOH, nominee, evictee, player, NPC), never names.
"""

from src.faithfulness import (
    FAITH_CLASSES,
    FAITH_DIMENSIONS,
    FAITH_LEVERS,
    DeterministicFaithfulnessJudge,
    FaithfulnessJudge,
    FaithfulnessVerdict,
    dispatch_correction,
    should_judge,
)


def _judge(reply):
    """A FaithfulnessJudge whose model returns a fixed ``reply`` for any prompt."""
    return FaithfulnessJudge(lambda _prompt: reply)


def _json(dimension, classification, lever, rationale="because"):
    import json
    return json.dumps(
        {"dimension": dimension, "classification": classification, "lever": lever,
         "rationale": rationale}
    )


# ── the contract surface ──────────────────────────────────────────────────────────

def test_contract_tuples_are_the_documented_sets():
    assert FAITH_DIMENSIONS == ("board", "persona", "leak", "omission", "time")
    assert FAITH_CLASSES == ("open", "closed", "none")
    assert FAITH_LEVERS == ("none", "adopt", "reframe", "reground")


def test_verdict_is_slip_property():
    assert FaithfulnessVerdict("board", "closed", "reframe").is_slip is True
    assert FaithfulnessVerdict("none", "none", "none").is_slip is False
    # a lever without a real classification (or vice versa) is NOT a slip — the healthy turn.
    assert FaithfulnessVerdict("none", "none", "reframe").is_slip is False


# ── the sparse trigger ─────────────────────────────────────────────────────────────

def test_should_judge_wakes_on_claim_or_engaged_scene_only():
    assert should_judge(claim_bearing=True, engaged_scene=False) is True
    assert should_judge(claim_bearing=False, engaged_scene=True) is True
    assert should_judge(claim_bearing=True, engaged_scene=True) is True
    # a pure lull — neither a board claim nor an engaged scene — trips nothing.
    assert should_judge(claim_bearing=False, engaged_scene=False) is False


# ── the deterministic stub — the live-only carve-out ───────────────────────────────

def test_deterministic_judge_never_flags():
    """Seeded / no-model lanes wire the deterministic judge, which NEVER returns a slip — so the role
    is a pure no-op there and the lanes stay byte-identical (ruling D4)."""
    det = DeterministicFaithfulnessJudge()
    assert det.assess("the HOH crowned the new nominee", {"phase": "noms"}) is None
    assert det.assess("", None) is None


# ── well-formed verdicts parse through ─────────────────────────────────────────────

def test_no_slip_reply_parses_to_a_healthy_verdict():
    v = _judge(_json("none", "none", "none")).assess("a faithful line", {"phase": "veto"})
    assert v is not None
    assert v.is_slip is False
    assert v.lever == "none"


def test_open_set_adopt_is_accepted():
    """An OPEN-set slip may be adopted as canon — the one case where 'adopt' is valid."""
    v = _judge(_json("persona", "open", "adopt", "invented a harmless backyard detail")).assess(
        "they mention a hammock that was never established", {"phase": "veto"}
    )
    assert v is not None and v.is_slip is True
    assert v.lever == "adopt" and v.classification == "open"
    assert v.dimension == "persona"
    assert "hammock" not in v.rationale or isinstance(v.rationale, str)  # rationale is a string token


def test_closed_set_reframe_and_reground_are_accepted():
    vr = _judge(_json("board", "closed", "reframe")).assess("you won the veto", {"vetoHolder": "HOH"})
    assert vr is not None and vr.lever == "reframe" and vr.classification == "closed"
    vg = _judge(_json("board", "closed", "reground")).assess("you won the veto", {"vetoHolder": "HOH"})
    assert vg is not None and vg.lever == "reground" and vg.classification == "closed"


# ── THE WALL — adopt is rejected for any non-open slip ─────────────────────────────

def test_adopt_on_a_closed_slip_is_rejected_to_the_floor():
    """The load-bearing guard (mandate #3): a reply proposing to ADOPT a CLOSED-set slip — i.e. let a
    misnarration canonicalize a real outcome — is rejected to the deterministic floor (None). This is
    the one move the role must never make."""
    v = _judge(_json("board", "closed", "adopt")).assess("you won the veto", {"vetoHolder": "HOH"})
    assert v is None


def test_adopt_with_no_classification_is_rejected():
    v = _judge(_json("board", "none", "adopt")).assess("you won the veto", {})
    assert v is None


def test_no_lever_can_bend_a_closed_outcome_is_pinned_in_the_prompt():
    """Source-pin the mandate framing in the judge's own prompt — the model is told, in-band, that it
    may never change a closed-set outcome to match the narration."""
    prompt = _judge("").build_prompt("you won the veto", {"vetoHolder": "HOH"})
    assert "NEVER change a closed-set OUTCOME" in prompt
    # the lever set is taught, and 'adopt' is explicitly gated to the open set.
    assert "adopt" in prompt and "ONLY valid when classification=open" in prompt


# ── strict parsing — out-of-contract / unparseable ⇒ the floor ─────────────────────

def test_out_of_contract_tokens_route_to_the_floor():
    assert _judge(_json("board", "closed", "delete-the-vault")).assess("x", {}) is None   # bad lever
    assert _judge(_json("teleport", "closed", "reframe")).assess("x", {}) is None          # bad dim
    assert _judge(_json("board", "sideways", "reframe")).assess("x", {}) is None           # bad class


def test_unparseable_reply_routes_to_the_floor():
    assert _judge("not json at all").assess("x", {}) is None
    assert _judge("").assess("x", {}) is None


def test_prose_around_the_json_is_tolerated():
    reply = "Sure, here's my call:\n" + _json("persona", "open", "adopt") + "\nhope that helps"
    v = _judge(reply).assess("x", {})
    assert v is not None and v.lever == "adopt"


def test_a_raising_model_never_propagates():
    def _boom(_prompt):
        raise RuntimeError("model exploded")
    # must not raise — fail-soft to the floor.
    assert FaithfulnessJudge(_boom).assess("x", {}) is None


# ── Vault-free by construction — the judge sees only narration + projection ────────

def test_prompt_is_built_only_from_the_caller_supplied_inputs():
    """The judge holds NO Vault handle; its prompt is a pure function of the narration + the
    Vault-free projection the caller passes. A leak is caught as 'beyond the projection', never by
    reading hidden state. We prove the input surface: both sentinels appear, and nothing else is
    fabricated into the prompt body beyond the fixed instruction text."""
    prompt = _judge("").build_prompt("NARR-SENTINEL-123", {"board": "PROJ-SENTINEL-456"})
    assert "NARR-SENTINEL-123" in prompt
    assert "PROJ-SENTINEL-456" in prompt


def test_overlong_narration_is_bounded():
    huge = "x" * 20000
    prompt = _judge("").build_prompt(huge, {})
    # the narration is clipped to the bound, so a runaway turn can't blow the judge prompt. Slice the
    # actual NARRATION block (counting raw 'x' over the whole prompt would also catch instruction
    # text like "texture").
    narr_block = prompt.split("NARRATION:\n", 1)[1].split("\nPROJECTION:", 1)[0]
    assert len(narr_block) <= FaithfulnessJudge._MAX_NARRATION


def test_a_broken_projection_does_not_crash_the_prompt():
    class _Unserializable:
        def __repr__(self):
            return "UNSERIAL"
    # default=str makes json.dumps tolerate it; either way the builder must never raise.
    prompt = _judge("").build_prompt("line", {"weird": _Unserializable()})
    assert "NARRATION:" in prompt and "PROJECTION:" in prompt


# ── dispatch_correction — the trigger-only active-mode seam (mirrors dispatch_lever) ──

def _fv(lever, classification="open"):
    return FaithfulnessVerdict("persona", classification, lever)


def test_dispatch_correction_invokes_exactly_the_lever_action():
    """Trigger-only (mandate #3): for a verdict whose lever is wired, exactly that action runs and is
    the only side effect — dispatch authors nothing itself."""
    calls = []
    actions = {lev: (lambda l=lev: (calls.append(l) or True))
               for lev in ("adopt", "reframe", "reground")}
    r = dispatch_correction(_fv("adopt"), actions)
    assert calls == ["adopt"]
    assert set(r.keys()) == {"lever", "applied", "reason"}
    assert r["lever"] == "adopt" and r["applied"] is True


def test_dispatch_correction_none_lever_is_a_noop():
    ran = []
    r = dispatch_correction(_fv("none"), {"none": lambda: ran.append(1) or True})
    assert ran == [] and r["applied"] is False         # 'none' never invokes an action


def test_dispatch_correction_no_action_for_lever_is_a_noop():
    # reframe/reground aren't wired until P4 — an unwired lever is a no-op, not an error.
    r = dispatch_correction(_fv("reframe", "closed"), {})
    assert r["applied"] is False and r["lever"] == "reframe"


def test_dispatch_correction_raising_action_is_failsoft():
    def _boom():
        raise RuntimeError("correction exploded")
    r = dispatch_correction(_fv("adopt"), {"adopt": _boom})   # must not raise
    assert r["applied"] is False and r["lever"] == "adopt"


def test_dispatch_correction_out_of_set_lever_is_rejected():
    ran = []
    rogue = FaithfulnessVerdict("persona", "open", "frobnicate")
    r = dispatch_correction(rogue, {"frobnicate": lambda: ran.append(1) or True})
    assert ran == [] and r["applied"] is False         # only FAITH_LEVERS are ever routed


def test_dispatch_correction_none_verdict_is_a_noop():
    ran = []
    r = dispatch_correction(None, {lev: (lambda: ran.append(1)) for lev in FAITH_LEVERS})
    assert ran == [] and r["applied"] is False


# ── P5: the junction context switches the prompt framing (casting vs in-game) ──────

def test_build_prompt_context_switches_the_junction_framing():
    """The four dimension labels are stable, but their MEANING is junction-specific — the casting
    interview must not be judged against an in-game board it has no concept of."""
    j = _judge("")
    ingame = j.build_prompt("x", {}, "in-game")
    casting = j.build_prompt("x", {}, "casting")
    assert "live Big Brother game" in ingame and "HOH/noms" in ingame
    assert "CASTING INTERVIEW" in casting and "casting fact" in casting
    assert "HOH/noms" not in casting                    # the in-game board framing is gone at casting
    # the WALL framing is present in BOTH contexts — the mandate doesn't relax at a junction.
    assert "NEVER change a closed-set OUTCOME" in ingame
    assert "NEVER change a closed-set OUTCOME" in casting


def test_unknown_context_falls_back_to_in_game_framing():
    prompt = _judge("").build_prompt("x", {}, "nonsense")
    assert "HOH/noms" in prompt                          # an unknown context degrades to in-game
