"""ORW-555: once the history no longer fits the input budget, the game-turn trim cuts down to a target share of the budget in one go and HOLDS that cut while the
request still fits, so consecutive requests share the same history prefix (a provider's prefix cache can match it) instead of the cut moving one turn every turn."""
import json

from src import context_compactor as cc


def _turns(n, chars=2400):
    out = []
    for i in range(n):
        out.append({"role": "user", "content": f"player line {i} " + "p" * chars})
        out.append({"role": "assistant", "content": f"narration {i} " + "n" * chars})
    return out


def _wire(n, budget=48_000):
    sys_msg = {"role": "system", "content": "S" * 76_000}
    msgs = [sys_msg] + _turns(n)
    return cc.trim_for_context(msgs, budget, preserve_system=True)


def _shared(a, b):
    sa, sb = json.dumps(a), json.dumps(b)
    i = 0
    while i < min(len(sa), len(sb)) and sa[i] == sb[i]:
        i += 1
    return i / len(sb)


def test_the_cut_is_held_so_consecutive_turns_share_the_history_prefix(monkeypatch):
    monkeypatch.delenv("ORWELL_TRIM_HYSTERESIS", raising=False)
    cc._TRIM_CUTS.clear()
    wires = [_wire(80 + k) for k in range(6)]
    shares = [_shared(wires[k - 1], wires[k]) for k in range(1, 6)]
    assert min(shares) > 0.9, shares
    for w in wires:
        assert cc.estimate_tokens(w) <= 48_000  # never over the budget


def test_off_the_cut_moves_every_turn(monkeypatch):
    monkeypatch.setenv("ORWELL_TRIM_HYSTERESIS", "0")
    cc._TRIM_CUTS.clear()
    wires = [_wire(80 + k) for k in range(4)]
    shares = [_shared(wires[k - 1], wires[k]) for k in range(1, 4)]
    assert max(shares) < 0.7, shares


def test_under_budget_nothing_is_cut(monkeypatch):
    monkeypatch.delenv("ORWELL_TRIM_HYSTERESIS", raising=False)
    cc._TRIM_CUTS.clear()
    msgs = [{"role": "system", "content": "S" * 1000}] + _turns(3, chars=100)
    assert cc.trim_for_context(msgs, 48_000, preserve_system=True) == msgs


def test_the_system_messages_and_the_newest_turn_always_stay(monkeypatch):
    monkeypatch.delenv("ORWELL_TRIM_HYSTERESIS", raising=False)
    cc._TRIM_CUTS.clear()
    w = _wire(90)
    assert w[0]["role"] == "system" and w[0]["content"].startswith("S")
    assert w[-1]["content"].startswith("narration 89")
