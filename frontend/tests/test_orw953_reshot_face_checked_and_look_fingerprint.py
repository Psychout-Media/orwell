"""ORW-953: (1) a face's staleness fingerprint is taken from the engine's `lookKey` (what changes how THIS person looks), so a changed prompt text (the dealt shot or face
card moved by another houseguest's repair) re-shoots nobody, a changed look still does, and a face stored under the old whole-prompt fingerprint is re-baselined quietly on
deploy; (2) a re-shot face whose check gives no verdict is looked at once more, and the skip line names the face. Invented ids, no names, no model calls."""
import asyncio
import importlib
import logging

import pytest

from tests.test_adr0013_backfill_gate import (  # noqa: F401  (the fixture and stubs the sweep tests use)
    _kick_reshoot, _run, _stub_gate, _stub_generate, _stub_provider, tmp_portraits)
from tests.test_orw384_photo_check import _entry, _reply, _store, env  # noqa: F401

P = importlib.import_module("src.orwell_portraits")
C = importlib.import_module("src.orwell_portrait_check")
E = importlib.import_module("src.orwell_engine")


def _stub_engine(monkeypatch, prompt, look):
    """The engine's reply: the prompt text and the look key move independently, as in production."""
    state = {"prompt": prompt, "look": look}

    async def fake_prompt(hid, user=None):
        return {"houseguestId": hid, "name": f"HG {hid}", "prompt": state["prompt"], "lookKey": state["look"]}

    async def fake_beat(hid, ref, user=None):
        return {"ok": True}
    monkeypatch.setattr(E, "get_portrait_prompt", fake_prompt)
    monkeypatch.setattr(E, "record_image_beat", fake_beat)
    return state


def _face(look_key, wording=None):
    P._write_portrait("u", "npc:3", b"LIVE-FACE", "HG npc:3", fingerprint=P._look_fingerprint({"lookKey": look_key}))
    if wording is not None:
        m = P.load_manifest("u")
        m["npc_3"]["promptWording"] = wording
        P._save_manifest("u", m)


def test_a_moved_shot_card_with_the_same_look_reshoots_nobody(tmp_portraits, monkeypatch):
    _stub_gate(monkeypatch, False)
    _stub_provider(monkeypatch, True)
    st = _stub_engine(monkeypatch, "prompt A", "look-1")
    calls = _stub_generate(monkeypatch)
    _face("look-1")
    st["prompt"] = "prompt B: another place, another light, another moment"   # another houseguest's repair shifted the cast deal
    _kick_reshoot("npc:3", "u")
    assert calls == [] and P.portrait_file("u", "npc:3").read_bytes() == b"LIVE-FACE"


def test_a_changed_look_still_reshoots(tmp_portraits, monkeypatch):
    _stub_gate(monkeypatch, False)
    _stub_provider(monkeypatch, True)
    st = _stub_engine(monkeypatch, "prompt A", "look-1")
    calls = _stub_generate(monkeypatch)
    _face("look-1")
    st["look"] = "look-2"
    _kick_reshoot("npc:3", "u")
    assert len(calls) == 1


def test_the_sweep_reshoots_nobody_when_only_prompts_moved(tmp_portraits, monkeypatch):
    _stub_provider(monkeypatch, True)
    st = _stub_engine(monkeypatch, "prompt A", "look-1")
    calls = _stub_generate(monkeypatch)
    _face("look-1")
    st["prompt"] = "prompt B"
    n = _run(P._heal_stale_authored_faces("u", [{"id": "npc:3", "name": "HG npc:3", "status": "active", "authored": True}]))
    assert n == 0 and calls == []
    st["look"] = "look-2"
    P._STALE_AUTHORED_SEEN.clear()
    n = _run(P._heal_stale_authored_faces("u", [{"id": "npc:3", "name": "HG npc:3", "status": "active", "authored": True}]))
    assert n == 1 and len(calls) == 1


def test_a_face_stored_under_the_old_whole_prompt_fingerprint_is_rebaselined_not_reshot(tmp_portraits, monkeypatch):
    """Deploy: every stored face carries a hash of the whole prompt and promptWording 4. None re-shoots; the first sweep stamps the look fingerprint."""
    _stub_gate(monkeypatch, False)
    _stub_provider(monkeypatch, True)
    _stub_engine(monkeypatch, "prompt A", "look-1")
    calls = _stub_generate(monkeypatch)
    P._write_portrait("u", "npc:3", b"LIVE-FACE", "HG npc:3", fingerprint=P._prompt_fingerprint("an older prompt text"))
    m = P.load_manifest("u")
    m["npc_3"]["promptWording"] = 4
    P._save_manifest("u", m)
    _kick_reshoot("npc:3", "u")
    assert calls == [] and P.portrait_file("u", "npc:3").read_bytes() == b"LIVE-FACE"
    base = P.load_manifest("u")["npc_3"]
    assert base["fingerprint"] == P._look_fingerprint({"lookKey": "look-1"}) and base["promptWording"] == P.PORTRAIT_WORDING == 5


def test_a_new_shoot_is_fingerprinted_by_the_look_key(tmp_portraits, monkeypatch):
    _stub_provider(monkeypatch, True)
    _stub_engine(monkeypatch, "prompt A", "look-1")
    _stub_generate(monkeypatch)
    _run(P.generate_and_store([{"houseguestId": "npc:3", "name": "HG npc:3", "prompt": "prompt A", "lookKey": "look-1"}], "u", record_beats=False))
    assert P.load_manifest("u")["npc_3"]["fingerprint"] == P._look_fingerprint({"lookKey": "look-1"})
    assert P._look_fingerprint({"lookKey": "look-1", "prompt": "x"}) == P._look_fingerprint({"lookKey": "look-1", "prompt": "y"})
    assert P._look_fingerprint({"prompt": "x"}) == P._prompt_fingerprint("x")      # an engine without a key: the prompt hash, as before


# ── (2) a re-shot face is always looked at again ─────────────────────────────────────────────────

def test_a_reshot_face_whose_check_times_out_gets_one_more_look(env, monkeypatch):
    env.replies = [_reply(["wrong-age"])]
    verdicts = [{"ok": False, "problems": ["wrong-age"]}, None, {"ok": True, "problems": []}]   # first look fails, the second look gives nothing, the retry passes

    async def look(png, facts, user):
        return verdicts.pop(0)
    monkeypatch.setattr(C, "check_portrait", look)
    _store()
    assert len(env.shots) == 2 and verdicts == []
    chk = P.load_manifest("u")[P._safe_id("npc:1")]["check"]
    assert chk["ok"] is True and chk["problems"] == [] and chk["reshot"] is True


def test_the_extra_look_is_bounded_and_the_check_stays_fail_open(env, monkeypatch):
    calls = []

    async def look(png, facts, user):
        calls.append(1)
        return {"ok": False, "problems": ["wrong-age"]} if len(calls) == 1 else None
    monkeypatch.setattr(C, "check_portrait", look)
    _store()
    assert len(calls) == 3                       # the first look, the second look, ONE retry: never a fourth
    assert len(env.shots) == 2                   # the photo is kept (fail open), no third shot
    assert P.portrait_file("u", "npc:1") is not None


def test_a_passed_second_look_makes_no_extra_call(env, monkeypatch):
    calls = []

    async def look(png, facts, user):
        calls.append(1)
        return {"ok": False, "problems": ["messy-hair"]} if len(calls) == 1 else {"ok": True, "problems": []}
    monkeypatch.setattr(C, "check_portrait", look)
    _store()
    assert len(calls) == 2


def test_the_skip_line_names_the_face(env, caplog):
    async def slow(*a, **k):
        await asyncio.sleep(5)
    C.CHECK_TIMEOUT_S, saved = 0.05, C.CHECK_TIMEOUT_S
    real = C._call
    C._call = slow
    token = P._CURRENT_HID.set("npc:14")
    try:
        with caplog.at_level(logging.INFO, logger=C.logger.name):
            assert _run(C.check_portrait(b"x", {}, "u")) is None
    finally:
        P._CURRENT_HID.reset(token)
        C.CHECK_TIMEOUT_S, C._call = saved, real
    assert any("[portrait-check] skipped: TimeoutError (npc:14)" in r.getMessage() for r in caplog.records)


def test_a_wrong_age_fix_line_states_the_age_as_a_number(env):
    env.replies = [_reply(["wrong-age"]), _reply([])]
    _store()
    fix = env.shots[1][0]
    assert "the stated age exactly, not older and not younger" in fix and fix.endswith("The person is exactly 35 years old.")
    assert "no printed words, logos or graphics on any clothing" in C.problems_in_words(["text-or-logo"])
