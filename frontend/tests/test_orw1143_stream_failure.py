"""ORW-1143 (prod 2026-11-28: a chat_stream crash left the player with no reply and nobody was alerted). An exception inside the turn generator must give the client a neutral, retryable
error event, one failed ledger row (driver=error), one ops alert per session per 15 minutes (error class and session id only), and a retry that narrates a commit without making it twice.
Codes and names only: no player text is used or quoted here."""
import asyncio
import importlib
import json
import pathlib

import pytest

sf = importlib.import_module("src.orwell_stream_failure")
ledger = importlib.import_module("src.orwell_sync_ledger")
af = importlib.import_module("src.act_first")
log_rings = importlib.import_module("src.log_rings")
FE = pathlib.Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def clean(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "l.json")
    for d in (ledger._PENDING_BELTS, ledger._PENDING_FORCED, ledger._RECORDED, ledger._UNLEDGERED, af._COMMIT_MEMO, af._STASH):
        d.clear()
    sf.reset()
    yield


def _run(factory, **kw):
    async def go():
        return [c async for c in sf.guard_stream(factory, session=kw.pop("session", "sess-1"), user=kw.pop("user", "u1"), **kw)]
    return asyncio.run(go())


def _boom(msg="secret chat words"):
    async def gen():
        yield 'data: {"delta": "a"}\n\n'
        raise RuntimeError(msg)
    return gen


def test_a_generator_exception_gives_a_neutral_retryable_error_then_done():
    out = _run(_boom())
    err = next(c for c in out if c.startswith("event: error"))
    body = json.loads(err.split("data: ", 1)[1])
    assert body["error"] == sf.NEUTRAL_MESSAGE and body["retry"] is True and body["terminal"] is True and body["status"] == 500
    assert "secret chat words" not in "".join(out)  # the exception text never reaches the player
    assert out[-1] == "data: [DONE]\n\n"


def test_the_failed_turn_gets_exactly_one_row_with_driver_error():
    _run(_boom())
    rows = ledger.get_recent("u1")
    assert len(rows) == 1 and rows[0]["drivenBy"] == "error" and rows[0]["unledgered"] == "failed" and rows[0]["session"] == "sess-1"
    assert ledger.get_driver_totals("u1")["errorTurns"] == 1


def test_a_row_the_agent_loop_already_wrote_is_not_doubled():
    async def gen():
        ledger.record_unledgered_turn("u1", session="sess-1", reason="failed")  # the agent loop's own finally
        raise RuntimeError("x")
        yield  # pragma: no cover
    _run(lambda: gen())
    assert len(ledger.get_recent("u1")) == 1


def test_the_alert_fires_once_per_session_per_15_minutes_with_class_and_session_only(monkeypatch):
    calls = []
    monkeypatch.setattr(log_rings, "record_soft_failure", lambda cls, exc, **ctx: calls.append((cls, exc, ctx)))
    _run(_boom("words the player typed"))
    _run(_boom("words the player typed"))
    _run(_boom(), session="sess-2")
    assert [c[1] for c in calls] == ["RuntimeError session=sess-1", "RuntimeError session=sess-2"]
    assert all(c[0] == "chat-stream:generator-failed" and "words" not in c[1] for c in calls)
    t = 10_000.0
    sf._ALERTED["sess-1"] = t
    assert sf._alert_due("sess-1", t + 899) is False and sf._alert_due("sess-1", t + 901) is True


def test_a_clean_stream_raises_nothing(monkeypatch):
    calls = []
    monkeypatch.setattr(log_rings, "record_soft_failure", lambda *a, **k: calls.append(a))

    async def ok():
        yield 'data: {"delta": "a"}\n\n'
        yield "data: [DONE]\n\n"
    out = _run(lambda: ok())
    assert out[-1] == "data: [DONE]\n\n" and not any("event: error" in c for c in out) and calls == [] and ledger.get_recent("u1") == []


def test_a_stream_that_ends_without_done_is_closed_with_a_retryable_terminal():
    async def empty():
        return
        yield  # pragma: no cover
    out = _run(lambda: empty())
    assert json.loads(out[0].split("data: ", 1)[1])["retry"] is True and out[-1] == "data: [DONE]\n\n"


def test_a_client_disconnect_is_not_a_failure(monkeypatch):
    calls = []
    monkeypatch.setattr(log_rings, "record_soft_failure", lambda *a, **k: calls.append(a))

    async def gone():
        yield "x"
        raise asyncio.CancelledError()

    async def go():
        return [c async for c in sf.guard_stream(lambda: gone(), session="s", user="u1")]
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(go())
    assert calls == [] and ledger.get_recent("u1") == []


def test_on_finish_runs_after_a_failure():
    done = []
    _run(_boom(), on_finish=lambda: done.append(1))
    assert done == [1]


# ── (3) the retry narrates a commit and never makes it twice ─────────────────────────────────
class _Eng:
    def __init__(self):
        self.calls = []

    async def get_game_state(self, user=None, **k):
        return {"started": True, "house": []}

    async def game_status(self, user=None):
        return {"pending": {}}

    async def whereabouts(self, user=None):
        return {"room": "lounge"}

    async def resolve_player_move(self, *a, **k):
        self.calls.append(a)
        return {}


def test_a_retry_after_a_commit_narrates_it_and_commits_nothing_again(monkeypatch):
    pm = importlib.import_module("src.orwell_player_move")
    monkeypatch.setenv("ORWELL_ACT_FIRST", "1")
    eng = _Eng()
    model_calls = []

    async def call(**k):
        model_calls.append(k)
        return []
    # the first turn committed, then died: its memo is flagged failed
    af.put_commit_memo("u1", "cm-1", ["The player is NOW in kitchen: voice the move."])
    sf.handle("u1", "sess-1", RuntimeError("x"))
    assert af._COMMIT_MEMO["u1"]["failed"] is True
    ok = asyncio.run(pm.act_first_before_narrator(af.RETRY_PREFIX + " - please answer my last message.", "u1", "cm-2", sess=type("S", (), {"endpoint_url": "", "model": "m"})(), engine=eng, call=call))
    assert ok is True and eng.calls == [] and model_calls == []  # no engine commit, no model call
    st = af.take_stash("u1")
    assert st["outcome"] == "retry-after-failure" and st["done"] == [] and any("kitchen" in n for n in st["notes"])
    assert "u1" not in af._COMMIT_MEMO  # consumed once


def test_an_unrelated_message_is_not_swallowed_by_the_memo():
    af.put_commit_memo("u1", "cm-1", ["n"])
    af.mark_turn_failed("u1")
    assert af.take_retry_memo("u1", "I go to the kitchen", "cm-9") is None
    assert af.take_retry_memo("u1", "anything", "cm-1") is not None  # the same client message id re-sent is the retry


def test_a_memo_of_a_turn_that_did_not_fail_never_replays():
    af.put_commit_memo("u1", "cm-1", ["n"])
    assert af.take_retry_memo("u1", af.RETRY_PREFIX, "cm-1") is None


def test_the_client_retry_message_matches_the_server_prefix_and_the_error_frame_gets_a_retry_control():
    js = (FE / "static" / "js" / "chat.js").read_text(encoding="utf-8")
    assert f'handleChatSubmit(null, "{af.RETRY_PREFIX}' in js
    assert "if (json.retry) {" in js and "_renderStreamDropRetry(roundHolder || holder, streamSessionId" in js
    route = (FE / "routes" / "chat_routes.py").read_text(encoding="utf-8")
    assert "_sf.guard_stream(stream_with_save" in route
