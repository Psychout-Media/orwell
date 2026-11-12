"""ORW-59 / R3 step 2: chatStreamMachine.applyDelta is the pure F8 channel split + <think> wrapping that used to be inline in chat.js. Tested in Node: (1) reasoning NEVER reaches the reply buffer, (2) the output is
byte-identical to the original inline algorithm over a seeded corpus of delta sequences (the equivalence check the A61 plan asks for), (3) it is pure (never mutates its input). No model."""
import json
import os
import shutil
import subprocess

import pytest

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js")


def _node(program):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    mod = os.path.join(STATIC, "chatStreamMachine.js").replace("\\", "/")
    p = subprocess.run([node, "--input-type=module", "-e", f"import {{ applyDelta, splitChannel }} from 'file://{mod}';\n{program}"], capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


# The ORIGINAL inline logic from chat.js, copied verbatim as the reference implementation.
LEGACY = """
function legacy(deltas) {
  let accumulated = '', roundText = '', roundReplyText = '', roundReasoningText = '', _thinkOpen = false, armed = true; const wasEmptyLog = [];
  for (const json of deltas) {
    let _delta = json.delta;
    if (json.thinking) roundReasoningText += json.delta;
    else               roundReplyText += json.delta;
    if (!json.thinking && armed) armed = false;
    if (json.thinking) { if (!_thinkOpen) { _delta = '<think>' + _delta; _thinkOpen = true; } }
    else if (_thinkOpen) { _delta = '</think>' + _delta; _thinkOpen = false; }
    wasEmptyLog.push(!accumulated);
    accumulated += _delta; roundText += _delta;
  }
  return { accumulated, roundText, roundReplyText, roundReasoningText, thinkOpen: _thinkOpen, armed, wasEmptyLog };
}
function machine(deltas) {
  let st = { accumulated: '', roundText: '', roundReplyText: '', roundReasoningText: '', thinkOpen: false }, armed = true; const wasEmptyLog = [];
  for (const json of deltas) {
    const r = applyDelta(st, json);
    if (r.isReplyToken && armed) armed = false;
    wasEmptyLog.push(r.wasEmpty);
    st = { accumulated: r.accumulated, roundText: r.roundText, roundReplyText: r.roundReplyText, roundReasoningText: r.roundReasoningText, thinkOpen: r.thinkOpen };
  }
  return { accumulated: st.accumulated, roundText: st.roundText, roundReplyText: st.roundReplyText, roundReasoningText: st.roundReasoningText, thinkOpen: st.thinkOpen, armed, wasEmptyLog };
}
"""


def test_reasoning_never_reaches_the_reply_buffer():
    out = _node("""let st={accumulated:'',roundText:'',roundReplyText:'',roundReasoningText:'',thinkOpen:false};
for (const d of [{delta:'plan ',thinking:true},{delta:'more ',thinking:true},{delta:'Hello ',thinking:false},{delta:'there',thinking:undefined}]) { const r=applyDelta(st,d); st=r; }
process.stdout.write(JSON.stringify(st));""")
    assert out["roundReplyText"] == "Hello there" and out["roundReasoningText"] == "plan more "
    assert "plan" not in out["roundReplyText"]
    assert out["accumulated"] == "<think>plan more </think>Hello there" and out["thinkOpen"] is False


def test_identical_to_the_original_inline_algorithm_over_a_seeded_corpus():
    out = _node(LEGACY + """
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const words = ['a','bb','<tag>','</think>','\\n\\n','**x**',' ','é','((Production:','))'];
let bad = 0;
for (let n = 0; n < 400; n++) {
  const deltas = []; const len = 1 + Math.floor(rnd() * 14);
  for (let i = 0; i < len; i++) deltas.push({ delta: words[Math.floor(rnd() * words.length)], thinking: rnd() < 0.4 ? true : (rnd() < 0.5 ? false : undefined) });
  if (JSON.stringify(legacy(deltas)) !== JSON.stringify(machine(deltas))) bad++;
}
process.stdout.write(JSON.stringify({ bad }));""")
    assert out["bad"] == 0


def test_applydelta_is_pure():
    out = _node("""const st = Object.freeze({accumulated:'x',roundText:'y',roundReplyText:'z',roundReasoningText:'w',thinkOpen:true});
const r = applyDelta(st, {delta:'q', thinking:false});
process.stdout.write(JSON.stringify({r, st}));""")
    assert out["st"] == {"accumulated": "x", "roundText": "y", "roundReplyText": "z", "roundReasoningText": "w", "thinkOpen": True}
    assert out["r"]["accumulated"] == "x</think>q" and out["r"]["thinkOpen"] is False


def test_split_channel_matches_applydelta_and_the_two_sibling_loops_use_it():
    """R3 step 4 slice: splitChannel is the same F8 split applyDelta does, and chat.js's resume + background loops call it instead of re-implementing it."""
    out = _node("""const ds=[{delta:'a',thinking:true},{delta:'B'},{delta:'c',thinking:false},{delta:'d',thinking:true},{delta:'E',thinking:undefined}];
let b={reply:'',reasoning:''}; const frozen=Object.freeze({reply:'x',reasoning:'y'}); splitChannel(frozen,{delta:'z'});
let st={accumulated:'',roundText:'',roundReplyText:'',roundReasoningText:'',thinkOpen:false};
for (const d of ds){ b=splitChannel(b,d); st=applyDelta(st,d); }
process.stdout.write(JSON.stringify({b, a:{reply:st.roundReplyText,reasoning:st.roundReasoningText}}));""")
    assert out["b"] == out["a"] == {"reply": "BcE", "reasoning": "ad"}
    src = open(os.path.join(STATIC, "chat.js"), encoding="utf-8").read()
    assert src.count("splitChannel({ reply: replyText, reasoning: reasoningText }, json)") == 2
    assert "if (json.thinking) reasoningText += json.delta" not in src, "an inline copy of the F8 split came back"
