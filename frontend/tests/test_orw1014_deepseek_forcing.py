"""ORW-1014 - forced tool_choice on DeepSeek's own API (thinking disabled), the canary, and the narrator-vs-belt driver metric."""
import importlib
import json
import os

import pytest

al = importlib.import_module("src.agent_loop")
ledger = importlib.import_module("src.orwell_sync_ledger")
canary = importlib.import_module("src.deepseek_force_canary")

DS = "https://api.deepseek.com/chat/completions"
OR = "https://openrouter.ai/api/v1/chat/completions"
_FIX = json.load(open(os.path.join(os.path.dirname(__file__), "fixtures", "orw1014_deepseek_force_probe.json")))


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.delenv("ORWELL_DEEPSEEK_FORCE", raising=False)


# ── the mode-aware rejecter check ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("site", ["beat", "casting", "stall"])
def test_deepseek_direct_thinking_off_is_forced_at_the_safe_sites(site):
    assert al._model_honors_forced_tool_choice("deepseek-flash", DS, site=site) is True
    assert al._model_honors_forced_tool_choice("deepseek-v4-pro", DS, site=site) is True


@pytest.mark.parametrize("site", ["bedtime", "whereabouts", None])
def test_other_sites_stay_off_on_deepseek(site):
    assert al._model_honors_forced_tool_choice("deepseek-flash", DS, site=site) is False


def test_thinking_on_and_other_routes_stay_blocked():
    for m in ("deepseek-reasoner", "deepseek-r1"):
        assert al._model_honors_forced_tool_choice(m, DS, site="beat") is False
    # DeepSeek via OpenRouter: thinking mode unknown, the old block stands
    assert al._model_honors_forced_tool_choice("deepseek/deepseek-v4-flash", OR, site="beat") is False
    # no route given: the old conservative answer
    assert al._model_honors_forced_tool_choice("deepseek-flash") is False


def test_non_rejecters_unchanged_and_kill_switch(monkeypatch):
    assert al._model_honors_forced_tool_choice("z-ai/glm-4.7", OR, site="whereabouts") is True
    monkeypatch.setenv("ORWELL_DEEPSEEK_FORCE", "0")
    assert al._model_honors_forced_tool_choice("deepseek-flash", DS, site="beat") is False


def test_no_site_forces_the_players_binding_pick():
    assert "submitDecision" not in json.dumps(sorted(al._DEEPSEEK_FORCE_SITES))
    src = open(al.__file__).read()
    assert '"function": {"name": "submitDecision"}' not in src


# ── conformance on a recorded fixture + the canary ────────────────────────────────────────────

def test_recorded_fixture_is_honored():
    f = _FIX["ok_named"]
    assert canary.judge_response(f["status"], f["body"])["ok"] is True


def test_rejection_and_prose_fail_loudly():
    assert canary.judge_response(_FIX["rejected_400"]["status"], _FIX["rejected_400"]["body"])["ok"] is False
    r = canary.judge_response(_FIX["prose_only"]["status"], _FIX["prose_only"]["body"])
    assert r["ok"] is False and "not made" in r["detail"]


def test_canary_payload_is_the_narrators_shape():
    p = canary.build_payload("deepseek-flash", DS)
    assert p["thinking"] == {"type": "disabled"}
    assert p["tool_choice"]["function"]["name"] == "recordMove" and len(p["tools"]) == 2


def test_canary_run_pass_fail_skip(monkeypatch):
    import httpx

    class R:
        def __init__(self, f):
            self.status_code, self._b = f["status"], f["body"]

        def json(self):
            return self._b

    seen = {}

    def post(url, headers=None, json=None, timeout=None):
        seen["json"] = json
        return R(_FIX[seen["which"]])

    monkeypatch.setattr(httpx, "post", post)
    ep = (DS, "deepseek-flash", {"Authorization": "Bearer x"})
    seen["which"] = "ok_named"
    assert canary.run_canary(endpoint=ep)["ok"] is True
    seen["which"] = "rejected_400"
    out = canary.run_canary(endpoint=ep)
    assert out["ok"] is False and out["status"] == 400
    # not DeepSeek's own API: skipped, no call
    seen.clear()
    out = canary.run_canary(endpoint=(OR, "x", {}))
    assert out["ok"] and out["skipped"] and "json" not in seen


# ── the driver metric ────────────────────────────────────────────────────────────────────────

@pytest.fixture
def led(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "l.json")
    ledger._PENDING_BELTS.clear()
    ledger._PENDING_FORCED.clear()
    yield ledger
    ledger._PENDING_BELTS.clear()


def test_classify_driver():
    c = ledger.classify_driver
    assert c(["moveTo"], {}) == "narrator"
    assert c([], {"auto-move-player": 1}) == "belt"
    assert c(["advanceGame"], {"forced-advance:stall": 1}) == "both"
    assert c(["whereabouts"], {"desync-reground-voiced": 1, "advance-stall-nudge": 2}) == "none"  # reads and advisory belts change nothing
    assert c(["noteMessage"], {}) == "none"
    assert c(["turnIn"], {"bedtime-turn-in-direct": 1}) == "belt"  # the belt ran it
    assert c(["advanceGame"], {"forced-tool-choice:advanceGame": 1}) == "narrator"  # a forced call is still the narrator's


def test_totals_rates_and_log(led, caplog):
    import logging
    caplog.set_level(logging.INFO)
    led.record_turn("u", session="s", turn_id="1", tools_called=["moveTo"])
    led.note_belt_fire("u", "auto-record-scene")
    led.record_turn("u", session="s", turn_id="2")
    led.note_belt_fire("u", "auto-move-player")
    led.record_turn("u", session="s", turn_id="3")
    led.record_turn("u", session="s", turn_id="4")
    t = led.get_driver_totals("u")
    assert (t["turns"], t["narratorToolTurns"], t["beltDrivenTurns"], t["none"]) == (4, 1, 2, 1)
    assert t["narratorToolRate"] == 0.25 and t["beltDrivenRate"] == 0.5
    assert led.get_driver_totals("nobody")["narratorToolRate"] is None
    lines = [r.getMessage() for r in caplog.records if "sync-ledger turn" in r.getMessage()]
    assert lines and "driver=narrator" in lines[0] and "driver=belt" in lines[1]


def test_health_snapshot_carries_the_counters(led):
    from routes import admin_health_routes as h
    led.record_turn("u", session="s", turn_id="1", tools_called=["moveTo"])
    assert h._turn_drivers_section("u")["narratorToolTurns"] == 1
    assert h._sync_ledger_section("u")["driverTotals"]["turns"] == 1


# ── ORW-1041 / ORW-1042 ─────────────────────────────────────────────────────────────────────

def test_gate_and_payload_share_one_thinking_predicate():
    llm = importlib.import_module("src.llm_core")
    for url, model, want in ((DS, "deepseek-flash", True), (DS, "deepseek-reasoner", False), (OR, "deepseek/deepseek-v4-flash", False)):
        assert llm.deepseek_thinking_disabled(url, model) is want
        p = {"reasoning": 1}
        llm._apply_deepseek_thinking_off(p, url, model)
        assert (p.get("thinking") == {"type": "disabled"}) is want  # the payload sends thinking-off exactly when the gate says so


def test_every_steer_and_reground_builder_is_counted():
    import re
    src = open(os.path.join(os.path.dirname(__file__), "..", "routes", "chat_helpers.py")).read()
    # drained elsewhere and counted at the drain (belts day-roll/desync/ceremony-unvoiced) or pure helpers
    exempt = {"_counted_steer", "_whereabouts_barrier_directive"}
    missing = []
    for m in re.finditer(r"^((?:@[\w_().=]+\n)*)def (\w*(?:_steer|_reground))\(", src, re.M):
        if m.group(2) not in exempt and "_counted_steer" not in m.group(1):
            missing.append(m.group(2))
    assert not missing, f"steer/reground builders with no counter (decorate with @_counted_steer): {missing}"


def test_steer_counter_counts_and_logs(caplog):
    import logging
    ch = importlib.import_module("routes.chat_helpers")
    ledger._STEER_COUNTS.clear()
    caplog.set_level(logging.INFO)
    ch._veto_draw_steer("x")
    assert ledger.get_steer_counts().get("_veto_draw_steer") == 1
    assert any("steer _veto_draw_steer" in r.getMessage() for r in caplog.records)
