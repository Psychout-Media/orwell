"""Feature 0067 / ADR 0007 — the public-profile fail-closed boot guard + Host allow-list.

Self-contained: imports only `core.middleware` (loaded via the conftest `core` stub), never boots
the full app. Mirrors the engine's fail-closed posture for an internet-facing deployment.
"""
import pytest

from core.middleware import assert_public_profile_safe, allowed_hosts_from_env

SAFE = {
    "ORWELL_PUBLIC": "1",
    "AUTH_ENABLED": "true",
    "LOCALHOST_BYPASS": "false",
    "SECURE_COOKIES": "true",
    "ALLOWED_HOSTS": "hiorwell.com,www.hiorwell.com",
    "ALLOWED_ORIGINS": "https://hiorwell.com,https://www.hiorwell.com",
}


def test_noop_when_public_not_selected():
    # Dormant unless ORWELL_PUBLIC is set: even a wildly unsafe posture is ignored, so the
    # default / trusted-LAN start path is byte-identical.
    env = {"AUTH_ENABLED": "false", "LOCALHOST_BYPASS": "true", "SECURE_COOKIES": "false"}
    assert_public_profile_safe(env)  # must not raise


def test_safe_public_profile_boots_green():
    assert_public_profile_safe(dict(SAFE))  # must not raise


@pytest.mark.parametrize(
    "key,bad",
    [
        ("AUTH_ENABLED", "false"),
        ("LOCALHOST_BYPASS", "true"),
        ("SECURE_COOKIES", "false"),
    ],
)
def test_refuses_each_unsafe_knob(key, bad):
    env = dict(SAFE)
    env[key] = bad
    with pytest.raises(RuntimeError) as exc:
        assert_public_profile_safe(env)
    assert key in str(exc.value)  # the refusal NAMES the offending setting


@pytest.mark.parametrize("bind", ["0.0.0.0", "::", "10.0.0.5"])
def test_refuses_public_bind_host(bind):
    # EXPOSE-1 (#623): a public profile must bind loopback and sit behind the proxy/tunnel; a
    # non-loopback bind host is refused and NAMED.
    env = dict(SAFE)
    env["ORWELL_BIND_HOST"] = bind
    with pytest.raises(RuntimeError) as exc:
        assert_public_profile_safe(env)
    assert "ORWELL_BIND_HOST" in str(exc.value)


@pytest.mark.parametrize("bind", ["127.0.0.1", "::1", "localhost"])
def test_allows_loopback_bind_host(bind):
    env = dict(SAFE)
    env["ORWELL_BIND_HOST"] = bind
    assert_public_profile_safe(env)  # must not raise


def test_refuses_unpinned_host():
    env = dict(SAFE)
    del env["ALLOWED_HOSTS"]
    with pytest.raises(RuntimeError) as exc:
        assert_public_profile_safe(env)
    assert "ALLOWED_HOSTS" in str(exc.value)


@pytest.mark.parametrize(
    "origins",
    [
        None,                       # unset entirely
        "*",                        # wildcard ⇒ credentialed reflection
        "https://ok.com,*",         # wildcard mixed in
        "http://hiorwell.com",      # plaintext http origin
        "https://ok.com,http://x",  # one non-https in the list
    ],
)
def test_refuses_unsafe_origins(origins):
    # SEC-1: with CORS allow_credentials=True, a "*"/http origin reflects credentials.
    env = dict(SAFE)
    if origins is None:
        del env["ALLOWED_ORIGINS"]
    else:
        env["ALLOWED_ORIGINS"] = origins
    with pytest.raises(RuntimeError) as exc:
        assert_public_profile_safe(env)
    assert "ALLOWED_ORIGINS" in str(exc.value)  # the refusal NAMES the offending setting


def test_allowed_hosts_default_is_wildcard():
    # Unset / empty ⇒ ["*"] so dev + trusted-LAN are unaffected.
    assert allowed_hosts_from_env({}) == ["*"]
    assert allowed_hosts_from_env({"ALLOWED_HOSTS": ""}) == ["*"]


def test_allowed_hosts_parses_csv():
    assert allowed_hosts_from_env({"ALLOWED_HOSTS": "a.com, b.com"}) == ["a.com", "b.com"]


@pytest.mark.parametrize("key", ["ALLOWED_HOSTS", "ALLOWED_ORIGINS", "ORWELL_BIND_HOST"])
def test_refuses_a_control_character_in_a_value_written_to_dotenv(key):
    # A newline inside any of these would start a new KEY=VALUE line when the root ops script upserts
    # data/.env — the guard fails closed and NAMES the key.
    env = dict(SAFE)
    env[key] = {"ALLOWED_HOSTS": "hiorwell.com\nAUTH_ENABLED=false",
                "ALLOWED_ORIGINS": "https://hiorwell.com\nX=1",
                "ORWELL_BIND_HOST": "127.0.0.1\nX=1"}[key]
    with pytest.raises(RuntimeError) as exc:
        assert_public_profile_safe(env)
    assert f"{key} contains a control character" in str(exc.value)


@pytest.mark.parametrize("bad", ["\nAUTH_ENABLED=false", "\r\nX=1", "\thiorwell.com"])
def test_a_leading_control_character_is_not_hidden_by_strip(bad):
    env = dict(SAFE)
    env["ALLOWED_HOSTS"] = bad
    with pytest.raises(RuntimeError) as exc:
        assert_public_profile_safe(env)
    assert "ALLOWED_HOSTS contains a control character" in str(exc.value)


def test_a_trailing_newline_alone_is_still_just_whitespace():
    # The boot path already .strip()s each value; a stray trailing newline (a CRLF-edited .env) is not
    # an embedded control character and must keep booting.
    env = dict(SAFE)
    env["ALLOWED_HOSTS"] = "hiorwell.com,www.hiorwell.com\n"
    assert_public_profile_safe(env)


def test_control_char_helpers():
    from core.middleware import control_char_fields, has_control_chars
    assert has_control_chars("a\nb") and has_control_chars("a\x00") and has_control_chars("a\x7f")
    assert has_control_chars(["ok", "bad\t"]) and has_control_chars("a\u2028b")
    assert not has_control_chars("hiorwell.com") and not has_control_chars(None)
    assert control_char_fields(a="x\n", b=["ok"], c=None) == ["a"]
