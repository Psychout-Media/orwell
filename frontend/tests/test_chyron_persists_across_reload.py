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
