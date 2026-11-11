"""ORW-175 - the page shell is processed once and cached; only the CSP nonce is substituted per request.

Pins: the body is byte-identical across requests modulo the nonce; the page shell is opened once for N requests
(was N); a changed file (mtime) refreshes the cache. Also prints a median-time micro-benchmark for `/` and
`/api/health` (informational, `pytest -s`). No model.
"""
import builtins
import os
import re
import statistics
import time

import pytest
from fastapi.testclient import TestClient

import app as app_module


@pytest.fixture
def client():
    app_module._HTML_TEMPLATE_CACHE.clear()
    with TestClient(app_module.app) as c:
        yield c


def _nonces(body: str):
    return set(re.findall(r'nonce="([^"]+)"', body))


def test_body_is_identical_across_requests_modulo_the_nonce(client):
    a, b = client.get("/"), client.get("/")
    assert a.status_code == b.status_code == 200
    na, nb = _nonces(a.text), _nonces(b.text)
    if na or nb:  # when the shell carries nonces, they differ per request and are the only difference
        assert na != nb
    norm = lambda t, ns: t.replace(next(iter(ns)), "NONCE") if ns else t  # noqa: E731
    assert norm(a.text, na) == norm(b.text, nb)
    assert "{{CSP_NONCE}}" not in a.text and "{{BUILD_ID}}" not in a.text


def test_index_html_is_opened_once_for_many_requests(client, monkeypatch):
    real_open, opened = builtins.open, []

    def counting_open(file, *a, **k):
        if str(file).endswith(".html"):  # the shell the test client lands on (index.html, or login.html when auth redirects)
            opened.append(str(file))
        return real_open(file, *a, **k)

    app_module._HTML_TEMPLATE_CACHE.clear()  # startup may already have served the shell once
    monkeypatch.setattr(builtins, "open", counting_open)
    for _ in range(25):
        assert client.get("/").status_code == 200
    assert len(opened) == 1, opened


def test_the_cache_refreshes_when_the_file_changes(client, tmp_path):
    f = tmp_path / "shell.html"
    f.write_text("<html><body>one {{CSP_NONCE}}</body></html>", encoding="utf-8")
    assert "one" in app_module._html_template(str(f))
    f.write_text("<html><body>two!! {{CSP_NONCE}}</body></html>", encoding="utf-8")
    os.utime(f, ns=(1, 2))  # force a different mtime even on coarse clocks
    assert "two!!" in app_module._html_template(str(f))


def test_micro_benchmark_prints_medians(client):
    def median_ms(path, n=200):
        ts = []
        for _ in range(n):
            t = time.perf_counter()
            client.get(path)
            ts.append((time.perf_counter() - t) * 1000)
        return statistics.median(ts)

    class _NoCache(dict):
        def get(self, *a, **k):
            return None

    cached = {p: median_ms(p) for p in ("/", "/api/health")}
    orig = app_module._HTML_TEMPLATE_CACHE
    app_module._HTML_TEMPLATE_CACHE = _NoCache()  # emulates the old read-and-process-per-request path
    try:
        uncached = {p: median_ms(p) for p in ("/", "/api/health")}
    finally:
        app_module._HTML_TEMPLATE_CACHE = orig
    print(f"\nORW-175 median ms (N=200): cached {cached} | uncached {uncached}")
    assert cached["/"] <= uncached["/"] * 1.5  # sanity only; timing is not a gate
