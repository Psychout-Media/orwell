"""#1599 — no-silent-fail-soft: the shared recorder, the class-A site wiring, the per-class/-tool
health rollup (WI2), and the RED alarms (WI3).

Owner ruling (2026-07-14, issue #1599): NOTHING fails softly unless the owner grants it. Every
genuine failure (an exception / a guard that couldn't run / a refused write) must (1) show RED on
/admin/status — INCLUDING when auto-corrected, annotated `auto-corrected` vs `uncorrected`; (2) log
at WARN/ERROR; (3) never swallow a real error into the void. An expected-empty result is NOT a
failure and does not alarm.

Roles only — every string here is a generic probe, never cast material. Proves:
  (a) a swallowed real error now records a RED-eligible health event (the shared recorder + the
      wired class-A sites: overseer judge, enrichment);
  (b) N judge failures → a RED alarm in the /api/admin/health payload;
  (c) an auto-corrected belt/floor → RED-with-`auto-corrected` (a correction is not a cloak).
"""
import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

log_rings = importlib.import_module("src.log_rings")
overseer = importlib.import_module("src.overseer")
enrichment_policy = importlib.import_module("src.enrichment_policy")
ahr = importlib.import_module("routes.admin_health_routes")
orwell_engine = importlib.import_module("src.orwell_engine")
llm_trace = importlib.import_module("src.llm_trace")


def _clear_rings():
    for ring in (log_rings.OVERSEER, log_rings.LLMIO, log_rings.IO, log_rings.LIVE):
        ring.buf.clear()


def _overseer_entries():
    _, lines = log_rings.OVERSEER.since(0, limit=100000)
    return lines


# ── the shared recorder ────────────────────────────────────────────────────────────────────

def test_record_soft_failure_writes_a_red_eligible_health_event():
    _clear_rings()
    log_rings.record_soft_failure("overseer:judge-call-failed", RuntimeError("boom"),
                                  corrected="deterministic-floor")
    entries = _overseer_entries()
    assert len(entries) == 1
    e = entries[0]
    assert e["ok"] is False                       # RED-eligible (record_overseer colours ok=False red)
    assert e["level"] == "ERROR"                   # display severity is RED
    assert e["kind"] == "overseer:judge-call-failed"
    assert "boom" in e["diagnosis"] and "RuntimeError" in e["diagnosis"]
    assert log_rings.SOFT_FAIL_AUTOCORRECTED in e["diagnosis"]  # "auto-corrected by deterministic-floor"
    assert e["lever"] == "deterministic-floor"


def test_record_soft_failure_uncorrected_is_still_red_and_annotated():
    _clear_rings()
    log_rings.record_soft_failure("faith:gate-error", ValueError("nope"))
    e = _overseer_entries()[0]
    assert e["ok"] is False
    assert log_rings.SOFT_FAIL_UNCORRECTED in e["diagnosis"]  # "uncorrected"
    assert e["lever"] is None


def test_record_soft_failure_never_raises_even_if_the_health_write_is_broken(monkeypatch):
    """Fail-safe: a broken telemetry write must never propagate out of the recorder (the WARN above
    already surfaced the diagnosis) — the reference-pattern contract."""
    def _boom(*a, **k):
        raise RuntimeError("overseer ring down")
    monkeypatch.setattr(log_rings, "record_overseer", _boom)
    # Must not raise.
    log_rings.record_soft_failure("overseer:hook-error", RuntimeError("x"))


# ── (a) the class-A sites now record instead of swallowing ──────────────────────────────────

def test_overseer_llm_judge_error_records_red(monkeypatch):
    """`LlmOverseer.assess` swallowing a genuine model-call error now records RED before the floor."""
    _clear_rings()

    def _raises(_prompt):
        raise RuntimeError("model 503")

    # A symptom that trips should_assess so the judge actually runs.
    sig = overseer.Signals(in_advance_phase=True, play_quiet=True, engaged_scene=False,
                           recorded_interaction=False, progression_tool_called=False)
    verdict = overseer.LlmOverseer(_raises).assess(sig)
    assert verdict is not None                      # still fail-soft to the deterministic floor
    kinds = [e["kind"] for e in _overseer_entries()]
    assert "overseer:judge-call-failed" in kinds
    down = [e for e in _overseer_entries() if e["kind"] == "overseer:judge-call-failed"][0]
    assert down["ok"] is False and down["lever"] == "deterministic-floor"


def test_overseer_deterministic_heuristic_error_records_red(monkeypatch):
    """`DeterministicOverseer.assess` self-erroring records RED before the benign hold verdict."""
    _clear_rings()
    monkeypatch.setattr(overseer, "_heuristic_verdict",
                        lambda s: (_ for _ in ()).throw(RuntimeError("heuristic boom")))
    sig = overseer.Signals(in_advance_phase=True, play_quiet=True, engaged_scene=False,
                           recorded_interaction=False, progression_tool_called=False)
    verdict = overseer.DeterministicOverseer().assess(sig)
    assert verdict is not None and verdict.lever == "hold"   # still fail-soft
    down = [e for e in _overseer_entries() if e["kind"] == "overseer:heuristic-error"]
    assert down and down[0]["ok"] is False and down[0]["lever"] == "hold"


def test_enrichment_record_failure_emits_a_red_health_event():
    """Every enrichment failure (not just no-model) now reaches RED — covers all 6 driver classes."""
    _clear_rings()
    enrichment_policy.clear_failures("probe-user")
    enrichment_policy.record_failure("probe-user", "cast-authoring", "LLM call failed",
                                     detail="503 from provider")
    red = [e for e in _overseer_entries()
           if e["kind"] == "enrichment:cast-authoring" and e["ok"] is False]
    assert red, "an enrichment failure must land a RED-eligible health event"
    assert "LLM call failed" in red[0]["diagnosis"]
    enrichment_policy.clear_failures("probe-user")


# ── (b) N judge failures → a RED alarm ──────────────────────────────────────────────────────

def test_n_judge_failures_produce_a_guard_alarm_in_the_rollup():
    _clear_rings()
    for _ in range(3):
        log_rings.record_soft_failure("overseer:judge-call-failed", RuntimeError("t"),
                                      corrected="deterministic-floor")
    rollup = ahr._compute_health_rollup()
    assert rollup["guards"]["overseer:judge-call-failed"]["failed"] == 3
    alarms = ahr._compute_alarms(rollup)
    guard = [a for a in alarms if a["code"] == "guard-judge-failure"]
    assert guard, "a guard/judge failing at all must raise a RED alarm"
    assert guard[0]["severity"] == "red" and guard[0]["count"] == 3


@pytest.fixture
def _stubbed_engine(monkeypatch):
    async def fake_detail():
        return {"ok": True, "engineUrl": "http://127.0.0.1:8765"}

    async def fake_raw():
        return ({"ok": True, "uptimeSeconds": 1, "toolCalls": {"total": 0, "failed": 0},
                 "recentFailures": [], "embeddings": {"provider": "deterministic", "degraded": False}}, 3)

    async def no_sandbox(user=None):
        return None

    monkeypatch.setattr(orwell_engine, "engine_health_detail", fake_detail)
    monkeypatch.setattr(ahr, "_engine_raw_health", fake_raw)
    monkeypatch.setattr(orwell_engine, "sandbox_health", no_sandbox)
    monkeypatch.setattr(ahr, "_store_stats", lambda: {"sessions": 0, "messages": 0})
    monkeypatch.setattr(ahr, "_image_state", lambda user: {"available": False, "enabled": False})

    async def no_cast(user=None):
        return None
    monkeypatch.setattr(ahr, "_cast_authoring_state", no_cast)


def _health_app():
    app = FastAPI()
    app.include_router(ahr.setup_admin_health_routes())
    return app


def test_health_payload_surfaces_the_rollup_and_red_alarm(monkeypatch, _stubbed_engine):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    _clear_rings()
    for _ in range(3):
        log_rings.record_soft_failure("overseer:judge-call-failed", RuntimeError("t"),
                                      corrected="deterministic-floor")
    body = TestClient(_health_app(), raise_server_exceptions=False).get("/api/admin/health").json()
    assert "healthRollup" in body and "alarms" in body           # WI2 + WI3 on the payload
    codes = {a["code"] for a in body["alarms"]}
    assert "guard-judge-failure" in codes
    assert all(a["severity"] == "red" for a in body["alarms"])   # every alarm is RED
    # Vault-free: alarms carry only tokens/counts/flags, never narration/cast content.
    for a in body["alarms"]:
        assert set(a) >= {"code", "severity", "label", "count", "detail", "autoCorrected"}


# ── (c) an auto-corrected belt/floor → RED-with-`auto-corrected` ─────────────────────────────

def test_auto_corrected_soft_failure_is_red_with_autocorrected():
    _clear_rings()
    log_rings.record_soft_failure("overseer:judge-call-failed", RuntimeError("t"),
                                  corrected="auto-record-scene")
    rollup = ahr._compute_health_rollup()
    assert rollup["guards"]["overseer:judge-call-failed"]["autoCorrected"] == 1
    alarms = ahr._compute_alarms(rollup)
    # A correction is not a cloak: there is a RED alarm flagged auto-corrected.
    auto = [a for a in alarms if a["autoCorrected"]]
    assert auto, "an auto-corrected fault must still show RED, annotated auto-corrected"
    assert all(a["severity"] == "red" for a in auto)
    assert any(a["code"] == "auto-corrected" for a in alarms)


def test_belt_fire_totals_raise_the_auto_corrected_alarm():
    """The belt-fire telemetry (get_belt_totals) also surfaces RED-with-auto-corrected — every
    applied belt correction is a genuine (auto-corrected) fault, not silence."""
    alarms = ahr._compute_alarms({"guards": {}, "llm": {}, "tools": {}},
                                 belt_totals={"auto-record-scene": 2, "force-advance": 1})
    auto = [a for a in alarms if a["code"] == "auto-corrected"]
    assert auto and auto[0]["severity"] == "red" and auto[0]["autoCorrected"] is True
    assert auto[0]["count"] == 3


# ── the other WI3 alarm signals fire on their inputs ────────────────────────────────────────

def test_embeddings_degraded_and_integrity_and_storm_alarms():
    rollup = {"guards": {"enrichment:cast-authoring": {"failed": 2, "autoCorrected": 0}},
              "llm": {"narration": {"total": 4, "failed": 2, "failureRate": 0.5}},
              "tools": {"recordInteraction": {"total": 5, "failed": 2, "failureRate": 0.4}}}
    alarms = ahr._compute_alarms(
        rollup,
        embeddings={"provider": "fastembed", "degraded": True},
        sync_recent=[{"staleRejections": 2, "desyncDetected": True}],
        sandbox={"circuitOpen": True, "lastIntegrity": "fault",
                 "faults": [{"kind": "degradation"}, {"kind": "persist-failure"}]})
    codes = {a["code"] for a in alarms}
    assert {"narration-failure", "writeback-storm", "desync-burst",
            "embeddings-degraded", "integrity-fault"} <= codes
    assert all(a["severity"] == "red" for a in alarms)


# ── Class-B is left alone: an expected-empty result must NOT alarm ───────────────────────────

def test_no_failures_means_no_alarms():
    _clear_rings()
    alarms = ahr._compute_alarms(ahr._compute_health_rollup())
    assert alarms == []


# ── cross-user isolation: a soft-failure is scoped to the user that emitted it (#1641 / Greptile P1) ──
#
# The OVERSEER ring is GLOBAL (one ring, every sandbox), but every OTHER health read the snapshot
# assembles (sync_recent / belt_totals / sandbox_health) is already user-scoped. Before the fix the
# rollup's `guards` bucket counted EVERY user's soft-failures, so user A's fault inflated the rollup
# AND raised RED alarms in user B's /api/admin/health — a cross-user sandbox-isolation breach (first
# class alongside the Vault Wall). The fix filters the OVERSEER ring by the per-entry `user` field
# `record_overseer`/`record_soft_failure` stamp, matching how the sibling reads are already scoped.

def test_soft_failure_rollup_is_scoped_to_the_emitting_user():
    _clear_rings()
    # User A hits a genuine (auto-corrected) soft failure; user B's sandbox is clean.
    for _ in range(3):
        log_rings.record_soft_failure("overseer:judge-call-failed", RuntimeError("t"),
                                      corrected="deterministic-floor", user="user-a")

    roll_a = ahr._compute_health_rollup(user="user-a")
    roll_b = ahr._compute_health_rollup(user="user-b")

    # A sees its own failures; B's guards bucket stays empty — no bleed across sandboxes.
    assert roll_a["guards"]["overseer:judge-call-failed"]["failed"] == 3
    assert roll_b["guards"] == {}

    # The RED alarms follow the rollup: A raises the guard/judge + auto-corrected alarms; B neither.
    codes_a = {a["code"] for a in ahr._compute_alarms(roll_a)}
    codes_b = {a["code"] for a in ahr._compute_alarms(roll_b)}
    assert {"guard-judge-failure", "auto-corrected"} <= codes_a
    assert {"guard-judge-failure", "auto-corrected"}.isdisjoint(codes_b)


def test_none_user_soft_failure_maps_to_the_default_bucket_only():
    """A soft-failure with NO user (user=None) normalizes to the shared `default` bucket (mirroring
    orwell_sync_ledger._key) — it surfaces for a default/single-user request but never for a named
    user, so an unattributed fault can't leak into a specific user's view either."""
    _clear_rings()
    log_rings.record_soft_failure("faith:gate-error", RuntimeError("x"))  # no user in ctx
    assert ahr._compute_health_rollup(user=None)["guards"].get("faith:gate-error", {}).get("failed") == 1
    assert ahr._compute_health_rollup(user="default")["guards"].get("faith:gate-error", {}).get("failed") == 1
    assert ahr._compute_health_rollup(user="user-a")["guards"] == {}


def test_health_payload_does_not_leak_another_users_soft_failure(monkeypatch, _stubbed_engine):
    """Greptile repro end-to-end: user A's soft-failure must be ABSENT from user B's
    /api/admin/health rollup + alarms, yet still present in user A's own view (the fix scopes it,
    it does not drop it)."""
    monkeypatch.setenv("AUTH_ENABLED", "false")
    _clear_rings()
    for _ in range(3):
        log_rings.record_soft_failure("overseer:judge-call-failed", RuntimeError("t"),
                                      corrected="deterministic-floor", user="user-a")

    # The requesting admin resolves to user B — their view of the health payload must be clean.
    monkeypatch.setattr(ahr, "effective_user", lambda request: "user-b")
    body_b = TestClient(_health_app(), raise_server_exceptions=False).get("/api/admin/health").json()
    assert body_b["healthRollup"].get("guards") == {}
    assert {a["code"] for a in body_b["alarms"]}.isdisjoint({"guard-judge-failure", "auto-corrected"})

    # Sanity — the SAME failure DOES surface for user A (scoped, not silenced).
    monkeypatch.setattr(ahr, "effective_user", lambda request: "user-a")
    body_a = TestClient(_health_app(), raise_server_exceptions=False).get("/api/admin/health").json()
    assert body_a["healthRollup"]["guards"]["overseer:judge-call-failed"]["failed"] == 3
    assert "guard-judge-failure" in {a["code"] for a in body_a["alarms"]}


# ── second cross-user leak (Greptile #1641): the LLMIO/IO rings also drive per-user alarms ──────
#
# `healthRollup.llm` (narration-failure) and `healthRollup.tools` (write-back storm) feed RED
# alarms too. The LLMIO/IO rings used to carry NO user field, so a narration 5xx / a failed
# recordInteraction from user A raised RED in user B's per-user /api/admin/health — the same
# isolation breach as the OVERSEER ring. The fix stamps `user` at the record_llm_call / record_io
# push sites and filters llm/tools by the requesting user in _compute_health_rollup.

def _push_llm_narration_failure(user):
    """A narration-classed LLMIO failure entry exactly as `llm_trace._push_ring` produces one."""
    import time as _t
    log_rings.LLMIO.push({
        "ts": int(_t.time() * 1000), "level": "ERROR", "logger": "llm-io",
        "msg": "stream[narration] · m FAILED 1ms", "kind": "stream", "callClass": "narration",
        "finishReason": None, "ok": False, "user": user, "args": "", "result": "[error] 503",
    })


def test_record_io_stamps_the_user_on_the_ring():
    _clear_rings()
    log_rings.record_io("recordInteraction", {"x": 1}, False, 5, "boom", user="user-a")
    _, io = log_rings.IO.since(0, limit=100000)
    assert io and io[-1]["tool"] == "recordInteraction" and io[-1]["ok"] is False
    assert io[-1]["user"] == "user-a"


def test_record_llm_call_stamps_the_user_on_the_ring_explicit_and_via_context(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))  # isolate the durable archive write
    _clear_rings()
    # (a) explicit user= wins.
    llm_trace.record_llm_call(kind="stream", model="m", ok=False, call_class="narration",
                              user="user-a", response={"error": {"type": "X", "message": "y"}})
    _, llm = log_rings.LLMIO.since(0, limit=100000)
    assert llm and llm[-1]["user"] == "user-a" and llm[-1]["callClass"] == "narration"
    # (b) the always-on call-user context supplies it when no explicit arg is passed (the
    #     streaming-narration path, where record_llm_call has no `user` in scope).
    _clear_rings()
    token = llm_trace.set_call_user("user-b")
    try:
        llm_trace.record_llm_call(kind="stream", model="m", ok=False, call_class="narration",
                                  response={"error": {"type": "X", "message": "y"}})
    finally:
        llm_trace.reset_call_user(token)
    _, llm = log_rings.LLMIO.since(0, limit=100000)
    assert llm and llm[-1]["user"] == "user-b"


def test_llm_and_tool_failures_are_scoped_to_the_emitting_user():
    _clear_rings()
    # User A: a narration failure + a burst of failed engine write-backs.
    _push_llm_narration_failure("user-a")
    for _ in range(3):
        log_rings.record_io("recordInteraction", {"x": 1}, False, 5, "boom", user="user-a")

    roll_a = ahr._compute_health_rollup(user="user-a")
    roll_b = ahr._compute_health_rollup(user="user-b")

    # A sees its own llm + tools failures; B's buckets stay empty (no cross-sandbox bleed).
    assert roll_a["llm"]["narration"]["failed"] == 1
    assert roll_a["tools"]["recordInteraction"]["failed"] == 3
    assert roll_b["llm"] == {} and roll_b["tools"] == {}

    codes_a = {a["code"] for a in ahr._compute_alarms(roll_a)}
    codes_b = {a["code"] for a in ahr._compute_alarms(roll_b)}
    assert {"narration-failure", "writeback-storm"} <= codes_a
    assert {"narration-failure", "writeback-storm"}.isdisjoint(codes_b)


def test_health_payload_does_not_leak_another_users_llm_or_tool_failure(monkeypatch, _stubbed_engine):
    """Greptile repro end-to-end: user A's narration + write-back failures must be ABSENT from user
    B's /api/admin/health rollup + alarms, yet present in user A's own view."""
    monkeypatch.setenv("AUTH_ENABLED", "false")
    _clear_rings()
    _push_llm_narration_failure("user-a")
    for _ in range(3):
        log_rings.record_io("recordInteraction", {"x": 1}, False, 5, "boom", user="user-a")

    monkeypatch.setattr(ahr, "effective_user", lambda request: "user-b")
    body_b = TestClient(_health_app(), raise_server_exceptions=False).get("/api/admin/health").json()
    assert body_b["healthRollup"].get("llm") == {} and body_b["healthRollup"].get("tools") == {}
    assert {a["code"] for a in body_b["alarms"]}.isdisjoint({"narration-failure", "writeback-storm"})

    monkeypatch.setattr(ahr, "effective_user", lambda request: "user-a")
    body_a = TestClient(_health_app(), raise_server_exceptions=False).get("/api/admin/health").json()
    assert body_a["healthRollup"]["llm"]["narration"]["failed"] == 1
    assert body_a["healthRollup"]["tools"]["recordInteraction"]["failed"] == 3
    assert {"narration-failure", "writeback-storm"} <= {a["code"] for a in body_a["alarms"]}


# ── ORW-500: cast-authoring / cast-gate corrections reach the rollup totals, never an alarm ──

def test_cast_authoring_and_cast_gate_corrections_count_in_totals_without_alarming():
    _clear_rings()
    for _ in range(6):  # a normal ~15-houseguest cast with several repairs
        log_rings.record_soft_failure("cast-authoring:voice-repaired", "repaired",
                                      corrected="seeded-voice-dial")
    log_rings.record_soft_failure("cast-gate:non-blocking", "accepted with a soft gap",
                                  corrected="backfill")
    rollup = ahr._compute_health_rollup()
    assert rollup["guards"]["cast-authoring:voice-repaired"]["failed"] == 6
    assert rollup["guards"]["cast-authoring:voice-repaired"]["autoCorrected"] == 6
    assert rollup["guards"]["cast-gate:non-blocking"]["failed"] == 1
    assert ahr._compute_alarms(rollup) == []


def test_cast_corrections_do_not_hide_other_auto_corrected_alarms():
    _clear_rings()
    log_rings.record_soft_failure("cast-authoring:voice-repaired", "r", corrected="x")
    log_rings.record_soft_failure("overseer:judge-call-failed", "t", corrected="floor")
    alarms = ahr._compute_alarms(ahr._compute_health_rollup())
    auto = [a for a in alarms if a["code"] == "auto-corrected"]
    assert auto and auto[0]["count"] == 1
