// ============================================
// Platform detection + AltGr-keystroke helper
// ============================================
// Shared by the keybind code: root keyboard-shortcuts.js, the editor's
// keyboard-shortcuts.js, and settings.js. Single source of truth so the three
// guards can't drift.

// AltGr (right Alt on AZERTY/QWERTZ and most non-US layouts, used to type
// @ # { } [ ] | \ and €) is reported by browsers as Ctrl+Alt. macOS is the
// exception: there the Option key — a normal part of Mac shortcuts — also sets
// the AltGraph modifier state, so it must NOT be treated as AltGr.
//
// IS_MAC covers all Apple platforms, iPad/iPhone included: a Magic Keyboard's
// Option key sets AltGraph exactly like a Mac's, so they need the same carve-out
// — narrowing to macOS-only would re-break them. The name and the
// /Mac|iPhone|iPad/ test deliberately mirror the existing isMac checks in
// calendar.js and sessions.js; this is their single shared source of truth.
export const IS_MAC =
  /Mac|iPhone|iPad/.test((typeof navigator !== 'undefined' && navigator.platform) || '') ||
  /Mac/.test((typeof navigator !== 'undefined' && navigator.userAgent) || '');

// True when `e` is an AltGr keystroke we should ignore for Ctrl+Alt shortcut
// purposes. getModifierState('AltGraph') is true for AltGr but false for a
// genuine left Ctrl+Alt, so real shortcuts still work. Always false on macOS,
// where Option legitimately sets AltGraph.
//
// We also require ctrlKey+altKey: the collision we defend against is precisely
// "AltGr reported AS Ctrl+Alt", so an event that asserts AltGraph WITHOUT
// presenting as Ctrl+Alt (a Linux ISO_Level3_Shift layout, a stray modifier
// state) is left alone instead of being swallowed.
//
// Trade-off: on Windows AltGr *is* Ctrl+right-Alt, so a deliberate
// Ctrl+Alt+<char> shortcut typed via AltGr is unreachable too — accepted; use
// the left Ctrl+Alt.
//
// NOTE: the AltGr -> AltGraph mapping is taken from the UI Events spec / MDN,
// not proven by our tests. Older Firefox and some Linux setups historically did
// not report AltGraph; where a browser sets ctrlKey+altKey without it this
// guard is simply a no-op (the pre-fix behaviour) rather than a regression.
export function isAltGrEvent(e, isMac = IS_MAC) {
  return (
    !isMac &&
    !!e.ctrlKey &&
    !!e.altKey &&
    !!(e.getModifierState && e.getModifierState('AltGraph'))
  );
}

// ============================================
// Viewport mode (Stream S / ruling #16)
// ============================================
// THE one source of truth for "are we in the narrow (sheet) layout?". The app
// previously compared window.innerWidth to 768 in four different ways across
// 15 files — at exactly 768px modules disagreed which mode they were in. All
// width-mode checks now go through these matchMedia-backed helpers; the FE
// lint gate (tests/test_s_responsive_mechanism.py) bans literal innerWidth
// threshold comparisons anywhere else. The thresholds are the breakpoint
// tokens in static/css/responsive-tokens.css.

const NARROW_QUERY = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(max-width: 768px)') : { matches: false, addEventListener() {} };
const BELOW_MEDIUM_QUERY = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(max-width: 1024px)') : { matches: false, addEventListener() {} };

/** ≤768px — the narrow/sheet boundary (--bp-narrow). */
export function isNarrow() { return NARROW_QUERY.matches; }

/** ≤1024px — below the medium boundary (--bp-medium). */
export function isBelowMedium() { return BELOW_MEDIUM_QUERY.matches; }

/** Subscribe to narrow-mode flips (preferred over per-resize innerWidth reads). */
export function onNarrowChange(fn) {
  NARROW_QUERY.addEventListener('change', fn);
}

// ============================================
// Game freshness (Lane G15)
// ============================================
// THE one dispatcher for `orwell:gamechanged`. The game panels (status HUD,
// social, cast, finale, diary gate, engine banner, decision re-arm) already
// subscribe; what they lacked was a dispatcher at every mutation seam — the
// only inline dispatch was unreachable, so post-action UI waited out a
// 20–30s poll ("the sidebar is behind"). Every FE path that mutates engine
// game state calls this helper instead of dispatching ad hoc.
//
// Trailing debounce (~250ms): one agent turn can advance, record, and decide
// back-to-back, so a burst of tool results coalesces into ONE refresh wave.
// Exposed on window so classic-script surfaces and module code share the same
// seam without import coupling; `detail.reason` (the last trigger) is debug
// breadcrumb only — listeners must not branch on it.
const GAMECHANGED_DEBOUNCE_MS = 250;
let _gameChangedTimer = null;
// M1-3 (audit A3): the seams that KNOW the committed beatSeq (a tool result, the decision
// POST body) pass it as the second arg; the debounce window coalesces to the HIGHEST beat
// seen, and the event detail carries it so a panel can verify its refetch actually caught
// up to the claimed commit (and re-fetch briefly if the read raced the write) instead of
// rendering a stale board beside a fresh ceremony card for a whole poll interval.
let _gameChangedBeat = 0;
// F6 (#1538, #891): the debounce coalesces a burst into ONE event whose `detail.reason`
// is LAST-WINS — so when a routine board refresh (e.g. "tool:recordInteraction",
// "ws:state", "tab-visible") arrives last in the same window, it MASKS an earlier
// ceremony/decision beat (a crown, an eviction) from any listener that picks a cue by
// reason (orwellHaptics.js). We ADDITIONALLY accumulate the SET of reasons seen across
// the debounce window and carry it as `detail.reasons` — additive only: the last-wins
// `detail.reason`, the 250ms debounce, and the coalesced-to-highest `beatSeq` are all
// byte-identical. Listeners that don't care ignore it; haptics reads it to pick the most
// salient beat even when a routine refresh was last. This is NOT a second dispatcher —
// still the ONE `orwell:gamechanged` emitter (test_g15_gamechanged.py).
const _gameChangedReasons = new Set();

export function orwellGameChanged(reason, beatSeq, correction) {
  const b = Number(beatSeq);
  if (Number.isFinite(b) && b > _gameChangedBeat) _gameChangedBeat = b;
  _gameChangedReasons.add(String(reason || ''));
  // #1785 AC3: store the optional correction text for the deferred re-dispatch
  // (the debounce timer may have already started, so we capture it here and
  // re-emit with the correction detail ~100ms after the routine HUD refresh).
  const _correction = (correction && typeof correction === 'string' && correction.trim()) ? correction.trim() : null;
  if (_gameChangedTimer) clearTimeout(_gameChangedTimer);
  _gameChangedTimer = setTimeout(() => {
    _gameChangedTimer = null;
    const beat = _gameChangedBeat;
    _gameChangedBeat = 0;
    const reasons = Array.from(_gameChangedReasons);
    _gameChangedReasons.clear();
    try {
      const detail = { reason: String(reason || ''), beatSeq: beat > 0 ? beat : undefined, reasons };
      // #1785 AC3: post-air correction piggybacks on the SAME event so the
      // diegetic control-room card (orwellDecision.js) picks it up merged
      // with the normal HUD-refresh payload — no second dispatcher.
      const _dc = _correction;
      if (_dc && typeof _dc === 'string' && _dc.trim()) {
        detail.correction = _dc.trim();
      }
      window.dispatchEvent(new CustomEvent('orwell:gamechanged', { detail }));
    } catch (_) { /* fail open — every panel keeps its poll fallback */ }
  }, GAMECHANGED_DEBOUNCE_MS);
}

if (typeof window !== 'undefined') window.orwellGameChanged = orwellGameChanged;

// ============================================
// The mutating-tool manifest (issue #1412 — this half). The set of tools whose
// SUCCESSFUL result should fire `orwell:gamechanged` (a HUD refresh). The chat.js
// tool-result seam consumes this via `window.orwellIsMutatingTool(json.tool)`
// instead of carrying its own hand-coded array — that inline list silently went
// stale whenever a new game-mutating tool got wired (the HUD then lagged a full
// poll period after that tool ran).
//
// DERIVED FROM the engine tool registry `src/surfaces/tools/registry.ts` (the
// mutating subset of PLAYER_TOOLS — the pure reads and the non-HUD FE write-backs
// are excluded — plus the one mutating admin tool `manageSandbox`), and PINNED to
// it by the drift-guard `frontend/tests/test_1412_mutating_manifest.py`: that test
// reads the registry, classifies every tool, and asserts THIS array equals the
// registry's mutating set EXACTLY (no missing, no extra). So a newly-wired mutating
// tool fails that test until it is added here — the HUD stays fresh by construction,
// not by hope. (Membership in `INFRA_LEVERS` does NOT decide this: `recordImageBeat`
// is an infra lever that IS mutating; `recordCastProfile` is an infra lever that is
// NOT — hence the classification is explicit, see the drift-guard.)
//
// This adds NO second dispatcher: `orwellGameChanged` above stays the ONE
// `orwell:gamechanged` emitter (test_g15_gamechanged.py). This manifest only feeds
// that dispatcher's "does this tool warrant a refresh?" decision.
export const ORWELL_MUTATING_TOOLS = Object.freeze([
  // Weekly-loop progression + the player's binding decisions.
  'advanceGame', 'submitDecision',
  // E-1: a watching evictee re-opens the skip-or-watch card (moves the pending card the HUD reads).
  'raiseSpectatorChoice',
  // Casting / character lifecycle.
  'updateCasting', 'createCharacter',
  // Consequence loop + the single competition authority (all move the board the HUD reads).
  'recordInteraction', 'runCompetition', 'surfaceInformationTo', 'diaryRoom', 'recordImageBeat',
  // Presence & movement (0049 / ADR 0009), premiere meet-everyone (#380), the bedtime lever (ADR 0006).
  'moveTo', 'moveHouseguest', 'markHouseguestMet', 'turnIn', 'hangOut',
  // Per-message clock (P0a): announcing a player message steps the in-game clock the HUD reads.
  'noteMessage',
  // Deals & alliances (0039 / 0107).
  'makeDeal', 'formAlliance', 'joinAlliance',
  // The jury house Q&A (0129): a juror's telling lands in the player's knowledge (Journal).
  'askJuror',
  // Secrets-as-power + gossip / pre-show-tie levers (0093 / 0094 / 0095 / 0099).
  'exposeSecret', 'tradeSecret', 'confront', 'accuseTie',
  // The one mutating ADMIN tool in the HUD set — sandbox lifecycle (create | reset | save | load).
  'manageSandbox',
]);

const _ORWELL_MUTATING_SET = new Set(ORWELL_MUTATING_TOOLS);

// The lookup chat.js's tool-result seam calls in place of its old inline array.
export function orwellIsMutatingTool(name) { return _ORWELL_MUTATING_SET.has(name); }

if (typeof window !== 'undefined') {
  window.ORWELL_MUTATING_TOOLS = ORWELL_MUTATING_TOOLS;
  window.orwellIsMutatingTool = orwellIsMutatingTool;
}

// #570: a backgrounded tab misses cross-device game-updated server pushes (the panels' polls are
// gated on `!document.hidden`, and the server-push reconcile may be dropped while hidden), so it
// can sit stale for a whole poll cycle after the user returns. When the tab REGAINS visibility,
// route a reconcile through THE single dispatcher (never an ad-hoc `orwell:gamechanged`) so every
// game panel refreshes immediately — catching up on anything that changed while we were away. The
// helper is debounced + fail-open, and a no-op outside the game build (no panels listening).
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      try { orwellGameChanged('tab-visible'); } catch (_) { /* fail open */ }
    }
  });
}

// ============================================
// WebSocket transport (ADR 0017 / websocket-phase1-protocol.md §4)
// ============================================
// Side-effect import: orwellWs opens the multiplexed socket (flag-gated, fail-soft)
// and hands us its `state`/`hud` DOWN-frames. This module is the ONE place that
// turns a socket "the board changed" edge into a HUD refresh — by calling the ONE
// debounced dispatcher `orwellGameChanged('ws:state')` above (§4). We delete the
// 20/25s poll TIMERS, never the dispatcher: a `state`/`hud` frame is just one MORE
// caller of the single g15 seam (test_g15_gamechanged.py stays green — no ad-hoc
// CustomEvent here). Payloads are pings (ids + beatSeq), never state bodies, so the
// Vault Wall is trivially intact; each HUD re-reads its own Vault-free projection.
import './orwellWs.js';

// Bridge the socket's board-changed edges to the single dispatcher. `state` (status
// changed) and `hud` (presence/whereabouts changed) both mean "re-read your
// projection now" — route both through `orwellGameChanged`, threading the frame's
// beatSeq so a panel can verify its refetch caught the claimed commit (M1-3). Robust
// to load order: register immediately if OrwellWs is present, else on ws-ready.
function _bridgeWsStateFrames() {
  if (!(typeof window !== 'undefined' && window.OrwellWs && typeof window.OrwellWs.onFrame === 'function')) return false;
  const relay = (frame) => {
    const beat = frame && frame.d && typeof frame.d.beatSeq === 'number' ? frame.d.beatSeq : undefined;
    try { orwellGameChanged('ws:state', beat); } catch (_) { /* fail open */ }
  };
  window.OrwellWs.onFrame('state', relay);
  window.OrwellWs.onFrame('hud', relay);
  return true;
}
if (typeof window !== 'undefined' && !_bridgeWsStateFrames()) {
  window.addEventListener('orwell:ws-ready', _bridgeWsStateFrames, { once: true });
}

// ============================================
// Haptics + audio beat channel (issue #745)
// ============================================
// Side-effect import: orwellHaptics self-registers its window listeners and rides
// the `orwell:gamechanged` reason this module dispatches above (crown / noms /
// veto / eviction / decision-confirm) to fire a sub-second vibrate + audio cue.
// Imported HERE — at the dispatcher hub, which is always loaded — so no
// index.html script tag is needed. Vault-free (reads only the public beat
// reason), gated behind a user setting + prefers-reduced-motion, fail-soft.
import './orwellHaptics.js';
