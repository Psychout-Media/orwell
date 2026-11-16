"""ORW-483: the call-time key lookup for a session (ORW-199) must still find the key when

(a) two endpoints share one base URL with different keys — the row records no endpoint id, so the
    tie is broken by what is known: the session's model and the configured default endpoint; and
(b) the session was created while DNS failed, so it stored the IP form `resolve_url` produced,
    and the endpoint's hostname form is back in use.

Private in-memory DB, fixture keys and documentation-range hosts only; no network (the resolver's
DNS and Tailscale calls are replaced on the module under test).
"""
import json
import socket
import types

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import core.database as d
from src import endpoint_resolver as er

BASE = "https://gw.example.test/v1"
LAN_HOST = "llm.example.test"
LAN_IP = "192.0.2.10"


@pytest.fixture()
def db(monkeypatch):
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    d.Base.metadata.create_all(eng, tables=[d.ModelEndpoint.__table__, d.Session.__table__])
    S = sessionmaker(bind=eng)
    monkeypatch.setattr(er, "SessionLocal", S)
    return S


@pytest.fixture()
def settings(monkeypatch):
    """Fake settings: only what the lookup reads (no data/settings.json)."""
    values = {"default_endpoint_id": ""}
    import src.settings as st
    monkeypatch.setattr(st, "load_settings", lambda *a, **k: dict(values))
    monkeypatch.setattr(st, "get_user_setting", lambda key, owner="", default=None: values.get(key, default))
    return values


@pytest.fixture()
def resolver(monkeypatch):
    """DNS and `tailscale status` as seen by the resolver; `dns_ok` toggles a DNS outage."""
    state = {"dns_ok": True}

    def getaddrinfo(host, *a, **k):
        if not state["dns_ok"]:
            raise socket.gaierror("no DNS")
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("198.51.100.7", 0))]

    def run(*a, **k):
        peers = {"p1": {"HostName": LAN_HOST, "DNSName": LAN_HOST + ".",
                        "TailscaleIPs": [LAN_IP]}}
        return types.SimpleNamespace(returncode=0, stdout=json.dumps({"Peer": peers}))

    monkeypatch.setattr(er, "socket", types.SimpleNamespace(
        getaddrinfo=getaddrinfo, gaierror=socket.gaierror, AF_INET=socket.AF_INET))
    monkeypatch.setattr(er, "subprocess", types.SimpleNamespace(run=run))
    monkeypatch.setattr(er, "_tailscale_cache", {})
    monkeypatch.setattr(er, "_tailscale_ips_cache", {}, raising=False)
    return state


def _ep(S, ep_id, base, key, models=None, owner="u1", pinned=None):
    with S() as s:
        s.add(d.ModelEndpoint(id=ep_id, name=ep_id, base_url=base, api_key=key, is_enabled=True,
                              owner=owner, cached_models=json.dumps(models) if models else None,
                              pinned_models=json.dumps(pinned) if pinned else None))
        s.commit()


def _sess(url, model="m-shared", headers=None, owner="u1"):
    return types.SimpleNamespace(id="s", endpoint_url=url, model=model, headers=headers or {}, owner=owner)


# ---- (a) same URL, two keys -------------------------------------------------------------------

def test_same_url_two_keys_session_on_the_second_endpoints_model_gets_the_second_key(db, settings):
    _ep(db, "first", BASE, "sk-test-a", models=["m-first"])
    _ep(db, "second", BASE, "sk-test-b", models=["m-second"])
    out = er.resolve_session_headers(_sess(BASE + "/chat/completions", model="m-second"))
    assert out.get("Authorization") == "Bearer sk-test-b"


def test_same_url_two_keys_default_endpoint_breaks_the_tie(db, settings):
    _ep(db, "first", BASE, "sk-test-a")
    _ep(db, "second", BASE, "sk-test-b")
    settings["default_endpoint_id"] = "second"
    out = er.resolve_session_headers(_sess(BASE + "/chat/completions"))
    assert out.get("Authorization") == "Bearer sk-test-b"


def test_genuine_tie_keeps_stored_headers(db, settings):
    """Nothing known distinguishes them: today's behaviour (stored headers) stands."""
    _ep(db, "first", BASE, "sk-test-a")
    _ep(db, "second", BASE, "sk-test-b")
    sess = _sess(BASE + "/chat/completions", headers={"X-Custom": "keep"})
    assert er.resolve_session_headers(sess) == {"X-Custom": "keep"}


def test_a_stored_key_is_never_overridden_by_the_tie_break(db, settings):
    _ep(db, "first", BASE, "sk-test-a", models=["m-first"])
    _ep(db, "second", BASE, "sk-test-b", models=["m-second"])
    stored = {"Authorization": "Bearer sk-test-a"}
    assert er.resolve_session_headers(_sess(BASE, model="m-second", headers=stored)) == stored
    # persisting / migrating stay conservative: an ambiguous match never strips a stored key
    assert er.persistable_session_headers(BASE, stored, "u1") == stored


# ---- (b) IP form vs hostname form -------------------------------------------------------------

def test_session_stored_with_ip_form_gets_the_endpoints_key_once_hostname_is_back(db, settings, resolver):
    base = f"http://{LAN_HOST}:8000/v1"
    resolver["dns_ok"] = False
    stored_url = er.build_chat_url(base)          # what session creation stored during the outage
    assert LAN_IP in stored_url and LAN_HOST not in stored_url

    resolver["dns_ok"] = True                     # later: DNS works, the hostname form is in use
    er._tailscale_cache.clear()
    getattr(er, "_tailscale_ips_cache", {}).clear()
    assert LAN_HOST in er.build_chat_url(base)

    _ep(db, "lan", base, "sk-test-a")
    assert er.session_url_matches_endpoint(stored_url, base)
    out = er.resolve_session_headers(_sess(stored_url))
    assert out.get("Authorization") == "Bearer sk-test-a"


def test_an_unrelated_ip_does_not_match_a_hostname_endpoint(db, settings, resolver):
    base = f"http://{LAN_HOST}:8000/v1"
    _ep(db, "lan", base, "sk-test-a")
    other = "http://192.0.2.99:8000/v1/chat/completions"
    assert not er.session_url_matches_endpoint(other, base)
    assert er.resolve_session_headers(_sess(other)) == {}


# ---- #2845 review ------------------------------------------------------------------------------

def test_an_ip_form_url_matches_only_with_the_same_scheme_and_port(db, settings, resolver):
    base = f"http://{LAN_HOST}:8000/v1"
    resolver["dns_ok"] = False
    stored_url = er.build_chat_url(base)          # the IP form, as stored during an outage
    resolver["dns_ok"] = True
    er._tailscale_cache.clear()
    getattr(er, "_tailscale_ips_cache", {}).clear()
    assert er.session_url_matches_endpoint(stored_url, base)                                   # control: same scheme and port
    assert not er.session_url_matches_endpoint(stored_url.replace("http://", "https://", 1), base)
    assert not er.session_url_matches_endpoint(stored_url.replace(":8000", ":9000", 1), base)


def test_a_pinned_model_counts_as_served_in_the_tie_break(db, settings):
    _ep(db, "first", BASE, "sk-test-a", models=["m-listed"])
    _ep(db, "second", BASE, "sk-test-b", models=["m-listed"], pinned=["m-pinned"])
    out = er.resolve_session_headers(_sess(BASE + "/chat/completions", model="m-pinned"))
    assert out.get("Authorization") == "Bearer sk-test-b"


def test_no_candidate_serving_the_model_means_no_key_even_from_the_default_endpoint(db, settings):
    _ep(db, "first", BASE, "sk-test-a", models=["m-listed"])
    _ep(db, "second", BASE, "sk-test-b", models=["m-listed"])
    settings["default_endpoint_id"] = "second"
    sess = _sess(BASE + "/chat/completions", model="m-elsewhere", headers={"X-Custom": "keep"})
    assert er.resolve_session_headers(sess) == {"X-Custom": "keep"}
