"""ORW-266 / ADR 0010 slice D: context tiering is ON by default and only ever GROWS the input budget. Proves it can never
cost the prompt anything required: every system message (the GM prompt, the HARD CONSTRAINTS block, a pending decision
card) survives a game-turn trim at the lean budget AND at the escalated budget, and tiering keeps a superset of what
the lean budget keeps (history is kept, never lost). No model, roles only."""
from src.context_budget import escalate_budget
from src.context_compactor import estimate_tokens, trim_for_context
from src.settings import DEFAULT_SETTINGS


def _convo(n: int):
    msgs = [
        {"role": "system", "content": "GM PROMPT " + "x" * 400},
        {"role": "system", "content": "DECISION CARD pending " + "y" * 200},
    ]
    for i in range(n):
        msgs.append({"role": "user" if i % 2 == 0 else "assistant", "content": f"turn {i} " + "z" * 300})
    msgs.append({"role": "system", "content": "HARD CONSTRAINTS: never leak. " + "h" * 200})
    return msgs


def test_tiering_is_on_by_default():
    assert DEFAULT_SETTINGS["context_tiering_enabled"] is True


def test_system_messages_survive_lean_and_escalated_budgets_and_tiering_keeps_a_superset():
    messages = _convo(60)
    needed = estimate_tokens(messages)
    lean = needed // 4
    window = needed * 3
    escalated = escalate_budget(lean, needed, window, enabled=True)
    assert escalated > lean
    lean_kept = trim_for_context(list(messages), lean, reserve_tokens=0, preserve_system=True)
    big_kept = trim_for_context(list(messages), escalated, reserve_tokens=0, preserve_system=True)
    systems = [m["content"] for m in messages if m["role"] == "system"]
    for kept in (lean_kept, big_kept):
        assert [m["content"] for m in kept if m["role"] == "system"] == systems  # all intact, in place
    lean_ids = {m["content"] for m in lean_kept}
    assert lean_ids <= {m["content"] for m in big_kept}
    assert len(big_kept) > len(lean_kept)


def test_tiering_off_is_the_lean_budget_unchanged():
    assert escalate_budget(6000, 90000, 200000, enabled=False) == 6000
