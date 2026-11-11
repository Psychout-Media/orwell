"""Showrunner memory — the Show Brief v1 skeleton, front-end half (ORWELL_SHOW_BRIEF, default OFF).

Flag off: `getMomentPrompt` is called exactly as before (no extra argument) and no message is added, so the turn is
byte-identical. Flag on: the same call carries the optional `brief` request (the previous brief's `seen` echo, the
houseguests the player named, the last lines the player saw), the engine's brief is stashed per SESSION (the #1752
race rule), and `build_chat_context` appends it as a terminal system message after the transcript, right before
HARD CONSTRAINTS, so the cached prefix is untouched. Roles only (no houseguest names from any corpus).
"""

import asyncio
import importlib
import inspect

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")
sb = importlib.import_module("src.orwell_show_brief")

FLAG = "ORWELL_SHOW_BRIEF"
HOUSE = [
    {"id": "npc:1", "name": "Alpha Role", "status": "active"},
    {"id": "npc:2", "name": "Bravo Role", "status": "active"},
    {"id": "npc:3", "name": "Bravo Other", "status": "active"},  # shares the first name "Bravo"
    {"id": "npc:4", "name": "Charlie-Ann Role", "status": "active"},
]


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def _clean():
    sb._STASH.clear()
    sb._SEEN.clear()
    yield
    sb._STASH.clear()
    sb._SEEN.clear()


class _Msg:
    def __init__(self, role, content):
        self.role = role
        self.content = content


# ── the pure helpers ─────────────────────────────────────────────────────────────────────────────────────────

def test_flag_parsing(monkeypatch):
    for on in ("1", "true", "yes", "on", "ON"):
        monkeypatch.setenv(FLAG, on)
        assert sb.show_brief_enabled() is True
    for off in ("0", "false", "no", "off", "OFF"):
        monkeypatch.setenv(FLAG, off)
        assert sb.show_brief_enabled() is False
    # ships ON (Ryne): unset or empty means ON; the diagnostic profile turns every flag off
    monkeypatch.delenv(FLAG, raising=False)
    assert sb.show_brief_enabled() is True
    monkeypatch.setenv(FLAG, "")
    assert sb.show_brief_enabled() is True
    monkeypatch.setenv("ORWELL_FLAGS_OFF", "1")
    assert sb.show_brief_enabled() is False


def test_last_scene_tail_is_the_last_reply_without_asides_capped_to_40_words():
    history = [_Msg("assistant", "an older reply"), _Msg("user", "a question"),
               _Msg("assistant", " ".join(f"w{i}" for i in range(60)) + " ((an aside)) end.")]
    tail = sb.last_scene_tail(history + [_Msg("user", "the new message")])
    words = tail.split(" ")
    assert len(words) == 40 and words[-1] == "end." and "aside" not in tail
    assert sb.last_scene_tail([_Msg("user", "only a user line")]) is None
    assert sb.last_scene_tail([_Msg("assistant", "((only an aside))")]) is None
    assert sb.last_scene_tail(None) is None
    assert sb.last_scene_tail([{"role": "assistant", "content": "a dict row works too."}]) == "a dict row works too."
    assert sb.last_scene_tail([_Msg("assistant", ["not", "text"])]) is None


def test_asked_about_resolves_full_names_and_unique_first_names_only():
    assert sb.asked_about(["Where is Alpha?"], HOUSE) == ["npc:1"]
    # "Bravo" is ambiguous (two houseguests share it): only a full name counts.
    assert sb.asked_about(["Is Bravo around?"], HOUSE) == []
    assert sb.asked_about(["Is bravo other around? And alpha role?"], HOUSE) == ["npc:3", "npc:1"]
    assert sb.asked_about(["Charlie-Ann said hi"], HOUSE) == ["npc:4"]
    assert sb.asked_about(["Alphabet soup, Alphas"], HOUSE) == []  # word-bounded
    assert sb.asked_about([""], HOUSE) == []
    assert sb.asked_about(["Alpha", "Alpha again"], HOUSE) == ["npc:1"]  # no duplicates
    assert sb.asked_about(["Player One"], HOUSE + [{"id": "player", "name": "Player One"}]) == []


def test_build_request_carries_only_what_it_has():
    assert sb.build_request("s", {"house": HOUSE}, "hello", None) == {}
    sb._SEEN["owner-1"] = {"v": 1, "beatSeq": 4, "room": "kitchen", "here": [], "inView": []}
    req = sb.build_request("s", {"house": HOUSE}, "Where did Alpha go?", "Bravo Other waved.", user="owner-1")
    assert req == {"seen": sb._SEEN["owner-1"], "askedAbout": ["npc:1", "npc:3"], "lastShown": "Bravo Other waved."}


def test_stash_and_pop_are_per_session_one_shot_and_remember_what_was_served():
    sb.stash("A", {"showBrief": {"text": "BRIEF-A", "seen": {"v": 1, "beatSeq": 1}}})
    sb.stash("B", {"showBrief": {"text": "BRIEF-B", "seen": {"v": 1, "beatSeq": 2}}})
    assert sb.pop("B", "owner-B") == "BRIEF-B"
    assert sb.pop("A", "owner-A") == "BRIEF-A"
    assert sb.pop("A", "owner-A") is None
    # What was served is remembered per game OWNER (the narrator's tools only know the owner).
    assert sb._SEEN == {"owner-A": {"v": 1, "beatSeq": 1}, "owner-B": {"v": 1, "beatSeq": 2}}
    # A turn whose response has no brief clears any earlier one for that session only.
    sb.stash("A", {"showBrief": {"text": "STALE", "seen": None}})
    sb.stash("A", {"systemPrompt": "x"})
    assert sb.pop("A") is None
    sb.stash("C", {"showBrief": {"text": "   "}})
    assert sb.pop("C") is None
    sb.stash(None, {"showBrief": {"text": "DEFAULT"}})
    assert sb.pop(None) == "DEFAULT"


# ── the framing seam ─────────────────────────────────────────────────────────────────────────────────────────

def _patch_engine(monkeypatch, calls, served=None):
    async def fake_state(user=None, **kw):
        return {"started": True, "phase": "social", "moment": "social", "house": HOUSE}

    async def fake_status(user=None):
        return {"phase": "social"}

    async def no_advance(*a, **kw):
        raise AssertionError("no advance in this test")

    if served is None:
        # The legacy signature: a `brief` keyword would raise TypeError, proving the flag-off call is unchanged.
        async def fake_moment(moment, user=None):
            calls.append({"moment": moment})
            return {"systemPrompt": "MOMENT-PROMPT"}
    else:
        async def fake_moment(moment, user=None, brief=None):
            calls.append({"moment": moment, "brief": brief})
            return {"systemPrompt": "MOMENT-PROMPT", "showBrief": served}

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_moment)
    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "advance_game", no_advance)
    monkeypatch.setattr("src.settings.game_build_enabled", lambda: True)


def test_flag_off_calls_the_moment_prompt_exactly_as_before_and_stashes_nothing(monkeypatch):
    monkeypatch.setenv(FLAG, "0")
    calls = []
    _patch_engine(monkeypatch, calls)
    preface = []
    _, game_active, _ = _run(chat_helpers.apply_game_framing(preface, "u", False, session_id="sess-off", player_msg="Where is Alpha?"))
    assert game_active is True
    assert calls and all(set(c) == {"moment"} for c in calls)
    assert sb._STASH == {} and sb.pop("sess-off") is None
    assert preface[0]["content"].startswith("MOMENT-PROMPT")


def test_flag_on_asks_for_the_brief_and_stashes_it_by_session(monkeypatch):
    monkeypatch.setenv(FLAG, "1")
    calls = []
    served = {"text": "SHOW BRIEF. test", "seen": {"v": 1, "beatSeq": 9, "room": "kitchen", "here": ["npc:1"], "inView": []}}
    _patch_engine(monkeypatch, calls, served=served)
    preface = []
    _run(chat_helpers.apply_game_framing(preface, "u", False, session_id="sess-on", player_msg="Is Alpha Role here?",
                                         last_scene_tail="Bravo Other left for the yard."))
    req = calls[-1]["brief"]
    assert req == {"askedAbout": ["npc:1", "npc:3"], "lastShown": "Bravo Other left for the yard."}
    # The brief never rides in the leading system prompt (that is the cached prefix).
    assert "SHOW BRIEF" not in preface[0]["content"]
    assert sb.pop("sess-on", "u") == "SHOW BRIEF. test"
    # The next turn echoes what was served.
    _run(chat_helpers.apply_game_framing([], "u", False, session_id="sess-on", player_msg="ok"))
    assert calls[-1]["brief"]["seen"] == served["seen"]


def test_flag_on_a_failed_fetch_clears_any_stale_brief(monkeypatch):
    monkeypatch.setenv(FLAG, "1")
    _patch_engine(monkeypatch, [], served={"text": "OLD"})
    sb.stash("sess-x", {"showBrief": {"text": "OLD"}})

    async def boom(moment, user=None, brief=None):
        raise RuntimeError("engine hiccup")

    monkeypatch.setattr(orwell_engine, "get_moment_prompt", boom)
    _run(chat_helpers.apply_game_framing([], "u", False, session_id="sess-x"))
    assert sb.pop("sess-x") is None


def test_the_wrapper_sends_brief_only_when_given(monkeypatch):
    sent = []

    async def fake_call(name, args, user=None, timeout=None):
        sent.append((name, dict(args)))
        return {}

    monkeypatch.setattr(orwell_engine, "_call", fake_call)
    _run(orwell_engine.get_moment_prompt("social", user="u"))
    _run(orwell_engine.get_moment_prompt("social", user="u", brief={"lastShown": "x"}))
    assert sent == [("getMomentPrompt", {"moment": "social"}), ("getMomentPrompt", {"moment": "social", "brief": {"lastShown": "x"}})]


# ── source pins: where the brief rides in the assembled context ──────────────────────────────────────────────

def test_the_brief_is_appended_after_the_trim_and_right_before_hard_constraints():
    src = inspect.getsource(chat_helpers.build_chat_context)
    # Match the call, not its exact arguments (ORW-219 added `preserve_system=`; more may follow).
    trim = src.index("messages = trim_for_context(messages, context_length")
    brief = src.index("_brief_text = _show_brief.pop(session_id, user)")
    brief_append = src.index('messages = messages + [{"role": "system", "content": _brief_text}]')
    hc_append = src.index('messages = messages + [{"role": "system", "content": _hard_constraints}]')
    assert trim < brief < brief_append < hc_append
    # Off: the framing call carries no extra keyword and nothing is popped.
    assert "**_brief_kw," in src and "if _brief_kw:" in src


# ── the go-live gate: the brief survives the game-turn trim, in place (ORW-219, #2263) ────────────────────────

def test_the_game_turn_trim_keeps_the_brief_intact_and_terminal():
    from src.context_compactor import trim_for_context
    msgs = [{"role": "system", "content": "GM PROMPT " * 200}]
    for i in range(30):
        msgs += [{"role": "user", "content": f"turn {i} " * 40}, {"role": "assistant", "content": f"reply {i} " * 40}]
    msgs += [{"role": "user", "content": "now"},
             {"role": "system", "content": "SHOW BRIEF. test"},
             {"role": "system", "content": "HARD CONSTRAINTS — test"}]
    out = trim_for_context(msgs, 3000, preserve_system=True)
    assert len(out) < len(msgs), "the budget must actually force a trim"
    assert [m["content"] for m in out[-2:]] == ["SHOW BRIEF. test", "HARD CONSTRAINTS — test"]
    assert out[-3]["content"] == "now"
