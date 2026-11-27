"""ORW-146 - build-stamped static URLs are immutable; the page shell is gzipped; behaviour otherwise unchanged. No model."""
import gzip
import os
import re

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(scope="module")
def client():
    old = os.getcwd()
    os.chdir(FRONTEND)
    os.environ["ORWELL_FE_BUILD"] = "abc1234"
    try:
        import app as app_module
        from src import orwell_version
        orwell_version._cached_build = None
        app_module._HTML_TEMPLATE_CACHE.clear()
        with TestClient(app_module.app, raise_server_exceptions=False) as c:
            yield c
    finally:
        os.chdir(old)
        os.environ.pop("ORWELL_FE_BUILD", None)
        from src import orwell_version
        orwell_version._cached_build = None


def test_shell_stamps_classic_scripts_and_css(client):
    # ORW-1015 supersedes the "modules unstamped" half: modules are stamped too (their imports go through an import map to the same URL),
    # and adjacent classic scripts are served as one bundle; with the bundle off, the classic tags are stamped one by one.
    import app as app_module
    html = app_module._html_template(os.path.join(FRONTEND, "static", "index.html"))
    assert re.search(r'<link rel="stylesheet" href="/static/style\.css\?b=abc1234"', html)
    assert re.search(r'<script src="/static/_bundle/classic-[0-9a-f]{12}\.js"', html)
    assert re.search(r'type="module" src="[^"]*\?b=abc1234"', html)


def test_stamped_url_is_immutable_and_unstamped_or_stale_is_not(client):
    r = client.get("/static/js/chat.js?b=abc1234")
    assert "immutable" in r.headers["cache-control"] and "max-age=31536000" in r.headers["cache-control"]
    assert client.get("/static/js/chat.js").headers["cache-control"] == "no-cache"
    assert client.get("/static/js/chat.js?b=oldbuild").headers["cache-control"] == "no-cache"


def test_shell_is_gzipped_when_accepted_and_plain_otherwise(client):
    with client.stream("GET", "/", headers={"Accept-Encoding": "gzip"}) as r:
        wire = b"".join(r.iter_raw())
        assert r.headers["content-encoding"] == "gzip"
    plain = client.get("/", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in plain.headers
    assert len(wire) < len(plain.content) / 3
    nonce = re.search(r'nonce="([^"]+)"', gzip.decompress(wire).decode()).group(1)
    assert nonce and "{{CSP_NONCE}}" not in plain.text


def test_kill_switch_disables_stamping(client, monkeypatch):
    monkeypatch.setenv("ORWELL_STATIC_IMMUTABLE", "0")
    import app as app_module
    assert app_module._stamp_static_urls('<script src="/static/js/a.js"></script>', "abc") == \
        '<script src="/static/js/a.js"></script>'
    assert client.get("/static/js/chat.js?b=abc1234").headers["cache-control"] == "no-cache"
