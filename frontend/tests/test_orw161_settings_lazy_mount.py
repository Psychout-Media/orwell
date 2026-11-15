"""ORW-161 slice 1 - the Settings DOM is lazy-mounted (inert <template>, stamped on first open)."""
import os
from html.parser import HTMLParser

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")
INDEX = open(os.path.join(STATIC, "index.html"), encoding="utf-8").read()
SETTINGS_JS = open(os.path.join(STATIC, "js", "settings.js"), encoding="utf-8").read()


class _Count(HTMLParser):
    def __init__(self):
        super().__init__()
        self.live = 0
        self.tpl = 0
        self.depth = 0
        self.live_ids = set()

    def handle_starttag(self, tag, attrs):
        if self.depth:
            self.tpl += 1
            if tag == "template":
                self.depth += 1
            return
        self.live += 1
        self.live_ids.update(v for k, v in attrs if k == "id")
        if tag == "template":
            self.depth = 1

    def handle_endtag(self, tag):
        if tag == "template" and self.depth:
            self.depth -= 1


def _parse():
    p = _Count()
    p.feed(INDEX)
    return p


def test_settings_dom_is_inert_at_load():
    p = _parse()
    assert 'id="settings-host" hidden' in INDEX
    assert '<template id="settings-template">' in INDEX
    assert p.tpl > 500, "the Settings DOM must live inside the inert template"
    assert "settings-account-avatar" not in p.live_ids
    assert "settings-tab-services" not in p.live_ids
    assert "set-defaultModelSelect" not in p.live_ids
    assert "settings-host" in p.live_ids


def test_settings_content_still_in_source_for_pins():
    t0 = INDEX.index('<template id="settings-template">')
    assert t0 < INDEX.index('class="modal-content settings-modal-content"') < INDEX.index("</template>", t0)


def test_initkitwindow_stamps_template_before_lookup():
    i = SETTINGS_JS.index("function initKitWindow()")
    body = SETTINGS_JS[i:i + 2500]
    assert "template#settings-template" in body
    assert body.index("appendChild(tpl.content)") < body.index("querySelector('.settings-modal-content')")
    assert "OrwellAvatar.refresh" in body
    j = SETTINGS_JS.index("export function open(")
    assert "if (!initialized) initAll();" in SETTINGS_JS[j:j + 120]
