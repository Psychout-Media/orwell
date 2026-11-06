"""Gateway consequence fold — the multi-platform gateway's counterpart to the streaming agent
loop's 0055 ``_auto_record_scene`` belt (2026-07-22 repo gap audit, finding G1).

THE BUG THIS CLOSES. Every player turn taken through the gateway (feature 0072 — Telegram/Discord
etc., ``gateway/handler.py::_call_player_turn``) called only READ engine tools
(``getGameState``/``getMomentPrompt``), narrated, and returned — never ``recordInteraction``, never
any other mutating tool. That silently bypassed the whole consequence/memory loop (mandate #4 /
feature 0023, "never ship an action that is narrated but never recorded") for an entire live client
surface, AND — because ``recordInteraction`` is the ONLY mutating call in this path — meant
``Orchestrator.commitPlayerTurn``'s per-turn bounded off-screen tick (the seam every mutating tool
rides via ``EngineCommandsAdapter``'s ``onPersist`` → ``registry.commit`` →
``orchestrator.commitPlayerTurn``, wired in ``src/composition/runtime.ts``'s
``registry.setCommit(...)``) never fired either, freezing the off-screen society for gateway-only
players.

THE FIX. ``handler.py`` calls :func:`fold_gateway_turn` once, after narration, with the player's raw
message + the narrated reply + the live house roster. It is a deliberately self-contained MIRROR of
``_auto_record_scene``'s contract — it does NOT import ``frontend/src/agent_loop.py`` (locked
tonight, and importing the full streaming agent loop is exactly the weight the 0072 design
deliberately avoids for this lightweight HTTP-turn path):

  1. A constrained extraction call over the user's resolved UTILITY model, when one resolves,
     proposing ``{withIds, kind, content}`` — model-proposed SHAPE only (ADR 0005: direction/
     participants/kind), never a magnitude; the engine alone decides how far anything moves.
  2. Failing that (no model configured, or the extraction call/parse fails), a DETERMINISTIC FLOOR:
     a kind-less ``recordInteraction`` naming whichever houseguests the turn's own text actually
     names, intersected with the engine's own live presence read when available — never invented.

Witness-set discipline (E21/BL-014 in ``EngineCommandsAdapter.recordInteraction``): the engine
itself is the final authority on who witnessed what — this module only PROPOSES a witness set, and
proposes the MINIMAL SAFE one it can derive from real turn context, never a guess.

Fail-soft, never SILENT (#1599): every genuine failure here is WARN-logged AND recorded via
``log_rings.record_soft_failure`` (RED-eligible on ``/admin/status`` — a correction is not a cloak).
A turn with nothing recordable (a solo/idle beat, non-diegetic text) is not a failure and returns
``False`` without any record.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Optional

logger = logging.getLogger(__name__)

# Mirrors agent_loop._auto_record_scene's kind vocabulary exactly (src/ports/GameSession.ts's
# RecordInteractionReq.kind enum) — an unrecognized kind is treated as "no kind proposed" (the
# ADR 0005 floor), never invented.
_RECORD_KINDS = {"bonding", "betrayal", "conflict", "strategy", "alliance", "gossip", "showmance"}

# #1729's nondiegetic gate, mirrored: an ((double-parenthesized)) or "ooc:"-prefixed aside is the
# out-of-character convention momentPrompts.ts documents for the narrator's own asides — never a
# witnessed world event, on either the player's message or the narration.


def _is_nondiegetic(text: Optional[str]) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    from src.ooc_aside import is_aside_only  # the shared span-based detector
    return is_aside_only(t)


def _living_house_names(house: list) -> list:
    return [h.get("name") for h in house
            if isinstance(h, dict) and h.get("name") and h.get("status", "active") == "active"]


def _scene_touched_house(narration: str, message_text: str, house_names: list) -> bool:
    """Cheap name-based gate (mirrors ``agent_loop._scene_touched_houseguest``): true only when the
    player's own message or the narration actually names a living houseguest — tells a real social
    scene from a solo/idle/no-op gateway ping, so a trivial message never folds a consequence onto
    nobody."""
    if not house_names:
        return False
    hay = f"{narration or ''} {message_text or ''}".lower()
    if not hay.strip():
        return False
    for name in house_names:
        if not name:
            continue
        n = name.lower()
        if n in hay:
            return True
        first = n.split(" ")[0]
        if len(first) >= 3 and re.search(r"\b" + re.escape(first) + r"\b", hay):
            return True
    return False


def _match_ids_by_name(text: str, house: list) -> list:
    """Name-match the live roster against ``text``, returning canonical engine ids — the
    deterministic floor's participant resolution. Never invents a participant: a name absent from
    the roster is never matched."""
    out: list = []
    hay = (text or "").lower()
    for h in house:
        if not isinstance(h, dict):
            continue
        hid, name = h.get("id"), h.get("name")
        if not hid or not name or h.get("status", "active") != "active":
            continue
        n = name.lower()
        first = n.split(" ")[0]
        if n in hay or (len(first) >= 3 and re.search(r"\b" + re.escape(first) + r"\b", hay)):
            out.append(hid)
    return out


def _normalize_with_ids(raw, valid_ids) -> list:
    """Normalize a model-proposed ``withIds`` list to canonical roster ids (mirrors
    ``agent_loop._normalize_with_ids``) — anything that does not resolve to a living roster id is
    DROPPED, never guessed at."""
    out: list = []
    if not isinstance(raw, list):
        return out
    seen = set()
    for entry in raw:
        cand = None
        if isinstance(entry, str):
            s = entry.strip()
            if s in valid_ids:
                cand = s
            elif re.fullmatch(r"\d+", s) and f"npc:{s}" in valid_ids:
                cand = f"npc:{s}"
        elif isinstance(entry, int) and not isinstance(entry, bool):
            probe = f"npc:{entry}"
            if probe in valid_ids:
                cand = probe
        if cand is not None and cand not in seen:
            seen.add(cand)
            out.append(cand)
    return out


def _last_json_object_with_key(raw: str, key: str) -> Optional[dict]:
    """A minimal brace-balanced scan for the LAST JSON object in ``raw`` carrying ``key`` — a
    reasoning model may emit prose before, or entirely instead of, the bare answer. Self-contained
    (mirrors the helper of the same name in ``agent_loop.py`` without importing that module)."""
    if not raw:
        return None
    starts = [m.start() for m in re.finditer(r'\{\s*"' + re.escape(key) + r'"', raw)]
    for start in reversed(starts):
        depth = 0
        for i in range(start, len(raw)):
            if raw[i] == "{":
                depth += 1
            elif raw[i] == "}":
                depth -= 1
                if depth == 0:
                    candidate = raw[start:i + 1]
                    try:
                        obj = json.loads(candidate)
                    except Exception:
                        break
                    if isinstance(obj, dict) and key in obj:
                        return obj
                    break
    return None


async def _extract_via_model(user: str, message_text: str, narration: str, roster_line: str,
                             valid_ids: set) -> Optional[tuple]:
    """A constrained extraction call over the user's resolved utility model, structurally identical
    to 0055's ``_auto_record_scene`` contract (``{withIds, kind, content}``) but self-contained.

    Returns ``(with_ids, kind, content)`` or ``None`` — either nothing usable was proposed (no model
    configured, a solo/idle beat) or the call/parse genuinely failed (WARN-logged + RED-recorded
    here; the caller falls back to the deterministic floor, so this is an auto-corrected fault, not
    a lost scene)."""
    try:
        from src.orwell_cast_authoring import _resolve_llm_fn
        llm_fn = await _resolve_llm_fn(user)
        if llm_fn is None:
            return None  # no usable model configured — expected-empty, not a failure
        messages = [
            {"role": "system", "content":
                "Extract the recordable consequence of a Big Brother scene the player just had "
                "with other houseguests over a messaging platform. Reply IMMEDIATELY with ONLY a "
                "JSON object — no analysis, no prose, no code fence:\n"
                '{"withIds":[<ids of houseguests the player actually interacted WITH, from the '
                'roster>],"kind":"<one of: bonding, betrayal, conflict, strategy, alliance, '
                'gossip, showmance>","content":"<one concise past-tense sentence of what passed '
                'between them>"}\n'
                'If no houseguest was genuinely engaged (a solo/idle beat), reply {"withIds":[]}.'},
            {"role": "user", "content":
                f"ROSTER (id = name):\n{roster_line}\n\nTHE PLAYER'S MESSAGE:\n"
                f"{(message_text or '')[:800]}\n\nWHAT HAPPENED:\n{(narration or '')[:1500]}\n\n"
                "JSON:"},
        ]
        raw = await llm_fn(messages)
    except Exception as exc:
        logger.warning("gateway: consequence extraction call failed for user %s: %s", user, exc)
        from src import log_rings
        log_rings.record_soft_failure("gateway:extraction-call-failed", exc,
                                      corrected="deterministic-floor", user=user)
        return None

    if isinstance(raw, dict):
        raw = raw.get("content") or raw.get("text") or ""
    raw_text = raw if isinstance(raw, str) else str(raw or "")

    obj = _last_json_object_with_key(raw_text, "withIds")
    if obj is None:
        return None
    ids = _normalize_with_ids(obj.get("withIds"), valid_ids)
    if not ids:
        return None
    kind = obj.get("kind") if obj.get("kind") in _RECORD_KINDS else None
    content = (obj.get("content") or "").strip() or None
    return ids, kind, content


async def fold_gateway_turn(user: str, message_text: str, narration: str, house: list) -> bool:
    """Best-effort, bounded consequence fold for one gateway turn (mandate #4 / feature 0023's
    "never ship an action that is narrated but never recorded", mirroring 0055's
    ``_auto_record_scene`` belt without importing the full streaming agent loop).

    Returns ``True`` when an interaction was recorded, ``False`` when there was nothing recordable
    (a solo/idle beat, non-diegetic text, or a genuine failure) — never raises.

    The ``recordInteraction`` call this makes is a MUTATING engine tool, so by construction it fires
    ``Orchestrator.commitPlayerTurn``'s per-turn bounded off-screen tick server-side — the same
    commit funnel every other mutating tool rides (``EngineCommandsAdapter.recordInteraction``'s own
    ``onPersist`` → ``GameSessionRegistry.commit`` → ``orchestrator.commitPlayerTurn``, wired in
    ``src/composition/runtime.ts``'s ``registry.setCommit(...)``) — which the prior read-only turn
    never triggered.

    Fail-soft, never silent (#1599): a genuine failure here is WARN-logged AND recorded via
    ``log_rings.record_soft_failure`` (RED-eligible on ``/admin/status``) before returning ``False``.
    """
    try:
        if _is_nondiegetic(message_text) or _is_nondiegetic(narration):
            return False
        house = house or []
        house_names = _living_house_names(house)
        if not _scene_touched_house(narration, message_text, house_names):
            return False  # a solo/idle beat — nothing recordable, not a failure

        valid_ids = {h.get("id") for h in house if isinstance(h, dict) and h.get("id")}
        roster_line = "\n".join(f'{h.get("id")} = {h.get("name")}' for h in house
                                if isinstance(h, dict) and h.get("id") and h.get("name"))

        from src import orwell_engine as _oe

        # Resolve the minimal-safe witness set from ENGINE whereabouts when available — never
        # invented from prose alone (mirrors #1730's presence-filter in agent_loop). A read hiccup
        # fails OPEN (proceeds without the presence filter) so a transient read blip can never zero
        # the whole consequence-recording safety net — but it is still WARN-logged + RED-recorded
        # (auto-corrected), never silent.
        present_ids: Optional[set] = None
        try:
            wb = await _oe.whereabouts(user=user)
            if isinstance(wb, dict):
                present_ids = {p.get("id") for p in (wb.get("present") or [])
                              if isinstance(p, dict) and p.get("id")}
        except Exception as exc:
            logger.warning("gateway: whereabouts read failed for user %s, proceeding without a "
                          "presence filter: %s", user, exc)
            from src import log_rings
            log_rings.record_soft_failure("gateway:whereabouts-read-failed", exc,
                                          corrected="fail-open-presence-filter", user=user)
            present_ids = None

        with_ids: list = []
        kind: Optional[str] = None
        content: Optional[str] = None

        extracted = await _extract_via_model(user, message_text, narration, roster_line, valid_ids)
        if extracted is not None:
            with_ids, kind, content = extracted
            if present_ids is not None:
                with_ids = [i for i in with_ids if i in present_ids]

        if not with_ids:
            # No model, or the model proposed nothing usable — the deterministic floor: a
            # kind-less fold (ADR 0005's magnitude floor — "no descriptor ⇒ byte-identical fold")
            # naming whoever the turn's own text actually names, intersected with live presence
            # when we have a read for it. Never invents a participant, never guesses a kind.
            named = _match_ids_by_name(f"{narration} {message_text}", house)
            with_ids = ([i for i in named if i in present_ids] if present_ids is not None else named)
            kind = None
            content = None
        if not with_ids:
            return False  # nobody the engine can name as present/addressed — nothing to fold onto

        content = (content or (message_text or "").strip()[:400]
                  or "The player had a scene with a houseguest.")

        result = await _oe.record_interaction(content[:400], with_ids=with_ids, kind=kind,
                                              idempotency_key=uuid.uuid4().hex, user=user)
        logger.info("gateway: folded consequence (with=%s, kind=%s) user=%s", with_ids, kind, user)
        from src import log_rings
        log_rings.record_overseer(
            "action", "gateway-consequence-fold",
            f"folded a gateway scene (with={len(with_ids)} houseguest(s), kind={kind or 'floor'})",
            lever="gateway-record", ok=True, user=user)
        return bool(result)
    except Exception as exc:
        logger.warning("gateway: consequence fold failed for user %s: %s", user, exc)
        from src import log_rings
        log_rings.record_soft_failure("gateway:consequence-fold-failed", exc, user=user)
        return False
