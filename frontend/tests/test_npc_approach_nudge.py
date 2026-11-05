"""NPC approaches come through CHAT, never a notification panel (owner ruling 2026-06-18).

The player-facing "Wants a word" surface was removed because an NPC wanting to connect is in-fiction
intent — it must reach the player through the dialogue (the GM voices the approach), not a UI panel
that hands NPCs a one-way notification advantage. To keep the social life alive without the panel, the
agent loop nudges the GM to voice an organic approach in the LINGERING window (a lull that hasn't gone
stale enough to advance the week). The scene that follows is real social play that folds into the
hidden weights (the consequence loop) — so the approach is recorded, never just narrated.
"""

import importlib

al = importlib.import_module("src.agent_loop")


def test_approach_nudge_voices_an_organic_in_chat_approach():
    nudge = al._approach_nudge("Cynthia Hawkins", "bond")
    # Names the houseguest and frames THEM coming to the player (not the player reaching out).
    assert "Cynthia Hawkins" in nudge
    assert "drift over" in nudge.lower() or "start the scene" in nudge.lower()
    # NPCs play their own game / come to the player.
    assert "own game" in nudge.lower()
    # The intent/motive is NEVER announced to the player out of character.
    assert "never name a motive" in nudge.lower() or "do not" in nudge.lower()
    # The scene must be recorded so it moves the weights (consequence loop).
    assert "recordInteraction" in nudge


def test_approach_nudge_shades_by_motive_without_naming_it():
    bond = al._approach_nudge("A", "bond")
    probe = al._approach_nudge("A", "probe")
    neutral = al._approach_nudge("A", None)
    # The manner differs by motive (the GM voices it differently), and an unknown motive still works.
    assert bond != probe and neutral
    # The motive is shaded as plain MANNER words, never surfaced as a labelled enum value.
    assert '"bond"' not in bond and '"probe"' not in probe
    assert "motive:" not in (bond + probe).lower()


def test_approach_nudge_is_wired_into_the_lingering_window():
    import os
    js = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "src", "agent_loop.py"), encoding="utf-8").read()
    # Fires only in the lingering window: a lull that is NOT progressed and NOT yet stale.
    gates = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "agent_gates.py"), encoding="utf-8").read()  # A60: the gate lives in agent_gates.py now
    assert "is_lull and (not progressed) and (not stale)" in gates
    assert "turn_approach_nudges < max_approach_nudges" in gates
    assert "_want_approach = _gates.want_approach(" in js
    # Folded into the same fetch gate, and only on an advance-eligible (social) phase — but NOT the
    # staged finale (#670 added "finale" to _ADVANCE_PHASES for the backstop only; the finale is a
    # one-beat-per-turn reveal, not a lingering window, so an approach there is excluded).
    assert "or _want_approach or _want_reapproach:" in js
    assert "if _want_approach and _phase in _ADVANCE_PHASES and _phase != \"finale\":" in js
    # Reads the GM-only socialInitiatives lever (the same intent the panel used to leak to the player).
    assert "_oe2.social_initiatives(owner)" in js
    assert "await _approach_nudge" not in js  # it is a plain string builder, not a coroutine
    assert "_approach_nudge(_name, _top.get(\"motive\"))" in js


def test_approach_nudge_honors_one_narration_per_turn():
    """The approach nudge must NOT re-prompt a SECOND scene once the player has already been shown
    one this turn (the duplicate/overlapping bedroom-scene bug). It must carry the SAME
    `_emitted_visible` suppression the advance ladder honors — a second re-prompt appends a second
    narration to the same message, so the player sees two scenes concatenated."""
    import os
    js = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "src", "agent_loop.py"), encoding="utf-8").read()
    # The gate excludes a turn that already showed a scene (mirrors the advance nudge's guard).
    gates = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "agent_gates.py"), encoding="utf-8").read()  # A60
    assert "and (not emitted_visible)" in gates, \
        "_want_approach must suppress when a scene was already shown this turn"
    # It is folded into the SAME _want_approach gate (not a separate, bypassable check).
    gate_start = gates.index("def want_approach(")
    gate_block = gates[gate_start:gate_start + 400]
    assert "(not emitted_visible)" in gate_block, \
        "the _emitted_visible guard must live inside the _want_approach gate"


def test_no_player_facing_initiatives_route_or_panel_remains():
    """The intent must not reach the player through any route/panel — only chat."""
    import os
    fe = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    routes = open(os.path.join(fe, "routes", "orwell_routes.py"), encoding="utf-8").read()
    assert '@router.get("/initiatives")' not in routes, "the player-facing initiatives route must be gone"
    assert not os.path.exists(os.path.join(fe, "static", "js", "orwellSocial.js")), \
        "the 'Wants a word' panel must be deleted"
    index = open(os.path.join(fe, "static", "index.html"), encoding="utf-8").read()
    assert "orwellSocial.js" not in index, "the panel script tag must be removed"
