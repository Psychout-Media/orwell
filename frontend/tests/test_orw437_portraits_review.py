"""ORW-437: review fixes in orwell_portraits (malformed counters, legacy stamp, per-host billing alerts, GPT reason)."""
import asyncio
import importlib

P = importlib.import_module("src.orwell_portraits")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_prompt_version_rejects_fractional_bool_and_malformed_numbers():
    v = P._entry_prompt_version
    assert v({"promptVersion": 2.9}) == 1 and v({"promptVersion": True}) == 1 and v({"promptVersion": "x"}) == 1
    assert v({"promptVersion": -3}) == 1 and v({"promptVersion": None}) == 1
    assert v({"promptVersion": 2}) == 2 and v({"promptVersion": 2.0}) == 2 and v({"promptVersion": "2"}) == 2
    assert v({}) == 1 and v("not a dict") == 1


def test_check_retry_ids_survives_a_malformed_counter():
    man = {"a": {"check": {"ok": False}, "checkRetries": "two"}, "b": {"check": {"ok": False}, "checkRetries": 2.5},
           "c": {"check": {"ok": False}, "checkRetries": 2}, "d": {"check": {"ok": False}}}
    # review of #2748 (changes the wave-1 expectation on purpose): a corrupt counter is a spent budget, not a fresh one,
    # because every retry is a paid image; only a MISSING counter ("d") means no attempt yet
    assert P.check_retry_ids(man) == ["d"]


def test_a_failed_legacy_stamp_never_raises(monkeypatch):
    monkeypatch.setattr(P, "load_manifest", lambda user: {"npc_1": {"fingerprint": "x"}})

    def boom(user, manifest):
        raise OSError("disk full")
    monkeypatch.setattr(P, "_save_manifest", boom)
    P._stamp_version_one("u", "npc_1")  # must not raise


def test_two_hosts_tripping_together_record_one_soft_failure_each(monkeypatch):
    from src import log_rings
    seen = []
    monkeypatch.setattr(log_rings, "record_soft_failure", lambda *a, **k: seen.append(a[1]))
    P.reset_billing_breaker()
    try:
        P._trip_billing_breaker("one.example")
        P._trip_billing_breaker("two.example")
        P._record_billing_soft_failure("u")
        P._record_billing_soft_failure("u")  # already recorded: silent
    finally:
        P.reset_billing_breaker()
    assert len(seen) == 2 and any("one.example" in m for m in seen) and any("two.example" in m for m in seen)


def test_a_gpt_image_429_is_transient_for_the_retry_budget(monkeypatch, tmp_path):
    monkeypatch.setattr(P, "PORTRAITS_DIR", tmp_path / "portraits")
    monkeypatch.setattr(P, "PORTRAIT_LOG_PATH", tmp_path / "log.jsonl")
    monkeypatch.setattr(P, "image_generation_available", lambda user: True)
    monkeypatch.setattr(P, "image_gen_disabled", lambda: False)

    async def fake(prompt, user, reference_png=None, keep_identity=True):
        P._note_gen_error("gpt-image-failed", "http-429: slow down")
        return None
    monkeypatch.setattr(P, "_generate_one", fake)
    _run(P.generate_and_store([{"houseguestId": "npc:1", "name": "Zorvan", "prompt": "a prompt"}], "u", record_beats=False))
    assert P._is_transient_gen_error(P.last_gen_error_class("u", "npc:1"))
