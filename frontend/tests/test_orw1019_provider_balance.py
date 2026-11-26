"""ORW-1019 follow-up - the hourly read-only provider balance check: under, over, unknown, rate limit, back-off."""
import importlib
import shutil
import subprocess
from pathlib import Path

import pytest
from conftest import _run

pb = importlib.import_module("src.orwell_provider_balance")
pc = importlib.import_module("src.orwell_provider_credit")
log_rings = importlib.import_module("src.log_rings")
ROOT = Path(__file__).resolve().parents[2]
KEYS = {"deepseek": "sk-test-deepseek", "openrouter": "sk-or-test"}
DS = lambda v: {"is_available": True, "balance_infos": [{"currency": "USD", "total_balance": str(v)}]}
OR = lambda bought, used: {"data": {"total_credits": bought, "total_usage": used}}


@pytest.fixture(autouse=True)
def _clean():
    pb.reset()
    yield
    pb.reset()


@pytest.fixture
def alerts(monkeypatch):
    seen = []
    monkeypatch.setattr(log_rings, "record_soft_failure", lambda cls, exc, **k: seen.append((cls, str(exc))))
    return seen


def fake_get(answers, calls):
    async def get(url, key):
        calls.append((url, key))
        a = answers[url]
        if isinstance(a, Exception):
            raise a
        return a
    return get


def run(now, answers, calls, keys=KEYS):
    _run(pb.check_once(now, get=fake_get(answers, calls), keys=keys))


DSU, ORU = pb._URLS["deepseek"], pb._URLS["openrouter"]


def test_under_the_line_warns_once_per_provider_and_shows_last_known(alerts):
    calls = []
    run(1000.0, {DSU: (200, DS("3.10")), ORU: (200, OR(20, 18.5))}, calls)
    rows = {r["provider"]: r for r in pb.snapshot()}
    assert rows["deepseek"]["status"] == "low" and rows["deepseek"]["balanceUsd"] == 3.1 and rows["deepseek"]["checkedAt"] == 1000
    assert rows["openrouter"]["status"] == "low" and rows["openrouter"]["balanceUsd"] == 1.5
    assert sorted(c for c, _ in alerts) == ["provider:balance-low"] * 2
    assert all("sk-" not in msg for _, msg in alerts), "a key must never reach an alert"
    # an hour later: asked again, still low, but the 6 h alert limit holds
    run(1000.0 + 3601, {DSU: (200, DS("3.00")), ORU: (200, OR(20, 18.5))}, calls)
    assert len(alerts) == 2
    run(1000.0 + 6 * 3600 + 5, {DSU: (200, DS("2.00")), ORU: (200, OR(20, 18.5))}, calls)
    assert len(alerts) == 4


def test_over_the_line_is_ok_and_silent(alerts):
    run(1000.0, {DSU: (200, DS("42.00")), ORU: (200, OR(100, 10))}, [])
    assert [r["status"] for r in pb.snapshot()] == ["ok", "ok"] and alerts == []
    assert pc.snapshot()["lowBalance"] is False


def test_the_check_is_hourly_per_provider(alerts):
    calls = []
    answers = {DSU: (200, DS(50)), ORU: (200, OR(100, 10))}
    run(1000.0, answers, calls)
    run(1000.0 + 600, answers, calls)
    run(1000.0 + 3599, answers, calls)
    assert len(calls) == 2
    run(1000.0 + 3601, answers, calls)
    assert len(calls) == 4


def test_a_failed_check_reads_unknown_backs_off_and_never_storms(alerts):
    calls = []
    bad = {DSU: OSError("down"), ORU: (404, {"error": "moved"})}
    run(1000.0, bad, calls)
    assert [r["status"] for r in pb.snapshot()] == ["unknown", "unknown"] and alerts == []
    n = len(calls)
    for i in range(1, 30):  # frequent ticks inside the back-off window ask nobody
        run(1000.0 + i * 100, bad, calls)
    assert len(calls) <= n + 4
    # the back-off doubles, and a later success clears the unknown
    run(1000.0 + 7200 + 1, {DSU: (200, DS(80)), ORU: (200, OR(100, 10))}, calls)
    assert {r["provider"]: r["status"] for r in pb.snapshot()} == {"deepseek": "ok", "openrouter": "ok"}


def test_a_non_usd_deepseek_wallet_or_a_junk_body_is_unknown(alerts):
    run(1000.0, {DSU: (200, {"balance_infos": [{"currency": "CNY", "total_balance": "1.0"}]}), ORU: (200, {"nope": 1})}, [])
    assert [r["status"] for r in pb.snapshot()] == ["unknown", "unknown"] and alerts == []


def test_the_line_is_configurable(monkeypatch, alerts):
    from src import settings
    monkeypatch.setattr(settings, "get_setting", lambda k, d=None: 50 if k == "provider_balance_warn_usd" else d)
    run(1000.0, {DSU: (200, DS(20)), ORU: (200, OR(100, 10))}, [])
    assert {r["provider"]: r["status"] for r in pb.snapshot()} == {"deepseek": "low", "openrouter": "ok"}


def test_no_endpoint_key_means_no_call(alerts):
    calls = []
    run(1000.0, {}, calls, keys={})
    assert calls == [] and pb.snapshot() == []


def test_only_the_expected_hosts_get_the_key():
    assert pb._provider_of("https://api.deepseek.com") == "deepseek" and pb._provider_of("https://openrouter.ai/api/v1") == "openrouter"
    assert pb._provider_of("https://deepseek.com.evil.test/v1") is None and pb._provider_of("http://10.0.0.5:8000/v1") is None


def test_snapshot_reaches_the_admin_view_and_the_doctor_is_wired(alerts):
    run(1000.0, {DSU: (200, DS("1.00")), ORU: (200, OR(100, 10))}, [])
    s = pc.snapshot()
    assert s["lowBalance"] is True and {b["provider"] for b in s["balances"]} == {"deepseek", "openrouter"}
    doc = (ROOT / "deploy" / "orwell-doctor.sh").read_text()
    assert "provider_balance_check" in doc and "orwell_provider_balance.run_forever" in (ROOT / "frontend" / "app.py").read_text()


@pytest.mark.skipif(shutil.which("bash") is None or shutil.which("python3") is None, reason="bash and python3 are needed")
def test_doctor_function_warns_on_low_and_passes_on_ok(tmp_path):
    src = (ROOT / "deploy" / "orwell-doctor.sh").read_text()
    a = src.index("provider_balance_check() {")
    fn = src[a:src.index("\n}\n", a) + 3]
    body = '{"balances":[{"status":"low","provider":"deepseek","balanceUsd":3.1,"warnUsd":5.0},{"status":"unknown","provider":"openrouter","balanceUsd":null,"warnUsd":5.0},{"status":"ok","provider":"x","balanceUsd":9,"warnUsd":5.0}]}'
    script = ('FE_BASE=http://x\ncurl() { printf %s \'' + body + '\'; }\nwarn() { echo "WARN $*"; }\ninfo() { echo "INFO $*"; }\npass() { echo "PASS $*"; }\n' + fn + "\nprovider_balance_check\n")
    out = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=20).stdout
    assert "WARN provider balance LOW: deepseek has $3.1, under the $5.0 line" in out
    assert "INFO provider balance unknown: openrouter" in out and "PASS provider balance: x $9" in out
