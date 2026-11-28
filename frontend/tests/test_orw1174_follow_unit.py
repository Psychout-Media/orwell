"""ORW-1174: the accept reader, the invitation finder and the commit (open ask, and an invitation made in the player's room). Roles only; a fake engine; no model."""
import asyncio
import importlib
import json

af = importlib.import_module("src.act_first")
pm = importlib.import_module("src.orwell_player_move")
ti = importlib.import_module("src.tool_implementations")

ROSTER = {"npc:k": "Kai Role", "npc:v": "Valerie Role", "npc:j": "Jace Role"}
CTX = {"roster": ROSTER, "present": ["npc:k", "npc:v"], "here": "kitchen", "room_names": {}, "hoh_id": "npc:k", "open_ask": None, "reply_lines": []}


def test_the_prod_yes_lines_read_as_accepts_when_an_invitation_stands():
    ctx = {**CTX, "invite": {"id": "npc:k", "name": "Kai Role", "room": "hoh-room", "source": "reply"}}
    for t in ("sure Ill walk with you!", "Yeah Letsd go Kai", "go join Kai", "Follow Kai inside for our chat.", "GO upstairs with Kai.", "lead the way", "yeah", "Sure!", "ok lets go", "I'll follow you", "go with Kai"):
        assert af.accept_intent(t, ctx), t


def test_a_no_a_hedge_a_question_or_another_houseguest_is_no_accept():
    ctx = {**CTX, "invite": {"id": "npc:k", "name": "Kai Role", "room": "hoh-room", "source": "reply"}}
    for t in ("no thanks", "nah not now", "sure, but first let me grab a snack", "who is Valerie?", "go join Valerie", "join me in the yard", "come with me", "I will not follow you", "oh sure, great idea", "Kai what is this about?"):
        assert af.accept_intent(t, ctx) is None, t
    assert af.accept_intent("sure", {**CTX, "invite": None}) is None  # no invitation standing


def test_an_invitation_is_an_engine_fact_the_inviter_is_here_or_an_ask_is_open():
    lines = [("npc:k", "Not out there. Upstairs. I'd like to say the rest somewhere with a door on it."), ("npc:v", "Kai, take it easy.")]
    inv = af.find_invite("sure", {**CTX, "reply_lines": lines})
    assert inv and inv["id"] == "npc:k" and inv["room"] == "hoh-room" and inv["source"] == "reply"  # Kai is the HOH: upstairs is their room
    assert af.find_invite("sure", {**CTX, "reply_lines": lines, "present": ["npc:v"]}) is None  # the inviter is not here: a staged invitation
    ask = af.find_invite("sure", {**CTX, "present": [], "open_ask": {"id": "npc:k", "room": "hoh-room"}})
    assert ask and ask["source"] == "ask"
    assert af.find_invite("go join Valerie", {**CTX, "reply_lines": lines}) is None  # the words name someone who did not invite


class FakeEngine:
    def __init__(self, ask=None):
        self.calls = []
        self.room = "kitchen"
        self.ask = ask

    async def get_game_state(self, user=None):
        return {"started": True, "house": [{"id": i, "name": n, "status": "active"} for i, n in ROSTER.items()], **({"openTalkAsk": self.ask} if self.ask else {})}

    async def game_status(self, user=None):
        return {"pending": None, "hoh": {"id": "npc:k", "name": "Kai Role"}}

    async def whereabouts(self, user=None, **kw):
        return {"room": self.room, "present": [{"id": "npc:k", "name": "Kai Role"}], "nearby": [], "roomNames": {}}

    async def ask_to_talk_alone(self, npc, room=None, private=None, expected_beat_seq=None, user=None, invited=None):
        self.calls.append(("ask", npc, room, private, bool(invited)))
        return {"outcome": "accepted", "room": room or "hoh-room", "roomName": "the HOH room"}

    async def resolve_player_move(self, text, key=None, user=None, **kw):
        self.calls.append(("resolve", kw.get("skip")))
        return {}


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _patch_move(monkeypatch, eng):
    async def do_move_to(args, owner=None):
        room = json.loads(args)["room"]
        eng.calls.append(("move", room))
        return {"output": json.dumps({"room": room})}
    monkeypatch.setattr(ti, "do_move_to", do_move_to)


def test_a_yes_to_an_open_ask_goes_through_the_engines_accept_and_owns_the_message(monkeypatch):
    eng = FakeEngine(ask={"from": {"id": "npc:k", "name": "Kai Role"}, "room": "hoh-room"})
    got = _run(pm.follow_before_narrator("sure Ill walk with you!", "u-ask", "m1", previous_reply="", engine=eng))
    assert got is True
    assert ("ask", "npc:k", "hoh-room", True, False) in eng.calls  # the open ask is accepted (the room it named): the engine places both, no player-side move, no invited flag
    assert ("resolve", ["move", "bed"]) in eng.calls  # the player's own move parse is off: it would walk them away from the inviter
    st = af.take_stash("u-ask")
    assert st and any("on their way with Kai Role" in n for n in st["notes"])


def test_a_yes_to_an_invitation_in_the_room_walks_the_player_then_the_inviter_with_their_consent(monkeypatch):
    eng = FakeEngine()
    _patch_move(monkeypatch, eng)
    reply = "@[Kai Role] Not out there. Come with me to the storage room, I want a word."
    got = _run(pm.follow_before_narrator("Yeah Letsd go Kai", "u-rep", "m2", previous_reply=reply, engine=eng))
    assert got is True
    kinds = [c[0] for c in eng.calls]
    assert kinds.index("move") < kinds.index("ask")
    assert ("move", "storage-room") in eng.calls and ("ask", "npc:k", "storage-room", False, True) in eng.calls


def test_no_yes_without_an_invitation_commits_nothing(monkeypatch):
    eng = FakeEngine()
    _patch_move(monkeypatch, eng)
    assert _run(pm.follow_before_narrator("sure", "u-none", "m3", previous_reply="@[Kai Role] Nice weather.", engine=eng)) is False
    assert _run(pm.follow_before_narrator("no thanks", "u-none", "m4", previous_reply="@[Kai Role] Come with me to the storage room.", engine=eng)) is False
    assert not [c for c in eng.calls if c[0] in ("move", "ask", "resolve")]


def test_an_escort_that_committed_the_message_keeps_the_follow_slot_from_a_second_pair_of_walks():
    """ORW-1168 x ORW-1174: 'sure, come with me outside' is both an accept and an invitation along; the escort owns it (wiring guard in the chat build)."""
    import pathlib
    src = (pathlib.Path(__file__).resolve().parents[1] / "routes" / "chat_helpers.py").read_text()
    assert "if _escort is None and await follow_before_narrator(" in src
