"""ORW-333 - the narrator's request stays bounded across a season: closed in-game days leave the SENT history (ORW-271), so the per-turn input is the GM prompt
+ one day's rows, not the whole season. Offline, no model, no engine: the real `apply_prompt_view` + `estimate_tokens` over a synthetic stamped history.

Measured when this was written (K = turns per in-game day, ~370 tokens per assistant row, 76k-char GM prompt; peak input tokens on day 1 / 7 / 14 / 28):
  K=20  raw 31k / 190k / 360k  -> with the view 31k / 33k / 33k / 35k
  K=60  raw 49k / 360k / ...   -> with the view 49k / 50k / 51k / 53k
  K=120 raw 74k / 690k / ...   -> with the view 74k / 76k / 77k / 78k
The bound is one day's rows: a single very long day is still unbounded within the day (the day is the player's to end). Week chapters (ORW-275) are the
on-screen reset only; this view is what shrinks the MODEL request. Roles only; no names.
"""
from src import orwell_day_condense as dc
from src.model_context import estimate_tokens

SYS = {"role": "system", "content": "g" * 76000}
ASSIST = "a" * 1400


def _season(turns_per_day, days, *, with_ledger=True):
    hist, ledger, peaks = [SYS], [], []
    for d in range(1, days + 1):
        peak = 0
        for _ in range(turns_per_day):
            hist.append({"role": "user", "content": "go on", "metadata": {"game_day": d}})
            hist.append({"role": "assistant", "content": ASSIST, "metadata": {"game_day": d}})
            sent = dc.apply_prompt_view(list(hist), ledger) if with_ledger else hist
            peak = max(peak, estimate_tokens(sent))
        peaks.append(peak)
        ledger.append({"tier": "day", "day": d, "events": ["event one", "event two", "event three"]})  # the engine floor entry at each turnIn
    return peaks, hist


def test_per_turn_input_does_not_grow_with_the_number_of_closed_days():
    peaks, _ = _season(30, 21)
    assert peaks[-1] - peaks[1] < 4000, peaks  # day 21 costs about what day 2 does


def test_without_the_view_the_same_history_grows_without_bound_the_control():
    peaks, _ = _season(30, 6, with_ledger=False)
    assert peaks[-1] > 2 * peaks[0], peaks


def test_stored_history_is_never_shortened_only_the_sent_copy():
    peaks, hist = _season(10, 5)
    assert len(hist) == 1 + 10 * 2 * 5  # every row is still in the stored history (mandate #4)


def test_a_day_with_no_engine_entry_stays_raw_so_nothing_is_lost_before_it_is_summarised():
    msgs = [SYS] + [{"role": "assistant", "content": ASSIST, "metadata": {"game_day": 1}} for _ in range(5)]
    assert dc.apply_prompt_view(msgs, [{"tier": "day", "day": 7, "events": ["x"]}]) == msgs
