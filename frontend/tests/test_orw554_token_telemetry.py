"""ORW-554 — token-cost telemetry: call site, model, cache hit/miss, calls, played day, the daily roll-up, the report.

Fake DeepSeek usage payloads only; no model, no network, no secrets. The store path is redirected to tmp.
"""
import asyncio
import importlib
import json
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.usefixtures("non_game_text_routing")

ledger = importlib.import_module("src.orwell_token_ledger")
llm_core = importlib.import_module("src.llm_core")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
report = importlib.import_module("orwell_token_report")

URL = "https://api.deepseek.com/chat/completions"
# the real DeepSeek usage shape (hit + miss add up to prompt_tokens)
USAGE = {"prompt_tokens": 8000, "completion_tokens": 300, "total_tokens": 8300,
         "prompt_tokens_details": {"cached_tokens": 6000}, "prompt_cache_hit_tokens": 6000,
         "prompt_cache_miss_tokens": 2000, "completion_tokens_details": {"reasoning_tokens": 40}}


@pytest.fixture(autouse=True)
def _tmp_store(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "orwell_token_ledger.json")
    monkeypatch.setattr(ledger, "_GAME_DAY", {})


def _rec(**kw):
    base = dict(session="s1", call_class="background-authoring", input_tokens=8000, cached_tokens=6000,
                output_tokens=300, cost=0.001)
    base.update(kw)
    ledger.record_turn("player", **base)


# ── entry shape ──────────────────────────────────────────────────────────────────────────────

def test_entry_carries_site_model_miss_calls_day():
    _rec(call_site="npc-minds", model="deepseek-v4-flash", cache_miss_tokens=2000, calls=3, day=4)
    e = ledger.get_recent("player")[0]
    assert (e["callSite"], e["model"], e["cacheMissTokens"], e["calls"], e["day"]) == ("npc-minds", "deepseek-v4-flash", 2000, 3, 4)


def test_miss_derived_from_input_minus_hit_when_not_reported():
    _rec(cache_miss_tokens=None)
    assert ledger.get_recent("player")[0]["cacheMissTokens"] == 2000


def test_site_falls_back_to_call_class_and_junk_is_coerced():
    _rec(call_site=None, call_class="portrait")
    _rec(call_site="x" * 500, model={"body": "secret"}, cache_miss_tokens="nope", calls=-4, day="d")
    a, b = ledger.get_recent("player")
    assert a["callSite"] in ("portrait",) or a["callSite"]  # a stack-inferred or class name, never empty
    assert len(b["callSite"]) <= 80 and isinstance(b["model"], str) and len(b["model"]) <= 80
    assert b["cacheMissTokens"] == 0 and b["calls"] == 1 and b["day"] == 0


def test_no_free_text_field_added():
    _rec(call_site="npc-minds", model="m")
    for k, v in ledger.get_recent("player")[0].items():
        assert isinstance(v, (int, float, str, bool)), k


# ── call-site inference ──────────────────────────────────────────────────────────────────────

def test_scope_wins_over_stack():
    with ledger.call_site_scope("look-pass"):
        _rec()
    assert ledger.get_recent("player")[0]["callSite"] == "look-pass"
    _rec()
    assert ledger.get_recent("player")[1]["callSite"] != "look-pass"


def test_infer_names_module_through_await_chain():
    # a coroutine whose module name is a known site: fake it with a function whose globals say so
    ns = {"__name__": "src.orwell_day_condense", "ledger": ledger}
    exec("async def _summarise_day():\n    return ledger.infer_call_site()\n", ns)
    assert asyncio.run(ns["_summarise_day"]()) == "day-condense"


def test_infer_skips_plumbing_frames():
    # a frame in a plumbing module, with nothing above it, names no site
    ns = {"__name__": "src.llm_core", "ledger": ledger}
    exec("def _x():\n    return ledger.infer_call_site()\n", ns)
    assert ns["_x"]() == ""


def test_infer_sees_through_the_cast_authoring_closures():
    # Utility spend runs through cast authoring's `_fn` -> `_once` closures; the site is whoever called `_fn`, not
    # "cast-authoring". Built here the way the real module nests them, called from a day-condense coroutine.
    ca = {"__name__": "src.orwell_cast_authoring", "ledger": ledger}
    exec(
        "def make():\n"
        "    async def _once(m, cap):\n"
        "        return ledger.infer_call_site()\n"
        "    async def _fn(m):\n"
        "        return await _once(m, 1)\n"
        "    return _fn\n",
        ca,
    )
    dc = {"__name__": "src.orwell_day_condense", "fn": ca["make"]()}
    exec("async def _summarise_day():\n    return await fn([])\n", dc)
    assert asyncio.run(dc["_summarise_day"]()) == "day-condense"
    # ...and the real module still names its closures so: a rename would relabel every utility call "cast-authoring"
    import inspect

    from src import orwell_cast_authoring

    src = inspect.getsource(orwell_cast_authoring)
    assert "    async def _once(" in src and "    async def _fn(" in src


# ── played day ───────────────────────────────────────────────────────────────────────────────

def test_note_game_day_stamps_entries_and_ignores_junk():
    ledger.note_game_day("player", 7)
    ledger.note_game_day("player", "bad")
    ledger.note_game_day("player", -1)
    _rec()
    assert ledger.get_recent("player")[0]["day"] == 7


# ── roll-up ──────────────────────────────────────────────────────────────────────────────────

def test_rollup_sums_by_site_model_and_day():
    ledger.note_game_day("player", 2)
    _rec(call_site="npc-minds", model="m1", cost=0.01, calls=1)
    _rec(call_site="npc-minds", model="m1", cost=0.02, calls=2)
    _rec(call_site="day-condense", model="m1", cost=0.5, cached_tokens=0, cache_miss_tokens=8000)
    roll = ledger.get_rollup("player")
    (date, rows), = roll["daily"].items()
    nm = rows["npc-minds|m1"]
    assert nm["calls"] == 3 and nm["cost"] == pytest.approx(0.03)
    assert nm["cacheHitTokens"] == 12000 and nm["cacheMissTokens"] == 4000
    assert rows["day-condense|m1"]["cacheHitTokens"] == 0
    assert roll["gameDays"]["s1:2"]["cost"] == pytest.approx(0.53)


def test_rollup_outlives_the_500_ring_and_is_bounded(monkeypatch):
    monkeypatch.setattr(ledger, "_MAX_PER_USER", 3)
    for _ in range(10):
        _rec(call_site="a", model="m", cost=0.1)
    assert len(ledger.get_recent("player", 50)) == 3
    (rows,) = ledger.get_rollup("player")["daily"].values()
    assert rows["a|m"]["calls"] == 10  # the roll-up kept all ten


def test_rollup_is_per_user_and_clear_drops_it():
    ledger.record_turn("other", call_site="a", cost=1.0)
    _rec(call_site="a", cost=2.0)
    assert ledger.get_rollup("other")["daily"]
    ledger.clear("other")
    assert ledger.get_rollup("other") == {}
    assert ledger.get_rollup("player")["daily"]
    assert ledger.get_recent("other") == []


def test_old_ledger_file_without_rollup_still_loads():
    ledger.LEDGER_PATH.write_text(json.dumps({"player": [{"session": "s1", "cost": 0.5}]}))
    assert ledger.game_cost_total("player", "s1") == 0.5
    _rec(call_site="a")
    assert ledger.get_rollup("player")["daily"]


def test_hit_rate_helper():
    assert ledger.cache_hit_rate(6000, 2000) == 0.75
    assert ledger.cache_hit_rate(0, 0) is None


# ── usage capture from the provider payload ──────────────────────────────────────────────────

def test_non_stream_usage_sink_gets_miss_and_model(monkeypatch):
    class R:
        status_code = 200
        is_success = True
        text = "x"
        headers = {}
        content = b"x"
        def json(self):
            return {"choices": [{"message": {"content": "hello"}, "finish_reason": "stop"}], "usage": USAGE}

    class C:
        async def post(self, *a, **k):
            return R()

    monkeypatch.setattr(llm_core, "_get_http_client", lambda: C())
    sink = {}
    asyncio.run(llm_core._llm_call_async_impl(
        URL, "deepseek-v4-flash", [{"role": "user", "content": "hi"}], usage_sink=sink, meta_sink={}))
    assert sink["cached_tokens"] == 6000 and sink["cache_miss_tokens"] == 2000
    assert sink["input_tokens"] == 8000 and sink["reasoning_tokens"] == 40
    # computed cost: 6000 hit + 2000 miss + 300 out at the published off/peak rates, always positive and estimated
    assert sink["cost"] > 0 and sink["cost_estimated"] is True and sink["model"] == "deepseek-v4-flash"


def test_stream_usage_event_carries_miss(monkeypatch):
    chunk = {"id": "x", "model": "deepseek-v4-flash", "usage": USAGE,
             "choices": [{"index": 0, "delta": {"content": "hi"}, "finish_reason": "stop"}]}

    class Resp:
        status_code = 200
        async def aiter_lines(self):
            yield "data: " + json.dumps(chunk)
            yield "data: [DONE]"
        async def aread(self):
            return b""
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False

    class C:
        def stream(self, *a, **k):
            return Resp()

    monkeypatch.setattr(llm_core, "_get_http_client", lambda: C())

    async def go():
        return [e async for e in llm_core.stream_llm(URL, "deepseek-v4-flash", [{"role": "user", "content": "hi"}], max_tokens=30)]

    events = asyncio.run(go())
    usage = [json.loads(e[6:])["data"] for e in events if e.startswith("data: {") and json.loads(e[6:]).get("type") == "usage"]
    assert usage and usage[0]["cache_miss_tokens"] == 2000 and usage[0]["cached_tokens"] == 6000


def test_cost_uses_hit_and_miss_rates():
    base = llm_core._deepseek_cost_estimate("deepseek-v4-flash", 8000, 6000, 300)
    allmiss = llm_core._deepseek_cost_estimate("deepseek-v4-flash", 8000, 0, 300)
    assert 0 < base < allmiss


# ── the report ───────────────────────────────────────────────────────────────────────────────

def _seed():
    ledger.note_game_day("player", 1)
    _rec(call_site="narrator-turn", model="m", cost=0.30, cached_tokens=2000, cache_miss_tokens=6000, calls=4)
    _rec(call_site="npc-minds", model="m", cost=0.05, cached_tokens=7900, cache_miss_tokens=100)
    ledger.note_game_day("player", 2)
    _rec(call_site="narrator-turn", model="m", cost=0.10, cached_tokens=6000, cache_miss_tokens=2000)


def test_report_per_site_hit_rate_and_cost_per_day():
    _seed()
    ledger.drain_pending_writes()
    rep = report.build_report(json.loads(ledger._rollup_path().read_text()))
    s = rep["bySite"]
    assert list(s) == ["narrator-turn", "npc-minds"]  # sorted by cost
    assert s["narrator-turn"]["cost"] == pytest.approx(0.40) and s["narrator-turn"]["calls"] == 5
    assert s["narrator-turn"]["hitRate"] == pytest.approx(8000 / 16000)
    assert s["npc-minds"]["hitRate"] == pytest.approx(7900 / 8000)
    assert rep["total"]["cost"] == pytest.approx(0.45)
    p = rep["costPerPlayedDay"]
    assert p["count"] == 2 and p["mean"] == pytest.approx(0.225) and p["max"] == pytest.approx(0.35)


def test_report_filters_user_and_renders_text_without_ids():
    _seed()
    ledger.record_turn("other", call_site="zeitgeist", cost=9.0)
    ledger.drain_pending_writes()
    data = json.loads(ledger._rollup_path().read_text())
    assert "zeitgeist" not in report.build_report(data, user="player")["bySite"]
    text = report.render(report.build_report(data, user="player", days=1))
    assert "narrator-turn" in text and "Per call site" in text and "Cost per played day" in text


def test_report_cli_json_and_missing_file(tmp_path, capsys):
    _seed()
    ledger.drain_pending_writes()
    assert report.main(["--rollup", str(ledger._rollup_path()), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["total"]["calls"] == 6
    assert report.main(["--rollup", str(tmp_path / "nope.json")]) == 1


# ── review fixes (#2894): the roll-up's own file ─────────────────────────────────────────────

def test_a_user_named_like_the_old_rollup_key_collides_with_nothing():
    _rec(call_site="narrator-turn", cost=0.2)
    ledger.record_turn("__rollup__", call_site="x", cost=0.1)
    assert len(ledger.get_recent("player")) == 1 and ledger.get_rollup("player")
    ledger.clear("__rollup__")
    assert ledger.get_rollup("player") and ledger.get_recent("player")


def test_a_bar_in_the_call_site_cannot_split_the_row_key():
    ledger.record_turn("player", call_site="a|b", model="m", cost=0.1)
    ledger.drain_pending_writes()
    (rows,) = ledger.get_rollup("player")["daily"].values()
    assert list(rows) == ["a/b|m"]
    assert list(report.build_report(json.loads(ledger._rollup_path().read_text()))["bySite"]) == ["a/b"]


def test_report_skips_a_damaged_user_row():
    _seed()
    ledger.drain_pending_writes()
    data = json.loads(ledger._rollup_path().read_text())
    data["broken"] = "not a dict"
    assert report.build_report(data)["total"]["calls"] == 6
