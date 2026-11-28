"""B66 — the augment-not-replace guard (ADR 0003 §4), structurally.

UI may AUGMENT the chat but never REPLACE a game-building interaction: no front-end UI
route/control may reach a game-PROGRESSING engine action except the two sanctioned,
explicitly-confirmed paths — the decision route (the C20 confirm card posts the player's
selection engine-direct) and the new-game route (guarded by a 409 unless confirm=true).
Everything else progressing belongs to the AGENT path (src/tool_implementations.py),
where the model acts inside the conversation. This mirrors the engine's dependency-cruiser
Vault rule at the front-end layer: a registry/source assertion, not a convention.
"""

import os
import re

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Engine-client calls that PROGRESS the game (vs. read-only projections).
PROGRESSING = [
    "advance_game", "submit_decision", "create_character", "update_casting",
    "make_deal", "record_interaction", "surface_information",
]

# The sanctioned commitment paths (file, function-name marker, required guard marker).
# The first two are the UI confirm paths; the third is NOT a UI control at all — it is the
# E22 turn-integrity guard ("narrated but never recorded" enforced in code): on a COMPLETED
# agent game turn with non-trivial narration and zero engine writes, the server folds a
# bounded digest of the conversation that just happened into the record. It records the
# conversation; it never replaces one (ADR 0003 §4 intact), and it never advances the week.
# Its guard marker is the zero-engine-writes precondition set.
SANCTIONED = {
    # submit_decision has TWO sanctioned confirm sites: the HTTP /decision route (the C20 confirm card)
    # and the socket-native `decision` up-frame (WS Phase-1 §3.5). Both post the player's EXPLICIT
    # selection engine-direct with the same `_DECISION_KINDS` legality gate, so prose can never bind
    # through either — the WS just swaps the pipe under the identical confirm contract.
    "submit_decision": [
        ("routes/orwell_routes.py", "orwell_decision", "_DECISION_KINDS"),
        ("routes/ws_routes.py", "_handle_decision", "_DECISION_KINDS"),
    ],
    "create_character": ("routes/orwell_routes.py", "orwell_new_game", "409"),
    "record_interaction": ("routes/chat_helpers.py", "ensure_turn_recorded", "GAME_ENGINE_WRITE_TOOLS"),
    # C-02 (engine bypass): pre-resolving an NPC-driven ceremony is a sanctioned FE-side
    # progression. It resolves a beat the player is NOT part of (the pending gate guarantees no
    # player decision is pending) so the model voices the engine's REAL outcome instead of
    # inventing one. It never touches a player decision and never replaces a player interaction
    # (ADR 0003 §4 intact); it only error-corrects the model's documented engine bypass. Its guard
    # marker is the ceremony-phase allowlist that scopes the advance.
    # F14 (#1013): a SECOND sanctioned advance site — the decision route. After the player's
    # goodbye-message is submitted ENGINE-DIRECT (the C20 confirm path), submitDecision returns only
    # the goodbye beat; the engine still owes `goodbye → eviction-result → rollWeek`, and the model
    # reliably under-calls that delivery, wedging the week. The follow-up advance DELIVERS the result
    # of a decision the player JUST CONFIRMED on the sanctioned path — it never resolves a NEW player
    # decision (gated on no new player pending) and never replaces a player interaction (ADR 0003 §4
    # intact). Its guard marker is that goodbye-scoped gate. `advance_game` therefore has TWO
    # sanctioned sites; the guard accepts a list.
    "advance_game": [
        ("routes/chat_helpers.py", "_pre_resolve_npc_ceremony", "_CEREMONY_RESOLVE_PHASES"),
        ("routes/orwell_routes.py", "orwell_decision", "_pending_is_player"),
    ],
    # 0065 (cast photo as casting step #1): the /casting/photo route records ONLY the player's
    # photo-step marker (castPhoto uploaded/skipped). The photo box is a FE-only affordance the
    # narration model cannot observe, so the FE must mark the outcome — it augments, never replaces
    # (the model still runs the whole interview and records every substantive answer) and never
    # advances the week (castPhoto does not gate `ready`). Its guard marker is the status allowlist.
    # ORW-1126 (Ryne's prod casting, 2026-11-28): a SECOND site records the SAME photo-step marker - a photo the player already has on file (the account photo survives a new-season scrub)
    # is recorded as castPhoto "uploaded" before the casting prompt is read, so the producer never asks for it again. It writes only that marker, only while the status still asks for
    # the photo, and never advances the week. Its guard marker is the one-field allowlist it writes.
    "update_casting": [
        ("routes/orwell_routes.py", "orwell_casting_photo", "_CAST_PHOTO_STATUSES"),
        ("routes/chat_helpers.py", "apply_game_framing", "_CARRIED_PHOTO_FIELDS"),
    ],
}


def _route_files():
    root = os.path.join(FRONTEND, "routes")
    for name in sorted(os.listdir(root)):
        if name.endswith(".py"):
            yield name, open(os.path.join(root, name), encoding="utf-8").read()


def test_progressing_actions_reach_routes_only_through_sanctioned_confirm_paths():
    for fname, src in _route_files():
        for action in PROGRESSING:
            hits = [m.start() for m in re.finditer(rf"orwell_engine\.{action}\(", src)]
            if not hits:
                continue
            sanctioned = SANCTIONED.get(action)
            # An action may have ONE sanctioned site (a tuple) or SEVERAL (a list of tuples).
            sites = sanctioned if isinstance(sanctioned, list) else ([sanctioned] if sanctioned else [])
            site = next((s for s in sites if f"routes/{fname}" == s[0]), None)
            assert site, (
                f"routes/{fname} calls game-progressing orwell_engine.{action}() — UI must not "
                "progress the game outside the sanctioned confirm paths (ADR 0003 §4)"
            )
            # The sanctioned path must still carry its explicit guard.
            assert site[2] in src, (
                f"the sanctioned {action} path lost its '{site[2]}' guard"
            )


def test_sanctioned_decision_path_validates_kinds_and_posts_engine_direct():
    src = open(os.path.join(FRONTEND, "routes", "orwell_routes.py"), encoding="utf-8").read()
    assert "_DECISION_KINDS" in src and "unknown decision kind" in src
    assert "confirm" in src and "409" in src  # the new-game guard stays honest


def test_static_js_never_calls_the_engine_directly():
    """The browser talks to /api/orwell/* routes only — never the engine's own transport."""
    root = os.path.join(FRONTEND, "static", "js")
    offenders = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if not name.endswith(".js"):
                continue
            src = open(os.path.join(dirpath, name), encoding="utf-8").read()
            # A fetch/XHR to the engine transport (its tool route or default port) is a bypass.
            if re.search(r"""fetch\([^)]*(player/call|admin/call|:8765)""", src):
                offenders.append(os.path.relpath(os.path.join(dirpath, name), FRONTEND))
    assert not offenders, f"static JS bypasses the FE routes to reach the engine: {offenders}"


def test_diary_room_route_is_not_treated_as_progressing():
    # The Diary Room is the player's OOC space (0013): it records knowledge, never advances the
    # week — it is deliberately NOT in the progressing set. Pin that classification here so a
    # future change that makes it progressing must revisit this guard.
    assert "diary_room" not in PROGRESSING
