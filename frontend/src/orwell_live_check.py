"""ORW-1145 - the pre-cast test account for a dev live check (called by routes/admin_live_check_routes.py; it lives in src/ because it starts a season, which the route files may not do outside the sanctioned paths)."""
import asyncio
import logging
import time

logger = logging.getLogger(__name__)


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
