"""ORW-1145 - the ops doors a dev LIVE CHECK needs (the script is scripts/live-run/live_check.py, documented in scripts/live-run/README.md).

Dev could not host a live check on 11-26: it auto-redeployed (restarting both services) on every main merge, and each fresh account blocked chat for 4-6 minutes
on cast authoring. Three admin-only routes, all refused on a production deployment (ORWELL_DEPLOYMENT unset or prod):

  POST /api/admin/ops/deploy-hold             {minutes?, reason?} or {clear: true}. Writes or removes data/.deploy-hold (``until=<epoch>``) which
                                              deploy/orwell-update.sh honours (a held run exits 0 and changes nothing). Bounded: at most 240 minutes,
                                              and the updater counts the hold from the file's own mtime, so a forgotten hold ends by itself.
  POST /api/admin/ops/prepare-test-account    {username, password, seed?, playerName?, authorTimeoutS?}. Makes the account (admin, so it resolves the
                                              global default model), turns its images OFF, starts a season through the engine with the fixed seed, and
                                              authors the whole cast NOW (inside this call, with no turn waiting on it), so turn 1 can be played at once.
  POST /api/admin/ops/delete-test-account     {username}. Deletes a livecheck- account (its engine sandbox is left to the next factory reset).

Vault-free: counts and ids only. The password is read from the body and handed to the account store; it is never logged or returned.
"""
import asyncio
import logging
import os
import re
import time
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from core.middleware import require_admin

logger = logging.getLogger(__name__)

HOLD_FILE = ".deploy-hold"
HOLD_MAX_MINUTES = 240
HOLD_DEFAULT_MINUTES = 60
TEST_ACCOUNT_RE = re.compile(r"^livecheck-[a-z0-9-]{1,32}$")
DEFAULT_AUTHOR_TIMEOUT_S = 900.0
DEFAULT_SEED = 20261128


def _refuse_prod() -> Optional[JSONResponse]:
    from src import orwell_image_spend
    if orwell_image_spend.is_prod():
        return JSONResponse(status_code=403, content={"ok": False, "reason": "refused: this is a production deployment (set ORWELL_DEPLOYMENT=dev on a dev box)"})
    return None


def hold_path() -> str:
    from routes.admin_health_routes import _ops_data_dir
    return os.path.join(_ops_data_dir(), HOLD_FILE)


def write_hold(minutes: int, reason: str, now: Optional[float] = None) -> dict:
    """Write the hold file atomically. Returns {held, until, minutes}."""
    t = time.time() if now is None else now
    until = int(t + minutes * 60)
    path = hold_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    safe_reason = re.sub(r"[^A-Za-z0-9 ._:,-]", "", reason or "live check")[:120]
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(f"until={until}\nreason={safe_reason}\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
    return {"held": True, "until": until, "minutes": minutes}


def clear_hold() -> dict:
    try:
        os.remove(hold_path())
    except FileNotFoundError:
        pass
    return {"held": False}


async def _body(request: Request) -> dict:
    try:
        b = await request.json()
    except Exception:
        return {}
    return b if isinstance(b, dict) else {}


def setup_admin_live_check_routes() -> APIRouter:
    router = APIRouter(prefix="/api/admin/ops", tags=["admin_live_check"])

    @router.post("/deploy-hold")
    async def admin_deploy_hold(request: Request):
        require_admin(request)
        if (r := _refuse_prod()) is not None:
            return r
        body = await _body(request)
        if body.get("clear") is True:
            logger.info("[ops] deploy hold cleared")
            return {"ok": True, **clear_hold()}
        m = body.get("minutes", HOLD_DEFAULT_MINUTES)
        if isinstance(m, bool) or not isinstance(m, int) or not (1 <= m <= HOLD_MAX_MINUTES):
            return JSONResponse(status_code=400, content={"ok": False, "reason": f"minutes must be an integer from 1 to {HOLD_MAX_MINUTES}"})
        out = write_hold(m, str(body.get("reason") or "live check"))
        logger.info("[ops] deploy hold set for %d minutes", m)
        return {"ok": True, **out}

    @router.post("/prepare-test-account")
    async def admin_prepare_test_account(request: Request):
        require_admin(request)
        if (r := _refuse_prod()) is not None:
            return r
        body = await _body(request)
        username = str(body.get("username") or "").strip().lower()
        password = body.get("password")
        if not TEST_ACCOUNT_RE.match(username):
            return JSONResponse(status_code=400, content={"ok": False, "reason": "username must look like livecheck-<letters, digits, dashes>"})
        if not isinstance(password, str) or len(password) < 12:
            return JSONResponse(status_code=400, content={"ok": False, "reason": "password (at least 12 characters) is required"})
        seed = body.get("seed", DEFAULT_SEED)
        if isinstance(seed, bool) or not isinstance(seed, int):
            return JSONResponse(status_code=400, content={"ok": False, "reason": "seed must be an integer"})
        player = str(body.get("playerName") or "Livecheck Player").strip()[:40] or "Livecheck Player"
        try:
            timeout_s = float(body.get("authorTimeoutS", DEFAULT_AUTHOR_TIMEOUT_S))
        except (TypeError, ValueError):
            timeout_s = DEFAULT_AUTHOR_TIMEOUT_S
        timeout_s = max(1.0, min(timeout_s, 1800.0))
        auth_mgr = getattr(request.app.state, "auth_manager", None)
        if auth_mgr is None:
            return JSONResponse(status_code=503, content={"ok": False, "reason": "no account store"})
        if not auth_mgr.create_user(username, password, is_admin=True):
            return JSONResponse(status_code=409, content={"ok": False, "reason": "that account already exists (or the name is reserved)"})
        return await prepare_account(username, player, seed, timeout_s)

    @router.post("/delete-test-account")
    async def admin_delete_test_account(request: Request):
        require_admin(request)
        if (r := _refuse_prod()) is not None:
            return r
        body = await _body(request)
        username = str(body.get("username") or "").strip().lower()
        if not TEST_ACCOUNT_RE.match(username):
            return JSONResponse(status_code=400, content={"ok": False, "reason": "only livecheck- accounts can be deleted here"})
        auth_mgr = getattr(request.app.state, "auth_manager", None)
        if auth_mgr is None:
            return JSONResponse(status_code=503, content={"ok": False, "reason": "no account store"})
        # delete_user needs an admin other than the account itself; a loopback-token caller has no account, so use any other admin.
        others = [u for u, rec in dict(auth_mgr.users).items() if u != username and isinstance(rec, dict) and rec.get("is_admin")]
        if not others:
            return JSONResponse(status_code=409, content={"ok": False, "reason": "no other admin account to act as"})
        deleted = bool(auth_mgr.delete_user(username, others[0]))
        logger.info("[ops] live-check account deleted: %s", deleted)
        return {"ok": deleted, "deleted": deleted}

    return router


async def prepare_account(username: str, player: str, seed: int, timeout_s: float) -> dict:
    """The account exists. Images off, season started through the engine with the fixed seed, the whole cast authored now."""
    from routes.orwell_routes import _roster_cards
    from routes.prefs_routes import _load_for_user, _save_for_user
    from src import orwell_cast_authoring, orwell_engine, orwell_prewarm

    prefs = _load_for_user(username) or {}
    prefs["image_gen_enabled"] = False
    _save_for_user(username, prefs)
    try:
        orwell_prewarm.reset_user_season(username)
        res = await orwell_engine.create_character(player, seed=seed, user=username)
    except Exception as e:
        logger.warning("[ops] live-check season start failed: %s", type(e).__name__)
        return {"ok": False, "created": True, "reason": f"season start failed: {type(e).__name__}"}
    if not isinstance(res, dict) or not res.get("started") or res.get("createRefused"):
        return {"ok": False, "created": True, "reason": "the engine refused the season"}
    state = await orwell_engine.get_game_state(user=username)
    cards = _roster_cards(state, username)
    total = len([c for c in cards if isinstance(c, dict) and (c.get("status") or "active") == "active" and not (c.get("isPlayer") or c.get("id") == "player")])
    t0 = time.time()
    missing = orwell_cast_authoring.unauthored_ids(username, cards)
    try:
        if missing:
            await asyncio.wait_for(orwell_cast_authoring.backfill_unauthored(missing, username), timeout=timeout_s)
    except asyncio.TimeoutError:
        logger.warning("[ops] live-check cast authoring timed out after %.0fs", timeout_s)
    state = await orwell_engine.get_game_state(user=username)
    left = orwell_cast_authoring.unauthored_ids(username, _roster_cards(state, username))
    authored = max(0, total - len(left))
    logger.info("[ops] live-check account ready: authored %d/%d in %.0fs", authored, total, time.time() - t0)
    return {"ok": True, "created": True, "seed": seed, "authored": authored, "total": total,
            "ready": not left, "imagesOff": True, "authorSeconds": round(time.time() - t0, 1)}
