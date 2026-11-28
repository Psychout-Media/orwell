"""ORW-1168 (prod 2026-11-28): an invitation along ("do you wanna come with?", "go inside and invite her outside") moved only the player or nobody, and the story showed the houseguest
arriving anyway. Real engine + the real turn route + a scripted stub as the fake model (no model calls). The board must hold what the reply shows: the player and the invited houseguest
together in the room the words name. Roles only (a seeded houseguest stands in); no player text from prod.
Needs the built engine bundle (`npm run build`)."""
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
def stack_es():
    prior = os.environ.get("ORWELL_ACT_FIRST")
    os.environ["ORWELL_ACT_FIRST"] = "1"
    auth_json = pathlib.Path(m03.FRONTEND) / "data" / "auth.json"
    aside = auth_json.with_name("auth.json.orw1168-aside")
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


def _room_of(stack, hid):
    w = _engine_u(stack, "whereabouts", {"search": True}) or {}
    for h in (w.get("search") or w.get("houseguests") or []):
        if isinstance(h, dict) and h.get("id") == hid:
            return h.get("room")
    return None


def _together_in(stack, room, hid):
    w = _where(stack)
    return w.get("room") == room and any(p.get("id") == hid for p in (w.get("present") or []))


def test_invite_her_outside_puts_the_player_and_her_in_the_backyard(stack_es):
    _new_game(stack_es)
    sid = _session(stack_es, "orw1168")
    _settle_premiere(stack_es, sid)
    house = [h for h in ((_engine_u(stack_es, "getGameState") or {}).get("house") or []) if isinstance(h, dict) and h.get("id") and h.get("name")]
    guest = house[0]
    gid, gname = guest["id"], guest["name"]
    first = str(gname).split()[0]
    # the shape of prod: the player stands in the yard, she is inside, and the player has just spoken of her
    _engine_u(stack_es, "moveTo", {"room": "backyard"})
    _engine_u(stack_es, "moveHouseguest", {"id": gid, "room": "kitchen"})
    STUB.script.clear(); STUB.forced_script.clear()
    STUB.script.extend(_voice_house(stack_es))
    ws_turn(stack_es["fe"], sid, f"{first} wanted to ask me something earlier.", timeout=120, client_msg_id="orw1168-a", headers=stack_es["auth"])
    _engine_u(stack_es, "moveTo", {"room": "backyard"})
    _engine_u(stack_es, "moveHouseguest", {"id": gid, "room": "kitchen"})
    assert not _together_in(stack_es, "backyard", gid)
    STUB.script.clear(); STUB.forced_script.clear()
    # the narrator shows her coming (what prod showed); the engine must agree, or the reply must be told she did not
    STUB.script.append({"deltas": [f"Back through the screen door. @[{gname}] There you are. She comes out to the pool deck with you."], "delay": 0})
    res = ws_turn(stack_es["fe"], sid, "Why dont we go inside and invite her outside?", timeout=120, client_msg_id="orw1168-b", headers=stack_es["auth"])
    assert res["done"] and res["saved"]
    assert _where(stack_es).get("room") == "backyard"
    together = _together_in(stack_es, "backyard", gid)
    told_no = any("did not come" in str(m.get("content", "")) or "DECLINED" in str(m.get("content", "")) or "NOT come" in str(m.get("content", ""))
                  for r in STUB.requests[-6:] for m in (r.get("messages") or []) if isinstance(m, dict) and m.get("role") == "system")
    assert together or told_no, "the player and the invited houseguest are not together in the backyard on the engine board, and the narrator was not told she did not come"


def test_do_you_wanna_come_with_commits_her_walk_and_the_players(stack_es):
    """The 05:31 shape: she has just spoken to the player in the kitchen; 'come with?' is meant for her, and the player walks to the yard."""
    _new_game(stack_es)
    sid = _session(stack_es, "orw1168b")
    _settle_premiere(stack_es, sid)
    house = [h for h in ((_engine_u(stack_es, "getGameState") or {}).get("house") or []) if isinstance(h, dict) and h.get("id") and h.get("name")]
    gid, gname = house[0]["id"], house[0]["name"]
    other = house[1]["name"].split()[0]
    _engine_u(stack_es, "moveTo", {"room": "kitchen"})
    _engine_u(stack_es, "moveHouseguest", {"id": gid, "room": "kitchen"})
    STUB.script.clear(); STUB.forced_script.clear()
    STUB.script.append({"deltas": [f"@[{gname}] Got a minute? I want to ask you something."], "delay": 0})
    ws_turn(stack_es["fe"], sid, "Sure, what is it?", timeout=120, client_msg_id="orw1168-c", headers=stack_es["auth"])
    _engine_u(stack_es, "moveTo", {"room": "kitchen"})
    _engine_u(stack_es, "moveHouseguest", {"id": gid, "room": "kitchen"})
    assert _together_in(stack_es, "kitchen", gid)
    STUB.script.clear(); STUB.forced_script.clear()
    STUB.script.append({"deltas": [f"Sunlight on the lawn. @[{gname}] Yeah. Come on, walking is better."], "delay": 0})
    res = ws_turn(stack_es["fe"], sid, f"Yeah, I wanted to join {other} outside, do you wanna come with? Chat on the way?", timeout=120, client_msg_id="orw1168-d", headers=stack_es["auth"])
    assert res["done"] and res["saved"]
    assert _where(stack_es).get("room") == "backyard"
    together = _together_in(stack_es, "backyard", gid)
    told_no = any("NOT come" in str(m.get("content", "")) or "did NOT come" in str(m.get("content", ""))
                  for r in STUB.requests[-6:] for m in (r.get("messages") or []) if isinstance(m, dict) and m.get("role") == "system")
    assert together or told_no, "she neither walked out with the player on the engine board nor was the narrator told she did not"
