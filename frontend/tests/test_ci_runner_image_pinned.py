"""CI must run on a pinned Ubuntu image, not ubuntu-latest.

On 2026-11-06 GitHub served `ubuntu-latest` as Ubuntu 26.04 to the Psychout-Media org, and the pinned
Playwright (1.56) refuses that OS ("Playwright does not support chromium on ubuntu26.04-x64"), so every
browser lane failed at setup on every PR and on main. Pinning keeps the image (and the mirror-gate pixel
baselines made on it) stable; move the pin deliberately, together with a Playwright upgrade.
"""
from pathlib import Path

WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"
PINNED = "ubuntu-24.04"


def _workflow_files():
    # both spellings GitHub accepts (review of #2278: a `.yaml` workflow escaped the old `*.yml` scan)
    return sorted([*WORKFLOWS.glob("*.yml"), *WORKFLOWS.glob("*.yaml")])


def _runs_on_values():
    out = []
    for p in _workflow_files():
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            s = line.strip()
            if s.startswith("runs-on:"):
                out.append((f"{p.name}:{i}", s.split(":", 1)[1].split("#", 1)[0].strip().strip("'\"")))
    return out


def test_no_workflow_uses_the_floating_ubuntu_latest_label():
    offenders = [where for where, v in _runs_on_values() if "ubuntu-latest" in v]
    assert not offenders, f"pin the runner image ({PINNED}) instead of ubuntu-latest: {offenders}"


def test_every_hosted_job_is_on_the_pinned_image():
    # Every runs-on is checked, not a total (review of #2278: a count let one job move to another image and stay green).
    values = _runs_on_values()
    assert values, "no runs-on found: the workflow scan is broken"
    offenders = [f"{where}={v}" for where, v in values if v != PINNED]
    assert not offenders, f"every job must run on {PINNED} (move the pin deliberately, with a Playwright upgrade): {offenders}"
