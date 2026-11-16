"""ORW-406: a tiny "is a turn in flight?" signal for the updater.

The updater (root) reads <data>/turns-in-flight just before it restarts the services, and waits (bounded)
until it says 0. The file holds one integer: the number of chat streams currently registered. It carries no
game or chat content. Best-effort: a write failure never affects a turn.
"""
import logging
import math
import os
import threading
import time
from typing import Any, Dict, List, Optional

from src.constants import DATA_DIR

SIGNAL_NAME = "turns-in-flight"
HOLD_NAME = "turns-hold"            # ORW-461: written by the updater (root) to say "hold new turns": `until=<epoch seconds>`
HOLD_RETRY_AFTER_MS = 2000
_HOLD_MAX_AHEAD_S = 3600            # a hold stamped further ahead than this is not believed (a corrupt or hostile file must not wedge the game)
_warned_unreadable = False
_ADMIT_TTL_S = 15.0                 # an admitted turn that never registers (it failed first) stops counting after this long


def signal_path() -> str:
    return os.path.join(os.environ.get("ORWELL_INFLIGHT_DIR") or DATA_DIR, SIGNAL_NAME)


def hold_path() -> str:
    # The ROOT-owned run dir (the updater's own, like deploy/orwell-live-game.sh ORWELL_RUN_DIR), never the data dir: the service user may read the hold but can never write or
    # swap it, so root never writes through a path that user controls.
    return os.path.join(os.environ.get("ORWELL_RUN_DIR") or "/run/orwell", HOLD_NAME)


def hold_until(now: Optional[float] = None) -> Optional[float]:
    """The epoch second the updater's hold lasts until, or None when no hold is in force (no file, unreadable, malformed, expired, or stamped absurdly far ahead)."""
    now = time.time() if now is None else now
    try:
        with open(hold_path(), "r", encoding="utf-8") as fh:
            text = fh.read(256)
    except FileNotFoundError:
        return None
    except OSError as exc:
        # The hold exists but this process cannot read it (a permissions slip): say so once, because the alternative is a hold that silently never takes effect.
        global _warned_unreadable
        if not _warned_unreadable:
            _warned_unreadable = True
            logging.getLogger(__name__).warning("[orwell] the update hold %s exists but cannot be read (%s): new turns are NOT being held", hold_path(), exc)
        return None
    for line in text.splitlines():
        if line.startswith("until="):
            try:
                until = float(line[6:].strip())
            except ValueError:
                return None
            if not math.isfinite(until) or until <= now or until - now > _HOLD_MAX_AHEAD_S:
                return None
            return until
    return None


# A turn that passed the hold check is counted as in flight from that moment until its stream registers in the registry below, so there is no gap in which the updater reads
# "0 in flight" while a turn it did not refuse is about to start. Keyed by the turn's clientMsgId, one stamp per admission: the same clientMsgId admitted twice (a re-send queued
# behind the first) counts twice, and each registration releases one (review of #2805).
_admitting: Dict[str, List[float]] = {}
# An admission that outlived the TTL before it registered (a turn queued behind a long run) no longer counts, but it is remembered here for a while: when it does register, its
# admit_end releases THIS record, oldest first, never a newer admission's live stamp under the same clientMsgId (review of #2854).
_expired: Dict[str, List[float]] = {}
_EXPIRED_KEEP_S = 600.0
# ORW-491: an admission whose turn is QUEUED behind a running one (agent_runs.start(queue=True)) is pinned: it counts for as long as that queued run is alive, however long the run
# ahead of it takes, and is released by the run's own end (admit_release_pinned). The TTL is only the backstop for an admission with no live queued run behind it.
_pinned: set = set()   # (key, stamp) of pinned admissions
_registry_size = 0
_lock = threading.Lock()


def _total_locked() -> int:
    now = time.monotonic()
    for k in list(_admitting):
        live = [t for t in _admitting[k] if now - t <= _ADMIT_TTL_S or (k, t) in _pinned]
        dead = [t for t in _admitting[k] if now - t > _ADMIT_TTL_S and (k, t) not in _pinned]
        if dead:
            _expired.setdefault(k, []).extend(dead)
        if live:
            _admitting[k] = live
        else:
            del _admitting[k]
    for k in list(_expired):
        keep = [t for t in _expired[k] if now - t <= _EXPIRED_KEEP_S]
        if keep:
            _expired[k] = keep
        else:
            del _expired[k]
    for pk in [p for p in _pinned if p[1] not in _admitting.get(p[0], ())]:
        _pinned.discard(pk)
    return _registry_size + sum(len(v) for v in _admitting.values())


def admit_begin(token: Optional[str]) -> str:
    """Count one admission under `token` (an anonymous key when there is none) and publish the new total. Returns the key the admission is held under."""
    key = token or f"anon-{time.monotonic()}"
    with _lock:
        _admitting.setdefault(key, []).append(time.monotonic())
        publish_inflight(_total_locked())   # under the lock: a concurrent publish can never overwrite this count with an older total
    return key


def admit_end(token: Optional[str]) -> None:
    if not token:
        return
    with _lock:
        _total_locked()   # move any admission past the TTL into _expired first, so the release below is the OLDEST admission's own
        old = _expired.get(token)
        if old:
            old.pop(0)
            if not old:
                del _expired[token]
            publish_inflight(_total_locked())
            return
        stamps = _admitting.get(token)
        if not stamps:
            return
        _pinned.discard((token, stamps.pop(0)))   # handed over to the registry: its pin (if any) is spent
        if not stamps:
            del _admitting[token]
        publish_inflight(_total_locked())


def admit_pin(key: str) -> Optional[float]:
    """Pin the admission just made under `key` (the newest): it stops expiring while its queued run is alive. Returns its stamp (the handle for admit_release_pinned), or None."""
    with _lock:
        stamps = _admitting.get(key)
        if not stamps:
            return None
        _pinned.add((key, stamps[-1]))
        return stamps[-1]


def admit_release_pinned(key: str, stamp: Optional[float]) -> None:
    """Release exactly the pinned admission `stamp` under `key`, once. A no-op when it was already handed over to the registry (admit_end popped it) or already released."""
    if stamp is None:
        return
    with _lock:
        if (key, stamp) not in _pinned:
            return
        _pinned.discard((key, stamp))
        stamps = _admitting.get(key)
        if stamps and stamp in stamps:
            stamps.remove(stamp)
            if not stamps:
                del _admitting[key]
        publish_inflight(_total_locked())


def _admit_cancel(key: str) -> None:
    """Withdraw the admission just made under `key` (refused by the second look at the hold): its own stamp, the newest, never an older one."""
    with _lock:
        stamps = _admitting.get(key)
        if stamps:
            stamps.pop()
            if not stamps:
                del _admitting[key]
        publish_inflight(_total_locked())


def check_and_admit(token: Optional[str]) -> Optional[float]:
    """The one admission gate for a new chat turn. Returns the epoch second the hold lasts until when the turn must be REFUSED (nothing has started, so the client may re-send it
    unchanged), or None when it is admitted (and now counted as in flight until its stream registers)."""
    until = hold_until()
    if until is not None:
        return until
    key = admit_begin(token)
    # Review of #2805: the hold may have been written between the check above and the count being published. Read it again AFTER the count is on disk: either this read sees
    # the hold (refuse, nothing started) or the hold was written after the count, so the updater, which reads the count after writing the hold, sees this turn.
    until = hold_until()
    if until is not None:
        _admit_cancel(key)
        return until
    return None


def publish_inflight(count: int) -> None:
    path = signal_path()
    tmp = f"{path}.tmp{os.getpid()}"
    try:
        with open(tmp, "w") as fh:
            fh.write(f"{int(count)}\n")
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


class InflightRegistry(dict):
    """A dict of active streams that republishes its size whenever a stream is added or removed."""

    def _publish(self) -> None:
        global _registry_size
        with _lock:
            _registry_size = len(self)
            publish_inflight(_total_locked())

    def __setitem__(self, key: Any, value: Any) -> None:
        super().__setitem__(key, value)
        self._publish()

    def __delitem__(self, key: Any) -> None:
        super().__delitem__(key)
        self._publish()

    def pop(self, *args: Any) -> Any:
        had = args[0] in self
        out = super().pop(*args)
        if had:
            self._publish()
        return out

    def clear(self) -> None:
        super().clear()
        self._publish()
