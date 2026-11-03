"""Owner directive 2026-07-11 — the STRICT enrichment policy ("never fail soft at runtime").

The gate file for `src/enrichment_policy.py` + its wiring: the fail-soft enrichment pattern
(no model ⇒ silent skip ⇒ deterministic floor) has a documented silent-death failure class
(recordCastProfile / recordWorldSnapshot silently no-op'd for weeks). The policy makes those
failures LOUD:

  * default `strict` (settings key → env seed → code default);
  * strict + an unconfigured class ⇒ game creation REFUSES loudly, naming the unwired class,
    and the engine create is NEVER called (no silent floor season);
  * strict + a failing call ⇒ bounded retry, then a loud ERROR + a failure-ledger entry;
  * soft ⇒ the legacy behavior byte-identical (single attempts, silent skips, no ledger);
  * the test lanes + the golden driver + the smoke/matrix harnesses pin `soft`.

Roles only — every string is a generic probe, never cast material.
"""
import importlib
import json
import os

import pytest

ep = importlib.import_module("src.enrichment_policy")
ca = importlib.import_module("src.orwell_cast_authoring")
ti = importlib.import_module("src.tool_implementations")
oe = importlib.import_module("src.orwell_engine")

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(FRONTEND)


def _read(rel, root=FRONTEND):
    with open(os.path.join(root, rel), encoding="utf-8") as f:
        return f.read()


def _no_setting(monkeypatch):
    """Blank out the settings tier so the env/default tiers are what resolve."""
    import src.settings as settings_mod
    monkeypatch.setattr(settings_mod, "get_setting",
                        lambda key, default=None: "" if key == "enrichment_policy" else default)


# ── policy resolution: env seed (the harness pin) → settings → the STRICT default ────────
# (Env-first since the 2026-07-13 owner ruling: the shipped DEFAULT_SETTINGS seed is now an
# EXPLICIT "strict" that merges into every get_setting read, so the settings tier can no longer
# distinguish an operator's persisted choice from the shipped default — the env seed must win or
# the stubbed lanes' "soft" pin would be silently shadowed. Prod never sets the env var.)

def test_default_policy_is_strict(monkeypatch):
    _no_setting(monkeypatch)
    monkeypatch.delenv("ORWELL_ENRICHMENT_POLICY", raising=False)
    assert ep.current_policy() == "strict"
    assert ep.is_strict() is True


def test_shipped_settings_seed_is_an_explicit_strict():
    """Owner ruling 2026-07-13 (prod debug-bundle audit): the shipped default is a VISIBLE
    'strict' in the settings seed — never an empty string that resolves strict only by code
    default (intent must be readable in every store snapshot)."""
    from src.settings import DEFAULT_SETTINGS
    assert DEFAULT_SETTINGS["enrichment_policy"] == "strict"


def test_env_seed_soft_wins_over_the_default(monkeypatch):
    _no_setting(monkeypatch)
    monkeypatch.setenv("ORWELL_ENRICHMENT_POLICY", "soft")
    assert ep.current_policy() == "soft"
    assert ep.is_strict() is False


def test_garbage_env_falls_back_to_strict(monkeypatch):
    _no_setting(monkeypatch)
    monkeypatch.setenv("ORWELL_ENRICHMENT_POLICY", "yolo")
    assert ep.current_policy() == "strict"


def test_env_seed_wins_over_the_settings_key(monkeypatch):
    """The env seed is the HARNESS PIN and sits ABOVE the settings tier (2026-07-13): with the
    explicit 'strict' shipped in DEFAULT_SETTINGS (merged into every read), a lane pinned soft
    via the env must stay soft even though the settings tier reads 'strict'."""
    import src.settings as settings_mod
    monkeypatch.setattr(settings_mod, "get_setting",
                        lambda key, default=None: "strict" if key == "enrichment_policy" else default)
    monkeypatch.setenv("ORWELL_ENRICHMENT_POLICY", "soft")
    assert ep.current_policy() == "soft"


def test_settings_key_wins_when_no_env_is_set(monkeypatch):
    """Prod shape: no env seed ⇒ the runtime-editable settings key is authoritative (an
    operator's 'soft' persists and wins over the code default)."""
    import src.settings as settings_mod
    monkeypatch.setattr(settings_mod, "get_setting",
                        lambda key, default=None: "soft" if key == "enrichment_policy" else default)
    monkeypatch.delenv("ORWELL_ENRICHMENT_POLICY", raising=False)
    assert ep.current_policy() == "soft"


def test_garbage_setting_falls_through_with_no_env(monkeypatch):
    import src.settings as settings_mod
    monkeypatch.setattr(settings_mod, "get_setting",
                        lambda key, default=None: "loud" if key == "enrichment_policy" else default)
    monkeypatch.delenv("ORWELL_ENRICHMENT_POLICY", raising=False)
    assert ep.current_policy() == "strict"


def test_the_suite_itself_runs_pinned_soft():
    """The conftest env seed: every stubbed test lane defaults to the LEGACY soft policy, so the
    existing fail-soft contracts ("absent ⇒ byte-identical floor") stay green untouched."""
    assert os.environ.get("ORWELL_ENRICHMENT_POLICY") == "soft"


# ── the failure ledger ───────────────────────────────────────────────────────────────

def test_ledger_records_and_clears():
    ep.clear_failures("erin")
    ep.record_failure("erin", "cast-authoring", "probe reason", detail="probe detail")
    rows = ep.failures("erin")
    assert len(rows) == 1
    assert rows[0]["callClass"] == "cast-authoring" and rows[0]["reason"] == "probe reason"
    assert rows[0]["detail"] == "probe detail" and rows[0]["at"] > 0
    ep.clear_failures("erin")
    assert ep.failures("erin") == []


def test_ledger_is_bounded():
    ep.clear_failures("erin")
    for i in range(200):
        ep.record_failure("erin", "zeitgeist", f"r{i}")
    assert len(ep.failures("erin")) == ep._MAX_FAILURES_PER_USER


# ── strict + unconfigured class ⇒ game creation REFUSES loudly (no silent floor) ─────────

@pytest.fixture()
def _creation_stubs(monkeypatch):
    """Stub the engine seams around do_create_character (mirrors test_1313's isolate fixture)."""
    calls = {"create": 0}

    async def fake_create(*a, **k):
        calls["create"] += 1
        return {"started": True, "house": [], "portraitPrompts": []}
    monkeypatch.setattr(oe, "create_character", fake_create)

    async def fake_state(*a, **k):
        return {"started": False}
    monkeypatch.setattr(oe, "get_game_state", fake_state)

    cid = importlib.import_module("src.orwell_cast_identity")
    monkeypatch.setattr(cid, "kickoff_identity", lambda *a, **k: None)
    zg = importlib.import_module("src.orwell_zeitgeist")
    monkeypatch.setattr(zg, "kickoff_capture", lambda *a, **k: None)
    return calls


async def _none(owner, **k):
    return None


async def _model(owner, **k):
    async def _fn(messages):
        return "{}"
    return _fn


def test_strict_unwired_class_refuses_game_creation(monkeypatch, run, _creation_stubs):
    """STRICT + no model for any enrichment class ⇒ the creation flow is REFUSED with a clear,
    player-visible error NAMING the unwired classes; the engine create is never reached; the
    failure ledger carries the refusal (the admin surface)."""
    monkeypatch.setenv("ORWELL_ENRICHMENT_POLICY", "strict")
    monkeypatch.setattr(ca, "resolve_authoring_llm_fn", _none)
    monkeypatch.setattr(ca, "_resolve_llm_fn", _none)
    ep.clear_failures("frank")

    res = run(ti.do_create_character('{"playerName":"P"}', owner="frank"))
    assert res.get("exit_code") == 1, "creation must surface as a loud tool error"
    err = res.get("error") or ""
    assert "cast-authoring" in err, "the refusal must NAME the unwired class"
    assert "zeitgeist" in err
    assert _creation_stubs["create"] == 0, "the engine create must never run on a strict refusal"
    classes = {r["callClass"] for r in ep.failures("frank")}
    assert "cast-authoring" in classes and "zeitgeist" in classes


def test_strict_with_models_wired_does_not_refuse(monkeypatch, run, _creation_stubs):
    """STRICT + every class resolvable ⇒ creation proceeds (strict only bites on a real gap)."""
    monkeypatch.setenv("ORWELL_ENRICHMENT_POLICY", "strict")
    monkeypatch.setattr(ca, "resolve_authoring_llm_fn", _model)
    monkeypatch.setattr(ca, "_resolve_llm_fn", _model)
    # keep the house-entry gate out of the frame — this test drives only the strict preflight
    monkeypatch.setenv("ORWELL_ALLOW_FLOOR_START", "1")

    res = run(ti.do_create_character('{"playerName":"P"}', owner="gina"))
    assert res.get("exit_code") == 0
    assert json.loads(res["output"]).get("started") is True
    assert _creation_stubs["create"] == 1


def test_soft_unwired_class_creates_byte_identical_legacy(monkeypatch, run, _creation_stubs):
    """SOFT + no model ⇒ the legacy behavior: creation proceeds onto the deterministic floor,
    silently (no refusal, no ledger entry)."""
    monkeypatch.setenv("ORWELL_ENRICHMENT_POLICY", "soft")
    monkeypatch.setattr(ca, "resolve_authoring_llm_fn", _none)
    monkeypatch.setattr(ca, "_resolve_llm_fn", _none)
    ep.clear_failures("hank")

    res = run(ti.do_create_character('{"playerName":"P"}', owner="hank"))
    assert res.get("exit_code") == 0
    assert json.loads(res["output"]).get("started") is True
    assert _creation_stubs["create"] == 1
    assert ep.failures("hank") == [], "soft must stay silent — no ledger entries"


# ── strict + a FAILING call ⇒ bounded retry, then a loud ledgered error ──────────────────

def test_strict_failing_authoring_call_lands_in_the_ledger(monkeypatch, run):
    """A model that never yields usable JSON: the existing retry ladder runs, the NPC falls to the
    floor, and under STRICT the run records a loud failure (soft records nothing — below)."""
    monkeypatch.setenv("ORWELL_ENRICHMENT_POLICY", "strict")
    ep.clear_failures("iris")
    calls = {"n": 0}

    async def bad_llm(messages):
        calls["n"] += 1
        return "I will not emit JSON, only prose."

    async def write(profile):
        raise AssertionError("nothing parseable must ever reach the write-back")

    written = run(ca.author_cast([{"id": "npc:1", "name": "Probe"}], bad_llm, write, user="iris"))
    assert written == 0
    assert calls["n"] >= 2, "the bounded retry must have re-issued the call"
    rows = ep.failures("iris")
    assert rows and rows[-1]["callClass"] == "cast-authoring"
    assert "floor" in rows[-1]["reason"]


def test_soft_failing_authoring_call_stays_silent(monkeypatch, run):
    monkeypatch.setenv("ORWELL_ENRICHMENT_POLICY", "soft")
    ep.clear_failures("jack")

    async def bad_llm(messages):
        return "no json here either"

    async def write(profile):
        raise AssertionError("unreachable")

    written = run(ca.author_cast([{"id": "npc:1", "name": "Probe"}], bad_llm, write, user="jack"))
    assert written == 0
    assert ep.failures("jack") == [], "soft is the byte-identical legacy: no ledger entries"


def test_strict_no_model_run_authoring_is_loud(monkeypatch, run):
    monkeypatch.setenv("ORWELL_ENRICHMENT_POLICY", "strict")
    monkeypatch.setattr(ca, "resolve_authoring_llm_fn", _none)
    ep.clear_failures("kate")
    written = run(ca.run_authoring([{"id": "npc:1", "name": "Probe"}], "kate"))
    assert written == 0
    rows = ep.failures("kate")
    assert rows and rows[0]["callClass"] == "cast-authoring" and "no model" in rows[0]["reason"]


# ── zeitgeist: strict retries once then ledgers; soft is single-attempt legacy ───────────

def _quiet_search(monkeypatch):
    import src.settings as settings_mod
    real = settings_mod.get_setting

    def fake(key, default=None):
        if key == "search_provider":
            return "disabled"
        if key == "enrichment_policy":
            return ""
        return real(key, default)
    monkeypatch.setattr(settings_mod, "get_setting", fake)


def test_strict_zeitgeist_failure_retries_then_ledgers(monkeypatch, run):
    monkeypatch.setenv("ORWELL_ENRICHMENT_POLICY", "strict")
    _quiet_search(monkeypatch)
    zg = importlib.import_module("src.orwell_zeitgeist")
    ep.clear_failures("liam")
    calls = {"n": 0}

    async def failing_fn(messages):
        calls["n"] += 1
        raise RuntimeError("provider down")

    async def resolver(owner, **k):
        return failing_fn
    monkeypatch.setattr(ca, "_resolve_llm_fn", resolver)

    result = run(zg.run_capture("liam"))
    assert result.get("accepted") is False
    assert calls["n"] == 2, "strict must retry the capture exactly once"
    rows = ep.failures("liam")
    assert rows and rows[-1]["callClass"] == "zeitgeist" and "retry" in rows[-1]["reason"]


def test_soft_zeitgeist_failure_is_single_attempt_and_silent(monkeypatch, run):
    monkeypatch.setenv("ORWELL_ENRICHMENT_POLICY", "soft")
    _quiet_search(monkeypatch)
    zg = importlib.import_module("src.orwell_zeitgeist")
    ep.clear_failures("mona")
    calls = {"n": 0}

    async def failing_fn(messages):
        calls["n"] += 1
        raise RuntimeError("provider down")

    async def resolver(owner, **k):
        return failing_fn
    monkeypatch.setattr(ca, "_resolve_llm_fn", resolver)

    result = run(zg.run_capture("mona"))
    assert result == {"accepted": False, "reason": "llm-failed"}
    assert calls["n"] == 1, "soft keeps the legacy single attempt byte-identical"
    assert ep.failures("mona") == []


def test_strict_zeitgeist_no_model_is_loud(monkeypatch, run):
    monkeypatch.setenv("ORWELL_ENRICHMENT_POLICY", "strict")
    zg = importlib.import_module("src.orwell_zeitgeist")
    ep.clear_failures("nora")
    monkeypatch.setattr(ca, "_resolve_llm_fn", _none)
    result = run(zg.run_capture("nora"))
    assert result == {"accepted": False, "reason": "no-model"}
    rows = ep.failures("nora")
    assert rows and rows[0]["callClass"] == "zeitgeist" and "no model" in rows[0]["reason"]


# ── the other fail-soft sites are strict-wired too ───────────────────────────────────────

def test_strict_offscreen_texture_no_model_is_loud(monkeypatch, run):
    monkeypatch.setenv("ORWELL_ENRICHMENT_POLICY", "strict")
    tex = importlib.import_module("src.orwell_offscreen_texture")
    monkeypatch.setattr(tex, "enrichment_enabled", lambda: True)  # #1936: the policy applies to the ENABLED path
    ep.clear_failures("olga")
    monkeypatch.setattr(ca, "_resolve_llm_fn", _none)
    result = run(tex.run_enrich(owner="olga"))
    assert result.get("reason") == "no-model"
    rows = ep.failures("olga")
    assert rows and rows[0]["callClass"] == "offscreen-texture"


def test_strict_cast_identity_no_model_is_loud(monkeypatch, run):
    monkeypatch.setenv("ORWELL_ENRICHMENT_POLICY", "strict")
    cid = importlib.import_module("src.orwell_cast_identity")
    ep.clear_failures("pete")
    monkeypatch.setattr(ca, "_resolve_llm_fn", _none)
    applied = run(cid.run_identity([{"id": "npc:1"}], "pete"))
    assert applied == 0
    rows = ep.failures("pete")
    assert rows and rows[0]["callClass"] == "cast-identity"


def test_soft_sites_record_nothing(monkeypatch, run):
    monkeypatch.setenv("ORWELL_ENRICHMENT_POLICY", "soft")
    tex = importlib.import_module("src.orwell_offscreen_texture")
    monkeypatch.setattr(tex, "enrichment_enabled", lambda: True)  # #1936: the policy applies to the ENABLED path
    cid = importlib.import_module("src.orwell_cast_identity")
    ep.clear_failures("ruth")
    monkeypatch.setattr(ca, "_resolve_llm_fn", _none)
    assert run(tex.run_enrich(owner="ruth")).get("reason") == "no-model"
    assert run(cid.run_identity([{"id": "npc:1"}], "ruth")) == 0
    assert ep.failures("ruth") == []


# ── the pinned-soft lanes (source pins, the repo convention) ─────────────────────────────

def test_harnesses_pin_soft():
    for rel in ("scripts/boot_smoke.py", "scripts/browser_smoke.py", "scripts/responsive_matrix.py"):
        assert 'ORWELL_ENRICHMENT_POLICY="soft"' in _read(rel), f"{rel} must pin the soft policy"
    assert "ORWELL_ENRICHMENT_POLICY=soft" in _read("deploy/smoke.sh", root=REPO), \
        "deploy/smoke.sh boots the FE with no model and must pin the soft policy"


def test_conftest_pins_soft_for_the_suite():
    src = _read("tests/conftest.py")
    assert 'os.environ.setdefault("ORWELL_ENRICHMENT_POLICY", "soft")' in src


# ── the new-season scrub clears the ledger ───────────────────────────────────────────────

def test_reset_user_season_clears_the_failure_ledger(monkeypatch):
    pw = importlib.import_module("src.orwell_prewarm")
    op = importlib.import_module("src.orwell_portraits")
    monkeypatch.setattr(op, "scrub_user", lambda u: None)
    ep.record_failure("sara", "cast-authoring", "stale from last season")
    pw.reset_user_season("sara")
    assert ep.failures("sara") == []
