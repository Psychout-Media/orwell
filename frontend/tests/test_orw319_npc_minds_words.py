"""ORW-319 (ORW-253 slice 5, spec docs/features/0146 lanes 1-2): the model's cast-time words.

Ryne 2026-11-12 (answer 2): a failed model call is retried ONCE, then the item is skipped with an admin alert; the engine's own version
stands. Each lane-1 call sees ONE houseguest's PUBLIC profile only. Injected fakes; no live model. Roles only.
"""
import asyncio
import json

from src import orwell_npc_minds_words as w

CARD_A = {"id": "npc:1", "name": "Houseguest A", "vocation": "ER nurse", "biography": "ran marathons", "archetype": "comp-beast",
          "soul": {"emotionalState": 0.2}, "hiddenElements": [{"kind": "secret-motive", "detail": "zzsecretzz"}], "trust": 0.9}
CARD_B = {"id": "npc:2", "name": "Houseguest B", "vocation": "chef", "demeanor": "deadpan"}
GOOD = json.dumps({"habits": ["gym-rat", "early-riser"], "aimHint": "win-by-comps", "aimWhy": "a former sprinter"})


def run(coro):
    return asyncio.run(coro)


def test_public_card_carries_only_public_facets():
    card = w.public_card(CARD_A)
    assert set(card) <= set(w.PUBLIC_KEYS)
    blob = json.dumps(card)
    assert "zzsecretzz" not in blob and "emotionalState" not in blob and "npc:1" not in blob and "0.9" not in blob


def test_each_traits_call_sees_one_houseguest_only():
    seen = []

    async def llm(msgs):
        seen.append(json.dumps(msgs))
        return GOOD

    async def write(req):
        return {"accepted": len(req["traits"]), "rejected": 0}

    out = run(w.author_traits([CARD_A, CARD_B], llm, write))
    assert out == {"accepted": 2, "rejected": 0, "skipped": []}
    assert len(seen) == 2
    assert "ER nurse" in seen[0] and "chef" not in seen[0]
    assert "chef" in seen[1] and "ER nurse" not in seen[1]
    assert all("zzsecretzz" not in s for s in seen)


def test_a_failure_is_retried_once_then_skipped():
    calls = {"n": 0}

    async def flaky(msgs):
        calls["n"] += 1
        return "not json" if calls["n"] == 1 else GOOD

    written = []

    async def write(req):
        written.append(req)
        return {"accepted": len(req["traits"]), "rejected": 0}

    out = run(w.author_traits([CARD_A], flaky, write))
    assert calls["n"] == 2 and out["accepted"] == 1 and out["skipped"] == []

    calls["n"] = 0

    async def broken(msgs):
        calls["n"] += 1
        raise RuntimeError("provider down")

    out = run(w.author_traits([CARD_A], broken, write))
    assert calls["n"] == 2, "exactly one retry"
    assert out["skipped"] == ["npc:1"]


def test_parse_traits_drops_unknown_values():
    assert w.parse_traits('{"habits":["gym-rat","flying"]}') is None
    assert w.parse_traits('noise {"habits":["gym-rat","napper","devout","night-owl"],"aimHint":"revenge"} tail') == {"habits": ["gym-rat", "napper", "devout"]}


def test_culture_retry_skip_and_parse():
    calls = {"n": 0}

    async def llm(msgs):
        calls["n"] += 1
        assert "zzsecretzz" not in json.dumps(msgs)
        return json.dumps({"spots": [{"room": "backyard", "nickname": "the Deck"}, {"room": "mars", "nickname": "x"}],
                           "rituals": [{"timeOfDay": "evening", "action": "cook", "name": "Family Dinner"},
                                       {"timeOfDay": "evening", "action": "frame", "name": "plot"}],
                           "runningJoke": "the missing spatula"})

    sent = []

    async def write(req):
        sent.append(req)
        return {"accepted": True}

    assert run(w.author_culture([CARD_A, CARD_B], llm, write)) == {"accepted": True}
    assert sent[0]["spots"] == [{"room": "backyard", "nickname": "the Deck"}]
    assert [r["action"] for r in sent[0]["rituals"]] == ["cook"]

    async def bad(msgs):
        calls["n"] += 1
        return "no"

    calls["n"] = 0
    assert run(w.author_culture([CARD_A], bad, write)) == {"accepted": False, "reason": "skipped"}
    assert calls["n"] == 2


def test_skips_raise_an_admin_alert(monkeypatch):
    alerts = []
    monkeypatch.setattr(w, "_alert", lambda owner, key, what: alerts.append(key))

    async def resolve(owner):
        async def bad(msgs):
            raise RuntimeError("down")
        return bad

    async def state(user=None):
        return {"house": [CARD_A, {**CARD_B, "isPlayer": True}]}

    import src.orwell_cast_authoring as ca
    import src.orwell_engine as eng
    monkeypatch.setattr(ca, "_resolve_llm_fn", resolve)
    monkeypatch.setattr(eng, "get_game_state", state)
    out = run(w.run_words("u1"))
    assert out["traits"]["skipped"] == ["npc:1"], "the player's card is never sent"
    assert "npc-minds:traits-skipped" in alerts and "npc-minds:culture-skipped" in alerts


def test_no_model_alerts_once_and_changes_nothing(monkeypatch):
    alerts = []
    monkeypatch.setattr(w, "_alert", lambda owner, key, what: alerts.append(key))

    async def resolve(owner):
        return None

    import src.orwell_cast_authoring as ca
    monkeypatch.setattr(ca, "_resolve_llm_fn", resolve)
    assert run(w.run_words("u2"))["reason"] == "no-model"
    assert alerts == ["npc-minds:no-model"]


def test_kicked_from_a_genuine_season_start():
    src = open("src/tool_implementations.py", encoding="utf-8").read()
    assert src.count("orwell_npc_minds_words.kickoff_npc_minds_words(owner)") == 2, "both the normal start and the deferred gate-clear start"
