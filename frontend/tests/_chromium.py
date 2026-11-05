"""One locator for the headless Chromium the browser tests launch (A41 follow-up).

Six test files each hard-coded `/opt/pw-browsers/chromium*/chrome-linux/chrome` - a path that exists only in the sandbox image. On CI, `playwright install chromium` puts the browser under
`$PLAYWRIGHT_BROWSERS_PATH` or `~/.cache/ms-playwright`, so every one of those tests skipped with "chromium unavailable" and the browser lane quietly never ran them. This helper checks the
sandbox paths first (unchanged behavior there) and then Playwright's own install directory. Returns None only when no Chromium is installed anywhere.
"""
from __future__ import annotations

import glob
import os

_SANDBOX = ("/opt/pw-browsers/chromium/chrome-linux/chrome", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")


def chromium_path():
    for p in _SANDBOX:
        if os.path.exists(p):
            return p
    roots = [os.environ.get("PLAYWRIGHT_BROWSERS_PATH"), os.path.expanduser("~/.cache/ms-playwright"), "/opt/pw-browsers"]
    for root in (r for r in roots if r and r != "0"):
        for pattern in ("chromium-*/chrome-linux/chrome", "chromium-*/chrome-linux64/chrome"):
            hits = sorted(glob.glob(os.path.join(root, pattern)), reverse=True)
            for h in hits:
                if os.path.exists(h):
                    return h
    return None
