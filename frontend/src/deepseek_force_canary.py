"""ORW-1014 - the DeepSeek forced-``tool_choice`` canary.

The agent loop forces a tool call at ceremony beats and stall advances when the narrator route honors it (``agent_loop._model_honors_forced_tool_choice``:
DeepSeek's own API with thinking disabled). That rests on one external fact - DeepSeek accepts ``tool_choice`` (auto / required / a named function) with
thinking off - which was a 2026-06 HTTP 400 once. This canary makes ONE forced call (a few hundred tokens, a fraction of a cent) through the app's own
default endpoint and FAILS LOUDLY (exit 1) if the provider rejects the request or answers without the named call. The doctor runs it on request
(``DOCTOR_FORCE_CANARY=1 bash deploy/orwell-doctor.sh --status``); ``python -m src.deepseek_force_canary`` runs it by hand.

Secrets: the endpoint and its headers are resolved at runtime through ``endpoint_resolver`` and never printed; only the outcome is.
"""
from __future__ import annotations

import json
import sys
from typing import Any, Optional

_TOOL = {
    "type": "function",
    "function": {
        "name": "recordMove",
        "description": "Record that the player moved to a room.",
        "parameters": {"type": "object", "properties": {"room": {"type": "string"}}, "required": ["room"]},
    },
}
_NOACTION = {
    "type": "function",
    "function": {"name": "noAction", "description": "Nothing to record.", "parameters": {"type": "object", "properties": {}}},
}
_CHOICE = {"type": "function", "function": {"name": "recordMove"}}


def build_payload(model: str, url: str) -> dict:
    """The one canary request, shaped as the narrator's own call is (tools on the wire, a named forced choice, thinking disabled on deepseek.com)."""
    payload: dict = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a conformance canary. Call the tool the request forces."},
            {"role": "user", "content": "let's go to the kitchen"},
        ],
        "tools": [_TOOL, _NOACTION],
        "tool_choice": _CHOICE,
        "max_tokens": 100,
        "temperature": 0,
    }
    from src.llm_core import _apply_deepseek_thinking_off
    _apply_deepseek_thinking_off(payload, url, model)
    return payload


def judge_response(status: int, body: Any) -> dict:
    """Pure verdict on one response: ok only for HTTP 200 carrying a tool call to the named function."""
    if status != 200:
        return {"ok": False, "status": status, "detail": f"HTTP {status}: the provider rejected a forced tool_choice"}
    try:
        msg = ((body.get("choices") or [{}])[0] or {}).get("message") or {}
        calls = msg.get("tool_calls") or []
    except Exception:
        return {"ok": False, "status": status, "detail": "unparseable response"}
    names = [((c or {}).get("function") or {}).get("name") for c in calls]
    if "recordMove" in names:
        return {"ok": True, "status": status, "detail": "forced call honored"}
    return {"ok": False, "status": status, "detail": f"HTTP 200 but the forced call was not made (tool calls: {names or 'none'})"}


def run_canary(timeout: float = 30.0, *, endpoint: Optional[tuple] = None) -> dict:
    """Make the one forced call. ``endpoint`` = (chat_url, model, headers) for tests; default is the app's own default endpoint.
    Returns {ok, skipped, status, detail}. Skipped (ok True) when the default route is not DeepSeek's own API: forcing is not enabled there."""
    import httpx
    if endpoint is None:
        from src.endpoint_resolver import resolve_endpoint
        endpoint = resolve_endpoint("default")
    url, model, headers = endpoint
    if not url or not model:
        return {"ok": False, "skipped": False, "status": None, "detail": "no default endpoint resolves"}
    from src.llm_core import _host_match
    if not _host_match(url, "deepseek.com"):
        return {"ok": True, "skipped": True, "status": None, "detail": "default route is not api.deepseek.com; forcing is not enabled there"}
    h = dict(headers or {})
    h["Content-Type"] = "application/json"
    try:
        r = httpx.post(url, headers=h, json=build_payload(model, url), timeout=timeout)
        try:
            body = r.json()
        except Exception:
            body = {}
        out = judge_response(r.status_code, body)
    except Exception as e:  # failsoft-ok: force-canary-single-call - the verdict IS the result: a failure is returned as ok=False and the CLI exits 1 loudly
        return {"ok": False, "skipped": False, "status": None, "detail": f"transport failure: {type(e).__name__}"}
    out["skipped"] = False
    return out


def main() -> int:
    out = run_canary()
    print(json.dumps({k: out.get(k) for k in ("ok", "skipped", "status", "detail")}))
    if out["ok"]:
        return 0
    print("FORCE CANARY FAILED: DeepSeek no longer honors a forced tool_choice with thinking off. "
          "Set ORWELL_DEEPSEEK_FORCE=0 (the rejecter list applies again) and open an ORW card.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
