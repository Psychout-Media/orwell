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
    CA = importlib.import_module("src.orwell_cast_authoring")

    async def _no_writer(owner, **k):  # ORW-380: no look writer unless a test supplies one
        return None

    monkeypatch.setattr(CA, "resolve_authoring_llm_fn", _no_writer)
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

    async def fake(prompt, user, reference_png=None, keep_identity=True):
        live["n"] += 1
        live["max"] = max(live["max"], live["n"])
        await asyncio.sleep(0)
        live["n"] -= 1
        live.setdefault("calls", []).append({"prompt": prompt, "ref": reference_png, "keep": keep_identity})
        log.append(prompt.replace(P.UPGRADE_IDENTITY_PREFIX, ""))
        if any(f in prompt for f in fail):
            P._note_gen_error("http-500")
            return None
        return b"PNG:new:" + prompt.replace(P.UPGRADE_IDENTITY_PREFIX, "").encode()

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

    async def ok(prompt, user, reference_png=None, keep_identity=True):
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
    # ORW-437: recorded RED exactly once, by the pipeline that failed (the upgrader no longer records it a second time)
    assert len(seen) == 1 and "http-500" in seen[0]


def test_current_version_season_does_nothing(season, monkeypatch):
    state, d = season
    log = []
    _gen(monkeypatch, log)
    m = P.load_manifest("u")
    for k in m:
        m[k]["promptVersion"] = P.PORTRAIT_PROMPT_VERSION
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


def _sheet_llm(monkeypatch, replies, record):
    """A fake photo-sheet writer: `replies(name, n)` gives the JSON for that houseguest's n-th call."""
    CA = importlib.import_module("src.orwell_cast_authoring")
    live = {"n": 0, "max": 0}

    async def llm(msgs):
        live["n"] += 1
        live["max"] = max(live["max"], live["n"])
        await asyncio.sleep(0)
        live["n"] -= 1
        inp = json.loads(msgs[1]["content"])
        record.append({"system": msgs[0]["content"], "input": inp, "msgs": msgs})
        n = sum(1 for r in record if r["input"].get("name") == inp.get("name"))
        return json.dumps(replies(inp.get("name"), n))

    async def resolve(owner, **k):
        return llm

    monkeypatch.setattr(CA, "resolve_authoring_llm_fn", resolve)
    return live


def _fake_engine(monkeypatch, stored):
    async def record(hid, look, user=None):
        stored.append((hid, dict(look)))
        return {"accepted": True, "fields": [k for k in ("wardrobe", "photoHair", "onCamera") if k in look]}

    monkeypatch.setattr(U, "look_fill_supported", lambda: True)
    monkeypatch.setattr(engine, "record_look_extras", record, raising=False)


def _sheet(name, piece, spot, pron="She"):
    return {"wardrobe": [piece, "dark trousers"], "photoHair": "sleek neat braid over one shoulder",
            "onCamera": f"{pron} stands in the {spot}, arms folded, eyes on the camera, a small smile, the one who misses nothing."}


def test_sheets_rewritten_for_every_stale_houseguest_with_name_gender_and_taken(season, monkeypatch):
    state, d = season
    state["house"] = [
        _card(1, genderPresentation="woman", ethnicity="Irish", presentation="soft tailoring", voice={"energy": "low", "register": "dry", "catchphrases": ["VAULT-PHRASE"]},
              physicalCharacteristics={"heightBuild": "tall", "hair": "a braid", "style": "x", "wardrobe": ["old", "old2"], "onCamera": "She jokes then leaves the kitchen."}),
        _card(2, genderPresentation="man"), _card(3, genderPresentation="nonbinary")]
    log, record, stored = [], [], []
    _gen(monkeypatch, log)
    _fake_engine(monkeypatch, stored)
    live = _sheet_llm(monkeypatch, lambda name, n: {
        "Guest 1": _sheet("g1", "a leather jacket", "kitchen"),
        "Guest 2": _sheet("g2", "a flannel shirt", "backyard", "He"),
        "Guest 3": _sheet("g3", "a denim jacket", "lounge", "They")}[name], record)
    _run(U.upgrade_tick("u", now=0.0))
    assert _run(U.upgrade_tick("u", now=100.0)) == "upgraded"
    for t in (200.0, 300.0):
        _run(U.upgrade_tick("u", now=t))
    assert [h for h, _ in stored] == ["npc:1", "npc:2", "npc:3"]  # ALWAYS rewritten, even npc:1 that had a sheet
    first = record[0]["input"]
    assert first["name"] == "Guest 1" and first["genderPresentation"] == "woman"
    assert first["voice"] == {"energy": "low", "register": "dry"}
    assert first["taken"] == {"mainPieces": [], "spots": {}}
    assert "VAULT" not in json.dumps(record) and "secrets" not in json.dumps(first) and "opinions" not in json.dumps(first)
    # each later writer sees the main pieces and spots of the houseguests rewritten before it
    assert record[1]["input"]["taken"] == {"mainPieces": ["a leather jacket"], "spots": {"kitchen": 1}}
    assert record[2]["input"]["taken"]["mainPieces"] == ["a leather jacket", "a flannel shirt"]
    # photoHair rides along with the rewritten sheet that is stored for npc:1
    assert stored[0][1]["photoHair"] == "sleek neat braid over one shoulder"
    assert "PHOTO SHEET" in record[0]["system"] and "genderPresentation" in record[0]["system"]


def test_sheets_are_written_one_at_a_time_then_the_shoots_run_in_parallel(season, monkeypatch):
    state, d = season
    log, record, stored = [], [], []
    shoot = _gen(monkeypatch, log)
    _fake_engine(monkeypatch, stored)
    live = _sheet_llm(monkeypatch, lambda name, n: _sheet(name, {"Guest 1": "a green parka", "Guest 2": "a cream cardigan", "Guest 3": "a navy blazer"}[name], "kitchen"), record)

    async def idle():
        return False

    monkeypatch.setattr(U, "game_is_live", idle)
    monkeypatch.setattr(P, "portrait_parallel", lambda user: 3)
    _run(U.upgrade_tick("u", now=0.0))
    assert _run(U.upgrade_tick("u", now=100.0)) == "upgraded"
    assert live["max"] == 1 and len(record) == 3          # sheets: strictly sequential
    assert shoot["max"] >= 2                                # shoots: more than one at once
    assert [h for h, _ in stored] == ["npc:1", "npc:2", "npc:3"]
    assert record[2]["input"]["taken"]["spots"] == {"kitchen": 2}


def test_shoot_uses_the_current_file_as_the_reference_with_the_prefix_and_records_version_3(season, monkeypatch):
    state, d = season
    log, stored = [], []
    shoot = _gen(monkeypatch, log)
    _fake_engine(monkeypatch, stored)
    state["house"] = [_card(1)]
    _run(U.upgrade_tick("u", now=0.0))
    assert _run(U.upgrade_tick("u", now=100.0)) == "upgraded"
    call = shoot["calls"][0]
    assert call["ref"] == b"PNG:old" and call["keep"] is False
    assert call["prompt"] == ("The same person as in the reference photo: keep their face, skin tone and age. "
                              "Everything else (hair styling, clothes, pose, setting and light) follows this brief, "
                              "with clear even skin and no marks other than those named. v2 prompt npc:1")
    assert P.PORTRAIT_PROMPT_VERSION == 3
    assert P.load_manifest("u")["npc_1"]["promptVersion"] == 3


def test_no_current_file_shoots_without_a_reference(season, monkeypatch):
    state, d = season
    log = []
    shoot = _gen(monkeypatch, log)
    state["house"] = [_card(1)]
    (d / "npc_1.png").unlink()
    _run(U.upgrade_tick("u", now=0.0))
    _run(U.upgrade_tick("u", now=100.0))
    # no file on disk: the manifest entry is stale but there is nothing to carry; no reference, no prefix
    assert len(shoot.get("calls", [])) == 1  # ORW-437: a skipped candidate must not let the loop below pass vacuously
    for c in shoot.get("calls", []):
        assert c["ref"] is None and not c["prompt"].startswith("The same person")


def test_a_writer_that_gives_nothing_keeps_the_old_photo_when_an_old_sheet_would_ride(season, monkeypatch):
    state, d = season
    log, stored, record = [], [], []
    _gen(monkeypatch, log)
    _fake_engine(monkeypatch, stored)
    _sheet_llm(monkeypatch, lambda name, n: {}, record)
    state["house"] = [_card(1, physicalCharacteristics={"wardrobe": ["a", "b"], "onCamera": "She jokes then leaves the kitchen."})]
    _run(U.upgrade_tick("u", now=0.0))
    assert _run(U.upgrade_tick("u", now=100.0)) == "failed"
    assert len(record) == 2  # ORW-437: the writer was called and the strict retry ran (both gave nothing)
    assert log == [] and stored == []
    assert (d / "npc_1.png").read_bytes() == b"PNG:old"


def test_a_field_the_checker_drops_clears_the_old_one(season, monkeypatch):
    state, d = season
    log, stored, record = [], [], []
    _gen(monkeypatch, log)
    _fake_engine(monkeypatch, stored)
    bad = {"wardrobe": ["a plain navy cardigan", "dark jeans"], "photoHair": "a neat bun",
           "onCamera": "She says hello, then laughs in the kitchen."}
    _sheet_llm(monkeypatch, lambda name, n: bad, record)
    state["house"] = [_card(1, genderPresentation="woman", physicalCharacteristics={"onCamera": "She cooks then paces the kitchen.", "wardrobe": ["x", "y"]})]
    _run(U.upgrade_tick("u", now=0.0))
    assert _run(U.upgrade_tick("u", now=100.0)) == "upgraded"
    hid, look = stored[0]
    assert "onCamera" not in look and look["clear"] == ["onCamera"] and look["wardrobe"][0] == "a plain navy cardigan"
    assert len(record) == 2  # one strict retry


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


# ---- ORW-437 review ------------------------------------------------------------------------------------------

def test_a_stale_generation_heartbeat_does_not_block_the_upgrader_but_a_fresh_one_does():
    import time
    P._INFLIGHT.clear()
    P._GEN_PROGRESS.clear()
    P._GEN_PROGRESS[P._safe_user("u")] = {"active": True, "updatedAt": time.time() - P._GEN_PROGRESS_STALE_S - 5}
    assert U._full_generation_running("u") is False
    P._GEN_PROGRESS[P._safe_user("u")] = {"active": True, "updatedAt": time.time()}
    assert U._full_generation_running("u") is True
    P._GEN_PROGRESS.clear()
    P._INFLIGHT[P._safe_user("u")] = 1
    assert U._full_generation_running("u") is True  # the in-flight registry stays authoritative
    P._INFLIGHT.clear()


def test_a_429_keeps_the_breathing_gap_before_the_next_attempt():
    st = {"failed": 0, "fails": {}, "retry_at": {}, "next_ok_at": 0.0, "rate_limited": False}
    U._note_failure("u", "u", "npc_1", st, 100.0, 0.0, RuntimeError("http-429: slow down"))
    assert st["rate_limited"] is True and st["next_ok_at"] >= 100.0 + U.GAP_S


def test_the_429_gap_counts_from_the_failure_not_from_the_tick_start():
    import time
    st = {"failed": 0, "fails": {}, "retry_at": {}, "next_ok_at": 0.0, "rate_limited": False,
          "tick_t0": time.monotonic() - 20.0}  # the call took 20 s before the 429 came back
    U._note_failure("u", "u", "npc_1", st, 100.0, 0.0, RuntimeError("http-429: slow down"))
    assert st["next_ok_at"] >= 120.0 + U.GAP_S - 0.5


def test_the_billing_gate_only_reads_the_users_own_provider_host(season, monkeypatch):
    state, d = season
    log, stored = [], []
    _gen(monkeypatch, log)
    _fake_engine(monkeypatch, stored)
    state["house"] = [_card(1), _card(2), _card(3)]   # one season throughout: the quiet window is not reset by the swap
    P.reset_billing_breaker()
    monkeypatch.setattr(P, "portrait_parallel", lambda user: 1)  # one houseguest per tick

    async def host(user):
        return "mine.example"
    monkeypatch.setattr(P, "image_provider_host", host)
    try:
        P._trip_billing_breaker("other.example")          # an unrelated provider is out of credits
        _run(U.upgrade_tick("u", now=0.0))
        assert _run(U.upgrade_tick("u", now=100.0)) == "upgraded"
        assert len(log) == 1
        P._trip_billing_breaker("mine.example")           # the user's own provider is
        assert U.stale_candidates("u", state, P.load_manifest("u"))   # a stale candidate remains in the same season
        assert _run(U.upgrade_tick("u", now=200.0)) == "waiting"
        assert len(log) == 1                              # and it was held at the billing gate, not shot
    finally:
        P.reset_billing_breaker()


def test_a_failure_the_pipeline_already_recorded_is_not_recorded_again(monkeypatch):
    seen = []
    monkeypatch.setattr(P, "_note_generation_failure", lambda *a, **k: seen.append(a))
    st = {"failed": 0, "fails": {}, "retry_at": {}, "next_ok_at": 0.0, "rate_limited": False}
    U._note_failure("u", "u", "npc_1", st, 1.0, 0.0, U._PipelineFailure("http-500"))
    assert seen == []
    U._note_failure("u", "u", "npc_2", st, 1.0, 0.0, RuntimeError("look-write-failed"))
    assert len(seen) == 1
