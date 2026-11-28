"""ORW-1174 (prod 2026-11-28 06:17-06:46): a houseguest invited the player somewhere, and ten messages of "sure Ill walk with you!", "Yeah Letsd go Kai", "go join Kai", "Follow Kai inside for our chat." and
"GO upstairs with Kai." moved the player alone, or nobody. A yes to an invitation commits BOTH walks (the houseguest's invitation is their consent), to the room they named.
Real engine + the real turn route + a scripted stub as the fake model (no model calls). The board must hold what the reply shows: the player and the inviter together in the named room, and the narrator told the rule for the
walk. Roles only (a seeded houseguest stands in; the player's lines are the prod lines with the name swapped). Needs the built engine bundle (`npm run build`)."""
from __future__ import annotations

import os
import pathlib

import pytest

import test_m0_3_midgen_join as m03
from test_m0_3_midgen_join import STUB
from test_orw1144_act_first_real_loop import _engine_u, _new_game, _session, _settle_premiere, _voice_house
from _ws_turn_driver import ws_turn

pytestmark = pytest.mark.browser


@pytest.fixture(scope="module")
def stack_fl():
    prior = os.environ.get("ORWELL_ACT_FIRST")
    os.environ["ORWELL_ACT_FIRST"] = "1"
    auth_json = pathlib.Path(m03.FRONTEND) / "data" / "auth.json"
    aside = auth_json.with_name("auth.json.orw1174-aside")
    had = auth_json.exists()
    if had:
        auth_json.replace(aside)
    try:
        yield from m03._boot_stack(auth_user="orw1144")
    finally:
        if auth_json.exists():
            auth_json.unlink()
        if had:
            aside.replace(auth_json)
        if prior is None:
            os.environ.pop("ORWELL_ACT_FIRST", None)
        else:
            os.environ["ORWELL_ACT_FIRST"] = prior


def _where(stack):
    return _engine_u(stack, "whereabouts") or {}


def _together_in(stack, room, hid):
    w = _where(stack)
    return w.get("room") == room and any(p.get("id") == hid for p in (w.get("present") or []))


def _place(stack, gid, room="kitchen"):
    _engine_u(stack, "moveTo", {"room": room})
    _engine_u(stack, "moveHouseguest", {"id": gid, "room": room})


def _guest(stack):
    house = [h for h in ((_engine_u(stack, "getGameState") or {}).get("house") or []) if isinstance(h, dict) and h.get("id") and h.get("name")]
    return house[0]["id"], house[0]["name"]


_n = [0]


def _turn(stack, sid, text, reply, forced=None):
    _n[0] += 1
    STUB.script.clear()
    STUB.forced_script.clear()
    if forced is not None:
        STUB.forced_script.append({"tool_calls": forced})
    STUB.script.append({"deltas": [reply], "delay": 0})
    res = ws_turn(stack["fe"], sid, text, timeout=120, client_msg_id=f"orw1174-{_n[0]}", headers=stack["auth"])
    assert res["done"] and res["saved"], f"no completed reply for {text!r}"
    return res


def _invited(stack, sid, gid, gname, line):
    """The shape of prod: the houseguest, standing in the kitchen with the player, has just invited the player along in the story's last reply."""
    _place(stack, gid)
    _turn(stack, sid, "Hello there.", f"@[{gname}] {line}")
    _place(stack, gid)  # the engine's own presence tick may have moved anyone; the invitation stands where it was made
    assert _together_in(stack, "kitchen", gid)


def _told_rule(stack):
    return any("is on their way with" in str(m.get("content", ""))
               for r in STUB.requests[-8:] for m in (r.get("messages") or []) if isinstance(m, dict) and m.get("role") == "system")


# (the player's line with {n} = the inviter's first name, what the inviter said, the room the two end in)
YES_CASES = [
    ("sure Ill walk with you!", "Come with me to the storage room, I want a word.", "storage-room"),
    ("Yeah Letsd go {n}", "Not out there. Upstairs, somewhere with a door on it.", "landing"),
    ("go join {n}", "Follow me to the lounge.", "lounge"),
    ("Follow {n} inside for our chat.", "Come inside with me, to the living room. I want a word.", "living-room"),
    ("GO upstairs with {n}.", "Come with me to the storage room.", "storage-room"),
]


@pytest.mark.parametrize("text,line,room", YES_CASES, ids=["sure-walk", "letsd-go", "go-join", "follow-inside", "go-upstairs-with"])
def test_a_yes_to_an_invitation_puts_the_player_and_the_inviter_together_in_the_named_room(stack_fl, text, line, room):
    _new_game(stack_fl)
    sid = _session(stack_fl, "orw1174")
    _settle_premiere(stack_fl, sid)
    gid, gname = _guest(stack_fl)
    _invited(stack_fl, sid, gid, gname, line)
    _turn(stack_fl, sid, text.format(n=gname.split()[0]), "They set off together.")
    assert _together_in(stack_fl, room, gid), f"the player and the inviter are not together in {room} (player in {_where(stack_fl).get('room')})"
    assert _told_rule(stack_fl), "the narrator was not told the on-their-way rule"


def test_a_yes_the_model_reads_is_committed_the_same_way(stack_fl):
    """'Okay you win, take me there.' is no plain yes to the regexes: the act-first round reads it, with the invitation in its context, and calls followInvite."""
    _new_game(stack_fl)
    sid = _session(stack_fl, "orw1174m")
    _settle_premiere(stack_fl, sid)
    gid, gname = _guest(stack_fl)
    _invited(stack_fl, sid, gid, gname, "Come with me to the storage room, I want a word.")
    _turn(stack_fl, sid, "Okay you win, take me there.", "They set off together.", forced=[{"name": "followInvite", "args": {}}])
    assert _together_in(stack_fl, "storage-room", gid)


def test_no_yes_without_an_invitation_and_a_no_do_nothing(stack_fl):
    _new_game(stack_fl)
    sid = _session(stack_fl, "orw1174n")
    _settle_premiere(stack_fl, sid)
    gid, gname = _guest(stack_fl)
    # 'sure' with nobody having invited the player
    _place(stack_fl, gid)
    _turn(stack_fl, sid, "Hello there.", f"@[{gname}] Nice weather in the yard today.")
    _place(stack_fl, gid)
    for text in ("sure", "Yeah lets go", "Follow " + gname.split()[0]):
        _turn(stack_fl, sid, text, "Nothing much happens.")
        assert _together_in(stack_fl, "kitchen", gid), f"{text!r} with no invitation moved someone"
        _place(stack_fl, gid)
    # 'no thanks' with an invitation standing
    _invited(stack_fl, sid, gid, gname, "Come with me to the storage room, I want a word.")
    for text in ("no thanks", "nah not now"):
        _turn(stack_fl, sid, text, "They shrug.")
        w = _where(stack_fl)
        assert w.get("room") == "kitchen" and not _together_in(stack_fl, "storage-room", gid), f"{text!r} walked someone to the storage room"
        _invited(stack_fl, sid, gid, gname, "Come with me to the storage room, I want a word.")
