"""ORW-1146: a non-prod deployment's new accounts start with image generation off, and a per-deployment daily image-spend cap refuses
further portrait calls once reached, alerts once, and shows on the admin health page.

Roles only: every account and prompt is an invented probe."""
import importlib
import time

import pytest
from conftest import _run

S = importlib.import_module("src.orwell_image_spend")
P = importlib.import_module("src.orwell_portraits")
log_rings = importlib.import_module("src.log_rings")
ahr = importlib.import_module("routes.admin_health_routes")
prefs_routes = importlib.import_module("routes.prefs_routes")
from core.auth import AuthManager


@pytest.fixture(autouse=True)
def _env(tmp_path, monkeypatch):
    for k in ("ORWELL_DEPLOYMENT", "ORWELL_IMAGE_DAILY_CAP_USD", "ORWELL_IMAGE_COST_ESTIMATE_USD", "ORWELL_IMAGE_GEN_NEW_ACCOUNTS"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("ORWELL_IMAGE_SPEND_FILE", str(tmp_path / "image-spend.json"))
    monkeypatch.setattr(prefs_routes, "PREFS_FILE", str(tmp_path / "user_prefs.json"))


@pytest.fixture
def alerts(monkeypatch):
    seen = []
    monkeypatch.setattr(log_rings, "record_soft_failure", lambda cls, exc, **k: seen.append(cls))
    return seen


def _new_account(tmp_path, name="probe1"):
    am = AuthManager(auth_path=str(tmp_path / "auth.json"))
    assert am.create_user(name, "a-long-enough-probe-password", is_admin=False)
    return prefs_routes._load_for_user(name)


def test_a_new_account_on_dev_starts_with_images_off(tmp_path, monkeypatch):
    monkeypatch.setenv("ORWELL_DEPLOYMENT", "dev")
    assert _new_account(tmp_path).get("image_gen_enabled") is False
    assert P._image_settings("probe1")[0] is False  # the portrait pipeline reads that pref: no image call on first load


def test_prod_and_unset_deployments_are_unchanged(tmp_path, monkeypatch):
    assert "image_gen_enabled" not in _new_account(tmp_path, "probe2")
    monkeypatch.setenv("ORWELL_DEPLOYMENT", "prod")
    assert "image_gen_enabled" not in _new_account(tmp_path, "probe3")


def test_a_setting_can_keep_images_on_for_new_dev_accounts(tmp_path, monkeypatch):
    monkeypatch.setenv("ORWELL_DEPLOYMENT", "dev")
    monkeypatch.setenv("ORWELL_IMAGE_GEN_NEW_ACCOUNTS", "1")
    assert "image_gen_enabled" not in _new_account(tmp_path, "probe4")


def test_an_existing_pref_is_never_overwritten(tmp_path, monkeypatch):
    monkeypatch.setenv("ORWELL_DEPLOYMENT", "dev")
    prefs_routes._save_for_user("probe5", {"image_gen_enabled": True})
    assert S.apply_new_account_defaults("probe5") is False
    assert prefs_routes._load_for_user("probe5")["image_gen_enabled"] is True


def test_default_cap_is_small_on_dev_and_none_on_prod(monkeypatch):
    assert S.daily_cap_usd() is None
    monkeypatch.setenv("ORWELL_DEPLOYMENT", "dev")
    assert S.daily_cap_usd() == S.DEFAULT_NONPROD_CAP_USD
    monkeypatch.setenv("ORWELL_IMAGE_DAILY_CAP_USD", "0.30")
    assert S.daily_cap_usd() == 0.30
    monkeypatch.setenv("ORWELL_IMAGE_DAILY_CAP_USD", "off")
    assert S.daily_cap_usd() is None


def test_the_cap_refuses_after_the_limit_and_alerts_once(monkeypatch, alerts):
    monkeypatch.setenv("ORWELL_DEPLOYMENT", "dev")
    monkeypatch.setenv("ORWELL_IMAGE_DAILY_CAP_USD", "0.20")
    monkeypatch.setenv("ORWELL_IMAGE_COST_ESTIMATE_USD", "0.05")
    for _ in range(4):
        assert S.allow() is True
        S.record(None)
    assert alerts == []
    assert all(S.allow() is False for _ in range(5))
    assert alerts == ["images:daily-cap"]
    snap = S.snapshot()
    assert snap["count"] == 4 and snap["usd"] == 0.2 and snap["refused"] == 5 and snap["capReached"] is True


def test_the_providers_own_cost_counts_when_it_returned_one(monkeypatch):
    monkeypatch.setenv("ORWELL_DEPLOYMENT", "dev")
    S.record(0.123)
    assert S.snapshot()["usd"] == 0.123


def test_a_new_day_starts_clean(monkeypatch, alerts):
    monkeypatch.setenv("ORWELL_DEPLOYMENT", "dev")
    monkeypatch.setenv("ORWELL_IMAGE_DAILY_CAP_USD", "0.05")
    now = time.time()
    S.record(0.05, now=now)
    assert S.allow(now=now) is False
    assert S.allow(now=now + 86400) is True and S.snapshot(now=now + 86400)["count"] == 0


def test_the_portrait_call_is_refused_at_the_cap_with_no_provider_call(monkeypatch, alerts):
    monkeypatch.setenv("ORWELL_DEPLOYMENT", "dev")
    monkeypatch.setenv("ORWELL_IMAGE_DAILY_CAP_USD", "0.05")
    S.record(0.05)
    calls = []

    async def inner(prompt, user, reference_png=None, keep_identity=True, _ctx=None):
        calls.append(prompt)
        return b"PNG"

    monkeypatch.setattr(P, "_generate_one_inner", inner)
    assert _run(P._generate_one_gated("a probe prompt", "u")) is None
    assert calls == [] and alerts == ["images:daily-cap"]


def test_a_made_image_is_counted(monkeypatch):
    async def inner(prompt, user, reference_png=None, keep_identity=True, _ctx=None):
        return b"PNG"

    monkeypatch.setattr(P, "_generate_one_inner", inner)
    assert _run(P._generate_one_gated("a probe prompt", "u")) == b"PNG"
    assert S.snapshot()["count"] == 1


def test_the_health_payload_and_page_carry_the_image_spend(monkeypatch):
    S.record(0.07)
    sec = ahr._image_spend_section()
    assert sec["count"] == 1 and sec["usd"] == 0.07
    src = open(ahr.__file__, encoding="utf-8").read()
    assert '"imageSpend": _image_spend_section()' in src and "Image spend today" in src
