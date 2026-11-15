"""ORW-369: upgrade a running season's old-wording portraits in the background, one houseguest at a time.

When the portrait prompt wording changes (ORW-361, PORTRAIT_PROMPT_VERSION) a season already being
played keeps faces shot under the old wording. This module walks them quietly:

  * the current season only (the roster the engine serves for the user now; a saved season is
    upgraded when it is loaded, i.e. when it becomes the user's current season);
  * `stale_portrait_ids(manifest)` minus the player (whatever its source) minus anyone not in the house;
  * a single asyncio task per process, off the request path, holding no lock the chat/stream path
    needs: first houseguest ~45 s after the user is first seen (or the season changes), then ~15 s apart;
  * if a full cast generation is running for that user it waits;
  * per houseguest: (1) fill in the clothing pieces + on-camera line when the public profile lacks them
    (one writer call over PUBLIC fields only; needs ORW-360's look fields, behind `look_fill_supported`),
    (2) fetch the fresh prompt from the engine, (3) one forced silent re-shoot. The old file stays until
    the new image succeeds, then swaps atomically and records the current prompt version;
  * a failure keeps the old photo, is recorded RED through the portrait failure recorder, and that
    houseguest is retried later with a growing wait (5, 15, 45 min, then every 2 h). The loop never
    stops itself; in-memory state only, a restart re-scans.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

logger = logging.getLogger(__name__)

START_DELAY_S = 45.0
GAP_S = 15.0
TICK_S = 5.0
RETRY_WAITS_S = (5 * 60.0, 15 * 60.0, 45 * 60.0)
RETRY_STEADY_S = 2 * 60 * 60.0

# The ONLY card fields the look writer ever sees (public profile). Never a Vault-adjacent field.
WRITER_INPUT_FIELDS = ("identityConcept", "archetype", "demeanor", "presentation", "age", "vocation",
                       "hometown", "biography", "voice", "style", "styleFamily")
_PHYS_PUBLIC_FIELDS = ("presentation", "style", "styleFamily", "family")
ON_CAMERA_MAX = 240
ON_CAMERA_SPOTS = ("kitchen", "living room", "dining room", "backyard", "lounge", "bedroom")
WARDROBE_MAX_ITEMS = 3
WARDROBE_ITEM_MAX = 60

# per safe-user state: {"sig", "armed_at", "next_ok_at", "fails": {sid: n}, "retry_at": {sid: ts},
#                       "started_at", "done": int, "failed": int}
_STATE: dict = {}
_TASK = None
_BUSY: set = set()  # safe users with an upgrade step in flight (never two at once for one user)


def _st(user) -> dict:
    from src import orwell_portraits as P
    return _STATE.setdefault(P._safe_user(user), {"sig": None, "armed_at": None, "next_ok_at": 0.0,
                                                  "fails": {}, "retry_at": {}, "started_at": None,
                                                  "done": 0, "failed": 0})


def look_fill_supported() -> bool:
    """The look fill-in needs ORW-360's engine fields; off (clear seam) until that code is present."""
    try:
        from src import orwell_engine
        if not hasattr(orwell_engine, "record_look_extras"):
            return False
        import src.orwell_style_families  # noqa: F401  (ORW-360's module)
        return True
    except Exception:
        return False


def retry_wait_s(n_failures: int) -> float:
    """5, 15, 45 min after failures 1..3, then every 2 h."""
    return RETRY_WAITS_S[n_failures - 1] if 1 <= n_failures <= len(RETRY_WAITS_S) else RETRY_STEADY_S


def _season_sig(state: dict) -> tuple:
    """Identity of the season now loaded: player + house names/ids. A different value = a load."""
    house = state.get("house") if isinstance(state.get("house"), list) else []
    player = state.get("player") if isinstance(state.get("player"), dict) else {}
    return (str(player.get("name") or ""),
            tuple(sorted(str(h.get("id") or h.get("name")) + ":" + str(h.get("name")) for h in house
                         if isinstance(h, dict))))


def stale_candidates(user, state: dict, manifest: dict) -> list:
    """Stale houseguest ids in the CURRENT season's active house, player excluded."""
    from src import orwell_portraits as P
    active = set()
    for hg in state.get("house") if isinstance(state.get("house"), list) else []:
        if isinstance(hg, dict) and hg.get("name") and (hg.get("status") or "active") == "active":
            active.add(P._safe_id(str(hg.get("id") or hg.get("name"))))
    pid = state.get("player") if isinstance(state.get("player"), dict) else {}
    player_ids = {P.PLAYER_PORTRAIT_ID, P._safe_id(str(pid.get("id") or "player"))}
    return [sid for sid in P.stale_portrait_ids(manifest) if sid in active and sid not in player_ids]


# ── the look writer (public fields only) ─────────────────────────────────────────────────────

def writer_input(card: dict) -> dict:
    """Allowlisted PUBLIC profile fields for the look writer; nothing else can ride."""
    out = {k: card[k] for k in WRITER_INPUT_FIELDS if card.get(k) not in (None, "", [], {})}
    phys = card.get("physicalCharacteristics")
    if isinstance(phys, dict):
        sub = {k: phys[k] for k in _PHYS_PUBLIC_FIELDS if phys.get(k) not in (None, "")}
        if sub:
            out["physicalCharacteristics"] = sub
    if isinstance(out.get("biography"), str):
        out["biography"] = out["biography"][:600]
    return out


def needs_look(card: dict) -> bool:
    phys = card.get("physicalCharacteristics")
    phys = phys if isinstance(phys, dict) else {}
    return not (phys.get("wardrobe") and phys.get("onCamera"))


def _validate_wardrobe(v) -> Optional[list]:
    if not isinstance(v, list):
        return None
    items = [" ".join(str(x).split()) for x in v if isinstance(x, str) and str(x).strip()]
    if not 2 <= len(items) <= WARDROBE_MAX_ITEMS or any(len(i) > WARDROBE_ITEM_MAX for i in items):
        return None
    return items


def _validate_on_camera(v) -> Optional[str]:
    if not isinstance(v, str):
        return None
    t = " ".join(v.split())
    if not t or len(t) > ON_CAMERA_MAX:
        return None
    return t if any(spot in t.lower() for spot in ON_CAMERA_SPOTS) else None


def _validate_look(raw: dict) -> dict:
    """ORW-360's validators when that module is present (the one source of the rules), else the local
    equivalents. A field that fails is omitted."""
    out = {}
    try:
        from src import orwell_style_families as sf  # ORW-360
        vw = getattr(sf, "validate_wardrobe", None)
        vc = getattr(sf, "validate_on_camera", None)
    except Exception:
        vw = vc = None
    for key, local, ext in (("wardrobe", _validate_wardrobe, vw), ("onCamera", _validate_on_camera, vc)):
        val = local(raw.get(key)) if isinstance(raw, dict) else None
        if val is not None and ext is not None:
            try:
                ok = ext(val)
                val = val if (ok is True or ok is None or ok) else None
            except Exception:
                val = None
        if val is not None:
            out[key] = val
    return out


_LOOK_SYSTEM = (
    "You write two short fields for one reality-show houseguest from their PUBLIC profile only. "
    "Reply with ONLY a JSON object: {\"wardrobe\": [2-3 short items], \"onCamera\": \"...\"}. "
    "wardrobe: 2-3 specific clothing pieces in their style family; no visible words, logos, band or "
    "brand names. onCamera: 1-2 sentences, at most 240 characters, visible personality only, placed in "
    "exactly one spot from: kitchen, living room, dining room, backyard, lounge, a bedroom.")
_LOOK_RETRY = ("Your reply was not valid. Reply with ONLY the JSON object, wardrobe 2-3 short items "
               "without words/logos/brands, onCamera at most 240 characters naming one house spot.")


async def write_look(card: dict, owner) -> dict:
    """One writer call (+ one strict retry) over `writer_input(card)`; returns the validated subset
    ({} when nothing passed or no model)."""
    import json
    from src import orwell_cast_authoring as CA
    llm = await CA.resolve_authoring_llm_fn(owner)
    if llm is None:
        return {}
    messages = [{"role": "system", "content": _LOOK_SYSTEM},
                {"role": "user", "content": json.dumps(writer_input(card), ensure_ascii=False)}]
    look: dict = {}
    for attempt in (0, 1):
        msgs = messages if attempt == 0 else messages + [{"role": "user", "content": _LOOK_RETRY}]
        try:
            text = await llm(msgs)
        except Exception as e:  # failsoft-ok: best-effort-enrichment (the look is optional; the photo still upgrades)
            logger.info("[portrait-upgrade] look writer call failed: %s", e)
            continue
        raw = CA._extract_json(text or "")
        got = _validate_look(raw or {})
        look.update({k: v for k, v in got.items() if k not in look})
        if len(look) == 2:
            break
    return look


# ── one step ─────────────────────────────────────────────────────────────────────────────────

def _full_generation_running(user) -> bool:
    from src import orwell_portraits as P
    rec = P._GEN_PROGRESS.get(P._safe_user(user))
    if isinstance(rec, dict) and rec.get("active"):
        return True
    return bool(P._INFLIGHT.get(P._safe_user(user)))


def _portrait_cost_since(user, since_ms: int) -> float:
    try:
        from src import orwell_token_ledger as L
        return sum(float(e.get("cost") or 0) for e in L.get_recent(user, 500)
                   if e.get("callClass") == "portrait" and int(e.get("ts") or 0) >= since_ms)
    except Exception:
        return 0.0


async def upgrade_one(user, sid: str, card: dict) -> bool:
    """Fill in the look when missing, then force the single silent re-shoot. True on a landed new face."""
    from src import orwell_engine
    from src import orwell_portraits as P
    if look_fill_supported() and needs_look(card):
        try:
            look = await write_look(card, user)
            if look:
                await orwell_engine.record_look_extras(sid, look, user=user)
        except Exception as e:  # failsoft-ok: best-effort-enrichment (no look is fine; the photo still upgrades)
            logger.info("[portrait-upgrade] look fill-in for %s skipped: %s", sid, e)
    pp = await orwell_engine.get_portrait_prompt(sid, user=user)
    if not isinstance(pp, dict) or not pp.get("prompt"):
        raise RuntimeError("no-prompt")
    entry = {"houseguestId": sid, "name": pp.get("name") or card.get("name") or "", "prompt": pp["prompt"]}
    await P.generate_and_store([entry], user, record_beats=False, force_ids=[sid], silent=True)
    stored = P.load_manifest(user).get(P._safe_id(sid))
    if isinstance(stored, dict) and not P._entry_version_stale(stored):
        return True
    raise RuntimeError(P.last_gen_error_class(user, sid) or "generation-failed")


async def upgrade_tick(user, *, now: Optional[float] = None) -> str:
    """One scheduling step for one user: at most ONE houseguest is upgraded. Returns a short status
    ('idle', 'waiting', 'busy', 'upgraded', 'failed', 'done')."""
    from src import orwell_engine
    from src import orwell_portraits as P
    now = time.monotonic() if now is None else now
    safe = P._safe_user(user)
    if safe in _BUSY:
        return "busy"
    if P.image_gen_disabled():
        return "idle"
    st = _st(user)
    try:
        state = await orwell_engine.get_game_state(user=user)
    except Exception:  # failsoft-ok: expected-empty (engine down => idle this cycle)
        return "idle"
    if not isinstance(state, dict) or state.get("started") is False:
        return "idle"
    sig = _season_sig(state)
    if st["sig"] != sig:  # first sight, or a different season was loaded: restart the quiet window
        st.update(sig=sig, armed_at=now, next_ok_at=0.0, fails={}, retry_at={}, started_at=None,
                  done=0, failed=0)
    cands = stale_candidates(user, state, P.load_manifest(user))
    if not cands:
        if st["started_at"] is not None:  # this season's upgrade just finished: one line with its cost
            cost = _portrait_cost_since(user, st["started_at"])
            logger.info("[portrait-upgrade] season upgrade finished for %s: %d upgraded, %d failed this run, "
                        "portrait spend this upgrade $%.4f", safe, st["done"], st["failed"], cost)
            st["started_at"] = None
        return "done" if st["done"] else "idle"
    if now < st["armed_at"] + START_DELAY_S or now < st["next_ok_at"]:
        return "waiting"
    if _full_generation_running(user) or not P.image_generation_available(user):
        return "waiting"
    ready = [c for c in cands if st["retry_at"].get(c, 0.0) <= now]
    if not ready:
        return "waiting"
    sid = ready[0]
    card = next((h for h in state.get("house", []) if isinstance(h, dict)
                 and P._safe_id(str(h.get("id") or h.get("name"))) == sid), {})
    if st["started_at"] is None:
        st["started_at"] = int(time.time() * 1000)
    _BUSY.add(safe)
    try:
        await upgrade_one(user, str(card.get("id") or sid), card)
        st["fails"].pop(sid, None)
        st["retry_at"].pop(sid, None)
        st["done"] += 1
        st["next_ok_at"] = now + GAP_S
        logger.info("[portrait-upgrade] %s upgraded for %s", sid, safe)
        return "upgraded"
    except Exception as e:  # failsoft-ok: handled-by-terminal (the old photo stays; recorded RED below; retried later)
        reason = str(e) or type(e).__name__
        n = st["fails"].get(sid, 0) + 1
        st["fails"][sid] = n
        st["retry_at"][sid] = now + retry_wait_s(n)
        st["failed"] += 1
        st["next_ok_at"] = now + GAP_S
        P._note_gen_error("portrait-upgrade-failed", reason)
        P._note_generation_failure(user, sid, f"portrait-upgrade-failed: {reason}")
        logger.info("[portrait-upgrade] %s failed for %s (%s); old photo kept, retry in %.0fs",
                    sid, safe, reason, retry_wait_s(n))
        return "failed"
    finally:
        _BUSY.discard(safe)


async def upgrade_once() -> dict:
    """One sweep over every user the portrait surfaces have seen this process."""
    from src import orwell_portraits as P
    out = {}
    for safe, raw in list(P._SEEN_USERS.items()):
        try:
            out[safe] = await upgrade_tick(raw)
        except Exception as e:  # failsoft-ok: best-effort-enrichment (one user's trouble never starves another)
            logger.info("[portrait-upgrade] tick for %s failed: %s", safe, e)
            out[safe] = "error"
    return out


async def _loop() -> None:
    while True:
        await asyncio.sleep(TICK_S)
        try:
            await upgrade_once()
        except asyncio.CancelledError:  # pragma: no cover
            raise
        except Exception as e:  # pragma: no cover - failsoft-ok: loop keepalive
            logger.info("[portrait-upgrade] sweep error: %s", e)


def ensure_upgrader_started() -> bool:
    """Start the single background upgrade task on the running loop (idempotent)."""
    global _TASK
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return False
    if _TASK is not None and not _TASK.done():
        try:
            if _TASK.get_loop() is loop:
                return False
        except Exception:  # pragma: no cover
            pass
    _TASK = loop.create_task(_loop())
    return True
