// orwellPremiereTutorial.js — L31 (FE half): the premiere is a light, hand-held tutorial.
//
// The engine already drives the structured premiere (a built-in introductions round + a gentler
// first-week cadence — L31 engine half, momentPrompts). This is the FE framing: a QUIET, ONE-TIME,
// DISMISSIBLE card that orients a brand-new player to the weekly rhythm the first time they play —
// the player never has to PROMPT for it (ledger L31). It never replaces the chat (the interview /
// premiere happens IN the chat); it just sets expectations beside it.
//
// #642: the guide is a charter member of the OrwellNotice kit (the above-composer affordance
// zone). It composes window.OrwellNoticeKit (kind "guide") for the shared chrome/anchor/dismiss/
// a11y/animation + the ONE stacked container, so it STACKS deterministically beside the decision
// card instead of each minting its own insertBefore(bar). It keeps its OWN richer dismiss
// persistence (the long-standing synced "popup:premiere-tutorial" id, #638) via the kit's
// persistDismiss:false escape hatch + the onDismiss hook — so existing cross-device dismiss data
// is untouched (mirrors the gadget kit's persistCollapsed:false consumer pattern).
//
// Shows ONLY when: the game build is on, a season has started, it is WEEK 1 (the premiere week), and
// the player has not dismissed it before. Per-user dismiss persists (the E71 per-user-key pattern),
// so it appears once per account, not once per session. Reads the same Vault-free /api/orwell/state +
// /status projections the season-progress HUD does; refreshes on `orwell:gamechanged`.
//
// Provenance: docs/audits/2026-06-19-live-debug-issues.md item L31 (structured premiere + tutorial).

(function () {
  "use strict";

  function isGameBuild() {
    return !!(typeof document !== "undefined" && document.body &&
      document.body.hasAttribute("data-game-build"));
  }

  // E71 per-user dismiss key — one account's dismissal never bleeds into another's.
  // Fail-closed (R5/#1416): null when there is no data-user identity, so the local fallback write
  // is skipped rather than written to a shared "" namespace (the synced layout store still carries it).
  function dismissKey() {
    return (window.orwellUserKey && window.orwellUserKey("orwell-premiere-tutorial-dismissed")) || null;
  }
  // #638: the SYNCED layout-store id for this popup's dismiss state (the source of truth that
  // survives reload, crosses devices, and mirrors between two windows). localStorage stays the
  // offline/seed fallback. `_syncedDismissed` is the latest synced value seen this session.
  var POPUP_ID = "popup:premiere-tutorial";
  var _syncedDismissed = false;
  function hasDismissed() {
    if (_syncedDismissed) return true;
    var k = dismissKey();
    if (!k) return false;
    try { return localStorage.getItem(k) === "1"; } catch (_) { return false; }
  }
  function markDismissed() {
    var k = dismissKey();
    if (k) { try { localStorage.setItem(k, "1"); } catch (_) {} }
    // #638: fan the dismiss out as a synced, last-write-wins field via the 0064 layout seam.
    if (!_applyingSynced) {
      try {
        window.dispatchEvent(new CustomEvent("orwell:window-layout",
          { detail: { id: POPUP_ID, state: { dismissed: true } } }));
      } catch (_) {}
    }
  }

  // #638: apply a synced dismiss arriving from the layout store (initial seed OR a peer window) —
  // remember it, write the local fallback (without re-emitting), and close the card live if shown.
  var _applyingSynced = false;
  function applySyncedDismiss() {
    if (_syncedDismissed) { removeTutorial(); return; }
    _syncedDismissed = true;
    _applyingSynced = true;   // suppress the re-emit while WE land a remote/seed dismiss
    try {
      var k = dismissKey();
      if (k) { try { localStorage.setItem(k, "1"); } catch (_) {} }
      var card = document.getElementById("orwell-premiere-tutorial");
      if (card) dismiss();      // mirror the close in this window (no re-emit — guarded)
      else removeTutorial();
    } finally { _applyingSynced = false; }
  }
  function _onSyncedLayout(e) {
    var d = e && e.detail;
    if (!d || d.windowId !== POPUP_ID || !d.state) return;
    if (d.state.dismissed === true) applySyncedDismiss();
  }

  function jgetSafe(url) {
    return fetch(url, { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // The premiere window is the engine's own "premiere" moment (move-in, before the meet-everyone
  // gate lets the first HOH begin) — NOT "week 1". A week stays 1 all the way through the HOH comp,
  // nominations, veto, veto ceremony, and eviction, so gating on `week === 1` left the card mounted
  // through the entire week-1 ceremony chain after the meet-gate had long completed (the corroborated
  // "stale premiere welcome card" finding). `moment` flips off "premiere" the instant the gate
  // completes and the first HOH begins (`momentForPhase`/`GameSessionAdapter.view()`), so keying off
  // it retires the card exactly on gate-complete instead of at the week-2 boundary.
  function isPremiereWeek(status, state) {
    const started = (status && status.started !== false && typeof status.week === "number" && status.week >= 1) ||
                    (state && state.started === true);
    if (!started) return false;
    const moment = (state && state.moment) || "";
    return moment === "premiere";
  }

  function ensureCss() {
    if (document.getElementById("orwell-premiere-tutorial-css")) return;
    const st = document.createElement("style");
    st.id = "orwell-premiere-tutorial-css";
    // #642: the card SHELL (margin/padding/dashed bg+border/radius/the rise+fade entrance) is now
    // the OrwellNotice kit's `.on-card.on-guide`. Only the premiere-SPECIFIC inner rules remain.
    // Theme-token driven (works across every house theme + frost) — no hard-coded colors.
    st.textContent =
      ".orwell-premiere-tutorial .opt-rhythm { font-weight: 600; margin-top: .35rem;" +
      "  color: color-mix(in srgb, var(--fg) 72%, transparent); }" +
      // J2-13: a real affordance to DO the first move (the tutorial named the rhythm but offered no
      // way to act). The CTA seeds the composer with an opener and focuses it — it never sends, so
      // the player stays the author (ADR 0003). Sits in its own action row.
      ".orwell-premiere-tutorial .opt-actions { display: flex; align-items: center; gap: .5rem;" +
      "  flex-wrap: wrap; margin-top: .55rem; }" +
      ".orwell-premiere-tutorial .opt-go { flex-shrink: 0; cursor: pointer;" +
      "  background: color-mix(in srgb, var(--accent, var(--fg)) 16%, transparent);" +
      "  border: 1px solid color-mix(in srgb, var(--accent, var(--fg)) 42%, transparent); color: inherit;" +
      "  border-radius: 8px; font: inherit; font-size: .74rem; font-weight: 600; min-height: 44px;" + // 2.5.5 tap floor
      "  padding: 0 .85rem; }" +
      ".orwell-premiere-tutorial .opt-go:hover, .orwell-premiere-tutorial .opt-go:focus-visible {" +
      "  background: color-mix(in srgb, var(--accent, var(--fg)) 26%, transparent); }";
    document.head.appendChild(st);
  }

  let _mounted = false;
  let _notice = null;   // #642: the OrwellNotice kit instance for this guide.

  function dismiss() {
    markDismissed();
    if (_notice) _notice.hide();   // remove from the stacked zone (we own the dismiss persistence)
    _mounted = false;
  }

  function mount() {
    if (_mounted) return;
    if (!isGameBuild() || hasDismissed()) return;
    if (document.getElementById("orwell-premiere-tutorial")) { _mounted = true; return; }
    // The above-composer affordance zone is owned by the OrwellNotice kit; with the kit absent,
    // fail-soft (no guide rather than a hand-rolled fallback).
    if (!window.OrwellNoticeKit) return;
    // Need the composer anchor to exist (the kit anchors the zone above .chat-input-bar).
    const bar = document.querySelector(".chat-input-bar");
    if (!bar || !bar.parentNode) return;
    ensureCss();

    // Compose the kit (kind "guide"). persistDismiss:false — the premiere keeps its OWN richer
    // synced "popup:premiere-tutorial" dismiss (#638, cross-device); the kit just supplies the
    // chrome/anchor/animation/a11y. The legacy id + class are kept so existing selectors/tests
    // and the per-premiere CSS above still apply.
    _notice = window.OrwellNoticeKit.create({
      id: "orwell-premiere-tutorial",
      kind: "guide",
      title: "Welcome to the house — premiere week",
      dismissible: true,
      persistDismiss: false,        // the premiere owns its own (synced) dismiss persistence
      onDismiss: function () { dismiss(); },
    });
    const body = _notice.ensure();   // mounts into the stacked zone; returns the .on-body
    const card = _notice.el;
    if (!card) return;
    card.classList.add("orwell-premiere-tutorial");   // keep the legacy hook class for inner CSS
    // J2-12: announce on insert without stealing focus (the kit already sets aria-live=polite for
    // the guide kind — non-intrusive note per ADR 0003).
    // 0111 (Pillar 3, owner ruling 2026-07-14 — THE CHAMPAGNE CIRCLE): the producers gather the whole
    // house for a champagne toast, so you meet the houseguests as they arrive (ORW-148: one at a time, then the toast) — then the first HOH is a
    // breath away. And (Pillar 5, #907) the Diary Room is introduced as an enterable room from day one.
    body.innerHTML =
      '<div>The houseguests arrive one at a time — you\'ll meet all fifteen houseguests as they walk in, ' +
      'and the producers cap the night with a champagne toast. Then talk to anyone and wander any room; ' +
      'the house keeps playing around you, and the first HOH is a breath away.</div>' +
      '<div>The <strong>Diary Room</strong> is open from day one — step in whenever you want to vent. ' +
      'Nobody in the house hears it.</div>' +
      '<div class="opt-rhythm">' +
        '<span aria-hidden="true">\u{1F3C6}</span> HOH → ' +
        '<span aria-hidden="true">\u{1F528}</span> Nominations → ' +
        '<span aria-hidden="true">\u{1F48E}</span> Veto → ' +
        '<span aria-hidden="true">\u{1F5F3}️</span> Eviction.' +
      '</div>' +
      // J2-13: an affordance to DO the first move (close the gulf-of-execution).
      '<div class="opt-actions">' +
        '<button type="button" class="ow-btn ow-btn-secondary opt-go" aria-label="Say hello — fills the message box with an opener">Say hello \u{2192}</button>' +
      '</div>';
    _mounted = true;
    var go = body.querySelector(".opt-go");
    if (go) go.addEventListener("click", function () { firstMove(); });
  }

  // J2-13: seed the composer with a gentle opener and focus it — the player stays the author
  // (ADR 0003: never send for them). Fail-soft if the composer isn't present. The card is left
  // up (the rhythm guide is still useful) but we put the cursor where the next move happens.
  function firstMove() {
    var input = document.getElementById("message");
    if (!input) return;
    // Only seed an EMPTY composer — never clobber a draft the player has already started.
    if (!input.value || !input.value.trim()) {
      input.value = "I look around as the first houseguests arrive and start taking in the house.";
      // Let the composer's own autosize / draft-save seams react to the change.
      try { input.dispatchEvent(new Event("input", { bubbles: true })); } catch (_) {}
    }
    try { input.focus(); } catch (_) {}
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
  }

  // J5-16 (J4-27): the card is content-gated to week 1 but was only ever MOUNTED — never removed.
  // Once the season advanced it kept rendering its "premiere week" banner all the way to the finale.
  // Actively remove it whenever the game is no longer in the premiere window.
  function removeTutorial() {
    if (_notice) _notice.hide();
    const card = document.getElementById("orwell-premiere-tutorial");
    if (card) card.remove();
    _mounted = false;
  }

  async function refresh() {
    if (!isGameBuild()) return;
    const status = await jgetSafe("/api/orwell/status");
    const state = await jgetSafe("/api/orwell/state");
    if (isPremiereWeek(status, state)) {
      if (!hasDismissed()) mount();
    } else {
      removeTutorial();
    }
  }

  const ready = (fn) =>
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", fn, { once: true })
      : fn();

  if (typeof window !== "undefined") {
    ready(refresh);
    window.addEventListener("orwell:gamechanged", refresh);
    // #638: the synced dismiss seam (initial GET /layout seed + a peer window / device).
    window.addEventListener("orwell:layout-seed", _onSyncedLayout);
    window.addEventListener("orwell:layout-changed", _onSyncedLayout);
    // A new season resets the per-user gate only if the player un-dismissed; otherwise stays retired.
    window.addEventListener("orwell:gamechanged", function () { _mounted = false; });
    // Test/debug seam for the headless gate.
    window._orwellPremiereTutorial = { refresh: refresh, isPremiereWeek: isPremiereWeek };
  }
})();
