"""Shared Playwright helper: open the Settings modal deterministically past the
pre-game onboarding overlays.

Root cause of the #925/#1148/#930 "onboarding-scrim" flake (deterministic in CI,
invisible to plain local runs), established by direct DOM probing of this exact
no-engine boot:

Two *transient full-screen overlays* cover the Settings gear (#user-bar-settings)
and defeat Playwright's HIT-TESTED ``page.click`` (which waits for the target
point to actually receive the event):

  1. ``#app-loader`` — the boot spinner (``position:fixed; inset:0;
     z-index:99999``). It is removed when ``loadSessions()`` resolves OR by a hard
     ~5s fallback timer (static/index.html). On a *loaded* CI runner it is still
     up past the test's fixed 4s wait, so ``page.click`` on the gear times out on
     it (``document.elementFromPoint(gear) === #app-loader``). The old converge
     loop only ever checked for the onboarding window/scrim, never this loader —
     so it timed out with ``{onboarding: None, scrims: 0, settingsConnected:
     False}``, the exact CI signature.
  2. the F5 "Big Brother engine unavailable" holding card (this suite runs the FE
     with NO TS engine, so ``route()``'s ``fetchState()`` 502s and mounts it). It
     is ``modal:true`` — its scrim covers the gear AND it inerts the sidebar (the
     gear becomes non-interactive) — and ``route()`` re-mounts it on every
     ``orwell:models-changed`` (models.js fires that on the model-scan none→some
     edge, which the pre-seeded endpoint here guarantees), so it *recurs*.

A RAW JS ``.click()`` on the gear opens Settings reliably whenever the gear is not
``inert`` (verified) — the click handler + ``settingsModule.open()`` are fine; the
only failure was Playwright's hit-tested click being intercepted by these overlays
(no product bug). And the holding card's ``[data-ob-dismiss]`` runs
``win.destroy()`` SYNCHRONOUSLY (removes the scrim + un-inerts the sidebar in the
same tick, per orwellWindow.js).

So the robust, deterministic recipe is:
  * wait out ``#app-loader`` (honest boot readiness), then
  * each pass, ATOMICALLY (one ``page.evaluate`` = one JS microtask): dismiss any
    onboarding card via its own ``[data-ob-dismiss]`` (synchronous teardown →
    gear un-inerted) and immediately JS-dispatch the gear ``.click()`` — before any
    async ``orwell:models-changed`` can re-mount the card and re-inert the gear.
    The JS click also bypasses the app-loader's z-index cover.

This opens ``#settings-modal`` deterministically regardless of overlay timing,
without depending on out-racing an async re-mount and without an engine-state stub
(stubbing ``/api/orwell/state`` healthy triggers game-mode sidebar hiding — wrong).
"""


def open_settings_deterministically(page, deadline_s: float = 30.0):
    """Open the Settings kit modal (#settings-modal) past the onboarding overlays.

    Raises AssertionError with a rich blocking-state diagnostic on timeout.
    """
    import time

    def _settings_open() -> bool:
        return page.evaluate(
            """() => {
              const m = document.getElementById('settings-modal');
              if (!m || !m.isConnected) return false;
              const s = getComputedStyle(m);
              return s.display !== 'none' && s.visibility !== 'hidden'
                     && m.getClientRects().length > 0;
            }"""
        )

    # (1) Wait out the boot spinner. It always clears by ~5.3s (loadSessions finally
    # OR the hard 5s fallback); a loaded runner just needs us not to race it.
    try:
        page.wait_for_function("() => !document.getElementById('app-loader')", timeout=12000)
    except Exception:
        pass

    # (1b) A84: neutralise the holding card's re-mount seam up front (the shared recipe, tests/_no_engine_page.py), so a card dismissed below can not come back on the next orwell:models-changed.
    from _no_engine_page import stub_mount_seam
    stub_mount_seam(page)

    # (2) Atomic dismiss-and-open, retried until the modal is actually up.
    atomic_open = """() => {
      // Dismiss any onboarding card via its own SYNCHRONOUS teardown (win.destroy),
      // which removes the scrim + un-inerts the sidebar in this same microtask...
      const card = document.getElementById('orwell-onboarding');
      if (card) { const b = card.querySelector('[data-ob-dismiss]'); if (b) b.click(); }
      // ...then open Settings in the SAME tick, before any async re-mount can
      // re-inert the gear. A JS-dispatched click also bypasses the #app-loader
      // z-index cover (real hit-tested clicks are what the overlays intercept).
      const g = document.getElementById('user-bar-settings');
      if (g && !g.closest('[inert]')) g.click();
    }"""

    deadline = time.monotonic() + deadline_s
    while time.monotonic() < deadline:
        if _settings_open():
            return
        page.evaluate(atomic_open)
        page.wait_for_timeout(150)

    if not _settings_open():
        diag = page.evaluate(
            """() => {
              const ob = document.getElementById('orwell-onboarding');
              const m = document.getElementById('settings-modal');
              const g = document.getElementById('user-bar-settings');
              const r = g ? g.getBoundingClientRect() : null;
              const at = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
              return {
                appLoader: !!document.getElementById('app-loader'),
                onboarding: ob ? (ob.getAttribute('data-ob-holding') !== null ? 'holding'
                                  : ob.getAttribute('data-ob-setup') !== null ? 'setup' : 'other') : null,
                scrims: document.querySelectorAll('[data-ow-scrim]').length,
                gearInert: g ? (g.closest('[inert]') !== null) : null,
                elementAtGear: at ? (at.id || at.tagName) : null,
                settingsConnected: !!(m && m.isConnected),
                settingsDisplay: m ? getComputedStyle(m).display : null,
              };
            }"""
        )
        raise AssertionError(
            f"Settings modal never opened past the boot loader / onboarding overlay — "
            f"blocking state: {diag}")
