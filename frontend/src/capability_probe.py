"""T0-4 (telemetry + probe arm) — the provider capability contract.

docs/audits/2026-07-21-campaign-report-and-exhaustive-backlog.md §T0-4. The live 2026-07 playtest
surfaced two launch-blocker-adjacent failure classes on the shipped default model/provider:

  * F2 — forced ``tool_choice`` silently ignored (20 forced selections, 7 honored, and the
    ledger had no record of the other 13 at all until the belt-telemetry flip alongside this).
  * F3 — reasoning/planning text leaking into the visible narration bubble because the provider
    inlines chain-of-thought into ``content`` instead of a separate reasoning channel
    (``reasoning_chars == 0``), so the FE's channel split (``chat.js``) never engages.

This module is the PROBE arm: a ~10-call capability check run against a configured model
endpoint, measuring three provider behaviors relevant to those failure classes:

  1. **forced tool_choice honoring** — does the provider actually call the named tool when
     ``tool_choice`` names it, or silently answer in prose instead?
  2. **json / structured-output conformance** — does ``response_format``-style JSON prompting
     return parseable JSON matching the requested shape?
  3. **reasoning-channel separation** — does the provider emit reasoning in its own field
     (``reasoning_content`` / ``reasoning``, chars > 0) or inline it into the visible ``content``
     (the exact GLM-4.7 failure mode T0-5 patches tactically)?

The result is persisted as a per-endpoint ``CapabilityProfile`` (Vault-free: ids / counts / rates
/ short tier tokens only — never a request or response BODY) in the FE settings store under
``capability_profiles.<endpoint_id>``, surfaced on ``/admin/status`` via the ``/api/admin/health``
snapshot's ``capability`` section (see ``routes/admin_health_routes.py``).

Kicked off as a best-effort BACKGROUND thread at endpoint registration
(``POST /api/model-endpoints``) — never blocks the registration response. Fail-soft throughout:
a probe-run failure or a detected RED capability both emit a #1599 RED-eligible health event via
``log_rings.record_soft_failure`` (never silently swallowed), and any exception here is caught and
logged, never raised into the caller.

Scope note: this is the TELEMETRY + PROBE arm only. The provider-PINNING arm (``require_parameters:
true`` + ``provider.only`` routing on tool_choice/response_format requests, role-split routing, the
auto-downgrade on a red capability) ships separately per the backlog's T0-4 scoping — this module
only MEASURES and SURFACES; it does not yet change what gets sent on a live turn.
"""

from __future__ import annotations

import logging
import threading
import time as _time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# Bump if the probe methodology changes shape (lets a future reader/migrator tell profiles apart).
CAPABILITY_PROBE_VERSION = 1

_DEFAULT_TIMEOUT = 12  # seconds per call — generous enough for a cold provider, still bounded.

_PROBE_TOOL_NAME = "orwell_capability_probe_respond"
_PROBE_TOOL = {
    "type": "function",
    "function": {
        "name": _PROBE_TOOL_NAME,
        "description": "Answer the probe question by calling this tool.",
        "parameters": {
            "type": "object",
            "properties": {"answer": {"type": "string", "description": "Your short answer."}},
            "required": ["answer"],
        },
    },
}

# ~10 calls total: 4 forced tool_choice + 3 json conformance + 3 reasoning-separation.
_TOOL_CHOICE_PROMPTS = (
    "Pick a color you like.",
    "Name a small animal.",
    "Say a short greeting.",
    "Name a number between 1 and 10.",
)
_JSON_PROMPTS = (
    'Reply with ONLY a JSON object of the shape {"result": <a short string>}. '
    "No prose, no markdown code fences — just the raw JSON object.",
    'Reply with ONLY a JSON object of the shape {"result": "ok"}. '
    "No prose, no markdown code fences — just the raw JSON object.",
    'Reply with ONLY a JSON object of the shape {"result": <a one-word color>}. '
    "No prose, no markdown code fences — just the raw JSON object.",
)
_REASONING_PROMPTS = (
    "What is 17 * 24? Reason it out step by step, then give just the final number.",
    "A train travels 60 miles in 90 minutes. Reason out its speed in mph step by step, "
    "then give just the final number.",
    "What is the next number in the sequence 2, 4, 8, 16? Reason it out step by step, "
    "then give just the number.",
)


def _post(base_url: str, api_key: str | None, model: str, payload: dict, timeout: float):
    """One raw chat-completions POST. Vault-free: callers never log the body, only outcomes."""
    from src.endpoint_resolver import build_chat_url, build_headers
    url = build_chat_url(base_url)
    headers = build_headers(api_key, base_url)
    headers["Content-Type"] = "application/json"
    body = dict(payload)
    body["model"] = model
    return httpx.post(url, headers=headers, json=body, timeout=timeout)


def _tool_choice_call(base_url: str, api_key: str | None, model: str, prompt: str,
                      timeout: float) -> bool | None:
    """One forced-tool_choice attempt. True = honored, False = ignored — EITHER the provider
    answered without calling the tool, OR it outright REJECTED the request (a 4xx/5xx HTTP
    status on a forced tool_choice call, e.g. 'tool_choice is not supported'). CodeRabbit P1
    (PR #1821): an API rejection is a genuine, meaningful capability signal — a provider that
    can't honor forced tools at all — and must count as a MISS in the denominator, not vanish as
    None (a provider that 400s on every forced call would otherwise show `toolChoice.tier ==
    'unknown'`, which is excluded from the overall-tier gate, so a provider that can NEVER honor
    tool_choice would score green/never trip `capability-red`). None is reserved strictly for a
    TRANSPORT failure (timeout, connection refused, an unparseable response) — genuine no-signal,
    not a provider answer."""
    payload = {
        "messages": [
            {"role": "system", "content": "You are being capability-tested. Follow instructions exactly."},
            {"role": "user", "content": prompt},
        ],
        "tools": [_PROBE_TOOL],
        "tool_choice": {"type": "function", "function": {"name": _PROBE_TOOL_NAME}},
        "max_tokens": 200,
        "temperature": 0,
    }
    try:
        resp = _post(base_url, api_key, model, payload, timeout)
        if not resp.is_success:
            # An API REJECTION (the provider refused the forced-tool_choice request outright) is
            # FAILED conformance for this dimension — a miss, not no-signal (P1 fix above).
            return False
        data = resp.json()
        msg = ((data.get("choices") or [{}])[0] or {}).get("message") or {}
        for call in (msg.get("tool_calls") or []):
            if (call.get("function") or {}).get("name") == _PROBE_TOOL_NAME:
                return True
        return False
    except Exception as e:
        # failsoft-ok: capability-probe-single-call — a transient failure on ONE of the ~10 probe
        # calls (network blip / provider hiccup) is expected-empty, not a hard failure (per
        # test_no_silent_failsoft.py's own docstring: "a capability probe that legitimately
        # returns 'unavailable' ... is normal flow, NOT a failure"). The caller's rate calc
        # excludes None outcomes entirely, and a probe that comes back with NO usable signal
        # (overallTier 'unknown') OR a genuinely RED capability is separately RED-recorded by
        # probe_endpoint_background — this per-call swallow is never the last line of defense.
        logger.debug("[capability-probe] tool_choice call failed: %s", e)
        return None


def _json_call(base_url: str, api_key: str | None, model: str, prompt: str,
              timeout: float) -> bool | None:
    """One JSON-conformance attempt. True = parsed as a JSON object with a 'result' key,
    False = the reply didn't parse/conform OR the provider REJECTED the request outright (a
    4xx/5xx on a `response_format`-json call — CodeRabbit P1, PR #1821: an API rejection is
    FAILED conformance, a real miss, not no-signal — see `_tool_choice_call`'s identical fix).
    None is reserved strictly for a TRANSPORT failure (timeout, connection refused)."""
    import json as _json
    from src.llm_core import ensure_json_word  # ORW-1024: a json_object request must say json in its prompt
    payload = {
        "messages": ensure_json_word([
            {"role": "system", "content": "You are being capability-tested. Follow instructions exactly."},
            {"role": "user", "content": prompt},
        ]),
        "response_format": {"type": "json_object"},
        "max_tokens": 200,
        "temperature": 0,
    }
    try:
        resp = _post(base_url, api_key, model, payload, timeout)
        if not resp.is_success:
            return False  # an API rejection is FAILED conformance, not no-signal
        data = resp.json()
        content = (((data.get("choices") or [{}])[0] or {}).get("message") or {}).get("content") or ""
        try:
            parsed = _json.loads(content.strip())
        except Exception:
            # Some providers wrap in a markdown fence despite instructions — a fair, forgiving
            # strip-and-retry before scoring it non-conformant.
            stripped = content.strip().strip("`").strip()
            if stripped.lower().startswith("json"):
                stripped = stripped[4:].strip()
            try:
                parsed = _json.loads(stripped)
            except Exception:
                return False
        return isinstance(parsed, dict) and "result" in parsed
    except Exception as e:
        # failsoft-ok: capability-probe-single-call — see _tool_choice_call's identical pragma;
        # one call's transient failure is expected-empty, backstopped by probe_endpoint_background's
        # RED record on a red/unknown overall profile.
        logger.debug("[capability-probe] json call failed: %s", e)
        return None


def _reasoning_call(base_url: str, api_key: str | None, model: str, prompt: str,
                    timeout: float) -> str | None:
    """One reasoning-separation attempt. 'separated' = the provider returned a non-empty
    reasoning/reasoning_content field, 'inline' = no separate channel (the F3 failure mode —
    any chain-of-thought had to have gone into the visible content instead), None = call failed."""
    payload = {
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 400,
        "temperature": 0,
    }
    try:
        resp = _post(base_url, api_key, model, payload, timeout)
        if not resp.is_success:
            return None
        data = resp.json()
        msg = ((data.get("choices") or [{}])[0] or {}).get("message") or {}
        reasoning = msg.get("reasoning_content") or msg.get("reasoning") or ""
        reasoning_chars = len(reasoning) if isinstance(reasoning, str) else 0
        return "separated" if reasoning_chars > 0 else "inline"
    except Exception as e:
        # failsoft-ok: capability-probe-single-call — see _tool_choice_call's identical pragma;
        # one call's transient failure is expected-empty, backstopped by probe_endpoint_background's
        # RED record on a red/unknown overall profile.
        logger.debug("[capability-probe] reasoning call failed: %s", e)
        return None


def _rate(vals: list, pred) -> float | None:
    if not vals:
        return None
    return sum(1 for v in vals if pred(v)) / len(vals)


def _tier(rate: float | None) -> str:
    """A coarse RED / YELLOW / GREEN read on an honoring/conformance rate. Thresholds are
    deliberately coarse (this is a triage signal, not a calibrated SLA) — RED below 50%
    (worse than a coin flip; the playtest's 7/20 ≈ 35% would land here), YELLOW below 90%
    (honors it MOST of the time but not reliably enough to trust blind), GREEN otherwise."""
    if rate is None:
        return "unknown"
    if rate < 0.5:
        return "red"
    if rate < 0.9:
        return "yellow"
    return "green"


def run_capability_probe(base_url: str, api_key: str | None, model: str,
                         *, timeout: float = _DEFAULT_TIMEOUT) -> dict:
    """Run the ~10-call T0-4 capability probe against one (base_url, model). Returns a
    Vault-free ``CapabilityProfile`` dict — counts / rates / short tier tokens only, never a
    request/response body. Never raises: a total failure still returns a well-shaped profile
    with empty rates (tier 'unknown') rather than propagating."""
    tool_results: list[bool] = []
    json_results: list[bool] = []
    reasoning_results: list[str] = []
    calls_failed = 0

    try:
        for prompt in _TOOL_CHOICE_PROMPTS:
            r = _tool_choice_call(base_url, api_key, model, prompt, timeout)
            if r is None:
                calls_failed += 1
            else:
                tool_results.append(r)
        for prompt in _JSON_PROMPTS:
            r = _json_call(base_url, api_key, model, prompt, timeout)
            if r is None:
                calls_failed += 1
            else:
                json_results.append(r)
        for prompt in _REASONING_PROMPTS:
            r = _reasoning_call(base_url, api_key, model, prompt, timeout)
            if r is None:
                calls_failed += 1
            else:
                reasoning_results.append(r)
    except Exception as e:  # belt-and-braces — the per-call helpers already swallow
        logger.warning("[capability-probe] probe run raised (degraded profile): %s", e)

    tool_honored_rate = _rate(tool_results, lambda v: v is True)
    json_conformance_rate = _rate(json_results, lambda v: v is True)
    reasoning_separated_rate = _rate(reasoning_results, lambda v: v == "separated")

    tool_tier = _tier(tool_honored_rate)
    json_tier = _tier(json_conformance_rate)
    dimension_tiers = [t for t in (tool_tier, json_tier) if t != "unknown"]
    if "red" in dimension_tiers:
        overall_tier = "red"
    elif "yellow" in dimension_tiers:
        overall_tier = "yellow"
    elif dimension_tiers:
        overall_tier = "green"
    else:
        overall_tier = "unknown"

    total_attempted = len(_TOOL_CHOICE_PROMPTS) + len(_JSON_PROMPTS) + len(_REASONING_PROMPTS)
    return {
        "version": CAPABILITY_PROBE_VERSION,
        "model": model,
        "probedAt": int(_time.time() * 1000),
        "callsAttempted": total_attempted,
        "callsFailed": calls_failed,
        "toolChoice": {
            "calls": len(tool_results),
            "honoredRate": tool_honored_rate,
            "tier": tool_tier,
        },
        "json": {
            "calls": len(json_results),
            "conformanceRate": json_conformance_rate,
            "tier": json_tier,
        },
        "reasoning": {
            "calls": len(reasoning_results),
            "separatedRate": reasoning_separated_rate,
            # A majority-vote read: True once at least half of the successful calls showed a
            # separate reasoning channel. None (no successful calls) reads as not-separated —
            # the conservative default (assume inline / needs the T0-5 scrub) rather than silently
            # assuming the channel is clean.
            "separated": bool(reasoning_separated_rate is not None and reasoning_separated_rate >= 0.5),
        },
        "overallTier": overall_tier,
    }


# ── persistence (the FE settings store) ──────────────────────────────────────────────────────

# Guards save_capability_profile / clear_capability_profile against EACH OTHER — see
# _scoped_capability_profiles_update's docstring for the lost-update race this closes (and the
# residual it does NOT close).
_SETTINGS_LOCK = threading.Lock()


def _scoped_capability_profiles_update(mutate) -> None:
    """Read-modify-write ONLY the ``capability_profiles`` settings key, under ``_SETTINGS_LOCK``,
    and NEVER through ``load_settings()``'s DEFAULT_SETTINGS-merged view.

    Why: the original implementation did ``settings = load_settings(); settings[k] = v;
    save_settings(settings)`` — a FULL-DICT read-merge-write. Two problems, both real (#1821):

      1. ``load_settings()`` merges every ``DEFAULT_SETTINGS`` key into the returned dict, so
         writing that whole dict back to disk silently PINS every default value (e.g.
         ``overseer_debug: 'off'``) as if it had been explicitly saved, even though it never
         was. ``is_setting_overridden()`` then reports it as user-set, which is wrong and can
         change behavior for a completely unrelated setting.
      2. It is a classic lost-update race: probe A reads the whole dict, probe B (or ANY other
         settings writer) reads the whole dict, A writes, then B writes its own full copy —
         silently reverting whatever A changed in between, in production as much as in tests
         (the capability probe runs on an unawaited background thread, so its write can land at
         an arbitrary moment relative to any other in-flight settings write).

    The fix here: re-open the RAW file fresh on every call (same technique as
    ``is_setting_overridden`` — never the cached/merged ``load_settings()``), mutate ONLY
    ``capability_profiles`` in place, and write back exactly that raw dict (never a
    DEFAULT_SETTINGS merge). ``mutate(raw_dict) -> bool`` mutates in place and returns whether
    anything changed; a no-op mutate skips the write entirely (preserves the prior
    no-write-on-noop behavior of ``clear_capability_profile``).

    RESIDUAL (by design, out of scope here): this only protects the probe's OWN two entry
    points from clobbering each other or a sibling key. A DIFFERENT settings writer elsewhere
    in the app that still does its own full-dict load-merge-save can still race this function
    and clobber ``capability_profiles`` if its read happens between our read and our write —
    the lock only serializes the two capability-probe call sites, not every settings writer in
    the process. Closing that fully would mean giving ``src.settings`` itself a process-wide
    scoped-update primitive; no such helper exists yet (grepped — every other writer still does
    its own load/mutate/save), so this module owns its own narrow fix rather than block on that
    larger change."""
    import json
    from src import settings as _settings_mod
    with _SETTINGS_LOCK:
        path = _settings_mod.SETTINGS_FILE
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if not isinstance(raw, dict):
                raw = {}
        except (FileNotFoundError, json.JSONDecodeError):
            raw = {}
        if mutate(raw):
            _settings_mod.save_settings(raw)


def save_capability_profile(endpoint_id: Any, profile: dict) -> None:
    """Persist one endpoint's CapabilityProfile into the FE settings store. Best-effort: a
    write failure is logged, never raised (probing must never break endpoint registration).
    Does a SCOPED update of ``capability_profiles`` only — see
    ``_scoped_capability_profiles_update`` for why a full-dict write was a lost-update hazard."""
    try:
        def _mutate(raw: dict) -> bool:
            profiles = dict(raw.get("capability_profiles") or {})
            profiles[str(endpoint_id)] = profile
            raw["capability_profiles"] = profiles
            return True
        _scoped_capability_profiles_update(_mutate)
    except Exception as e:
        logger.warning("[capability-probe] failed to persist profile for endpoint %s: %s",
                       endpoint_id, e)


def get_capability_profile(endpoint_id: Any) -> dict | None:
    """Read one endpoint's CapabilityProfile, or None if never probed / unreadable."""
    try:
        from src.settings import get_setting
        profiles = get_setting("capability_profiles", {}) or {}
        return profiles.get(str(endpoint_id))
    except Exception:
        return None


def get_all_capability_profiles() -> dict:
    """Every persisted CapabilityProfile, keyed by endpoint id. Vault-free; best-effort (a
    broken read answers {} rather than raising — the admin status poll must never hard-fail)."""
    try:
        from src.settings import get_setting
        return dict(get_setting("capability_profiles", {}) or {})
    except Exception:
        return {}


def clear_capability_profile(endpoint_id: Any) -> None:
    """Drop one endpoint's CapabilityProfile (CodeRabbit minor, PR #1821) — call this when the
    endpoint itself is deleted. A stale profile left behind after deletion can still light the
    `capability-red` alarm on /admin/status for an endpoint that no longer exists, which is
    exactly the kind of un-actionable RED noise #1599 warns against. Best-effort: a missing
    entry or a broken settings read/write is a no-op, never raised (deletion must never fail on
    this). Does a SCOPED update of ``capability_profiles`` only — see
    ``_scoped_capability_profiles_update`` for why a full-dict write was a lost-update hazard."""
    try:
        def _mutate(raw: dict) -> bool:
            profiles = dict(raw.get("capability_profiles") or {})
            if str(endpoint_id) not in profiles:
                return False
            profiles.pop(str(endpoint_id), None)
            raw["capability_profiles"] = profiles
            return True
        _scoped_capability_profiles_update(_mutate)
    except Exception as e:
        logger.warning("[capability-probe] failed to clear profile for endpoint %s: %s",
                       endpoint_id, e)


# ── the best-effort background probe run (kicked from endpoint registration) ────────────────
#
# KNOWN GAP (CodeRabbit nitpick, PR #1821, accepted as-is for now): the probe only fires on the
# FRESH-endpoint registration path (POST /api/model-endpoints) — an already-registered endpoint
# is never retro-probed, so its CapabilityProfile can go stale (or stay absent) until it is
# edited/re-added. No scheduled/periodic re-probe exists yet; a future T1-2-style nightly canary
# would close this (see docs/audits/2026-07-21-campaign-report-and-exhaustive-backlog.md §T1-2).


def probe_endpoint_background(endpoint_id: Any, base_url: str, api_key: str | None, model: str,
                              *, user: str | None = None) -> threading.Thread:
    """Fire-and-forget: run the ~10-call probe on a daemon thread, persist the result, and
    emit a #1599 RED-eligible health event for either a run failure OR a detected RED
    capability (a correction/finding is never a silent cloak — it must surface RED even when
    nothing crashed). Never blocks the caller; never raises.

    Returns the started ``Thread`` — every production caller ignores it (this stays genuinely
    fire-and-forget on the live request path), but it gives TESTS a real handle to ``.join()``
    in teardown so a probe kicked by an unmocked ``POST /api/model-endpoints`` in an unrelated
    test can't outlive that test and land its settings write during a LATER test's window (the
    exact background-thread race that surfaced the residual flake in
    tests/test_overseer_debug_telemetry.py — a stray probe thread completing mid-test and
    writing into whatever settings file happened to be monkeypatched at that instant)."""

    def _run() -> None:
        try:
            profile = run_capability_probe(base_url, api_key, model)
            profile["endpointId"] = str(endpoint_id)
            save_capability_profile(endpoint_id, profile)
            logger.info(
                "[capability-probe] endpoint=%s model=%s tier=%s toolChoiceRate=%s jsonRate=%s "
                "reasoningSeparated=%s failedCalls=%s/%s",
                endpoint_id, model, profile.get("overallTier"),
                profile.get("toolChoice", {}).get("honoredRate"),
                profile.get("json", {}).get("conformanceRate"),
                profile.get("reasoning", {}).get("separated"),
                profile.get("callsFailed"), profile.get("callsAttempted"))
            # RED-eligible per #1599: a genuinely RED capability AND a total probe washout
            # ('unknown' — every call failed, so there is no usable signal at all) both surface
            # here; only a clean green/yellow read with real signal stays quiet.
            tier = profile.get("overallTier")
            if tier in ("red", "unknown"):
                try:
                    from src import log_rings
                    log_rings.record_soft_failure(
                        "capability-probe:red-capability" if tier == "red"
                        else "capability-probe:no-signal",
                        f"endpoint {endpoint_id} model {model} probed {tier} "
                        f"(toolChoice={profile.get('toolChoice', {}).get('tier')} "
                        f"json={profile.get('json', {}).get('tier')} "
                        f"failedCalls={profile.get('callsFailed')}/{profile.get('callsAttempted')})",
                        corrected=None, user=user)
                except Exception:
                    # failsoft-ok: recorder-self — the RED-event write itself failing must never
                    # crash the probe thread; log_rings.record_soft_failure already WARN-logs the
                    # original finding before this can even be reached, so nothing goes silent.
                    pass
        except Exception as e:
            logger.warning("[capability-probe] run failed for endpoint %s: %s", endpoint_id, e)
            try:
                from src import log_rings
                log_rings.record_soft_failure("capability-probe:run-failed", e, corrected=None,
                                              user=user)
            except Exception:
                # failsoft-ok: recorder-self — see the inner except above; the WARN log two lines
                # up already surfaced this before the recorder write could fail.
                pass

    t = threading.Thread(target=_run, daemon=True, name=f"capability-probe-{endpoint_id}")
    t.start()
    return t
