"""ORW-555 (prompt prefix cache): on a live-season turn the per-turn tail of the framing (the engine's game context from "- Week: " on, plus the per-turn
directives) and the datetime are sent AFTER the history, just before the player's message, so the static head, the agent preamble and the whole history are an
exact prefix from one turn to the next (DeepSeek's cache matches the exact prefix; a miss costs about 50 times a hit). The model receives the same text."""
import json

from routes import chat_helpers as ch
from src import agent_loop as al

HEAD = "BASE GAME MASTER RULES (static)\n\nWORLD (season-fixed)\n\nMOMENT — The house is social."
PREAMBLE = "GAME AGENT PREAMBLE (static tool contract)"


def tail(turn):
    return f"\n- Week: 2\n- Time of day: evening (turn {turn})\n- Who is here: ...\n\nPENDING BARRIER for turn {turn}"


def request(turn, history, owner="u555"):
    """One turn's messages the way the agent loop merges them: framing (head + tail) + preface, then the agent preamble, then history and the player's message."""
    t = tail(turn)
    ch._LAST_FRAMED_GM_TAIL[owner] = t
    system0 = {"role": "system", "content": HEAD + t + "\n\nslim policy (static)\n\n" + PREAMBLE}
    msgs = [system0, *history, {"role": "user", "content": f"player message {turn}"}]
    return al._send_per_turn_tail_last(msgs, owner, f"## Current date and time\nToday ... {turn:02d}:00 UTC")


def serial(msgs):
    return "".join(json.dumps(m, sort_keys=True) for m in msgs)


def test_the_tail_and_datetime_move_after_the_history_with_the_same_text():
    hist = [{"role": "user", "content": "earlier"}, {"role": "assistant", "content": "reply"}]
    out = request(7, hist)
    assert tail(7) not in out[0]["content"] and out[0]["content"].startswith(HEAD) and PREAMBLE in out[0]["content"]
    assert out[1:3] == hist
    assert out[-1] == {"role": "user", "content": "player message 7"}
    moved = out[-2]
    assert moved["role"] == "system" and moved["content"].startswith("- Week: 2") and "PENDING BARRIER for turn 7" in moved["content"] and "07:00 UTC" in moved["content"]
    # the same text reaches the model: nothing dropped, nothing added
    before = HEAD + tail(7) + "slim policy (static)" + PREAMBLE + "07:00 UTC"
    after = "".join(m["content"] for m in out if m["role"] == "system")
    for piece in ("BASE GAME MASTER RULES", "PENDING BARRIER for turn 7", "slim policy (static)", PREAMBLE, "07:00 UTC"):
        assert piece in after and piece in before


def test_consecutive_turns_share_the_static_head_preamble_and_history_as_an_exact_prefix():
    h1 = [{"role": "user", "content": "u1"}, {"role": "assistant", "content": "a1"}]
    r1 = request(1, h1)
    h2 = h1 + [{"role": "user", "content": "player message 1"}, {"role": "assistant", "content": "a2"}]
    r2 = request(2, h2)
    stable1 = serial(r1[:-2])  # everything before turn 1's own tail and message
    assert serial(r2).startswith(stable1), "turn 2's request starts with turn 1's static head, preamble and history"


def test_nothing_recorded_or_flag_off_keeps_the_old_layout(monkeypatch):
    msgs = [{"role": "system", "content": HEAD + "\n\n" + PREAMBLE}, {"role": "user", "content": "hi"}]
    ch._LAST_FRAMED_GM_TAIL.pop("nobody", None)
    out = al._send_per_turn_tail_last(msgs, "nobody", "")
    assert out == msgs
    monkeypatch.setenv("ORWELL_PROMPT_CACHE_ORDER", "0")
    assert al.prompt_cache_order_enabled() is False
    monkeypatch.delenv("ORWELL_PROMPT_CACHE_ORDER")
    assert al.prompt_cache_order_enabled() is True
