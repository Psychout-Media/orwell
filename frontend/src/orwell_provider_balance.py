"""ORW-1019 follow-up - an hourly, READ-ONLY balance check of the two paid providers the app uses.

DeepSeek ``GET https://api.deepseek.com/user/balance`` and OpenRouter ``GET https://openrouter.ai/api/v1/credits`` (purchased
minus used), each with the app's own enabled endpoint key (the ``model_endpoints`` row, key never logged or returned).
Nothing here spends, tops up or changes billing.

* Under ``provider_balance_warn_usd`` (setting, default 5): the admin status row and ``orwell-doctor.sh --status`` show a
  WARN, and ONE soft failure ``provider:balance-low`` per provider is raised, at most once per ``ALERT_INTERVAL_S``.
* A failed check (network, an endpoint change, a key the endpoint refuses, a non-USD DeepSeek wallet) reads "unknown",
  logs once, and backs off (1 h, doubling to 6 h); never an error storm. A later success clears it.

Vault-free: provider names, dollars and times only.
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

CHECK_INTERVAL_S = 3600.0
MAX_BACKOFF_S = 6 * 3600.0
ALERT_INTERVAL_S = 6 * 3600.0
DEFAULT_WARN_USD = 5.0
_URLS = {"deepseek": "https://api.deepseek.com/user/balance", "openrouter": "https://openrouter.ai/api/v1/credits"}

_LOCK = threading.Lock()
_STATE: dict[str, dict] = {}


def warn_threshold() -> float:
    try:
        from src.settings import get_setting
        v = float(get_setting("provider_balance_warn_usd", DEFAULT_WARN_USD))
        return v if v > 0 else DEFAULT_WARN_USD
    except Exception:
        return DEFAULT_WARN_USD


def parse_balance(provider: str, data: Any) -> Optional[float]:
    """USD balance from a provider answer, or None when it cannot be read as one."""
    try:
        if provider == "deepseek":
            for info in data.get("balance_infos") or []:
                if str(info.get("currency", "")).upper() == "USD":
                    return float(info["total_balance"])
            return None
        if provider == "openrouter":
            d = data["data"]
            return round(float(d["total_credits"]) - float(d["total_usage"]), 4)
    except Exception:
        return None
    return None


def _provider_of(base_url: Any) -> Optional[str]:
    h = str(base_url or "").lower().split("://", 1)[-1].split("/", 1)[0]
    if h == "deepseek.com" or h.endswith(".deepseek.com"):
        return "deepseek"
    if h == "openrouter.ai" or h.endswith(".openrouter.ai"):
        return "openrouter"
    return None


def endpoint_keys() -> dict[str, str]:
    """``{provider: api key}`` from the enabled model endpoints (first with a key wins). Empty on any error."""
    out: dict[str, str] = {}
    try:
        from core.database import SessionLocal, ModelEndpoint
        db = SessionLocal()
        try:
            for ep in db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True).order_by(ModelEndpoint.created_at).all():  # noqa: E712
                p = _provider_of(ep.base_url)
                key = (ep.api_key or "").strip() if p else ""
                if p and key and p not in out:
                    out[p] = key
        finally:
            db.close()
    except Exception:
        return {}
    return out


async def _http_get(url: str, key: str) -> tuple[int, Any]:
    import httpx
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as c:
        r = await c.get(url, headers={"Authorization": f"Bearer {key}"})
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, None


def _alert(provider: str, balance: float, limit: float) -> None:
    try:
        from src import log_rings
        log_rings.record_soft_failure(
            "provider:balance-low",
            f"{provider} balance is ${balance:.2f}, under the ${limit:.2f} warning line. Top up the account before it runs out.",
            corrected="balance-check")
    except Exception:  # pragma: no cover - failsoft-ok: recorder-self
        pass


async def check_once(now: Optional[float] = None, *, get=None, keys: Optional[dict] = None) -> None:
    """One pass. A provider is only asked when its next check time has come. Never raises."""
    t = time.time() if now is None else now
    get = get or _http_get
    keys = endpoint_keys() if keys is None else keys
    limit = warn_threshold()
    for provider, key in keys.items():
        with _LOCK:
            st = _STATE.setdefault(provider, {"balance": None, "checkedAt": None, "ok": None, "fails": 0, "nextAt": 0.0, "alertedAt": None})
            if t < st["nextAt"]:
                continue
        bal: Optional[float] = None
        try:
            status, data = await get(_URLS[provider], key)
            if status == 200:
                bal = parse_balance(provider, data)
        except Exception:
            bal = None
        with _LOCK:
            st["checkedAt"] = t
            if bal is None:
                first = st["fails"] == 0
                st["fails"] += 1
                st["ok"] = False
                st["nextAt"] = t + min(CHECK_INTERVAL_S * (2 ** (st["fails"] - 1)), MAX_BACKOFF_S)
                fire = False
            else:
                first = False
                st["fails"], st["ok"], st["balance"] = 0, True, bal
                st["nextAt"] = t + CHECK_INTERVAL_S
                fire = bal < limit and (st["alertedAt"] is None or t - st["alertedAt"] >= ALERT_INTERVAL_S)
                if fire:
                    st["alertedAt"] = t
        if first:
            logger.info("[balance] %s balance check unavailable; status unknown, backing off", provider)
        if fire:
            _alert(provider, bal, limit)


def snapshot() -> list:
    """Per provider: ``{provider, balanceUsd (last known), checkedAt (epoch), status: ok|low|unknown, warnUsd}``."""
    limit = warn_threshold()
    with _LOCK:
        rows = []
        for p, st in _STATE.items():
            if st["checkedAt"] is None:
                continue
            status = "unknown" if not st["ok"] else ("low" if st["balance"] is not None and st["balance"] < limit else "ok")
            rows.append({"provider": p, "balanceUsd": st["balance"], "checkedAt": int(st["checkedAt"]), "status": status, "warnUsd": limit})
    return rows


def reset() -> None:
    with _LOCK:
        _STATE.clear()


async def run_forever(first_delay: float = 60.0, tick: float = 300.0) -> None:
    """Background loop: ``check_once`` respects each provider's own schedule, so ticking often is cheap."""
    await asyncio.sleep(first_delay)
    while True:
        try:
            await check_once()
        except Exception:  # pragma: no cover - failsoft-ok: a balance check never hurts the app
            pass
        await asyncio.sleep(tick)
