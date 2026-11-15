"""Full LLM I/O trace + log retention (src/llm_trace.py + the /admin/status controls).

The owner commission: "log everything in/out of the llm, add it to the logfile viewer,
archive it off after a period — a universal retention setting on the health page:
trim logfiles, a selectable horizon, and a live total-size readout."

Proves: the recorder captures the full request + reconstructed response to both the
live ring and the durable archive; it is a no-op when disabled; secrets are scrubbed;
the streaming accumulator reconstructs text/reasoning/tool-calls/usage/error; retention
trims JSONL by entry age and stale .log files by mtime, with "keep everything" a no-op;
and the admin endpoints + status-page controls are wired and admin-gated.
"""

import importlib
import json
import os
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

pytestmark = pytest.mark.usefixtures("non_game_text_routing")  # ORW-287: pins the OpenRouter payload shape (non-game build)

llm_trace = importlib.import_module("src.llm_trace")
log_rings = importlib.import_module("src.log_rings")
ahr = importlib.import_module("routes.admin_health_routes")
settings = importlib.import_module("src.settings")


def _app():
    app = FastAPI()
    app.include_router(ahr.setup_admin_health_routes())
    app.include_router(ahr.setup_admin_status_page())
    return app


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    return tmp_path


def _enable(monkeypatch, on=True):
    monkeypatch.setattr(llm_trace, "enabled", lambda: on)


# ── the recorder: full I/O to ring + durable archive ───────────────────────────

def test_record_writes_full_io_to_file_and_ring(data_dir, monkeypatch):
    _enable(monkeypatch)
    llm_trace.record_llm_call(
        kind="stream", model="m1", requested_model="m1",
        messages=[{"role": "system", "content": "the system prompt"},
                  {"role": "user", "content": "hi there"}],
        tools=[{"name": "advanceGame"}], temperature=0.7, max_tokens=2048,
        response={"text": "hello", "reasoning": "let me think…",
                  "toolCalls": [{"name": "foo"}], "usage": {"input_tokens": 3}},
        ok=True, duration_ms=42)

    # durable archive: the FULL request (incl the system prompt + tool schemas) + response
    rec = json.loads(open(llm_trace.trace_path()).read().splitlines()[-1])
    assert rec["model"] == "m1" and rec["ok"] is True and rec["durationMs"] == 42
    assert rec["request"]["messages"][0]["content"] == "the system prompt"
    assert rec["request"]["messages"][1]["content"] == "hi there"
    assert rec["request"]["tools"] == [{"name": "advanceGame"}]
    assert rec["response"]["text"] == "hello"
    assert rec["response"]["reasoning"] == "let me think…"
    assert rec["response"]["toolCalls"] == [{"name": "foo"}]

    # live ring: a glanceable summary the viewer follows
    _, lines = log_rings.LLMIO.since(0)
    last = [l for l in lines if "m1" in l["msg"]][-1]
    assert "stream" in last["msg"] and "ok" in last["msg"]
    assert "the system prompt" in last["args"]


def test_record_over_soft_ceiling_is_written_in_full(data_dir, monkeypatch):
    # "Preserve ALL I/O — and I mean all": a record larger than the soft observability
    # threshold is written LOSSLESSLY, never truncated/dropped.
    _enable(monkeypatch)
    monkeypatch.setattr(llm_trace, "_MAX_RECORD_BYTES", 100)  # force the over-ceiling path
    big_prompt = "X" * 5000
    big_reply = "Y" * 5000
    llm_trace.record_llm_call(
        kind="stream", model="m1",
        messages=[{"role": "system", "content": big_prompt},
                  {"role": "user", "content": "hi"}],
        response={"text": big_reply, "reasoning": "Z" * 5000}, ok=True)
    rec = json.loads(open(llm_trace.trace_path()).read().splitlines()[-1])
    # Full content survives — no {"truncated": True} sentinel, no clipping.
    assert rec["request"]["messages"][0]["content"] == big_prompt
    assert rec["response"]["text"] == big_reply
    assert rec["response"]["reasoning"] == "Z" * 5000
    assert "truncated" not in rec["request"] and "truncated" not in rec["response"]


def test_record_is_noop_when_disabled(data_dir, monkeypatch):
    _enable(monkeypatch, on=False)
    llm_trace.record_llm_call(kind="call", model="x",
                              messages=[{"role": "user", "content": "y"}], response={"text": "z"})
    assert not os.path.exists(llm_trace.trace_path())


def test_record_scrubs_secrets(data_dir, monkeypatch):
    _enable(monkeypatch)
    llm_trace.record_llm_call(
        kind="call", model="m",
        messages=[{"role": "user", "content": "my key is sk-ABCDEF0123456789 and Bearer abcdef0123456"}],
        response={"text": "ok"})
    txt = open(llm_trace.trace_path()).read()
    assert "sk-ABCDEF0123456789" not in txt
    assert "abcdef0123456" not in txt
    assert "REDACTED" in txt


def test_record_redacts_secret_shaped_keys(data_dir, monkeypatch):
    _enable(monkeypatch)
    llm_trace.record_llm_call(
        kind="call", model="m", messages=[{"role": "user", "content": "hi", "authorization": "Bearer zzzzzzzz"}],
        response={"text": "ok"})
    rec = json.loads(open(llm_trace.trace_path()).read().splitlines()[-1])
    assert rec["request"]["messages"][0]["authorization"] == llm_trace._REDACTED


# ── the streaming accumulator: reconstruct the response from SSE chunks ─────────

def test_stream_accumulator_reconstructs_response():
    acc = llm_trace.StreamAccumulator()
    acc.observe('data: {"delta": "Hel"}\n\n')
    acc.observe('data: {"delta": "lo"}\n\n')
    acc.observe('data: {"delta": "reasoning bit", "thinking": true}\n\n')
    acc.observe('data: {"type": "tool_calls", "calls": [{"name": "foo"}]}\n\n')
    acc.observe('data: {"type": "usage", "data": {"input_tokens": 5, "output_tokens": 2}}\n\n')
    acc.observe('data: [DONE]\n\n')
    r = acc.response()
    assert r["text"] == "Hello"
    assert r["reasoning"] == "reasoning bit"
    assert r["toolCalls"] == [{"name": "foo"}]
    assert r["usage"] == {"input_tokens": 5, "output_tokens": 2}
    assert r["error"] is None


def test_stream_accumulator_captures_error():
    acc = llm_trace.StreamAccumulator()
    acc.observe('event: error\ndata: {"error": "boom", "status": 503}\n\n')
    r = acc.response()
    assert r["error"] and r["error"].get("error") == "boom"


def test_stream_accumulator_captures_finish_reason():
    # G1 ("preserve ALL I/O"): the terminal finish_reason ("length"/"error"/…) must reach the trace.
    acc = llm_trace.StreamAccumulator()
    acc.observe('data: {"delta": "hi"}\n\n')
    acc.observe('data: {"type": "finish", "reason": "length"}\n\n')
    acc.observe('data: [DONE]\n\n')
    assert acc.response()["finishReason"] == "length"


def test_record_persists_finish_reason_and_reasoning(data_dir, monkeypatch):
    # G1/G2: the durable record carries WHY a reply ended (finishReason) and any reasoning.
    _enable(monkeypatch)
    llm_trace.record_llm_call(
        kind="call", model="m", messages=[{"role": "user", "content": "x"}],
        response={"text": "ok", "reasoning": "thought process", "finishReason": "error"}, ok=False)
    rec = json.loads(open(llm_trace.trace_path()).read().splitlines()[-1])
    assert rec["response"]["finishReason"] == "error"
    assert rec["response"]["reasoning"] == "thought process"


def test_nonstreaming_call_traces_reasoning_and_finish(data_dir, monkeypatch):
    # G2 end-to-end: the non-streaming utility path threads reasoning + finish_reason into the trace
    # via meta_sink (previously it recorded text-only). Drives the real llm_call_async with a fake client.
    import asyncio
    from src import llm_core as lc
    _enable(monkeypatch)

    data = {"choices": [{"message": {"content": "answer", "reasoning_content": "deliberation"},
                         "finish_reason": "stop"}]}

    class _Resp:
        is_success = True
        status_code = 200
        text = ""

        def json(self):
            return data

    class _Client:
        async def post(self, url, headers=None, json=None, timeout=None):
            return _Resp()

    monkeypatch.setattr(lc, "_get_http_client", lambda: _Client())
    monkeypatch.setattr(lc, "_is_host_dead", lambda u: False)
    monkeypatch.setattr(lc, "note_model_activity", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_clear_host_dead", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_get_cached_response", lambda k: None)
    monkeypatch.setattr(lc, "_set_cached_response", lambda *a, **k: None)

    async def drive():
        return await lc.llm_call_async(
            "https://openrouter.ai/api/v1/chat/completions", "deepseek/deepseek-v4-pro",
            [{"role": "user", "content": "x"}])

    text = asyncio.get_event_loop().run_until_complete(drive())
    assert text == "answer"
    rec = json.loads(open(llm_trace.trace_path()).read().splitlines()[-1])
    assert rec["response"]["reasoning"] == "deliberation"
    assert rec["response"]["finishReason"] == "stop"


def test_stream_accumulator_notes_fallback_answerer():
    acc = llm_trace.StreamAccumulator()
    acc.observe('data: {"type": "fallback", "selected_model": "a", "answered_by": "b"}\n\n')
    acc.observe('data: {"delta": "hi"}\n\n')
    assert acc.response()["answeredBy"] == "b"


# ── 2026-07-13 (prod bundle audit): top-level finishReason + callClass triage fields ──

def test_record_carries_top_level_finish_reason_and_call_class(data_dir, monkeypatch):
    _enable(monkeypatch)
    llm_trace.record_llm_call(
        kind="call", model="m", messages=[{"role": "user", "content": "x"}],
        call_class="utility-extraction",
        response={"text": "", "finishReason": "stop"}, ok=True)
    rec = json.loads(open(llm_trace.trace_path()).read().splitlines()[-1])
    assert rec["finishReason"] == "stop", "the stop reason must be a TOP-LEVEL triage field"
    assert rec["callClass"] == "utility-extraction", "the ADR-0010 call class must be recorded"
    # Back-compat: the response copy stays where it always was.
    assert rec["response"]["finishReason"] == "stop"


def test_record_call_class_is_null_when_unknown(data_dir, monkeypatch):
    _enable(monkeypatch)
    llm_trace.record_llm_call(
        kind="stream", model="m", messages=[{"role": "user", "content": "x"}],
        response={"text": "hi"}, ok=True)
    rec = json.loads(open(llm_trace.trace_path()).read().splitlines()[-1])
    assert rec["callClass"] is None, "unknown class is null — never guessed"
    assert rec["finishReason"] is None


def test_record_call_class_falls_back_to_the_observability_context(data_dir, monkeypatch):
    """The streaming chokepoint has no call_class parameter — the 0112 per-turn context
    (set by the agent loop on game turns) supplies it when available."""
    _enable(monkeypatch)
    token = llm_trace.set_observability_context(call_class="narration")
    try:
        llm_trace.record_llm_call(
            kind="stream", model="m", messages=[{"role": "user", "content": "x"}],
            response={"text": "hi", "finishReason": "length"}, ok=True)
    finally:
        llm_trace.reset_observability_context(token)
    rec = json.loads(open(llm_trace.trace_path()).read().splitlines()[-1])
    assert rec["callClass"] == "narration"
    assert rec["finishReason"] == "length"


def test_ring_summary_line_shows_class_and_finish_reason(data_dir, monkeypatch):
    _enable(monkeypatch)
    llm_trace.record_llm_call(
        kind="call", model="m9", messages=[{"role": "user", "content": "x"}],
        call_class="utility-extraction",
        response={"text": "", "finishReason": "stop"}, ok=True)
    _, lines = log_rings.LLMIO.since(0)
    msg = lines[-1]["msg"]
    assert "call[utility-extraction]" in msg, f"the ring summary must carry the class: {msg}"
    assert "finish=stop" in msg, f"the ring summary must carry the stop reason: {msg}"


def test_nonstreaming_call_threads_call_class_to_the_record(data_dir, monkeypatch):
    """End-to-end: llm_call_async(call_class=…) lands as the record's top-level callClass."""
    import asyncio
    from src import llm_core as lc
    _enable(monkeypatch)

    data = {"choices": [{"message": {"content": "answer"}, "finish_reason": "stop"}]}

    class _Resp:
        is_success = True
        status_code = 200
        text = "x"

        def json(self):
            return data

    class _Client:
        async def post(self, url, headers=None, json=None, timeout=None):
            return _Resp()

    monkeypatch.setattr(lc, "_get_http_client", lambda: _Client())
    monkeypatch.setattr(lc, "_is_host_dead", lambda u: False)
    monkeypatch.setattr(lc, "note_model_activity", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_clear_host_dead", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_get_cached_response", lambda k: None)
    monkeypatch.setattr(lc, "_set_cached_response", lambda *a, **k: None)

    async def drive():
        return await lc.llm_call_async(
            "https://openrouter.ai/api/v1/chat/completions", "m",
            [{"role": "user", "content": "x"}], call_class="background-authoring")

    # Deterministic fresh loop WITHOUT poisoning the shared xdist-worker loop: a bare
    # `asyncio.run()` closes+unsets the current loop, which then breaks every later test on
    # this worker that uses `asyncio.get_event_loop().run_until_complete` (the suite-wide
    # convention). `new_event_loop()` + `close()` (no `set_event_loop`) gives a private loop and
    # leaves the policy's current-loop state untouched — the same pattern as the sibling `_run`
    # helpers.
    _loop = asyncio.new_event_loop()
    try:
        text = _loop.run_until_complete(drive())
    finally:
        _loop.close()
    assert text == "answer"
    rec = json.loads(open(llm_trace.trace_path()).read().splitlines()[-1])
    assert rec["callClass"] == "background-authoring"
    assert rec["finishReason"] == "stop"


# ── retention: trim by age, total-size, human formatting ───────────────────────

def test_trim_drops_old_jsonl_entries_keeps_new(data_dir):
    p = llm_trace.trace_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    now_ms = int(time.time() * 1000)
    old_ms = now_ms - 10 * 86400 * 1000
    with open(p, "w") as f:
        f.write(json.dumps({"ts": old_ms, "model": "old"}) + "\n")
        f.write(json.dumps({"ts": now_ms, "model": "new"}) + "\n")
    res = llm_trace.trim_logs(7)
    kept = open(p).read()
    assert "new" in kept and "old" not in kept
    assert res["removedBytes"] > 0 and res["afterBytes"] < res["beforeBytes"]


def test_trim_keep_everything_is_a_noop(data_dir):
    p = llm_trace.trace_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    old_ms = int(time.time() * 1000) - 100 * 86400 * 1000
    with open(p, "w") as f:
        f.write(json.dumps({"ts": old_ms, "model": "old"}) + "\n")
    res = llm_trace.trim_logs(0)   # 0 = keep everything
    assert "old" in open(p).read()
    assert res["removedBytes"] == 0


def test_trim_truncates_stale_log_files(data_dir):
    logp = os.path.join(str(data_dir), "stale.log")
    with open(logp, "w") as f:
        f.write("old content\n")
    old = time.time() - 30 * 86400
    os.utime(logp, (old, old))
    llm_trace.trim_logs(7)
    assert os.path.getsize(logp) == 0   # whole file older than the horizon → cleared


def test_trim_keeps_fresh_log_files(data_dir):
    logp = os.path.join(str(data_dir), "fresh.log")
    with open(logp, "w") as f:
        f.write("recent content\n")
    llm_trace.trim_logs(7)
    assert "recent content" in open(logp).read()


def test_total_log_bytes_counts_data_and_logs_subdir(data_dir):
    (data_dir / "a.jsonl").write_text("x" * 100)
    sub = data_dir / "logs"
    sub.mkdir()
    (sub / "b.log").write_text("y" * 50)
    assert llm_trace.total_log_bytes() == 150


def test_human_bytes():
    assert llm_trace.human_bytes(0) == "0 B"
    assert llm_trace.human_bytes(512) == "512 B"
    assert llm_trace.human_bytes(1536).endswith("KB")
    assert "MB" in llm_trace.human_bytes(5 * 1024 * 1024)


# ── the admin endpoints + the live source ──────────────────────────────────────

def test_llmio_is_a_selectable_live_source(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    client = TestClient(_app(), raise_server_exceptions=False)
    ids = [s["id"] for s in client.get("/api/admin/logs/sources").json()["sources"]]
    assert "llmio" in ids


def test_llmio_source_serves_the_ring(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    log_rings.LLMIO.push({"ts": 1, "level": "INFO", "logger": "llm-io", "msg": "llmio smoke line",
                          "args": "→", "result": "←"})
    client = TestClient(_app(), raise_server_exceptions=False)
    body = client.get("/api/admin/logs?source=llmio&since=0").json()
    assert any("llmio smoke line" in l["msg"] for l in body["lines"])


def test_retention_endpoint_is_admin_gated(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    client = TestClient(_app(), raise_server_exceptions=False)
    assert client.get("/api/admin/logs/retention").status_code == 403
    assert client.post("/api/admin/logs/trim").status_code == 403


def test_retention_get_reports_size_and_choices(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    (tmp_path / "llm-io.jsonl").write_text("z" * 321)
    client = TestClient(_app(), raise_server_exceptions=False)
    d = client.get("/api/admin/logs/retention").json()
    assert isinstance(d["traceEnabled"], bool)
    assert isinstance(d["retentionDays"], int) and d["retentionDays"] >= 0
    assert d["totalBytes"] >= 321 and d["totalHuman"]
    assert any(c["days"] == 0 for c in d["choices"])   # "keep everything" offered
    assert any(f["name"] == "llm-io.jsonl" for f in d["files"])


def test_trim_endpoint_frees_space(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    p = tmp_path / "llm-io.jsonl"
    now_ms = int(time.time() * 1000)
    p.write_text(json.dumps({"ts": now_ms - 10 * 86400 * 1000, "model": "old"}) + "\n" +
                 json.dumps({"ts": now_ms, "model": "new"}) + "\n")
    client = TestClient(_app(), raise_server_exceptions=False)
    d = client.post("/api/admin/logs/trim", json={"days": 7}).json()
    assert d["removedBytes"] > 0 and "removedHuman" in d
    assert "old" not in p.read_text() and "new" in p.read_text()


def test_retention_set_persists_setting(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    # Redirect the settings file into the tmp dir so the real config is untouched.
    monkeypatch.setattr(settings, "SETTINGS_FILE", str(tmp_path / "settings.json"))
    settings._invalidate_caches()
    client = TestClient(_app(), raise_server_exceptions=False)
    d = client.post("/api/admin/logs/retention", json={"traceEnabled": False, "retentionDays": 30}).json()
    assert d["traceEnabled"] is False and d["retentionDays"] == 30
    saved = json.loads((tmp_path / "settings.json").read_text())
    assert saved["llm_trace_enabled"] is False and saved["log_retention_days"] == 30


def test_status_page_carries_the_retention_controls(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    client = TestClient(_app(), raise_server_exceptions=False)
    body = client.get("/admin/status").text
    assert "LOG RETENTION" in body
    assert 'id="trace-toggle"' in body
    assert 'id="ret-days"' in body
    assert 'id="trim-now"' in body
    assert "/api/admin/logs/retention" in body
    assert "/api/admin/logs/trim" in body


def test_default_settings_carry_trace_and_retention():
    assert settings.DEFAULT_SETTINGS["llm_trace_enabled"] is True
    assert settings.DEFAULT_SETTINGS["log_retention_days"] == 7
