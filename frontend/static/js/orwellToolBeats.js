// orwellToolBeats — the SINGLE source of truth for the C14/C19 immersion treatment:
// every engine/agent tool the GM can pull renders as a quiet, diegetic production
// "beat" (a label + status), never its raw camelCase name or its raw JSON payload.
//
// Both render paths import this:
//   • live stream    → chat.js   (relabel + clear cmd/output as tools run)
//   • history reload → chatRenderer.js (same treatment when a session is re-opened)
// Keeping it here prevents the two paths from drifting — a tool added to the live
// path but not the reload path was leaking raw names + engine JSON on every reload.
// M2-5 (audit B4; owner pick 2026-07-08) + #1626 increment 2: the diegetic transcript author is the
// show's PRODUCTION VOICE — never the model name, and no longer the product name ("Orwell" stays
// product chrome: wordmark, tab title, admin). GAME_NARRATOR is the DEFAULT byline ("Production") —
// the safe pre-resolution value AND the parked P-1 rebrand's one line. Once the engine resolves the
// season's seeded, Vault-free producer name, the stream hands it to the client (chat.js sets
// `window.ORWELL_GAME_NARRATOR` from the `orwell_narrator` event) and the byline reflects THAT
// producer, stable per season. Every game-build sender-label site reads the dynamic `gameNarrator()`
// getter below — NOT this frozen const — so the byline tracks the producer; fail-open to "Production".
export const GAME_NARRATOR = 'Production';
if (typeof window !== 'undefined') window.ORWELL_GAME_NARRATOR = GAME_NARRATOR;

// The DYNAMIC byline: the season's resolved producer name if this window has one, else the
// "Production" default. Every game-build sender-label site reads THIS so the byline tracks the
// producer. Fail-open: an unset/blank window value ⇒ GAME_NARRATOR.
export function gameNarrator() {
  const n = (typeof window !== 'undefined' && window.ORWELL_GAME_NARRATOR) || '';
  return (typeof n === 'string' && n.trim()) ? n.trim() : GAME_NARRATOR;
}

// Set this window's resolved producer byline (from the stream's `orwell_narrator` event). Fail-open:
// a blank/absent name resets to the "Production" default — never throws, never leaves it empty.
export function setGameNarrator(name) {
  if (typeof window === 'undefined') return;
  window.ORWELL_GAME_NARRATOR = (typeof name === 'string' && name.trim()) ? name.trim() : GAME_NARRATOR;
}

export const ORWELL_TOOL_BEATS = {
  'createCharacter': '🎬 Casting',
  'getGameState': '📋 Production notes',
  'gameStatus': '📋 Production notes',
  'getVisibleStateFor': '📋 Production notes',
  'getMomentPrompt': '📋 Production notes',
  'runCompetition': '🏆 Competition',
  'advanceGame': '📺 Production',
  'submitDecision': '🗳 Your move',
  // 0061: the player signalled they may want to walk out — a quiet producer-aside beat.
  'requestSelfEviction': '🚪 A word with production',
  'recordInteraction': '🎬 Scene log',
  'surfaceInformationTo': '🤫 Word travels',
  'socialRead': '👀 Reading the room',
  // Owner ruling 2026-06-18: NPC approach-INTENT never surfaces to the player — not even as a
  // beat label that says someone "wants a word". The GM reads the house's social pull privately and
  // voices any approach organically in chat, so this reads as a neutral "reading the house" beat.
  'socialInitiatives': '🏠 Reading the house',
  'diaryRoom': '📔 Diary Room',
  'makeDeal': '🤝 Handshake',
  // 0107: the player names a pact / accepts an NPC's pitch into a named alliance.
  'formAlliance': '👥 Naming an alliance',
  'joinAlliance': '👥 Joining an alliance',
  // 0093/0099: out a learned secret to the house / trade it to a houseguest for a favor.
  'exposeSecret': '🗣 Outing a secret',
  'tradeSecret': '🔁 Trading a secret',
  // 0094/0095: confront a houseguest over a learned fact / accuse a pre-show tie.
  'confront': '⚡ Confrontation',
  'accuseTie': '🔍 Calling out a tie',
  // 0075: the player presses an ally to open up; the engine decides the disclosure.
  'confide': '🤫 Confiding',
  // 0129: the juror-player asks a fellow juror what they know.
  'askJuror': '🗳 Asking a juror',
  'askProducers': '🎙 Producers',
  'renderScene': '📺 Production',
  'endOfSessionSummary': '📼 Tape check',
  'finaleView': '👑 Finale',
  // D5/W6: EVERY keep-set tool the agent can pull renders diegetically —
  // raw camelCase names in the transcript are the C14/C19 immersion bleed.
  'updateCasting': '\u{1F3AC} Casting notes',
  'whereabouts': '\u{1F9ED} Around the house',
  'moveTo': '\u{1F6B6} Moving through the house',
  'premiereIntros': '\u{1F44B} Meeting the house',
  'markHouseguestMet': '\u{1F91D} First impressions',
  'seasonRecap': '\u{1F4DC} The season so far',
  'seasonRetrospective': '\u{1F513} The producers’ vault',
  // #1800 / #1793: the player's OWN Diary-Room record (pure reads — also silent below).
  'playerReceipts': '\u{1F9FE} The receipts',
  'playerDossier': '\u{1F4D3} Your diary reads',
  // 0102: the daily "day in review" digest re-fetch (usually delivered inline on turnIn).
  'dailyRecap': '\u{1F4C6} The day in review',
  // 0062: the move-in zeitgeist snapshot — public flavor from the outside world.
  'worldSnapshotView': '\u{1F30D} The world outside',
  // ADR 0006 (#1385): the player turns in for the night — the house rolls to morning (the 0102 recap
  // rides this beat's result). A real mutation, so it stays VISIBLE (never in ORWELL_SILENT_BEATS).
  'turnIn': '\u{1F319} Lights out',
  'npcVoice': '\u{1F3AD} In their head',
  'inspectNonVaultState': '\u{1F50E} Control room',
  'overrideMechanic': '\u{1F39B} Control room',
  'configureGame': '\u{1F39B} Control room',
  'manageSandbox': '\u{1F39B} Control room',
  'sandboxHealth': '\u{1F39B} Control room',
  'web_search': '\u{1F4E1} Checking the feeds',
  'ask_user': '\u{1F399} A question for you',
  'update_plan': '\u{1F4CB} Production notes',
  'ui_control': '\u{1F4FA} Camera direction',
  'generate_image': '\u{1F4F8} Photo booth',
  'search_chats': '\u{1F4DC} The archive',
  'list_models': '\u{1F4E1} Checking the feeds',
  'manage_settings': '\u{1F39B} Control room',
  'manage_endpoints': '\u{1F39B} Control room',
  'manage_tokens': '\u{1F39B} Control room',
  'manage_mcp': '\u{1F39B} Control room',
};

export function orwellBeat(tool) {
  return (tool && ORWELL_TOOL_BEATS[tool]) || null;
}

// ADR 0011 — PURE CONTEXT-READ beats. The model fires these to GROUND itself (read the board, the
// room, a houseguest's read); they change NOTHING the player witnessed, carry no public outcome, and
// on a long / concurrent-re-ground turn they stack as a wall of identical "📋 Production notes" rows —
// the operator's "too much LLM rendered in the FE" garbage. In the game build BOTH render paths skip
// them entirely; the meaningful beats (comps, ceremonies, scene logs, deals, moves) still show.
// (Engine READS only — never a mutation — so dropping the chip loses no player-facing fact.)
export const ORWELL_SILENT_BEATS = new Set([
  'getGameState', 'gameStatus', 'getVisibleStateFor', 'getMomentPrompt',
  'whereabouts', 'socialRead', 'socialInitiatives', 'npcVoice', 'seasonRecap',
  // 0102: a pure re-fetch of a digest already delivered inline on turnIn — no new mutation.
  'dailyRecap',
  // #1800 / #1793: pure reads of the player's own Diary-Room record — no mutation.
  'playerReceipts', 'playerDossier',
  // 0062: a pure read of the zeitgeist snapshot — no mutation, no player-facing outcome.
  'worldSnapshotView',
  'inspectNonVaultState', 'sandboxHealth', 'list_models', 'search_chats',
  // FEDEEP-6/CA-23 — the admin/God-Mode meta-port tools (CLAUDE.md: "configure, override
  // mechanics, inspect non-Vault state, manage the sandbox"). These should never reach the player
  // channel at all, but ORWELL_TOOL_BEATS still maps them to a "🎛 Control room" label for the
  // admin/dev render path — silencing them in the game build is defense-in-depth so a stray
  // God-Mode call (e.g. a misrouted admin session sharing this render path) never announces
  // itself to the player. inspectNonVaultState/sandboxHealth were already silent; this closes the
  // rest of the admin/God Mode set (`configureGame` has no live engine tool of that name today —
  // kept here anyway as a harmless belt-and-suspenders in case one is ever added).
  'overrideMechanic', 'configureGame', 'manageSandbox',
]);

export function orwellBeatIsSilent(tool) {
  return ORWELL_SILENT_BEATS.has(tool);
}

// ADR 0011 — the per-turn beat-rail BACKSTOP. Even after silent beats are dropped and the loop's
// beat-aware staleness fix lands, a pathological turn must never stack an unbounded column of chips.
// Both render paths keep the most recent N solidified beats and drop older overflow. Generous on
// purpose — a normal turn (a handful of beats) never hits it; this is a safety net, not a budget.
export const ORWELL_MAX_VISIBLE_BEATS = 10;

// L42 — the PUBLIC outcome of a solidified beat (so the chat shows WHAT happened, not a stack of
// identical "PRODUCTION done" rows). Derived ONLY from the tool RESULT's player-witnessed, Vault-free
// fields: the resolved beat's `event.content` (a short diegetic sentence the engine already exposes —
// "Maya nominates Cole and Jess", "Troy is evicted"), the crowned `winner`, and, for an eviction, the
// anonymized ballot count from the staged `eviction.votesRevealed` (E12: ballots, never voters). No
// hidden state is ever read here — these are the same facts the player sees on the ceremonies.
const _BEAT_ICON = {
  'hoh-competition': '🏆', 'veto-competition': '💎', 'veto-draw': '🎟️', 'nominations': '🔨',
  'veto-ceremony': '💎', 'eviction': '🗳️', 'eviction-result': '🗳️', 'eviction-reveal': '🗳️',
  'eviction-goodbye': '💌', 'exit-interview': '🎤', 'spectator-choice': '🍿', 'finale-interview': '🎙️', 'final-eviction': '🗳️', 'finale': '👑', 'finale-reveal': '👑',
  'finale-result': '👑', 'twist-reveal': '🌀',
  // A75: the engine beat kinds that used to fall back to a bare bullet (contract: tests/test_a75_beat_icon_contract.py parses the engine's Beat union)
  'comp-elimination': '🧗', 'battle-back': '⚔️', 'self-eviction': '🚪', 'final-hoh-part': '🏆', 'day-break': '🌅',
};

export function orwellBeatOutcome(tool, output) {
  if (!output) return null;
  let r;
  try { r = typeof output === 'string' ? JSON.parse(output) : output; }
  catch (_) { return null; }
  if (!r || typeof r !== 'object') return null;
  // A crowned winner trumps everything.
  if (r.finished && r.winner && r.winner.name) return `👑 ${r.winner.name} wins the season`;
  const ev = r.event;
  if (!ev || !ev.content) return null;
  const icon = _BEAT_ICON[ev.beat] || '•';
  // ORW-232 slice 1: a competition's per-round drop is told in the narrator's one continuous scene, so its box is COMPACTED to a short progress line (who falters and how is prose, not a box).
  // The crown beat keeps its full outcome (and the ceremony slate); only the interim rounds shrink.
  if (ev.beat === 'comp-elimination') {
    const left = /(\d+)\s+remain/i.exec(String(ev.content));
    return left ? `${icon} The competition: ${left[1]} remain` : `${icon} The competition continues`;
  }
  let content = String(ev.content);
  // Append the anonymized ballot tally for a resolved eviction, when the staged ballots are present.
  if (/eviction|final-eviction/.test(ev.beat || '') && r.eviction && Array.isArray(r.eviction.votesRevealed) && r.eviction.votesRevealed.length) {
    const counts = {};
    for (const v of r.eviction.votesRevealed) {
      const n = v && v.votedFor && v.votedFor.name;
      if (n) counts[n] = (counts[n] || 0) + 1;
    }
    const nums = Object.values(counts).sort((a, b) => b - a);
    if (nums.length) content += ` (${nums.join('-')})`;
  }
  return `${icon} ${content}`;
}

export function isGameBuild() {
  return !!(typeof document !== 'undefined' && document.body && document.body.hasAttribute('data-game-build'));
}

// ── #1325 — PHASE-AWARE narrator WAIT/status chrome copy ─────────────────────────────────
// The byline (gameNarrator(), above) is the show's production voice — the DEFAULT "Production" until
// the engine resolves the season's producer name, then that producer, STABLE PER SEASON (not per
// phase; #1626 relaxed M2-5's phase-invariance to producer-name-invariance — same producer all game).
// But the WAIT-state copy underneath that byline is a DIFFERENT thing: "the producers are
// rolling / talking it over" is a pre-game/casting voice, and it stayed on screen unchanged
// after the season started because the chrome that renders it never asked what phase the
// game was in (#1325). This is the one shared source both callers (chat.js's `_waitLabel` /
// `_inProgressLabel`) read from — a producer-flavored table pre-game, a house/broadcast-
// flavored table once a season is live.
const _WAIT_COPY = {
  casting: {
    init: 'The producers are rolling',
    waiting: 'The producers are talking it over',
    still: 'The producers are still deliberating',
  },
  started: {
    init: 'The feeds are rolling',
    waiting: 'The house is in motion',
    still: 'Cameras are still rolling',
  },
};

// The ONE cached, Vault-free "has the season started?" signal this module tracks — never a
// new poll. It fetches `/api/orwell/state` (the same shared HUD read every other panel already
// polls) exactly ONCE at load, then refreshes only when the existing g15 seam says something
// changed — `orwell:gamechanged`, the single debounced dispatcher owned by platform.js
// (this module only LISTENS; it never dispatches). Fails open to `false` (the casting/pre-game
// voice) so a slow/unreachable read never falsely announces a started season.
let _seasonStarted = false;
function _refreshSeasonStartedSignal() {
  if (typeof fetch !== 'function') return;
  fetch('/api/orwell/state', { credentials: 'same-origin' })
    .then((r) => (r && r.ok ? r.json() : null))
    .then((st) => { if (st && typeof st.started === 'boolean') _seasonStarted = st.started; })
    .catch(() => { /* fail open — keep the last-known value */ });
}
export function isSeasonStarted() { return _seasonStarted; }
if (typeof window !== 'undefined') {
  _refreshSeasonStartedSignal();
  window.addEventListener('orwell:gamechanged', _refreshSeasonStartedSignal);
}

/**
 * The phase-aware wait/status copy for a generic waiting `stage` ('init' | 'waiting' | 'still').
 * `started` is optional — pass it explicitly (e.g. from a caller that already has fresher state)
 * or omit it to read the cached signal above. Returns null for an unknown stage so callers keep
 * their own literal fallback (mirrors `orwellBeat`'s null-on-miss contract).
 */
export function narratorWaitCopy(stage, started) {
  const phase = (typeof started === 'boolean' ? started : isSeasonStarted()) ? 'started' : 'casting';
  const table = _WAIT_COPY[phase];
  return (table && table[stage]) || null;
}

// ── M4-6 — CEREMONY SLATES ────────────────────────────────────────────────────────────────
// A curated subset of resolved beats — HOH win, nominations, veto win, veto ceremony, and
// eviction result — upgrade from the compact `.ow-slate-outcome` chip (above) to a DESIGNED
// FULL-WIDTH card: a portrait (OrwellMonogram), the subject's name, and a role line, inserted
// into the transcript beside the model's narration. The week roll rides the HOH card rather
// than getting its own synthetic card: a "week" IS one HOH reign (CLAUDE.md), so the HOH
// competition beat that just resolved is, definitionally, the moment the new week begins —
// there is no separate engine beat to source a distinct card from, and inventing one would be
// a card not backed by a real tool-result event.
//
// Sourced ONLY from the resolved tool result's closed-set fields — `event.beat` / `content` /
// `participants` (Vault-free NamedRefs, EVT-1) and `status.veto.holder` (Vault-free
// PublicGameStatus) — NEVER parsed from narration prose (ADR 0005). `orwellCeremonySlate` is a
// PURE function of (tool, output): the live path (chat.js, at tool_output) and the reload path
// (chatRenderer.js, at history render) both call it with the SAME tool-result JSON shape
// (`json.tool`/`json.output` live, `ev.tool`/`ev.output` persisted), so the two paths derive an
// identical descriptor — and `orwellRenderCeremonySlate` below is the ONE shared DOM builder
// both paths call, so the markup itself can never drift between live and reload.
export const CEREMONY_SLATE_KIND = {
  'hoh-competition': 'hoh',
  'nominations': 'nominations',
  'veto-competition': 'veto-win',
  'veto-ceremony': 'veto-ceremony',
  'eviction-result': 'eviction',
  'eviction': 'eviction',
};

// Role-line text matches OrwellMonogram's own badge labels (BADGES[*].label) so the card's
// caption and the face's badge tooltip always agree.
const _SLATE_ROLE = {
  'hoh': 'Head of Household',
  'nominations': 'Nominated',
  'veto-win': 'Veto holder',
  'veto-ceremony': 'Veto Ceremony',
  'eviction': 'Evicted',
};

// OrwellMonogram badge keys (orwellMonogram.js BADGES) — veto-ceremony and eviction carry NO
// badge: the ceremony can name several people in different roles (holder / saved / replacement)
// with no single structural "the" subject, and eviction is the L16 grayscale-only rule (an
// evicted houseguest is never badged, per orwellMonogram.js's own comment).
const _SLATE_BADGE = {
  'hoh': 'hoh',
  'nominations': 'nominee',
  'veto-win': 'veto',
};

/**
 * Build a Vault-free ceremony-slate descriptor from a resolved advanceGame/submitDecision tool
 * result, or null when this tool/output isn't a slate-worthy ceremony beat. Pure + deterministic:
 * identical (tool, output) always yields an identical descriptor, live or on reload.
 */
export function orwellCeremonySlate(tool, output) {
  if (tool !== 'advanceGame' && tool !== 'submitDecision') return null;
  let r;
  try { r = typeof output === 'string' ? JSON.parse(output) : output; }
  catch (_) { return null; }
  if (!r || typeof r !== 'object') return null;
  const ev = r.event;
  if (!ev || !ev.content || !ev.beat) return null;
  const kind = CEREMONY_SLATE_KIND[ev.beat];
  if (!kind) return null;
  const participants = Array.isArray(ev.participants) ? ev.participants : [];
  const week = (r.status && typeof r.status.week === 'number') ? r.status.week : null;

  let subjects = [];
  if (kind === 'hoh') {
    subjects = participants.slice(0, 1); // the crown event carries just the winner
  } else if (kind === 'nominations') {
    subjects = participants.slice(1, 3); // [hoh, nominee, nominee] — the two nominees
  } else if (kind === 'veto-win') {
    // The crown event's `participants` carries the FULL drawn field (it folds consequence for
    // the whole six), not just the winner — the structured winner lives on status.veto.holder.
    const holder = r.status && r.status.veto && r.status.veto.holder;
    subjects = holder ? [holder] : participants.slice(0, 1);
  } else if (kind === 'veto-ceremony') {
    subjects = participants.slice(0, 3); // holder/saved/hoh/replacement — shape varies by branch
  } else if (kind === 'eviction') {
    subjects = participants.slice(0, 1); // the evictee
  }
  if (!subjects.length) return null;

  let ballotLine = null;
  if (kind === 'eviction' && r.eviction && Array.isArray(r.eviction.votesRevealed) && r.eviction.votesRevealed.length) {
    const counts = {};
    for (const v of r.eviction.votesRevealed) {
      const n = v && v.votedFor && v.votedFor.name;
      if (n) counts[n] = (counts[n] || 0) + 1;
    }
    const nums = Object.values(counts).sort((a, b) => b - a);
    if (nums.length) ballotLine = nums.join('-');
  }

  const weekRoll = kind === 'hoh' && week != null;
  return {
    kind,
    week,
    weekRoll,
    role: _SLATE_ROLE[kind],
    kicker: weekRoll ? `Week ${week} · ${_SLATE_ROLE[kind]}`
      : (kind === 'nominations' && participants[0] && participants[0].name)
        ? `${_SLATE_ROLE[kind]} by ${participants[0].name}`
        : _SLATE_ROLE[kind],
    badge: _SLATE_BADGE[kind] || null,
    headline: String(ev.content) + (ballotLine ? ` (${ballotLine})` : ''),
    subjects, // NamedRef[] — {id, name}
  };
}

/**
 * The ONE shared DOM builder for a ceremony-slate card — chat.js (live) and chatRenderer.js
 * (reload) both call this with the descriptor from `orwellCeremonySlate` so the same input
 * always produces byte-identical markup. Faces render through OrwellMonogram, resolving a
 * portrait SYNCHRONOUSLY from its shared portrait cache (issue #1324: id→portrait, kept warm
 * off the ONE `orwell:gamechanged` dispatcher event, never fetched here) — deterministic per
 * paint, so the card never depends on a network round-trip landing mid-render, and live vs.
 * reload can never visually diverge because a portrait loaded on one pass but not the other:
 * both passes read whatever snapshot of the SAME cache is already loaded when they paint. A
 * cache miss (no portrait on file yet) falls back to the designed monogram and upgrades in
 * place the next time this card's beat is repainted after the cache refreshes.
 */
export function orwellRenderCeremonySlate(slate) {
  const card = document.createElement('div');
  card.className = 'ow-cslate ow-cslate-' + slate.kind;
  card.setAttribute('data-ow-cslate', slate.kind);

  const faces = document.createElement('div');
  faces.className = 'ow-cslate-faces';
  const evicted = slate.kind === 'eviction';
  for (const subj of slate.subjects) {
    const holder = document.createElement('span');
    holder.className = 'ow-cslate-face-holder';
    if (typeof window !== 'undefined' && window.OrwellMonogram) {
      const subjId = (subj && (subj.id || subj.name)) || '?';
      const cached = window.OrwellMonogram.portraitFor ? window.OrwellMonogram.portraitFor(subjId) : null;
      holder.appendChild(window.OrwellMonogram.face(
        { id: subjId, name: subj && subj.name, status: evicted ? 'evicted' : 'active',
          portrait: cached && cached.portrait },
        { role: slate.badge, alt: subj && subj.name }
      ));
    }
    faces.appendChild(holder);
  }

  const body = document.createElement('div');
  body.className = 'ow-cslate-body';
  const kicker = document.createElement('div');
  kicker.className = 'ow-cslate-kicker';
  kicker.textContent = slate.kicker;
  const names = document.createElement('div');
  names.className = 'ow-cslate-names';
  names.textContent = slate.subjects.map((s) => s && s.name).filter(Boolean).join(' & ');
  const line = document.createElement('div');
  line.className = 'ow-cslate-line';
  line.textContent = slate.headline;
  body.appendChild(kicker);
  body.appendChild(names);
  body.appendChild(line);

  card.appendChild(faces);
  card.appendChild(body);
  return card;
}

// ORW-264 (R2, ADR 0015): the ONE pure builder of a FINISHED tool-beat chip node, used by BOTH the live
// stream (chat.js tool_output) and the reload path (chatRenderer.js) so the two can never drift again
// (a "stack of identical beat rows" / a check + "done" tail on one path only). Pure: (inputs) -> {className,
// innerHTML, outcome}. `beat` is the caller's resolved ORWELL_TOOL_BEATS label (null => not a production
// beat); `expandHtml` is the already-built expandable content (command/output/diff, '' for a beat).
// Live-only presentation state (`wasOpen`, `reveal` = the transient ceremony-reveal entrance) is an
// input, never read from the DOM, so reload (false/false) yields the same markup minus transients.
export function orwellBeatNodeView({ tool, beat, ok, output, expandHtml, esc, wasOpen = false, reveal = false }) {
  const hasExpand = !!String(expandHtml || '').trim();
  const outcome = (beat && ok) ? orwellBeatOutcome(tool, output) : null;
  const toolText = outcome || beat || tool;
  // game-build slates carry no "done" debug tail; failures stay literal (J1-30)
  const statusHtml = outcome ? '' : (ok && isGameBuild()) ? ''
    : `<span class="agent-thread-status">${ok ? 'done' : 'failed'}</span>`;
  const chevron = hasExpand ? '<span class="agent-thread-chevron">\u25B6</span>' : '';
  const contentDiv = hasExpand ? `<div class="agent-thread-content">${expandHtml}</div>` : '';
  const className = 'agent-thread-node' + (ok ? '' : ' error') + (hasExpand ? '' : ' agent-thread-node--flat')
    + ((wasOpen && hasExpand) ? ' open' : '') + (outcome ? (reveal ? ' ow-ceremony-reveal' : '') + ' ow-slate-outcome' : '');
  const innerHTML = `<div class="agent-thread-dot"></div><div class="agent-thread-header"><span class="agent-thread-tool">${esc(toolText)}</span>${statusHtml}${chevron}</div>${contentDiv}`;
  return { className, innerHTML, outcome };
}

// ORW-264 (R2, ADR 0015): the ONE pure parse of an advanceGame/submitDecision tool result into its Vault-free
// AdvanceView, shared by the LIVE stream (chat.js tool_output: arms the decision card via `orwell:pending`
// + the chyron via `orwell:announcements`) and the RELOAD path (chatRenderer.js storedAnnouncements: repaints the
// chyron cards; the decision card itself re-arms from gameStatus.pending, never from a stored result).
// Returns the parsed object ({pending?, announcements?, ...}; a non-object parse is normalized to {}), or null
// when `tool` is not one of the two or the output is not JSON (fail-open: the caller does nothing).
export function orwellAdvanceView(tool, output) {
  if (tool !== 'advanceGame' && tool !== 'submitDecision') return null;
  try {
    const v = JSON.parse(output || '{}');
    return (v && typeof v === 'object') ? v : {};
  } catch (_) { return null; }
}
