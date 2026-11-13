"""ORW-223 part C, slice C5 - the deterministic gate on the scene extraction BEFORE it is recorded (the C1 checker, no model call).

It only TRIMS: an absent / sleeping / unknown participant leaves the scene, a record with no NPC left is dropped, a closed-set claim
leaves the free text; a clean extraction is recorded byte-identically. Stubbed llm and engine, roles only.
"""
import asyncio
import importlib
import json

import pytest

al = importlib.import_module("src.agent_loop")
llm_core = importlib.import_module("src.llm_core")
oe = importlib.import_module("src.orwell_engine")
sp = importlib.import_module("src.orwell_scene_plan")

ROSTER = [{"id": f"npc:{n}", "name": f"Houseguest {n}"} for n in range(1, 7)]


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


class Env:
    def __init__(self, monkeypatch, *, present=None, asleep=(), pending=None, state_error=False, gate=True):
        self.writes, self.belts = [], []
        present = [h["id"] for h in ROSTER] if present is None else present
        monkeypatch.setattr(oe, "_RETRY_ATTEMPTS", 0)

        async def whereabouts(user=None):
            return {"room": "kitchen", "present": [{"id": i} for i in present]}

        async def state(owner=None, **k):
            if state_error:
                raise RuntimeError("engine down")
            return {"asleep": [{"id": i, "name": "x"} for i in asleep], "pending": pending}

        async def backfill(owner, fn, *args, **kw):
            kw = {k: v for k, v in kw.items() if k != "idempotency_key"}
            self.writes.append((args, kw))
            return {"ok": True}

        monkeypatch.setattr(oe, "whereabouts", whereabouts)
        monkeypatch.setattr(oe, "get_game_state", state)
        monkeypatch.setattr(al, "_backfill_with_cas", backfill)
        monkeypatch.setattr(al, "_note_belt", lambda owner, belt, n=1: self.belts.append(belt))
        if not gate:
            async def nogate(*a, **k):
                return None
            monkeypatch.setattr(al, "_scene_check_gate", nogate)

    def record(self, obj, last_user="I talk to them in the kitchen."):
        raw = json.dumps(obj)
        ok = _run(al._auto_record_scene("They talked.", last_user, ROSTER, "http://x", "m", {}, "o", raw=raw))
        return ok


def clean(**over):
    o = {"withIds": ["npc:1"], "kind": "bonding", "content": "They compared notes about the week.", "feltMinutes": 45}
    o.update(over)
    return o


# A corpus of realistic extraction outputs: every shape the instruction block allows. None names a closed-set outcome.
CORPUS = [
    clean(),
    clean(withIds=["npc:1", "npc:2"], kind="strategy", content="The player floated a two-person plan and both listened."),
    clean(kind="alliance", content="They agreed to look out for each other."),
    clean(kind="conflict", content="A sharp exchange about who ate the last of the food."),
    clean(kind="gossip", content="The houseguest shared a rumor about the others.", feltMinutes=20),
    clean(kind="showmance", content="Late talk on the couch, close and quiet."),
    clean(kind="betrayal", content="The player admitted going back on a promise.", feltMinutes=90),
    clean(content="  Padded   text\nwith  odd   whitespace. "),
    clean(content=""),
    clean(content="They talked, and the player argued the case and won her over."),
    clean(withIds=[2], kind="bonding"),
    clean(withIds=["3", "npc:4"], kind="gossip"),
    clean(kind="unknown-kind"),
    clean(feltMinutes=None),
    clean(feltMinutes=240),
    clean(consequence={"edges": [{"toward": "npc:1", "direction": "warmer", "emphasis": "notable"}], "rationale": "The player was kind to them."}),
    clean(withIds=["npc:1", "npc:2"], consequence={"edges": [{"toward": "npc:1", "direction": "more-trust"},
                                                              {"toward": "npc:2", "direction": "more-threatened", "emphasis": "strong"}],
                                                   "rationale": "Warm to one, a threat to the other."}),
    clean(withIds=["npc:1"], consequence={"aboutEdges": [{"holder": "npc:1", "about": "npc:5", "direction": "more-threatened", "emphasis": "slight"}],
                                          "rationale": "The player pitched the third houseguest as the real threat."}),
    clean(withIds=["npc:1", "npc:2"], consequence={"edges": [{"toward": "npc:2", "direction": "cooler"}],
                                                   "aboutEdges": [{"holder": "npc:1", "about": "npc:2", "direction": "less-aligned"}]}),
    clean(consequence={"edges": [{"toward": "npc:3", "direction": "warmer"}]}),  # edge toward a present NPC not in withIds
    clean(assurance={"kind": "safe", "by": "player"}),
    clean(assurance={"kind": "vote", "by": "npc:1"}),
    clean(heardAboutMe={"nature": "targeting", "by": "npc:1"}),
    clean(withIds=["npc:1", "npc:2", "npc:3"], kind="alliance", content="A three-way huddle about trust.",
          consequence={"edges": [{"toward": "npc:1", "direction": "more-aligned"}, {"toward": "npc:2", "direction": "more-aligned"},
                                 {"toward": "npc:3", "direction": "less-trust", "emphasis": "slight"}], "rationale": "Two in, one doubtful."}),
    clean(content="The player asked who they trusted and the houseguest named the HOH as a worry."),  # the HOH is a role, not an outcome
    clean(content="They talked about how the competition might go next week."),
    clean(content="They wondered aloud who might get nominated."),  # speculation about an outcome is texture, kept
    clean(content="She was afraid she would be nominated and asked for the player's help."),
    clean(content="The player lied about the veto, then smoothed it over."),
    clean(withIds=["npc:6"], kind="strategy"),
    clean(withIds=["npc:5", "npc:6"], kind="bonding", content="A quiet moment by the sink."),
    clean(content="x" * 700),
]


def _args(env):
    return env.writes


def test_corpus_size_is_meaningful():
    assert len(CORPUS) >= 30


@pytest.mark.parametrize("idx", range(len(CORPUS)))
def test_a_clean_extraction_is_recorded_byte_identically_with_and_without_the_gate(monkeypatch, idx):
    with_gate = Env(monkeypatch)
    assert with_gate.record(CORPUS[idx]) is True
    monkeypatch.undo()
    no_gate = Env(monkeypatch, gate=False)
    assert no_gate.record(CORPUS[idx]) is True
    assert _args(with_gate) == _args(no_gate) and len(_args(no_gate)) == 1
    assert with_gate.belts == []  # nothing trimmed => no belt count


def test_an_absent_participant_is_trimmed_and_the_rest_recorded(monkeypatch):
    env = Env(monkeypatch, present=["npc:1", "npc:2"])
    assert env.record(clean(withIds=["npc:1", "npc:2"])) is True
    assert env.writes[0][1]["with_ids"] == ["npc:1", "npc:2"]
    env = Env(monkeypatch, present=["npc:1", "npc:2"], asleep=["npc:2"])
    assert env.record(clean(withIds=["npc:1", "npc:2"])) is True
    assert env.writes[0][1]["with_ids"] == ["npc:1"]
    assert env.belts == ["scene-check-trim"]


def test_a_sleeping_participant_is_trimmed_even_when_the_whereabouts_still_lists_them(monkeypatch):
    env = Env(monkeypatch, asleep=["npc:1"])
    assert env.record(clean(withIds=["npc:1", "npc:2"], consequence={"edges": [
        {"toward": "npc:1", "direction": "warmer"}, {"toward": "npc:2", "direction": "warmer"}], "rationale": "kind"})) is True
    kw = env.writes[0][1]
    assert kw["with_ids"] == ["npc:2"]
    assert kw["consequence"]["edges"] == [{"toward": "npc:2", "direction": "warmer"}]
    assert kw["consequence"]["rationale"] == "kind"


def test_an_unknown_participant_never_reaches_a_record_through_the_gate(monkeypatch):
    # the normalizer already rejects an id outside the roster; the gate is the second wall for an edge that names one
    env = Env(monkeypatch)
    gate = _run(al._scene_check_gate("o", ["npc:1"], "bonding", "c", {"edges": [{"toward": "npc:99", "direction": "warmer"}]},
                                     {"npc:1"}, {"npc:1"}, "u"))
    assert gate.consequence is None and gate.trimmed and "unknown-id" in gate.codes


def test_an_edge_toward_an_absent_houseguest_is_trimmed_but_the_record_stands(monkeypatch):
    env = Env(monkeypatch, present=["npc:1"])
    cons = {"edges": [{"toward": "npc:1", "direction": "warmer"}, {"toward": "npc:4", "direction": "cooler"}],
            "aboutEdges": [{"holder": "npc:4", "about": "npc:1", "direction": "more-trust"}]}
    assert env.record(clean(consequence=cons)) is True
    assert env.writes[0][1]["consequence"] == {"edges": [{"toward": "npc:1", "direction": "warmer"}]}
    assert env.belts == ["scene-check-trim"]


def test_a_record_left_with_no_npc_is_dropped_and_counted(monkeypatch):
    env = Env(monkeypatch, asleep=["npc:1", "npc:2"])
    assert env.record(clean(withIds=["npc:1", "npc:2"])) is False
    assert env.writes == [] and env.belts == ["scene-check-drop"]


def test_a_rationale_stating_a_closed_set_outcome_is_trimmed_the_edges_stay(monkeypatch):
    env = Env(monkeypatch)
    cons = {"edges": [{"toward": "npc:1", "direction": "more-threatened"}], "rationale": "They said the player will be nominated."}
    assert env.record(clean(consequence=cons)) is True
    assert env.writes[0][1]["consequence"] == {"edges": [{"toward": "npc:1", "direction": "more-threatened"}]}
    assert env.belts == ["scene-check-trim"]


def test_content_stating_a_closed_set_outcome_loses_that_sentence_only(monkeypatch):
    env = Env(monkeypatch)
    assert env.record(clean(content="They shared a quiet laugh. The houseguest was evicted by a vote of 5 to 2. Then they hugged.")) is True
    assert env.writes[0][0][0] == "They shared a quiet laugh. Then they hugged."
    env = Env(monkeypatch)
    assert env.record(clean(content="The HOH won the veto and was nominated again.")) is True
    assert env.writes[0][0][0] == "The player and a houseguest had a private exchange."  # the existing default sentence for an empty content
    assert env.writes[0][1]["kind"] == "bonding" and env.belts == ["scene-check-trim"]


def test_the_content_trim_is_for_assertions_not_speculation():
    f = sp._without_closed_set_sentences
    assert f("He is worried he could be evicted. Then he was evicted last night.") == "He is worried he could be evicted."
    assert f("Nothing to see.") == "Nothing to see."


def test_a_bedtime_turn_with_an_open_decision_records_nothing_new(monkeypatch):
    env = Env(monkeypatch, pending="nominations")
    assert env.record(clean(), last_user="Goodnight. I'm going to bed.") is False
    assert env.writes == [] and env.belts == ["scene-check-drop"]
    # an ordinary conversation while a decision is open is play, not a bedtime: recorded as today
    env = Env(monkeypatch, pending="nominations")
    assert env.record(clean()) is True and env.belts == []


def test_an_ooc_turn_records_nothing(monkeypatch):
    env = Env(monkeypatch)
    assert env.record(clean(), last_user="((how many days are left?))") is False
    assert env.writes == [] and env.belts == []  # skipped quietly by the earlier ORW-207 check, never reaches the gate
    assert sp.gate_scene_record(["npc:1"], "bonding", "c", None, {"present": ["npc:1"], "awake": ["npc:1"], "known_ids": ["npc:1"]},
                                act="ooc").dropped is True


def test_a_state_read_failure_fails_open(monkeypatch):
    env = Env(monkeypatch, state_error=True)
    assert env.record(clean(withIds=["npc:1", "npc:2"])) is True
    assert env.writes[0][1]["with_ids"] == ["npc:1", "npc:2"] and env.belts == []


def _soft_failures(monkeypatch):
    from src import log_rings
    seen = []
    monkeypatch.setattr(log_rings, "record_soft_failure", lambda cls, exc, **k: seen.append(cls))
    return seen


def test_a_state_read_failure_is_a_red_soft_failure_not_a_silent_fail_open(monkeypatch):
    """Coordinator review of #2590 (the #1599 rule): a fail-open is never silent."""
    seen = _soft_failures(monkeypatch)
    env = Env(monkeypatch, state_error=True)
    assert env.record(clean(withIds=["npc:1", "npc:2"])) is True          # still records as today
    assert "scene-check:gate-failed" in seen


def test_a_failed_presence_read_is_a_red_soft_failure(monkeypatch):
    seen = _soft_failures(monkeypatch)
    env = Env(monkeypatch)

    async def whereabouts_down(user=None):
        raise RuntimeError("engine down")

    monkeypatch.setattr(al.__dict__.get("_oe", None) or __import__("src.orwell_engine", fromlist=["x"]), "whereabouts", whereabouts_down)
    env.record(clean(withIds=["npc:1"]))
    assert "scene-check:presence-read-failed" in seen


def test_a_healthy_gate_records_no_soft_failure(monkeypatch):
    seen = _soft_failures(monkeypatch)
    env = Env(monkeypatch)
    assert env.record(clean(withIds=["npc:1"])) is True
    assert not [c for c in seen if c.startswith("scene-check")]


def test_the_gate_only_trims_never_adds():
    view = {"present": ["npc:1", "npc:2"], "awake": ["npc:1"], "known_ids": ["npc:1", "npc:2", "npc:3"], "asleep": ["npc:2"]}
    g = sp.gate_scene_record(["npc:1", "npc:2", "npc:3"], "bonding", "Fine.", {"edges": [{"toward": "npc:1", "direction": "warmer"}]}, view)
    assert g.ids == ["npc:1"] and set(g.ids) <= {"npc:1", "npc:2", "npc:3"} and g.consequence == {"edges": [{"toward": "npc:1", "direction": "warmer"}]}


def test_the_record_kinds_match_the_checkers():
    assert set(sp.RECORD_KINDS) == al._RECORD_KINDS


def test_the_belt_is_deferred_to_settle_when_a_session_is_given_and_still_counts_the_trim(monkeypatch):
    env = Env(monkeypatch, asleep=["npc:2"])
    staged = []
    from src import fold_ledger as fl
    monkeypatch.setattr(fl, "stage_pending_fold", lambda owner, sid, **kw: staged.append(kw))
    ok = _run(al._auto_record_scene("n", "u", ROSTER, "http://x", "m", {}, "o", session_id="s",
                                    raw=json.dumps(clean(withIds=["npc:1", "npc:2"]))))
    assert ok is True and staged[0]["with_ids"] == ["npc:1"] and env.belts == ["scene-check-trim"]
