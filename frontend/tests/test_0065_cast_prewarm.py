"""Feature 0065 — cast pre-warm orchestration (FE side).

The hard invariant: a FULLY WARMED AUTHORSHIP before any portrait is ever generated. Author warm runs
the deep authoring in the background as early as possible; portrait warm is held and WAITS for author
warm to finish before it shoots a single face. Deps are injected, so the whole gate is testable with no
live model, engine, or image provider.
"""
import asyncio

from src import orwell_prewarm as P


def _run(coro):
    # FE convention: drive on the existing session loop (never asyncio.run, which closes the loop).
    return asyncio.get_event_loop().run_until_complete(coro)


def _drive():
    # Let the loop process the background task(s) created by warm_portraits / kickoff_authoring.
    # Portrait warm now nests tasks (the `_run` dispatcher spawns a per-NPC `_shoot_one` task each,
    # #7), so a single yield can't drain every level — pump the loop a few turns to settle them all.
    for _ in range(5):
        _run(asyncio.sleep(0))


class _FakeEngine:
    def __init__(self, res):
        self.res = res
        self.calls = 0

    async def pre_seed_cast(self, user=None):
        self.calls += 1
        return self.res


class _FakeAuthoring:
    """Captures the kickoff and the gate-release callbacks; releases on `finish()` (or immediately).

    Mirrors the real `kickoff_authoring(cast, user, then=None, on_authored=None)` signature (#7): it
    captures the per-NPC `on_authored` callback so a test can fire ONE houseguest's completion in
    isolation via `finish_npc(hid)`, plus the whole-cast `then` gate via `finish()`."""
    def __init__(self, auto_finish=True):
        self.cast = None
        self.calls = 0
        self._then = None
        self._on_authored = None
        self._auto = auto_finish

    def kickoff_authoring(self, cast, user, then=None, on_authored=None, write=None, seed=None):
        self.cast = cast
        self.calls += 1
        self._then = then
        self._on_authored = on_authored
        if self._auto:
            # auto-finish authors every NPC (per-NPC gate) AND closes the whole-cast gate.
            for npc in (cast or []):
                hid = npc.get("id")
                if hid and hid != "player" and on_authored:
                    on_authored(hid)
            if then:
                then()

    def finish_npc(self, hid):
        """Fire ONE houseguest's per-NPC completion (its portrait gate opens)."""
        if self._on_authored:
            self._on_authored(hid)

    def finish(self):
        """Fire the whole-cast completion gate (and, in the real wiring, any never-fired per-NPC gate)."""
        if self._then:
            self._then()


class _FakePortraits:
    def __init__(self):
        self.prompts = None
        self.calls = 0
        self.shot_ids = []  # every houseguest id whose portrait was shot, in order (#7 per-NPC gating)

    def kickoff_generation(self, prompts, user):
        self.prompts = prompts
        self.calls += 1
        for entry in (prompts or []):
            if isinstance(entry, dict):
                hid = entry.get("houseguestId") or entry.get("id")
                if hid:
                    self.shot_ids.append(hid)

    def kickoff_authored_reshoot(self, hid, user):
        # 2026-07-13: the per-NPC authored shoot fetches the CURRENT prompt at shoot time (never
        # the captured pre-authoring snapshot) — the warm hands it the ID, not the stale entry.
        self.calls += 1
        if hid:
            self.shot_ids.append(hid)
        return True


_WARM_RES = {
    "warmed": True, "seed": 5,
    "house": [{"id": "npc:1", "name": "A", "biography": "A deep bio. Two sentences."}],
    "portraitPrompts": [{"houseguestId": "npc:1", "name": "A", "prompt": "a portrait"}],
}


def setup_function(_):
    P.reset()  # isolate per-user warm state across tests


# ── author warm ────────────────────────────────────────────────────────────────

def test_prewarm_cast_pre_seeds_then_authors_in_background():
    eng, auth = _FakeEngine(_WARM_RES), _FakeAuthoring()
    res = _run(P.prewarm_cast("u1", engine=eng, authoring=auth))
    assert res["warmed"] is True
    assert eng.calls == 1
    assert auth.calls == 1
    assert auth.cast == _WARM_RES["house"]
    st = P.warm_state("u1")
    assert st["authorStarted"] is True and st["authorDone"] is True and st["promptCount"] == 1


def test_prewarm_cast_is_idempotent_within_a_season():
    eng, auth = _FakeEngine(_WARM_RES), _FakeAuthoring()
    _run(P.prewarm_cast("u1", engine=eng, authoring=auth))
    again = _run(P.prewarm_cast("u1", engine=eng, authoring=auth))
    assert again.get("alreadyWarmed") is True
    # The engine is polled each time (cheap, idempotent), but the SAME seed never re-authors.
    assert eng.calls == 2 and auth.calls == 1


def test_prewarm_cast_re_warms_a_fresh_cast_across_seasons():
    # A new season mints a new seed → a fresh author warm (self-resetting, no per-route plumbing).
    eng = _FakeEngine(dict(_WARM_RES, seed=5))
    auth = _FakeAuthoring()
    _run(P.prewarm_cast("u1", engine=eng, authoring=auth))
    assert auth.calls == 1
    eng.res = dict(_WARM_RES, seed=99)  # season 2's cast
    res2 = _run(P.prewarm_cast("u1", engine=eng, authoring=auth))
    assert res2.get("alreadyWarmed") is not True
    assert auth.calls == 2  # the new cast was authored afresh
    assert P.warm_state("u1")["authorDone"] is True


def test_prewarm_cast_declines_when_a_season_is_running():
    eng, auth = _FakeEngine({"warmed": False, "refused": "in-progress"}), _FakeAuthoring()
    res = _run(P.prewarm_cast("u1", engine=eng, authoring=auth))
    assert res["warmed"] is False
    assert auth.calls == 0
    assert P.warm_state("u1")["authorStarted"] is False


# ── portrait warm — gated on author warm ─────────────────────────────────────────

def test_warm_portraits_declines_when_no_author_warm_ran():
    # No prewarm_cast first → nothing to gate on → decline (createCharacter's fallback owns portraits).
    port = _FakePortraits()
    res = _run(P.warm_portraits("u1", portraits=port))
    assert res["started"] is False
    assert port.calls == 0


def test_warm_portraits_shoots_after_author_warm_finished():
    eng, auth, port = _FakeEngine(_WARM_RES), _FakeAuthoring(auto_finish=True), _FakePortraits()
    _run(P.prewarm_cast("u1", engine=eng, authoring=auth, server_portraits=False))  # author warm already done (auto_finish); the browser path is under test
    res = _run(P.warm_portraits("u1", portraits=port))
    assert res["started"] is True
    _drive()  # let the gated background task run
    assert port.calls == 1
    # 2026-07-13: the per-NPC authored shoot passes the ID (the fresh-prompt fetch happens inside
    # the portrait pipeline at shoot time), not the pre-seed-time captured prompt entry.
    assert port.shot_ids == ["npc:1"]


def test_portraits_NEVER_shoot_before_authoring_completes():
    """The load-bearing invariant: hold a face until ITS houseguest is model-authored (ADR 0013)."""
    eng = _FakeEngine(_WARM_RES)
    auth = _FakeAuthoring(auto_finish=False)  # authoring is in-flight; the gate stays closed
    port = _FakePortraits()
    _run(P.prewarm_cast("u1", engine=eng, authoring=auth))
    _run(P.warm_portraits("u1", portraits=port))
    _drive()  # the portrait task starts and AWAITS the gate
    assert port.calls == 0, "a portrait was shot before authoring finished"
    assert P.warm_state("u1")["authorDone"] is False

    auth.finish_npc("npc:1")  # ADR 0013: the NPC's OWN authoring (not the whole-cast gate) shoots its face
    _drive()
    assert port.calls == 1, "the portrait did not shoot once its houseguest was authored"


# A two-houseguest cast + two prompts, for the per-NPC gating invariant (#7).
_WARM_RES_2 = {
    "warmed": True, "seed": 7,
    "house": [
        {"id": "npc:1", "name": "A", "biography": "A deep bio. Two sentences."},
        {"id": "npc:2", "name": "B", "biography": "B deep bio. Two sentences."},
    ],
    "portraitPrompts": [
        {"houseguestId": "npc:1", "name": "A", "prompt": "portrait A"},
        {"houseguestId": "npc:2", "name": "B", "prompt": "portrait B"},
    ],
}


def test_portraits_gate_PER_NPC_each_face_shoots_only_after_that_npc_is_authored():
    """#7: per-houseguest gating. NPC X's portrait shoots only AFTER X's authoring write-back lands;
    a still-unauthored NPC's face is NOT shot early. Faces stream in as authoring completes."""
    eng = _FakeEngine(_WARM_RES_2)
    auth = _FakeAuthoring(auto_finish=False)  # author each NPC manually, one at a time
    port = _FakePortraits()

    _run(P.prewarm_cast("u1", engine=eng, authoring=auth))
    _run(P.warm_portraits("u1", portraits=port))
    _drive()  # both per-NPC portrait tasks start and AWAIT their own gate
    assert port.shot_ids == [], "a portrait shot before its houseguest was authored"

    # Author ONLY npc:1 → only npc:1's face may shoot; npc:2 stays held.
    auth.finish_npc("npc:1")
    _drive()
    assert port.shot_ids == ["npc:1"], "expected only npc:1's portrait after only npc:1 authored"

    # Now author npc:2 → its face streams in.
    auth.finish_npc("npc:2")
    _drive()
    assert port.shot_ids == ["npc:1", "npc:2"], "npc:2's portrait did not shoot once it was authored"
    # Each face was shot exactly once, individually (per-NPC, not one whole-cast batch).
    assert port.calls == 2


def test_portraits_unauthored_npc_gets_NO_face_even_at_authoring_end():
    """ADR 0013 — an NPC the model never authored gets NO photo (a seeded/un-authored face would
    mismatch the real, authored text). The whole-cast `then` releases ONLY the fallback gate; it must
    NOT shoot a never-authored NPC. That NPC's face stays unshot here — the portrait backfill shoots it
    if/when its authoring actually lands. (Overturns the prior #7 'whole-cast fallback shoots' behavior.)"""
    eng = _FakeEngine(_WARM_RES_2)
    auth = _FakeAuthoring(auto_finish=False)
    port = _FakePortraits()

    _run(P.prewarm_cast("u1", engine=eng, authoring=auth))
    _run(P.warm_portraits("u1", portraits=port))
    _drive()
    assert port.shot_ids == []

    auth.finish_npc("npc:1")  # only one NPC authored
    _drive()
    assert port.shot_ids == ["npc:1"]

    auth.finish()  # whole-cast done → ADR 0013: the never-authored npc:2 must NOT shoot
    _drive()
    assert port.shot_ids == ["npc:1"], "ADR 0013: an unauthored NPC must NOT get a face"
    assert "npc:2" not in port.shot_ids
    assert P.warm_state("u1")["authorDone"] is True


def test_warm_portraits_is_idempotent():
    eng, auth, port = _FakeEngine(_WARM_RES), _FakeAuthoring(), _FakePortraits()
    _run(P.prewarm_cast("u1", engine=eng, authoring=auth, server_portraits=False))
    _run(P.warm_portraits("u1", portraits=port))
    again = _run(P.warm_portraits("u1", portraits=port))
    assert again.get("alreadyStarted") is True
    _drive()
    assert port.calls == 1  # a single generation pass, not two


def test_reset_clears_state_for_a_fresh_oobe():
    eng, auth = _FakeEngine(_WARM_RES), _FakeAuthoring()
    _run(P.prewarm_cast("u1", engine=eng, authoring=auth))
    assert P.warm_state("u1")["authorStarted"] is True
    P.reset("u1")
    assert P.warm_state("u1")["authorStarted"] is False
