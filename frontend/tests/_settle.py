"""Condition-based 'nothing more is going to happen' for browser tests (replaces fixed wait_for_timeout sleeps, A83).

`settle(page)` waits until the page has been QUIET: no fetch in flight and no fetch started or finished for `quiet_frames` consecutive animation frames. It is the bounded form of a negative assertion
('no second dialog appeared', 'nothing was re-dispatched'): the window is measured in the page's own frames and network activity, not in wall-clock guesses, so it neither flakes on a slow runner nor
wastes seconds on a fast one. A JS-side deadline turns a never-quiet page into a clear error instead of a hang.
"""
_INSTALL = r"""
() => {
  if (window.__settle) return true;
  const orig = window.fetch.bind(window);
  window.__settle = { inflight: 0, last: performance.now() };
  window.fetch = (...a) => {
    window.__settle.inflight++; window.__settle.last = performance.now();
    return orig(...a).finally(() => { window.__settle.inflight--; window.__settle.last = performance.now(); });
  };
  return true;
}
"""
_WAIT = r"""
([quietFrames, deadlineMs]) => new Promise((resolve, reject) => {
  const t0 = performance.now();
  let quiet = 0, seen = window.__settle.last;
  const tick = () => {
    const s = window.__settle;
    if (s.inflight === 0 && s.last === seen) quiet++; else { quiet = 0; seen = s.last; }
    if (quiet >= quietFrames) return resolve(true);
    if (performance.now() - t0 > deadlineMs) return reject(new Error('page never went quiet: inflight=' + s.inflight));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})
"""


def install(page):
    page.evaluate(_INSTALL)


def settle(page, quiet_frames=30, deadline_ms=15000):
    install(page)
    return page.evaluate(_WAIT, [quiet_frames, deadline_ms])


_FRAMES = "(n) => new Promise((resolve) => { let i = 0; const tick = () => { if (++i >= n) resolve(true); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })"


def frames(page, n=30):
    """Wait n animation frames of the PAGE (not wall-clock): the bounded window for a NEGATIVE assertion ('no dialog appeared') whose cause is synchronous or one awaited fetch away. Unlike `settle`, it does not wait for the page-wide pollers to go quiet (they never do on a live HUD page)."""
    return page.evaluate(_FRAMES, n)


_APP_READY = "(names) => names.every((n) => !!window[n]) && !!document.getElementById('chat-history') && !document.getElementById('app-loader')"


def app_ready(page, names=("chatModule",), timeout_ms=30000, settle_frames=45):
    """ORW-414: wait for the EVENT instead of a fixed `wait_for_timeout(3500)  # module graph + async init`.

    After `page.goto(..., wait_until="load")` the app is ready when the module globals the test drives exist (`names`, e.g. chatModule / sessionModule), the
    chat box is mounted and the boot loader is gone; then `settle_frames` painted frames (the page's own clock, ~0.75 s at 60 fps) let the last async init
    step land. A slow runner takes as long as it needs (up to `timeout_ms`); a fast one no longer sleeps 3.5 s per page. The string is a function expression
    (the page CSP refuses a bare-expression `wait_for_function`)."""
    page.wait_for_function(_APP_READY, arg=list(names), timeout=timeout_ms)
    frames(page, settle_frames)
