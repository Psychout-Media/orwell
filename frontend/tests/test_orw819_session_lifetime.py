"""ORW-819 (from the 0067/0068 public-exposure leftovers): a session is short-lived and a logout revokes it on the server. Both were built (#581: the 24h default and
ORWELL_SESSION_TTL_HOURS; the logout route calls AuthManager.revoke_token), but nothing proved a logged-out token is refused afterwards. These pin it. No network."""
import importlib
import os

import pytest

auth_mod = importlib.import_module("core.auth")
AuthManager = auth_mod.AuthManager


@pytest.fixture
def auth(tmp_path):
    a = AuthManager(auth_path=os.path.join(str(tmp_path), "auth.json"))
    assert a.setup("operator", "a-long-test-password")
    return a


def test_a_logged_out_token_is_refused_and_stays_refused_after_a_restart(auth, tmp_path):
    token = auth.create_session("operator", "a-long-test-password")
    assert token and auth.validate_token(token)
    other = auth.create_session("operator", "a-long-test-password")   # a second device stays signed in
    auth.revoke_token(token)   # what POST /api/auth/logout does with the cookie's token
    assert not auth.validate_token(token)
    assert auth.get_username_for_token(token) is None
    assert auth.validate_token(other)
    reloaded = AuthManager(auth_path=os.path.join(str(tmp_path), "auth.json"))   # sessions persist: the revocation must too
    assert not reloaded.validate_token(token)
    assert reloaded.validate_token(other)


def test_a_session_past_its_lifetime_is_refused(auth, monkeypatch):
    token = auth.create_session("operator", "a-long-test-password")
    now = auth_mod.time.time()
    monkeypatch.setattr(auth_mod.time, "time", lambda: now + auth_mod.TOKEN_TTL + 1)
    assert not auth.validate_token(token)
    assert auth.get_username_for_token(token) is None


@pytest.mark.parametrize("raw,hours", [("", 24), ("6", 6), ("0.5", 24), ("bogus", 24), ("10000", 24)])
def test_the_lifetime_defaults_to_24h_and_the_override_is_clamped(monkeypatch, raw, hours):
    monkeypatch.setenv("ORWELL_SESSION_TTL_HOURS", raw)
    assert auth_mod._token_ttl_seconds() == hours * 3600
