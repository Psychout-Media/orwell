"""ORW-179 (slice 1): the CORS allow_headers list must not advertise the internal loopback credential headers to a cross-origin page. Pinned on app.py's CORSMiddleware call (importing app boots the whole server). No model."""
import ast
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app.py"


def _cors_allow_headers():
    tree = ast.parse(APP.read_text())
    for n in ast.walk(tree):
        if isinstance(n, ast.Call) and getattr(n.func, "attr", "") == "add_middleware" and n.args \
                and getattr(n.args[0], "id", "") == "CORSMiddleware":
            for kw in n.keywords:
                if kw.arg == "allow_headers":
                    return [e.value for e in kw.value.elts if isinstance(e, ast.Constant)]
    raise AssertionError("CORSMiddleware allow_headers not found in app.py")


def test_the_loopback_credential_headers_are_not_cors_allowed():
    allowed = [h.lower() for h in _cors_allow_headers()]
    assert "x-orwell-internal-token" not in allowed and "x-orwell-owner" not in allowed, allowed


def test_the_ordinary_headers_still_pass():
    allowed = [h.lower() for h in _cors_allow_headers()]
    assert {"content-type", "authorization", "x-requested-with", "x-tz-offset"} <= set(allowed)


def test_the_server_side_loopback_callers_are_unaffected():
    # the in-process tools send the token server-side (not subject to CORS): the constants are intact
    from core.middleware import INTERNAL_TOOL_HEADER, INTERNAL_TOOL_TOKEN
    assert INTERNAL_TOOL_HEADER and INTERNAL_TOOL_TOKEN
