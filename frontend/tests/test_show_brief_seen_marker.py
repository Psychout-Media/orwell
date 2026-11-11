"""Showrunner memory — the Show Brief's "last seen" marker (K6 §5.1; ORWELL_SHOW_BRIEF, default OFF).

"What changed since your last turn" is computed against what the NARRATOR last saw. Two mistakes the game can't make:
  • after a restart the marker was gone, so the first brief said "Unknown";
  • moves the narrator itself made or read through its own tools (whereabouts, moveTo, getGameState) were reported
    again on the next turn, because the marker only moved when a brief was served.
Now the marker is kept per game OWNER and moved forward by the narrator's own tool reads and by the two move belts
(they record a walk the reply already narrated), never by the front end's internal engine reads. It is stamped on
the assistant chat row when the reply is saved, adopted back from the newest stamped row after a restart, and
dropped when a season starts (or when it is ahead of the beat counter, so it belongs to an earlier game). Flag off
⇒ none of it runs. Roles only.
"""

import asyncio
import importlib
import inspect
import json

import pytest

sb = importlib.import_module("src.orwell_show_brief")
chat_helpers = importlib.import_module("routes.chat_helpers")
tool_impl = importlib.import_module("src.tool_implementations")
orwell_engine = importlib.import_module("src.orwell_engine")
agent_loop = importlib.import_module("src.agent_loop")
llm_core = importlib.import_module("src.llm_core")
chat_routes = importlib.import_module("routes.chat_routes")

FLAG = "ORWELL_SHOW_BRIEF"


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def _clean():
    sb._STASH.clear()
    sb._SEEN.clear()
    yield
    sb._STASH.clear()
    sb._SEEN.clear()


@pytest.fixture
def flag_on(monkeypatch):
    monkeypatch.setenv(FLAG, "1")


class _Msg:
    def __init__(self, role, content, metadata=None):
        self.role = role
        self.content = content
        self.metadata = metadata or {}


WA_KITCHEN = {
    "room": "kitchen",
    "present": [{"id": "npc:3", "name": "C"}, {"id": "npc:1", "name": "A"}],
    "nearby": [{"room": "living-room", "present": [{"id": "npc:2", "name": "B"}]}, {"room": "dining-room", "present": []}],
    "turnsHere": 0, "companions": [], "tracked": [],
}
SERVED = {"v": 1, "beatSeq": 7, "clock": "9:40am, Day 1", "room": "living-room", "here": ["npc:2"], "inView": []}


def test_the_narrators_own_tool_read_moves_the_marker_and_keeps_the_clock(flag_on):
    sb._SEEN["owner-1"] = dict(SERVED)
    sb.note_tool_result("owner-1", WA_KITCHEN)
    assert sb._SEEN["owner-1"] == {
        "v": 1, "beatSeq": 7, "clock": "9:40am, Day 1", "room": "kitchen", "here": ["npc:1", "npc:3"],
        "inView": [{"room": "living-room", "ids": ["npc:2"]}, {"room": "dining-room", "ids": []}],
    }


def test_a_result_that_wraps_whereabouts_or_a_full_state_read_counts_too(flag_on):
    sb.note_tool_result("owner-1", {"status": "moved", "whereabouts": WA_KITCHEN, "beatSeq": 9})
    assert sb._SEEN["owner-1"]["room"] == "kitchen" and sb._SEEN["owner-1"]["beatSeq"] == 9
    sb.note_tool_result("owner-1", {"started": True, "beatSeq": 11, "clockLabel": "9:45am, Day 1", "whereabouts": WA_KITCHEN})
    assert sb._SEEN["owner-1"]["beatSeq"] == 11 and sb._SEEN["owner-1"]["clock"] == "9:45am, Day 1"


def test_results_without_whereabouts_or_malformed_ones_change_nothing(flag_on):
    sb._SEEN["owner-1"] = dict(SERVED)
    for junk in (None, "text", {"status": "noop"}, {"whereabouts": None}, {"room": "kitchen"}, {"whereabouts": {"room": 3}}):
        sb.note_tool_result("owner-1", junk)
    assert sb._SEEN["owner-1"] == SERVED


def test_flag_off_the_marker_never_moves(monkeypatch):
    monkeypatch.delenv(FLAG, raising=False)
    sb.note_tool_result("owner-1", WA_KITCHEN)
    assert sb._SEEN == {}
    assert sb.served_seen("owner-1") is None


def test_the_marker_is_per_owner_so_two_sessions_of_one_game_share_it(flag_on):
    sb.stash("sess-A", {"showBrief": {"text": "BRIEF", "seen": SERVED}})
    assert sb.pop("sess-A", "owner-1") == "BRIEF"
    req = sb.build_request("sess-B", {"house": []}, "", None, user="owner-1")
    assert req["seen"] == SERVED
    assert "seen" not in sb.build_request("sess-C", {"house": []}, "", None, user="owner-2")


# ── the narrator's tools move it; the front end's own reads never do ─────────────────────────────────────────

def test_do_move_to_and_do_whereabouts_move_the_marker(flag_on, monkeypatch):
    async def fake_move_to(room, user=None):
        return WA_KITCHEN

    async def fake_whereabouts(user=None):
        return {**WA_KITCHEN, "room": "dining-room", "nearby": []}

    monkeypatch.setattr(orwell_engine, "move_to", fake_move_to)
    monkeypatch.setattr(orwell_engine, "whereabouts", fake_whereabouts)
    _run(tool_impl.do_move_to(json.dumps({"room": "kitchen"}), owner="owner-1"))
    assert sb._SEEN["owner-1"]["room"] == "kitchen"
    _run(tool_impl.do_whereabouts("{}", owner="owner-1"))
    assert sb._SEEN["owner-1"]["room"] == "dining-room"


def test_do_get_game_state_moves_the_marker(flag_on, monkeypatch):
    async def fake_state(user=None, **kw):
        return {"started": True, "beatSeq": 5, "clockLabel": "8:00am, Day 2", "whereabouts": WA_KITCHEN}

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    _run(tool_impl.do_get_game_state("{}", owner="owner-1"))
    assert sb._SEEN["owner-1"]["clock"] == "8:00am, Day 2"


def test_the_front_ends_own_engine_read_never_moves_the_marker(flag_on, monkeypatch):
    async def fake_call(name, args, user=None, timeout=None):
        return WA_KITCHEN

    monkeypatch.setattr(orwell_engine, "_call", fake_call)
    sb._SEEN["owner-1"] = dict(SERVED)
    _run(orwell_engine.whereabouts(user="owner-1"))  # e.g. the framing's beat-signature read
    assert sb._SEEN["owner-1"] == SERVED


# ── the move belts record a walk the reply already narrated ─────────────────────────────────────────────────

SEEN_KITCHEN = {"v": 1, "beatSeq": 7, "room": "kitchen", "here": ["npc:1", "npc:3"],
                "inView": [{"room": "living-room", "ids": ["npc:2"]}, {"room": "dining-room", "ids": []},
                           {"room": "backyard", "ids": []}]}


def test_the_player_move_belt_moves_the_marker_to_the_room_the_reply_walked_to(flag_on, monkeypatch):
    async def fake_llm(**kw):
        return '{"room": "kitchen"}'

    async def fake_backfill(owner, fn, *args, **kw):
        return WA_KITCHEN

    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    monkeypatch.setattr(agent_loop, "_backfill_with_cas", fake_backfill)
    sb._SEEN["owner-1"] = dict(SERVED)
    assert _run(agent_loop._auto_move_player("You head into the kitchen.", "I go to the kitchen",
                                             "http://llm.invalid", "m", {}, "owner-1"))
    assert sb._SEEN["owner-1"]["room"] == "kitchen" and sb._SEEN["owner-1"]["here"] == ["npc:1", "npc:3"]


def test_the_npc_move_belt_moves_only_the_houseguest_the_reply_walked(flag_on, monkeypatch):
    # The reply walked houseguest 1 from the kitchen out to the backyard. Meanwhile houseguest 4 turned up in the
    # living room, which the narrator never saw: that must still be reported, so it is NOT absorbed.
    after = {"room": "kitchen", "present": [{"id": "npc:3", "name": "C"}],
             "nearby": [{"room": "living-room", "present": [{"id": "npc:2", "name": "B"}, {"id": "npc:4", "name": "D"}]},
                        {"room": "dining-room", "present": []},
                        {"room": "backyard", "present": [{"id": "npc:1", "name": "A"}]}],
             "turnsHere": 2, "companions": [], "tracked": []}

    async def fake_llm(**kw):
        return '{"moves": [{"id": "npc:1", "room": "backyard"}]}'

    async def fake_whereabouts(user=None):  # the belt's own ORW-210 check: an FE read, never a marker move
        return {**after, "room": "kitchen", "present": [], "nearby": []}

    async def fake_move_houseguest(hid, room, user=None):
        return {"status": "moved", "whereabouts": after, "beatSeq": 12}

    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    monkeypatch.setattr(orwell_engine, "whereabouts", fake_whereabouts)
    monkeypatch.setattr(orwell_engine, "move_houseguest", fake_move_houseguest)
    sb._SEEN["owner-1"] = dict(SEEN_KITCHEN)
    house = [{"id": f"npc:{i}", "name": n} for i, n in ((1, "A"), (2, "B"), (3, "C"), (4, "D"))]
    assert _run(agent_loop._auto_move_npc("A drifts out to the backyard.", "hi", house,
                                          "http://llm.invalid", "m", {}, "owner-1")) == 1
    assert sb._SEEN["owner-1"] == {**SEEN_KITCHEN, "here": ["npc:3"],
                                   "inView": [{"room": "living-room", "ids": ["npc:2"]},
                                              {"room": "dining-room", "ids": []},
                                              {"room": "backyard", "ids": ["npc:1"]}]}


def test_the_npc_move_note_ignores_a_refused_move_and_a_missing_marker(flag_on):
    res = {"status": "illegal", "whereabouts": WA_KITCHEN}
    sb._SEEN["owner-1"] = dict(SEEN_KITCHEN)
    sb.note_narrated_npc_move("owner-1", "npc:1", res)
    assert sb._SEEN["owner-1"] == SEEN_KITCHEN
    sb.note_narrated_npc_move("owner-2", "npc:1", {**res, "status": "moved"})
    assert "owner-2" not in sb._SEEN


def test_a_houseguest_walked_out_of_view_leaves_the_marker(flag_on):
    sb._SEEN["owner-1"] = dict(SEEN_KITCHEN)
    gone = {**WA_KITCHEN, "present": [{"id": "npc:3", "name": "C"}],
            "nearby": [{"room": "living-room", "present": [{"id": "npc:2", "name": "B"}]}, {"room": "dining-room", "present": []},
                       {"room": "backyard", "present": []}]}
    sb.note_narrated_npc_move("owner-1", "npc:1", {"status": "moved", "whereabouts": gone})
    assert sb._SEEN["owner-1"]["here"] == ["npc:3"]
    assert all("npc:1" not in v["ids"] for v in sb._SEEN["owner-1"]["inView"])


# ── a new game never inherits the old game's marker ─────────────────────────────────────────────────────────

def test_a_season_reset_forgets_the_marker(flag_on):
    assert sb.forget in orwell_engine._SEASON_RESET_LISTENERS
    sb._SEEN["owner-1"] = dict(SERVED)
    sb._SEEN["owner-2"] = dict(SERVED)
    orwell_engine._notify_season_reset("owner-1")
    assert "owner-1" not in sb._SEEN and "owner-2" in sb._SEEN


def test_a_marker_ahead_of_the_beat_counter_belongs_to_an_earlier_game_and_is_dropped(flag_on):
    sb._SEEN["owner-1"] = {**SERVED, "beatSeq": 50}
    assert "seen" not in sb.build_request("s", {"house": [], "beatSeq": 3}, "", None, user="owner-1")
    assert "owner-1" not in sb._SEEN
    sb._SEEN["owner-1"] = dict(SERVED)  # beatSeq 7: at or behind the counter is this game's
    assert sb.build_request("s", {"house": [], "beatSeq": 7}, "", None, user="owner-1")["seen"] == SERVED


# ── kept on the chat row, adopted back after a restart ───────────────────────────────────────────────────────

def test_the_marker_is_stamped_on_the_saved_assistant_row(flag_on):
    sb._SEEN["owner-1"] = dict(SERVED)
    stamped = sb.served_seen("owner-1")
    assert stamped == SERVED and stamped is not sb._SEEN["owner-1"], "a copy, never the live dict"


def test_save_assistant_response_stamps_briefSeen_only_when_given():
    class _Sess:
        def __init__(self):
            self.history = []

        def add_message(self, m):
            self.history.append(m)

    for given, expect in ((SERVED, SERVED), (None, None)):
        sess = _Sess()
        chat_helpers.save_assistant_response(sess, None, "sid", "A reply.", None, incognito=True, brief_seen=given)
        assert (sess.history[-1].metadata or {}).get("briefSeen") == expect


def test_after_a_restart_the_last_rows_marker_is_adopted(flag_on):
    history = [_Msg("assistant", "older", {"briefSeen": {**SERVED, "beatSeq": 3}}), _Msg("user", "hi"),
               _Msg("assistant", "newest", {"briefSeen": SERVED}), _Msg("user", "now")]
    sb.adopt_history_seen("owner-1", history)
    assert sb._SEEN["owner-1"] == SERVED
    # An in-memory marker (this process saw a newer brief) is never replaced by the row.
    sb._SEEN["owner-1"] = {**SERVED, "beatSeq": 99}
    sb.adopt_history_seen("owner-1", history)
    assert sb._SEEN["owner-1"]["beatSeq"] == 99


def test_adoption_ignores_rows_without_a_usable_marker(flag_on):
    sb.adopt_history_seen("owner-1", [_Msg("assistant", "x", {"briefSeen": "junk"}), _Msg("assistant", "y", {})])
    assert "owner-1" not in sb._SEEN
    sb.adopt_history_seen("owner-1", None)
    assert "owner-1" not in sb._SEEN


def test_flag_off_nothing_is_adopted(monkeypatch):
    monkeypatch.delenv(FLAG, raising=False)
    sb.adopt_history_seen("owner-1", [_Msg("assistant", "x", {"briefSeen": SERVED})])
    assert sb._SEEN == {}


# ── source pins: where the marker is stamped and adopted ─────────────────────────────────────────────────────

def test_both_reply_save_paths_stamp_the_marker_on_game_rows_only():
    src = inspect.getsource(chat_routes)
    assert src.count("brief_seen=(_served_brief_seen(ctx.user) if ctx.game_active else None),") == 2


def test_the_restart_adoption_runs_before_the_framing_reads_the_marker():
    src = inspect.getsource(chat_helpers.build_chat_context)
    adopt = src.index("_show_brief.adopt_history_seen(user, getattr(sess, \"history\", None))")
    framing = src.index("apply_game_framing(")
    assert adopt < framing
