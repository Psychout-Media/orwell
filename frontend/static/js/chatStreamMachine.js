// static/js/chatStreamMachine.js
//
// ORW-59 / R3 step 2 (REFACTOR-ROADMAP, A61 plan): the FIRST pure piece of the chat.js stream state machine. It owns the per-delta bookkeeping that used to sit inline in
// handleChatSubmit's SSE loop: the F8 reply/reasoning channel split and the stateful <think> wrapping. No DOM, no module state, no I/O: `applyDelta(state, json)` returns the
// next buffers; the shell (chat.js) assigns them back to its per-turn locals and keeps doing the DOM work.
//
// The reasoning-never-reaches-the-public-bubble rule (CLAUDE.md "the live stream splits by channel") is therefore a property of THIS function and is tested on it directly
// (tests/test_orw59_stream_machine.py): `roundReplyText` only ever receives deltas whose `thinking` is falsy.

/**
 * @param {{accumulated:string, roundText:string, roundReplyText:string, roundReasoningText:string, thinkOpen:boolean}} st
 * @param {{delta:string, thinking?:boolean}} json  a stream event carrying a text delta
 * @returns {{accumulated:string, roundText:string, roundReplyText:string, roundReasoningText:string, thinkOpen:boolean, wasEmpty:boolean, isReplyToken:boolean}}
 */
export function applyDelta(st, json) {
  let delta = json.delta;
  // F8: split the RAW delta by channel BEFORE the <think>-wrapping below, so the reply buffer carries zero reasoning/markup and the accordion buffer carries raw reasoning.
  let roundReplyText = st.roundReplyText;
  let roundReasoningText = st.roundReasoningText;
  if (json.thinking) roundReasoningText += json.delta;
  else roundReplyText += json.delta;
  // Stateful open/close (not a whole-message substring check) so each round of a multi-round agent response gets its own <think>…</think>.
  let thinkOpen = st.thinkOpen;
  if (json.thinking) {
    if (!thinkOpen) { delta = '<think>' + delta; thinkOpen = true; }
  } else if (thinkOpen) {
    delta = '</think>' + delta; thinkOpen = false;
  }
  return {
    accumulated: st.accumulated + delta,
    roundText: st.roundText + delta,
    roundReplyText,
    roundReasoningText,
    thinkOpen,
    wasEmpty: !st.accumulated,
    isReplyToken: !json.thinking,
  };
}
