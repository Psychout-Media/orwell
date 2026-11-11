"""Feature 0051 — in-character cast portraits (front-end half).

Name-agnostic (roles only). Covers the FE pipeline the spec pins for pytest:
  • generation triggered on createCharacter with portraitPrompts
  • skip (silent) when image generation is unavailable / disabled — game plays identically
  • persistence: a file + manifest entry written; NOT regenerated when already present
  • cast roster route: name + status + portrait ref, and Vault-free (no hidden content)
  • factory/game scrub removes the portraits dir

Generation itself is monkeypatched (deterministic, no image API / no engine).
"""

import asyncio
import importlib
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

orwell_portraits = importlib.import_module("src.orwell_portraits")
orwell_engine = importlib.import_module("src.orwell_engine")
orwell_routes = importlib.import_module("routes.orwell_routes")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture
def tmp_portraits(tmp_path, monkeypatch):
    """Redirect the portraits dir to a throwaway tmp tree for the test."""
    d = tmp_path / "portraits"
    monkeypatch.setattr(orwell_portraits, "PORTRAITS_DIR", d)
    return d


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app)


_PROMPTS = [
    {"houseguestId": "player", "name": "The Player", "prompt": "photoreal headshot, person A"},
    {"houseguestId": "npc:1", "name": "Houseguest One", "prompt": "photoreal headshot, person B"},
    {"houseguestId": "npc:2", "name": "Houseguest Two", "prompt": "photoreal headshot, person C"},
]


# --- generation triggered on createCharacter with prompts -------------------------------

def test_generate_and_store_writes_files_and_manifest(tmp_portraits, monkeypatch):
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: True)

    async def fake_gen(prompt, user, reference_png=None):
        return b"PNGBYTES-" + prompt.encode()[:4]
    monkeypatch.setattr(orwell_portraits, "_generate_one", fake_gen)

    summary = _run(orwell_portraits.generate_and_store(_PROMPTS, "alice", record_beats=False))

    assert summary["generated"] == 3 and summary["total"] == 3
    for hid in ("player", "npc_1", "npc_2"):  # ids are sanitized for filenames
        assert (tmp_portraits / "alice" / f"{hid}.png").exists()
    manifest = orwell_portraits.load_manifest("alice")
    assert set(manifest.keys()) == {"player", "npc_1", "npc_2"}
    assert manifest["npc_1"]["name"] == "Houseguest One"


def test_create_character_tool_kicks_off_generation(tmp_portraits, monkeypatch):
    """The do_create_character tool path passes the engine's portraitPrompts to the pipeline."""
    tool_impl = importlib.import_module("src.tool_implementations")

    async def fake_create(*a, **k):
        return {"started": True, "portraitPrompts": _PROMPTS}
    monkeypatch.setattr(orwell_engine, "create_character", fake_create)

    captured = {}

    def fake_kickoff(prompts, user):
        captured["prompts"] = prompts
        captured["user"] = user
    monkeypatch.setattr(orwell_portraits, "kickoff_generation", fake_kickoff)

    res = _run(tool_impl.do_create_character('{"playerName":"P"}', owner="bob"))
    assert res["exit_code"] == 0
    assert captured["user"] == "bob"
    assert captured["prompts"] == _PROMPTS


def test_portraits_start_immediately_not_chained_behind_authoring(tmp_portraits, monkeypatch):
    """Bug B — cast portraits must start generating BY MOVE-IN, not after.

    With a cast present, createCharacter must (a) kick portrait generation off IMMEDIATELY from
    the seeded facets (in parallel with authoring), and (b) still run cast authoring with a
    `then` top-up callback. The picture must NOT be chained behind the (slow, 15-call) authoring
    pass — that is what made portraits land around/after house entry."""
    tool_impl = importlib.import_module("src.tool_implementations")
    cast_authoring = importlib.import_module("src.orwell_cast_authoring")

    async def fake_create(*a, **k):
        return {
            "started": True,
            "portraitPrompts": _PROMPTS,
            "house": [{"id": "npc:1"}, {"id": "npc:2"}],
            "player": {"name": "The Player"},
        }
    monkeypatch.setattr(orwell_engine, "create_character", fake_create)

    order = []  # record the call order so we can prove portraits don't wait on authoring

    def fake_kickoff_generation(prompts, user):
        order.append(("portraits", tuple(p["houseguestId"] for p in prompts)))
    monkeypatch.setattr(orwell_portraits, "kickoff_generation", fake_kickoff_generation)

    captured = {}

    # ANTI-SYCOPHANCY: kickoff_authoring no longer takes the player's name — NPC storylines are
    # authored player-independent, so the call carries only the cast + owner (+ the top-up callback).
    def fake_kickoff_authoring(cast, owner, then=None, on_authored=None, write=None, seed=None):
        order.append(("authoring", owner))
        captured["cast"] = cast
        captured["then"] = then  # the top-up callback must be wired (not None)
    monkeypatch.setattr(cast_authoring, "kickoff_authoring", fake_kickoff_authoring)

    res = _run(tool_impl.do_create_character('{"playerName":"P"}', owner="bob"))
    assert res["exit_code"] == 0
    # Portraits kicked off, and BEFORE authoring is even scheduled — never chained behind it.
    assert ("portraits", ("player", "npc:1", "npc:2")) in order
    assert order.index(("portraits", ("player", "npc:1", "npc:2"))) < \
        next(i for i, c in enumerate(order) if c[0] == "authoring")
    # Authoring still runs, with a top-up callback to fill any not-yet-landed face from the
    # authored facet (idempotent). It is keyed by the OWNER, never the player's identity.
    assert ("authoring", "bob") in order
    assert callable(captured.get("then"))
    # and the player's name is never threaded into authoring (storylines are player-independent)
    assert "player_name" not in str(captured.get("cast"))


# --- #976: the prewarmed branch must still shoot when the gated warm declines/no-ops -------
# When author warm ran during the interview, createCharacter routes portraits through the GATED
# `warm_portraits` (ADR 0013). But that warm DECLINES outright when author warm never truly started,
# and otherwise holds each face on a per-NPC authoring gate — so at unseal it can leave
# `portraitsStarted` false and NOTHING shoots, deferring every face to the lazy cast-window backfill.
# The fix: after the gated warm, if portraits still didn't start, fall through to the same
# unconditional seeded-facet `kickoff_generation` the no-prewarm branch uses, so faces start at
# season start, not on cast-window open.
#
# #1336 (deliberate update): the unconditional seeded-facet fall-through is the GATE-OFF path only
# (no utility model resolves / ORWELL_ALLOW_FLOOR_START — the deterministic floor IS the final cast).
# Under a resolvable model (house-entry gate ON) the fall-through must follow the SAME per-NPC
# authoring gate as the no-prewarm fallback — no floor face for an un-authored NPC (ADR 0013); the
# gate-ON half lives in test_adr0013_photo_requires_authoring.py. These three tests pin the gate-OFF
# half explicitly (they also ran gate-OFF before — no model resolves in the test env — but the stub
# makes the pinned branch unambiguous).


def _gate_off(monkeypatch):
    """Pin the house-entry gate OFF for the #976 gate-OFF-path tests (explicit, not incidental)."""
    ca = importlib.import_module("src.orwell_cast_authoring")

    async def _off(owner):
        return False
    monkeypatch.setattr(ca, "house_entry_gate_active", _off)


@pytest.fixture(autouse=True)
def _pin_house_entry_gate_off(monkeypatch):
    """ORW-251e: every createCharacter test in this file pins the house-entry gate OFF. They used to rely on "no utility model resolves in the test env", which another test's saved model settings
    can falsify on the same xdist worker: the gate then goes ON, the immediate seeded-facet kick is skipped, authoring runs first and the portraits land after it ("assert 1 < 0", fe-unit 2/2). The
    gate-ON contract is pinned in test_adr0013_photo_requires_authoring.py, which patches the gate itself."""
    _gate_off(monkeypatch)


def test_prewarmed_branch_falls_through_to_kickoff_when_warm_declines(tmp_portraits, monkeypatch):
    """#976 — prewarmed, but the gated portrait warm declines/no-ops (portraitsStarted stays false):
    with the house-entry gate OFF, createCharacter must STILL kick `kickoff_generation` immediately,
    not defer to the backfill."""
    tool_impl = importlib.import_module("src.tool_implementations")
    prewarm = importlib.import_module("src.orwell_prewarm")
    _gate_off(monkeypatch)

    async def fake_create(*a, **k):
        return {"started": True, "portraitPrompts": _PROMPTS}
    monkeypatch.setattr(orwell_engine, "create_character", fake_create)

    # Author warm ran during the interview → createCharacter takes the PREWARMED branch.
    monkeypatch.setattr(prewarm, "warm_state",
                        lambda user=None: {"authorStarted": True, "portraitsStarted": False})

    # The gated warm DECLINES / no-ops (e.g. author warm never really started, or its faces are all
    # still held on the authoring gate) — it does NOT start portraits.
    warm_called = {"n": 0}

    async def fake_warm(user=None):
        warm_called["n"] += 1
        return {"started": False, "reason": "author-warm-not-started"}
    monkeypatch.setattr(prewarm, "warm_portraits", fake_warm)

    captured = {}

    def fake_kickoff(prompts, user):
        captured["prompts"] = prompts
        captured["user"] = user
    monkeypatch.setattr(orwell_portraits, "kickoff_generation", fake_kickoff)

    res = _run(tool_impl.do_create_character('{"playerName":"P"}', owner="bob"))
    assert res["exit_code"] == 0
    # The gated warm was attempted (idempotent kick preserved) …
    assert warm_called["n"] == 1
    # … and because it declined, generation STILL started immediately (no backfill deferral).
    assert captured.get("user") == "bob"
    assert captured.get("prompts") == _PROMPTS


def test_prewarmed_branch_does_not_double_shoot_when_warm_started_portraits(tmp_portraits, monkeypatch):
    """#976 idempotency guard — when the gated warm DID start portraits (portraitsStarted true), the
    fall-through must NOT also fire `kickoff_generation` (no duplicate generation / double budget)."""
    tool_impl = importlib.import_module("src.tool_implementations")
    prewarm = importlib.import_module("src.orwell_prewarm")
    _gate_off(monkeypatch)

    async def fake_create(*a, **k):
        return {"started": True, "portraitPrompts": _PROMPTS}
    monkeypatch.setattr(orwell_engine, "create_character", fake_create)

    monkeypatch.setattr(prewarm, "warm_state",
                        lambda user=None: {"authorStarted": True, "portraitsStarted": True})

    async def fake_warm(user=None):
        return {"started": True}
    monkeypatch.setattr(prewarm, "warm_portraits", fake_warm)

    called = {"n": 0}

    def fake_kickoff(prompts, user):
        called["n"] += 1
    monkeypatch.setattr(orwell_portraits, "kickoff_generation", fake_kickoff)

    res = _run(tool_impl.do_create_character('{"playerName":"P"}', owner="bob"))
    assert res["exit_code"] == 0
    # The gated warm owns the faces — the immediate kick must NOT also fire.
    assert called["n"] == 0


def test_prewarmed_fall_through_is_fail_soft_with_no_image_provider(tmp_portraits, monkeypatch):
    """#976 fail-soft — the declined-warm fall-through routes through the standard, availability-gated
    pipeline; with NO image provider it is a silent no-op that NEVER raises / blocks game start."""
    tool_impl = importlib.import_module("src.tool_implementations")
    prewarm = importlib.import_module("src.orwell_prewarm")
    _gate_off(monkeypatch)

    async def fake_create(*a, **k):
        return {"started": True, "portraitPrompts": _PROMPTS}
    monkeypatch.setattr(orwell_engine, "create_character", fake_create)

    monkeypatch.setattr(prewarm, "warm_state",
                        lambda user=None: {"authorStarted": True, "portraitsStarted": False})

    async def fake_warm(user=None):
        return {"started": False, "reason": "author-warm-not-started"}
    monkeypatch.setattr(prewarm, "warm_portraits", fake_warm)

    # No image provider → generation is unavailable; the real kickoff/generate path must no-op silently.
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: True)

    async def boom(prompt, user, reference_png=None):
        raise AssertionError("generation must not run when unavailable")
    # Force the availability gate closed so the whole pipeline is a true no-op even if scheduled.
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: False)
    monkeypatch.setattr(orwell_portraits, "_generate_one", boom)

    res = _run(tool_impl.do_create_character('{"playerName":"P"}', owner="carol"))
    # Game start completed cleanly; nothing raised; no portraits dir created.
    assert res["exit_code"] == 0
    assert not (tmp_portraits / "carol").exists()


# --- graceful absence: skip silently when generation is unavailable ---------------------

def test_skips_silently_when_generation_unavailable(tmp_portraits, monkeypatch):
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: False)

    # If it ever tried to generate, this would error the test (it must NOT be called).
    async def boom(prompt, user, reference_png=None):
        raise AssertionError("generation must not run when unavailable")
    monkeypatch.setattr(orwell_portraits, "_generate_one", boom)

    summary = _run(orwell_portraits.generate_and_store(_PROMPTS, "carol"))
    assert summary["generated"] == 0
    assert summary["skipped"] == 3
    # No directory/manifest created — the game plays identically with no portraits.
    assert not (tmp_portraits / "carol").exists()


def test_image_settings_disabled_means_unavailable(tmp_portraits, monkeypatch):
    monkeypatch.setattr(orwell_portraits, "_image_settings", lambda user: (False, "some-model", "medium"))
    assert orwell_portraits.image_generation_available("dave") is False


# --- persistence: not regenerated when already present ----------------------------------

def test_not_regenerated_when_already_stored(tmp_portraits, monkeypatch):
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: True)

    calls = {"n": 0}

    async def fake_gen(prompt, user, reference_png=None):
        calls["n"] += 1
        return b"PNG"
    monkeypatch.setattr(orwell_portraits, "_generate_one", fake_gen)

    _run(orwell_portraits.generate_and_store(_PROMPTS, "erin", record_beats=False))
    assert calls["n"] == 3
    # Second run (a "restart"): every portrait already on disk → no regeneration.
    summary = _run(orwell_portraits.generate_and_store(_PROMPTS, "erin", record_beats=False))
    assert calls["n"] == 3  # unchanged
    assert summary["generated"] == 0 and summary["skipped"] == 3


def test_concurrent_runs_generate_each_id_exactly_once(tmp_portraits, monkeypatch):
    """#998: two overlapping generate_and_store runs for the SAME ids must not double-generate.

    On-disk idempotency alone (portrait_file is None) can't catch the not-yet-written tail when two
    runs (eager fall-through × /roster backfill × per-NPC warm) pick up the same id before either
    writes it. The per-(user,id) in-flight claim set is the precise guard. fake_gen blocks on a
    barrier so BOTH runs are simultaneously past the claim point before any write lands — without
    the claim set, both would generate every id.
    """
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: True)

    NUM_RUNS = 2
    EXPECTED = len(_PROMPTS)  # one generation per distinct id, total
    per_id_calls = {}
    release = asyncio.Event()
    inflight = {"n": 0}

    async def fake_gen(prompt, user, reference_png=None):
        # Tag the call by its prompt (1:1 with id in _PROMPTS) so we can count per-id generations.
        per_id_calls[prompt] = per_id_calls.get(prompt, 0) + 1
        # Each run processes ids sequentially and blocks here on its FIRST generate, so at the
        # overlap point exactly NUM_RUNS generations are simultaneously in flight (claimed, not yet
        # written) — the precise window the bug exploited. Hold them all until both runs are here,
        # THEN release so they finish; without the claim set both runs would generate every id.
        inflight["n"] += 1
        if inflight["n"] >= NUM_RUNS:
            release.set()
        # Bounded wait: a logic deadlock fails loudly instead of hanging the suite.
        await asyncio.wait_for(release.wait(), timeout=5)
        return b"PNG-" + prompt.encode()[:6]
    monkeypatch.setattr(orwell_portraits, "_generate_one", fake_gen)

    # Belt-and-suspenders: start from a clean in-flight map for this user.
    orwell_portraits._INFLIGHT.pop("zoe", None)

    async def both():
        return await asyncio.gather(
            orwell_portraits.generate_and_store(_PROMPTS, "zoe", record_beats=False),
            orwell_portraits.generate_and_store(_PROMPTS, "zoe", record_beats=False),
        )
    _run(both())

    # Each distinct prompt/id was generated EXACTLY once across the two concurrent runs.
    assert all(c == 1 for c in per_id_calls.values()), per_id_calls
    assert sum(per_id_calls.values()) == EXPECTED
    # …and each portrait landed on disk once.
    for hid in ("player", "npc_1", "npc_2"):
        assert (tmp_portraits / "zoe" / f"{hid}.png").exists()
    # The claim set is released (no leaked claims) after the runs complete.
    assert not orwell_portraits._INFLIGHT.get("zoe")


def test_portrait_ref_points_at_route_only_when_file_exists(tmp_portraits, monkeypatch):
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: True)

    async def fake_gen(prompt, user, reference_png=None):
        return b"PNG"
    monkeypatch.setattr(orwell_portraits, "_generate_one", fake_gen)

    assert orwell_portraits.portrait_ref("fay", "npc:1") is None  # nothing yet
    _run(orwell_portraits.generate_and_store(_PROMPTS[:1] + [_PROMPTS[1]], "fay", record_beats=False))
    # The ref points at the route AND carries the per-cast cache-busting version (`?v=`).
    ref = orwell_portraits.portrait_ref("fay", "npc:1")
    epoch = orwell_portraits._load_cast_epoch("fay")
    assert epoch and ref == f"/api/orwell/portrait/npc_1?v={epoch}"
    # A scrubbed file → ref goes back to None (no broken <img>).
    (tmp_portraits / "fay" / "npc_1.png").unlink()
    assert orwell_portraits.portrait_ref("fay", "npc:1") is None


# --- cross-season: a NEW cast on REUSED role ids never inherits an old face ----------------
# Root cause #1 (portrait id reused every season) + #3 (generate-once skips the new cast). The
# engine hands out role ids (`npc:3`) that are byte-identical every season, so a reset whose
# portrait scrub was skipped/failed leaves last season's face on the new houseguest at that id.

def test_new_cast_on_reused_ids_wipes_and_regenerates_with_a_fresh_version(tmp_portraits, monkeypatch):
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: True)

    async def fake_gen(prompt, user, reference_png=None):
        return b"PNG:" + prompt.encode()  # bytes track the prompt so we can spot a regen
    monkeypatch.setattr(orwell_portraits, "_generate_one", fake_gen)

    cast_a = [
        {"houseguestId": "npc:1", "name": "Houseguest One", "prompt": "A-one"},
        {"houseguestId": "npc:2", "name": "Houseguest Two", "prompt": "A-two"},
    ]
    _run(orwell_portraits.generate_and_store(cast_a, "u", record_beats=False))
    bytes_a = (tmp_portraits / "u" / "npc_1.png").read_bytes()
    epoch_a = orwell_portraits._load_cast_epoch("u")
    assert epoch_a and orwell_portraits.portrait_ref("u", "npc:1").endswith(f"?v={epoch_a}")

    # A NEW season's cast lands on the SAME role ids with DIFFERENT names, and the reset's
    # portrait scrub did NOT run (we deliberately do not call scrub_user — simulating the bug).
    cast_b = [
        {"houseguestId": "npc:1", "name": "Fresh Alpha", "prompt": "B-one"},
        {"houseguestId": "npc:2", "name": "Fresh Beta", "prompt": "B-two"},
    ]
    summary = _run(orwell_portraits.generate_and_store(cast_b, "u", record_beats=False))

    # The stale faces were wiped and regenerated for the new cast (root cause #1/#3 fixed)…
    assert summary["generated"] == 2
    bytes_b = (tmp_portraits / "u" / "npc_1.png").read_bytes()
    assert bytes_b == b"PNG:B-one" and bytes_b != bytes_a
    assert orwell_portraits.load_manifest("u")["npc_1"]["name"] == "Fresh Alpha"
    # …and the cache-busting version rotated, so a 24h-cached browser fetches the new face.
    epoch_b = orwell_portraits._load_cast_epoch("u")
    assert epoch_b and epoch_b != epoch_a
    assert orwell_portraits.portrait_ref("u", "npc:1").endswith(f"?v={epoch_b}")


def test_same_season_rerun_keeps_one_persisted_image_per_npc(tmp_portraits, monkeypatch):
    """Generate-once is preserved WITHIN a season: one image per NPC persists, the URL version is
    stable, and a re-run (backfill / restart) regenerates nothing — the requested behavior."""
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: True)
    calls = []

    async def fake_gen(prompt, user, reference_png=None):
        calls.append(prompt)
        return b"PNG:" + prompt.encode() + b":" + str(len(calls)).encode()
    monkeypatch.setattr(orwell_portraits, "_generate_one", fake_gen)

    cast = [
        {"houseguestId": "npc:1", "name": "Houseguest One", "prompt": "one"},
        {"houseguestId": "npc:2", "name": "Houseguest Two", "prompt": "two"},
    ]
    _run(orwell_portraits.generate_and_store(cast, "u", record_beats=False))
    bytes_first = (tmp_portraits / "u" / "npc_1.png").read_bytes()
    epoch_first = orwell_portraits._load_cast_epoch("u")
    calls_after_first = len(calls)

    # Same cast (same names): generate-once must hold — nothing regenerated, version unchanged.
    summary = _run(orwell_portraits.generate_and_store(cast, "u", record_beats=False))
    assert summary["generated"] == 0 and summary["skipped"] == 2
    assert len(calls) == calls_after_first  # no fresh generation calls
    assert (tmp_portraits / "u" / "npc_1.png").read_bytes() == bytes_first  # same persisted image
    assert orwell_portraits._load_cast_epoch("u") == epoch_first  # stable URL version all season


# --- 0065 follow-up: the facet FINGERPRINT re-shoot backstop ----------------------------
# Generate-once versions a face by id+name within a season — but a houseguest's deep FACET can
# change at the SAME id+name (the no-key→key path, or a seeded-floor shot that predates authoring).
# The engine bakes the full facet into the deterministic portrait PROMPT, so a changed prompt at an
# unchanged id+name means the stored face is stale and must be re-shot.

def test_changed_facet_prompt_reshoots_same_houseguest(tmp_portraits, monkeypatch):
    """A face shot from prompt A is RE-SHOT when the prompt changes to B for the SAME id+name."""
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: True)

    async def fake_gen(prompt, user, reference_png=None):
        return b"PNG:" + prompt.encode()  # bytes track the prompt so a re-shoot is visible
    monkeypatch.setattr(orwell_portraits, "_generate_one", fake_gen)

    # A seeded-floor portrait shot from facet/prompt A.
    cast_a = [{"houseguestId": "npc:1", "name": "Houseguest One", "prompt": "facet-A"}]
    _run(orwell_portraits.generate_and_store(cast_a, "u", record_beats=False))
    bytes_a = (tmp_portraits / "u" / "npc_1.png").read_bytes()
    assert bytes_a == b"PNG:facet-A"
    fp_a = orwell_portraits.load_manifest("u")["npc_1"]["fingerprint"]
    assert fp_a  # a fingerprint of the prompt was stamped

    # The deep facet lands (same id, same name) → a DIFFERENT prompt → the stale face is re-shot.
    cast_b = [{"houseguestId": "npc:1", "name": "Houseguest One", "prompt": "facet-B-deeper"}]
    summary = _run(orwell_portraits.generate_and_store(cast_b, "u", record_beats=False))

    assert summary["generated"] == 1  # regeneration was invoked
    bytes_b = (tmp_portraits / "u" / "npc_1.png").read_bytes()
    assert bytes_b == b"PNG:facet-B-deeper" and bytes_b != bytes_a  # the image changed
    fp_b = orwell_portraits.load_manifest("u")["npc_1"]["fingerprint"]
    assert fp_b and fp_b != fp_a  # the stored fingerprint tracks the new facet


def test_reshoot_in_place_rotates_the_cache_epoch(tmp_portraits, monkeypatch):
    """#531 — when portrait BYTES are replaced in place (a mid-season facet re-shoot), the cast
    cache epoch must ROTATE so the `?v=<epoch>` URL changes and a browser holding the stale face
    (Cache-Control: max-age=86400) fetches the re-shot one. Without this, both sessions diverge."""
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: True)

    async def fake_gen(prompt, user, reference_png=None):
        return b"PNG:" + prompt.encode()
    monkeypatch.setattr(orwell_portraits, "_generate_one", fake_gen)

    cast_a = [{"houseguestId": "npc:1", "name": "Houseguest One", "prompt": "facet-A"}]
    _run(orwell_portraits.generate_and_store(cast_a, "u", record_beats=False))
    epoch_a = orwell_portraits._load_cast_epoch("u")
    assert epoch_a  # an epoch was minted on first persist

    # Same id+name, a CHANGED facet → bytes replaced in place → the epoch must rotate.
    cast_b = [{"houseguestId": "npc:1", "name": "Houseguest One", "prompt": "facet-B-deeper"}]
    _run(orwell_portraits.generate_and_store(cast_b, "u", record_beats=False))
    epoch_b = orwell_portraits._load_cast_epoch("u")
    assert epoch_b and epoch_b != epoch_a, "cache epoch did not rotate on an in-place re-shoot"


def test_first_generation_does_not_rotate_epoch(tmp_portraits, monkeypatch):
    """#531 guard: a FIRST-time generation (no prior bytes) keeps the freshly-minted epoch stable —
    only an in-place byte REPLACEMENT rotates it, so a clean season keeps one URL per houseguest."""
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: True)

    async def fake_gen(prompt, user, reference_png=None):
        return b"PNG:" + prompt.encode()
    monkeypatch.setattr(orwell_portraits, "_generate_one", fake_gen)

    cast = [
        {"houseguestId": "npc:1", "name": "Houseguest One", "prompt": "facet-A"},
        {"houseguestId": "npc:2", "name": "Houseguest Two", "prompt": "facet-B"},
    ]
    _run(orwell_portraits.generate_and_store(cast, "u", record_beats=False))
    epoch_after_first = orwell_portraits._load_cast_epoch("u")
    # Re-running with UNCHANGED facets shoots nothing new → no in-place replacement → stable epoch.
    _run(orwell_portraits.generate_and_store(cast, "u", record_beats=False))
    assert orwell_portraits._load_cast_epoch("u") == epoch_after_first


def test_unchanged_facet_prompt_does_not_reshoot(tmp_portraits, monkeypatch):
    """An UNCHANGED prompt does NOT re-shoot — generate-once-per-season holds (single generation)."""
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: True)
    calls = {"n": 0}

    async def fake_gen(prompt, user, reference_png=None):
        calls["n"] += 1
        return b"PNG:" + prompt.encode() + b":" + str(calls["n"]).encode()
    monkeypatch.setattr(orwell_portraits, "_generate_one", fake_gen)

    cast = [{"houseguestId": "npc:1", "name": "Houseguest One", "prompt": "facet-A"}]
    _run(orwell_portraits.generate_and_store(cast, "u", record_beats=False))
    assert calls["n"] == 1
    bytes_first = (tmp_portraits / "u" / "npc_1.png").read_bytes()

    # Same prompt (unchanged facet): generate-once must hold — nothing regenerated.
    summary = _run(orwell_portraits.generate_and_store(cast, "u", record_beats=False))
    assert summary["generated"] == 0 and summary["skipped"] == 1
    assert calls["n"] == 1  # exactly one generation, never a second
    assert (tmp_portraits / "u" / "npc_1.png").read_bytes() == bytes_first  # same persisted image


def test_legacy_entry_without_fingerprint_is_not_mass_reshot(tmp_portraits, monkeypatch):
    """A legacy manifest entry with NO fingerprint backfills the field WITHOUT regenerating —
    so the change doesn't trigger a mass re-shoot of every existing portrait."""
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: True)
    calls = {"n": 0}

    async def fake_gen(prompt, user, reference_png=None):
        calls["n"] += 1
        return b"PNG:" + prompt.encode()
    monkeypatch.setattr(orwell_portraits, "_generate_one", fake_gen)

    # Seed a LEGACY (pre-fingerprint) portrait: write the file + a manifest entry with NO
    # fingerprint, exactly as a pre-this-change build would have left it on disk.
    d = tmp_portraits / "u"
    d.mkdir(parents=True, exist_ok=True)
    (d / "npc_1.png").write_bytes(b"PNG:legacy")
    orwell_portraits._save_manifest(
        "u", {"npc_1": {"file": "npc_1.png", "name": "Houseguest One", "source": "generated"}})

    cast = [{"houseguestId": "npc:1", "name": "Houseguest One", "prompt": "facet-A"}]
    summary = _run(orwell_portraits.generate_and_store(cast, "u", record_beats=False))

    # The missing field must NOT force a re-shoot — nothing was generated…
    assert summary["generated"] == 0 and summary["skipped"] == 1
    assert calls["n"] == 0
    assert (tmp_portraits / "u" / "npc_1.png").read_bytes() == b"PNG:legacy"  # untouched image
    # …but the fingerprint self-healed onto the entry so a FUTURE genuine facet change re-shoots.
    fp = orwell_portraits.load_manifest("u")["npc_1"].get("fingerprint")
    assert fp == orwell_portraits._prompt_fingerprint("facet-A")

    # Prove the self-heal works: a DIFFERENT prompt now does re-shoot (no longer a legacy entry).
    summary2 = _run(orwell_portraits.generate_and_store(
        [{"houseguestId": "npc:1", "name": "Houseguest One", "prompt": "facet-B"}],
        "u", record_beats=False))
    assert summary2["generated"] == 1 and calls["n"] == 1
    assert (tmp_portraits / "u" / "npc_1.png").read_bytes() == b"PNG:facet-B"


# --- the cast roster route: name + status + portrait, Vault-free ------------------------

_HIDDEN_SENTINEL = "VAULT_SECRET_DO_NOT_LEAK"


def test_roster_returns_name_status_portrait(tmp_portraits, client, monkeypatch):
    async def fake_state(user=None, **k):
        return {
            "started": True,
            "player": {"id": "player", "name": "The Player", "status": "active"},
            "house": [
                {"id": "npc:1", "name": "Houseguest One", "status": "active"},
                {"id": "npc:2", "name": "Houseguest Two", "status": "jury"},
                {"id": "npc:3", "name": "Houseguest Three", "status": "evicted"},
            ],
        }
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: True)
    # One houseguest has a stored portrait; the rest fall back to null (placeholder client-side).
    monkeypatch.setattr(orwell_portraits, "portrait_ref",
                        lambda user, hid: "/api/orwell/portrait/npc_1" if hid == "npc:1" else None)

    body = client.get("/api/orwell/roster").json()
    roster = body["roster"]
    assert body["imagesAvailable"] is True
    assert len(roster) == 4  # player + 3 house
    by_name = {c["name"]: c for c in roster}
    assert by_name["The Player"]["isPlayer"] is True
    assert by_name["Houseguest One"]["portrait"] == "/api/orwell/portrait/npc_1"
    assert by_name["Houseguest Two"]["status"] == "jury"
    assert by_name["Houseguest Three"]["status"] == "evicted"  # evicted stays on the roster
    assert by_name["Houseguest Two"]["portrait"] is None


def test_roster_is_vault_free(tmp_portraits, client, monkeypatch):
    # Even if the engine projection ever carried hidden content, the roster only forwards
    # name + status + portrait — never a stat / relationship / soul field.
    async def fake_state(user=None, **k):
        return {
            "started": True,
            "player": {"id": "player", "name": "The Player", "status": "active",
                       "secretTrust": _HIDDEN_SENTINEL, "threat": 99},
            "house": [
                {"id": "npc:1", "name": "Houseguest One", "status": "active",
                 "soul": _HIDDEN_SENTINEL, "affinity": 0.7, "hiddenPlan": _HIDDEN_SENTINEL},
            ],
        }
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: False)

    r = client.get("/api/orwell/roster")
    text = r.text
    assert _HIDDEN_SENTINEL not in text
    for forbidden in ("secretTrust", "threat", "soul", "affinity", "hiddenPlan"):
        assert forbidden not in text
    cards = r.json()["roster"]
    # Only the whitelisted public keys are present per card. `authored` is the engine's
    # Vault-free deep-profile boolean (true/false only — no secret content) that drives the
    # cast-authoring backfill; it is a public projection field, not a Vault leak.
    allowed = {"id", "name", "status", "isPlayer", "portrait", "authored"}
    for c in cards:
        assert set(c.keys()) <= allowed


def test_roster_empty_pre_game(tmp_portraits, client, monkeypatch):
    async def fake_state(user=None, **k):
        return {"started": False}
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    body = client.get("/api/orwell/roster").json()
    assert body == {"roster": [], "imagesAvailable": False}


def test_roster_fails_open_on_engine_error(tmp_portraits, client, monkeypatch):
    # No prior good roster cached for this (anonymous) user → the route must fail open to empty.
    # (L15 adds a last-good cache; clearing it here pins the genuine "engine down, never had a
    #  cast" path — the stale-serving behavior is covered by its own test below.)
    orwell_routes._LAST_ROSTER.clear()

    async def boom(user=None, **k):
        raise RuntimeError("engine unreachable")
    monkeypatch.setattr(orwell_engine, "get_game_state", boom)
    r = client.get("/api/orwell/roster")
    assert r.status_code == 200
    assert r.json() == {"roster": [], "imagesAvailable": False}


# --- the portrait-serving route ---------------------------------------------------------

def test_portrait_route_serves_stored_png(tmp_portraits, client, monkeypatch):
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: True)

    async def fake_gen(prompt, user, reference_png=None):
        return b"\x89PNG\r\n\x1a\n-fake"
    monkeypatch.setattr(orwell_portraits, "_generate_one", fake_gen)
    _run(orwell_portraits.generate_and_store([_PROMPTS[1]], "default", record_beats=False))

    r = client.get("/api/orwell/portrait/npc:1")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/png")
    assert r.content.startswith(b"\x89PNG")


def test_portrait_route_404_when_missing(tmp_portraits, client):
    r = client.get("/api/orwell/portrait/nobody")
    assert r.status_code == 404


# --- image-beat recording on first show -------------------------------------------------

def test_records_image_beat_for_each_shown_portrait(tmp_portraits, monkeypatch):
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: True)

    async def fake_gen(prompt, user, reference_png=None):
        return b"PNG"
    monkeypatch.setattr(orwell_portraits, "_generate_one", fake_gen)

    beats = []

    async def fake_beat(houseguest_id, image_ref, user=None):
        beats.append((houseguest_id, image_ref, user))
        return {"ok": True}
    monkeypatch.setattr(orwell_engine, "record_image_beat", fake_beat)

    _run(orwell_portraits.generate_and_store(_PROMPTS, "gail", record_beats=True))
    assert len(beats) == 3
    ids = {b[0] for b in beats}
    assert ids == {"player", "npc:1", "npc:2"}
    for hid, ref, user in beats:
        assert user == "gail"
        assert ref.startswith("/api/orwell/portrait/")


# --- scrub (factory / game reset) -------------------------------------------------------

def test_scrub_user_and_scrub_all_remove_portraits(tmp_portraits, monkeypatch):
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: True)

    async def fake_gen(prompt, user, reference_png=None):
        return b"PNG"
    monkeypatch.setattr(orwell_portraits, "_generate_one", fake_gen)

    _run(orwell_portraits.generate_and_store(_PROMPTS, "hank", record_beats=False))
    _run(orwell_portraits.generate_and_store(_PROMPTS, "iris", record_beats=False))
    assert (tmp_portraits / "hank").exists() and (tmp_portraits / "iris").exists()

    orwell_portraits.scrub_user("hank")
    assert not (tmp_portraits / "hank").exists()
    assert (tmp_portraits / "iris").exists()  # other users untouched

    orwell_portraits.scrub_all()
    assert not tmp_portraits.exists()


def test_factory_reset_script_scrubs_portraits_dir():
    """The reset scripts remove the cast portraits (feature 0051).

    The factory reset delegates to orwell-oobe-reset.sh, which wipes the WHOLE front-end store
    (portraits included) while keeping the LLM config — proven end-to-end in
    test_factory_reset_keeps_llm_config.py. The game reset preserves the FE store, so it must
    name the portraits dir explicitly.
    """
    root = Path(__file__).resolve().parents[2]
    factory = (root / "deploy" / "orwell-factory-reset.sh").read_text()
    oobe = (root / "deploy" / "orwell-oobe-reset.sh").read_text()
    game = (root / "deploy" / "orwell-game-reset.sh").read_text()
    # Factory reset hands off to the OOBE-reset implementation (which scrubs the FE store)…
    assert "orwell-oobe-reset.sh" in factory
    # …and that implementation wipes the front-end store wholesale (portraits live under it).
    assert "scrubbing front-end store" in oobe.lower() or "fe_data_dir" in oobe.lower()
    # Game reset preserves the FE store, so it MUST name the portraits dir explicitly.
    assert "portraits" in game.lower()
    assert "PORTRAITS_DIR" in game
