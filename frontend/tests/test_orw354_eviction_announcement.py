"""ORW-354 - eviction night: the narrator's announcement of the ENGINE'S OWN committed evictee must never be stripped, and a scene-circuit-breaker halt
must never leave the player's bubble inside an open quote / bold span.

Live run 2026-11-14 (rehearsal 22:21): at the result / goodbye stage the engine had already decided `eviction.evictee` (the one-turn reveal pre-resolves it),
but `evictedNames` had not moved yet, so the role-claim guard read the true announcement as "evictee uncommitted or different" and stripped it; the scene
then halted at the next sentence boundary mid-quote, leaving a stray `**"`. Roles only - the names below are synthetic."""
import importlib

rc = importlib.import_module("src.role_claims")
agent_loop = importlib.import_module("src.agent_loop")

ROSTER = ["Hoh Person", "Nom Alpha", "Nom Beta", "Other Delta"]
ANNOUNCE = ('The ballots are all in.\n\nProduction\'s voice fills the living room, flat and final.\n\n'
            '**"Nom Alpha - you are evicted from the Big Brother house."**\n\nThe room goes still.\n')


def sig(**kw):
    base = {"phase": "eviction", "activeNames": list(ROSTER), "evictedNames": [], "playerName": "Player Epsilon", "hohName": "Hoh Person",
            "vetoHolderName": None, "nomNames": ["Nom Alpha", "Nom Beta"], "playerStatus": "active", "evictionBallots": 13, "pending": None}
    base.update(kw)
    return base


def test_a_announcement_of_the_engines_committed_evictee_is_emitted_whole():
    s = sig(evictionEvictee="Nom Alpha")  # committed by the pre-resolve; evictedNames has not moved yet
    kept, out, _ = rc.screen_role_units(ANNOUNCE, s, None)
    assert kept == ANNOUNCE and not out


def test_a_goodbye_stage_farewell_naming_the_committed_evictee_is_emitted_whole():
    t = 'Production: **"Nom Alpha, say your goodbyes."**\n'
    kept, out, _ = rc.screen_role_units(t, sig(evictionEvictee="Nom Alpha"), None)
    assert kept == t and not out


def test_b_a_different_houseguest_than_the_committed_evictee_is_still_stripped():
    kept, out, _ = rc.screen_role_units(ANNOUNCE.replace("Nom Alpha", "Nom Beta"), sig(evictionEvictee="Nom Alpha"), None)
    assert "Nom Beta" not in kept and out and "evictee uncommitted or different" in out[0]["reason"]


def test_b_negative_control_no_committed_evictee_still_strips_the_announcement():
    kept, out, _ = rc.screen_role_units(ANNOUNCE, sig(), None)
    assert "Nom Alpha" not in kept and out


def test_c_close_open_markup_closes_a_quote_and_bold_left_open():
    t = 'Production\'s voice fills the room.\n\n**"The ballots are read.'
    assert agent_loop.close_open_markup(t) == '"**'
    t2 = t + agent_loop.close_open_markup(t)
    assert t2.count("**") % 2 == 0 and t2.count('"') % 2 == 0
    assert agent_loop.close_open_markup('A “quote that opens') == "”"
    assert agent_loop.close_open_markup('**"Done."** She nods.') == ""
    assert agent_loop.close_open_markup("") == ""


def test_c_a_halted_round_persists_balanced_text():
    emitted = 'The room waits.\n\n**"The ballots are read.'
    out = agent_loop._persisted_round_text("ignored", scene_broken=True, scrub_active=True, round_emitted=emitted)
    assert out.count("**") % 2 == 0 and out.count('"') % 2 == 0 and out.startswith(emitted)
    # idempotent: a live-closed round persists unchanged
    closed = emitted + '"**'
    assert agent_loop._persisted_round_text("x", scene_broken=True, scrub_active=True, round_emitted=closed) == closed
