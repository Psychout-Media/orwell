"""Issue #1626 (increment 3, FE lane) — the producer-persona deepening driver.

The orchestrator (`author_producer`) takes INJECTED llm + write functions, so the whole lane is
testable without a live model or engine (mirrors `test_0062_zeitgeist_capture` /
`test_l28b_cast_authoring`). We pin: the producer prompt, the tolerant JSON parser (open-set keys
only, name NEVER forwarded), the orchestration (writes the overlay, one strict-JSON reparse,
best-effort/fail-soft), and the live wiring — no model ⇒ NO write-back (the seeded floor stands),
a stub model ⇒ `record_producer_profile` called with the synthesized Vault-free overlay.
"""
import asyncio
import json

from conftest import _run
from src import orwell_producer_authoring as P


_FULL = {
    "archetype": "world-weary casting savant",
    "demeanor": "clipped, unhurried, faintly amused",
    "disposition": "reads a room for the crack in every confident smile",
    "wit": "dry, surgical, never cruel for its own sake",
    "quirk": "always circles back to a candidate's very first small lie",
    "backstory": (
        "Two decades behind the one-way glass of a hundred casting calls left this producer able to "
        "spot a fraud from the doorway. They started as a runner and never left the room."),
    "name": "Should Be Ignored Name",   # the byline is seeded + immovable — must be DROPPED
    "physical": "6.5 stats",             # a forbidden Vault-ish key — must be DROPPED (unknown key)
}


# ── the prompt ─────────────────────────────────────────────────────────────────

def test_prompt_is_producer_framed_and_authors_no_name():
    msgs = P.build_authoring_messages()
    assert msgs[0]["role"] == "system"
    system = msgs[0]["content"]
    assert "PRODUCER" in system
    assert "JSON" in system
    # every open-set field the engine accepts is named for the model
    for key in ("archetype", "demeanor", "disposition", "wit", "quirk", "backstory"):
        assert key in system
    # NO name / NO stats / NO numbers are to be authored (the byline is seeded + immovable)
    low = system.lower()
    assert "no name" in low or "no stats" in low


def test_prompt_seeds_from_the_producer_skeleton_without_letting_the_name_change():
    msgs = P.build_authoring_messages({"name": "Seeded Byline", "archetype": "sardonic"})
    user = msgs[1]["content"]
    assert "Seeded Byline" in user           # seeded name handed over as the brief
    assert "never change the name" in user.lower()


# ── the parser: open-set keys only, name never forwarded ─────────────────────────

def test_parse_keeps_open_set_fields_and_drops_name_and_unknown_keys():
    out = P.parse_authored_producer(json.dumps(_FULL))
    assert set(out) == {"archetype", "demeanor", "disposition", "wit", "quirk", "backstory"}
    assert "name" not in out          # the byline stays seeded — NEVER authored
    assert "physical" not in out      # unknown key dropped
    assert out["archetype"] == "world-weary casting savant"


def test_parse_extracts_json_from_surrounding_prose():
    text = "Here is the producer: {\"quirk\": \"hums old game-show themes between questions\"} — enjoy!"
    out = P.parse_authored_producer(text)
    assert out == {"quirk": "hums old game-show themes between questions"}


def test_parse_drops_trivially_short_fields_so_the_seeded_floor_stands():
    # each below its floor (backstory needs >= 40 chars; others >= 8) ⇒ nothing usable ⇒ {}
    out = P.parse_authored_producer(json.dumps({"quirk": "wry", "backstory": "short."}))
    assert out == {}


def test_parse_returns_empty_on_junk():
    assert P.parse_authored_producer("no json at all") == {}
    assert P.parse_authored_producer("") == {}
    assert P.parse_authored_producer('{"name": "Only A Name"}') == {}   # name alone ⇒ nothing to write


# ── author_producer orchestration (injected fakes) ───────────────────────────────

def _fakes(llm_text):
    seen = {}

    async def llm_fn(messages):
        seen["messages"] = messages
        return llm_text

    async def write_fn(overlay):
        seen["overlay"] = overlay
        return {"accepted": True, "fields": sorted(overlay)}

    return llm_fn, write_fn, seen


def test_author_producer_writes_back_the_overlay():
    llm_fn, write_fn, seen = _fakes(json.dumps(_FULL))
    res = _run(P.author_producer(llm_fn, write_fn))
    assert res["accepted"] is True
    overlay = seen["overlay"]
    assert "name" not in overlay
    assert overlay["backstory"].startswith("Two decades")
    assert set(overlay) == {"archetype", "demeanor", "disposition", "wit", "quirk", "backstory"}


def test_author_producer_retries_once_on_prose_then_writes():
    replies = ["I think the producer is a great character, but here is no object.",
               json.dumps({"quirk": "always circles back to a candidate's first small lie"})]

    async def llm_fn(messages):
        return replies.pop(0)

    written = {}

    async def write_fn(overlay):
        written["overlay"] = overlay
        return {"accepted": True, "fields": sorted(overlay)}

    res = _run(P.author_producer(llm_fn, write_fn))
    assert res["accepted"] is True
    assert written["overlay"]["quirk"].startswith("always circles back")
    assert replies == []  # both the first call and the strict-JSON reparse fired


def test_author_producer_skips_write_when_nothing_usable_authored():
    async def llm_fn(messages):
        return "the model rambled and produced no JSON"

    async def write_fn(overlay):  # pragma: no cover - must never be called
        raise AssertionError("must not write when nothing parsed")

    res = _run(P.author_producer(llm_fn, write_fn))
    assert res["accepted"] is False and res["reason"] == "no-fields"


def test_author_producer_is_graceful_when_the_model_fails():
    async def llm_fn(messages):
        raise RuntimeError("model down")

    calls = []

    async def write_fn(overlay):
        calls.append(overlay)
        return {"accepted": True}

    res = _run(P.author_producer(llm_fn, write_fn))
    assert res["accepted"] is False and res["reason"] == "llm-failed"
    assert calls == []  # never wrote ⇒ the seeded floor stands


def test_author_producer_is_graceful_when_the_write_back_fails():
    async def llm_fn(messages):
        return json.dumps(_FULL)

    async def write_fn(overlay):
        raise RuntimeError("engine 409")

    res = _run(P.author_producer(llm_fn, write_fn))
    assert res["accepted"] is False and res["reason"] == "write-failed"


# ── the live wiring (no model ⇒ no write; stub model ⇒ record_producer_profile) ───

def test_run_authoring_no_model_makes_no_write_back(monkeypatch):
    async def _no_model(owner):
        return None
    monkeypatch.setattr("src.orwell_cast_authoring._resolve_llm_fn", _no_model)

    async def _must_not_write(overlay, user=None):  # pragma: no cover - must never be called
        raise AssertionError("no model ⇒ the seeded floor stands, no write-back")
    monkeypatch.setattr("src.orwell_engine.record_producer_profile", _must_not_write)

    res = _run(P.run_authoring("user-nomodel"))
    assert res["accepted"] is False and res["reason"] == "no-model"


def test_run_authoring_is_fail_soft_when_the_resolver_raises(monkeypatch):
    # A resolver/config error must NOT escape run_authoring (it promises never to raise) and must be
    # surfaced as a DISTINCT "resolver-failed" reason — never mislabeled the expected "no-model" (#1599).
    async def _boom(owner):
        raise RuntimeError("endpoint config exploded")
    monkeypatch.setattr("src.orwell_cast_authoring._resolve_llm_fn", _boom)

    async def _must_not_write(overlay, user=None):  # pragma: no cover - resolver died, no write-back
        raise AssertionError("resolver failed ⇒ no write-back")
    monkeypatch.setattr("src.orwell_engine.record_producer_profile", _must_not_write)

    res = _run(P.run_authoring("user-boom"))  # does not raise
    assert res["accepted"] is False and res["reason"] == "resolver-failed"


def test_run_authoring_with_a_stub_model_writes_the_vault_free_overlay(monkeypatch):
    async def _stub_llm(messages):
        return json.dumps(_FULL)

    async def _resolve(owner):
        return _stub_llm
    monkeypatch.setattr("src.orwell_cast_authoring._resolve_llm_fn", _resolve)

    captured = {}

    async def _capture(overlay, user=None):
        captured["overlay"] = overlay
        captured["user"] = user
        return {"accepted": True, "fields": sorted(overlay)}
    monkeypatch.setattr("src.orwell_engine.record_producer_profile", _capture)

    res = _run(P.run_authoring("user-stub"))
    assert res["accepted"] is True
    overlay = captured["overlay"]
    assert "name" not in overlay          # the byline is never authored
    assert captured["user"] == "user-stub"
    # the synthesized overlay is Vault-free open-set prose only
    assert set(overlay) == {"archetype", "demeanor", "disposition", "wit", "quirk", "backstory"}


# ── the kickoff never raises + the engine wrapper exists ─────────────────────────

def test_kickoff_runs_the_driver_and_never_raises(monkeypatch):
    ran = {}

    async def _run_authoring(owner):
        ran["owner"] = owner
        return {"accepted": True}
    monkeypatch.setattr(P, "run_authoring", _run_authoring)
    try:
        # No running loop here ⇒ kickoff runs the background task to completion synchronously.
        P.kickoff_producer_authoring("user-kick")
        assert ran.get("owner") == "user-kick"
        assert "user-kick" not in P._IN_FLIGHT  # the in-flight guard is released
    finally:
        # kickoff's no-running-loop path uses `asyncio.run()`, which CLOSES the main-thread event loop
        # (exactly the hazard conftest._run guards against). Restore a fresh OPEN loop so this test can
        # never poison a sibling test that later calls `asyncio.get_event_loop()` (mirrors conftest._run).
        asyncio.set_event_loop(asyncio.new_event_loop())


def test_engine_client_method_exists():
    from src import orwell_engine
    assert hasattr(orwell_engine, "record_producer_profile")


# ORW-511: the random anchors are letters on their own seeded stream, so the same seed gives the same prompt and different seeds give different ones.
def test_orw511_anchors_are_seeded_letters_not_a_menu():
    from src.orwell_producer_authoring import build_authoring_messages, producer_anchors
    assert producer_anchors(None) == ""
    assert producer_anchors(7) == producer_anchors(7)
    assert len({producer_anchors(s) for s in range(200)}) > 100
    assert not any(ch.isdigit() for ch in producer_anchors(7))
    a = build_authoring_messages(None, 7)[1]["content"]
    assert "begins with" in a and build_authoring_messages(None, None)[1]["content"].startswith("Write the producer")
