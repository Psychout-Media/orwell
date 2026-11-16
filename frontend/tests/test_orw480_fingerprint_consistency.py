"""ORW-480: with the authored shot briefs on, a face is stored with the fingerprint of the ENGINE's prompt (what the staleness sweeps compare), never of the briefed one,
so a sweep after a briefed shoot re-shoots nothing. A face shot before the shot-card wording is never a fingerprint re-shoot either."""
import asyncio
import importlib

import pytest

from tests.test_adr0013_backfill_gate import (  # noqa: F401  (the fixture and the stubs are the same ones the sweep tests use)
    _kick_reshoot, _run, _stub_gate, _stub_generate, _stub_prompts, _stub_provider, tmp_portraits)

orwell_portraits = importlib.import_module("src.orwell_portraits")
PB = importlib.import_module("src.orwell_photo_brief")


def test_a_sweep_after_a_briefed_shoot_reshoots_nothing(tmp_portraits, monkeypatch):
    _stub_gate(monkeypatch, False)
    _stub_provider(monkeypatch, True)
    _stub_prompts(monkeypatch)                                   # the engine's prompt for npc:1 is "photoreal npc:1"
    calls = _stub_generate(monkeypatch)
    monkeypatch.setattr(PB, "brief_enabled", lambda user: True)

    async def briefed(prompts, user, **k):
        return [{**e, "prompt": "BRIEFED " + e["prompt"], "enginePrompt": e["prompt"]} for e in prompts]
    monkeypatch.setattr(PB, "apply_briefs", briefed)

    _run(orwell_portraits.generate_and_store([{"houseguestId": "npc:1", "name": "HG npc:1", "prompt": "photoreal npc:1"}], "u", record_beats=False))
    assert calls == ["BRIEFED photoreal npc:1"]                                  # the image was shot from the briefed prompt
    stored = orwell_portraits.load_manifest("u")["npc_1"]
    assert stored["fingerprint"] == orwell_portraits._prompt_fingerprint("photoreal npc:1")   # ... and fingerprinted by the engine's own

    _kick_reshoot("npc:1", "u")                                                  # the authored heal compares with the engine's prompt
    assert len(calls) == 1
    assert orwell_portraits.portrait_file("u", "npc:1") is not None


def test_a_face_shot_before_the_shot_card_wording_is_rebaselined_quietly_then_an_edit_reshoots(tmp_portraits, monkeypatch):
    _stub_gate(monkeypatch, False)
    _stub_provider(monkeypatch, True)
    _stub_prompts(monkeypatch, suffix=" NEW WORDING")                            # today's prompt differs from the one the face was shot with
    calls = _stub_generate(monkeypatch)
    orwell_portraits._write_portrait("u", "npc:1", b"LIVE-FACE", "HG npc:1", fingerprint=orwell_portraits._prompt_fingerprint("photoreal npc:1"))
    m = orwell_portraits.load_manifest("u")
    m["npc_1"].pop("promptWording")                                              # a face shot before the wording was recorded
    orwell_portraits._save_manifest("u", m)
    _kick_reshoot("npc:1", "u")
    assert calls == [] and orwell_portraits.portrait_file("u", "npc:1").read_bytes() == b"LIVE-FACE"
    assert orwell_portraits.PORTRAIT_PROMPT_VERSION == 3                          # no version bump: the upgrader lists no live face
    assert orwell_portraits.stale_portrait_ids(orwell_portraits.load_manifest("u")) == []
    # the first sweep took today's engine prompt as the baseline (stamped with the wording), image untouched
    base = orwell_portraits.load_manifest("u")["npc_1"]
    assert base["fingerprint"] == orwell_portraits._prompt_fingerprint("photoreal npc:1 NEW WORDING") and base["promptWording"] == orwell_portraits.PORTRAIT_WORDING
    _kick_reshoot("npc:1", "u")
    assert calls == []                                                           # an unchanged card after the baseline re-shoots nothing
    # the look is then edited: the engine's prompt changes, so the sweep re-shoots from it
    _stub_prompts(monkeypatch, suffix=" EDITED LOOK")
    _kick_reshoot("npc:1", "u")
    assert calls and "EDITED LOOK" in calls[0]


def test_a_task_never_borrows_another_tasks_provider(monkeypatch):
    monkeypatch.setattr(orwell_portraits, "_LAST_PROVIDER", {"model": "other-task", "route": "gemini-fallback"})

    async def inside():
        return orwell_portraits._peek_gen_provider()
    assert asyncio.get_event_loop().run_until_complete(asyncio.ensure_future(inside())) is None
