"""ORW-1019 - one place that knows when a paid provider has run out of credit (HTTP 402).

Before: an out-of-credit text provider was hit by every cast-genesis call plus its strict retry (53 calls in 20
minutes on 2026-11-18), nothing said "balance", and only the image provider had a breaker (ORW-397).

Now, on the first 402 from a host:
  * the host is marked tripped; further calls to it answer 402 locally (no network) until a single re-probe is
    allowed every ``REPROBE_S``; a success clears it;
  * ONE admin-visible soft failure ``provider:credit-exhausted`` is recorded (RED on the admin status page, an alarm
    ``provider-credit``, a row in ``deploy/orwell-doctor.sh --status`` via ``GET /api/admin/provider-credit``); repeats
    for the same host are rate-limited to one per ``ALERT_INTERVAL_S``.

Balance prediction: ``orwell_provider_balance`` checks both providers' balance hourly (read-only) and warns under a
configurable line; ``snapshot()`` carries its rows and the ledger's spend for today and yesterday (UTC).

Vault-free: host names, counts, dates and costs only. Never a request body, never player text.
"""
from __future__ import annotations

import logging
import re
import threading
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

REPROBE_S = 300.0
ALERT_INTERVAL_S = 6 * 3600.0
_INFLIGHT_RE = re.compile(r"in[\s-]?flight", re.IGNORECASE)

_LOCK = threading.Lock()
_HOSTS: dict[str, dict] = {}


def is_credit_error(status: Any, body: Any = None) -> bool:
    """True for HTTP 402 that is a real empty balance. A 402 that says the account would exceed its credits given requests
    already in flight is back-pressure (ORW-397), not billing."""
    try:
        if int(status) != 402:
            return False
    except (TypeError, ValueError):
        return False
    return not _INFLIGHT_RE.search(str(body or "")[:2000])


def _host(url_or_host: Any) -> str:
    s = str(url_or_host or "").strip().lower()
    if "://" in s:
        s = s.split("://", 1)[1]
    return s.split("/", 1)[0] or "unknown"


def note(url_or_host: Any, status: Any, body: Any = None, *, kind: str = "text", now: Optional[float] = None) -> bool:
    """Record a provider answer. Returns True when it was a credit error (the host is now tripped)."""
    if not is_credit_error(status, body):
        return False
    t = time.monotonic() if now is None else now
    h = _host(url_or_host)
    with _LOCK:
        rec = _HOSTS.get(h)
        first = rec is None
        if first:
            rec = {"host": h, "kind": kind, "since": time.time(), "count": 0, "probe_at": t + REPROBE_S, "alerted_at": None}
            _HOSTS[h] = rec
        rec["count"] += 1
        rec["last"] = time.time()
        rec["probe_at"] = t + REPROBE_S  # a failed re-probe closes the door again
        due = rec["alerted_at"] is None or (t - rec["alerted_at"]) >= ALERT_INTERVAL_S
        if due:
            rec["alerted_at"] = t
    if due:
        _alert(h, kind)
    return True


def _alert(host: str, kind: str) -> None:
    try:
        from src import log_rings
        log_rings.record_soft_failure(
            "provider:credit-exhausted",
            f"{kind} provider {host} answered HTTP 402: out of credit. Calls to it are paused (one re-probe every "
            f"{int(REPROBE_S // 60)} min); top up the account, then it resumes by itself.",
            corrected="credit-breaker")
    except Exception:  # pragma: no cover - failsoft-ok: recorder-self
        pass


def blocked(url_or_host: Any, now: Optional[float] = None) -> bool:
    """True when the host is tripped and its re-probe time has not come. When the time has come, ONE caller is let through."""
    h = _host(url_or_host)
    t = time.monotonic() if now is None else now
    with _LOCK:
        rec = _HOSTS.get(h)
        if rec is None:
            return False
        if t >= rec["probe_at"]:
            rec["probe_at"] = t + REPROBE_S  # this caller is the probe; the rest wait
            return False
        return True


def any_blocked(kind: str = "text", now: Optional[float] = None) -> bool:
    t = time.monotonic() if now is None else now
    with _LOCK:
        return any(r["kind"] == kind and t < r["probe_at"] for r in _HOSTS.values())


def clear(url_or_host: Any) -> None:
    with _LOCK:
        _HOSTS.pop(_host(url_or_host), None)


def reset() -> None:
    with _LOCK:
        _HOSTS.clear()


def daily_spend(days: int = 2) -> dict:
    """Ledger cost per UTC date over all users, newest ``days`` dates: ``{"2026-11-26": 1.23, ...}``. Empty on any error."""
    try:
        from src import orwell_token_ledger as L
        with L._LOCK:
            roll = L._load_rollup()
        out: dict[str, float] = {}
        for u in roll.values():
            for date, rows in ((u or {}).get("daily") or {}).items():
                out[date] = out.get(date, 0.0) + sum(float((r or {}).get("cost") or 0.0) for r in (rows or {}).values())
        return {d: round(out[d], 4) for d in sorted(out)[-days:]}
    except Exception:
        return {}


def snapshot() -> dict:
    with _LOCK:
        tripped = [{"host": r["host"], "kind": r["kind"], "sinceEpoch": int(r["since"]), "count": r["count"]} for r in _HOSTS.values()]
    try:
        from src import orwell_provider_balance
        balances = orwell_provider_balance.snapshot()
    except Exception:
        balances = []
    spend = daily_spend()
    parts = []
    if tripped:
        parts.append("out of credit: " + ", ".join(t["host"] for t in tripped))
    for b in balances:
        when = time.strftime("%Y-%m-%d %H:%MZ", time.gmtime(b["checkedAt"]))
        if b["status"] == "unknown":
            last = f", last ${b['balanceUsd']}" if b.get("balanceUsd") is not None else ""
            parts.append(f"{b['provider']} balance unknown{last} (checked {when})")
        else:
            flag = f" LOW, under ${b['warnUsd']}" if b["status"] == "low" else ""
            parts.append(f"{b['provider']} ${b['balanceUsd']}{flag} (checked {when})")
    if spend:
        d = sorted(spend)[-1]
        parts.append(f"spend {d} ${spend[d]}")
    return {"tripped": tripped, "degraded": bool(tripped), "dailySpendUsd": spend, "balances": balances,
            "lowBalance": any(b.get("status") == "low" for b in balances), "summary": " | ".join(parts)}
