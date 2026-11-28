"""ORW-419 - intent-first moves (FE side): resolve the player's OWN move in the engine BEFORE the narrator runs.

One small, fail-soft helper. The player's message text goes to the engine's ``resolvePlayerMove`` lever (an INFRA lever, never a
model lever): the engine parses present-tense self-moves ("I go to the kitchen", "leave the backyard", "go inside"), performs
the move itself and records ``playerMove`` on the turn state the narrator's briefing reads. The narrator voices the exit and the
arrival; it never decides, blocks or asks permission for the player's own move. Unsure parses move nothing (the existing
post-reply move belt, ``agent_loop._auto_move_player``, stays the fallback; the player's stated move always wins).

Called from ``routes.chat_helpers`` right after the per-message ``noteMessage`` and BEFORE ``apply_game_framing`` builds the
narrator's moment prompt, so the prompt already shows the new room. Telemetry is success-gated: a belt fire is counted only when
the engine actually applied a move.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Optional

logger = logging.getLogger(__name__)

BELT_NAME = "player-move-intent"

#: ORW-1038: the users whose LAST message the engine's parser already decided (moved them, or refused the move): the post-reply move belt must not write a second, different move over it.
_DECIDED: set = set()


def engine_decided_this_message(user) -> bool:
    return (user or "") in _DECIDED


async def resolve_player_move_before_narrator(text: Any, user: Optional[str], client_msg_id: Optional[str] = None,
                                              *, engine: Any = None, previous_reply: Optional[str] = None) -> Optional[dict]:
    """Resolve the player's own move from ``text`` in the engine. Returns the engine's ``playerMove`` dict ({from,to} or
    {refused,reason}) when the words held a clear move, else None. Never raises."""
    try:
        _DECIDED.discard(user or "")  # ORW-1038: a new message: last turn's verdict is over
        if not isinstance(text, str) or not text.strip():
            return None
        if engine is None:
            from src import orwell_engine as engine  # type: ignore[no-redef]
        key = f"move:{client_msg_id}" if client_msg_id else None
        extra = {"previous_reply": previous_reply} if previous_reply else {}
        res = await engine.resolve_player_move(text, key, user=user, **extra)
        if not isinstance(res, dict):
            return None
        try:
            from routes.chat_helpers import _refresh_beat_seq
            _refresh_beat_seq(user, res)
        except Exception:
            pass
        move = res.get("playerMove")
        if not isinstance(move, dict):
            return None
        _DECIDED.add(user or "")
        try:
            from src import orwell_sync_ledger as _led
            if not move.get("refused"):
                _led.note_belt_fire(user, BELT_NAME)  # success-gated: an APPLIED move, never an attempt
        except Exception:
            pass
        logger.info("[orwell] intent-first move user=%s refused=%s", user, bool(move.get("refused")))  # no content
        return move
    except Exception as exc:
        try:
            from src import log_rings
            log_rings.record_soft_failure("player-move:resolve-failed", exc,
                                          corrected="the post-reply move belt stays the fallback", user=user)
        except Exception:  # failsoft-ok: the recorder itself is down; the failure was already WARN-logged below
            logger.warning("[orwell] intent-first move failed (fail-soft): %s", exc)
        return None


# ── ORW-1168: an ESCORT ("come with me", "invite her outside") commits the houseguest's walk too ─────────────────────────────
#: ORW-1168: the houseguests the engine said NO for this turn's escort; the narrated-move belt never moves them over that answer.
_ESCORT_DECLINED: dict = {}


def escort_declined_ids(user) -> set:
    return set(_ESCORT_DECLINED.get(user or "") or ())


def _recent_ids(roster: dict, texts) -> list:
    """Houseguest ids named in `texts` (newest text first; inside one text, the one named last first). Roles only: no text is kept."""
    import re
    out: list = []
    for tx in texts:
        low = (tx or "").lower()
        hits = []
        for hid, nm in roster.items():
            first = str(nm or "").split()[0].lower() if str(nm or "").split() else ""
            if first:
                pos = [m.start() for m in re.finditer(r"(?<![\w'])" + re.escape(first) + r"(?![\w'])", low)]
                if pos:
                    hits.append((max(pos), hid))
        out += [h for _, h in sorted(hits, reverse=True) if h not in out]
    return out


def _last_speaker(previous_reply, roster: dict, present_ids: set):
    import re
    tags = [m.group(1).strip().lower() for m in re.finditer(r"^\s*@\[([^\]]+)\]", previous_reply or "", re.M)]
    by_name = {str(n).strip().lower(): i for i, n in roster.items()}
    for nm in reversed(tags):
        hid = by_name.get(nm)
        if hid in present_ids:
            return hid
    return None


async def escort_before_narrator(text: Any, user: Optional[str], client_msg_id: Optional[str] = None, *, previous_reply: Optional[str] = None,
                                 recent_user=(), engine: Any = None) -> Optional[dict]:
    """ORW-1168: the player's words invite a houseguest along to a named room ("do you wanna come with?", "invite her outside"). The engine commits BOTH walks before the narrator speaks:
    the houseguest's through `askToTalkAlone` (private:false: they go to that room, or DECLINE on their own read of the player) and the player's own move. What the engine did rides the
    stash as notes the narrator must voice (she came / she said no); the narration never moves a houseguest the engine did not. Returns {notes, done, committed} for `apply_escort`, or None when the words held no escort. Never raises."""
    try:
        _ESCORT_DECLINED.pop(user or "", None)  # a new message: last turn's refusals are over
        from src import act_first as af
        if not isinstance(text, str) or not af.escort_cue(text):
            return None
        if engine is None:
            from src import orwell_engine as engine  # type: ignore[no-redef]
        state = await engine.get_game_state(user=user)
        if not isinstance(state, dict) or state.get("started") is False:
            return None
        status = await engine.game_status(user=user)
        pend = ((status or {}).get("pending") or {}) if isinstance(status, dict) else {}
        if isinstance(pend, dict) and (pend.get("kind") or "").strip():
            return None  # a card decision is open: the card owns the turn
        wa = await engine.whereabouts(user=user)
        here = (wa or {}).get("room") if isinstance(wa, dict) else None
        if not here:
            return None
        roster = {str(h.get("id")): str(h.get("name")) for h in (state.get("house") or []) if isinstance(h, dict) and h.get("id") and h.get("name") and str(h.get("status") or "active") == "active"}
        present = {str(p.get("id")) for p in ((wa or {}).get("present") or []) if isinstance(p, dict) and p.get("id")}
        from routes import chat_helpers as _ch
        from src.agent_loop import _HOUSE_ROOMS, _season_room_names
        names = _season_room_names(user) or _ch.room_names_of(wa)
        ctx = {"room_names": names, "here": here, "rooms": list(_HOUSE_ROOMS), "roster": roster,
               "recent_ids": _recent_ids(roster, [t for t in recent_user if t and t != text] + [previous_reply or ""]),
               "addressee": _last_speaker(previous_reply, roster, present)}
        intent = af.escort_intent(text, ctx)
        if not intent:
            return None
        hid, who, dest = intent["id"], intent["name"], intent["room"]
        res = await engine.ask_to_talk_alone(hid, dest, False, user=user)
        outcome = res.get("outcome") if isinstance(res, dict) else None
        if isinstance(res, dict):
            try:
                _ch._refresh_beat_seq(user, res)
            except Exception:  # failsoft-ok: the next engine call reconciles a stale token
                pass
        came = outcome == "accepted"
        moved = False
        if dest != here:
            from src import tool_implementations as _ti
            import json as _json
            mv = await _ti.do_move_to(_json.dumps({"room": dest}), owner=user)
            try:
                out = _json.loads(mv.get("output") or "{}") if isinstance(mv, dict) else {}
            except Exception:
                out = {}
            moved = isinstance(mv, dict) and not mv.get("error") and str(out.get("room") or "").lower() == dest
        label = dest.replace("-", " ")
        notes = []
        if came:
            notes.append(f"{who} AGREED and the engine has them in {label} now" + (" with the player, who walked there too: voice the two arriving together." if moved else ", where the player already stands: voice them arriving. Whatever trip the player describes ends here, with the two together."))
        elif outcome is None:
            notes.append(f"The player asked {who} along to {label}, but the game could not place them: {who} did NOT come. Do not write them arriving.")
        else:
            notes.append(f"The player asked {who} along to {label} and {who} did NOT come (the engine answered: {outcome}). Voice {who} saying no in character, with no reason given, or the ask going nowhere; "
                         f"{who} stays where they were. NEVER write {who} walking out with the player.")
        if moved:
            notes.append(f"The player is NOW in {label}: voice the move.")
        done = [("moveTo", {"room": dest}, True)] if moved else []
        if not came:
            _ESCORT_DECLINED[user or ""] = {hid}
        if moved:
            af.note_commit("moveTo", True)
        try:
            from src import orwell_sync_ledger as _led
            _led.note_belt_fire(user, "escort-accepted" if came else "escort-declined")
            if came and dest != here:
                from src import orwell_companions as _oc
                _oc.add(user, hid, who)  # ORW-1030: an agreed companion stays with the player until the player ends it
        except Exception:  # failsoft-ok: telemetry and the companion store are aids; the engine board holds the truth
            pass
        logger.info("[orwell] escort user=%s outcome=%s moved=%s", user, outcome, moved)  # no content
        return {"notes": notes, "done": done, "committed": bool(moved or came)}
    except Exception as exc:
        try:
            from src import log_rings
            log_rings.record_soft_failure("escort:failed", exc, corrected="the ordinary path runs", user=user)
        except Exception:  # failsoft-ok: the recorder itself is down
            logger.warning("[orwell] escort failed (fail-soft): %s", exc)
        return None


def apply_escort(user: Optional[str], payload: Optional[dict], client_msg_id: Optional[str] = None) -> None:
    """Hand the escort's notes to the narrator (the stash the agent loop reads), AFTER act-first / the parser ran (each writes its own stash), and mark the player's move decided so the
    after-reply move belt never writes a second move over it. Never raises."""
    try:
        if not payload:
            return
        from src import act_first as af
        merged = af.add_stash_notes(user or "default", payload.get("notes") or [], payload.get("done") or [])
        if payload.get("committed"):
            af.put_commit_memo(user or "default", client_msg_id, merged)
        _DECIDED.add(user or "")
    except Exception:  # failsoft-ok: the engine already holds the truth; only the narrator's note is lost
        logger.warning("[orwell] escort hand-off skipped", exc_info=True)


# ── ORW-1174: ACCEPT / FOLLOW. A houseguest's invitation is their consent: the player's yes commits BOTH walks ────────────────────
#: ORW-1174: the player has said yes to an invitation and the engine has put the two together: {id, name, room}. The narrator's rule for the walk is tied to this engine fact (see `follow_notes`).
_ON_THE_WAY: dict = {}


def on_the_way(user) -> Optional[dict]:
    """The accepted invitation the engine has already walked, for this user's current message (None otherwise)."""
    d = _ON_THE_WAY.get(user or "")
    return dict(d) if d else None


def _reply_lines(previous_reply, roster: dict) -> list:
    """[(id, line)] for the tagged lines (`@[Name] ...`) of the last story reply, in order; only houseguests on the roster."""
    import re
    by_name = {str(n).strip().lower(): i for i, n in roster.items()}
    out = []
    for m in re.finditer(r"^\s*@\[([^\]]+)\]\s*(.*)$", previous_reply or "", re.M):
        hid = by_name.get(m.group(1).strip().lower())
        if hid:
            out.append((hid, m.group(2)))
    return out


async def invite_context(text: Any, user: Optional[str], previous_reply: Optional[str] = None, *, engine: Any = None, state: Any = None, status: Any = None, wa: Any = None) -> Optional[dict]:
    """The standing invitation the player's words may be answering, as `act_first.find_invite` reads it (an open talk ask, or a houseguest HERE whose line in the last reply invites), plus the context it was read from
    under key `ctx`. None when none stands, a card decision is open, or the game has not started. Never raises."""
    try:
        from src import act_first as af
        if engine is None:
            from src import orwell_engine as engine  # type: ignore[no-redef]
        state = state if state is not None else await engine.get_game_state(user=user)
        if not isinstance(state, dict) or state.get("started") is False:
            return None
        status = status if status is not None else await engine.game_status(user=user)
        pend = ((status or {}).get("pending") or {}) if isinstance(status, dict) else {}
        if isinstance(pend, dict) and (pend.get("kind") or "").strip():
            return None  # a card decision is open: the card owns the turn
        wa = wa if wa is not None else await engine.whereabouts(user=user)
        here = (wa or {}).get("room") if isinstance(wa, dict) else None
        if not here:
            return None
        roster = {str(h.get("id")): str(h.get("name")) for h in (state.get("house") or []) if isinstance(h, dict) and h.get("id") and h.get("name") and str(h.get("status") or "active") == "active"}
        present = [str(p.get("id")) for p in ((wa or {}).get("present") or []) if isinstance(p, dict) and p.get("id")]
        hoh = ((status or {}).get("hoh") or {}) if isinstance(status, dict) else {}
        hoh_id = str(hoh.get("id")) if isinstance(hoh, dict) and hoh.get("id") else None
        oa = state.get("openTalkAsk")
        open_ask = None
        if isinstance(oa, dict) and isinstance(oa.get("from"), dict) and oa["from"].get("id"):
            open_ask = {"id": str(oa["from"]["id"]), "room": oa.get("room")}
        from routes import chat_helpers as _ch
        from src.agent_loop import _season_room_names
        names = _season_room_names(user) or _ch.room_names_of(wa)
        ctx = {"roster": roster, "present": present, "here": here, "room_names": names, "hoh_id": hoh_id, "open_ask": open_ask, "reply_lines": _reply_lines(previous_reply, roster)}
        inv = af.find_invite(text if isinstance(text, str) else "", ctx)
        if not inv:
            return None
        return {**inv, "ctx": {**ctx, "invite": {k: inv.get(k) for k in ("id", "name", "room", "source", "line")}}}
    except Exception as exc:
        logger.warning("[orwell] invite context failed (fail-soft): %s", type(exc).__name__)
        return None


def follow_notes(who: str, label: str, moved_player: bool) -> list:
    """The narrator's notes for an accepted invitation. The RULE is tied to the engine fact (the player is on their way with `who`, and the engine has the two together): the walk completes in this reply."""
    return [
        f"{who} invited the player and the player ACCEPTED: the engine has the two of them together in {label} now" + (", the player included: voice the two setting off and arriving together." if moved_player else ": voice the two arriving together."),
        f"RULE (the player is on their way with {who}, an engine fact): at most ONE other houseguest may break in before the two arrive, with a single short word that does not hold them up; then the walk completes in THIS reply "
        f"and {who} opens the talk in {label}. No second interruption, no second invitation, no one blocking the way, and {who} is never written as having gone somewhere else.",
    ]


async def commit_follow(inv: dict, text: Any, user: Optional[str], *, engine: Any = None, here: Optional[str] = None, room_names=None) -> Optional[dict]:
    """Commit the yes to `inv` ({id, name, room, source}): both walks, through the engine's own levers. 'ask': the engine's open talk ask is accepted (`askToTalkAlone` places both). 'reply': a houseguest in the player's
    room invited the player somewhere: the player walks (`moveTo`), then the houseguest's walk is the same lever with `invited` (their invitation is their consent; no roll). Returns {notes, done, committed} or None when
    there is nothing to move (no place to go). Never raises."""
    try:
        from src import act_first as af
        from routes import chat_helpers as _ch
        if engine is None:
            from src import orwell_engine as engine  # type: ignore[no-redef]
        hid, who, dest = inv["id"], inv["name"], inv.get("room")
        if inv.get("source") != "ask" and not dest:
            named = [r for r in af.rooms_named(text if isinstance(text, str) else "", room_names) if r != "diary-room" and r != here]
            dest = named[-1] if named else None
        if inv.get("source") != "ask" and (not dest or dest == here):
            return None
        done: list = []
        if inv.get("source") == "ask":
            res = await engine.ask_to_talk_alone(hid, dest, True, user=user)
            outcome = res.get("outcome") if isinstance(res, dict) else None
            try:
                _ch._refresh_beat_seq(user, res)
            except Exception:  # failsoft-ok: the next engine call reconciles a stale token
                pass
            came = outcome == "accepted"
            room = (res or {}).get("room") if isinstance(res, dict) else None
            label = str((res or {}).get("roomName") or (room or "").replace("-", " ")) if came else ""
            if came:
                done = [("moveTo", {"room": room}, True)] if room and room != here else []
                notes = follow_notes(who, label or "their room", bool(done))
            else:
                notes = [f"The player said yes to {who}'s ask for a word, but the game could not put them together just now ({outcome or 'no answer'}): nobody moved. Voice that in the fiction (the place is taken or the moment is not right); do not write them anywhere new."]
            moved = bool(done)
        else:
            import json as _json
            from src import tool_implementations as _ti
            mv = await _ti.do_move_to(_json.dumps({"room": dest}), owner=user)
            try:
                out = _json.loads(mv.get("output") or "{}") if isinstance(mv, dict) else {}
            except Exception:
                out = {}
            moved = isinstance(mv, dict) and not mv.get("error") and str(out.get("room") or "").lower() == dest
            label = dest.replace("-", " ")
            if not moved:
                return {"notes": [f"The player said yes to {who}'s invitation, but the game did not let them reach {label}: nobody moved. Voice that in the fiction."], "done": [], "committed": False}
            res = await engine.ask_to_talk_alone(hid, dest, False, user=user, invited=True)
            outcome = res.get("outcome") if isinstance(res, dict) else None
            try:
                _ch._refresh_beat_seq(user, res)
            except Exception:  # failsoft-ok: the next engine call reconciles a stale token
                pass
            came = outcome == "accepted"
            done = [("moveTo", {"room": dest}, True)]
            if came:
                notes = follow_notes(who, label, True)
            else:
                notes = [f"The player went to {label} on {who}'s invitation but the game could not place {who} there ({outcome or 'no answer'}). Voice the player arriving alone and {who} not yet there; do not write them arriving."]
        if done:
            af.note_commit("moveTo", True)
        if came:
            _ON_THE_WAY[user or ""] = {"id": hid, "name": who, "room": dest or label}
        try:
            from src import orwell_sync_ledger as _led
            _led.note_belt_fire(user, "follow-accepted" if came else "follow-blocked")
        except Exception:  # failsoft-ok: telemetry only
            pass
        logger.info("[orwell] follow user=%s source=%s outcome=%s moved=%s", user, inv.get("source"), outcome, moved)  # no content
        return {"notes": notes, "done": done, "committed": bool(came or moved)}
    except Exception as exc:
        try:
            from src import log_rings
            log_rings.record_soft_failure("follow:failed", exc, corrected="the ordinary path runs", user=user)
        except Exception:  # failsoft-ok: the recorder itself is down
            logger.warning("[orwell] follow failed (fail-soft): %s", exc)
        return None


async def follow_before_narrator(text: Any, user: Optional[str], client_msg_id: Optional[str] = None, *, previous_reply: Optional[str] = None, engine: Any = None) -> bool:
    """ORW-1174: the player's plain yes to a standing invitation ('sure', 'yeah lets go', 'follow Kai inside', 'go upstairs with Kai') commits BOTH walks before the narrator speaks, whether or not act-first is on.
    True when this slot owned the message (the player's own move parse is then switched off: it would walk the player away from the inviter); False when it did not (nothing committed, the ordinary path runs). Never raises."""
    try:
        _ON_THE_WAY.pop(user or "", None)  # a new message: last turn's walk is over
        from src import act_first as af
        if not isinstance(text, str) or not text.strip() or af.prefilter(text):
            return False
        t = af.strip_quotes(af.clean_text(text))
        if not (af._CUE.search(t) or af._ACC_GO.search(t) or re.search(r"\blead\b|\bafter you\b", t, re.I)):
            return False  # nothing yes-like in the words: no engine read is spent
        if engine is None:
            from src import orwell_engine as engine  # type: ignore[no-redef]
        got = await invite_context(text, user, previous_reply, engine=engine)
        if not got:
            return False
        ctx = got["ctx"]
        acc = af.accept_intent(text, ctx)
        if not acc:
            return False
        r = await commit_follow(acc, text, user, engine=engine, here=ctx.get("here"), room_names=ctx.get("room_names"))
        if r is None:
            return False
        key = user or "default"
        af.put_stash(key, {"outcome": "follow", "text": text, "done": r["done"], "pending": [], "blocked": [], "notes": r["notes"]})
        if r["committed"]:
            af.put_commit_memo(key, client_msg_id, r["notes"])
        _DECIDED.add(user or "")
        extra = {"previous_reply": previous_reply} if previous_reply else {}
        await engine.resolve_player_move(text, f"move:{client_msg_id}" if client_msg_id else None, user=user, skip=["move", "bed"], **extra)  # the other text resolvers still run; the walk is the engine's already
        return True
    except Exception as exc:
        try:
            from src import log_rings
            log_rings.record_soft_failure("follow:slot-failed", exc, corrected="the ordinary move parser runs", user=user)
        except Exception:  # failsoft-ok: the recorder itself is down
            logger.warning("[orwell] follow slot failed (fail-soft): %s", exc)
        return False


# ── ORW-1014 PR 2: the ACT-FIRST owner of this slot (flag ORWELL_ACT_FIRST, default OFF) ───────────────────────────
_AF_ROOMS_ID = None


async def act_first_before_narrator(text: Any, user: Optional[str], client_msg_id: Optional[str] = None, *, sess: Any = None,
                                    previous_reply: Optional[str] = None, engine: Any = None, call: Any = None) -> bool:
    """Take resolvePlayerMove's slot when the act-first flag is on. ONE owner per message: ONE forced call over a closed toolset decides the player's acts; the engine commits
    the move / bed claim / search here (before the briefing is built); the sleep / advance / step-answer acts ride a stash to the agent loop (they go through the tool dispatcher);
    the engine's other text resolvers (who-told-you, meeting call, own-bed walk) still run, with the move and bed text parses switched off. Returns True when act-first owned the
    message; False (nothing committed, the caller runs the ordinary parser, one idempotency key) when it is off, the route cannot force, or the round failed or timed out. Never raises."""
    try:
        from src import act_first as af
        if not af.enabled() or not isinstance(text, str) or not text.strip():
            return False
        from src.agent_loop import (_model_honors_forced_tool_choice, _HOUSE_ROOMS, _season_room_names, _themed_rooms_note, _EXTRACTION_UNTRUSTED_FENCE,
                                    _player_means_going_to_bed, _bedtime_board_allows)
        url = getattr(sess, "endpoint_url", "") or ""
        model = getattr(sess, "model", "") or ""
        if call is None and not _model_honors_forced_tool_choice(model, route=url, site="actfirst"):
            return False
        if engine is None:
            from src import orwell_engine as engine  # type: ignore[no-redef]
        from routes import chat_helpers as _ch
        key = user or "default"
        memo = af.take_retry_memo(key, text, client_msg_id)
        if memo is not None:
            # ORW-1143: the earlier turn committed, then died before its reply. Nothing is committed again; the narrator voices what already happened.
            af.put_stash(key, {"outcome": "retry-after-failure", "text": "", "done": [], "pending": [], "blocked": [],
                               "notes": list(memo.get("notes") or []) + ["The previous reply failed to reach the player. The change above is already in the game: voice it now, change nothing again."]})
            return True
        state = await engine.get_game_state(user=user)
        if isinstance(state, dict) and state.get("started") is False:
            return False  # ORW-1014: the casting interview has no board to act on (prod 2026-11-28: 13 of 26 messages, two paid calls); the ordinary path runs as before
        status = await engine.game_status(user=user)
        pend =((status or {}).get("pending") or {}) if isinstance(status, dict) else {}
        kind = (pend.get("kind") or "").strip() if isinstance(pend, dict) else ""
        wa = await engine.whereabouts(user=user)
        here = (wa or {}).get("room") if isinstance(wa, dict) else None
        people =[str(h.get("name")) for h in ((state or {}).get("house") or []) if isinstance(h, dict) and h.get("name") and str(h.get("status") or "active") == "active"] if isinstance(state, dict) else []
        names = _season_room_names(user)
        if not names:  # ORW-1128: this slot runs BEFORE the turn's framing pins the whereabouts, so the pinned names are last turn's (or none on the first turn): read this turn's from the whereabouts just fetched
            names = _ch.room_names_of(wa)
        ctx = {
            "pending_kind": kind or None,
            "required_lever": _ch._LAST_FRAMED_REQUIRED_LEVER.get(key),
            "social_hold": bool(_ch.veto_draw_holds_force(user or "") or _ch.event_pause_holds(user)),
            "room_names": names, "here": here, "people": people,
            "sleep_ok": bool(_player_means_going_to_bed(text) and _bedtime_board_allows(status)),
        }
        # ORW-1174: the standing invitation (an open talk ask, or a houseguest here whose last line invited the player): the round sees it, so a yes can be read as a yes.
        _inv = await invite_context(text, user, previous_reply, engine=engine, state=state, status=status, wa=wa) if not kind else None
        if _inv:
            ctx["invite"] = _inv["ctx"]["invite"]
            ctx["roster"] = _inv["ctx"]["roster"]
        if call is None:
            from src.llm_core import llm_tool_call_async as call  # type: ignore[no-redef]
            from src.endpoint_resolver import resolve_session_headers
            kw = {"url": url, "model": model, "headers": resolve_session_headers(sess, user)}
        else:
            kw = {}
        d = await af.decide(text, _HOUSE_ROOMS, ctx=ctx, fence=_EXTRACTION_UNTRUSTED_FENCE, room_note=_themed_rooms_note(names), call=call, **kw)
        outcome = d["outcome"].split(":")[0]
        if d["outcome"] in ("error", "timeout") or d["outcome"] == "skipped:pending":
            return False  # the forced round failed / a card decision is open: the ordinary parser, once
        logger.info("[orwell] act-first outcome=%s ms=%.0f user=%s", d["outcome"], d["latencyMs"], user)  # no content
        if not d["acts"]:
            # ORW-1128 (prod 2026-11-28: the story moved the player and gave a bed, the engine kept both in the kitchen): act-first found nothing it could commit (noAction, or the message never reached
            # the model). It must not own the message then: the engine's ordinary text parser (move + bed) runs, so a move can never be silently dropped. The outcome still rides a stash for the ledger.
            af.put_stash(key, {"outcome": outcome, "text": text, "done": [], "pending": [], "blocked": [], "notes": []})
            return False
        done, blocked, notes, pending = [], [], [], []
        from src import tool_implementations as _ti
        msgid = client_msg_id or "nomsgid"
        for act in d["acts"]:
            tool, args = act
            why = af.blocked_precondition(act, blocked)
            if why:
                blocked.append(act)
                notes.append(f"The player's {tool} was NOT run: {why}.")
                af.note_commit(tool, False)
                continue
            if tool in af.LOOP_TOOLS:
                pending.append(act)
                continue
            ok = False
            if tool == "followInvite":
                fr = await commit_follow({"id": args["id"], "name": (ctx.get("roster") or {}).get(args["id"]) or "the houseguest", "room": args.get("room"), "source": args.get("source")},
                                         text, user, engine=engine, here=here, room_names=names)
                if fr is None:
                    continue  # nothing to move (no place named): the ordinary path below reads the words
                notes.extend(fr["notes"])
                ok = bool(fr["committed"])
                for d_ in fr["done"]:
                    done.append(d_)
                    af.note_commit(d_[0], bool(d_[2]))
                if not ok:
                    blocked.append(act)
                af.note_commit("followInvite", ok)
                continue
            if tool == "moveTo":
                import json as _json
                res = await _ti.do_move_to(_json.dumps(args), owner=user)
                try:
                    out = _json.loads(res.get("output") or "{}") if isinstance(res, dict) else {}
                except Exception:
                    out = {}
                ok = isinstance(res, dict) and not res.get("error") and str(out.get("room") or "").lower() == args["room"]
                if ok:
                    notes.append(f"The player is NOW in {args['room']}: voice the move.")
            elif tool == "claimBed":
                room_word = args["room"].replace("-", " ")  # "bedroom a": the engine's own bed-claim reader takes this sentence
                kind_word = {"single": "single ", "double": "double "}.get(args.get("kind"), "")
                r = await engine.resolve_player_move(f"I take a {kind_word}bed in {room_word}.", f"actfirst-bed:{msgid}:{len(done)}", user=user)
                ok = isinstance(r, dict)
            elif tool == "search":
                r = await engine.resolve_player_move(f"I look for {args['who']}.", f"actfirst-search:{msgid}", user=user, max_legs=af.SEARCH_MAX_LEGS)  # ORW-1135: capped legs
                sr = r.get("search") if isinstance(r, dict) and isinstance(r.get("search"), dict) else None
                ok = isinstance(r, dict) and bool(sr or r.get("playerMove"))
                if sr is not None and sr.get("outcome") == "found" and not sr.get("legs"):
                    # ORW-1136: the target is already in the player's room: a success, not a block; no walk, no clock spent
                    notes.append(f"{args['who']} is right here in the player's current room: no walk was needed. Voice them present in this room; do not send them or the player anywhere.")
                elif sr is not None and sr.get("outcome") == "stopped":
                    notes.append(f"The player's search for {args['who']} ended early: {sr.get('reason') or 'it was capped'}. Voice only the legs the engine returned and where the player now stands.")
            if not ok:
                blocked.append(act)
                notes.append(f"The player's {tool} was BLOCKED by the game: voice that in the fiction.")
            af.note_commit(tool, ok)
            done.append((tool, args, ok))
        # the engine's other text resolvers still run; the move / bed / search text parses are the model's now. Skipped when the model's own commit already ran the real text.
        extra = {"previous_reply": previous_reply} if previous_reply else {}
        await engine.resolve_player_move(text, f"move:{client_msg_id}" if client_msg_id else None, user=user, skip=["move", "bed"], **extra)
        af.put_stash(key, {"outcome": outcome, "text": text, "done": done, "pending": pending, "blocked": blocked, "notes": notes})
        if done:
            af.put_commit_memo(key, client_msg_id, notes)
        return True
    except Exception as exc:
        try:
            from src import log_rings
            log_rings.record_soft_failure("act-first:slot-failed", exc, corrected="the ordinary move parser runs", user=user)
        except Exception:  # failsoft-ok: the recorder itself is down
            logger.warning("[orwell] act-first slot failed (fail-soft): %s", exc)
        return False
