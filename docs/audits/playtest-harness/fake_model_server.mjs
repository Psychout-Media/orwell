// fake_model_server.mjs — a tiny OpenAI-compatible STREAMING echo server, for STUB-MODE validation
// of the mirror harness WITHOUT a live key. It exercises the real FE /api/chat_stream → stream_llm
// path (so the SSE token timeline + filmstrip capture rails get real deltas to record), but its
// output is DETERMINISTIC echo text — never real narration. This is a validation aid only; the
// real mirror audit runs against the live model (ORWELL_TEST_OPENROUTER_KEY).
//
// Endpoints:
//   GET  /v1/models                 → one model id (so the FE endpoint probe succeeds)
//   POST /v1/chat/completions        → streams a fixed reply as OpenAI SSE chunks (delta.content),
//                                       a reasoning preamble (delta.reasoning), a usage chunk, and a
//                                       terminal finish_reason — covering every trace/stream channel.
//
//   node docs/audits/playtest-harness/fake_model_server.mjs            # listens on :8011
//   FAKE_MODEL_PORT=8011 FAKE_FINISH=length node ...fake_model_server.mjs   # force a truncation finish
//
// FAKE_SCRIPT=toolturn — a scripted MULTI-ROUND tool-call turn (mirror-gate H1/H2 extension). Real
// game turns are almost always tool-rich (advanceGame/recordInteraction/whereabouts…), but the plain
// echo mode above NEVER emits a tool_calls delta, so the agent-loop multi-round path and the
// observer's resumeStream `rich=true` path (chat.js ~4607) were untested by the mirror gate. In this
// mode: ROUND 1 streams a short reasoning + narration preamble, then an OpenAI-shape streamed
// `delta.tool_calls` (function `whereabouts`, a real Vault-free read-only ORWELL_GAME_TOOLS member —
// no args, safe against the live engine) and a terminal `finish_reason: "tool_calls"`. The FE agent
// loop executes the tool and re-POSTs with the tool result appended (role:"tool") — detected here by
// scanning `messages` for a trailing tool-result message — and ROUND 2 streams the final reply text
// with `finish_reason: "stop"`, exactly like the plain echo path. Both rounds' text are DETERMINISTIC
// and DERIVED from the prompt so two mirrored windows see identical bytes.
import { createServer } from 'http';

const PORT = parseInt(process.env.FAKE_MODEL_PORT || '8011', 10);
const MODEL = process.env.FAKE_MODEL_ID || 'fake/echo-stream';
const FINISH = process.env.FAKE_FINISH || 'stop'; // 'stop' | 'length' | 'tool_calls'
const SCRIPT = process.env.FAKE_SCRIPT || 'echo'; // 'echo' | 'toolturn'
// FAKE_TOKEN_DELAY_MS — space out the streamed REPLY chunks by this many ms EACH (reasoning streams
// promptly), so the stream has a DETERMINISTIC wall-clock WIDTH instead of firing in one synchronous burst.
// Default 0 (byte-identical to the original instant echo — every other harness is unaffected). The
// mirror LIVE-parity gate sets it (run_mirror_gate.sh) so A's streaming window is wide enough that a
// second window reliably attaches DURING the stream and mirrors it live even on a heavily-contended
// host — the F5 invariant is about LIVE mirroring, and a zero-width stream is impossible to mirror
// live on a slow box (the CI-flake root cause). It only changes PACING, never the bytes: two windows
// on the same run still receive identical deltas, so the mirror byte-identity invariant is intact.
const TOKEN_DELAY_MS = parseInt(process.env.FAKE_TOKEN_DELAY_MS || '0', 10);
// FAKE_REPLY_REPEAT — repeat the fixed reply tail N times (default 1 = byte-identical to before) so a
// perf run can stream a long, realistic-length reply. Pacing/length only; still deterministic.
const REPLY_REPEAT = Math.max(1, parseInt(process.env.FAKE_REPLY_REPEAT || '1', 10));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    return send(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'fake' }] });
  }
  if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let stream = false; let lastUser = ''; let msgs = []; let forcedTool = '';
      try {
        const j = JSON.parse(body); stream = !!j.stream; msgs = j.messages || [];
        for (const m of msgs) if (m.role === 'user') lastUser = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        // A FORCED tool_choice ({type:"function", function:{name}}) — the agent loop's forced-lever rung.
        if (j.tool_choice && typeof j.tool_choice === 'object' && j.tool_choice.function) forcedTool = String(j.tool_choice.function.name || '');
      } catch (_) {}
      // A deterministic reply DERIVED from the prompt so both windows on the same game get identical
      // text (the mirror invariant) but different turns get different text.
      const seed = (lastUser || '').replace(/\s+/g, ' ').trim().slice(0, 60);

      if (SCRIPT === 'toolturn') {
        // ROUND 2: the agent loop re-POSTs with the executed tool's result appended (role:"tool").
        // Detect it and stream the FINAL reply — same shape as plain echo mode (finish "stop").
        const isRound2 = msgs.length && msgs[msgs.length - 1] && msgs[msgs.length - 1].role === 'tool';
        if (isRound2) {
          const reasoning2 = `Weighing what whereabouts just returned. (echo of: ${seed})`;
          const reply2 = `The house settles for a moment. [stub-echo round2] ${seed}`;
          if (!stream) {
            return send(res, 200, { id: 'fake', object: 'chat.completion', model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: reply2 }, finish_reason: 'stop' }], usage: { prompt_tokens: 48, completion_tokens: 18, total_tokens: 66 } });
          }
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          const chunk2 = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ id: 'fake-r2', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`);
          for (const w of reasoning2.split(' ')) chunk2({ reasoning: w + ' ' });
          for (const w of reply2.split(' ')) chunk2({ content: w + ' ' });
          res.write(`data: ${JSON.stringify({ id: 'fake-r2', object: 'chat.completion.chunk', model: MODEL, choices: [], usage: { prompt_tokens: 48, completion_tokens: 18, total_tokens: 66 } })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: 'fake-r2', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        // ROUND 1: narrate briefly, then call the benign read-only `whereabouts` tool (no args) via a
        // standard OpenAI streamed tool_calls delta, terminated with finish_reason "tool_calls".
        const reasoning1 = `Considering the room and who is present. (echo of: ${seed})`;
        const preamble1 = `I glance around to get my bearings. [stub-echo round1] ${seed}`;
        if (!stream) {
          return send(res, 200, {
            id: 'fake-r1', object: 'chat.completion', model: MODEL,
            choices: [{ index: 0, message: { role: 'assistant', content: preamble1, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'whereabouts', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 40, completion_tokens: 16, total_tokens: 56 },
          });
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const chunk1 = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ id: 'fake-r1', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`);
        for (const w of reasoning1.split(' ')) chunk1({ reasoning: w + ' ' });
        for (const w of preamble1.split(' ')) chunk1({ content: w + ' ' });
        // streamed tool_calls delta: name in the first chunk, arguments in the second (matches how
        // real providers split it — llm_core.py accumulates by index).
        chunk1({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'whereabouts', arguments: '' } }] });
        chunk1({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] });
        res.write(`data: ${JSON.stringify({ id: 'fake-r1', object: 'chat.completion.chunk', model: MODEL, choices: [], usage: { prompt_tokens: 40, completion_tokens: 16, total_tokens: 56 } })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'fake-r1', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      // The 0055 _auto_record_scene EXTRACTION call (agent_loop: a non-stream request whose system
      // prompt asks for a `{"withIds":[...]}` JSON object over a "ROSTER (id = name)" list). A real
      // model answers with JSON; the plain echo below never did, so the belt logged "no parseable
      // JSON" and recorded nothing — the mirror-hud gate's measured turn then committed NO engine
      // mutation and the gate could not run (beat N → N). Answer it deterministically: propose EVERY
      // roster id as a social scene. The FE still intersects that proposal with the engine's real
      // whereabouts (#1730), so only houseguests actually in the room are recorded — the harness
      // exercises the real belt path end to end, never a shortcut around it.
      const sysText = msgs.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      if (!stream && sysText.includes('"withIds"') && /ROSTER \(id = name\):/.test(lastUser)) {
        const rosterBlock = (lastUser.split('ROSTER (id = name):')[1] || '').split('\n\n')[0];
        const ids = rosterBlock.split('\n').map((l) => l.split(' = ')[0].trim()).filter((x) => /^npc:\d+$/.test(x));
        const answer = JSON.stringify({ withIds: ids, kind: 'bonding', content: 'The player made the rounds and introduced themself to the room.' });
        return send(res, 200, { id: 'fake', object: 'chat.completion', model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 16, total_tokens: 56 } });
      }

      // Honor a FORCED tool_choice the way a real model does: call exactly that tool (no args) instead of
      // ignoring the directive. The plain echo used to ignore it, so a forced-advance turn dragged into extra
      // escalation rounds and settled AFTER the mirror-hud gate measured (a timing-dependent false red).
      // Only on a fresh round (not right after a tool result), so round 2 streams the normal echo reply.
      const afterTool = msgs.length && msgs[msgs.length - 1] && msgs[msgs.length - 1].role === 'tool';
      if (forcedTool && !afterTool && SCRIPT !== 'toolturn') {
        const call = { id: 'call_forced', type: 'function', function: { name: forcedTool, arguments: '{}' } };
        if (!stream) {
          return send(res, 200, { id: 'fake-f', object: 'chat.completion', model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [call] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 } });
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ id: 'fake-f', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: forcedTool, arguments: '{}' } }] }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'fake-f', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const reasoning = `Considering the room and who is present. (echo of: ${seed})`;
      // The reply carries a DETERMINISTIC fixed tail (seed-independent) so the streamed REPLY has
      // MANY deltas — ~29 words even when the seed is empty. Combined with FAKE_TOKEN_DELAY_MS
      // (run_mirror_gate.sh sets it) this gives A's reply a wall-clock WIDTH of ~10-13s, wide enough
      // that a second window's re-subscribe/attach for the measured turn reliably lands DURING the
      // stream and mirrors it live — even on a contended CI runner where the WS rebind churn delays
      // the attach (issue #1560: a short ~3-5s stream let turn-2 settle before B attached, false-red).
      // It changes PACING/length only, never determinism: both windows on the same run get identical
      // bytes (the mirror byte-identity invariant is intact — the tail is fixed, not random).
      const reply = `The house settles for a moment. [stub-echo] ${seed} Somewhere down the hall a door clicks shut and two low voices trade a quick word before the whole room drifts back to quiet again.`
        + (REPLY_REPEAT > 1 ? Array.from({ length: REPLY_REPEAT - 1 }, (_, i) => `\n\n**Beat ${i + 2}.** The kitchen hums, someone laughs at a joke only half the room heard, and a chair scrapes while the cameras drift slowly across the faces turned toward you.`).join('') : '');
      if (!stream) {
        return send(res, 200, { id: 'fake', object: 'chat.completion', model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 16, total_tokens: 56 } });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const chunk = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`);
      // reasoning preamble (channel: delta.reasoning) — streamed PROMPTLY (no delay) so the live
      // thinking accordion mounts right away and the REPLY phase (below) is what fills the widened
      // window. Delaying reasoning instead would push the reply-container mount past the measurement
      // window on a mirror that only mounts `.live-reply-content` when reply tokens arrive.
      for (const w of reasoning.split(' ')) chunk({ reasoning: w + ' ' });
      // reply body (channel: delta.content) — SPACED by TOKEN_DELAY_MS so A's reply streams over a
      // deterministic wall-clock window wide enough for a second window to attach mid-stream and
      // mirror it live (mount `.live-reply-content` + stream through the shared incremental renderer).
      for (const w of reply.split(' ')) { chunk({ content: w + ' ' }); if (TOKEN_DELAY_MS) await sleep(TOKEN_DELAY_MS); }
      // usage chunk
      res.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', model: MODEL, choices: [], usage: { prompt_tokens: 40, completion_tokens: 16, total_tokens: 56 } })}\n\n`);
      // terminal finish_reason (the trace/stream signal the harness audits for completeness)
      res.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: FINISH }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }
  send(res, 404, { error: 'not found' });
}).listen(PORT, '127.0.0.1', () => console.log(`fake model server on http://127.0.0.1:${PORT} (model ${MODEL}, finish=${FINISH}, script=${SCRIPT})`));
