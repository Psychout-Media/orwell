"""Money-safety: the ORWELL_DISABLE_IMAGE_GEN kill-switch (image-spend hard off).

The keyed nightly CI workflow (live-harness-nightly) drives a full `createCharacter` casting flow,
which fire-and-forget kicks portrait generation. DEFAULT_SETTINGS ships image gen ON with a real
model, so without a hard off switch that keyed run could POST ~15 real portraits per night — real
image-API spend.

This gate proves the kill-switch is belt-and-suspenders: BOTH the availability gate AND every
generation entry point honor it, and a kill-switched run makes NO image call at all. Plus a
control (unset ⇒ behavior unchanged) and a source-pin that the workflow sets it.

Name-agnostic (roles only). Generation is monkeypatched — no image API, no engine.
"""

import asyncio
import importlib
from pathlib import Path

import pytest

orwell_portraits = importlib.import_module("src.orwell_portraits")

_REPO_ROOT = Path(__file__).resolve().parents[2]

_PROMPTS = [
    {"houseguestId": "player", "name": "The Player", "prompt": "photoreal headshot, person A"},
    {"houseguestId": "npc:1", "name": "Houseguest One", "prompt": "photoreal headshot, person B"},
    {"houseguestId": "npc:2", "name": "Houseguest Two", "prompt": "photoreal headshot, person C"},
]


def _run(coro):
    # Run on a dedicated loop and RESTORE a fresh current loop afterward. `asyncio.run()`
    # sets the thread's current event loop to None on exit, which poisons sibling tests that
    # use the legacy `asyncio.get_event_loop().run_until_complete(...)` pattern when they land
    # on the same pytest-xdist worker process (they'd hit "There is no current event loop").
    # Keeping a valid current loop keeps this file a good citizen in the parallel suite.
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(asyncio.new_event_loop())


@pytest.fixture
def tmp_portraits(tmp_path, monkeypatch):
    """Redirect the portraits dir to a throwaway tmp tree so nothing touches the real store."""
    monkeypatch.setattr(orwell_portraits, "PORTRAITS_DIR", tmp_path / "portraits")
    return tmp_path / "portraits"


# --- the kill-switch predicate --------------------------------------------------------------

@pytest.mark.parametrize("val", ["1", "true", "TRUE", "Yes", "on", "  on  "])
def test_killswitch_truthy_spellings(monkeypatch, val):
    monkeypatch.setenv("ORWELL_DISABLE_IMAGE_GEN", val)
    assert orwell_portraits.image_gen_disabled() is True


@pytest.mark.parametrize("val", ["0", "false", "no", "off", "banana", ""])
def test_killswitch_falsy_or_malformed_is_not_set(monkeypatch, val):
    # Fail-soft: anything but a recognized truthy spelling ⇒ NOT set ⇒ normal behavior.
    monkeypatch.setenv("ORWELL_DISABLE_IMAGE_GEN", val)
    assert orwell_portraits.image_gen_disabled() is False


def test_killswitch_absent_is_not_set(monkeypatch):
    monkeypatch.delenv("ORWELL_DISABLE_IMAGE_GEN", raising=False)
    assert orwell_portraits.image_gen_disabled() is False


# --- the availability gate reports graceful absence -----------------------------------------

def test_availability_false_when_killswitch_set(monkeypatch):
    """With the kill-switch set, the roster/onboarding correctly expect NO portraits — and the
    gate short-circuits BEFORE any settings read / catalog probe (a probe would raise here)."""
    monkeypatch.setenv("ORWELL_DISABLE_IMAGE_GEN", "1")

    # Prove the gate returns before touching ai_interaction at all: make any probe explode.
    ai = importlib.import_module("src.ai_interaction")
    monkeypatch.setattr(ai, "_resolve_model", lambda *a, **k: (_ for _ in ()).throw(AssertionError("probed!")))
    monkeypatch.setattr(ai, "has_image_capable_endpoint",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("probed!")))

    assert orwell_portraits.image_generation_available("alice") is False


# --- every generation entry point no-ops AND makes no image call ----------------------------

def _boom_generate_one(*a, **k):
    raise AssertionError("_generate_one must never be reached when the kill-switch is set")


def test_generate_and_store_noop_no_image_call(tmp_portraits, monkeypatch):
    """generate_and_store returns 0-generated and never invokes the POST path (_generate_one)."""
    monkeypatch.setenv("ORWELL_DISABLE_IMAGE_GEN", "1")
    # If the pipeline reached generation, this would raise and fail the test.
    monkeypatch.setattr(orwell_portraits, "_generate_one", _boom_generate_one)

    summary = _run(orwell_portraits.generate_and_store(_PROMPTS, "alice", record_beats=False))

    assert summary == {"generated": 0, "skipped": len(_PROMPTS), "total": len(_PROMPTS)}
    # Nothing was persisted — a true no-op (no dir, no files).
    assert not (tmp_portraits / "alice").exists()


def test_backfill_missing_noop_no_image_call(monkeypatch):
    """backfill_missing short-circuits before the engine prompt-fetch AND before generate_and_store."""
    monkeypatch.setenv("ORWELL_DISABLE_IMAGE_GEN", "1")

    async def _boom_gen_store(*a, **k):
        raise AssertionError("generate_and_store must never be reached when the kill-switch is set")

    monkeypatch.setattr(orwell_portraits, "generate_and_store", _boom_gen_store)
    # get_portrait_prompt lives on orwell_engine; it must never be fetched either.
    orwell_engine = importlib.import_module("src.orwell_engine")

    async def _boom_prompt(*a, **k):
        raise AssertionError("engine prompt fetch must never be reached when the kill-switch is set")

    monkeypatch.setattr(orwell_engine, "get_portrait_prompt", _boom_prompt)

    summary = _run(orwell_portraits.backfill_missing(["npc:1", "npc:2", "player"], "alice"))
    assert summary == {"generated": 0, "skipped": 3, "total": 3}


def test_generate_one_returns_none_and_makes_no_http_call(monkeypatch):
    """The DEEPEST guard: a direct _generate_one call (bypassing the gate) makes no provider POST.

    httpx.AsyncClient and the model resolver are booby-trapped — reaching either fails the test."""
    import httpx
    monkeypatch.setenv("ORWELL_DISABLE_IMAGE_GEN", "1")

    def _boom_client(*a, **k):
        raise AssertionError("no httpx client may be constructed when the kill-switch is set")

    monkeypatch.setattr(httpx, "AsyncClient", _boom_client)
    ai = importlib.import_module("src.ai_interaction")
    monkeypatch.setattr(ai, "_resolve_model",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("resolved!")))

    assert _run(orwell_portraits._generate_one("a prompt", "alice")) is None


@pytest.mark.parametrize("disabled", [True, False])
def test_a_stale_in_flight_error_never_requeues_a_call_that_made_no_request(monkeypatch, disabled):
    """ORW-1108: an earlier in-flight 402 left behind made a call that returned None without setting an error sleep through the retry schedule (and hung CI)."""
    monkeypatch.setenv("ORWELL_DISABLE_IMAGE_GEN", "1" if disabled else "0")
    orwell_portraits._set_gen_state("http-402", "would exceed your available credits given your current in-flight requests")

    async def silent_none(*a, **k):
        return None

    async def no_sleep(*a, **k):
        raise AssertionError("requeued on a stale error")

    if not disabled:
        monkeypatch.setattr(orwell_portraits, "_generate_one_gated", silent_none)
    monkeypatch.setattr(orwell_portraits.asyncio, "sleep", no_sleep)
    assert _run(orwell_portraits._generate_one("a prompt", "alice")) is None


# --- control: unset ⇒ existing behavior unchanged -------------------------------------------

def test_unset_preserves_generation(tmp_portraits, monkeypatch):
    """With the kill-switch UNSET, generation runs exactly as before (mocked resolve — no network)."""
    monkeypatch.delenv("ORWELL_DISABLE_IMAGE_GEN", raising=False)
    monkeypatch.setattr(orwell_portraits, "image_generation_available", lambda user: True)

    async def fake_gen(prompt, user, *a, **k):
        return b"PNGBYTES-" + prompt.encode()[:4]

    monkeypatch.setattr(orwell_portraits, "_generate_one", fake_gen)

    summary = _run(orwell_portraits.generate_and_store(_PROMPTS, "alice", record_beats=False))
    assert summary["generated"] == len(_PROMPTS) and summary["total"] == len(_PROMPTS)
    for hid in ("player", "npc_1", "npc_2"):
        assert (tmp_portraits / "alice" / f"{hid}.png").exists()


# --- source-pin: the keyed workflow sets the kill-switch -------------------------------------

@pytest.mark.parametrize("rel", [
    ".github/workflows/live-harness-nightly.yml",
])
def test_keyed_workflows_set_killswitch(rel):
    """The keyed CI workflow must set ORWELL_DISABLE_IMAGE_GEN (workflow-level env) so no keyed
    step can leak image spend. Source-pin (text) + a light structural YAML check when pyyaml is
    available."""
    path = _REPO_ROOT / rel
    text = path.read_text(encoding="utf-8")
    assert "ORWELL_DISABLE_IMAGE_GEN" in text, f"{rel} must set the image-spend kill-switch"

    try:
        import yaml
    except Exception:  # pyyaml not installed — the text pin above is enough
        return
    doc = yaml.safe_load(text)
    # Workflow-level env inherited by every job/step is the robust placement we chose.
    env = (doc or {}).get("env") or {}
    assert str(env.get("ORWELL_DISABLE_IMAGE_GEN")) == "1", \
        f"{rel} should set ORWELL_DISABLE_IMAGE_GEN=1 at the workflow level"
