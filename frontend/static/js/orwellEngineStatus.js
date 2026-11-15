// Orwell engine-status banner — VISIBLE error reporting when the game engine has a problem.
// The in-character "live feeds are down" chat line keeps players in the show, but the operator (and
// a confused player) needs an honest, out-of-character signal that something is actually broken. This
// is that signal: a top-of-viewport banner driven by /api/orwell/health with two severities:
//   • RED   — the engine is unreachable (connection refused / timeout / wrong URL);
//   • AMBER — the engine is up but a recent tool call FAILED (`lastError`: a technical problem like a
//     corrupt-save 500 or a failing action). The player sees ONE production-voiced line either way;
//     the raw tool name + backend error (the actionable operator detail) goes to console + OrwellReport
//     (the /admin/status failure ring), never into the player-visible banner body (MICRO-14/15).
// Fail-open (if its own fetch fails, it shows the warning), no deps beyond the notice kit.
//
// #642 (owner add-on): the banner is a first-class OrwellNotice kit consumer — a "system-notice"
// kind at the "top-banner" placement, so it shares the kit's chrome, ONE dismiss affordance (the
// 44px .on-dismiss), role/aria-live=alert semantics, reduced-motion-safe slide-in, and the
// body-inset compensation (now kit-owned: --on-banner-inset). It KEEPS its top-anchored,
// full-width placement (a global outage signal, not an above-composer affordance) and the
// dismissed-key behaviour (re-show only when the message changes; reset on healthy). The G8
// busy/creating hold + the reconnecting/holding variants are unchanged.
(function () {
  "use strict";

  const POLL_MS = 15000;
  const NOTICE_ID = "orwell-engine-status";
  const ready = (fn) =>
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", fn, { once: true })
      : fn();

  let timer = null;
  let dismissedKey = null; // the exact message the user dismissed — reshow only if it changes
  let _notice = null;      // the OrwellNotice kit instance (lazily created on first show)

  // Lazily create the kit notice (top-banner system-notice). Fail-open: with the kit absent the
  // module simply does nothing (no banner) rather than throwing.
  function ensureNotice() {
    if (_notice) return _notice;
    if (!window.OrwellNoticeKit) return null;
    _notice = window.OrwellNoticeKit.create({
      id: NOTICE_ID,
      kind: "system-notice",
      placement: "top-banner",
      severity: "error",
      role: "alert",                 // preserve the assertive announcement
      title: "",
      // NOT dismissible: this is an honest outage signal, never a "wave it away" affordance. It
      // already auto-hides the moment the engine reports healthy (see hide()), so a manual × would
      // only let a confused player bury a real problem. The dismissed-key plumbing below is now
      // inert (nothing sets dismissedKey), kept only so show()/hide() read uniformly.
      dismissible: false,
      persistDismiss: false,
      // M1-7 (audit t-3): OVERLAY, never reflow — the degraded slab used to push the whole
      // app down on every show/hide (body padding-top), a layout thrash exactly when the
      // player is already watching an outage. It floats over the chat top instead; the
      // banner is transient and the chat's first line returning beats the whole app jumping.
      reflow: false,
    });
    return _notice;
  }

  let _lastReason = "";

  // MICRO-14/15/16 — the outage copy stays an HONEST signal but in ONE production voice: no bare
  // "engine"/"app"/"game service" nouns (register break, I9), and NEVER a raw tool name or backend
  // error string in the player-visible body (the sharpest leak — a `recordInteraction: <stack>` in a
  // top-of-viewport banner). The raw detail still reaches the OPERATOR via console + OrwellReport (the
  // G11 failure ring / /admin/status), just never the player's screen. One shared line so the two
  // widgets that voice an outage (this banner + the House Status gadget) can't drift.
  const _OUTAGE_TITLE = "Big Brother is off the air.";
  const _OUTAGE_BODY = "We've lost the live feeds — the show comes back the moment the connection does.";
  const _DEGRADED_TITLE = "Big Brother's having a technical moment.";
  const _DEGRADED_BODY = "Production's on it — hang tight.";
  // AXE-6: a browser-offline event is NOT a production-side outage — reusing the
  // _OUTAGE_* copy told the player "the show is down" when the real, actionable fact is
  // "your own connection dropped." Distinct, correctly-scoped copy for that case.
  const _OFFLINE_TITLE = "Your connection dropped.";
  const _OFFLINE_BODY = "That one's on your end, not the show's — we'll reconnect the moment you're back online.";

  function show(kind, title, reason) {
    if (dismissedKey && dismissedKey === reason) return; // already waved off this exact problem
    const n = ensureNotice();
    if (!n) return;
    _lastReason = reason;
    const severity = kind === "down" ? "error" : "warn";
    // #763: pass the icon EXPLICITLY through the kit's `icon` channel (a semantic key from the
    // kit's ONE monochrome set — never a glyph baked into the title). "down" reads as a hard
    // error, a "degraded"/reconnecting state as a warning — the same mono SVG family every other
    // notice/banner uses, so BOTH engine-status banners share ONE icon language (no colour-emoji
    // beside a mono symbol). The title strings stay glyph-free text. (Passing it explicitly rather
    // than leaning on the system-notice severity auto-derive makes the kit's `icon` slot the single,
    // legible source of the banner icon — consistent with the dock / #764 notice icons.)
    const icon = kind === "down" ? "error" : "warn";
    // Mount (idempotent) then re-skin in place — a state transition (down → reconnecting) reuses
    // the same element (no flicker) and re-measures the body inset for the new copy.
    n.show();
    n.update({ severity: severity, icon: icon, title: title, body: reason });
  }
  function hide() {
    dismissedKey = null; // healthy again — a future problem should always reshow
    if (_notice) _notice.hide();
  }

  // #764/#763: titles carry NO baked-in glyph anymore — the icon flows through the OrwellNotice
  // kit's dedicated `icon` channel (a monochrome SVG glyph rendered into .on-icon), so engine-status
  // shares ONE icon language with every other notice/banner (the old satellite/warning/clapperboard
  // emoji baked into the title string mixed colour emoji with the kit's mono symbols). #763 makes
  // that icon EXPLICIT (a semantic key per kind: error=down, warn=degraded) rather than implicit via
  // the system-notice severity auto-derive — the kit's `icon` slot is the single legible source.

  // G8: while createCharacter is in flight (health reports busy:"creating"), a slow or even
  // timed-out engine probe is casting being finalized — NOT an outage. Hold in-fiction (amber),
  // never the red "engine unavailable" banner.
  function showHolding() {
    show("degraded", "Production is building the house…", "Casting is being finalized — the live feeds return in a moment.");
  }

  // Issue 1: a brief, transient outage is being retried — show a SOFT amber "reconnecting…"
  // line (it recovers on its own) instead of the hard red "engine unavailable".
  function showReconnecting() {
    show("degraded", "Reconnecting to Big Brother…", "The live feeds blinked — restoring the connection.");
  }

  // AXE-6: true when the BROWSER itself reports no network, distinct from the engine being
  // unreachable while the player's own connection is fine. Checked defensively (some
  // embedders / very old browsers don't expose navigator.onLine) — absence never blocks
  // the existing outage path.
  function _isOffline() {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }

  async function refresh() {
    if (_isOffline()) { show("down", _OFFLINE_TITLE, _OFFLINE_BODY); return; }
    try {
      const r = await fetch("/api/orwell/health", { credentials: "same-origin" });
      if (!r.ok) { show("down", _OUTAGE_TITLE, _OUTAGE_BODY); return; }
      const d = await r.json();
      const busy = !!(d && d.busy === "creating"); // G8: createCharacter in flight
      const reconnecting = !!(d && d.reconnecting); // Issue 1: transient outage being retried
      if (!d || !d.engine) {
        if (busy) { showHolding(); return; } // a probe timeout DURING creation is not an outage
        if (reconnecting) { showReconnecting(); return; } // a momentary blip — recovering, not down
        // MICRO-14/15: one production-voiced outage line — never the raw d.error/engineUrl in the
        // player banner. The operator's actionable detail already rides the engine's own /admin/status
        // health payload (this banner just mirrors that health poll), so it is not re-beaconed here —
        // and the g11 failure ring is reserved for the fail-open CATCH below, per its contract.
        show("down", _OUTAGE_TITLE, _OUTAGE_BODY);
      } else if ((d.lastError && d.lastError.error) || d.integrityRefusal) { // ORW-321: a standing integrity-checkpoint refusal is the same honest 'degraded' signal
        if (busy) { showHolding(); return; } // mid-creation hiccups hold in-fiction too
        // Engine reachable, but a recent call failed — an honest signal in one production voice; the raw
        // tool name + backend error string (MICRO-15) never reach the player banner (they remain on the
        // engine health payload / /admin/status for the operator).
        show("degraded", _DEGRADED_TITLE, _DEGRADED_BODY);
      } else {
        hide();
      }
    } catch (_) {
      // AXE-6: connectivity can drop mid-request — re-check here, not just up front.
      if (_isOffline()) { show("down", _OFFLINE_TITLE, _OFFLINE_BODY); return; }
      // The FE route itself failed — surface the most likely truth rather than going silent.
      if (window.OrwellReport) window.OrwellReport.fail("engine-status", "health-fetch", _); // G11: fail open, never silent
      show("down", _OUTAGE_TITLE, _OUTAGE_BODY);
    }
  }

  function start() {
    refresh();
    if (timer) clearInterval(timer);
    timer = setInterval(refresh, POLL_MS);
  }

  window.orwellRefreshEngineStatus = refresh;
  window.addEventListener("orwell:gamechanged", refresh);
  // AXE-6: react immediately to the browser's own connectivity signal rather than waiting
  // for the next 15s poll — 'offline' shows the correctly-scoped banner right away, 'online'
  // re-probes so a real recovery (or a genuine engine outage underneath) is caught fast.
  window.addEventListener("offline", () => show("down", _OFFLINE_TITLE, _OFFLINE_BODY));
  window.addEventListener("online", refresh);
  ready(start);
})();
