"""A85 - the chat input boundary (frontend/src/chat_helpers.py) had no direct tests: validate_message, validate_file_upload, coerce_message_and_session, extract_urls. Table-driven, no network.
Boundary mutations that must go red: `>` -> `>=` on the 50000 and on the size checks, and dropping `.lower()` on the extension. Roles only."""
import importlib
import io

import pytest
from fastapi import HTTPException

ch = importlib.import_module("src.chat_helpers")


# ── validate_message ──────────────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("message,detail", [(None, "Message is required"), ("", "Message is required"), ("   \n\t ", "Message cannot be empty"), ("x" * 50001, "Message exceeds maximum length"), (" " + "x" * 50001, "Message exceeds maximum length")])
def test_validate_message_rejects_with_400(message, detail):
    with pytest.raises(HTTPException) as e:
        ch.validate_message(message)
    assert e.value.status_code == 400 and e.value.detail == detail


@pytest.mark.parametrize("message,expected_len", [("hi", 2), ("  padded  ", 6), ("x" * 50000, 50000), ("\n" + "x" * 50000 + "\n", 50000)])
def test_validate_message_accepts_and_strips_exactly_up_to_the_limit(message, expected_len):
    assert len(ch.validate_message(message)) == expected_len


# ── validate_file_upload ──────────────────────────────────────────────────────────────────────────────────
class _Up:
    def __init__(self, name, data=b"abc", raise_on=None):
        self.filename = name
        self.file = _Raising(data, raise_on) if raise_on else io.BytesIO(data)


class _Raising(io.BytesIO):
    def __init__(self, data, what):
        super().__init__(data); self._what = what

    def seek(self, *a, **k):
        if self._what == "seek":
            raise IOError("seek failed")
        return super().seek(*a, **k)

    def tell(self):
        if self._what == "tell":
            raise IOError("tell failed")
        return super().tell()


@pytest.fixture
def limit10(monkeypatch):
    monkeypatch.setattr(ch, "get_chat_upload_max_bytes", lambda: 10)
    return 10


def _code(exc):
    d = exc.value.detail
    return exc.value.status_code, (d.get("error") if isinstance(d, dict) else d)


@pytest.mark.parametrize("up", [None, _Up(None), _Up("")])
def test_upload_without_a_filename_is_invalid(up, limit10):
    with pytest.raises(HTTPException) as e:
        ch.validate_file_upload(up)
    assert _code(e) == (400, "INVALID_FILE")


def test_upload_size_boundaries(limit10):
    assert ch.validate_file_upload(_Up("a.txt", b"x" * 10)).filename == "a.txt", "size == limit is accepted"
    with pytest.raises(HTTPException) as e:
        ch.validate_file_upload(_Up("a.txt", b"x" * 11))
    assert _code(e) == (400, "FILE_TOO_LARGE"), "limit + 1 is refused"
    with pytest.raises(HTTPException) as e:
        ch.validate_file_upload(_Up("a.txt", b""))
    assert _code(e) == (400, "EMPTY_FILE")
    assert ch.validate_file_upload(_Up("a.txt", b"x")).filename == "a.txt", "size 1 is accepted"


@pytest.mark.parametrize("what", ["seek", "tell"])
def test_a_read_error_while_sizing_is_a_500(what, limit10):
    with pytest.raises(HTTPException) as e:
        ch.validate_file_upload(_Up("a.txt", b"x", raise_on=what))
    assert _code(e) == (500, "FILE_READ_ERROR")


@pytest.mark.parametrize("name", ["a.TXT", "photo.JPG", "Notes.Md", "clip.WebM", "x.PDF"])
def test_extension_check_is_case_insensitive(name, limit10):
    assert ch.validate_file_upload(_Up(name, b"x")).filename == name


@pytest.mark.parametrize("name,ext", [("evil.exe", ".exe"), ("noext", ""), ("archive.tar.gz", ".gz"), ("shell.SH", ".sh")])
def test_an_unsupported_extension_is_refused_and_lists_the_allowed_types(name, ext, limit10):
    with pytest.raises(HTTPException) as e:
        ch.validate_file_upload(_Up(name, b"x"))
    d = e.value.detail
    assert e.value.status_code == 400 and d["error"] == "UNSUPPORTED_FILE_TYPE" and f"'{ext}'" in d["message"]
    assert ".txt" in d["allowed_types"] and ".webp" in d["allowed_types"] and d["allowed_types"] == sorted(d["allowed_types"])


def test_the_size_check_runs_before_the_extension_check(limit10):
    with pytest.raises(HTTPException) as e:
        ch.validate_file_upload(_Up("evil.exe", b"x" * 11))
    assert _code(e)[1] == "FILE_TOO_LARGE"


# ── coerce_message_and_session ────────────────────────────────────────────────────────────────────────────
class _SM:
    def __init__(self, known=("s1",)):
        self.known = set(known)

    def get_session(self, sid):
        if sid not in self.known:
            raise KeyError(sid)
        return object()


def test_coerce_takes_params_then_falls_back_to_the_json_body():
    assert ch.coerce_message_and_session(None, "hi", "s1", _SM()) == ("hi", "s1")
    assert ch.coerce_message_and_session({"message": " from json ", "session": "s1"}, None, None, _SM()) == ("from json", "s1")
    assert ch.coerce_message_and_session({"message": "ignored", "session": "s1"}, "param", None, _SM()) == ("param", "s1"), "an explicit param wins over the body"


def test_coerce_missing_everything_is_a_400_missing_parameters():
    with pytest.raises(HTTPException) as e:
        ch.coerce_message_and_session(None, None, None, _SM())
    assert _code(e) == (400, "MISSING_PARAMETERS")


def test_coerce_missing_session_and_unknown_session():
    with pytest.raises(HTTPException) as e:
        ch.coerce_message_and_session({"message": "hi", "session": ""}, None, None, _SM())
    assert _code(e) == (400, "VALIDATION_ERROR")
    with pytest.raises(HTTPException) as e:
        ch.coerce_message_and_session(None, "hi", "nope", _SM())
    assert _code(e) == (404, "SESSION_NOT_FOUND")


def test_coerce_allow_empty_normalizes_whitespace_and_none_to_empty_string():
    assert ch.coerce_message_and_session(None, "   \n", "s1", _SM(), allow_empty=True) == ("", "s1")
    assert ch.coerce_message_and_session({"session": "s1"}, None, None, _SM(), allow_empty=True) == ("", "s1")
    with pytest.raises(HTTPException) as e:
        ch.coerce_message_and_session(None, "   ", "s1", _SM(), allow_empty=False)
    assert _code(e)[0] == 400


# ── extract_urls ──────────────────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("text,expected", [
    ("see https://example.test/a, then http://x.test/b.", ["https://example.test/a", "http://x.test/b"]),
    ("(https://example.test/p?q=1)!", ["https://example.test/p?q=1"]),
    ("no links here, ftp://nope.test is not http", []),
    ("<https://a.test/x> and \"https://b.test/y\"", ["https://a.test/x", "https://b.test/y"]),
    ("", []),
])
def test_extract_urls(text, expected):
    assert ch.extract_urls(text) == expected
