"""ORW-164 S1 — gzip on the /static mount ONLY (never SSE / API / WS). No model."""
import gzip
import os

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSET = "/static/js/chat.js"


@pytest.fixture(scope="module")
def client():
    old = os.getcwd()
    os.chdir(FRONTEND)  # the mount uses the relative directory "static"
    try:
        import app as app_module

        with TestClient(app_module.app, raise_server_exceptions=False) as c:
            yield c
    finally:
        os.chdir(old)


def _raw():
    with open(os.path.join(FRONTEND, "static", "js", "chat.js"), "rb") as f:
        return f.read()


def test_static_js_is_gzipped_and_roundtrips(client):
    r = client.get(ASSET, headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    assert r.headers.get("content-encoding") == "gzip"
    assert "accept-encoding" in r.headers.get("vary", "").lower()
    assert r.content == _raw()  # httpx transparently decodes


def test_wire_bytes_are_gzip_of_the_file(client):
    with client.stream("GET", ASSET, headers={"Accept-Encoding": "gzip"}) as r:
        wire = b"".join(r.iter_raw())
    assert gzip.decompress(wire) == _raw()
    assert len(wire) < len(_raw())


def test_no_encoding_without_accept_encoding(client):
    r = client.get(ASSET, headers={"Accept-Encoding": "identity"})
    assert r.status_code == 200
    assert "content-encoding" not in r.headers
    assert r.content == _raw()


def test_cache_control_and_conditional_requests_intact(client):
    r = client.get(ASSET, headers={"Accept-Encoding": "gzip"})
    assert r.headers["cache-control"] == "no-cache"
    etag = r.headers.get("etag")
    assert etag
    r2 = client.get(ASSET, headers={"Accept-Encoding": "gzip", "If-None-Match": etag})
    assert r2.status_code == 304
    assert r2.headers["cache-control"] == "no-cache"


def test_api_and_sse_routes_are_not_gzipped(client):
    h = {"Accept-Encoding": "gzip"}
    assert "content-encoding" not in client.get("/api/chat/stream_status/none", headers=h).headers
    # SSE route: read headers only, never the body (a live stream would block the test).
    with client.stream("POST", "/api/chat_stream", headers=h, json={"message": "x"}) as r:
        assert "content-encoding" not in r.headers


def test_gzip_is_scoped_to_the_static_mount_only():
    src = open(os.path.join(FRONTEND, "app.py"), encoding="utf-8").read()
    assert src.count("GZipMiddleware(") == 1
    assert "add_middleware(GZipMiddleware" not in src
