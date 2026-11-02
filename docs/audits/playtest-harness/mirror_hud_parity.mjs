// mirror_hud_parity.mjs — the EXECUTABLE RED GATE for ship-gate F5's STATUS/GADGET half (feature
// 0064 §B/D instant cross-window HUD parity): a complement to mirror_live_parity.mjs (which gates
// the CHAT-RENDER half, R2 / ADR 0015).
//
// THE INVARIANT (F5, the status/gadget half):
//   Given two windows on one started game,
//   When a chat turn in window A MUTATES engine state,
//   Then the server publishes `game-updated` to the user's windows,
//   And window B's HUD reflects the new state within HUD_PARITY_BUDGET_MS (≤2000ms; target
//     sub-second) — driven by the SERVER PUSH, NOT B's 20–30s poll,
//   And no Vault data crosses (the push carries no state body; each window re-fetches its own
//     Vault-free projection).
//
// WHY THIS EXISTS (the gap on the base branch):
//   The 0064 server-push (`game-updated`) is fired from only THREE orwell_routes.py endpoints
//   (decision + the two self-eviction routes) — NEVER from the chat-turn path. So a chat turn whose
//   agent-loop tools mutate engine state (markHouseguestMet / advanceGame / recordInteraction / the
//   0055 _auto_record_scene belt) refreshes ONLY the SENDER's own HUD (chat.js → the g15 dispatcher,
//   client-side). Peer windows get NO push and stay stale until their own poll. Observed live:
//   window A "1 of 15 met", window B "0 of 15".
//
// HOW IT MEASURES (push, not poll — the load-bearing distinction):
//   The 0064 SSE `game-updated` is the ONLY thing that routes through sessionSync.js
//   `notifyGameUpdated()` → `window.orwellGameChanged('sync:game-updated')` → the debounced
//   `orwell:gamechanged` window event. The HUD panels' 20–30s poll is a SEPARATE setInterval that
//   re-fetches WITHOUT dispatching `orwell:gamechanged`. So a B-side `orwell:gamechanged` carrying
//   reason `sync:game-updated` is, by construction, the SERVER PUSH landing — never the poll. The
//   gate taps that event (wall-clocked) plus B's off-cycle `/api/orwell/{state,status}` re-fetches,
//   and times the first one from A's send. RED ⇒ B never receives the push (it would only converge on
//   its slow poll); GREEN ⇒ B's HUD reconciles within budget off the push.
//
// Key-free + deterministic (the fake streamed model). The turn mutates via the 0055 _auto_record_scene
// belt (a long player turn with no model write tool ⇒ ensure_turn_recorded → recordInteraction ⇒ a
// committed engine mutation ⇒ beatSeq bump). The gate CONFIRMS the mutation (engine beatSeq
// before/after) and only then asserts the parity budget — so a non-mutating turn can never produce a
// false GREEN.
//
// Run via run_mirror_gate.sh with MIRROR_HUD=1 (boots engine + fake model + FE + a STARTED game), or
// against an already-standing stack:  node docs/audits/playtest-harness/mirror_hud_parity.mjs
import { chromium, openMirrorWindow, sendTurn, waitSettled, engineSnapshot, pub, writeJson } from './mirrorlib.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const OUT = HERE + 'shots/mirror-hud/';
// A LONG player turn so the 0055 belt fires (ensure_turn_recorded needs >= 80 chars of narration; a
// substantive player line yields a long stub-echo reply → a committed recordInteraction).
const TURN = process.env.MIRROR_HUD_TURN ||
  "(I make a real point of going around the room and introducing myself to every single person here, one by one, learning their names and shaking hands.)";
const HUD_PARITY_BUDGET_MS = parseInt(process.env.HUD_PARITY_BUDGET_MS || '2000', 10);
const B_WAIT_MS = parseInt(process.env.MIRROR_HUD_B_WAIT_MS || '15000', 10);

// TRANSPORT MODE (the WS Phase-1 turn-on gate — protocol spec §6/§7 case f, ADR 0017 §Phasing):
// the SAME two-window parity invariant must hold whether the windows mirror over the WebSocket
// (`MIRROR_WS_TRANSPORT=1`) or the permanent SSE/poll fallback (`=0`/unset). The client reads the
// `ORWELL_WS_TRANSPORT` flag off a window global (orwellWs.js `_flagOn`); we set it in an init
// script that runs BEFORE any app JS, so we force WS mode WITHOUT touching app code or the server
// env (the server-side default stays OFF). Absent/`0` ⇒ the flag is never set ⇒ pure fallback,
// exactly the production default. This is the ONLY difference between the two gate invocations —
// the bytes, the checks, and the acceptance are identical (spec §6 "Both modes must pass F5").
const WS_TRANSPORT = process.env.MIRROR_WS_TRANSPORT === '1' || process.env.MIRROR_WS_TRANSPORT === 'true';
const MODE = WS_TRANSPORT ? 'ws' : 'fallback';
// Force the flag on before app scripts evaluate (null when fallback — nothing is set, so
// `_flagOn()` stays false and the client never even attempts the upgrade, §6 zero-risk default).
const WS_FLAG_INIT = WS_TRANSPORT
  ? `(() => { try {
      window.ORWELL_WS_TRANSPORT = true;
      if (document.documentElement) document.documentElement.dataset.wsForced = '1';
      // DIAG: wrap WebSocket to record every frame in/out on /api/ws/session (why a WS run fell back).
      window.__wsFrames = [];
      var _OWS = window.WebSocket;
      window.WebSocket = function (url, protocols) {
        var s = protocols ? new _OWS(url, protocols) : new _OWS(url);
        try {
          if (/\\/api\\/ws\\/session/.test(String(url))) {  // double-escaped: this is inside a template literal (a single \/ collapses to //, a COMMENT — the whole init script was a SyntaxError, so WS was never forced)
            var _send = s.send.bind(s);
            s.send = function (data) { try { window.__wsFrames.push({ dir: 'out', d: String(data).slice(0, 300), t: Date.now() }); } catch (_) {} return _send(data); };
            s.addEventListener('message', function (ev) { try { window.__wsFrames.push({ dir: 'in', d: String(ev.data).slice(0, 300), t: Date.now() }); } catch (_) {} });
            s.addEventListener('close', function (ev) { try { window.__wsFrames.push({ dir: 'close', code: ev.code, reason: String(ev.reason || '').slice(0, 120), t: Date.now() }); } catch (_) {} });
            s.addEventListener('error', function () { try { window.__wsFrames.push({ dir: 'error', t: Date.now() }); } catch (_) {} });
          }
        } catch (_) {}
        return s;
      };
      window.WebSocket.prototype = _OWS.prototype;
      window.WebSocket.CONNECTING = _OWS.CONNECTING; window.WebSocket.OPEN = _OWS.OPEN;
      window.WebSocket.CLOSING = _OWS.CLOSING; window.WebSocket.CLOSED = _OWS.CLOSED;
      // Record the WS lifecycle edges so a WS-mode FAILURE is diagnosable (why it fell back).
      window.__wsLife = [];
      ['orwell:ws-ready','orwell:ws-active','orwell:ws-inactive','orwell:ws-dead','orwell:ws-adopted']
        .forEach((n) => window.addEventListener(n, (e) => {
          try { window.__wsLife.push({ n: n.replace('orwell:',''), d: (e && e.detail) || {}, t: Date.now() }); } catch (_) {}
        }));
    } catch (_) {} })()`
  : null;
console.log(`\nMIRROR HUD-PARITY transport mode: ${MODE.toUpperCase()}`);

// A B-side tap: record every `orwell:gamechanged` (with its reason + wall) and every off-cycle HUD
// re-fetch of /api/orwell/{state,status}. Installed BEFORE app JS so we catch the first push.
const HUD_TAP = `(() => {
  if (window.__hud) return;
  const H = { changed: [], hudFetch: [] };
  window.__hud = H;
  window.addEventListener('orwell:gamechanged', (e) => {
    H.changed.push({ wall: Date.now(), reason: (e && e.detail && e.detail.reason) || '' });
  });
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    const url = (typeof input === 'string' ? input : (input && input.url)) || '';
    if (/\\/api\\/orwell\\/(state|status|moment)/.test(url)) H.hudFetch.push({ wall: Date.now(), url: url.replace(/^https?:\\/\\/[^/]+/, '') });
    return _fetch.apply(this, arguments);
  };
})()`;

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const A = await openMirrorWindow(browser, 'A', { extraInit: WS_FLAG_INIT });
// Window B installs the HUD tap on top of the mirror tap (openMirrorWindow already added the latter).
// Also inject the WS init script BEFORE it (WS_FLAG_INIT must run before any app JS triggers the WS
// upgrade; HUD_TAP runs after to intercept orwell:gamechanged. Concatenate them so both run in order).
// ';' separator: two `(() => {…})()` IIFEs joined by a bare newline parse as ONE call chain
// (`(a)()(b)()` — no ASI before `(`), which threw and left B with no HUD tap in WS mode.
const B_INIT = WS_FLAG_INIT ? [WS_FLAG_INIT, HUD_TAP].join(';\n') : HUD_TAP;
const B = await openMirrorWindow(browser, 'B', { extraInit: B_INIT });

// CP0 — both windows on the SAME started game (shared canonical session) or the mirror can't engage.
const e0 = { A: pub(await engineSnapshot(A.ctx)), B: pub(await engineSnapshot(B.ctx)) };
console.log(`CP0: started A=${e0.A.started} B=${e0.B.started} beat=${e0.A.beatSeq}/${e0.B.beatSeq} houseA=${e0.A.houseCount}`);
if (e0.A.started === false || e0.B.started === false) {
  console.error('\n*** PRECONDITION UNMET: game is not STARTED in both windows — seed a started season first.');
  await A.ctx.close(); await B.ctx.close(); await browser.close();
  process.exit(2);
}

// CP-warm — reach STEADY STATE first (the real scenario): A sends a WARM-UP framed turn so the
// canonical game session BINDS (apply_game_framing binds on the first framed turn) and BOTH windows
// converge + subscribe to that canonical SSE channel. Without this, the FIRST framed turn binds the
// canonical id mid-turn and the end-of-turn push races AHEAD of the peers' not-yet-existing
// subscription (publish-to-zero-subscribers) — a first-turn artifact, NOT the steady-state bug this
// gate targets (two windows already in the game; A sends; B must reconcile off the push). The live
// repro (window A "1 of 15 met" / window B "0 of 15") is exactly steady state.
console.log('\nCP-warm: A sends a warm-up turn to bind the canonical session + converge both windows…');
await sendTurn(A.page, "(I take a slow breath and look around the room, just getting my bearings for a second.)");
await waitSettled(A.page);
// Let both windows discover the now-bound canonical id and subscribe their SSE to it (sessionSync's
// canonical-discovery poll + bind). Generous settle so the RED/GREEN signal is the PUSH, not a
// not-yet-subscribed peer.
await B.page.waitForTimeout(5000);
await A.page.evaluate(() => { try { window.__hud = { changed: [], hudFetch: [] }; } catch (_) {} });
await B.page.evaluate(() => { if (window.__hud) { window.__hud.changed = []; window.__hud.hudFetch = []; } });
const eWarm = pub(await engineSnapshot(A.ctx));
console.log(`   canonical bound, both subscribed; beat now ${eWarm.beatSeq}`);

// CP1 — A sends ONE mutating turn; B is the passive HUD mirror (steady state).
const sendWall = Date.now();
console.log(`\nCP1 A sends @${sendWall}: ${JSON.stringify(TURN)}`);
await sendTurn(A.page, TURN);
const reasonA = await waitSettled(A.page);
const aSettleWall = Date.now();
console.log(`   A settled: ${reasonA} @${aSettleWall} (+${aSettleWall - sendWall}ms)`);

// Wait for B's first PUSH-DRIVEN reconcile (an `orwell:gamechanged` carrying the sync:game-updated
// reason — the 0064 server-push, never the poll), or a bounded timeout.
const bPush = await waitForBPush(B.page, sendWall, B_WAIT_MS);

// Confirm the turn actually MUTATED the engine (beatSeq bump) — a non-mutating turn is not a valid
// test of HUD PARITY (and must not yield a false GREEN). Give the fire-and-forget 0055 belt a moment
// to commit before we read the after-snapshot.
await A.page.waitForTimeout(2500);
const e1 = { A: pub(await engineSnapshot(A.ctx)), B: pub(await engineSnapshot(B.ctx)) };
// Mutation = the MEASURED turn advanced the beat beyond the POST-WARM-UP baseline (not e0, which
// predates the warm-up turn) — so the warm-up's own mutation can't mask a measured no-op.
const mutated = (typeof e1.A.beatSeq === 'number' && typeof eWarm.beatSeq === 'number')
  ? e1.A.beatSeq > eWarm.beatSeq : false;

const hudB = await B.page.evaluate(() => window.__hud || { changed: [], hudFetch: [] });
const firstPushMs = bPush ? (bPush.wall - sendWall) : null;
// THE PARITY LAG: B's HUD reconcile relative to A's SETTLE — i.e. the moment A's OWN HUD reflects the
// change (A refreshes its own HUD client-side at settle via the g15 dispatcher) vs the moment B's
// does (off the push). This is the A↔B gap the live repro showed (A "1 of 15 met" while B stayed "0
// of 15"). Measuring from A's SETTLE, not from send, is correct: the mutation (the 0055 belt) only
// COMMITS at end-of-turn, so a streamed turn's whole duration is not parity latency — the push-to-peer
// delay is. A push that lands at/before A's settle is zero lag (clamped at 0).
const aSettleMs = aSettleWall - sendWall;
const parityLagMs = bPush ? Math.max(0, bPush.wall - aSettleWall) : null;
// DIAGNOSTIC only: B's first HUD re-fetch after the send. The status panel polls on a few-second
// cadence, so a fetch within budget can be a poll OR a push — it CANNOT distinguish them. The
// load-bearing, push-ONLY signal is `bReceivedPush` (the `sync:game-updated` orwell:gamechanged
// event, dispatched ONLY by the 0064 SSE), which is what actually triggers every HUD panel to
// reconcile. So this is reported, not gated.
const firstHudFetch = (hudB.hudFetch || []).find((f) => f.wall >= sendWall);
const firstHudFetchMs = firstHudFetch ? (firstHudFetch.wall - sendWall) : null;

const checks = {
  turnMutatedEngine: mutated,                                                    // precondition: the measured turn committed a mutation
  bReceivedPush: bPush != null,                                                  // B got the 0064 game-updated push (the push-ONLY signal, never the poll)
  parityWithinBudget: parityLagMs != null && parityLagMs <= HUD_PARITY_BUDGET_MS, // B's HUD reconciles within the budget of A's (the push fires the panel reconcile)
};
const PASS = Object.values(checks).every(Boolean);

const report = {
  meta: { turn: TURN, sendWall, reasonA, budgetMs: HUD_PARITY_BUDGET_MS, model: process.env.FAKE_MODEL_ID || 'fake/echo-stream', transportMode: MODE },
  engine: { beatWarmBaseline: eWarm.beatSeq, beatAfter: e1.A.beatSeq, mutated, convergedBeat: [e1.A.beatSeq, e1.B.beatSeq] },
  timing: { aSettleMs, firstPushMs, parityLagMs },
  bPush: { firstPushReason: bPush ? bPush.reason : null, firstPushMs, parityLagMs, allChanged: hudB.changed, firstHudFetchMs, hudFetch: hudB.hudFetch },
  checks, PASS,
};
writeJson(OUT + 'mirror-hud-report.json', report);
await A.page.screenshot({ path: OUT + 'A.png', fullPage: true }).catch(() => {});
await B.page.screenshot({ path: OUT + 'B.png', fullPage: true }).catch(() => {});

console.log('\n──── MIRROR HUD-PARITY GATE (F5 status/gadget half · 0064 §B/D) ────');
console.log(`turn mutated the engine        : beat ${eWarm.beatSeq} → ${e1.A.beatSeq} → ${checks.turnMutatedEngine}  (false ⇒ not a valid parity test — the measured turn changed nothing)`);
console.log(`B received the game-updated push: reason=${bPush ? bPush.reason : 'NONE'} @+${firstPushMs == null ? 'n/a' : firstPushMs + 'ms'} (A settled @+${aSettleMs}ms) → ${checks.bReceivedPush}  (false ⇒ NO push reached B — it would only converge on its 20–30s poll)`);
console.log(`B↔A parity lag within budget    : ${parityLagMs == null ? 'n/a' : parityLagMs + 'ms'} (budget ${HUD_PARITY_BUDGET_MS}ms; B's reconcile vs A's settle) → ${checks.parityWithinBudget}`);
console.log(`(diag) B first HUD re-fetch     : +${firstHudFetchMs == null ? 'n/a' : firstHudFetchMs + 'ms'}  (poll-confounded — not gated; the push above fires the panel reconcile)`);
console.log(`\nVERDICT: ${PASS ? "PASS — B's HUD mirrors A's mutation off the server push, within budget" : 'FAIL — B did not reconcile off a push within budget (stale until its poll) — F5 status/gadget half'}`);
console.log(`artifacts: ${OUT}`);

await A.ctx.close(); await B.ctx.close(); await browser.close();
process.exit(PASS ? 0 : 1);

// ── helpers ──
// Poll B's HUD tap until the first `orwell:gamechanged` carrying the push reason
// (sync:game-updated for SSE, ws:state for WS transport) lands AFTER `sinceWall`. Under SSE,
// `sync:game-updated` is dispatched ONLY by sessionSync.js's notifyGameUpdated on a server
// `game-updated` SSE — by construction it is the push, not the poll. Under WS, the
// platform.js ws:state bridge fires `orwell:gamechanged` with reason `ws:state` on the
// same game-updated edge. Accept BOTH so the gate works under either transport.
async function waitForBPush(page, sinceWall, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = await page.evaluate((since) => {
      const c = (window.__hud && window.__hud.changed) || [];
      return c.find((e) => e.wall >= since && /sync:game-updated|ws:state/.test(e.reason || '')) || null;
    }, sinceWall);
    if (hit) return hit;
    await page.waitForTimeout(100);
  }
  return null;
}
