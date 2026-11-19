// Orwell session-detach guard (ship-blocker A6) — "the New Chat hazard".
//
// The logo click, the "New Chat" sidebar row, the icon-rail "+", and the composer's dual-purpose
// Send-as-New-Chat mode are workspace-chrome affordances that make sense for a generic chat app
// (throwaway sessions, cheap to recreate) but are CATASTROPHIC here: a season is stateful,
// long-running, single-instance play — there is no "just re-open it." Left ungated, all four
// silently step the player away from their live, in-progress season with NO confirmation and NO
// obvious way back. This is the sibling of the A2 fabricated-eviction bug: both cost the player
// their game state without their knowledge.
//
// The fix lives HERE as one shared chokepoint (`window._orwellConfirmLeaveGame`) that every
// entry point calls before it detaches: game-build only, Vault-free (reads only the public
// `/api/orwell/state` projection), and fails OPEN in every direction that matters —
//   • outside the game build: always resolves true (the generic chat app's New Chat is untouched);
//   • no live game (pre-game, or the season already reached its post-season hand-off): true,
//     nothing to lose, no dialog;
//   • the confirm UI itself unavailable: true (never trap the player behind a dialog that can't
//     render);
//   • the state fetch fails (engine hiccup): true (never block navigation on a transient network
//     blip — better a rare missed confirmation than a stuck app).
// Concurrent callers (this codebase double-wires a couple of these buttons to the same handler —
// see sidebar-layout.js's + app.js's independent "New Chat" row forwarders) collapse onto the SAME
// in-flight confirm — one dialog, one answer — instead of stacking two modals.
(function () {
  "use strict";

  function gameBuild() {
    return !!(document.body && document.body.hasAttribute("data-game-build"));
  }

  async function jget(url) {
    try {
      const r = await fetch(url, { credentials: "same-origin" });
      return r.ok ? await r.json() : null;
    } catch (_) { return null; }
  }

  // "Live" = a season has started and hasn't reached its terminal hand-off. An evicted-but-
  // not-yet-concluded player (LW10) still has jury/finale stake riding on the game, so that
  // still counts as live — only a fully-finished season (moment === "post-season", or the
  // engine's own `finished` flag) has nothing left to lose by navigating away.
  function isLive(st) {
    return !!(st && st.started === true && !st.finished && st.moment !== "post-season");
  }

  let _pending = null; // in-flight confirm — collapses redundant double-fires onto ONE dialog.

  // ORW-713: the confirm must DO what it says. A new chat cannot detach from a live game (one game =
  // one chat per user, ADR 0008/0012), so the old confirm opened an empty chat still bound to
  // the same season. Now the player's explicit confirm ENDS the season through the ONE sanctioned restart
  // door (POST /api/orwell/reset-progress -> the engine's registry.resetUser hinge; it also unbinds the
  // canonical chat), and a fresh chat opens for the new casting. The old chat stays in the list, readable.
  // Returns a Promise<boolean> — true = safe to proceed with the caller's own new-chat flow (no live game);
  // false = the player stayed, OR the season was ended here and the fresh chat is opened by the restart seam.
  async function endSeasonAndRestart() {
    let r = null;
    try {
      r = await fetch("/api/orwell/reset-progress", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
    } catch (_) { r = null; }
    if (!r || !r.ok) {
      try { window.OrwellReport && window.OrwellReport.fail("session-guard", "end-season", new Error("reset-progress " + (r ? r.status : "unreachable"))); } catch (_) {}
      try { window.uiModule && window.uiModule.showToast && window.uiModule.showToast("Couldn't end your season just now. It is untouched. Try again in a moment."); } catch (_) {}
      return false;
    }
    // Arm the fresh-session split (E65), then open the new chat AFTER this guard settles (the restart seam
    // clicks New Chat, which re-enters the guard; by then the season is over so it passes straight through).
    try { window._orwellMarkRestart && window._orwellMarkRestart(); } catch (_) {}
    try { window.orwellGameChanged && window.orwellGameChanged("reset-progress"); } catch (_) {}
    setTimeout(() => { try { window._orwellFreshSession && window._orwellFreshSession(); } catch (_) {} }, 0);
    return false;
  }

  async function confirmLeaveGame() {
    if (!gameBuild()) return true;
    if (_pending) return _pending;
    _pending = (async () => {
      const st = await jget("/api/orwell/state");
      if (!isLive(st)) return true;
      if (!window.styledConfirm) return true; // no dialog available — never trap the player
      const ok = await window.styledConfirm(
        "End this season and start a new one?\n\nYour season is still in progress. Starting a new one ends it " +
        "for good: it will not be finished, so it will not enter your hall of fame, and you begin again at " +
        "casting. This season's chat stays in your list so you can still read it.",
        { confirmText: "End season, start new", cancelText: "Stay in my season", danger: true }
      );
      if (!ok) return false;
      return endSeasonAndRestart();
    })();
    try {
      return await _pending;
    } catch (_) {
      return true; // fail open on any unexpected error in the check itself
    } finally {
      _pending = null;
    }
  }

  window._orwellConfirmLeaveGame = confirmLeaveGame;
})();
