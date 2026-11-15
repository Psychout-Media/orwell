"""ORW-369: the background upgrader re-shoots old-wording portraits of a running season, one
houseguest at a time, silently, keeping the old photo until the new image lands."""

import asyncio
import importlib
import json

import pytest

P = importlib.import_module("src.orwell_portraits")
U = importlib.import_module("src.orwell_portrait_upgrade")
engine = importlib.import_module("src.orwell_engine")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _card(i, **extra):
    c = {"id": f"npc:{i}", "name": f"Guest {i}", "status": "active", "vocation": "teacher",
         "hometown": "Tulsa", "demeanor": "dry", "age": 40, "archetype": "Planner",
         "secrets": ["VAULT-SECRET"], "trueGoals": "VAULT-GOAL", "opinions": {"x": 9}}
    c.update(extra)
    return c


@pytest.fixture
def season(tmp_path, monkeypatch):
    monkeypatch.setattr(P, "PORTRAITS_DIR", tmp_path / "portraits")
    monkeypatch.setattr(P, "image_generation_available", lambda user: True)
    monkeypatch.setattr(P, "image_gen_disabled", lambda: False)
    U._STATE.clear()
    U._BUSY.clear()

    async def _live():  # ORW-378: these tests are the live-game (one at a time) path
        return True

    monkeypatch.setattr(U, "game_is_live", _live)
    P._INFLIGHT.clear()
    P._GEN_PROGRESS.clear()
    state = {"started": True, "player": {"id": "player", "name": "Me"},
             "house": [_card(1), _card(2), _card(3)]}

    async def get_state(user=None, timeout=None):
        return state

    async def get_pp(hid, user=None):
        return {"houseguestId": hid, "name": "Guest " + hid.split(":")[1], "prompt": f"v2 prompt {hid}"}

    monkeypatch.setattr(engine, "get_game_state", get_state)
    monkeypatch.setattr(engine, "get_portrait_prompt", get_pp)
    # version-1 season: three NPCs + the player (an upload)
    d = P.user_portrait_dir("u")
    d.mkdir(parents=True)
    m = {}
    for sid, src in (("npc_1", "generated"), ("npc_2", "generated"), ("npc_3", "generated"),
                     ("player", "upload")):
        (d / f"{sid}.png").write_bytes(b"PNG:old")
        m[sid] = {"file": f"{sid}.png", "name": "Guest " + sid.split("_")[-1], "source": src, "promptVersion": 1}
    P._save_manifest("u", m)
    return state, d


def _gen(monkeypatch, log, fail=()):
    live = {"n": 0, "max": 0}

    async def fake(prompt, user, reference_png=None):
        live["n"] += 1
        live["max"] = max(live["max"], live["n"])
        await asyncio.sleep(0)
        live["n"] -= 1
        log.append(prompt)
        if any(f in prompt for f in fail):
            P._note_gen_error("http-500")
            return None
        return b"PNG:new:" + prompt.encode()

    monkeypatch.setattr(P, "_generate_one", fake)
    return live


def test_one_at_a_time_player_skipped_version_recorded(season, monkeypatch):
    state, d = season
    log = []
    live = _gen(monkeypatch, log)
    t = 1000.0
    assert _run(U.upgrade_tick("u", now=t)) == "waiting"           # the 45 s quiet window
    assert _run(U.upgrade_tick("u", now=t + 44)) == "waiting"
    assert _run(U.upgrade_tick("u", now=t + 46)) == "upgraded"
    assert len(log) == 1                                            # exactly one houseguest
    assert _run(U.upgrade_tick("u", now=t + 50)) == "waiting"       # 15 s gap
    assert _run(U.upgrade_tick("u", now=t + 62)) == "upgraded"
    assert _run(U.upgrade_tick("u", now=t + 80)) == "upgraded"
    assert _run(U.upgrade_tick("u", now=t + 100)) == "done"
    assert log == ["v2 prompt npc:1", "v2 prompt npc:2", "v2 prompt npc:3"]
    assert live["max"] == 1
    m = P.load_manifest("u")
    assert all(m[k]["promptVersion"] == P.PORTRAIT_PROMPT_VERSION for k in ("npc_1", "npc_2", "npc_3"))
    assert m["player"]["promptVersion"] == 1 and (d / "player.png").read_bytes() == b"PNG:old"
    assert (d / "npc_1.png").read_bytes() == b"PNG:new:v2 prompt npc:1"
    assert not list(d.glob(".*.tmp"))                               # atomic swap left no temp file
    assert P._GEN_PROGRESS == {}                                    # silent: no progress UI record


def test_player_stale_is_never_listed_even_if_generated(season):
    state, d = season
    m = P.load_manifest("u")
    m["player"]["source"] = "reference"
    P._save_manifest("u", m)
    assert "player" not in U.stale_candidates("u", state, P.load_manifest("u"))


def test_old_file_stays_until_success_and_failure_retries_with_growing_wait(season, monkeypatch):
    state, d = season
    log = []
    _gen(monkeypatch, log, fail=("npc:1",))
    state["house"] = [_card(1)]
    t = 2000.0
    _run(U.upgrade_tick("u", now=t))
    waits = []
    now = t + 50
    for n in range(1, 6):
        assert _run(U.upgrade_tick("u", now=now)) == "failed"
        assert (d / "npc_1.png").read_bytes() == b"PNG:old"
        assert P.load_manifest("u")["npc_1"]["promptVersion"] == 1
        w = U._STATE["u"]["retry_at"]["npc_1"] - now
        waits.append(w)
        assert _run(U.upgrade_tick("u", now=now + 20)) == "waiting"  # not before the wait
        now += w + 1
    assert waits == [300, 900, 2700, 7200, 7200]
    # then it works: the loop never gave up
    P._generate_one  # noqa
    log.clear()

    async def ok(prompt, user, reference_png=None):
        return b"PNG:fresh"
    monkeypatch.setattr(P, "_generate_one", ok)
    assert _run(U.upgrade_tick("u", now=now)) == "upgraded"
    assert (d / "npc_1.png").read_bytes() == b"PNG:fresh"


def test_failure_is_recorded_red(season, monkeypatch):
    state, d = season
    _gen(monkeypatch, [], fail=("npc",))
    state["house"] = [_card(1)]
    seen = []
    monkeypatch.setattr(P, "_note_generation_failure", lambda u, h, r, **k: seen.append(r))
    _run(U.upgrade_tick("u", now=5000.0))
    _run(U.upgrade_tick("u", now=5100.0))
    assert any(r.startswith("portrait-upgrade-failed") for r in seen)


def test_version2_season_does_nothing(season, monkeypatch):
    state, d = season
    log = []
    _gen(monkeypatch, log)
    m = P.load_manifest("u")
    for k in m:
        m[k]["promptVersion"] = 2
    P._save_manifest("u", m)
    for t in (0, 100, 200):
        assert _run(U.upgrade_tick("u", now=float(t))) == "idle"
    assert log == []


def test_waits_while_a_full_generation_runs(season, monkeypatch):
    state, d = season
    log = []
    _gen(monkeypatch, log)
    _run(U.upgrade_tick("u", now=0.0))
    P._progress_start("u", 5)  # a new-cast generation is in flight
    assert _run(U.upgrade_tick("u", now=100.0)) == "waiting"
    assert log == []
    P._progress_finish("u")
    assert _run(U.upgrade_tick("u", now=101.0)) == "upgraded"


def test_a_different_season_restarts_the_quiet_window(season, monkeypatch):
    state, d = season
    _gen(monkeypatch, [])
    _run(U.upgrade_tick("u", now=0.0))
    assert _run(U.upgrade_tick("u", now=100.0)) == "upgraded"
    state["house"] = [_card(7, name="Guest 7")]
    m = P.load_manifest("u")
    m["npc_7"] = {"file": "npc_7.png", "name": "Guest 7", "source": "generated", "promptVersion": 1}
    (d / "npc_7.png").write_bytes(b"x")
    P._save_manifest("u", m)
    assert _run(U.upgrade_tick("u", now=101.0)) == "waiting"  # re-armed on load


def test_writer_input_is_public_fields_only():
    card = _card(1, identityConcept="a baker", presentation="soft tailoring",
                 physicalCharacteristics={"hair": "x", "presentation": "soft", "wardrobe": ["a"]})
    out = U.writer_input(card)
    blob = json.dumps(out)
    for bad in ("VAULT-SECRET", "VAULT-GOAL", "opinions", "secrets", "trueGoals", "hair"):
        assert bad not in blob
    assert out["vocation"] == "teacher" and out["identityConcept"] == "a baker"


def test_look_checks_reuse_the_writers_validators():
    card = _card(1)
    ok = {"wardrobe": ["denim jacket", "white tee"], "onCamera": "Laughs easily in the kitchen."}
    assert U.look_checked(ok, card)[0] == ok
    bad, probs = U.look_checked({"wardrobe": ["one"], "onCamera": "x" * 300}, card)
    assert bad == {} and set(probs) == {"wardrobe-shape", "oncamera-shape"}
    got, _ = U.look_checked({"wardrobe": ["a jacket", "b tee"], "onCamera": "In the garage."}, card)
    assert got == {"wardrobe": ["a jacket", "b tee"]}  # a field that fails is omitted


def test_write_look_one_strict_retry(monkeypatch):
    CA = importlib.import_module("src.orwell_cast_authoring")
    calls = []

    async def llm(msgs):
        calls.append(msgs)
        return "no json" if len(calls) == 1 else json.dumps(
            {"wardrobe": ["denim jacket", "white tee"], "onCamera": "Laughs easily in the kitchen."})

    async def resolve(owner, **k):
        return llm
    monkeypatch.setattr(CA, "resolve_authoring_llm_fn", resolve)
    look = _run(U.write_look(_card(1), "u"))
    assert len(calls) == 2 and look["wardrobe"] == ["denim jacket", "white tee"]
    sent = json.dumps(calls[0])
    for bad in ("VAULT-SECRET", "VAULT-GOAL", "opinions"):
        assert bad not in sent


def test_look_filled_only_when_missing_and_from_public_fields(season, monkeypatch):
    state, d = season
    _gen(monkeypatch, [])
    state["house"] = [_card(1), _card(2, physicalCharacteristics={"wardrobe": ["a", "b"], "onCamera": "In the lounge."})]
    seen_inputs, stored = [], []

    async def fake_write_look(card, owner):
        seen_inputs.append(U.writer_input(card))
        return {"wardrobe": ["x", "y"], "onCamera": "In the kitchen."}

    async def record(hid, look, user=None):
        stored.append((hid, look))
        return {"accepted": True}

    monkeypatch.setattr(U, "look_fill_supported", lambda: True)
    monkeypatch.setattr(U, "write_look", fake_write_look)
    monkeypatch.setattr(engine, "record_look_extras", record, raising=False)
    _run(U.upgrade_tick("u", now=0.0))
    assert _run(U.upgrade_tick("u", now=100.0)) == "upgraded"
    assert _run(U.upgrade_tick("u", now=200.0)) == "upgraded"
    assert [h for h, _ in stored] == ["npc:1"]  # npc:2 already had its look
    assert "VAULT-SECRET" not in json.dumps(seen_inputs)


def test_runs_as_a_background_task_off_the_request_path(monkeypatch):
    async def main():
        started = U.ensure_upgrader_started()
        again = U.ensure_upgrader_started()
        task = U._TASK
        alive = not task.done()
        task.cancel()
        return started, again, alive
    loop = asyncio.new_event_loop()
    try:
        started, again, alive = loop.run_until_complete(main())
    finally:
        loop.close()
    assert started is True and again is False and alive


def test_evicted_and_jury_are_upgraded_too_but_after_the_house(season, monkeypatch):
    state, d = season
    log = []
    _gen(monkeypatch, log)
    state["house"] = [_card(1, status="evicted"), _card(2, status="jury"), _card(3)]
    assert U.stale_candidates("u", state, P.load_manifest("u")) == ["npc_3", "npc_1", "npc_2"]
    t = 0.0
    _run(U.upgrade_tick("u", now=t))
    for k in range(3):
        assert _run(U.upgrade_tick("u", now=100.0 + 20 * k)) == "upgraded"
    assert log == ["v2 prompt npc:3", "v2 prompt npc:1", "v2 prompt npc:2"]
    assert _run(U.upgrade_tick("u", now=300.0)) == "done"
