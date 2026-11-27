"""ORW-1024: every json_object request carries the word json in its prompt (DeepSeek answers 400 otherwise),
and a provider 400 names the call class that sent it. Roles only, no names."""
import asyncio
import logging
import re
from pathlib import Path

import pytest

from src import llm_core as lc

pytestmark = pytest.mark.usefixtures("non_game_text_routing")

OR_URL = "https://openrouter.ai/api/v1/chat/completions"
_JSON_FMT = {"type": "json_object"}


class _Resp:
    def __init__(self, status=200, body=b""):
        self.status_code = status
        self._body = body

    async def aiter_lines(self):
        for ln in ['data: {"choices":[{"delta":{"content":"hi"}}]}', "data: [DONE]"]:
            yield ln

    async def aread(self):
        return self._body


class _CM:
    def __init__(self, cap, payload, resp):
        cap["payload"] = payload
        self._resp = resp

    async def __aenter__(self):
        return self._resp

    async def __aexit__(self, *a):
        return False


class _Client:
    def __init__(self, cap, resp):
        self._cap, self._resp = cap, resp

    def stream(self, method, url, json=None, headers=None, timeout=None):
        return _CM(self._cap, json, self._resp)


def _drive(monkeypatch, messages, resp=None, **kw):
    cap: dict = {}
    monkeypatch.setattr(lc, "_get_http_client", lambda: _Client(cap, resp or _Resp()))
    monkeypatch.setattr(lc, "_is_host_dead", lambda u: False)
    monkeypatch.setattr(lc, "note_model_activity", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_clear_host_dead", lambda *a, **k: None)

    async def go():
        async for _ in lc.stream_llm(OR_URL, "m", messages, **kw):
            pass

    asyncio.get_event_loop().run_until_complete(go())
    return cap.get("payload") or {}


@pytest.mark.parametrize("messages", [
    [{"role": "user", "content": "Condense this day in plain prose."}],
    [{"role": "system", "content": "Narrate."}, {"role": "user", "content": [{"type": "text", "text": "Narrate."}]}],
    [{"role": "system", "content": "Narrate."}],
    [],
])
def test_json_object_request_always_carries_the_word_json(monkeypatch, messages):
    payload = _drive(monkeypatch, messages, response_format=_JSON_FMT)
    assert payload["response_format"] == _JSON_FMT
    assert lc.messages_mention_json(payload["messages"]), payload["messages"]


def test_prompt_already_naming_json_is_untouched(monkeypatch):
    msgs = [{"role": "user", "content": "Return STRICT Json only"}]
    assert lc.ensure_json_word(msgs) is msgs
    payload = _drive(monkeypatch, msgs, response_format=_JSON_FMT)
    assert payload["messages"][-1]["content"] == "Return STRICT Json only"


def test_no_response_format_leaves_messages_alone(monkeypatch):
    payload = _drive(monkeypatch, [{"role": "user", "content": "plain prose"}])
    assert "response_format" not in payload
    assert not lc.messages_mention_json(payload["messages"])


def test_ensure_json_word_does_not_mutate_the_input():
    msgs = [{"role": "user", "content": "hello"}]
    out = lc.ensure_json_word(msgs)
    assert msgs == [{"role": "user", "content": "hello"}]
    assert out is not msgs and lc.messages_mention_json(out)


def test_provider_400_log_names_the_caller_class(monkeypatch, caplog):
    tok = lc.LLM_CALLER.set("some_module.some_caller")
    try:
        with caplog.at_level(logging.WARNING):
            _drive(monkeypatch, [{"role": "user", "content": "x"}],
                   resp=_Resp(400, b'{"error":{"message":"bad"}}'), response_format=_JSON_FMT)
    finally:
        lc.LLM_CALLER.reset(tok)
    lines = [r.getMessage() for r in caplog.records if "provider stream failed: status=400" in r.getMessage()]
    assert lines and "caller=some_module.some_caller" in lines[0], lines


def test_every_json_object_sender_goes_through_the_shared_helper():
    """A new file that builds a json_object request must be added here on purpose: each listed file sends through
    stream_llm (which applies ensure_json_word) or calls ensure_json_word itself."""
    src = Path(lc.__file__).parent
    senders = {p.name for p in src.glob("*.py")
               if re.search(r'["\']type["\']\s*:\s*["\']json_object["\']', p.read_text(encoding="utf-8"))}
    through_stream_llm = {"llm_core.py", "orwell_cast_authoring.py", "orwell_producer_authoring.py"}
    own_helper_call = {"capability_probe.py"}
    assert senders <= through_stream_llm | own_helper_call, senders - (through_stream_llm | own_helper_call)
    for name in own_helper_call:
        assert "ensure_json_word" in (src / name).read_text(encoding="utf-8"), name
