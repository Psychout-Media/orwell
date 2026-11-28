"""ORW-1138 - the per-turn context for a move and a question about where everyone is (prod 11-28 shape, as codes): the people the player was with came along or stayed (named), "where is everyone" is answered from
the engine's whereabouts, and the part of the day is one hard line (the evening-light-at-night wording). Roles only; invented labels; no model."""
import importlib

ch = importlib.import_module("routes.chat_helpers")

W = {"room": "kitchen", "present": [{"name": "GuestA RoleA"}], "nearby": [{"room": "living-room", "present": [{"name": "GuestB RoleB"}, {"name": "GuestC RoleC"}]}], "roomNames": {}}


def test_a_move_names_who_stayed_behind():
    out = ch._whereabouts_barrier_directive(W, None, {"from": "living-room", "to": "kitchen", "stayed": ["GuestB RoleB", "GuestC RoleC"]})
    assert "STAYED BEHIND" in out and "GuestB RoleB, GuestC RoleC" in out and "do not write them in" in out


def test_a_move_names_who_came_along():
    out = ch._whereabouts_barrier_directive(W, None, {"from": "living-room", "to": "kitchen", "came": ["GuestA RoleA"]})
    assert "CAME ALONG" in out and "GuestA RoleA" in out and "STAYED BEHIND" not in out


def test_a_move_with_nobody_in_company_adds_neither_line():
    out = ch._whereabouts_barrier_directive(W, None, {"from": "living-room", "to": "kitchen"})
    assert "CAME ALONG" not in out and "STAYED BEHIND" not in out


def test_where_is_everyone_is_answered_from_the_engine_whereabouts():
    for msg in ("wait, where is everyone", "I thought everyone was in the other room", "where did everyone go?"):
        out = ch._where_is_everyone_directive(msg, W)
        assert out and "GuestA RoleA" in out and "GuestB RoleB" in out and "somewhere the player cannot see" in out, msg


def test_an_ordinary_message_gets_no_where_is_everyone_line():
    assert ch._where_is_everyone_directive("I grab a snack", W) is None
    assert ch._where_is_everyone_directive("where is the kitchen", W) is None


def test_the_part_of_the_day_is_one_hard_line(monkeypatch):
    zc = importlib.import_module("src.zero_clocks")
    monkeypatch.setattr(zc, "zero_clocks_on", lambda: False)
    out = ch._clock_light_directive({"started": True, "timeOfDay": "night"})
    assert out and "NIGHT" in out and "never call it any other part of the day" in out
    assert ch._clock_light_directive({"started": True}) is None
    assert ch._clock_light_directive(None) is None
