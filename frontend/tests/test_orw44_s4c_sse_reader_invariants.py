"""ORW-44 S4c: the game build is WebSocket-only, so the SSE fetch-reader in chat.js is reachable only in the non-game build. Three real-browser stacks used
to drive it in the game build with ORWELL_WS_TRANSPORT=0 and are RETIRED (Coordinator ruling B, 2026-11-12). Their invariants are pinned here as node unit
tests that run the REAL functions out of chat.js with the DOM stubbed:

  retired test_f3_drop_after_saved_no_recovery        -> test_f3_*   (no recovery after a server-confirmed completion)
  retired test_first_message_double_render            -> test_double_render_*  (our own run-started echo is never peer-resumed)
  retired test_orw96_no_done_dom                      -> test_no_done_*  (a stream that ends without [DONE]: one retry notice, never a GM bubble / raw error)
"""
import json
import os
import shutil
import subprocess

import pytest

JS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js", "chat.js")
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node not available")

PROGRAM = r"""
const fs = require('fs');
const src = fs.readFileSync(process.argv[1], 'utf8');
function fn(name) {  // the named function's full source, found by brace matching from its declaration
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let depth = 0, started = false;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unterminated ' + name);
}
const scenario = JSON.parse(process.argv[2]);
const out = {};
if (scenario === 'f3') {
  const sc = new Function(fn('_isServerConfirmedDone') + '; return _isServerConfirmedDone;')();
  const rec = new Function(fn('_isRecoverableStreamErr') + '; return _isRecoverableStreamErr;')();
  out.done = sc(true, false, null); out.saved = sc(false, true, null);
  out.dbId = sc(false, false, { dataset: { dbId: '42' } });
  out.none = sc(false, false, { dataset: {} }); out.nullHolder = sc(false, false, null);
  out.closedIsConnectionClass = rec(new Error('Stream closed before completion'));
  out.toolIsNot = rec(new Error('tool calls unsupported')); out.http4xxIsNot = rec(new Error('HTTP 400 bad request'));
}
if (scenario === 'double') {
  const chatState = { _streamSessionId: 's1', _ownRunIds: {} };
  const note = new Function('chatState', fn('noteRunStarted') + '; return noteRunStarted;')(chatState);
  out.ownEcho = note('s1', 'runA');            // our POST's run-started echo
  out.replay = note('s1', 'runA');             // the replay ring re-delivers it
  out.peerWhileStreaming = note('s1', 'runB'); // a genuinely different run on the same session
  out.otherSession = note('s2', 'runC');       // not the session our POST is streaming
  out.noIds = note('', '') || note('s1', '');
}
if (scenario === 'nodone') {
  const calls = { retry: 0, submit: 0, timers: 0 };
  const mk = (accumulated, nudges, cap, hasOwnRun) => {
    calls.retry = 0; calls.timers = 0;
    const chatState = { _autoNudges: nudges, _ownRunIds: hasOwnRun ? { s1: 'r' } : {} };
    const f = new Function('chatState', '_AUTO_NUDGE_CAP', '_renderStreamDropRetry', '_trySelfResume', 'markdownModule', 'sessionModule', 'handleChatSubmit', 'setTimeout',
      fn('_tryAutoRecover') + '; return _tryAutoRecover;')(chatState, cap, () => { calls.retry++; }, () => {},
      { scrubMachineryForPersistence: x => x, processWithThinking: x => x, squashOutsideCode: x => x }, { getCurrentSessionId: () => 's1' }, () => {}, () => { calls.timers++; });
    return f(null, accumulated, 's1');
  };
  out.emptyReturns = mk('', 0, 2, false); out.emptyRetryNotices = calls.retry; out.emptyTimers = calls.timers;
  out.partialCapSpent = mk('some text', 2, 2, false); out.partialCapSpentTimers = calls.timers;
  out.partialAutoContinues = mk('some text', 0, 2, false); out.partialAutoTimers = calls.timers;
  // the retry notice reclassifies an EMPTY narrator holder as a system notice (never the GM's voice)
  const holder = { className: 'msg msg-ai', dataset: {}, innerHTML: 'x',
    classList: { contains: c => c === 'msg-ai' }, querySelector: () => ({ textContent: '' }) };
  const doc = { createElement() { throw new Error('stop-after-reclassify'); } };
  try { new Function('document', fn('_renderStreamDropRetry') + '; _renderStreamDropRetry(arguments[1], "s1");')(doc, holder); } catch (e) { out.stopped = String(e.message); }
  out.holderClass = holder.className;
}
process.stdout.write(JSON.stringify(out));
"""


def _run(name):
    res = subprocess.run([NODE, "-e", PROGRAM, "--", JS, json.dumps(name)], capture_output=True, text=True, timeout=60)
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_f3_a_server_confirmed_completion_is_never_recovered():
    o = _run("f3")
    assert o["done"] and o["saved"] and o["dbId"], o            # [DONE] / message_saved / a db id on the holder each mean "complete"
    assert not o["none"] and not o["nullHolder"], o
    assert o["closedIsConnectionClass"] is True, o               # the reader's own "closed before completion" throw IS recoverable...
    assert o["toolIsNot"] is False and o["http4xxIsNot"] is False, o  # ...but deterministic errors surface at once


def test_f3_the_catch_gates_recovery_on_the_completion_helper():
    src = open(JS, encoding="utf-8").read()
    assert "const _serverConfirmedDone = _isServerConfirmedDone(_streamSawDone, _sawMessageSaved, holder);" in src
    assert "if (!_requeuedOffline && !_serverConfirmedDone &&" in src      # recovery AND the generic error surface both skip a completed turn


def test_double_render_our_own_run_started_echo_is_never_peer_resumed():
    o = _run("double")
    assert o["ownEcho"] is True and o["replay"] is True, o       # classified OURS, so sessionSync never resumes it (no second bubble)
    assert o["peerWhileStreaming"] is False, o                    # a real concurrent peer run still mirrors
    assert o["otherSession"] is False and o["noIds"] is False, o


def test_no_done_a_dead_stream_gets_one_retry_notice_or_a_capped_continue_never_a_gm_bubble():
    o = _run("nodone")
    assert o["emptyReturns"] is True and o["emptyRetryNotices"] == 1 and o["emptyTimers"] == 0, o  # nothing produced: ONE user-controlled Retry, no auto-resend
    assert o["partialCapSpent"] is False and o["partialCapSpentTimers"] == 0, o                  # cap spent: falls through to the honest retry notice in the caller
    assert o["partialAutoContinues"] is True and o["partialAutoTimers"] == 1, o                  # partial text: exactly one headless continue
    assert o["holderClass"] == "msg msg-system", o                                               # the empty narrator holder becomes a system notice, not the GM's voice
