"""Showrunner memory — the Show Brief v1 skeleton, front-end half (flag ``ORWELL_SHOW_BRIEF``, default OFF).

The ENGINE builds the brief (``src/engine/showBrief.ts``) from its own Vault-free projections; this module only:
  • decides whether to ask for it (the flag);
  • gathers the three optional echoes the engine re-validates —
      ``seen``        the state the PREVIOUS brief of this chat session returned (what the narrator last saw),
      ``askedAbout``  houseguest ids the player's message (or the last scene) named, resolved from the PUBLIC roster,
      ``lastShown``   the tail of the previous narrated reply, out-of-character ``(( ))`` asides removed;
  • hands the brief text from ``getMomentPrompt`` to ``build_chat_context`` (stash/pop keyed by SESSION, the #1752
    race fix), which appends it as a TERMINAL system message after the transcript, so the cached prefix is untouched;
  • remembers the ``seen`` state of the brief actually served, for the next turn.

Flag OFF ⇒ nothing here is called: ``getMomentPrompt`` is called exactly as before and no message is added.
Vault-free by construction: everything it reads is already player-visible (the chat the player saw, the public
roster names, the engine's own seen-state echo). In-memory only in v1: after a restart the first brief says
"Unknown" for what changed and trusts the full NOW section.
"""
from __future__ import annotations

import os
import re
from typing import Any, Optional

_FLAG = "ORWELL_SHOW_BRIEF"
_TAIL_WORDS = 40
_TAIL_MAX_CHARS = 320
_ASKED_MAX = 6

# session_id → {"text": str, "seen": dict} (this turn's brief, one-shot) and session_id → seen (last SERVED brief).
_STASH: dict = {}
_SEEN: dict = {}

_ASIDE_RE = re.compile(r"\(\([\s\S]*?\)\)")


def show_brief_enabled() -> bool:
    """``ORWELL_SHOW_BRIEF=1|true|yes|on`` asks the engine for the Show Brief each live turn. Default off."""
    return str(os.environ.get(_FLAG, "")).strip().lower() in ("1", "true", "yes", "on")


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


def build_request(session_id, game_state: Any, player_msg: Any, tail: Optional[str]) -> dict:
    """The optional ``brief`` argument for ``getMomentPrompt``. Every field is re-validated by the engine."""
    req: dict = {}
    seen = _SEEN.get(session_id or "default")
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


def pop(session_id) -> Optional[str]:
    """Consume this session's brief (one-shot) and remember its ``seen`` state as what the narrator last saw."""
    key = session_id or "default"
    item = _STASH.pop(key, None)
    if not item:
        return None
    if isinstance(item.get("seen"), dict):
        _SEEN[key] = item["seen"]
    return item["text"]
