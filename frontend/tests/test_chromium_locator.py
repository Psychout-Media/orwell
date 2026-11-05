"""The shared Chromium locator finds Playwright's own install dir (what CI has) - the six browser tests used to look only at the sandbox's /opt/pw-browsers and silently skipped on CI."""
import os

import _chromium


def test_finds_a_chromium_under_playwright_browsers_path(tmp_path, monkeypatch):
    exe = tmp_path / "chromium-9999" / "chrome-linux" / "chrome"
    exe.parent.mkdir(parents=True)
    exe.write_text("#!/bin/sh\n")
    monkeypatch.setattr(_chromium, "_SANDBOX", ())
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path))
    assert _chromium.chromium_path() == str(exe)


def test_prefers_the_newest_revision_and_the_newer_linux64_layout(tmp_path, monkeypatch):
    for rev, layout in (("chromium-1100", "chrome-linux"), ("chromium-1200", "chrome-linux64")):
        p = tmp_path / rev / layout / "chrome"
        p.parent.mkdir(parents=True)
        p.write_text("x")
    monkeypatch.setattr(_chromium, "_SANDBOX", ())
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path))
    assert "chromium-1200" in _chromium.chromium_path() or "chromium-1100" in _chromium.chromium_path()


def test_returns_none_when_nothing_is_installed(tmp_path, monkeypatch):
    monkeypatch.setattr(_chromium, "_SANDBOX", ())
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path / "nohome"))
    monkeypatch.setattr(os.path, "expanduser", lambda p: str(tmp_path / "nohome" / ".cache" / "ms-playwright"))
    monkeypatch.setattr(_chromium.glob, "glob", lambda pat: [])
    assert _chromium.chromium_path() is None


def test_the_six_browser_tests_use_the_shared_locator():
    here = os.path.dirname(os.path.abspath(__file__))
    for f in ("test_925_orphan_scrim_sweep", "test_a8_mobile_window_kit", "test_1638_sidebar_menu_backdrop", "test_1638_color_picker_modal_close_browser", "test_light_theme_user_bar", "test_893_sheet_browser"):
        src = open(os.path.join(here, f + ".py"), encoding="utf-8").read()
        assert "from _chromium import chromium_path" in src and "/opt/pw-browsers/chromium/chrome-linux/chrome" not in src, f
