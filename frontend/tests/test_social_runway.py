"""The SOCIAL RUNWAY — the "never fast-forward through ceremonies" fix.

Owner playtest verdict (the defect this proves fixed): "It should never fast forward in the game…
it skips all of the social narrative gameplay and advances straight to nominations… There is zero
social opportunity. This is a critical failure."

Root cause: the C-02 pre-resolve advanced ONE engine beat per turn whenever no player decision was
pending, so for a spectator player the chain HOH → noms → veto → eviction marched with no social
turns between ceremonies. The fix holds a SOCIAL RUNWAY of player turns after each ceremony lands
the player in a new spectator beat — overriding the moment to the engine's own `social` beat and
NOT advancing — until the runway is spent (or the player asks to move on). Pacing only: the engine
still decides every outcome; we never invent content, we just stop skipping the player's turns.
"""

import asyncio
import importlib

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def _clear_runway():
    chat_helpers.clear_social_runway("u")
    chat_helpers.consume_pre_resolved_advance("u")
    yield
    chat_helpers.clear_social_runway("u")
    # the pre-resolve these tests drive directly marks the #670 one-shot flag that the agent loop would
    # consume in a real turn; leaving it set made a later test's turn for the same owner skip its advance
    chat_helpers.consume_pre_resolved_advance("u")
    chat_helpers.clear_preresolve_debt("u")


class _Engine:
    """A tiny scripted live engine: advancing walks phases for a SPECTATOR player (never a pending),
    so the test exercises exactly the force-march case the runway protects. `week`/`phase` change on
    advance so the `(week:phase)` runway signature is realistic."""

    # A spectator's week as the pre-resolve would drive it, one ceremony per advance.
    _CHAIN = ["hoh-competition", "nominations", "veto-competition", "veto-ceremony", "eviction"]

    def __init__(self, start="nominations", pending=None):
        self.week = 1
        self.phase = start
        self.pending = pending
        self.advances = 0

    def state(self):
        return {"started": True, "week": self.week, "phase": self.phase, "moment": self.phase}

    async def game_status(self, user=None):
        return {"phase": self.phase, "pending": self.pending, "week": self.week}

    async def get_game_state(self, user=None, **kw):
        return self.state()

    async def advance_game(self, expected_beat_seq=None, idempotency_key=None, user=None):
        # 0065 Part A/B: the FE-issued pre-resolve now threads the optional sync-spine fields.
        self.advances += 1
        i = self._CHAIN.index(self.phase) if self.phase in self._CHAIN else -1
        nxt = self._CHAIN[i + 1] if 0 <= i < len(self._CHAIN) - 1 else self.phase
        self.phase = nxt
        return {"event": {"content": f"resolved into {nxt}"}}

    def wire(self, monkeypatch):
        monkeypatch.setattr(orwell_engine, "game_status", self.game_status)
        monkeypatch.setattr(orwell_engine, "get_game_state", self.get_game_state)
        monkeypatch.setattr(orwell_engine, "advance_game", self.advance_game)
        return self


def _pre(eng, *, player_msg=None):
    return _run(chat_helpers._pre_resolve_npc_ceremony(
        "u", eng.state(), retry=False, player_msg=player_msg))


# ── The core guarantee: a resolved ceremony is FOLLOWED by social turns, not the next ceremony ──

# NB (#1127): these three exercise the ARM-ON-ADVANCE path (the pre-resolve drives a ceremony and lands
# the player in the NEXT spectator beat, where it arms a runway). They start at `veto-ceremony` — a
# pending-free spectator ceremony that is NOT a LANDED-runway phase — because `nominations` is now itself
# HELD on landing (the crown→nominations gap, covered by its own tests below), which would otherwise mask
# the arm-on-advance behavior these tests target. The asserted property (resolve-for-real → social runway
# → drive once spent, never force-march) is identical; only the start beat moved off the held one.
def test_a_resolved_ceremony_arms_a_social_runway_instead_of_marching_on(monkeypatch):
    eng = _Engine(start="veto-ceremony").wire(monkeypatch)
    out = _pre(eng)
    # The ceremony resolved for real (C-02 preserved — the engine decides, not the model)…
    assert eng.advances == 1, "the pending-free ceremony is resolved for real"
    # …but the very next turn is framed as SOCIAL play, not driven straight into the next ceremony.
    assert out.get("moment") == "social", "the player gets a social beat after the ceremony resolves"


def test_the_runway_holds_the_next_ceremony_for_social_turns(monkeypatch):
    eng = _Engine(start="veto-ceremony").wire(monkeypatch)
    _pre(eng)                       # resolves veto-ceremony → arms a runway at eviction
    advances_after_first = eng.advances
    # The next two turns must HOLD — social opportunity, no further advance.
    for _ in range(chat_helpers._SOCIAL_RUNWAY_TURNS):
        out = _pre(eng)
        assert out.get("moment") == "social", "still lingering — a social beat, not a ceremony"
    assert eng.advances == advances_after_first, "the runway did NOT march to the next ceremony"


def test_the_next_ceremony_drives_once_the_runway_is_spent(monkeypatch):
    eng = _Engine(start="veto-ceremony").wire(monkeypatch)
    _pre(eng)                       # resolve veto-ceremony → runway armed at eviction
    for _ in range(chat_helpers._SOCIAL_RUNWAY_TURNS):
        _pre(eng)                   # spend the runway (social holds)
    before = eng.advances
    _pre(eng)                       # runway spent → the next ceremony is driven for real
    assert eng.advances == before + 1, "after the social runway, the next ceremony resolves"


def test_no_force_march_across_multiple_ceremonies(monkeypatch):
    # Five consecutive spectator turns must NOT blow through the whole week. With a runway between
    # each ceremony, five turns resolve at most a couple of beats — not the entire HOH→eviction chain.
    eng = _Engine(start="nominations").wire(monkeypatch)
    for _ in range(5):
        _pre(eng)
    assert eng.advances <= 2, (
        f"five spectator turns force-marched {eng.advances} ceremonies — the social runway is not holding")


# ── Engagement, not a turn count: the player can cut the runway short ──

def test_player_readiness_cuts_the_runway_short(monkeypatch):
    eng = _Engine(start="nominations").wire(monkeypatch)
    _pre(eng)                       # resolve nominations → runway armed
    before = eng.advances
    # "let's see the veto" is an explicit move-on cue → the runway yields and the ceremony drives now.
    out = _pre(eng, player_msg="ok let's move on and see the veto")
    assert eng.advances == before + 1, "an explicit 'move on' cuts the runway and drives the ceremony"
    assert out.get("moment") != "social", "readiness ends the lingering"


def test_substantive_play_keeps_lingering(monkeypatch):
    eng = _Engine(start="nominations").wire(monkeypatch)
    _pre(eng)
    before = eng.advances
    # A long scheming message is ENGAGEMENT, never a lull — the runway keeps the player in the house.
    scheme = ("I pull the swing vote aside in the storage room and walk them through exactly why "
              "flipping on the HOH this week protects both of us long term, then go shore up my "
              "side alliance before anyone notices we talked.")
    out = _pre(eng, player_msg=scheme)
    assert eng.advances == before, "substantive social play does not advance the ceremony"
    assert out.get("moment") == "social", "the scheming player keeps their social beat"


# ── A player decision is NEVER held behind a runway ──

def test_a_pending_decision_clears_the_runway_and_never_holds(monkeypatch):
    eng = _Engine(start="nominations").wire(monkeypatch)
    _pre(eng)                       # arm a runway at veto-competition
    # Now the engine surfaces a player decision (e.g. the player drew a veto comp-intent).
    eng.pending = {"kind": "comp-intent"}
    before = eng.advances
    out = _pre(eng)
    assert eng.advances == before, "a pending is the player's card — never auto-resolved"
    assert out.get("moment") != "social", "the decision card leads; we do not override to social"
    # The runway was dropped so the turn after the decision drives the result, not another lull.
    assert chat_helpers._RUNWAY_LEFT.get("u", 0) == 0


# ── The staged eviction reveal is not held mid-reveal (E12) ──

def test_staged_eviction_reveal_is_not_held_between_ballots(monkeypatch):
    # During the eviction reveal the phase STAYS `eviction` across advances (same signature), so the
    # runway never re-arms mid-reveal — the ballots tick one per turn as before (E12 staged reveal).
    class _Eviction(_Engine):
        async def advance_game(self, expected_beat_seq=None, idempotency_key=None, user=None):
            self.advances += 1
            return {"event": {"content": "a vote to evict <name>"}}  # phase stays `eviction`

    eng = _Eviction(start="eviction").wire(monkeypatch)
    # No runway armed for eviction yet, and the phase does not change → each turn ticks a ballot.
    for _ in range(3):
        _pre(eng)
    assert eng.advances == 3, "the staged eviction reveal advances one ballot per turn, never held"


# ── The reset path drops a stale runway ──

def test_clear_social_runway_drops_state():
    chat_helpers._arm_runway("u", "1:nominations")
    assert chat_helpers._RUNWAY_LEFT.get("u", 0) > 0
    chat_helpers.clear_social_runway("u")
    assert chat_helpers._RUNWAY_LEFT.get("u", 0) == 0
    assert "u" not in chat_helpers._RUNWAY_SIG


# ── #1127: the CROWN→NOMINATIONS gap — the player LANDS at `nominations` (an NPC won HOH) ──────────
#
# Root cause (evidence-backed, ENGINE is correct): when an NPC wins HOH the staged HOH comp completes
# through the player's OWN per-round decisions, so the engine transitions to phase=nominations via
# submitDecision — NOT via the pre-resolve's advance. The arm-on-advance path therefore never armed a
# window for the beat the player LANDED on, so the very first spectator turn pre-resolved the NPC noms
# off-screen (`s.beat → veto-competition`) with ZERO playable time to work the new HOH AND with the
# nomination ceremony never witnessed. The fix arms a runway ON LANDING at `nominations`, holds the
# post-HOH window, then drives the noms for real and frames the ceremony as a WITNESSED `nominations`
# beat. The player who landed at `nominations` is a SPECTATOR (no pending — an NPC is HOH).

def _spectator_at_noms(monkeypatch):
    """A spectator who has just landed at `nominations` because an NPC was crowned HOH (no pending)."""
    return _Engine(start="nominations", pending=None).wire(monkeypatch)


def test_landing_at_nominations_holds_the_post_hoh_window_first(monkeypatch):
    # THE bug: the FIRST spectator turn at `nominations` must NOT pre-resolve the NPC noms — it holds a
    # social window so the player can work the new HOH before the ceremony.
    eng = _spectator_at_noms(monkeypatch)
    out = _pre(eng)
    assert eng.advances == 0, "the NPC nominations must NOT be pre-resolved on the first spectator turn"
    assert out.get("moment") == "social", "the player gets their post-HOH social window first (#1127)"
    # the HUD's real phase is untouched — only the narration moment is overridden
    assert out.get("phase") == "nominations"


def test_landing_at_nominations_guarantees_playable_turns_before_noms_drive(monkeypatch):
    # A bounded run of guaranteed playable turns to work the new HOH, then the noms drive for real.
    eng = _spectator_at_noms(monkeypatch)
    held = 0
    drove_at = None
    for i in range(chat_helpers._SOCIAL_RUNWAY_TURNS + 2):
        out = _pre(eng)
        if eng.advances == 0:
            held += 1
            assert out.get("moment") == "social", "still holding the post-HOH window"
        else:
            drove_at = i
            break
    assert held >= 1, "there must be at least one guaranteed playable social turn before the NPC noms drive"
    assert drove_at is not None, "the noms must eventually be driven for real once the window is spent"


def test_the_npc_nomination_ceremony_is_framed_as_a_witnessed_beat(monkeypatch):
    # Once the post-HOH window is spent and the noms are driven for real, the player must WITNESS the
    # ceremony: the turn that resolved the NPC noms is framed on the `nominations` moment (not skipped to
    # the veto), so the model PLAYS the ceremony with the engine's real nominees.
    eng = _spectator_at_noms(monkeypatch)
    out = None
    for _ in range(chat_helpers._SOCIAL_RUNWAY_TURNS + 2):
        out = _pre(eng)
        if eng.advances >= 1:
            break
    assert eng.advances == 1, "exactly the NPC nominations beat was driven for real"
    assert out.get("moment") == "nominations", (
        "the player WITNESSES the nomination ceremony as its own beat — not fast-forwarded to the veto")
    # the engine (not the FE) decided the nominees; the HUD's real phase has moved to the veto comp
    assert out.get("phase") == "veto-competition"


def test_readiness_at_nominations_still_witnesses_the_ceremony(monkeypatch):
    # 'let's see the noms' cuts the social window short — but the player still WITNESSES the ceremony beat
    # (readiness means "show me the noms NOW", which is the ceremony, never a skip past it).
    eng = _spectator_at_noms(monkeypatch)
    out = _pre(eng, player_msg="ok let's see the nominations")
    assert eng.advances == 1, "readiness drives the noms now (no extended lull)"
    assert out.get("moment") == "nominations", "the player still witnesses the ceremony, not a skip past it"


def test_no_force_march_past_the_nomination_ceremony(monkeypatch):
    # The whole-week guard for the landing case: several spectator turns from `nominations` must HOLD the
    # window, then play the ceremony — never blow through nominations → veto in one steamroll.
    eng = _spectator_at_noms(monkeypatch)
    moments = [(_pre(eng)).get("moment") for _ in range(chat_helpers._SOCIAL_RUNWAY_TURNS + 1)]
    assert moments.count("social") >= 1, "the post-HOH window held at least one social turn"
    assert "nominations" in moments, "the nomination ceremony was played as a witnessed beat"
    assert eng.advances <= 1, (
        f"the landing case force-marched {eng.advances} beats — only the noms should have driven")


def test_clear_social_runway_drops_the_landed_done_marker(monkeypatch):
    # The new `_RUNWAY_LAST_DONE` marker (#1127) must be dropped on reset, like the rest of the runway
    # state — a fresh season/landing re-arms cleanly instead of treating the beat as already-lingered.
    eng = _spectator_at_noms(monkeypatch)
    # spend the window so the beat gets marked done
    for _ in range(chat_helpers._SOCIAL_RUNWAY_TURNS + 2):
        _pre(eng)
        if eng.advances >= 1:
            break
    assert chat_helpers._RUNWAY_LAST_DONE.get("u") is not None, "the lingered-through beat was marked done"
    chat_helpers.clear_social_runway("u")
    assert "u" not in chat_helpers._RUNWAY_LAST_DONE, "reset drops the #1127 lingered-through marker"


# ── #1127 hardening: the runway must arm + HOLD even when `user is None` (AUTH OFF) ─────────────────
#
# Root cause found LIVE: the FE-internal `user` is `None` under `AUTH_ENABLED=false` (the `x-orwell-user`
# header is ENGINE-isolation only, not FE auth). The post-HOH hold keyed its state directly on `user`,
# so with `user is None` the arm early-returned and the hold-block guarded on `if user is not None` —
# the hold went SILENTLY INERT and the montage returned (proven live: Run 1 montaged with user=None;
# Runs 2-3 with a real cookie user PASSED). The live-verify recipe (SOUL lesson 17) ALWAYS runs auth-off,
# so without these tests a future live-verify exercises a posture the suite never covered. The fix keys
# runway state via `_runway_key`, which collapses a `None` user onto a stable sentinel. These tests pin
# that the auth-off path behaves IDENTICALLY to the auth-on path (arm, hold, then drive once spent).

def _clear_anon():
    chat_helpers.clear_social_runway(None)


def _pre_anon(eng, *, player_msg=None):
    """Drive the pre-resolve with the AUTH-OFF identity (`user is None`)."""
    return _run(chat_helpers._pre_resolve_npc_ceremony(
        None, eng.state(), retry=False, player_msg=player_msg))


def test_runway_key_falls_back_to_a_stable_sentinel_when_user_is_none():
    # The keying primitive itself: a present user keys as-is; a None user keys a STABLE non-None sentinel.
    assert chat_helpers._runway_key("u") == "u", "a present user keys exactly as before"
    k1 = chat_helpers._runway_key(None)
    k2 = chat_helpers._runway_key(None)
    assert k1 is not None, "a None user must NOT key on None (that made the hold inert under auth-off)"
    assert k1 == k2, "the None fallback is stable across turns (single-user auth-off session)"


def test_arm_runway_arms_even_when_user_is_none():
    # Auth-off must not no-op the arm (it used to early-return on `user is None`).
    _clear_anon()
    try:
        chat_helpers._arm_runway(None, "1:nominations")
        assert chat_helpers._RUNWAY_LEFT.get(chat_helpers._runway_key(None), 0) > 0, (
            "the runway must arm under auth-off (user is None), not silently no-op")
    finally:
        _clear_anon()


def test_landing_at_nominations_holds_the_post_hoh_window_when_user_is_none(monkeypatch):
    # THE live-verify defect: the FIRST spectator turn at `nominations` under auth-off must HOLD the
    # post-HOH window (a social beat), NOT pre-resolve the NPC noms. Mirrors the auth-on test above with
    # `user is None` — the exact posture SOUL lesson 17's recipe runs in.
    _clear_anon()
    try:
        eng = _Engine(start="nominations", pending=None).wire(monkeypatch)
        out = _pre_anon(eng)
        assert eng.advances == 0, (
            "auth-off: the NPC nominations must NOT be pre-resolved on the first spectator turn")
        assert out.get("moment") == "social", (
            "auth-off: the player still gets their post-HOH social window first (#1127 hardening)")
        assert out.get("phase") == "nominations", "the HUD's real phase is untouched"
    finally:
        _clear_anon()


def test_runway_holds_then_drives_when_user_is_none(monkeypatch):
    # The full auth-off lifecycle: hold the bounded window, then drive the noms for real once spent —
    # identical to the auth-on guarantee, proving the hold is no longer inert when `user is None`.
    _clear_anon()
    try:
        eng = _Engine(start="nominations", pending=None).wire(monkeypatch)
        held = 0
        drove = False
        for _ in range(chat_helpers._SOCIAL_RUNWAY_TURNS + 2):
            out = _pre_anon(eng)
            if eng.advances == 0:
                held += 1
                assert out.get("moment") == "social", "auth-off: still holding the post-HOH window"
            else:
                drove = True
                break
        assert held >= 1, "auth-off: at least one guaranteed playable social turn before the noms drive"
        assert drove, "auth-off: the noms are eventually driven for real once the window is spent"
    finally:
        _clear_anon()


def test_no_force_march_past_nominations_when_user_is_none(monkeypatch):
    # The whole-week guard for the auth-off landing case: several spectator turns must HOLD, then play
    # the ceremony — never steamroll nominations → veto. This is the live-verify montage, pinned green.
    _clear_anon()
    try:
        eng = _Engine(start="nominations", pending=None).wire(monkeypatch)
        moments = [(_pre_anon(eng)).get("moment")
                   for _ in range(chat_helpers._SOCIAL_RUNWAY_TURNS + 1)]
        assert moments.count("social") >= 1, "auth-off: the post-HOH window held at least one social turn"
        assert "nominations" in moments, "auth-off: the nomination ceremony was played as a witnessed beat"
        assert eng.advances <= 1, (
            f"auth-off force-marched {eng.advances} beats — the hold went inert (the #1127 root cause)")
    finally:
        _clear_anon()
