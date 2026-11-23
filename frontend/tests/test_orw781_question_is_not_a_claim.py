"""ORW-781 - a question the player asks is never logged as a claim the player made; a declarative statement still is.

Real belt path (`_auto_record_scene`) with the model extraction stubbed; the engine write is observed. Roles only."""
import asyncio
import importlib
import json

al = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")

ROSTER = [{"id": f"npc:{n}", "name": f"Houseguest {n}"} for n in range(1, 5)]
IDS = [h["id"] for h in ROSTER]
STATEMENT = {"to": "npc:1", "about": "npc:2", "kind": "going-after", "object": "npc:3"}


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


class _Env:
    def __init__(self, monkeypatch):
        self.writes = []
        monkeypatch.setattr(oe, "_RETRY_ATTEMPTS", 0)

        async def whereabouts(user=None):
            return {"room": "kitchen", "present": [{"id": i} for i in IDS]}

        async def state(owner=None, **k):
            return {"asleep": [], "pending": None}

        async def backfill(owner, fn, *args, **kw):
            self.writes.append(kw)
            return {"ok": True}

        monkeypatch.setattr(oe, "whereabouts", whereabouts)
        monkeypatch.setattr(oe, "get_game_state", state)
        monkeypatch.setattr(al, "_backfill_with_cas", backfill)
        monkeypatch.setattr(al, "_note_belt", lambda owner, belt, n=1: None)

    def record(self, said):
        obj = {"withIds": ["npc:1"], "kind": "strategy", "content": "The player and a houseguest talked.", "feltMinutes": 30, "statement": dict(STATEMENT)}
        return _run(al._auto_record_scene("They talked.", said, ROSTER, "http://x", "m", {}, "o", raw=json.dumps(obj)))


def test_a_question_is_never_a_claim_but_the_scene_still_records(monkeypatch):
    env = _Env(monkeypatch)
    assert env.record("Is Houseguest 2 after Houseguest 3? Who told you that?") is True
    assert len(env.writes) == 1 and "statement" not in env.writes[0]


def test_a_declarative_lie_is_still_recorded(monkeypatch):
    env = _Env(monkeypatch)
    assert env.record("Houseguest 2 is going after Houseguest 3, trust me.") is True
    assert env.writes[0]["statement"] == STATEMENT


def test_a_message_with_a_statement_and_a_question_keeps_the_claim(monkeypatch):
    env = _Env(monkeypatch)
    assert env.record("Houseguest 2 is going after Houseguest 3. Did you know that?") is True
    assert env.writes[0]["statement"] == STATEMENT
