"""CI must run on a pinned Ubuntu image, not ubuntu-latest.

On 2026-11-06 GitHub served `ubuntu-latest` as Ubuntu 26.04 to the Psychout-Media org, and the pinned
Playwright (1.56) refuses that OS ("Playwright does not support chromium on ubuntu26.04-x64"), so every
browser lane failed at setup on every PR and on main. Pinning keeps the image (and the mirror-gate pixel
baselines made on it) stable; move the pin deliberately, together with a Playwright upgrade.
"""
from pathlib import Path

WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"


def test_no_workflow_uses_the_floating_ubuntu_latest_label():
    offenders = [f"{p.name}:{i}" for p in sorted(WORKFLOWS.glob("*.yml"))
                 for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1)
                 if "runs-on:" in line and "ubuntu-latest" in line]
    assert not offenders, f"pin the runner image (ubuntu-24.04) instead of ubuntu-latest: {offenders}"


def test_every_hosted_job_is_on_the_pinned_image():
    pinned = sum(p.read_text(encoding="utf-8").count("runs-on: ubuntu-24.04") for p in WORKFLOWS.glob("*.yml"))
    assert pinned >= 15  # ci.yml has ~15 jobs; nightly workflows add more
