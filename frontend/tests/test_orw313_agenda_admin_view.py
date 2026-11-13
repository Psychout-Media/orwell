"""ORW-313: the NPC agendas in the admin status page's Producer's Vault panel - one collapsible block per houseguest, readable on a phone, and ONLY after the explicit unseal.

The page HTML is the real /admin/status (served by the real router); every API call is stubbed, so this pins the front-end half: nothing renders on load, the explicit unseal fills the blocks, Re-seal
clears them, a refused unseal renders nothing. The engine half (the agendas ride the unsealed dump only) is tests/unit/producerVault.test.ts. Roles only (houseguests are generic labels)."""
import importlib
import json
import re

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ahr = importlib.import_module("routes.admin_health_routes")


def _html(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")   # the page is admin-gated; this is how the other status-page tests get its HTML
    app = FastAPI()
    app.include_router(ahr.setup_admin_status_page())
    r = TestClient(app).get("/admin/status")
    assert r.status_code == 200, r.status_code
    return r.text


def _goal(horizon, kind, target, status="active", commitment=80, **extra):
    return {"horizon": horizon, "kind": kind, **({"target": target} if target else {}), "why": ["threat read about Target B weight 80%", "board (hoh) weight 40%"],
            "test": "Target B is evicted while the holder is still playing", "commitment": commitment, "status": status, "formed": "week 2, day 9", **extra}


AGENDAS = [
    {"houseguest": "Holder A", "goals": [_goal("week", "get them out", "Target B"), _goal("season", "win by comps", None)],
     "history": [_goal("week", "stay safe", None, status="achieved", resolved="day 8")]},
    {"houseguest": "Holder C", "goals": [_goal("season", "run the house", None, commitment=55)], "history": []},
]
VAULT = {"hiddenStory": [{"type": "Secret thread", "content": "a hidden thing"}], "twists": [], "evictionVotes": [], "winner": None, "agendas": AGENDAS}


def _page_with_stubs(pw, html, vault_response):
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    posts = []

    def handler(route):
        req = route.request
        if req.url.endswith("/admin/status"):
            return route.fulfill(status=200, content_type="text/html", body=html)
        if req.url.endswith("/api/admin/ops/producer-vault"):
            posts.append(req.method)
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(vault_response))
        return route.fulfill(status=200, content_type="application/json", body="{}")

    page.route("**/*", handler)
    page.on("dialog", lambda d: d.accept())
    page.goto("http://admin.test/admin/status", wait_until="domcontentloaded")
    page.wait_for_selector("#producer-vault")
    return browser, page, posts


def test_agenda_blocks_appear_only_after_the_explicit_unseal_and_clear_on_reseal(monkeypatch):
    sync_api = pytest.importorskip("playwright.sync_api")
    html = _html(monkeypatch)
    with sync_api.sync_playwright() as pw:
        browser, page, posts = _page_with_stubs(pw, html, {"ok": True, "vault": VAULT})
        try:
            # on load: sealed, nothing from the agendas is in the DOM
            assert page.evaluate("document.getElementById('pv-panel').style.display") == "none"
            assert page.evaluate("document.getElementById('pv-agendas').children.length") == 0
            assert "Holder A" not in page.inner_text("body") and "AGENDAS" not in page.inner_text("body")
            assert posts == [], "nothing crosses to the vault route before the unseal"
            page.click("#producer-vault")
            page.wait_for_selector("#pv-agendas details", timeout=10000)
            assert posts == ["POST"]
            assert page.evaluate("document.querySelectorAll('#pv-agendas details').length") == 2
            first = page.evaluate("(() => { const d = document.querySelector('#pv-agendas details'); return { open: d.open, summary: d.querySelector('summary').textContent, h: d.querySelector('summary').getBoundingClientRect().height }; })()")
            assert first["open"] is False, "a block is collapsed until the admin opens it"
            assert first["summary"] == "Holder A - 2 active, 1 resolved", first
            assert first["h"] >= 40, "the summary is a phone-sized tap target"
            page.click("#pv-agendas details summary")
            text = page.inner_text("#pv-agendas details")
            for needle in ("[week] get them out -> Target B", "because: threat read about Target B weight 80%", "worked if: Target B is evicted", "commitment 80%", "History (resolved", "[week] stay safe"):
                assert needle in text, (needle, text)
            # readable on a phone: nothing makes the page scroll sideways
            assert page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") <= 1
            page.click("#pv-reseal")
            assert page.evaluate("document.getElementById('pv-agendas').children.length") == 0
            assert page.evaluate("document.getElementById('pv-panel').style.display") == "none"
            assert "Holder A" not in page.inner_text("body")
        finally:
            browser.close()


def test_a_refused_unseal_renders_no_agendas(monkeypatch):
    sync_api = pytest.importorskip("playwright.sync_api")
    html = _html(monkeypatch)
    with sync_api.sync_playwright() as pw:
        browser, page, _posts = _page_with_stubs(pw, html, {"ok": False, "reason": "no active game to unseal"})
        try:
            page.click("#producer-vault")
            page.wait_for_function("document.getElementById('pv-body').textContent.indexOf('Could not unseal') >= 0", timeout=10000)
            assert page.evaluate("document.getElementById('pv-agendas').children.length") == 0
        finally:
            browser.close()


def test_the_agenda_renderer_is_called_only_from_the_explicit_unseal(monkeypatch):
    """Source pin (the mutation guard): renderAgendas is defined once and CALLED only inside unsealProducerVault - never on load, never from a poll."""
    html = _html(monkeypatch)
    assert len(re.findall(r"function renderAgendas\(", html)) == 1
    calls = [m.start() for m in re.finditer(r"renderAgendas\(", html)]
    assert len(calls) == 2, "the definition and exactly one call"
    start = html.index("async function unsealProducerVault()")
    end = html.index('document.getElementById("producer-vault").addEventListener')
    assert start < calls[1] < end, "the one call sits inside unsealProducerVault"
    assert 'id="pv-agendas"' in html and html.index('id="pv-agendas"') > html.index('id="pv-panel"'), "the region lives inside the hidden panel"
