"""ORW-409 slice 2: the ONE hard-fact briefing for a narrator turn.

Built once from a single engine board read taken AFTER every engine write of the turn (player move, turnIn, advance, hang out). Every block that restates a hard fact (part of day, the next event
and whether it is due, where the player is, who is present, who is asleep) reads it from here instead of computing its own, so two blocks cannot disagree. Pure, Vault-free (the board it reads
is the public player view) and fail-open: a missing field is "" / None / (), and a block that gets nothing keeps today's behaviour.

Under the zero-clocks setting no clock number is ever produced: the part of day comes from the band, never the label.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Optional


def _names(v: Any) -> tuple:
    out = []
    for x in v or []:
        n = x.get("name") if isinstance(x, dict) else x
        if isinstance(n, str) and n.strip():
            out.append(n.strip())
    return tuple(out)


@dataclass(frozen=True)
class Briefing:
    part_of_day: str = ""        # "evening", "early morning": the spoken band; "" when the clock is dormant
    next_event: str = ""         # the engine's next scheduled milestone key ("hoh-competition")
    next_day: str = ""           # "today" | "tomorrow" | "" (no schedule)
    next_part: str = ""          # the part of day the next event is scheduled for
    due: Optional[bool] = None   # True/False from the day schedule; None when there is no schedule (never judge)
    location: str = ""
    present: tuple = ()
    asleep: tuple = ()
    commitments: tuple = ()      # open promises: reserved. The commitments the narrator sees are rendered by the ENGINE's own brief (ORW-407); the front end builds no prompt line for them
    day: Optional[int] = None    # the in-game day number (`dayNumber`); None when the clock is dormant
    minutes_until: Optional[int] = None  # whole in-game minutes to the next event (`daySchedule.minutesUntil`); never spoken under zero clocks

    @property
    def awake_present(self) -> tuple:
        """Who is in the player's room AND awake: a sleeper is never "present" for a block that has them come, go or talk."""
        return tuple(n for n in self.present if n not in self.asleep)

    def when(self, default: str) -> str:
        """The in-fiction "when" of the next event: "tomorrow <part>" / "this <part>"; `default` when the schedule names no part."""
        if self.next_day == "tomorrow":
            return f"tomorrow {self.next_part}" if self.next_part else "tomorrow"
        return f"this {self.next_part}" if self.next_part else default

    @classmethod
    def from_schedule(cls, ds: Any) -> "Briefing":
        """A briefing holding only the schedule facts of a `daySchedule` view (for a caller that has the schedule but not the whole board)."""
        if not isinstance(ds, dict):
            return cls()
        due = ds.get("due") if isinstance(ds.get("due"), bool) else None
        mu = ds.get("minutesUntil")
        mu = mu if isinstance(mu, int) and not isinstance(mu, bool) else None
        return cls(next_event=str(ds.get("next") or ""), next_day="tomorrow" if ds.get("tomorrow") else "today", next_part=str(ds.get("phase") or ""), due=due, minutes_until=mu)


def _part_of_day(board: dict, zero_clocks: bool) -> str:
    if zero_clocks:
        from src.zero_clocks import band_label
        lab = band_label(board.get("clockLabel"))
        if lab:
            return lab.split(",")[0].strip()
    tod = board.get("timeOfDay")
    return tod.strip().replace("-", " ") if isinstance(tod, str) else ""


def build_briefing(board: Any, zero_clocks: Optional[bool] = None) -> Briefing:
    """The briefing for this turn from one board (`getGameState` view). Never raises; a non-dict board gives an empty briefing."""
    if not isinstance(board, dict):
        return Briefing()
    if zero_clocks is None:
        from src.zero_clocks import zero_clocks_on
        zero_clocks = zero_clocks_on()
    sched = Briefing.from_schedule(board.get("daySchedule"))
    dn = board.get("dayNumber")
    w = board.get("whereabouts") if isinstance(board.get("whereabouts"), dict) else {}
    return Briefing(
        part_of_day=_part_of_day(board, bool(zero_clocks)),
        next_event=sched.next_event, next_day=sched.next_day, next_part=sched.next_part, due=sched.due, minutes_until=sched.minutes_until,
        day=dn if isinstance(dn, int) and not isinstance(dn, bool) and dn > 0 else None,
        location=str(w.get("room") or ""), present=_names(w.get("present")), asleep=_names(board.get("asleep")),
    )


def unify_part_of_day_lines(prompt: str, b: Briefing) -> str:
    """The engine's GAME CONTEXT states the part of day twice under zero clocks ("- Time of day: <raw phase>" and "- Part of the day: <band>"), and the two can differ (late night / early morning).
    When both are present: drop the "Time of day" line and make the "Part of the day" line name the briefing's band. Otherwise unchanged."""
    import re
    if not isinstance(prompt, str) or not b.part_of_day:
        return prompt
    tod = re.search(r"^- Time of day:[^\n]*\n", prompt, re.MULTILINE)
    pod = re.search(r"^(- Part of the day: )[A-Za-z -]+?(?=\s*[(.])", prompt, re.MULTILINE)
    if not (tod and pod):
        return prompt
    out = prompt[:pod.start()] + pod.group(1) + b.part_of_day + prompt[pod.end():]
    return re.sub(r"^- Time of day:[^\n]*\n", "", out, count=1, flags=re.MULTILINE)


_MOVE_CUE_RE = re.compile(r"\n*MOVEMENT IN THE ROOM[^\n]*(?:\n(?!\n)[^\n]*)*")


def drop_movement_cue(prompt: str) -> str:
    """Remove the "MOVEMENT IN THE ROOM" cue. After a turnIn it is stale by construction: it describes a change that happened before the player slept, and the morning block already says who is there."""
    if not isinstance(prompt, str):
        return prompt
    return _MOVE_CUE_RE.sub("", prompt, count=1)
