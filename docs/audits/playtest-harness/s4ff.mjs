// State 4 — RESOLUTION fast-forward + endgame Vault oracle.
// Drives the LIVE auditadmin sandbox to game-finish via direct engine callTool (EchoNarrator, no model
// cost), scanning EVERY advance result + player projection through the Vault-leak oracle. Special focus:
//  - secret-ballot anonymization: an eviction-vote beat the PLAYER can see must NOT attribute per-voter.
//  - per-voter unsealing is POST-SEASON only (0048 retrospective) — never in a live player projection.
//  - no numeric stat / soul / relationship / hidden leak in any endgame player response.
import { BASE } from './rig.mjs';
const USER = process.env.ADMIN_USER || 'auditadmin';
const ENGINE = process.env.ORWELL_ENGINE_MCP_URL || 'http://127.0.0.1:8765';

async function tool(name, args = {}) {
  const r = await fetch(ENGINE + '/player/call', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Orwell-User': USER },
    body: JSON.stringify({ name, args }),
  });
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = null; }
  return { status: r.status, raw: txt, result: data && data.result, error: data && data.error };
}

// The same Vault-leak oracle the UAT uses, plus per-voter eviction attribution in a player surface.
const LEAK = [
  [/"(physical|mental|social)"\s*:\s*\d+\.\d+/, 'numeric competition stat'],
  [/"(trust|affinity|threat)"\s*:\s*\d+\.\d+/, 'raw relationship numeric'],
  [/"soul"\s*:\s*[{[]/, 'soul object/array'],
  [/"hidden"\s*:\s*true/, 'hidden:true flag'],
  [/\bnpc:\d+\b/, 'raw entity id'],
];
const anomalies = [];
function scan(raw, where) { for (const [re, d] of LEAK) if (re.test(raw)) anomalies.push({ where, leak: d, sample: (raw.match(re) || [''])[0].slice(0, 60) }); }

function autoResolve(p) {
  switch (p.kind) {
    case 'nominations': return { kind: 'nominations', choice: [p.options[0].id, p.options[1].id] };
    case 'veto-decision': return { kind: 'veto-decision', use: false };
    case 'comp-intent': return { kind: 'comp-intent', intent: 'compete' };
    case 'comp-round': return { kind: 'comp-round', intent: 'compete' };
    case 'houseguests-choice': return { kind: 'houseguests-choice', vote: p.options[0].id };
    case 'replacement': return { kind: 'replacement', replacement: p.options[0].id };
    case 'eviction-vote': return { kind: 'eviction-vote', vote: p.options[0].id };
    case 'tie-break': return { kind: 'tie-break', vote: p.options[0].id };
    case 'final-eviction': return { kind: 'final-eviction', vote: p.options[0].id };
    case 'goodbye-message': return { kind: 'goodbye-message', vote: p.options[0].id, statement: 'Take care.' };
    case 'finale-statement': return { kind: 'finale-statement', statement: 'I played my own game.' };
    case 'finale-answer': return { kind: 'finale-answer', appeal: (p.appeals && p.appeals[0]) || 'own-game' };
    case 'juror-question': return { kind: 'juror-question', statement: 'What was your biggest move?' };
    // The engine reads the exit stance off `vote` (or `choice`) and the words off `statement` — `stance`/
    // `message` are its INTERNAL field names, so sending them made every exit interview a silent no-op.
    case 'exit-interview': return { kind: 'exit-interview', vote: (p.options && p.options[0] && p.options[0].id) || (p.stances && p.stances[0]) || 'gracious', statement: 'Take care.' };
    case 'juror-vote': return { kind: 'juror-vote', vote: p.options[0].id };
    default: return { kind: p.kind };
  }
}

const gs0 = await tool('getGameState');
console.log('START', gs0.status, 'started=', gs0.result && gs0.result.started, 'house=', gs0.result && (gs0.result.house || []).length);
if (!gs0.result || !gs0.result.started) { console.log('NO ACTIVE GAME for', USER, '-', gs0.error); process.exit(2); }

let weeks = new Set(), evictBeats = [], finaleKinds = new Set(), playerFate = 'active', lastWinner = null;
let i = 0, finished = false, consecFail = 0;
for (; i < 4000; i++) {
  const adv = await tool('advanceGame');
  if (adv.status !== 200 || !adv.result) { console.log('ADV-ERR', adv.status, adv.error); if (++consecFail > 5) break; continue; }
  consecFail = 0;
  scan(adv.raw, 'advance#' + i);
  const a = adv.result;
  if (a.status) weeks.add(a.status.week);
  // Capture every beat the player can see; flag eviction-vote attribution leaks (secret ballot).
  if (a.event && a.event.content) {
    const c = a.event.content;
    if (/\bvote(s|d)?\b/i.test(c) && a.status && a.status.phase && /evict/i.test(a.status.phase)) evictBeats.push(c.slice(0, 200));
    // a player-visible beat that names a specific houseguest AS a specific voter ("X voted to evict")
    if (/\bvoted to evict\b/i.test(c) && /[A-Z][a-z]+ voted to evict/.test(c)) anomalies.push({ where: 'evict-beat#' + i, leak: 'per-voter ballot attribution in player beat', sample: c.slice(0, 120) });
  }
  if (a.finished) { finished = true; lastWinner = a.winner; break; }
  const p = a.pending;
  if (p) {
    if (/finale|juror/.test(p.kind)) finaleKinds.add(p.kind);
    const sub = await tool('submitDecision', autoResolve(p));
    if (sub.status !== 200) { console.log('SUB-ERR', p.kind, sub.status, sub.error); if (++consecFail > 5) break; }
    else scan(sub.raw, 'submit:' + p.kind);
    if (sub.result && sub.result.finished) { finished = true; lastWinner = sub.result.winner; break; }
  }
}

// Endgame player projections — must stay Vault-free.
const finalState = await tool('getGameState'); scan(finalState.raw, 'final/getGameState');
const visible = await tool('getVisibleState'); scan(visible.raw, 'final/getVisibleState');
// Determine player fate from the final house.
const house = (finalState.result && finalState.result.house) || [];
const me = house.find(h => h.isPlayer || h.you || /devon/i.test(h.name || ''));

const out = {
  iterations: i, finished, weeksReached: Math.max(...[...weeks, 0]), weeksPlayed: [...weeks].sort((a, b) => a - b),
  winner: lastWinner, finaleKindsSeen: [...finaleKinds], evictBeatCount: evictBeats.length,
  anomalies, evictBeatSamples: evictBeats.slice(0, 3),
};
console.log('S4FF', JSON.stringify(out, null, 2).slice(0, 2400));
import { writeFileSync, mkdirSync } from 'fs';
const HERE = new URL('.', import.meta.url).pathname; mkdirSync(HERE + 'shots/s4', { recursive: true });
writeFileSync(HERE + 'shots/s4/ff.json', JSON.stringify({ out, evictBeats }, null, 2));
console.log('S4FF-DONE anomalies=' + anomalies.length + ' finished=' + finished + ' winner=' + (lastWinner && lastWinner.name));
