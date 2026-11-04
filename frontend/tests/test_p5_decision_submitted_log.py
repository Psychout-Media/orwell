"""P5 (post-session analyzer): every submitted decision card logs one `decision submitted kind=<kind>` line (shared HTTP + WS tail), with no payload text."""
import asyncio
import importlib
import logging

routes = importlib.import_module("routes.orwell_routes")


def test_post_decision_tail_logs_the_kind_and_never_the_payload(caplog):
    with caplog.at_level(logging.INFO, logger=routes.logger.name):
        asyncio.new_event_loop().run_until_complete(
            routes._post_decision_tail({"kind": "veto-decision", "text": "SECRET-WORDS"}, {"pending": None}, "u", "veto-decision"))
    lines = [r.getMessage() for r in caplog.records if "decision submitted" in r.getMessage()]
    assert lines == ["[orwell] decision submitted kind=veto-decision user=u"], lines
    assert not any("SECRET-WORDS" in r.getMessage() for r in caplog.records)
