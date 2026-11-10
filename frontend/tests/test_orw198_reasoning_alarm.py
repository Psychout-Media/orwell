"""ORW-198: a turn whose model reasoned for more than REASONING_ALARM_TOKENS is flagged - a warning log line and a slow-turn list in the admin token-economy summary (ids and counts only)."""
import logging

from src import orwell_token_ledger as tl


def test_reasoning_alarm_threshold():
    assert tl.reasoning_alarm({"reasoningTokens": tl.REASONING_ALARM_TOKENS + 1}) is True
    assert tl.reasoning_alarm({"reasoningTokens": tl.REASONING_ALARM_TOKENS}) is False
    assert tl.reasoning_alarm({"reasoningTokens": 1555}) is False
    assert tl.reasoning_alarm({}) is False
    assert tl.reasoning_alarm({"reasoningTokens": "not a number"}) is False


def test_slow_turn_logs_a_warning_and_a_fast_turn_logs_info(caplog):
    with caplog.at_level(logging.INFO, logger=tl.logger.name):
        tl._log_line("u", {"turnId": "t1", "reasoningTokens": 9951})
        tl._log_line("u", {"turnId": "t2", "reasoningTokens": 900})
    by_turn = {("t1" if "turn=t1" in r.getMessage() else "t2"): r.levelno for r in caplog.records if "token-ledger turn" in r.getMessage()}
    assert by_turn["t1"] == logging.WARNING
    assert by_turn["t2"] == logging.INFO


def test_admin_summary_lists_slow_turns(monkeypatch):
    from routes import admin_health_routes as ahr
    entries = [
        {"turnId": "a", "session": "s", "reasoningTokens": 4561, "cost": 0.0},
        {"turnId": "b", "session": "s", "reasoningTokens": 1200, "cost": 0.0},
        {"turnId": "c", "session": "s", "reasoningTokens": 9951, "cost": 0.0},
    ]
    monkeypatch.setattr(tl, "get_recent", lambda user, limit=200: entries)
    out = ahr._token_economy("u")
    s = out["summary"]
    assert s["reasoningAlarmTokens"] == tl.REASONING_ALARM_TOKENS
    assert s["reasoningAlarmCount"] == 2
    assert [a["turnId"] for a in s["reasoningAlarms"]] == ["a", "c"]
    assert all(set(a) == {"turnId", "session", "reasoningTokens"} for a in s["reasoningAlarms"])
