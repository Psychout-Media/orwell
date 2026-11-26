"""ORW-369: upgrade a running season's old-wording portraits in the background.

ORW-378: while a game is live (a player message within the last 15 minutes, the SAME signal the
updater uses to defer an update: deploy/orwell-live-game.sh) it is one houseguest at a time with the
15 s gap below. With nobody playing it upgrades up to `portrait_parallel` (default 3, 1-4) at once with
no pause. A provider 429 drops the rest of that season's upgrade to one at a time.

When the portrait prompt wording changes (ORW-361, PORTRAIT_PROMPT_VERSION) a season already being
played keeps faces shot under the old wording. This module walks them quietly:

  * the current season only (the roster the engine serves for the user now; a saved season is
    upgraded when it is loaded, i.e. when it becomes the user's current season);
  * `stale_portrait_ids(manifest)` minus the player (whatever its source) minus anyone not in the house;
  * a single asyncio task per process, off the request path, holding no lock the chat/stream path
    needs: first houseguest ~45 s after the user is first seen (or the season changes), then ~15 s apart;
  * if a full cast generation is running for that user it waits;
  * per houseguest: (1) fill in the clothing pieces + on-camera line when the public profile lacks them
    (ORW-380: ALWAYS rewrite the photo sheet, wardrobe + photoHair + onCamera, with the shared writer and
    checker from orwell_cast_authoring, one houseguest at a time so each sees the others' main pieces and
    spots; behind `look_fill_supported`), (2) fetch the fresh prompt from the engine, (3) one forced silent
    re-shoot with the current portrait file as the reference image (up to `portrait_parallel` at once). The old file stays until
    the new image succeeds, then swaps atomically and records the current prompt version;
  * a failure keeps the old photo, is recorded RED through the portrait failure recorder, and that
    houseguest is retried later with a growing wait (5, 15, 45 min, then every 2 h). The loop never
    stops itself; in-memory state only, a restart re-scans.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Optional

logger = logging.getLogger(__name__)

START_DELAY_S = 45.0
GAP_S = 15.0
TICK_S = 5.0
RETRY_WAITS_S = (5 * 60.0, 15 * 60.0, 45 * 60.0)
RETRY_STEADY_S = 2 * 60 * 60.0

# per safe-user state: {"sig", "armed_at", "next_ok_at", "fails": {sid: n}, "retry_at": {sid: ts},
#                       "started_at", "done": int, "failed": int, "sheets": {sid: fields}}
_STATE: dict = {}
_TASK = None
LIVE_IDLE_MINUTES_DEFAULT = 15  # same default as ORWELL_UPDATE_IDLE_MINUTES in deploy/orwell-live-game.sh
_LIVE_SQL = "SELECT CAST(strftime('%s','now') - strftime('%s', max(timestamp)) AS INTEGER) FROM chat_messages WHERE role='user'"
_BUSY: set = set()  # safe users with an upgrade step in flight (never two at once for one user)


def _st(user) -> dict:
    from src import orwell_portraits as P
    return _STATE.setdefault(P._safe_user(user), {"sig": None, "armed_at": None, "next_ok_at": 0.0,
                                                  "fails": {}, "retry_at": {}, "started_at": None,
                                                  "done": 0, "failed": 0, "rate_limited": False,
                                                  "sheets": {}})


def _player_idle_seconds() -> Optional[int]:
    """Age in seconds of the newest PLAYER chat message (the updater's live-game signal), or None when
    there is none or it cannot be read."""
    try:
        from sqlalchemy import text
        from core.database import SessionLocal
        db = SessionLocal()
        try:
            row = db.execute(text(_LIVE_SQL)).fetchone()
        finally:
            db.close()
        return int(row[0]) if row and row[0] is not None else None
    except Exception:  # failsoft-ok: expected-empty (an unreadable signal reads as idle, as the updater does)
        return None


async def game_is_live() -> bool:
    """True when a player message arrived within the idle window (default 15 min). Unknown = idle."""
    try:
        minutes = max(1, min(120, int(os.environ.get("ORWELL_UPDATE_IDLE_MINUTES") or LIVE_IDLE_MINUTES_DEFAULT)))
    except ValueError:
        minutes = LIVE_IDLE_MINUTES_DEFAULT
    idle = await asyncio.to_thread(_player_idle_seconds)
    return idle is not None and idle < minutes * 60


def look_fill_supported() -> bool:
    """The look fill-in rides ORW-360's fields and the look-only engine tool `recordLookExtras`."""
    try:
        from src import orwell_engine
        return hasattr(orwell_engine, "record_look_extras")
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
    """Stale houseguest ids of the CURRENT season's cast, player excluded. Every NPC counts whatever
    their status (evicted and jury faces still show, greyed, in the cast panel, dossier and chat), but
    the people still in the house come first so the faces on screen change first."""
    from src import orwell_portraits as P
    rank = {}
    for hg in state.get("house") if isinstance(state.get("house"), list) else []:
        if isinstance(hg, dict) and hg.get("name"):
            sid = P._safe_id(str(hg.get("id") or hg.get("name")))
            rank[sid] = 0 if (hg.get("status") or "active") == "active" else 1
    pid = state.get("player") if isinstance(state.get("player"), dict) else {}
    player_ids = {P.PLAYER_PORTRAIT_ID, P._safe_id(str(pid.get("id") or "player"))}
    stale = [sid for sid in sorted(set(P.stale_portrait_ids(manifest)) | set(P.check_retry_ids(manifest)))  # ORW-431 D
             if sid in rank and sid not in player_ids]
    return sorted(stale, key=lambda sid: (rank[sid], sid))


# ── the photo sheet (ORW-380): written with the shared instruction and checker ──────────────────

def sheet_taken(state: dict, st: dict, stale_set: set, exclude_sid: str) -> dict:
    """The `taken` lists for one houseguest: main pieces and spot counts of the houseguests whose sheet is
    already current: those rewritten this run (`st["sheets"]`, which overrides the state) and those whose
    portrait is not stale. Their stored fields come from the game state."""
    from src import orwell_cast_authoring as CA
    from src import orwell_portraits as P
    cards = []
    for hg in state.get("house") if isinstance(state.get("house"), list) else []:
        if not isinstance(hg, dict):
            continue
        sid = P._safe_id(str(hg.get("id") or hg.get("name")))
        if sid == exclude_sid:
            continue
        phys = dict(hg.get("physicalCharacteristics") or {}) if isinstance(hg.get("physicalCharacteristics"), dict) else {}
        if sid in st.get("sheets", {}):
            for k in CA.SHEET_FIELDS:
                phys.pop(k, None)
            phys.update(st["sheets"][sid])
        elif sid in stale_set:
            continue  # an old sheet, not yet rewritten: it does not count
        cards.append({"physicalCharacteristics": phys})
    return CA.photo_sheet_taken(cards)


async def rewrite_sheet(user, sid: str, card: dict, state: dict, st: dict, stale_set: set) -> dict:
    """ALWAYS rewrite one houseguest's photo sheet (wardrobe, photoHair, onCamera) with the shared writer, given
    the taken lists, and store it through recordLookExtras (an old field the writer left out is cleared, so a
    scene-like v2 line cannot ride into the v3 prompt). Returns the stored fields. Raises when the writer
    produced nothing for a card that still carries an old sheet (retried later with the growing wait)."""
    from src import orwell_cast_authoring as CA
    from src import orwell_engine
    from src import orwell_portraits as P
    llm = await CA.resolve_authoring_llm_fn(user)
    phys = card.get("physicalCharacteristics") if isinstance(card.get("physicalCharacteristics"), dict) else {}
    had_old = any(phys.get(k) for k in CA.SHEET_FIELDS)
    fields: dict = {}
    if llm is not None:
        taken = sheet_taken(state, st, stale_set, P._safe_id(str(sid)))
        fields, codes = await CA.write_photo_sheet({**card, "id": sid}, taken, llm)
        if "wardrobe-taken" in codes:
            logger.info("[portrait-upgrade] sheet for %s keeps a taken main piece (wardrobe-taken)", sid)
    if not fields:
        if had_old:
            raise RuntimeError("look-write-failed")
        return {}
    clear = [k for k in CA.SHEET_FIELDS if k not in fields and phys.get(k)]
    res = await orwell_engine.record_look_extras(sid, {**fields, **({"clear": clear} if clear else {})}, user=user)
    if not (isinstance(res, dict) and res.get("accepted")):
        if had_old:
            raise RuntimeError("look-store-failed")
        return {}
    st.setdefault("sheets", {})[P._safe_id(str(sid))] = dict(fields)
    return fields


# ── one step ─────────────────────────────────────────────────────────────────────────────────

def _full_generation_running(user) -> bool:
    from src import orwell_portraits as P
    rec = P._GEN_PROGRESS.get(P._safe_user(user))
    # ORW-437: a stale heartbeat (a crashed run that never cleared its record) must not block this user's upgrader forever;
    # `_INFLIGHT` below stays the authoritative live-generation check.
    if isinstance(rec, dict) and rec.get("active"):
        try:
            fresh = (time.time() - float(rec.get("updatedAt", 0))) <= P._GEN_PROGRESS_STALE_S
        except (TypeError, ValueError):
            fresh = False
        if fresh:
            return True
    return bool(P._INFLIGHT.get(P._safe_user(user)))


def _portrait_cost_since(user, since_ms: int) -> float:
    try:
        from src import orwell_token_ledger as L
        return sum(float(e.get("cost") or 0) for e in L.get_recent(user, 500)
                   if e.get("callClass") == "portrait" and int(e.get("ts") or 0) >= since_ms)
    except Exception:
        return 0.0


class _PipelineFailure(RuntimeError):
    """A failure `generate_and_store` already recorded RED (ORW-437): the upgrader must not record it a second time."""


async def shoot_one(user, sid: str, card: dict) -> bool:
    """Fetch the fresh prompt and force the single silent re-shoot with the current portrait file as the
    reference (the person stays; the brief changes the rest). True on a landed new face."""
    from src import orwell_engine
    from src import orwell_portraits as P
    pp = await orwell_engine.get_portrait_prompt(sid, user=user)
    if not isinstance(pp, dict) or not pp.get("prompt"):
        raise RuntimeError("no-prompt")
    entry = {"houseguestId": sid, "name": pp.get("name") or card.get("name") or "", "prompt": pp["prompt"],
             "identityPrefix": True, **({"lookKey": pp["lookKey"]} if isinstance(pp.get("lookKey"), str) else {})}
    await P.generate_and_store([entry], user, record_beats=False, force_ids=[sid], silent=True)
    stored = P.load_manifest(user).get(P._safe_id(sid))
    if isinstance(stored, dict) and not P._entry_version_stale(stored):
        return True
    cls = P.last_gen_error_class(user, sid)
    if cls:
        raise _PipelineFailure(cls)
    raise RuntimeError("generation-failed")


async def upgrade_one(user, sid: str, card: dict, state: Optional[dict] = None, st: Optional[dict] = None,
                      stale_set: Optional[set] = None) -> bool:
    """Rewrite the photo sheet, then force the single silent re-shoot. True on a landed new face."""
    if look_fill_supported():
        try:
            await rewrite_sheet(user, sid, card, state or {"house": [card]}, st if st is not None else {"sheets": {}},
                                stale_set if stale_set is not None else set())
        except RuntimeError:
            raise
        except Exception as e:  # failsoft-ok: best-effort-enrichment (no sheet is fine; the photo still upgrades)
            logger.info("[portrait-upgrade] photo sheet for %s skipped: %s", sid, e)
    return await shoot_one(user, sid, card)


async def upgrade_tick(user, *, now: Optional[float] = None) -> str:
    """One scheduling step for one user: one houseguest while a game is live (or after a 429), else up to `portrait_parallel` at once. Returns a short status
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
                  done=0, failed=0, rate_limited=False, sheets={})
    cands = stale_candidates(user, state, P.load_manifest(user))
    if not cands:
        if st["started_at"] is not None:  # this season's upgrade just finished: one line with its cost
            cost = _portrait_cost_since(user, st["started_at"])
            logger.info("[portrait-upgrade] season upgrade finished for %s: %d upgraded, %d failed this run, "
                        "portrait spend this upgrade $%.4f", safe, st["done"], st["failed"], cost)
            st["started_at"] = None
        st["rate_limited"] = False
        return "done" if st["done"] else "idle"
    if now < st["armed_at"] + START_DELAY_S or now < st["next_ok_at"]:
        return "waiting"
    if _full_generation_running(user) or not P.image_generation_available(user):
        return "waiting"
    host = await P.image_provider_host(user)  # ORW-437: only THIS user's provider host gates this user's upgrades
    if P.billing_breaker_open(host=host):  # ORW-397: the provider refused billing/auth; wait for the hourly re-probe
        return "waiting"
    ready = [c for c in cands if st["retry_at"].get(c, 0.0) <= now]
    if not ready:
        return "waiting"
    live = await game_is_live()
    solo = live or st["rate_limited"] or P.billing_breaker_probing(host=host)  # ORW-397: one probe call
    width = 1 if solo else P.portrait_parallel(user)
    batch = ready[:width]
    if st["started_at"] is None:
        st["started_at"] = int(time.time() * 1000)
    gap = GAP_S if (live or st["rate_limited"]) else 0.0  # ORW-437: a 429 keeps the breathing gap (the pre-ORW-378 15 s)
    st["tick_t0"] = time.monotonic()  # a failure's waits count from when it happened, not from the tick's start
    _BUSY.add(safe)
    try:
        # ORW-380: the photo sheets are written ONE houseguest at a time (each one's `taken` lists need the
        # sheets written before it), then the shoots run up to `width` at once.
        stale_set = set(cands)
        ready_to_shoot = []
        results = []
        for sid in batch:
            card = _card_of(state, sid)
            if look_fill_supported():
                try:
                    await rewrite_sheet(user, str(card.get("id") or sid), card, state, st, stale_set)
                except Exception as e:  # failsoft-ok: handled-by-terminal (recorded RED, retried later)
                    _note_failure(user, safe, sid, st, now, gap, e)
                    results.append("failed")
                    continue
            ready_to_shoot.append(sid)
        results += await asyncio.gather(*[_upgrade_sid(user, safe, state, sid, st, now, gap) for sid in ready_to_shoot],
                                        return_exceptions=True)
    finally:
        _BUSY.discard(safe)
    ok = [r for r in results if r == "upgraded"]
    return "upgraded" if ok else "failed"


def _card_of(state: dict, sid: str) -> dict:
    from src import orwell_portraits as P
    return next((h for h in state.get("house", []) if isinstance(h, dict)
                 and P._safe_id(str(h.get("id") or h.get("name"))) == sid), {})


def _note_failure(user, safe: str, sid: str, st: dict, now: float, gap: float, e: Exception) -> None:
    from src import orwell_portraits as P
    reason = str(e) or type(e).__name__
    if P.is_billing_error(reason):  # ORW-397: not this houseguest's fault; the breaker owns the wait
        st["failed"] += 1
        st["next_ok_at"] = now + gap
        P._note_gen_error("portrait-upgrade-failed", reason)
        P._note_generation_failure(user, sid, reason)  # one credits/billing soft failure per breaker trip
        logger.info("[portrait-upgrade] %s not upgraded for %s: provider billing/auth refused (%s)", sid, safe, reason)
        return
    n = st["fails"].get(sid, 0) + 1
    st["fails"][sid] = n
    st["retry_at"][sid] = now + retry_wait_s(n)
    st["failed"] += 1
    st["next_ok_at"] = now + gap
    if P.is_rate_limited(reason):  # ORW-378: the rest of this season's upgrade goes one at a time
        st["rate_limited"] = True
        t0 = st.get("tick_t0")  # the gap counts from when the 429 arrived, not from the tick's start (review of #2748)
        failed_at = now + (max(0.0, time.monotonic() - t0) if t0 is not None else 0.0)
        st["next_ok_at"] = failed_at + max(gap, GAP_S)  # ORW-437: ...and the provider gets the full gap before the next attempt
    P._note_gen_error("portrait-upgrade-failed", reason)
    if not isinstance(e, _PipelineFailure):  # the pipeline already recorded its own failure RED
        P._note_generation_failure(user, sid, f"portrait-upgrade-failed: {reason}")
    logger.info("[portrait-upgrade] %s failed for %s (%s); old photo kept, retry in %.0fs",
                sid, safe, reason, retry_wait_s(n))


async def _upgrade_sid(user, safe: str, state: dict, sid: str, st: dict, now: float, gap: float) -> str:
    """The shoot for one houseguest whose photo sheet is already written (see `upgrade_tick`)."""
    card = _card_of(state, sid)
    try:
        await shoot_one(user, str(card.get("id") or sid), card)
        st["fails"].pop(sid, None)
        st["retry_at"].pop(sid, None)
        st["done"] += 1
        st["next_ok_at"] = now + gap
        logger.info("[portrait-upgrade] %s upgraded for %s", sid, safe)
        return "upgraded"
    except Exception as e:  # failsoft-ok: handled-by-terminal (the old photo stays; recorded RED below; retried later)
        _note_failure(user, safe, sid, st, now, gap, e)
        return "failed"


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
