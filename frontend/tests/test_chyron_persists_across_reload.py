"""Chyron persistence (deferred from A's #2014): broadcast chyron / announcement cards were DOM-only, so a
reload dropped every card — including ones that reached the client through the pre-resolve / stateDelta
`owed` path, which never rode a persisted tool result. The history render path (the real
`chatModule.addMessage`, the same builder a reload uses) must repaint the SAME announcements, in the SAME
place (after the turn's bubble), once each, with no raw ids or machinery.

Drives the REAL app + addMessage (the #822/#873 lesson: a stub-blind reload path needs a real-render gate).
"""
import os
import socket
import subprocess
import sys
import time
import urllib.request

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _boot(env, port):
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env, stdout=open(f"/tmp/fe-chyron-{port}.log", "w"), stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    for _ in range(120):
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-chyron-{port}.log")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            return proc, base
        except Exception:
            time.sleep(1)
    proc.terminate()
    raise RuntimeError("server never became ready")


_HARNESS = r"""
async () => {
  const chat = window.chatModule;
  if (!chat || !chat.addMessage) return { error: 'chatModule.addMessage missing' };
  const box = document.getElementById('chat-history');
  if (!box) return { error: 'no #chat-history' };
  const ann = (id, kind, headline) => ({ id, kind, week: 1, beatSeq: 1, headline, subjects: [] });
  const out = {};
  // (a) the OWED path: announcements stashed on the message metadata (a pre-resolved beat — no tool result carried them)
  box.innerHTML = '';
  window.OrwellChyron && window.OrwellChyron._seen.clear();
  chat.addMessage('assistant', 'The house reacts.', 'm', {
    timestamp: '2026-06-27T15:30:00.000Z',
    announcements: [ann('ann:owed-1', 'hoh-winner', 'The Head of Household is crowned.')],
  });
  out.owedCards = Array.from(box.querySelectorAll('.ow-chyron')).map(e => e.textContent);
  out.owedAfterBubble = (() => {
    const kids = Array.from(box.children);
    const bi = kids.findIndex(k => k.classList.contains('msg-ai'));
    const ci = kids.findIndex(k => k.classList.contains('ow-chyron'));
    return bi >= 0 && ci > bi;
  })();
  // (b) the TOOL-RESULT path: an advanceGame tool event whose persisted output carries announcements
  box.innerHTML = '';
  window.OrwellChyron && window.OrwellChyron._seen.clear();
  chat.addMessage('assistant', '', 'm', {
    timestamp: '2026-06-27T15:30:00.000Z',
    round_texts: ['The round ends.'],
    tool_events: [{ round: 1, tool: 'advanceGame', command: 'advanceGame', exit_code: 0,
      output: JSON.stringify({ announcements: [ann('ann:tool-1', 'comp-round-result', 'Round one of the competition is decided.')] }) }],
  });
  out.toolCards = Array.from(box.querySelectorAll('.ow-chyron')).map(e => e.textContent);
  // (c) an idempotent re-render of the SAME message never doubles a card
  chat.addMessage('assistant', 'The house reacts.', 'm', {
    announcements: [ann('ann:owed-1', 'hoh-winner', 'The Head of Household is crowned.')],
  });
  chat.addMessage('assistant', 'The house reacts.', 'm', {
    announcements: [ann('ann:owed-1', 'hoh-winner', 'The Head of Household is crowned.')],
  });
  out.dupCount = box.querySelectorAll('[data-chyron-id="ann:owed-1"]').length;
  return out;
}
"""


def test_stored_announcements_repaint_on_history_render():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except Exception:
        pytest.skip("playwright not installed")
    env = dict(os.environ)
    env.setdefault("AUTH_ENABLED", "false")
    env.setdefault("ORWELL_GAME_BUILD", "1")
    port = _free_port()
    proc = None
    try:
        proc, base = _boot(env, port)
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as e:
                pytest.skip(f"chromium unavailable: {e}")
            page = browser.new_page()
            page.goto(base + "/", wait_until="load", timeout=30000)
            page.wait_for_timeout(3500)
            result = page.evaluate(_HARNESS)
            browser.close()
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
    assert not result.get("error"), result.get("error")
    assert len(result["owedCards"]) == 1 and result["owedCards"][0].endswith("Head of HouseholdThe Head of Household is crowned."), result["owedCards"]
    assert result["owedAfterBubble"], "the repainted card sits AFTER the turn's bubble, as it does live"
    assert len(result["toolCards"]) == 1 and result["toolCards"][0].endswith("CompetitionRound one of the competition is decided."), result["toolCards"]
    assert result["dupCount"] == 1, "re-rendering the same stored announcements never doubles a card"
    for t in result["owedCards"] + result["toolCards"]:
        assert "npc:" not in t and "ann:" not in t


def test_owed_announcements_are_stored_with_the_turn_source_pin():
    src = open(os.path.join(FRONTEND, "src", "agent_loop.py"), encoding="utf-8").read()
    assert "_turn_owed_announcements = [a for a in _owed if isinstance(a, dict)]" in src
    assert 'metrics["announcements"] = _turn_owed_announcements' in src


# ── the storage half, through the REAL save + history-serialisation path (no fabricated DOM metadata) ──
import pytest  # noqa: E402


@pytest.fixture
def _sm():
    from core.session_manager import SessionManager
    from core.models import set_session_manager
    import core.models as core_models
    manager = SessionManager()
    prior = getattr(core_models, "_session_manager", None)
    set_session_manager(manager)
    yield manager
    set_session_manager(prior)


def test_saved_turn_returns_its_announcements_from_the_history_serialisation(_sm):
    from routes.chat_helpers import save_assistant_response
    sid = "chyron-store-1"
    _sm.create_session(sid, "n", "http://x", "m", owner="u")
    sess = _sm.get_session(sid)
    ann = {"id": "ann:s-1", "kind": "hoh-winner", "week": 1, "beatSeq": 3, "headline": "The Head of Household is crowned.", "subjects": []}
    save_assistant_response(sess, _sm, sid, "The house reacts.", {"announcements": [ann], "model": "m"})
    served = sess.history[-1].to_dict()  # exactly what GET /history/{sid} returns per message
    assert served["metadata"]["announcements"] == [ann]


def test_owed_announcements_are_captured_for_the_stopped_save_too():
    src = open(os.path.join(FRONTEND, "routes", "chat_routes.py"), encoding="utf-8").read()
    assert "_owed_anns.extend(" in src, "the route captures owed announcements off the stream"
    # ORW-230: the agent-mode disconnect handler saves through `save_stopped_partial`, which stamps the cards.
    assert "announcements=_owed_anns," in src, "a cut-short turn keeps the cards the player was shown"
    helpers = open(os.path.join(FRONTEND, "routes", "chat_helpers.py"), encoding="utf-8").read()
    assert 'md["announcements"] = announcements' in helpers[helpers.index("def save_stopped_partial("):][:2500]
    assert '"announcements": _owed_anns' in src, "the normal save merges them into the stored metadata"


def test_the_owed_announcements_frame_is_captured_here_and_forwarded_by_exactly_one_branch():
    """The route CAPTURES a bare {"announcements": [...]} frame for storage (before the branch chain) and the chain forwards it through exactly ONE
    announcements branch (#2032's) — a second yield would be masked by the client dedup but is still wrong."""
    src = open(os.path.join(FRONTEND, "routes", "chat_routes.py"), encoding="utf-8").read()
    assert src.count('"announcements" in data and "delta" not in data') == 1, "exactly one announcements-forwarding branch in the chain"
    assert "yield chunk  # the owed-chyron frame" not in src, "no second yield from the storage capture"
    assert src.index("_owed_anns.extend(") < src.index('"announcements" in data and "delta" not in data'), "captured before the chain"
