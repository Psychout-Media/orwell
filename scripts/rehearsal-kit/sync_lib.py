"""ORW-506: the pure decision logic of the card-aware / toast-synchronised hang-out driver (a21_sync_drive.py). No browser, no network: everything here takes plain dicts,
so it is unit-tested offline (test_sync_lib.py). Roles only.

Script format (one entry per line; blank lines and lines starting with '#' are ignored):
  <text>          a player message, sent as written.
  next            the engine's "release the next arrival" message, sent as written.
  @toast <text>   the player's own toast line. The driver sends `next` until the engine says the player's toast slot is `now`, then sends <text>; if the toast is
                  already past (or the toast stage never comes within the bound) the line is SKIPPED, never sent at the wrong moment.
"""
from __future__ import annotations

import re

TOAST_PREFIX = "@toast "
CARD_JS = """() => { const d=document.querySelector('#orwell-decision-card'); if(!d) return null;
  return {title:(d.querySelector('.odec-title')||{}).innerText||'', opts:[...d.querySelectorAll('.odec-opt')].map(o=>o.innerText.trim()), hasText:!!d.querySelector('textarea')}; }"""


def parse_script(text):
    """-> [{"kind": "say"|"toast", "text": str}]. `next` is an ordinary say line."""
    out = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith(TOAST_PREFIX) and line[len(TOAST_PREFIX):].strip():
            out.append({"kind": "toast", "text": line[len(TOAST_PREFIX):].strip()})
        elif line.startswith("@"):
            raise ValueError(f"unknown script directive: {line.split()[0]!r}")
        else:
            out.append({"kind": "say", "text": line})
    return out


def toast_gate(entrance, nexts_sent, max_nexts):
    """What to do about a `@toast` line given the engine's premiereIntros().entrance: "send" (the player's slot is NOW), "release" (send `next` and look again),
    or "skip" (the toast is over for the player, was never reached, or the bound of `next` messages is spent)."""
    if not isinstance(entrance, dict) or not entrance:
        return "skip"                      # no premiere entrance on the board: the toast cannot be addressed
    slot, stage = entrance.get("playerToast"), entrance.get("stage")
    if slot == "now":
        return "send"
    if slot == "done" or (stage == "done" and not entrance.get("toastRemaining")):
        return "skip"                      # past the player's slot: sending it now would land in the wrong beat
    if nexts_sent >= max_nexts:
        return "skip"
    return "release"


def simplest_option(opts):
    """The index of the simplest legal option, or None; the same rule as live_week.simplest_option (skip, then compete, then keep / do not use), kept here so the kit has no
    import on live-run. test_sync_lib.py pins the two together."""
    for pat in (r"(?i)\bskip\b", r"(?i)\bcompete\b", r"(?i)do not use|don'?t use|not use|keep"):
        hit = next((i for i, o in enumerate(opts) if re.search(pat, o)), None)
        if hit is not None:
            return hit
    return None


def pick_for_card(card, me=None):
    """The option indexes to click for a decision card: a nominee who holds the veto saves themselves, nominations take the first two, else the simplest legal option, else the first."""
    title = (card.get("title") or "").lower()
    opts = card.get("opts") or []
    mine = next((i for i, o in enumerate(opts) if me and re.fullmatch(r"(?i)save\s+" + re.escape(me), o.strip())), None)
    if "veto" in title and mine is not None:
        return [mine]
    if "nominat" in title and len(opts) > 1:
        return [0, 1]
    hit = simplest_option(opts)
    return [hit] if hit is not None else ([0] if opts else [])


def card_budget_left(answered, max_cards):
    """A card answer costs a model call, so cards are bounded like messages: never answer past the bound."""
    return answered < max_cards
