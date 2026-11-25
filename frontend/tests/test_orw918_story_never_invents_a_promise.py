"""ORW-918 (Fable week-1 playtest, turn 149): a houseguest told the player "you told me you'd stay close this week, you said it in the kitchen". The player never said it.
The phrase was in the [Story so far] block: the utility model's summary of the closed day had turned the player's "I'll think on it overnight, and I won't tell anyone how
I'm voting before I tell you two" into a promise to stay close, in its prose, unquoted. The closed day's raw rows are no longer sent, so the narrator took the summary's word for
it. A summary line that has someone promise something must carry the promiser's own words, quoted, as they are in the day's text; a promise line that does not is dropped
before the summary is written. Roles only; no live model (the summariser is a stub)."""
import asyncio
import importlib

dc = importlib.import_module("src.orwell_day_condense")


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _author(summary, rows):
    writes = []

    async def ledger_fn():
        return [{"day": 3, "tier": "day"}]

    async def write_fn(day, text, tier="day", covers_days=None):
        writes.append(text)
        return {"accepted": True}

    async def llm(messages):
        return summary

    hist = [{"role": r, "content": c, "metadata": {"game_day": 3}} for r, c in rows]
    _run(dc.condense_day("u", 3, llm_fn=llm, history=hist, ledger_fn=ledger_fn, write_fn=write_fn))
    assert len(writes) == 1
    return writes[0]


DAY = [("user", "I'm sorry, both of you. I won't promise either of you my vote tonight, I don't make promises I might not keep."),
       ("user", "Heard. That counts with me. I'll think on it overnight, and I won't tell anyone how I'm voting before I tell you two."),
       ("assistant", "The nominee nods slowly. \"Telling me before you tell the room - that's the part that counts.\" Later the HOH names two houseguests at the ceremony.")]


def test_an_invented_unquoted_promise_is_dropped_and_the_rest_kept():
    out = _author("The HOH named two houseguests at the ceremony. - The player promised the nominee to stay close this week, in the kitchen. "
                  "The nominee took it well. Key list: the vote-first promise", DAY)
    assert "stay close" not in out, "the player never said it: a promise line with no quote from the day's text never reaches the narrator"
    assert "named two houseguests" in out and "took it well" in out and "Key list:" in out


def test_a_promise_quoted_from_the_text_is_kept():
    out = _author("The player promised the nominee: \"I won't tell anyone how I'm voting before I tell you two.\" The nominee took it well.", DAY)
    assert "before I tell you two" in out


def test_a_quote_that_is_not_in_the_text_does_not_save_the_line():
    out = _author("The player swore to the nominee: \"I'll stay close to you all week.\" The nominee took it well.", DAY)
    assert "stay close" not in out and "took it well" in out


def test_the_author_rule_asks_for_the_promisers_own_words():
    for msgs in (dc._day_messages(3, "x"), dc._chunk_messages(3, 1, 2, "x", 60), dc._merge_messages(3, ["a"], 120)):
        assert "own words" in msgs[0]["content"]
