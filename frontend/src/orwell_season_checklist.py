"""ORW-970 - a durable season-start checklist: one persisted record per owner per season.

On 2026-11-26 a web-tier restart cleared the house-entry hold (it lives in process memory) and also lost the three
post-start steps that the hold defers (world snapshot, producer persona, habits + house culture). Nothing recorded
that they were owed, so they were run by hand (ORW-949). This module is that record.

Shape (one JSON file under ``DATA_DIR``, the ``orwell_seasons.py`` / ``orwell_recent_seasons.py`` pattern: atomic
write, a missing or corrupt file reads as empty)::

    {"v": 1, "owners": {"<owner>": {
        "season": 3,                      # orwell_seasons.get_season at the start
        "sid": "9f2c...",                 # fresh per season start; an old record can never act on a new season
        "started_at": 1764150000.0,
        "closed": null,                   # or a short reason once the season is over / superseded
        "steps": {"house_hold":       {"status": "owed|running|done|failed", "at": 0.0, "attempts": 0,
                                       "reason": null, "detail": "held|released", "next_at": null},
                  "world_snapshot": {...}, "producer_persona": {...}, "habits_culture": {...}}}}}

``owed`` also means "tried, failed, will retry" (``reason`` holds the last failure and ``next_at`` the retry time).
``failed`` is final: the attempts are spent and an admin alert was raised. Vault-free: step names, statuses, times,
counts and short machine reasons only; never cast text.

Re-run trigger: ``resume_all()`` runs once at process startup (``app.py``). That is the lifecycle point a restart
actually breaks: the hold marker and the kick tasks are in-process. Retries inside a live process are scheduled by
``tracked`` with a growing delay. Both are bounded by ``max_attempts()``, and attempts are persisted, so a crash loop
or a model that keeps failing ends in ``failed`` plus an alert, never an endless loop.

A season in progress with NO record (the deploy of this change) is left exactly as it was: no record means no owed
work is known, nothing re-runs, and every helper here is a no-op that returns the old behaviour.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import logging
import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from core.atomic_io import atomic_write_json
from src.constants import DATA_DIR

logger = logging.getLogger(__name__)

CHECKLIST_PATH = Path(DATA_DIR) / "orwell_season_checklist.json"

HOUSE_HOLD = "house_hold"
WORLD_SNAPSHOT = "world_snapshot"
PRODUCER_PERSONA = "producer_persona"
HABITS_CULTURE = "habits_culture"
STEPS = (HOUSE_HOLD, WORLD_SNAPSHOT, PRODUCER_PERSONA, HABITS_CULTURE)
POST_START_STEPS = (WORLD_SNAPSHOT, PRODUCER_PERSONA, HABITS_CULTURE)
STATUSES = ("owed", "running", "done", "failed")

# step -> (module, kickoff function): the existing fire-and-forget kicks, which now report into the record.
_KICKS = {
    WORLD_SNAPSHOT: ("src.orwell_zeitgeist", "kickoff_capture"),
    PRODUCER_PERSONA: ("src.orwell_producer_authoring", "kickoff_producer_authoring"),
    HABITS_CULTURE: ("src.orwell_npc_minds_words", "kickoff_npc_minds_words"),
}

_LOCK = threading.Lock()
_ACTIVE: set = set()          # (owner key, step) running in THIS process
_RETRY_TASKS: dict = {}       # (owner key, step) -> asyncio.Task (strong refs)


def _env_num(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except (TypeError, ValueError):
        return float(default)


def max_attempts() -> int:
    return max(1, int(_env_num("ORWELL_SEASON_START_MAX_ATTEMPTS", 4)))


def retry_delay(attempts: int) -> float:
    """Growing delay after the Nth failed attempt: base, 4x base, 16x base (60 s, 240 s, 960 s by default)."""
    base = max(0.0, _env_num("ORWELL_SEASON_START_RETRY_BASE_S", 60.0))
    return base * (4 ** max(0, int(attempts) - 1))


def _key(owner: Optional[str]) -> str:
    return str(owner) if owner else "default"  # same bucket as orwell_cast_authoring._safe_user


def _reason(r: Any) -> str:
    return re.sub(r"[^a-z0-9:_-]+", "-", str(r if r is not None else "unknown").lower()).strip("-")[:48] or "unknown"


# -- storage ---------------------------------------------------------------------------------------------------------

def _num(v, default=None):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else default


def _clean_step(s) -> dict:
    s = s if isinstance(s, dict) else {}
    att = s.get("attempts")
    out = {
        "status": s.get("status") if s.get("status") in STATUSES else "owed",
        "at": _num(s.get("at"), 0.0),
        "attempts": att if isinstance(att, int) and not isinstance(att, bool) and att >= 0 else 0,
        "reason": _reason(s["reason"]) if s.get("reason") else None,
        "next_at": _num(s.get("next_at")),
    }
    if s.get("detail"):
        out["detail"] = _reason(s["detail"])
    return out


def _clean_record(rec) -> Optional[dict]:
    if not isinstance(rec, dict) or not isinstance(rec.get("sid"), str) or not rec["sid"]:
        return None
    steps = rec.get("steps") if isinstance(rec.get("steps"), dict) else {}
    season = rec.get("season")
    return {
        "season": season if isinstance(season, int) and not isinstance(season, bool) else 1,
        "sid": rec["sid"][:64],
        "started_at": _num(rec.get("started_at"), 0.0),
        "closed": _reason(rec["closed"]) if rec.get("closed") else None,
        "steps": {n: _clean_step(steps.get(n)) for n in STEPS},
    }


def _load() -> dict:
    """{owner: record}; a missing, corrupt or malformed file reads as empty, a malformed record is dropped."""
    try:
        raw = json.loads(Path(CHECKLIST_PATH).read_text(encoding="utf-8"))
    except Exception:  # failsoft-ok: a missing/corrupt store must never break a season
        return {}
    owners = raw.get("owners") if isinstance(raw, dict) else None
    if not isinstance(owners, dict):
        return {}
    out = {}
    for k, rec in owners.items():
        rec = _clean_record(rec)
        if rec is not None:
            out[str(k)] = rec
    return out


def _save(owners: dict) -> None:
    atomic_write_json(str(CHECKLIST_PATH), {"v": 1, "owners": owners}, indent=1)


def _update(owner: Optional[str], fn: Callable[[dict], Any], sid: Optional[str] = None) -> bool:
    """Read-modify-write one owner's record under the lock. False when there is no record, or `sid` no longer matches (a newer
    season replaced it), or the write failed. Never raises."""
    try:
        with _LOCK:
            owners = _load()
            rec = owners.get(_key(owner))
            if rec is None or (sid is not None and rec["sid"] != sid):
                return False
            fn(rec)
            _save(owners)
            return True
    except Exception as e:  # failsoft-ok: the record is bookkeeping, it must never break a season
        logger.warning("[season-checklist] update failed for %s: %s", _key(owner), e)
        return False


def get_record(owner: Optional[str]) -> Optional[dict]:
    """The owner's record (a copy), or None."""
    return _load().get(_key(owner))


def _set(rec: dict, step: str, status: str, **kw) -> None:
    s = rec["steps"][step]
    s["status"] = status
    s["at"] = time.time()
    for k, v in kw.items():
        if v is None and k == "detail":
            s.pop("detail", None)
        else:
            s[k] = v


# -- season lifecycle ------------------------------------------------------------------------------------------------

def begin_season(owner: Optional[str], *, hold: bool) -> Optional[str]:
    """A genuine season start: write a FRESH record (replacing any earlier season's, so an old record can never trigger work
    in the new one) with the three post-start steps owed. `hold` = the house-entry gate is on, so the hold is owed too.
    Returns the new sid, or None if the write failed (the season goes on without a record, exactly as before)."""
    try:
        try:
            from src import orwell_seasons
            season = orwell_seasons.get_season(owner)
        except Exception:
            season = 1
        now = time.time()
        sid = uuid.uuid4().hex
        rec = {"season": season, "sid": sid, "started_at": now, "closed": None,
               "steps": {n: {"status": "owed", "at": now, "attempts": 0, "reason": None, "next_at": None} for n in STEPS}}
        if hold:
            rec["steps"][HOUSE_HOLD]["detail"] = "held"
        else:
            rec["steps"][HOUSE_HOLD].update(status="done", detail="not-held")
        with _LOCK:
            owners = _load()
            owners[_key(owner)] = rec
            _save(owners)
        for k, t in list(_RETRY_TASKS.items()):
            if k[0] == _key(owner):
                t.cancel()  # an old season's pending retry must not fire into the new one
        return sid
    except Exception as e:  # failsoft-ok
        logger.warning("[season-checklist] could not begin a record for %s: %s", _key(owner), e)
        return None


def mark_hold(owner: Optional[str], held: bool, reason: Optional[str] = None) -> None:
    """The house-entry hold marker changed. No record (a season that predates this change, or a bare test owner) is a no-op."""
    def _f(rec):
        cur = rec["steps"][HOUSE_HOLD]
        if rec.get("closed"):
            return
        if held:
            if cur["status"] != "done":  # a released hold is never reopened by a stray re-mark
                _set(rec, HOUSE_HOLD, "owed", detail="held")
        elif cur["status"] != "done":
            _set(rec, HOUSE_HOLD, "done", detail="released", reason=reason)
    _update(owner, _f)


def close(owner: Optional[str], why: str, sid: Optional[str] = None) -> None:
    _update(owner, lambda rec: rec.__setitem__("closed", _reason(why)), sid)


def _current(owner: Optional[str], sid: str) -> Optional[dict]:
    rec = get_record(owner)
    return rec if rec and rec["sid"] == sid and not rec.get("closed") else None


# -- tracked runs ----------------------------------------------------------------------------------------------------

def _classify(step: str, result: Any) -> tuple:
    """(ok, reason) for the value the step's own function returned. `no-model` is the expected no-op (the engine's own
    version stands and the strict policy already alerted): done, not owed."""
    r = result if isinstance(result, dict) else {}
    if step in (WORLD_SNAPSHOT, PRODUCER_PERSONA):
        if r.get("accepted"):
            return True, None
        why = r.get("reason")
        return (True, why) if why == "no-model" else (False, why or "not-accepted")
    # habits + culture: {"traits": {...}|None, "culture": {...}|None} or {"reason": ...}
    if r.get("reason") == "no-model":
        return True, "no-model"
    if r.get("traits") is None and r.get("culture") is None:
        return False, r.get("reason") or "no-result"
    traits, culture = r.get("traits") or {}, r.get("culture") or {}
    if traits.get("skipped") or traits.get("writeFailed"):
        return False, "traits-skipped"
    if not culture.get("accepted") and culture.get("reason") != "frozen":
        return False, "culture-" + _reason(culture.get("reason"))
    return True, None


async def _already_done(owner: Optional[str], step: str) -> Optional[str]:
    """A cheap probe of the engine for output that already exists, so a second run is skipped rather than overwriting it. Only the
    world snapshot is readable (its `source` is `web_search` once captured). The producer overlay only accumulates, and the culture
    and each houseguest's habits are write-once engine-side, so a repeat of those costs model tokens and changes no stored value."""
    if step != WORLD_SNAPSHOT:
        return None
    try:
        from src import orwell_engine
        view = await orwell_engine.world_snapshot_view(user=owner)
        if isinstance(view, dict) and view.get("source") == "web_search":
            return "already-captured"
    except Exception:  # failsoft-ok: no probe answer means run it
        return None
    return None


def _alert(owner: Optional[str], step: str, why: str) -> None:
    try:
        from src import log_rings
        log_rings.record_soft_failure("season-start:%s-failed" % step.replace("_", "-"),
                                      "gave up after %d attempt(s): %s" % (max_attempts(), why),
                                      corrected="engine-version-stands", user=owner)
    except Exception:  # pragma: no cover - failsoft-ok: recorder-self
        pass


async def tracked(owner: Optional[str], step: str, fn: Callable[..., Awaitable[Any]], *args) -> Any:
    """Run a post-start step's own function and record the outcome. No record (or a closed one): the function runs plain, the old
    behaviour. A step already done or final, or already running in this process: not run twice. A failure leaves the step owed with
    a growing retry delay; the last allowed attempt ends it `failed` plus an alert."""
    rec = get_record(owner)
    if rec is None or rec.get("closed"):
        return await fn(*args)
    sid, cur = rec["sid"], rec["steps"][step]
    ak = (_key(owner), step)
    if cur["status"] in ("done", "failed") or ak in _ACTIVE:
        return {"skipped": cur["status"]}
    if cur["attempts"] >= max_attempts():  # attempts persist: a restart loop cannot buy extra tries
        why = cur["reason"] or "attempts-exhausted"
        _update(owner, lambda r: _set(r, step, "failed", reason=why, next_at=None), sid)
        _alert(owner, step, why)
        return {"skipped": "failed"}
    skip = await _already_done(owner, step)
    if skip:
        _update(owner, lambda r: _set(r, step, "done", reason=skip, next_at=None), sid)
        return {"skipped": skip}
    attempts = cur["attempts"] + 1
    if not _update(owner, lambda r: _set(r, step, "running", attempts=attempts, reason=None, next_at=None), sid):
        return await fn(*args)  # the record vanished or was replaced between the read and the write
    _ACTIVE.add(ak)
    try:
        try:
            result = await fn(*args)
            ok, why = _classify(step, result)
        except Exception as e:
            _finish(owner, step, sid, attempts, False, "raised:" + type(e).__name__)
            raise
        _finish(owner, step, sid, attempts, ok, why)
        return result
    finally:
        _ACTIVE.discard(ak)


def _finish(owner: Optional[str], step: str, sid: str, attempts: int, ok: bool, why: Optional[str]) -> None:
    if ok:
        _update(owner, lambda r: _set(r, step, "done", reason=_reason(why) if why else None, next_at=None), sid)
        return
    why = _reason(why)
    if attempts >= max_attempts():
        _update(owner, lambda r: _set(r, step, "failed", reason=why, next_at=None), sid)
        _alert(owner, step, why)
        return
    delay = retry_delay(attempts)
    _update(owner, lambda r: _set(r, step, "owed", reason=why, next_at=time.time() + delay), sid)
    _schedule_retry(owner, step, sid, delay)


def _kick(owner: Optional[str], step: str) -> None:
    mod, fn = _KICKS[step]
    getattr(importlib.import_module(mod), fn)(owner)


def _schedule_retry(owner: Optional[str], step: str, sid: str, delay: float) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # no loop: the next startup's resume picks it up

    async def _later():
        try:
            await asyncio.sleep(max(0.0, delay))
            await asyncio.sleep(0)  # let the failed run's kickoff guard clear before the retry kicks again
            rec = _current(owner, sid)
            if rec and rec["steps"][step]["status"] == "owed":
                _kick(owner, step)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # failsoft-ok
            logger.warning("[season-checklist] retry of %s for %s failed to start: %s", step, _key(owner), e)
        finally:
            if _RETRY_TASKS.get((_key(owner), step)) is asyncio.current_task():
                _RETRY_TASKS.pop((_key(owner), step), None)

    old = _RETRY_TASKS.get((_key(owner), step))
    if old is not None and not old.done():
        old.cancel()
    _RETRY_TASKS[(_key(owner), step)] = loop.create_task(_later())


def kick_owed_steps(owner: Optional[str]) -> list:
    """Start every post-start step that is still owed (or left `running` by a process that died). Returns the step names kicked."""
    rec = get_record(owner)
    if rec is None or rec.get("closed"):
        return []
    kicked = []
    for step in POST_START_STEPS:
        if rec["steps"][step]["status"] in ("owed", "running") and (_key(owner), step) not in _ACTIVE:
            try:
                _kick(owner, step)
                kicked.append(step)
            except Exception as e:  # failsoft-ok
                logger.warning("[season-checklist] could not start %s for %s: %s", step, _key(owner), e)
    return kicked


# -- restart recovery ------------------------------------------------------------------------------------------------

def _is_live(state: Any) -> Optional[bool]:
    """True: a season in progress. False: none, or it is over. None: unreadable."""
    if not isinstance(state, dict):
        return None
    if state.get("started") is not True:
        return False
    return not (state.get("finished") or state.get("moment") == "post-season")


async def resume_owner(owner: Optional[str]) -> str:
    """Pick up one owner's owed steps after a restart. Returns a short outcome token (for logs and tests)."""
    rec = get_record(owner)
    if rec is None or rec.get("closed"):
        return "none"
    sid = rec["sid"]
    try:
        from src import orwell_seasons
        if orwell_seasons.get_season(owner) != rec["season"]:
            close(owner, "superseded", sid)
            return "superseded"
    except Exception:  # failsoft-ok
        pass
    if not any(s["status"] in ("owed", "running") for s in rec["steps"].values()):
        return "complete"
    from src import orwell_engine
    live = None
    delay = max(0.0, _env_num("ORWELL_SEASON_RESUME_ENGINE_WAIT_S", 5.0))
    for i in range(max(1, int(_env_num("ORWELL_SEASON_RESUME_ENGINE_TRIES", 6)))):  # bounded wait for the engine to answer
        try:
            live = _is_live(await orwell_engine.get_game_state(user=owner))
        except Exception:  # failsoft-ok: an unreachable engine is retried with a bounded wait, then logged
            live = None
        if live is not None:
            break
        await asyncio.sleep(delay * (2 ** i))
    if live is None:
        logger.warning("[season-checklist] engine unreachable at startup: %s left as recorded (owed steps stay owed)", _key(owner))
        return "engine-unreachable"
    if not live:
        close(owner, "no-live-season", sid)
        return "closed"
    if rec["steps"][HOUSE_HOLD]["status"] != "done":
        from src import orwell_cast_authoring as ca
        if not await ca.house_entry_gate_active(owner):
            mark_hold(owner, False, "gate-off-on-resume")
            logger.info("[season-checklist] %s: house-entry gate is off at startup; hold recorded released", _key(owner))
        else:
            # The marker is in-process, so it is gone. Hold provisionally at once (no started-game window), then RE-EVALUATE the
            # cast: ready releases now, otherwise the watch releases the moment the cast lands and then runs the owed steps.
            ca.begin_house_entry_hold(owner, {"resumed": True})
            ready = await ca.await_house_ready(owner, timeout=0)
            if ready.get("ready"):
                ca.clear_house_entry_gate_block(owner)
            else:
                ca.record_house_entry_gate_block(owner, ready)
                if ca.kickoff_house_ready_watch(owner, on_ready=lambda: kick_owed_steps(owner)) or ca.house_ready_watch_active(owner):
                    return "holding"
                ca.clear_house_entry_gate_block(owner)  # could not arm a watch: never leave an unwatched hold behind
                mark_hold(owner, False, "no-watch-on-resume")
    kicked = kick_owed_steps(owner)
    return "resumed:" + ",".join(kicked) if kicked else "complete"


async def resume_all() -> dict:
    """Startup entry: resume every owner with an open record. One owner's failure never stops the others. Never raises."""
    out: dict = {}
    try:
        owners = list(_load().keys())
    except Exception:
        return out
    for owner in owners:
        try:
            out[owner] = await resume_owner(None if owner == "default" else owner)
        except Exception as e:  # failsoft-ok
            logger.warning("[season-checklist] resume failed for %s: %s", owner, e)
            out[owner] = "error"
    if any(v not in ("none", "complete", "closed", "superseded") for v in out.values()):
        logger.info("[season-checklist] startup resume: %s", out)
    return out


def start_resume_task() -> Optional["asyncio.Task"]:
    """Fire-and-forget `resume_all` from the startup event (the caller keeps the strong ref)."""
    try:
        return asyncio.get_running_loop().create_task(resume_all())
    except RuntimeError:
        return None


# -- admin view ------------------------------------------------------------------------------------------------------

def admin_view(owner: Optional[str]) -> dict:
    """Read-only, Vault-free: step names, statuses, times, attempt counts, short reasons. Never cast text."""
    rec = get_record(owner)
    if rec is None:
        return {"present": False}

    def iso(t):
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t)) if t else None
    return {
        "present": True, "season": rec["season"], "startedAt": iso(rec["started_at"]), "closed": rec["closed"],
        "steps": [{"step": n, "status": rec["steps"][n]["status"], "at": iso(rec["steps"][n]["at"]),
                   "attempts": rec["steps"][n]["attempts"], "reason": rec["steps"][n]["reason"],
                   "detail": rec["steps"][n].get("detail"), "nextAt": iso(rec["steps"][n]["next_at"])} for n in STEPS],
    }
