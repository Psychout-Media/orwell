"""ORW-1146 - the per-deployment daily image-spend cap, and the new-account image default for non-prod deployments.

Dev spent $3.15 on 68 unapproved portraits in 90 minutes (2026-11-26): every fresh test account's first page load started portrait generation.
Now:
  * ``ORWELL_DEPLOYMENT`` names the deployment. Unset or ``prod`` is production (nothing here changes it). Any other value (``dev``) is non-prod: a NEW account
    starts with ``image_gen_enabled`` off in its own prefs, unless ``ORWELL_IMAGE_GEN_NEW_ACCOUNTS=1`` says otherwise. The user can still turn it on.
  * ``ORWELL_IMAGE_DAILY_CAP_USD`` is a per-deployment cap on one UTC day's image spend. Default: no cap on prod, ``DEFAULT_NONPROD_CAP_USD`` on non-prod. ``off`` removes it.
    ``allow()`` is asked before every portrait provider call and refuses once the day's spend (the provider's own cost when it returned one, else
    ``ORWELL_IMAGE_COST_ESTIMATE_USD``, default ``DEFAULT_COST_ESTIMATE_USD``) plus one more image would pass the cap, and the first refusal of the day fires the ops alert
    (an admin-visible soft failure, RED on the status page).
  * ``snapshot()`` is the admin health page's row: today's image count and spend, the cap, the refusals.

Vault-free: counts, dates and dollars only.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Optional

from src.constants import DATA_DIR

logger = logging.getLogger(__name__)

DEFAULT_NONPROD_CAP_USD = 1.00
DEFAULT_COST_ESTIMATE_USD = 0.05
_LOCK = threading.Lock()
_PROD_NAMES = frozenset({"", "prod", "production"})
_TRUTHY = frozenset({"1", "true", "yes", "on"})


def _ledger_path() -> Path:
    return Path(os.environ.get("ORWELL_IMAGE_SPEND_FILE") or (Path(DATA_DIR) / "image-spend.json"))


def deployment() -> str:
    return os.environ.get("ORWELL_DEPLOYMENT", "").strip().lower() or "prod"


def is_prod() -> bool:
    return deployment() in _PROD_NAMES


def new_accounts_start_with_images_off() -> bool:
    """True on a non-prod deployment unless ``ORWELL_IMAGE_GEN_NEW_ACCOUNTS`` is truthy."""
    if is_prod():
        return False
    return os.environ.get("ORWELL_IMAGE_GEN_NEW_ACCOUNTS", "").strip().lower() not in _TRUTHY


def apply_new_account_defaults(username: str) -> bool:
    """Called once when an account is created: on a non-prod deployment write ``image_gen_enabled=false`` into the account's own prefs
    (never over a value already there). Returns True when it wrote. Never raises into account creation."""
    if not username or not new_accounts_start_with_images_off():
        return False
    try:
        from routes.prefs_routes import _load_for_user, _save_for_user
        prefs = _load_for_user(username) or {}
        if "image_gen_enabled" in prefs:
            return False
        prefs["image_gen_enabled"] = False
        _save_for_user(username, prefs)
        return True
    except Exception as e:  # failsoft-ok: the account is made either way; the daily cap is the backstop and the log says so
        logger.warning("[image-spend] could not set the new-account image default for %s: %s", username, e)
        return False


def daily_cap_usd() -> Optional[float]:
    """The day's cap in dollars, or None for no cap."""
    raw = os.environ.get("ORWELL_IMAGE_DAILY_CAP_USD", "").strip().lower()
    if raw in ("off", "none", "unlimited"):
        return None
    if raw:
        try:
            v = float(raw)
            if v == v and v >= 0:
                return v
        except ValueError:  # failsoft-ok: a malformed cap falls to the deployment default below
            pass
    return None if is_prod() else DEFAULT_NONPROD_CAP_USD


def cost_estimate_usd() -> float:
    try:
        v = float(os.environ.get("ORWELL_IMAGE_COST_ESTIMATE_USD", ""))
        if v == v and v >= 0:
            return v
    except ValueError:  # failsoft-ok: a malformed estimate falls to the default
        pass
    return DEFAULT_COST_ESTIMATE_USD


def _today(now: Optional[float] = None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() if now is None else now))


def _read(now: Optional[float] = None) -> dict:
    day = _today(now)
    try:
        data = json.loads(_ledger_path().read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("date") == day:
            return {"date": day, "count": int(data.get("count") or 0), "usd": float(data.get("usd") or 0.0),
                    "refused": int(data.get("refused") or 0), "alerted": bool(data.get("alerted"))}
    except Exception:  # failsoft-ok: no ledger, a new day or a corrupt file all read as an empty day
        pass
    return {"date": day, "count": 0, "usd": 0.0, "refused": 0, "alerted": False}


def _write(st: dict) -> None:
    p = _ledger_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".image-spend.")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(st, fh)
        os.replace(tmp, p)
    except Exception as e:  # failsoft-ok: a ledger that cannot be written must never break a game; the log says so
        logger.warning("[image-spend] ledger write failed: %s", e)


def _alert(st: dict, cap: float) -> None:
    try:
        from src import log_rings
        log_rings.record_soft_failure(
            "images:daily-cap",
            f"The daily image-spend cap on this {deployment()} deployment is reached: {st['count']} images, ${st['usd']:.2f} of ${cap:.2f} today (UTC). "
            "Further image calls are refused until tomorrow, or raise ORWELL_IMAGE_DAILY_CAP_USD.",
            corrected="image-cap")
    except Exception:  # failsoft-ok: the alert recorder never breaks the refusal itself
        pass


def allow(now: Optional[float] = None) -> bool:
    """False when one more image would pass today's cap. The first refusal of the day fires the ops alert."""
    cap = daily_cap_usd()
    if cap is None:
        return True
    with _LOCK:
        st = _read(now)
        if st["usd"] + cost_estimate_usd() <= cap + 1e-9:
            return True
        st["refused"] += 1
        fire = not st["alerted"]
        st["alerted"] = True
        _write(st)
    if fire:
        _alert(st, cap)
    return False


def record(cost: Optional[float] = None, now: Optional[float] = None) -> None:
    """Count one image made, at the provider's cost when it returned one, else the estimate."""
    c = cost if isinstance(cost, (int, float)) and not isinstance(cost, bool) and cost == cost and cost >= 0 else cost_estimate_usd()
    with _LOCK:
        st = _read(now)
        st["count"] += 1
        st["usd"] = round(st["usd"] + float(c), 6)
        _write(st)


def snapshot(now: Optional[float] = None) -> dict[str, Any]:
    """The admin health page's image row: today's (UTC) count and spend against the cap."""
    with _LOCK:
        st = _read(now)
    cap = daily_cap_usd()
    return {"deployment": deployment(), "date": st["date"], "count": st["count"], "usd": round(st["usd"], 4),
            "capUsd": cap, "refused": st["refused"], "capReached": bool(st["alerted"]),
            "newAccountsImagesOff": new_accounts_start_with_images_off()}
