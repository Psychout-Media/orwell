"""/play serving: no-cache index, immutable hashed assets, gzip, traversal-safe, graceful when unbuilt."""
import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes.play_routes import setup_play_routes


@pytest.fixture()
def dist(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text('<div id="root"></div><script type="module" src="/play/assets/index-abc.js"></script>')
    (tmp_path / "assets" / "index-abc.js").write_text("console.log('hi');" * 50)
    (tmp_path / "assets" / "style-abc.css").write_text("body{margin:0}")
    (tmp_path / "secret.txt").write_text("nope")
    return tmp_path


def client(dist_dir):
    app = FastAPI()
    app.include_router(setup_play_routes(str(dist_dir)))
    return TestClient(app)


def test_index_is_no_cache(dist):
    r = client(dist).get("/play")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-cache"
    assert "root" in r.text
    assert client(dist).get("/play/").status_code == 200


def test_assets_are_immutable_and_correct_type(dist):
    r = client(dist).get("/play/assets/index-abc.js", headers={"accept-encoding": "identity"})
    assert r.status_code == 200
    assert "immutable" in r.headers["cache-control"] and "max-age=31536000" in r.headers["cache-control"]
    assert r.headers["content-type"].startswith("text/javascript")
    assert client(dist).get("/play/assets/style-abc.css").headers["content-type"].startswith("text/css")


def test_assets_are_gzipped_when_accepted(dist):
    r = client(dist).get("/play/assets/index-abc.js", headers={"accept-encoding": "gzip"})
    assert r.headers.get("content-encoding") == "gzip"
    raw = open(os.path.join(dist, "assets", "index-abc.js"), "rb").read()
    assert r.content == raw  # the client transparently decoded it


def test_path_traversal_is_refused(dist):
    c = client(dist)
    assert c.get("/play/assets/../secret.txt").status_code in (404, 307)
    assert c.get("/play/assets/%2e%2e/secret.txt").status_code == 404
    assert c.get("/play/assets/missing.js").status_code == 404


def test_unbuilt_dist_gives_a_clear_503_not_a_crash(tmp_path):
    r = client(tmp_path / "nope").get("/play")
    assert r.status_code == 503
    assert "classic" in r.text.lower()
