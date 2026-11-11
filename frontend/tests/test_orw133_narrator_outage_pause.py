"""ORW-133 (Ryne's ruling): narrator outage => the game HOLDS, says so, retries with bounded backoff, resumes with
nothing lost. Account faults (402) never retry, alert the operator once, and read distinctly. Stubbed provider
errors only - no network, no model. Roles only."""
import asyncio
import json
import os

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_GOOD = ['data: ' + json.dumps({"delta": "The kitchen goes quiet as you walk in."}) + '\n\n',
         'data: ' + json.dumps({"type": "finish", "reason": "stop"}) + '\n\n', "data: [DONE]\n\n"]


def _err(status, text="boom"):
    return 'event: error\ndata: ' + json.dumps({"status": status, "text": text}) + '\n\n'


def _drive(monkeypatch, scripts, *, record=None):
    """Drive the REAL stream_agent_loop; scripts = per-call list of chunk lists. Returns (chunks, calls, sleeps)."""
    from src import agent_loop as al
    monkeypatch.setenv("ORWELL_GAME_BUILD", "1")
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: default)
    import src.tool_index as ti
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)
    al._OUTAGE_ALERTED.clear()
    calls = {"n": 0}
    sleeps = []

    async def fake_stream(candidates, messages, **kw):
        i = min(calls["n"], len(scripts) - 1)
        calls["n"] += 1
        for c in scripts[i]:
            yield c

    async def fake_sleep(d):
        if d >= 2.0:   # only the outage backoff; unrelated short engine-retry sleeps are not under test
            sleeps.append(d)

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setattr(al.asyncio, "sleep", fake_sleep)
    if record is not None:
        from src import enrichment_policy as ep
        monkeypatch.setattr(ep, "record_runtime_failure", lambda *a, **k: record.append(a))
    # any consequence belt firing during a paused turn is a failure of the ruling
    belts = []

    async def no_belt(*a, **k):
        belts.append(1)
        return False
    monkeypatch.setattr(al, "_auto_record_scene", no_belt)
    out = []

    async def run():
        gen = al.stream_agent_loop(
            "https://api.openai.com/v1/chat/completions", "deepseek/deepseek-v4-pro",
            [{"role": "system", "content": "You are Big Brother, the narrator."},
             {"role": "user", "content": "Take a slow lap around the house."}],
            max_rounds=4, game_mode="game", owner=None)
        async for c in gen:
            out.append(c)

    asyncio.run(run())
    return out, calls, sleeps, belts


def _text(chunks):
    t = []
    for c in chunks:
        if c.startswith("data: ") and not c.startswith("data: [DONE]"):
            try:
                ev = json.loads(c[6:])
            except Exception:
                continue
            if isinstance(ev, dict) and ev.get("delta") and not ev.get("thinking"):
                t.append(ev["delta"])
    return "".join(t)


def test_transient_outage_retries_then_resumes_with_the_real_scene(monkeypatch):
    out, calls, sleeps, _ = _drive(monkeypatch, [[_err(503)], [_err(429)], _GOOD])
    assert calls["n"] == 3 and sleeps == [2.0, 5.0]          # bounded backoff, no extra rounds
    assert "kitchen goes quiet" in _text(out)
    assert sum('"narrator_away"' in c for c in out) == 2     # the player is told, each retry
    assert not any('"narrator_paused"' in c for c in out)
    assert not any(c.startswith("event: error") for c in out)  # a recovered blip is never an interlude


def test_long_outage_pauses_with_one_honest_line_and_runs_no_belt(monkeypatch):
    from src import agent_loop as al
    rec = []
    out, calls, sleeps, belts = _drive(monkeypatch, [[_err(503)]], record=rec)
    assert calls["n"] == 1 + len(al._OUTAGE_BACKOFF_S) and sleeps == list(al._OUTAGE_BACKOFF_S)
    text = _text(out)
    assert text == al._NARRATOR_AWAY_LINE                    # exactly one paused line, once
    assert "technical interlude" not in text and "again in a moment" not in text
    assert not belts                                         # no auto-record / fake scene fold
    assert not any('"type": "agent_step"' in c for c in out)  # no nudge rounds either
    assert len(rec) == 1                                     # one operator alert


def test_402_never_retries_alerts_once_and_reads_distinctly(monkeypatch):
    from src import agent_loop as al
    rec = []
    out, calls, sleeps, belts = _drive(monkeypatch, [[_err(402, "Insufficient Balance")]], record=rec)
    assert calls["n"] == 1 and sleeps == []                  # no retry loop against a 402
    assert _text(out) == al._NARRATOR_ACCOUNT_LINE != al._NARRATOR_AWAY_LINE
    assert len(rec) == 1 and "insufficient balance (402)" in rec[0][2]
    assert not belts


def test_alert_fires_once_across_repeated_402_turns(monkeypatch):
    from src import agent_loop as al
    rec = []
    _drive(monkeypatch, [[_err(402)]], record=rec)

    async def again():
        async for _ in al._narrator_stream_with_outage_pause([("u", "m", {})], [], owner='default'):
            pass
    asyncio.run(again())
    assert len(rec) == 1


def test_non_outage_4xx_passes_through_untouched(monkeypatch):
    from src import agent_loop as al
    out, calls, sleeps, _ = _drive(monkeypatch, [[_err(400)]])
    assert calls["n"] >= 1 and sleeps == []
    assert not any('"narrator_' in c for c in out)


def test_outage_lines_leak_no_machinery():
    from src import agent_loop as al
    for line in (al._NARRATOR_AWAY_LINE, al._NARRATOR_ACCOUNT_LINE):
        low = line.lower()
        for bad in ("error", "402", "503", "provider", "deepseek", "model", "token", "engine", "api", "balance"):
            assert bad not in low, bad


def test_paused_lines_are_dropped_from_the_models_next_context():
    from src import agent_loop as al
    msgs = [{"role": "user", "content": "hi"},
            {"role": "assistant", "content": al._NARRATOR_AWAY_LINE},
            {"role": "assistant", "content": al._NARRATOR_ACCOUNT_LINE}]
    assert al._drop_fallback_turns(msgs) == [msgs[0]]


def test_chat_js_handles_the_typed_outage_events():
    src = open(os.path.join(FRONTEND, "static", "js", "chat.js"), encoding="utf-8").read()
    assert "json.type === 'narrator_away'" in src and "narrator_paused" in src
