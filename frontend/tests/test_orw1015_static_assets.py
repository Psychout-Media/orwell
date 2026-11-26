"""ORW-1015 - cacheable ES modules (import map), classic-script bundles, minified CSS. No model, no browser."""
import os
import re

import pytest

from src import static_assets as sa

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(FRONTEND, "static")


# ── CSS ──────────────────────────────────────────────────────────────────────────────────────────────────────────
def test_css_minify_keeps_strings_urls_and_meaning():
    src = 'a  b , c {  color : red ; /* gone */ background:url(data:image/png;base64,/*keep*/) ; content:"  /* x */ " }\n@media (min-width: 1px) and (max-width:2px){ .a > .b{margin:0 auto} }'
    out = sa.minify_css(src)
    assert "gone" not in out
    assert 'url(data:image/png;base64,/*keep*/)' in out
    assert 'content:"  /* x */ "' in out
    assert "a b,c{" in out                       # the descendant-combinator space survives, the list space does not
    assert "@media (min-width: 1px) and (max-width:2px){" in out
    assert ".a > .b{margin:0 auto}" in out


def test_css_minify_a_comment_between_tokens_leaves_a_space():
    assert sa.minify_css("a/**/b{x:y}") == "a b{x:y}"


def test_real_stylesheet_shrinks_a_lot_and_keeps_its_rule_count():
    raw = open(os.path.join(STATIC, "style.css"), encoding="utf-8").read()
    out = sa.minify_css(raw)
    assert len(out) < len(raw) * 0.75
    strip = lambda t: re.sub(r"/\*.*?\*/", "", t, flags=re.S)
    assert out.count("{") == strip(raw).count("{") and out.count("}") == strip(raw).count("}")


# ── modules ──────────────────────────────────────────────────────────────────────────────────────────────────────
def test_every_static_import_of_a_module_is_covered_by_the_import_map():
    """If an import resolved to a file the map lacks, the tag (stamped) and the import (unstamped) would be two URLs: a module loaded twice."""
    mapped = set(sa.module_files(STATIC))
    pat = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{0,2}/[^'"]+\.js)\1""")
    missing = []
    for root, _d, files in os.walk(os.path.join(STATIC, "js")):
        for fn in files:
            if not fn.endswith(".js"):
                continue
            path = os.path.join(root, fn)
            for m in pat.finditer(open(path, encoding="utf-8").read()):
                spec = m.group(2)
                target = os.path.normpath(os.path.join(STATIC, spec[len("/static/"):]) if spec.startswith("/static/")
                                          else os.path.join(os.path.dirname(path), spec))
                if not os.path.isfile(target) or not target.startswith(STATIC):
                    continue
                rel = "/static/" + os.path.relpath(target, STATIC).replace(os.sep, "/")
                if rel not in mapped:
                    missing.append((path, spec))
    assert missing == []


def test_stamp_and_map_use_the_identical_url():
    html = '<head><link rel="modulepreload" href="/static/app.js">\n<script type="module" src="/static/js/ui.js"></script></head>'
    out = sa.transform_page(html, STATIC, "abc123", True)
    assert '<script type="importmap" nonce="{{CSP_NONCE}}">' in out
    assert out.index("importmap") < out.index("modulepreload")
    assert '"/static/js/ui.js":"/static/js/ui.js?b=abc123"' in out.replace(" ", "")
    assert 'src="/static/js/ui.js?b=abc123"' in out and 'href="/static/app.js?b=abc123"' in out


def test_module_tags_with_other_attributes_are_stamped_too():
    """The login page writes `type="module" nonce=... src=...`; an unstamped tag beside a mapped import would load the module twice."""
    html = '<script type="module" nonce="{{CSP_NONCE}}" src="/static/js/login_bg.js"></script><link crossorigin rel="modulepreload" href="/static/js/ui.js">'
    out = sa.transform_page(html, STATIC, "abc123", True)
    assert 'src="/static/js/login_bg.js?b=abc123"' in out and 'href="/static/js/ui.js?b=abc123"' in out
    assert out.index("importmap") < out.index("login_bg")


def test_a_dropped_script_name_stays_out_of_the_map():
    out = sa.transform_page('<script type="module" src="/static/js/ui.js"></script>', STATIC, "abc123", True, ("tourHints.js",))
    assert "tourHints.js" not in out and "/static/js/ui.js?b=abc123" in out


def test_no_build_id_means_no_stamp_and_no_map():
    out = sa.transform_page('<script type="module" src="/static/js/ui.js"></script>', STATIC, "unknown", False)
    assert "importmap" not in out and "?b=" not in out


# ── classic bundles ──────────────────────────────────────────────────────────────────────────────────────────────
@pytest.fixture
def tree(tmp_path):
    (tmp_path / "js").mkdir()
    def mk(name, text):
        (tmp_path / "js" / name).write_text(text, encoding="utf-8")
    mk("a.js", "window.A = 1;\n// trailing comment")
    mk("b.js", "const B = 2; window.B = B;")
    mk("c.js", "window.C = 3;")
    mk("strict.js", "'use strict';\nwindow.S = 1;")
    mk("dup.js", "const B = 9;")
    return tmp_path


def _tag(n, extra=""):
    return f'<script{extra} src="/static/js/{n}.js"></script>'


def test_adjacent_classic_scripts_become_one_bundle_in_order(tree):
    html = "<body>\n" + _tag("a") + "  <!-- note -->\n" + _tag("b") + "\n" + _tag("c") + "\n</body>"
    out = sa.transform_page(html, str(tree), "x1", True)
    assert out.count("<script") == 1
    name = re.search(r"/static/_bundle/(classic-[0-9a-f]{12}\.js)", out).group(1)
    body = sa.get_bundle(name).decode()
    assert body.index("window.A") < body.index("window.B") < body.index("window.C")
    assert "// trailing comment\n;" in body        # a trailing line comment cannot swallow the next file


def test_an_element_between_scripts_splits_the_run(tree):
    html = _tag("a") + _tag("b") + '<div id="x"></div>' + _tag("c")
    out = sa.transform_page(html, str(tree), "x1", True)
    assert out.count("<script") == 2 and '<script src="/static/js/c.js' in out


def test_deferred_and_module_scripts_do_not_split_or_join(tree):
    html = _tag("a") + '<script type="module" src="/static/js/ui.js"></script>' + _tag("c", " defer") + _tag("b")
    out = sa.transform_page(html, str(tree), "x1", True)
    assert 'defer src="/static/js/c.js"' in out                      # the deferred one is untouched
    assert out.count('src="/static/_bundle/') == 1 and 'src="/static/js/b.js' not in out


def test_an_inline_script_is_a_barrier(tree):
    html = _tag("a") + "<script>window.x=1</script>" + _tag("b")
    out = sa.transform_page(html, str(tree), "x1", True)
    assert "_bundle" not in out and out.count("<script") == 3


def test_use_strict_or_a_duplicate_lexical_name_or_a_missing_file_leaves_the_run_alone(tree):
    for bad in (_tag("a") + _tag("strict"), _tag("b") + _tag("dup"), _tag("a") + _tag("nope")):
        assert "_bundle" not in sa.transform_page(bad, str(tree), "x1", True)


def test_kill_switch(tree, monkeypatch):
    monkeypatch.setenv("ORWELL_STATIC_BUNDLE", "0")
    html = _tag("a") + _tag("b")
    assert sa.transform_page(html, str(tree), "x1", True) == html


# ── the real page, through the app ───────────────────────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def client():
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
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


def test_real_page_has_map_stamped_modules_and_one_classic_bundle(client):
    import app as app_module
    html = app_module._html_template(os.path.join(FRONTEND, "static", "index.html")).replace("{{CSP_NONCE}}", "n")
    assert html.count('type="importmap"') == 1
    assert html.index('type="importmap"') < html.index('type="module"')
    mods = re.findall(r'<script type="module" src="(/static/[^"]+)"', html)
    assert mods and all(u.endswith("?b=abc1234") for u in mods)
    for u in mods:  # the tag's URL is the map's value for that module: one record per module
        assert f'"{u.split("?")[0]}":"{u}"' in html.replace(" ", "")
    bundles = re.findall(r'<script src="(/static/_bundle/classic-[0-9a-f]{12}\.js)"', html)
    assert 1 <= len(bundles) <= 3
    r = client.get(bundles[0])
    assert r.status_code == 200 and "immutable" in r.headers["cache-control"] and "javascript" in r.headers["content-type"]
    assert client.get("/static/_bundle/classic-000000000000.js").status_code == 404


def test_real_stylesheet_is_minified_and_revalidates_with_an_etag(client):
    r = client.get("/static/style.css", headers={"Accept-Encoding": "identity"})
    assert r.status_code == 200 and len(r.content) < 700_000
    etag = r.headers["etag"]
    assert client.get("/static/style.css", headers={"If-None-Match": etag}).status_code == 304
    stamped = client.get("/static/style.css?b=abc1234")
    assert "immutable" in stamped.headers["cache-control"]


def test_manual_v_cache_busters_become_the_build_stamp(client):
    import app as app_module
    html = app_module._html_template(os.path.join(FRONTEND, "static", "index.html"))
    assert "?v=2026" not in html
    assert 'href="/static/css/game-trim.css?b=abc1234"' in html
    assert 'defer src="/static/js/sessionSync.js?b=abc1234"' in html
