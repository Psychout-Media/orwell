"""Showrunner memory — the Show Brief v1 skeleton, front-end half (flag ``ORWELL_SHOW_BRIEF``, default ON).

The ENGINE builds the brief (``src/engine/showBrief.ts``) from its own Vault-free projections; this module only:
  • decides whether to ask for it (the flag);
  • gathers the three optional echoes the engine re-validates —
      ``seen``        what the narrator last saw (below), as the engine's own seen-state shape,
      ``askedAbout``  houseguest ids the player's message (or the last scene) named, resolved from the PUBLIC roster,
      ``lastShown``   the tail of the previous narrated reply, out-of-character ``(( ))`` asides removed;
  • hands the brief text from ``getMomentPrompt`` to ``build_chat_context`` (stash/pop keyed by SESSION, the #1752
    race fix), which appends it as a TERMINAL system message after the transcript, so the cached prefix is untouched;
  • remembers what the NARRATOR last saw (K6 §5.1), so "changed since your last turn" never repeats what the narrator
    already knows and never says "Unknown" after a restart. The marker is the ``seen`` state of the brief actually
    served, moved forward by:
      – the narrator's own tool results (whereabouts / moveTo / getGameState: what the model read);
      – the two move belts, which record a walk the reply already narrated (the player's, or one houseguest's);
    and NEVER by the front end's own engine reads or the other belts. It is stamped on the assistant chat row when
    the reply is saved, adopted back from the newest stamped row after a restart, and dropped when a season starts.

Flag OFF ⇒ nothing here is called: ``getMomentPrompt`` is called exactly as before and no message is added.
Vault-free by construction: everything it reads is already player-visible (the chat the player saw, the public
roster names, the engine's own seen-state echo). The marker is kept per game OWNER (one game per user; every
window of that game shares it); the per-turn brief text stays keyed by SESSION.
"""
from __future__ import annotations

import copy
import os
import re
from typing import Any, Optional

_FLAG = "ORWELL_SHOW_BRIEF"
_TAIL_WORDS = 40
_TAIL_MAX_CHARS = 320
_ASKED_MAX = 6

# session_id → {"text": str, "seen": dict} (this turn's brief, one-shot) and owner → seen (what the narrator last saw).
_STASH: dict = {}
_SEEN: dict = {}

_ASIDE_RE = re.compile(r"\(\([\s\S]*?\)\)")


def _owner(user) -> str:
    return user or "default"


def show_brief_enabled() -> bool:
    """The Show Brief rides each live turn. ON by default (Ryne: new features ship ON); ``ORWELL_SHOW_BRIEF=0|false|no|off`` turns it off, as does the diagnostic ``ORWELL_FLAGS_OFF=1`` profile."""
    if str(os.environ.get("ORWELL_FLAGS_OFF", "")).strip().lower() in ("1", "true", "yes", "on"):
        return False
    return str(os.environ.get(_FLAG, "")).strip().lower() not in ("0", "false", "no", "off")


def last_scene_tail(history: Any) -> Optional[str]:
    """The last ~40 words of the most recent ASSISTANT turn in ``history`` (the reply the player saw last), with
    ``(( ))`` asides removed. ``None`` when there is no prior reply or nothing in-fiction remains."""
    for msg in reversed(list(history or [])):
        role = getattr(msg, "role", None) if not isinstance(msg, dict) else msg.get("role")
        if role != "assistant":
            continue
        content = getattr(msg, "content", None) if not isinstance(msg, dict) else msg.get("content")
        if not isinstance(content, str):
            return None
        words = " ".join(_ASIDE_RE.sub(" ", content).split()).split(" ")
        tail = " ".join(w for w in words[-_TAIL_WORDS:] if w)
        return tail[-_TAIL_MAX_CHARS:].strip() or None
    return None


def asked_about(texts: list, house: Any, player_id: str = "player") -> list:
    """Houseguest ids named in ``texts`` (the player's message, the last scene), resolved from the PUBLIC roster:
    a full name always counts; a first name counts only when no other houseguest shares it. Order of first mention,
    no duplicates, never the player, at most 6."""
    cards = [h for h in (house or []) if isinstance(h, dict) and isinstance(h.get("id"), str) and isinstance(h.get("name"), str)]
    firsts: dict = {}
    for h in cards:
        first = h["name"].split()[0].lower() if h["name"].split() else ""
        firsts.setdefault(first, []).append(h["id"])
    hits: list = []
    blob = " ".join(t for t in texts if isinstance(t, str))
    if not blob:
        return []
    for h in cards:
        if h["id"] == player_id:
            continue
        full = re.escape(h["name"].strip())
        first = h["name"].split()[0] if h["name"].split() else ""
        pos = None
        m = re.search(rf"(?<![\w-]){full}(?![\w-])", blob, re.I)
        if m:
            pos = m.start()
        elif first and len(firsts.get(first.lower(), [])) == 1:
            m = re.search(rf"(?<![\w-]){re.escape(first)}(?![\w-])", blob, re.I)
            if m:
                pos = m.start()
        if pos is not None:
            hits.append((pos, h["id"]))
    hits.sort()
    out: list = []
    for _, hid in hits:
        if hid not in out:
            out.append(hid)
    return out[:_ASKED_MAX]


def build_request(session_id, game_state: Any, player_msg: Any, tail: Optional[str], *, user=None) -> dict:
    """The optional ``brief`` argument for ``getMomentPrompt``. Every field is re-validated by the engine."""
    req: dict = {}
    seen = _SEEN.get(_owner(user))
    now_seq = game_state.get("beatSeq") if isinstance(game_state, dict) else None
    if isinstance(seen, dict) and isinstance(now_seq, int) and isinstance(seen.get("beatSeq"), int) \
            and seen["beatSeq"] > now_seq:
        # The beat counter only grows within one game, so a marker AHEAD of it belongs to an earlier game (a new
        # season starts a fresh counter). Drop it: "Unknown" is honest, a stale marker is not.
        _SEEN.pop(_owner(user), None)
        seen = None
    if isinstance(seen, dict):
        req["seen"] = seen
    house = game_state.get("house") if isinstance(game_state, dict) else None
    ids = asked_about([player_msg if isinstance(player_msg, str) else "", tail or ""], house)
    if ids:
        req["askedAbout"] = ids
    if tail:
        req["lastShown"] = tail
    return req


def stash(session_id, mp: Any) -> None:
    """Keep this turn's brief (from the ``getMomentPrompt`` response) for ``build_chat_context``. A missing brief
    CLEARS any earlier one for this session, so a stale brief never rides onto a later turn."""
    key = session_id or "default"
    sb = mp.get("showBrief") if isinstance(mp, dict) else None
    if isinstance(sb, dict) and isinstance(sb.get("text"), str) and sb["text"].strip():
        _STASH[key] = {"text": sb["text"], "seen": sb.get("seen") if isinstance(sb.get("seen"), dict) else None}
    else:
        _STASH.pop(key, None)


def clear(session_id) -> None:
    _STASH.pop(session_id or "default", None)


def pop(session_id, user=None) -> Optional[str]:
    """Consume this session's brief (one-shot) and remember its ``seen`` state as what the narrator last saw."""
    item = _STASH.pop(session_id or "default", None)
    if not item:
        return None
    if isinstance(item.get("seen"), dict):
        _SEEN[_owner(user)] = copy.deepcopy(item["seen"])
    return item["text"]


def _order(pid: str):
    """The engine's person order (``idOrder`` in showBrief.ts): npc:N by number, anything else after, by string."""
    n = pid.split(":", 1)[1] if pid.startswith("npc:") else ""
    return (0, int(n), pid) if n.isdigit() else (1, 0, pid)


def _ids(people: Any) -> Optional[list]:
    """The ids in a whereabouts ``present`` list, deduplicated, in engine order. None when malformed."""
    if not isinstance(people, list):
        return None
    out = []
    for p in people:
        pid = p.get("id") if isinstance(p, dict) else None
        if not isinstance(pid, str):
            return None
        out.append(pid)
    return sorted(set(out), key=_order)


def _seen_from_whereabouts(wa: Any, prev: Optional[dict], beat_seq: Any = None, clock: Any = None) -> Optional[dict]:
    """The engine's seen shape built from a player-visible WhereaboutsView (what a tool result showed the narrator).
    The beat and clock come from the result when it carries them, else from the previous marker."""
    if not isinstance(wa, dict) or not isinstance(wa.get("room"), str):
        return None
    here = _ids(wa.get("present"))
    nearby = wa.get("nearby")
    if here is None or not isinstance(nearby, list):
        return None
    in_view = []
    for n in nearby:
        ids = _ids(n.get("present")) if isinstance(n, dict) else None
        if ids is None or not isinstance(n.get("room"), str):
            return None
        in_view.append({"room": n["room"], "ids": ids})
    seen = {"v": 1, "beatSeq": beat_seq if isinstance(beat_seq, int) else (prev or {}).get("beatSeq", 0)}
    clk = clock if isinstance(clock, str) and clock else (prev or {}).get("clock")
    if isinstance(clk, str) and clk:
        seen["clock"] = clk
    seen.update({"room": wa["room"], "here": here, "inView": in_view})
    return seen


def note_tool_result(user, result: Any) -> None:
    """A result the narrator READ showed it the house: a whereabouts / moveTo / getGameState tool result, or the
    move belt's record of a walk the reply already narrated. Move the marker to it, so the next brief does not
    report any of it again. Flag off, or a result with no usable whereabouts ⇒ no-op. Never called for the front
    end's own engine reads (the framing's reads, the belts' checks)."""
    if not show_brief_enabled() or not isinstance(result, dict):
        return
    wa = result.get("whereabouts") if isinstance(result.get("whereabouts"), dict) else result
    seen = _seen_from_whereabouts(wa, _SEEN.get(_owner(user)), result.get("beatSeq"), result.get("clockLabel"))
    if seen:
        _SEEN[_owner(user)] = seen


def note_narrated_npc_move(user, hid: Any, result: Any) -> None:
    """The NPC move belt recorded a houseguest walk the reply already narrated. Move ONLY that houseguest in the
    marker (to where the result shows them, or out of it when they are out of view); everyone else stays as the
    narrator last saw them, so a change the narrator did not see is still reported. Only an applied move counts.
    Flag off, no marker, or a malformed result ⇒ no-op."""
    if not show_brief_enabled() or not isinstance(hid, str) or not isinstance(result, dict) \
            or result.get("status") != "moved":
        return
    key = _owner(user)
    m = _SEEN.get(key)
    if not isinstance(m, dict) or not isinstance(m.get("room"), str):
        return
    here = [i for i in (m.get("here") if isinstance(m.get("here"), list) else []) if isinstance(i, str) and i != hid]
    in_view = [{"room": v["room"], "ids": [i for i in v["ids"] if isinstance(i, str) and i != hid]}
               for v in (m.get("inView") if isinstance(m.get("inView"), list) else [])
               if isinstance(v, dict) and isinstance(v.get("room"), str) and isinstance(v.get("ids"), list)]
    wa = result.get("whereabouts")
    if isinstance(wa, dict) and wa.get("room") == m["room"]:
        if hid in (_ids(wa.get("present")) or []):
            here = sorted(set(here + [hid]), key=_order)
        else:
            for n in (wa.get("nearby") if isinstance(wa.get("nearby"), list) else []):
                if isinstance(n, dict) and isinstance(n.get("room"), str) and hid in (_ids(n.get("present")) or []):
                    slot = next((v for v in in_view if v["room"] == n["room"]), None)
                    if slot is None:
                        in_view.append({"room": n["room"], "ids": [hid]})
                    else:
                        slot["ids"] = sorted(set(slot["ids"] + [hid]), key=_order)
                    break
    _SEEN[key] = {**m, "here": here, "inView": in_view}


def served_seen(user) -> Optional[dict]:
    """A copy of what the narrator last saw, to stamp on the assistant chat row at save time. None when the flag is
    off or there is no marker."""
    if not show_brief_enabled():
        return None
    seen = _SEEN.get(_owner(user))
    return copy.deepcopy(seen) if isinstance(seen, dict) else None


def adopt_history_seen(user, history: Any) -> None:
    """After a restart (no in-memory marker for this owner), adopt the marker stamped on the newest assistant row
    that carries one. An in-memory marker is never replaced. Flag off ⇒ no-op. The engine re-validates whatever is
    adopted, and ``build_request`` drops a marker from an earlier game."""
    if not show_brief_enabled() or _owner(user) in _SEEN:
        return
    for msg in reversed(list(history or [])):
        role = getattr(msg, "role", None) if not isinstance(msg, dict) else msg.get("role")
        if role != "assistant":
            continue
        md = getattr(msg, "metadata", None) if not isinstance(msg, dict) else msg.get("metadata")
        seen = md.get("briefSeen") if isinstance(md, dict) else None
        if isinstance(seen, dict) and seen.get("v") == 1 and isinstance(seen.get("room"), str):
            _SEEN[_owner(user)] = copy.deepcopy(seen)
            return


def forget(user) -> None:
    """A season was created or reset for this owner: the old game's marker must never brief the new one."""
    _SEEN.pop(_owner(user), None)


try:  # register at import; fail-soft so a missing engine module never breaks the brief
    from src import orwell_engine as _oe_for_reset
    _oe_for_reset.on_season_reset(forget)
except Exception:  # pragma: no cover - the engine module is always importable in the app
    pass
