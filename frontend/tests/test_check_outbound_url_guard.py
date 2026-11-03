"""#1994 — the LIVE outbound URL guard `check_outbound_url` (called from the embedding, gallery, note and contacts routes).

Local-first contract: private/loopback/LAN targets are ALLOWED by default (a local embedding server is the intended setup);
what is ALWAYS refused is a non-http(s) scheme and the link-local / metadata range (+ multicast/reserved/unspecified);
`block_private=True` (exposed multi-tenant) additionally refuses private + loopback. Every case injects the resolver — no DNS.
Mutation-checked: each assertion group fails if the matching branch of the guard is removed (see the PR for the run).
"""
import pytest

from src.url_safety import check_outbound_url


def _res(*ips):
    return lambda host: list(ips)


# -- schemes ------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("url", [
    "file:///etc/passwd", "gopher://example.test/x", "ftp://example.test/x", "javascript:alert(1)",
    "data:text/plain,hi", "//example.test/x", "example.test/x",
])
def test_non_http_schemes_are_refused(url):
    ok, reason = check_outbound_url(url, resolver=_res("93.184.216.34"))
    assert ok is False and "scheme" in reason


@pytest.mark.parametrize("url", ["", "   ", None, 123, b"http://example.test"])
def test_empty_or_non_string_is_refused(url):
    assert check_outbound_url(url, resolver=_res("93.184.216.34"))[0] is False


def test_a_url_with_no_host_is_refused():
    ok, reason = check_outbound_url("http:///path", resolver=_res("93.184.216.34"))
    assert ok is False and "no host" in reason


# -- the metadata / link-local vector (ALWAYS blocked, even in the permissive default) -------------------------------
@pytest.mark.parametrize("ip", ["169.254.169.254", "169.254.0.1", "fe80::1", "::ffff:169.254.169.254"])
@pytest.mark.parametrize("block_private", [False, True])
def test_link_local_and_metadata_are_always_blocked(ip, block_private):
    ok, reason = check_outbound_url("http://meta.test/latest", block_private=block_private, resolver=_res(ip))
    assert ok is False and "link-local" in reason


@pytest.mark.parametrize("ip", ["224.0.0.1", "ff02::1", "0.0.0.0", "::", "240.0.0.1"])
def test_multicast_unspecified_and_reserved_are_blocked(ip):
    ok, reason = check_outbound_url("http://odd.test/", resolver=_res(ip))
    assert ok is False and "disallowed" in reason


def test_a_hostname_that_resolves_to_ANY_bad_address_is_refused():
    # DNS-rebinding style: one public A record + one metadata record must not pass on the first.
    ok, _ = check_outbound_url("http://mixed.test/", resolver=_res("93.184.216.34", "169.254.169.254"))
    assert ok is False


def test_an_ipv6_zone_id_does_not_smuggle_a_link_local_address_past_the_guard():
    assert check_outbound_url("http://zone.test/", resolver=_res("fe80::1%eth0"))[0] is False


# -- the local-first default vs the lockdown flag -------------------------------------------------------------------
@pytest.mark.parametrize("ip", ["127.0.0.1", "10.1.2.3", "192.168.1.50", "172.16.5.5"])
def test_private_and_loopback_are_ALLOWED_by_default_for_a_local_embedding_server(ip):
    assert check_outbound_url("http://local.test:8000/v1", resolver=_res(ip)) == (True, "ok")


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.1.2.3", "192.168.1.50", "172.16.5.5", "::ffff:10.0.0.1"])
def test_block_private_locks_down_private_and_loopback(ip):
    ok, reason = check_outbound_url("http://local.test/", block_private=True, resolver=_res(ip))
    assert ok is False and "private/loopback" in reason


@pytest.mark.parametrize("scheme", ["http", "https", "HTTPS"])
def test_a_public_http_or_https_url_is_allowed_in_both_modes(scheme):
    for bp in (False, True):
        assert check_outbound_url(f"{scheme}://example.test/path?q=1", block_private=bp, resolver=_res("93.184.216.34")) == (True, "ok")


# -- resolution failures fail CLOSED ---------------------------------------------------------------------------------
def test_an_unresolvable_host_is_refused():
    def boom(host):
        raise OSError("nxdomain")
    ok, reason = check_outbound_url("http://nope.test/", resolver=boom)
    assert ok is False and "resolve" in reason


def test_an_empty_resolution_is_refused():
    ok, reason = check_outbound_url("http://empty.test/", resolver=_res())
    assert ok is False and "resolve" in reason


def test_the_default_resolver_is_used_when_none_is_injected(monkeypatch):
    import src.url_safety as us
    monkeypatch.setattr(us, "_default_resolver", lambda host: ["169.254.169.254"])
    assert us.check_outbound_url("http://anything.test/")[0] is False


def test_ipv6_loopback_is_refused_today_as_reserved_even_in_the_permissive_default():
    """Pinned CURRENT behaviour, flagged on the PR: Python classes `::1` as reserved, so it is rejected before the
    private/loopback allowance applies (the module doc says loopback is allowed; 127.0.0.1 is). Conservative, so kept."""
    ok, reason = check_outbound_url("http://[::1]:8000/", resolver=_res("::1"))
    assert ok is False and "disallowed" in reason
