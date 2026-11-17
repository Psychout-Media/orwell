"""ORW-554 follow-up: the narrator turn's ledger totals — cacheMissTokens fills every round, calls counts every round sent.

Drives the pure helpers `turn_cache_miss_tokens` / `turn_call_count` extracted from
`src/agent_loop.py` (the per-round fold the live loop hands to `orwell_token_ledger.record_turn`).
Fake DeepSeek-shaped usage dicts only — no model, no network, no store.
"""
import inspect

from src import agent_loop as al

# Three provider rounds of one narrator turn: round 1 reports hit+miss, round 2 reports the hit
# only (some providers omit the miss count), round 3's response carried no usage block at all.
R1 = {"input_tokens": 8000, "cached_tokens": 6000, "cache_miss_tokens": 2000}
R2 = {"input_tokens": 9000, "cached_tokens": 7000}          # no cache_miss_tokens field
R3 = None                                                    # no usage block returned


# ── bug 1: the turn's miss total ─────────────────────────────────────────────────────────────

def test_mixed_turn_derives_a_rounds_miss_from_input_minus_cached():
    # The bug case: round 2 reported cached tokens but no miss count, so the old sum dropped it and
    # cacheMissTokens (2000) no longer equalled inputTokens − cachedTokens (17000 − 13000).
    assert al.turn_cache_miss_tokens([R1, R2]) == 4000
    assert al.turn_cache_miss_tokens([R1, R2]) == (8000 + 9000) - (6000 + 7000)


def test_reported_miss_counts_win_over_the_derived_value():
    # A round that reports its miss uses the reported number, even if input − cached would differ.
    assert al.turn_cache_miss_tokens([{"input_tokens": 8000, "cached_tokens": 6000,
                                       "cache_miss_tokens": 1500}]) == 1500


def test_derived_miss_never_goes_below_zero():
    assert al.turn_cache_miss_tokens([{"input_tokens": 5000, "cached_tokens": 7000}]) == 0


def test_turn_with_no_cache_information_anywhere_stays_none():
    # Rounds with usage but no cache fields, and rounds with no usage at all ⇒ None: the ledger's
    # whole-turn derivation (input − hit) then stands.
    assert al.turn_cache_miss_tokens([{"input_tokens": 8000, "output_tokens": 300}]) is None
    assert al.turn_cache_miss_tokens([None, None]) is None
    assert al.turn_cache_miss_tokens([]) is None


def test_junk_rounds_are_skipped_not_fatal():
    assert al.turn_cache_miss_tokens([R1, "junk", {"cache_miss_tokens": "nope"}, 7]) == 2000


# ── bug 2: the turn's call count ─────────────────────────────────────────────────────────────

def test_calls_counts_every_round_sent_not_only_rounds_with_usage():
    # Three rounds sent, only two returned usage: the old `max(1, _usage_rounds)` counted 2.
    rounds_sent = 3
    with_usage = [R1, R2]  # R3 sent but returned no usage block
    assert al.turn_call_count(rounds_sent) == 3
    assert al.turn_call_count(len(with_usage)) == 2  # the OLD rule undercounts — pinned for contrast


def test_call_count_floors_at_one_and_coerces_junk():
    assert al.turn_call_count(0) == 1
    assert al.turn_call_count(-4) == 1
    assert al.turn_call_count("nope") == 1


# ── the full example the card names ──────────────────────────────────────────────────────────

def test_three_round_example_miss_is_4000_and_calls_is_3():
    rounds = [R1, R2, R3]                       # R3 never returned a usage block
    rounds_sent = len(rounds)                   # every round was actually sent
    assert al.turn_cache_miss_tokens([u for u in rounds if u]) == 4000
    assert al.turn_call_count(rounds_sent) == 3


# ── source pins: the loop actually routes the ledger entry through the helpers ───────────────

def test_record_turn_uses_the_helpers():
    src = inspect.getsource(al._stream_agent_loop_impl)
    assert "calls=turn_call_count(_rounds_sent)" in src
    assert "cache_miss_tokens=turn_cache_miss_tokens(_round_usages)" in src
    # the sent-counter increment sits BEFORE the provider stream opens (a round with no usage event
    # still counts), and the per-round usage capture replaced the old miss-only accumulator.
    assert src.index("_rounds_sent += 1") < src.index("async for chunk in _pd_bounded_stream(")
    assert "_usage_rounds" not in inspect.getsource(al)
    assert "real_cache_miss_tokens" not in inspect.getsource(al)


def test_a_round_with_no_cache_info_counts_its_whole_input_once_another_round_reports():
    # a round that reported usage but no cache fields had nothing cached: its whole input missed
    rounds = [
        {"input_tokens": 8000, "cached_tokens": 6000, "cache_miss_tokens": 2000},
        {"input_tokens": 3000, "cached_tokens": None, "cache_miss_tokens": None},
    ]
    assert al.turn_cache_miss_tokens(rounds) == 5000  # equals (8000 + 3000) - 6000
