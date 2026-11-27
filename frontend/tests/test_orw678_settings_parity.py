"""ORW-678: portrait_brief_enabled was off by default in production while the tests turned it on, so rounds of work never reached players.

CI: a boolean setting that ships OFF may be switched on by tests only for the reasons below; any new one fails here. RUNTIME: the admin health names the settings an install runs differently from the default.
"""
import glob
import os
import re

from src.settings import DEFAULT_SETTINGS

_HERE = os.path.dirname(__file__)
#: settings that ship off ON PURPOSE and whose "on" behaviour is tested ahead of the switch
_OFF_ON_PURPOSE = {
    "act_first_enabled": "ORW-1014 PR 2: the act-first round, off until measured",
    "offscreen_texture_enrichment": "off by default by ruling; its test asserts the default",
}


def _tests_that_enable(key: str) -> list:
    pat = re.compile(r"""["']""" + key + r"""["']\s*:\s*(True|"on"|"true")|["']""" + key + r"""["'],\s*True|k == ["']""" + key + r"""["']\s*else|""" + key + r"""["']\]\s*=\s*True""")
    return [os.path.basename(f) for f in glob.glob(os.path.join(_HERE, "test_*.py"))
            if os.path.basename(f) != os.path.basename(__file__) and pat.search(open(f, encoding="utf-8").read())]


def test_no_test_turns_on_a_shipped_off_setting_unannounced():
    surprises = {k: hits for k, v in DEFAULT_SETTINGS.items() if v is False and k not in _OFF_ON_PURPOSE for hits in [_tests_that_enable(k)] if hits}
    assert surprises == {}, f"tests exercise settings that ship OFF (turn them on by default, or say why here): {surprises}"


def test_health_names_the_settings_off_their_default(monkeypatch):
    from routes import admin_health_routes as h
    from src import settings
    monkeypatch.setattr(settings, "load_settings", lambda: {**DEFAULT_SETTINGS, "portrait_brief_enabled": False})
    out = h._settings_parity_section()
    assert out == {"portrait_brief_enabled": False}
