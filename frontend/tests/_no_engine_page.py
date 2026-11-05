"""One shared recipe for browser tests that boot the REAL front-end with NO engine (A84).

Root cause of the #925/#1148/#930 "onboarding-scrim" flake (full account in tests/_settings_open.py): with no engine, `route()`'s fetchState() fails and mounts the F5 "dark house" holding card, a modal
whose [data-ow-scrim] covers the page and inerts the sidebar; `route()` RE-MOUNTS it on every async `orwell:models-changed`, so dismissing it once is not enough, and the boot spinner `#app-loader`
(z-index 99999) can also still be up on a loaded runner. The fix lived twice in two forms (a dismiss+click-in-one-evaluate in `_settings_open.py`, a mount-seam stub in `test_1638_sorts_browser.py`).

`ready(page)` is the single recipe: (1) wait out #app-loader (honest boot readiness; remove it if it never leaves), (2) neutralise the re-mount SEAM `window._orwellOnboardingMount` (its ONLY mount path),
(3) dismiss the card that is already up through its own synchronous [data-ob-dismiss] way-out, until no card and no scrim remain. TEST-ONLY: it changes no product behaviour; the real onboarding lifecycle is
covered by test_925_orphan_scrim_sweep.py / test_j4_no_trap.py. Pass `stub=False` only for the negative control.

NOT needed for the static-harness browser tests (test_893_sheet_browser, test_660_confirm_prompt_kit, the other test_1638_* files): they `page.set_content` a tiny harness and never boot the FE app, so
there is no holding card to clear.
"""
import time


def wait_out_loader(page, timeout_ms=8000):
    try:
        page.wait_for_selector("#app-loader", state="detached", timeout=timeout_ms)
    except Exception:
        page.evaluate("() => { const l = document.getElementById('app-loader'); if (l) l.remove(); }")


def stub_mount_seam(page):
    page.evaluate("() => { try { window._orwellOnboardingMount = function () {}; } catch (_) {} }")


def dismiss_overlays(page, deadline_s=15.0):
    deadline = time.time() + deadline_s
    while time.time() < deadline:
        state = page.evaluate("""() => {
          const ob = document.getElementById('orwell-onboarding');
          if (ob) { const out = ob.querySelector('[data-ob-dismiss]'); if (out) out.click(); }
          return { ob: !!document.getElementById('orwell-onboarding'), scrims: document.querySelectorAll('[data-ow-scrim]').length };
        }""")
        if not state["ob"] and state["scrims"] == 0:
            return True
        page.wait_for_timeout(100)
    return False


def ready(page, stub=True, deadline_s=15.0):
    """Leave the no-engine page free of the app-loader, the holding card and every scrim, and (default) unable to mount a new card."""
    wait_out_loader(page)
    if stub:
        stub_mount_seam(page)
    return dismiss_overlays(page, deadline_s)
