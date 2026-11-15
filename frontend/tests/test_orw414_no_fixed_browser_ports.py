"""ORW-414: no browser test (nor a helper one imports, nor the responsive-matrix script they drive) may bind a hard-coded listen port.

A fixed port means two browser tests cannot run at once (CI runs the browser lane with `-n 2`), and a stray local server on that port makes a
test flaky. Every stack takes its port from `tests/_ports.free_port()` (bind port 0). This is a source test, so it fails the day someone adds
`ORWELL_FOO_PORT` defaulting to "8801" or `("127.0.0.1", 8801)` to a browser test.
"""
import pathlib
import re

import _ports

_LAUNCHES = "sync_" + "playwright"  # split so this file is not itself auto-marked `browser` by conftest (which greps for the whole word)
TESTS = pathlib.Path(__file__).resolve().parent
SCRIPTS = TESTS.parent / "scripts"

# A literal 4-5 digit port in any place a server is told where to listen (or where a launched stack is told which port to take).
_FIXED = [
    re.compile(r"""environ(?:\.get)?\(\s*["'][A-Z0-9_]*PORT[A-Z0-9_]*["']\s*,\s*["']?\d{4,5}"""),   # os.environ.get("X_PORT", "8801")
    re.compile(r"""^\s*[A-Za-z_]*PORT\w*\s*=\s*(?:int\()?["']?\d{4,5}["']?\)?\s*(?:#.*)?$""", re.M),  # PORT = 8801
    re.compile(r"""\(\s*["'](?:127\.0\.0\.1|0\.0\.0\.0|localhost|)["']\s*,\s*\d{4,5}\s*\)"""),     # ("127.0.0.1", 8801) bind/connect tuple
    re.compile(r"""["']--port["']\s*,\s*["']\d{4,5}["']"""),                                      # "--port", "8801"
    re.compile(r"""--port[ =]\d{4,5}"""),                                                          # --port 8801
    re.compile(r"""ENGINE_PORT["']?\s*[:=]\s*["']?\d{4,5}"""),                                      # ORWELL_ENGINE_PORT="8801"
]


def _browser_sources():
    out = []
    for p in sorted(TESTS.glob("*.py")):
        if p.name == pathlib.Path(__file__).name:
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        # a browser test (conftest marks every module that launches the browser) or a shared helper the browser tests import
        if _LAUNCHES in text or (p.name.startswith("_") and p.name not in {"_ci_shard.py", "_ci_refresh_durations.py", "_ports.py"}):
            out.append(p)
    out.append(SCRIPTS / "responsive_matrix.py")
    return out


def test_no_browser_test_hard_codes_a_listen_port():
    offenders = []
    for p in _browser_sources():
        for n, line in enumerate(p.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
            if line.lstrip().startswith("#"):
                continue
            if any(rx.search(line) for rx in _FIXED):
                offenders.append(f"{p.relative_to(TESTS.parent)}:{n}: {line.strip()}")
    assert not offenders, "hard-coded listen port in a browser test (use tests/_ports.free_port()):\n" + "\n".join(offenders)


def test_the_source_check_sees_the_old_patterns():
    # a control: the regexes must catch the shapes the seven fixed-port tests used, or the guard above is blind
    samples = [
        '_PORT = int(os.environ.get("ORWELL_925_PORT", "8796"))',
        "PORT = 8967",
        'httpd = _Q(("127.0.0.1", 8799), handler)',
        '[sys.executable, "-m", "uvicorn", "app:app", "--port", "8893"]',
        'env = dict(os.environ, ORWELL_ENGINE_PORT="8765")',
    ]
    for s in samples:
        assert any(rx.search(s) for rx in _FIXED), s


def test_free_port_is_free_and_not_repeated():
    import socket
    seen = set()
    for _ in range(20):
        port = _ports.free_port()
        assert port not in seen
        seen.add(port)
        with socket.socket() as s:
            s.bind(("127.0.0.1", port))  # still bindable: nothing holds it
