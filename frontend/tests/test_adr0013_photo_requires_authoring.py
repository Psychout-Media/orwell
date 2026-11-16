"""ADR 0013 — a cast photo requires a MODEL-AUTHORED identity.

The portrait warm (`orwell_prewarm.warm_portraits`) must shoot a face ONLY when its houseguest's
own authoring gate has fired (a real model write-back via `_on_authored`). An NPC the model could
NOT author — or one stuck behind a total authoring hang — must get NO photo (a seeded/un-authored
face would mismatch the rich authored text the player eventually sees). The portrait backfill shoots
it later, once authoring actually lands.
"""
import asyncio
import importlib

prewarm = importlib.import_module("src.orwell_prewarm")


def _run(coro):
    # FE convention: drive on the existing session loop (NEVER asyncio.run, which closes the loop
    # and breaks every subsequent test that shares it).
    return asyncio.get_event_loop().run_until_complete(coro)


def _drive():
    # warm_portraits nests tasks (the `_run` dispatcher spawns a per-NPC `_shoot_one` each); pump the
    # loop a few turns so they all settle.
    for _ in range(6):
        _run(asyncio.sleep(0))


class _FakePortraits:
    def __init__(self):
        self.shot = []

    def kickoff_generation(self, entries, user):
        for e in entries:
            self.shot.append(prewarm._prompt_id(e))

    def kickoff_authored_reshoot(self, hid, user):
        # 2026-07-13: the per-NPC authored shoot hands over the ID — the pipeline fetches the
        # CURRENT (authored) prompt at shoot time, never the captured pre-authoring snapshot.
        self.shot.append(hid)
        return True


def _setup(user, ids):
    prewarm.reset(user)
    st = prewarm._state(user)
    st.author_started = True
    st.prompts = [{"id": i} for i in ids]
    for i in ids:
        st.npc_event(i)  # pre-create the per-NPC gate
    return st


def test_photo_only_for_model_authored_npc():
    """Authored NPCs get a photo; an un-authored NPC (gate never fired, whole-cast done) gets none."""
    U = "adr11-mix"
    st = _setup(U, ["npc:1", "npc:2", "npc:3"])
    # npc:1 + npc:3 authored (their write-backs landed); npc:2 the model could NOT author.
    st.npc_event("npc:1").set()
    st.npc_event("npc:3").set()
    st.author_done.set()  # whole-cast authoring finished (success OR failure)
    fake = _FakePortraits()
    _run(prewarm.warm_portraits(U, portraits=fake, timeout=2.0))
    _drive()
    assert set(fake.shot) == {"npc:1", "npc:3"}, \
        f"only model-authored NPCs get a photo (got {fake.shot})"
    assert "npc:2" not in fake.shot, "an un-authored NPC must get NO photo (ADR 0013)"


def test_no_photo_when_nothing_authored():
    """If the whole cast finishes with NO NPC authored, zero photos shoot (never seeded faces)."""
    U = "adr11-none"
    st = _setup(U, ["npc:1", "npc:2"])
    st.author_done.set()  # whole-cast done, but no per-NPC gate ever fired
    fake = _FakePortraits()
    _run(prewarm.warm_portraits(U, portraits=fake, timeout=2.0))
    _drive()
    assert fake.shot == [], f"no NPC authored ⇒ no photos (got {fake.shot})"


def test_declines_when_author_warm_never_started():
    """No author warm at all ⇒ warm_portraits declines (createCharacter's fallback owns that path)."""
    U = "adr11-noauthor"
    prewarm.reset(U)
    st = prewarm._state(U)
    st.author_started = False
    fake = _FakePortraits()
    res = _run(prewarm.warm_portraits(U, portraits=fake, timeout=2.0))
    assert res.get("started") is False and res.get("reason") == "author-warm-not-started"
    assert fake.shot == []


# ── #1313: the no-prewarm FALLBACK branch of do_create_character must also respect ADR 0013 ──────
#
# Root cause of the bypass: the fallback branch immediately shot ALL portraits from the SEEDED-FLOOR
# prompts before authoring even started, winning the race every time — so authored identities never
# reached the faces. Under the house-entry gate (a real utility model resolves), the fallback must
# NOT floor-shoot: each face follows its OWN per-NPC authoring gate, so an un-authored NPC gets NO
# photo.
import json  # noqa: E402
import importlib as _il  # noqa: E402

_ti = _il.import_module("src.tool_implementations")
_oe = _il.import_module("src.orwell_engine")
_ca = _il.import_module("src.orwell_cast_authoring")
_cid = _il.import_module("src.orwell_cast_identity")
_portraits = _il.import_module("src.orwell_portraits")


def _fallback_res():
    house = [{"id": "player", "name": "The Player"}]
    prompts = [{"houseguestId": "player", "prompt": "headshot"}]
    for i in range(1, 16):
        house.append({"id": f"npc:{i}"})
        prompts.append({"houseguestId": f"npc:{i}", "prompt": "headshot"})
    return {"started": True, "house": house, "portraitPrompts": prompts}


def _wire_fallback(monkeypatch, *, gate_on, authored_ids):
    """Drive do_create_character's no-prewarm fallback: gate on/off, and a stubbed authoring pass
    that fires `on_authored` for exactly `authored_ids`. Returns the record of shot ids."""
    shot = []

    async def fake_create(*a, **k):
        return _fallback_res()
    monkeypatch.setattr(_oe, "create_character", fake_create)

    async def fake_state(*a, **k):
        return {"started": False}
    monkeypatch.setattr(_oe, "get_game_state", fake_state)

    # No pre-warm → the fallback branch runs.
    from src import orwell_prewarm as _pw
    monkeypatch.setattr(_pw, "warm_state",
                        lambda user=None: {"authorStarted": False, "portraitsStarted": False})

    async def _gate(owner):
        return gate_on
    monkeypatch.setattr(_ca, "house_entry_gate_active", _gate)

    # The gate's readiness wait is out of scope here — return immediately.
    async def _ready(owner, **k):
        return {"ready": True, "authored": len(authored_ids), "total": 15, "missing": 0}
    monkeypatch.setattr(_ca, "await_house_ready", _ready)

    # The immediate floor kick (gate OFF path) records under kickoff_generation …
    def fake_gen(prompts, user):
        for p in prompts:
            shot.append(p.get("houseguestId") or p.get("id"))
    monkeypatch.setattr(_portraits, "kickoff_generation", fake_gen)

    # … and the per-NPC authored shoot (gate ON path) records under kickoff_backfill.
    def fake_backfill(ids, user, force=False):
        for i in ids:
            shot.append(i)
    monkeypatch.setattr(_portraits, "kickoff_backfill", fake_backfill)

    # After the immediate gen (gate OFF), faces are on disk, so the authoring top-up finds nothing
    # missing (real behaviour). Stub `portrait_file` truthy so the top-up doesn't re-shoot the floor.
    monkeypatch.setattr(_portraits, "portrait_file", lambda user, hid: "onfile")

    # identity seed → immediately chain its `then` (simulate the fold landing).
    def fake_identity(cast, owner, then=None, seed=None):
        if then:
            then()
    monkeypatch.setattr(_cid, "kickoff_identity", fake_identity)

    # authoring → fire on_authored for exactly the authored ids, then the whole-cast `then`.
    def fake_authoring(cast, owner, then=None, on_authored=None, write=None, seed=None):
        if on_authored:
            for hid in authored_ids:
                on_authored(hid)
        if then:
            then()
    monkeypatch.setattr(_ca, "kickoff_authoring", fake_authoring)
    return shot


def test_fallback_zero_authored_shoots_zero_portraits(monkeypatch, run):
    """#1313 — no-prewarm fallback, gate ON, ZERO NPCs authored ⇒ ZERO portraits shot (ADR 0013)."""
    monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START", raising=False)
    shot = _wire_fallback(monkeypatch, gate_on=True, authored_ids=[])
    res = run(_ti.do_create_character('{"playerName":"P"}', owner="z1"))
    assert res["exit_code"] == 0
    assert shot == [], f"no NPC authored ⇒ no photos (got {shot})"


def test_fallback_shoots_only_authored_npcs(monkeypatch, run):
    """#1313 — gate ON: a face shoots ONLY for a model-authored NPC (its per-NPC gate fired)."""
    monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START", raising=False)
    shot = _wire_fallback(monkeypatch, gate_on=True, authored_ids=["npc:2", "npc:5"])
    res = run(_ti.do_create_character('{"playerName":"P"}', owner="z2"))
    assert res["exit_code"] == 0
    assert set(shot) == {"npc:2", "npc:5"}, \
        f"only model-authored NPCs get a photo in the gated fallback (got {shot})"


def test_fallback_gate_off_floor_shoots_immediately(monkeypatch, run):
    """Gate OFF (no model / escape hatch): the fallback floor-shoots immediately, as before — the
    deterministic floor IS the final cast, so a floor face can never mismatch an authored one."""
    monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START", raising=False)
    shot = _wire_fallback(monkeypatch, gate_on=False, authored_ids=[])
    res = run(_ti.do_create_character('{"playerName":"P"}', owner="z3"))
    assert res["exit_code"] == 0
    # every prompt (player + 15 NPCs) shot up front from the seeded facets
    assert "player" in shot and "npc:1" in shot and "npc:15" in shot
    assert len([s for s in shot if s]) == 16


# ── #1336: the PREWARMED branch's #976 fall-through must also respect ADR 0013 ──────────────
#
# Same class as the fallback fix above, separate region: when author warm ran during the interview
# (authorStarted=True) but the gated portrait warm DECLINES (portraitsStarted stays false), the #976
# fall-through used to floor-shoot EVERY face from the seeded prompts — even under a resolvable
# utility model (house-entry gate ON), where authoring can and will land richer identities. The
# prewarmed fall-through must now follow the SAME per-NPC authoring gate (`on_authored`): no floor
# face may be shot for an un-authored NPC while a utility model resolves. (The gate-OFF half — the
# original unconditional floor kick — stays pinned in test_orwell_portraits.py's #976 tests.)


def _wire_prewarmed(monkeypatch, *, gate_on, authored_ids):
    """Drive do_create_character's PREWARMED branch with the gated portrait warm DECLINING
    (portraitsStarted stays false): gate on/off, and a stubbed authoring pass that fires
    `on_authored` for exactly `authored_ids`. Returns the record of shot ids."""
    shot = []

    async def fake_create(*a, **k):
        return _fallback_res()
    monkeypatch.setattr(_oe, "create_character", fake_create)

    async def fake_state(*a, **k):
        return {"started": False}
    monkeypatch.setattr(_oe, "get_game_state", fake_state)

    # Author warm ran during the interview → the PREWARMED branch; the gated warm DECLINES.
    from src import orwell_prewarm as _pw
    monkeypatch.setattr(_pw, "warm_state",
                        lambda user=None: {"authorStarted": True, "portraitsStarted": False})

    async def fake_warm(user=None):
        return {"started": False, "reason": "author-warm-not-started"}
    monkeypatch.setattr(_pw, "warm_portraits", fake_warm)

    async def _gate(owner):
        return gate_on
    monkeypatch.setattr(_ca, "house_entry_gate_active", _gate)

    async def _ready(owner, **k):
        return {"ready": True, "authored": len(authored_ids), "total": 15, "missing": 0}
    monkeypatch.setattr(_ca, "await_house_ready", _ready)

    # The floor kick (gate OFF path) records under kickoff_generation …
    def fake_gen(prompts, user):
        for p in prompts:
            shot.append(p.get("houseguestId") or p.get("id"))
    monkeypatch.setattr(_portraits, "kickoff_generation", fake_gen)

    # … and the per-NPC authored shoot (gate ON path) records under kickoff_backfill.
    def fake_backfill(ids, user, force=False):
        for i in ids:
            shot.append(i)
    monkeypatch.setattr(_portraits, "kickoff_backfill", fake_backfill)

    # authoring → fire on_authored for exactly the authored ids, then the whole-cast `then`.
    def fake_authoring(cast, owner, then=None, on_authored=None, write=None, seed=None):
        if on_authored:
            for hid in authored_ids:
                on_authored(hid)
        if then:
            then()
    monkeypatch.setattr(_ca, "kickoff_authoring", fake_authoring)
    return shot


def test_prewarmed_declined_warm_gate_on_zero_authored_shoots_zero(monkeypatch, run):
    """#1336 — prewarmed branch, gated warm declined, gate ON, ZERO NPCs authored ⇒ ZERO portraits
    shot (ADR 0013: an un-authored NPC gets NO floor face while a utility model resolves)."""
    monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START", raising=False)
    shot = _wire_prewarmed(monkeypatch, gate_on=True, authored_ids=[])
    res = run(_ti.do_create_character('{"playerName":"P"}', owner="pw1"))
    assert res["exit_code"] == 0
    assert shot == [], f"no NPC authored ⇒ no photos in the gated prewarmed fall-through (got {shot})"


def test_prewarmed_declined_warm_gate_on_shoots_only_authored(monkeypatch, run):
    """#1336 — gate ON: the prewarmed fall-through shoots a face ONLY for a model-authored NPC
    (its per-NPC gate fired), exactly like the no-prewarm fallback branch."""
    monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START", raising=False)
    shot = _wire_prewarmed(monkeypatch, gate_on=True, authored_ids=["npc:3", "npc:7"])
    res = run(_ti.do_create_character('{"playerName":"P"}', owner="pw2"))
    assert res["exit_code"] == 0
    assert set(shot) == {"npc:3", "npc:7"}, \
        f"only model-authored NPCs get a photo in the gated prewarmed fall-through (got {shot})"


def test_prewarmed_declined_warm_gate_off_still_floor_shoots(monkeypatch, run):
    """#1336 — gate OFF (no model / escape hatch): the prewarmed fall-through keeps the original
    #976 behavior — the unconditional seeded-facet kick (the floor IS the final cast)."""
    monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START", raising=False)
    shot = _wire_prewarmed(monkeypatch, gate_on=False, authored_ids=[])
    res = run(_ti.do_create_character('{"playerName":"P"}', owner="pw3"))
    assert res["exit_code"] == 0
    assert "player" in shot and "npc:1" in shot and "npc:15" in shot
    assert len([s for s in shot if s]) == 16
