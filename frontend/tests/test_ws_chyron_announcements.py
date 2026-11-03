"""A-15 rehearsal 2026-11-03 — the production chyron must render on the WebSocket leg (the default transport).

The owed `{"announcements":[...]}` event (agent_loop, for a beat the FE pre-resolved) and the advanceGame /
submitDecision tool result both carry the engine's Vault-free BeatAnnouncement(s). chat.js dispatches
`orwell:announcements` from them on the SSE leg; `_onWsChatFrame` (chatWsSplice.js) had NO such branch, so with
ORWELL_WS_TRANSPORT default-ON (#1357) no chyron ever rendered (0 events over ~40 live turns) while the T0-3
hard-drop rail had already removed the model's restatement. Source-pinned (the consumer imports browser modules, so
it cannot be executed under node). Roles only.
"""
import os
import re

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _src(name):
    with open(os.path.join(FRONTEND, "static", "js", name), encoding="utf-8") as f:
        return f.read()


def _consumer_body():
    s = _src("chatWsSplice.js")
    i = s.index("export function _onWsChatFrame(frame)")
    return s[i:]


def test_ws_consumer_dispatches_the_owed_announcements_frame():
    body = _consumer_body()
    head = body[: body.index("if (d.type === 'user_message')")]
    assert "Array.isArray(d.announcements)" in head, "the owed announcements frame must be handled FIRST"
    assert "_dispatchAnnouncements(d.announcements)" in head


def test_ws_consumer_dispatches_tool_result_announcements_for_the_two_mutating_tools():
    body = _consumer_body()
    m = re.search(r"d\.type === 'tool_output' && \(d\.tool === 'advanceGame' \|\| d\.tool === 'submitDecision'\)", body)
    assert m, "advanceGame/submitDecision tool_output must feed the chyron (chat.js:3192 parity)"
    assert "JSON.parse(d.output" in body[m.start(): m.start() + 300]
    assert "_adv.announcements" in body[m.start(): m.start() + 300]


def test_the_dispatch_uses_the_same_event_the_chyron_listens_for_and_is_the_only_new_dispatcher():
    s = _src("chatWsSplice.js")
    assert s.count("new CustomEvent('orwell:announcements'") == 1, "exactly one dispatch site in the WS splice"
    deco = _src("orwellDecision.js")
    assert 'addEventListener("orwell:announcements"' in deco
    assert "_chyronSeen" in deco, "the chyron dedups by id, so a frame seen on SSE + WS cannot double-render"


def test_chat_routes_forwards_the_owed_announcements_event():
    """The REAL drop (A-15 live probe): `chat_routes`'s agent-loop chunk chain had no branch for
    `{"announcements":[…]}` (no `delta`, no `type`), so the owed chyron the agent loop emits was swallowed there —
    before BOTH the SSE and WS legs. It must be forwarded."""
    with open(os.path.join(FRONTEND, "routes", "chat_routes.py"), encoding="utf-8") as f:
        src = f.read()
    start = src.index("async for chunk in stream_agent_loop(")
    chain = src[start: start + 12000]
    m = re.search(r'elif "announcements" in data and "delta" not in data:\s*(?:#[^\n]*\n\s*)*yield chunk', chain)
    assert m, "the agent-loop chunk chain must forward {'announcements': [...]} events"
    assert m.start() < chain.index('data.get("type") == "fallback"'), "forward it before the type-keyed branches"
