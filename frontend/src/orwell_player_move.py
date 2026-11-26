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
from typing import Any, Optional

logger = logging.getLogger(__name__)

BELT_NAME = "player-move-intent"


async def resolve_player_move_before_narrator(text: Any, user: Optional[str], client_msg_id: Optional[str] = None,
                                              *, engine: Any = None, previous_reply: Optional[str] = None) -> Optional[dict]:
    """Resolve the player's own move from ``text`` in the engine. Returns the engine's ``playerMove`` dict ({from,to} or
    {refused,reason}) when the words held a clear move, else None. Never raises."""
    try:
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
        status = await engine.game_status(user=user)
        pend = ((status or {}).get("pending") or {}) if isinstance(status, dict) else {}
        kind = (pend.get("kind") or "").strip() if isinstance(pend, dict) else ""
        wa = await engine.whereabouts(user=user)
        here = (wa or {}).get("room") if isinstance(wa, dict) else None
        state = await engine.get_game_state(user=user)
        people = [str(h.get("name")) for h in ((state or {}).get("house") or []) if isinstance(h, dict) and h.get("name") and str(h.get("status") or "active") == "active"] if isinstance(state, dict) else []
        names = _season_room_names(user)
        ctx = {
            "pending_kind": kind or None,
            "required_lever": _ch._LAST_FRAMED_REQUIRED_LEVER.get(key),
            "social_hold": bool(_ch.veto_draw_holds_force(user or "") or _ch.event_pause_holds(user)),
            "room_names": names, "here": here, "people": people,
            "sleep_ok": bool(_player_means_going_to_bed(text) and _bedtime_board_allows(status)),
        }
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
                r = await engine.resolve_player_move(f"I look for {args['who']}.", f"actfirst-search:{msgid}", user=user)
                ok = isinstance(r, dict) and bool(r.get("search") or r.get("playerMove"))
            if not ok:
                blocked.append(act)
                notes.append(f"The player's {tool} was BLOCKED by the game: voice that in the fiction.")
            af.note_commit(tool, ok)
            done.append((tool, args, ok))
        # the engine's other text resolvers still run; the move / bed / search text parses are the model's now. Skipped when the model's own commit already ran the real text.
        extra = {"previous_reply": previous_reply} if previous_reply else {}
        await engine.resolve_player_move(text, f"move:{client_msg_id}" if client_msg_id else None, user=user, skip=["move", "bed"], **extra)
        af.put_stash(key, {"outcome": outcome, "text": text, "done": done, "pending": pending, "blocked": blocked, "notes": notes})
        return True
    except Exception as exc:
        try:
            from src import log_rings
            log_rings.record_soft_failure("act-first:slot-failed", exc, corrected="the ordinary move parser runs", user=user)
        except Exception:  # failsoft-ok: the recorder itself is down
            logger.warning("[orwell] act-first slot failed (fail-soft): %s", exc)
        return False
