"""ORW-307 - the per-NPC scoped-call leak harness (ADR 0022 gates 3 and 5), applied first to the 0070 off-screen texture lane
(``src/orwell_offscreen_texture.py``), the one per-houseguest-pair model call that exists today. Roles only; no model."""
import asyncio

import pytest

from _npc_scope_harness import (Recorder, assert_call_inputs_scoped, assert_no_funnel_bleed, assert_output_is_data,
                                assert_planted_tokens_reached_their_owner, input_text)
from src import orwell_offscreen_texture as T

# Three off-screen scenes, each witnessed by a DIFFERENT pair; every template carries a sentinel only that pair may know.
SCENES = [
    {"eventId": "e1", "nature": "gossip", "participants": ["npc:1", "npc:2"], "templateContent": "pair-A talked SENTINEL-A", "producerNote": "VAULT-ONLY-1"},
    {"eventId": "e2", "nature": "scheme", "participants": ["npc:3", "npc:4"], "templateContent": "pair-B talked SENTINEL-B", "producerNote": "VAULT-ONLY-2"},
    {"eventId": "e3", "nature": "comfort", "participants": ["npc:5", "npc:6"], "templateContent": "pair-C talked SENTINEL-C", "producerNote": "VAULT-ONLY-3"},
]
TOKENS = {
    "SENTINEL-A": {"npc:1|npc:2"}, "SENTINEL-B": {"npc:3|npc:4"}, "SENTINEL-C": {"npc:5|npc:6"},
    "VAULT-ONLY-1": None, "VAULT-ONLY-2": None, "VAULT-ONLY-3": None,   # producer-only: in NO call
}
TEXTURE_SCHEMA = {"eventId": ("id",), "content": ("text",)}   # the write-back payload: an id and ONE declared, bounded line of text


def _pair_of(messages):
    """The scene key a texture call was built for, read from the prompt's own public participant ids."""
    ids = [w for w in input_text(messages).replace(",", " ").split() if w.startswith("npc:")]
    return "|".join(sorted(set(ids)))


async def _tick(llm, builder=None):
    writes = []

    async def skeletons():
        return [dict(s) for s in SCENES]

    async def write(event_id, content):
        writes.append({"eventId": event_id, "content": content})
        return {"ok": True}

    if builder is not None:
        orig = T._voicing_messages
        T._voicing_messages = builder
    try:
        await T.enrich_tick(skeletons, llm, write)
    finally:
        if builder is not None:
            T._voicing_messages = orig
    return writes


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_texture_calls_carry_only_their_own_scene_and_no_producer_token():
    rec = Recorder(npc_of=_pair_of, reply=lambda m: "The two houseguests traded a wary look by the counter.")
    _run(_tick(rec))
    assert len(rec.calls) == 3
    assert_planted_tokens_reached_their_owner(rec.calls, TOKENS)   # positive control: the scenes really were voiced
    assert_call_inputs_scoped(rec.calls, TOKENS)


def test_texture_write_back_payload_is_the_declared_data_shape():
    rec = Recorder(npc_of=_pair_of, reply=lambda m: "A short, ambiguous beat between two houseguests.")
    writes = _run(_tick(rec))
    assert len(writes) == 3
    for w in writes:
        assert_output_is_data(w, TEXTURE_SCHEMA)


# ── mutation proofs: the harness must go RED on the leaks it exists to catch ─────────────────────────────────────

def test_mutation_a_builder_that_includes_another_scenes_content_goes_red():
    orig = T._voicing_messages

    def leaky(nature, participants, template, zeitgeist=""):
        msgs = orig(nature, participants, template, zeitgeist)
        msgs[1]["content"] += "\nAlso: " + SCENES[1]["templateContent"]       # pair B's scene leaks into EVERY call
        return msgs

    rec = Recorder(npc_of=_pair_of)
    _run(_tick(rec, builder=leaky))
    with pytest.raises(AssertionError, match="SENTINEL-B"):
        assert_call_inputs_scoped(rec.calls, TOKENS)


def test_mutation_a_builder_that_carries_a_producer_only_field_goes_red():
    orig = T._voicing_messages

    def leaky(nature, participants, template, zeitgeist=""):
        msgs = orig(nature, participants, template, zeitgeist)
        msgs[0]["content"] += " VAULT-ONLY-2"
        return msgs

    rec = Recorder(npc_of=_pair_of)
    _run(_tick(rec, builder=leaky))
    with pytest.raises(AssertionError, match="producer-only"):
        assert_call_inputs_scoped(rec.calls, TOKENS)


def test_mutation_an_extra_prose_field_in_the_output_goes_red():
    with pytest.raises(AssertionError, match="undeclared fields"):
        assert_output_is_data({"eventId": "e1", "content": "ok", "narration": "She said she would never vote him out."}, TEXTURE_SCHEMA)


def test_a_strict_cognition_call_may_emit_no_prose_at_all():
    cognition = {"want": ("enum", {"ally", "target", "hide"}), "toward": ("id",), "urgency": float}
    assert_output_is_data('{"want": "target", "toward": "npc:4", "urgency": 0.6}', cognition, strict=True)
    with pytest.raises(AssertionError, match="not one of"):
        assert_output_is_data({"want": "I will quietly put him on the block", "toward": "npc:4"}, cognition, strict=True)
    with pytest.raises(AssertionError, match="strict"):
        assert_output_is_data({"why": "text"}, {"why": ("text",)}, strict=True)


def test_funnel_bleed_a_token_private_to_one_npc_stays_in_that_npcs_line():
    private = {"RESIDUAL-B": "npc:B"}
    assert_no_funnel_bleed(private, {"npc:A": "A speaks plainly.", "npc:B": "B hints at RESIDUAL-B."}, ["The house falls quiet."])
    with pytest.raises(AssertionError, match="bled into"):
        assert_no_funnel_bleed(private, {"npc:A": "A says RESIDUAL-B aloud.", "npc:B": "B."}, ["x"])
    with pytest.raises(AssertionError, match="player-visible"):
        assert_no_funnel_bleed(private, {"npc:A": "A.", "npc:B": "B."}, ["Narration: RESIDUAL-B"])


def test_the_harness_refuses_to_pass_vacuously():
    with pytest.raises(AssertionError, match="no per-NPC calls"):
        assert_call_inputs_scoped([], TOKENS)
