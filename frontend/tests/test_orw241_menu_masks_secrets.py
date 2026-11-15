"""ORW-241 (infra audit item 28): the control-panel menu's run() helper echoes the command it is about to run; a NAME=value secret argument (the deploy token) must be masked in that echo while the command still receives the real value. No model."""
import re
import subprocess
from pathlib import Path

MENU = Path(__file__).resolve().parents[2] / "deploy" / "orwell-menu.sh"


def _run_snippet():
    src = MENU.read_text()
    m = re.search(r"^run\(\) \{.*?^\}\n", src, re.S | re.M)
    assert m, "run() not found in orwell-menu.sh"
    return m.group(0)


def test_run_masks_secret_assignments_in_its_echo_but_passes_the_real_value():
    script = f"""
set -u
tui_active() {{ return 1; }}
ow_section() {{ :; }}
ow_step() {{ echo "STEP: $*"; }}
ow_ok() {{ :; }}
ow_fail() {{ :; }}
{_run_snippet()}
run "Set deploy token" env GIT_TOKEN="ghp_supersecretvalue123" printenv GIT_TOKEN
"""
    out = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    step = next(l for l in out.stdout.splitlines() if l.startswith("STEP:"))
    assert "supersecretvalue" not in step and "GIT_TOKEN=***" in step, step
    # the command itself still received the real value (printenv echoes it as the command's own output, not the menu's)
    assert "ghp_supersecretvalue123" in out.stdout.replace(step, "")


def test_non_secret_arguments_are_shown_unchanged():
    script = f"""
set -u
tui_active() {{ return 1; }}
ow_section() {{ :; }}
ow_step() {{ echo "STEP: $*"; }}
ow_ok() {{ :; }}
ow_fail() {{ :; }}
{_run_snippet()}
run "Update" env REF=v1.2 true
"""
    out = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
    assert "STEP: env REF=v1.2 true" in out.stdout, out.stdout
