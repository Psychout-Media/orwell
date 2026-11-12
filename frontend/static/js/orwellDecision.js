// Orwell decision guardrail (C20 / audit U1+U2) — confirm-on-binding, per ADR 0003.
//
// NOT a decision-card dashboard: play stays in conversation. This is the light guardrail on
// the COMMITMENT — when the engine pauses the loop on a pending player decision, a small card
// presents the engine's own prompt + LEGAL options, enforces the pick count, and requires one
// explicit Confirm. The confirmed selection posts ENGINE-DIRECT (POST /api/orwell/decision →
// submitDecision), so a hedge in prose can never bind through this surface; the engine still
// validates legality and stays idempotent. Dismissing the card (×) is always allowed — the
// player may instead talk it out with the game master, which drives the same validated seam.
//
// #642: the decision card is the CHARTER member of the OrwellNotice kit (the above-composer
// affordance zone). It composes window.OrwellNoticeKit (kind "decision") for the shared
// anchor — it now mounts into the ONE stacked notice zone above the composer, so it STACKS
// deterministically beside the game guide (the decision sits closest to the composer) instead
// of scrolling inside #chat-history and fighting for the slot. It keeps its OWN rich internals
// (legal options, pick-count, the binding Confirm, the J5-20 risk skin, the per-signature
// dismiss + the boot/poll rearm) — the kit owns only the anchor; the decision is a HARD-STOP
// affordance (dismissible, NEVER auto-dismissed). The kit's own corner × is suppressed
// (dismissible:false) — the card renders its OWN .odec-x with the existing dismiss semantics.
//
// Input: chat.js dispatches `orwell:pending` with {pending} parsed from advanceGame /
// submitDecision tool results (Vault-free PendingDecisionView: kind, prompt, options[],
// appeals?, juror?, pick). Vault-free by construction; fail-open everywhere.
(function () {
  "use strict";

  const CARD_ID = "orwell-decision-card";

  // PendingDecisionView.kind → the SubmitDecisionReq wire field carrying the pick.
  // Mirrors GameSessionAdapter.toDecisionInput: `vote` carries every single-pick kind
  // except `replacement`; `choice` carries the nominations pair.
  const SINGLE_PICK_FIELD = {
    "houseguests-choice": "vote",
    "eviction-vote": "vote",
    "tie-break": "vote",
    "final-eviction": "vote",
    "juror-vote": "vote",
    "goodbye-message": "vote", // E34: the chosen tone rides `vote` (options are the tones)
    "exit-interview": "vote", // 0130: the chosen exit stance rides `vote` (options are the stances)
    "spectator-choice": "vote", // 0133: the chosen spectator mode (watch | skip) rides `vote` (options are the two modes)
    "finale-interview": "vote", // 0133: the finale-night interview posture rides `vote` (like the exit interview)
    "deal-offer": "vote", // 0123: accept/decline of an NPC's floated deal rides `vote` (options are the two)
    "replacement": "replacement",
  };
  const COMP_INTENTS = ["compete", "throw", "play-safe"];

  // J5-20: the genuinely high-stakes, irreversible decision kinds — evicting someone, naming
  // nominees, crowning the winner. These bind a person's fate (theirs or the player's game),
  // so the card must carry a RISK signal that a low-stakes comp-intent/comp-round must NOT —
  // those only set how the player plays a comp, and never end anyone's game. Driven off this
  // single set so "which kinds are weighty" lives in one place (matches SINGLE_PICK_FIELD's
  // role as the canonical kind→behavior map).
  const HIGH_STAKES_KINDS = new Set([
    "eviction-vote",
    "final-eviction",
    "juror-vote",
    "nominations",
    // A veto replacement nominee is permanent (the named houseguest is on the block for
    // eviction day with no further appeal) and a HOH tie-break evicts someone outright — both
    // end a houseguest's game just like the four above, so they get the same risk skin.
    "replacement",
    "tie-break",
    // INT-7/CA-15: "Don't use the veto" is the single highest-leverage, irrevocable choice of
    // the week for a first-time HOH/veto-holder — it locks the current two nominees in place
    // with no walk-back, and is a precondition for every high-stakes kind downstream (the
    // ceremony's own body copy already says "locked in and plays out" with no matching badge).
    "veto-decision",
    // 0025: the secret veto is one-time and decides whether the player stays on the block.
    "secret-veto",
  ]);
  const isHighStakes = (kind) => HIGH_STAKES_KINDS.has(kind);

  // N-12: a decision submit must NEVER hang forever on "Locking in...". Bound it (the idempotency key makes a retry a verbatim replay).
  const _DECISION_SUBMIT_TIMEOUT_MS = 30000;
  const _submitTimeoutMs = () => (typeof window.__orwellDecisionTimeoutMs === "number" && window.__orwellDecisionTimeoutMs > 0)
    ? window.__orwellDecisionTimeoutMs : _DECISION_SUBMIT_TIMEOUT_MS;
  /** Race a promise against a timer; rejects with {timedOut:true}. The timer is always cleared. */
  function _withTimeout(promise, ms, onTimeout) {
    let timer;
    const t = new Promise((_res, rej) => {
      // Reject FIRST, then abort: the abort's own AbortError must not win the race and hide that this was a timeout.
      timer = setTimeout(() => { rej(Object.assign(new Error("decision-submit-timeout"), { timedOut: true })); try { if (onTimeout) onTimeout(); } catch (_) {} }, ms);
    });
    return Promise.race([promise, t]).finally(() => clearTimeout(timer));
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // J5-06: a confirmed card schedules its own 4s self-removal. Track that timer so a NEW card
  // arming within the window cancels it — otherwise the stale timer fires removeCard() and yanks
  // the freshly-armed (live, unconfirmed) next decision card out from under the player (TRANS-4).
  let _doneTimer = null;
  let _notice = null;   // #642: the OrwellNotice kit instance hosting the card (the zone anchor).
  let _sheet = null;    // #753: the OrwellSheet (anchored, non-blocking action-sheet) hosting the card.
  function removeCard() {
    if (_doneTimer) { clearTimeout(_doneTimer); _doneTimer = null; }
    // #753: prefer the sheet host (the non-blocking action-sheet) when present; fall back to the
    // OrwellNotice host (the pre-#753 anchor) so a card mounted via either path tears down cleanly.
    if (_sheet) { try { _sheet.dismiss("api"); } catch (_) {} _sheet = null; }
    if (_notice) { try { _notice.hide(); } catch (_) {} _notice = null; }
    const old = document.getElementById(CARD_ID);
    if (old) old.remove();
  }

  // API-2: on a 409 (the board moved since this card armed), the old copy CLAIMED "refreshing
  // the latest state" but nothing ever refreshed — the same stale options/selection just sat
  // there disabled-then-re-enabled, wedged until the player noticed and manually dismissed it.
  // Actively re-fetch the engine's own current pending and either replace the stale card with
  // the fresh one immediately, or (no fresh pending) remove it outright so the 2.5s backstop poll
  // (below) can re-arm the real thing — never leave a card up that lies about refreshing.
  async function _recoverFrom409() {
    try {
      const r = await fetch("/api/orwell/status", { credentials: "same-origin" });
      if (!r.ok) return;
      const st = await r.json();
      const fresh = st && st.pending && st.pending.kind ? st.pending : null;
      removeCard();
      if (fresh) window.dispatchEvent(new CustomEvent("orwell:pending", { detail: { pending: fresh } }));
    } catch (_) { /* fail open — the 2.5s backstop poll still recovers it */ }
  }

  // M3-4 (road-to-market, pairs with M1-4/M2-2): a lightweight roster-portrait cache so a
  // houseguest option carries their REAL persisted portrait when one exists — the designed
  // monogram (M2-2) is the fallback, never the only face. Reads ONLY the public roster route
  // (id/name/status/portrait — the same public projection every cast surface already renders);
  // Vault-free by construction. Best-effort/fail-open: an unfetched or failed cache simply
  // leaves every option on the monogram fallback (the sanctioned default), and self-heals on
  // the next refresh — it NEVER blocks or delays the card (a binding decision must always
  // reach the player immediately).
  let _portraitById = Object.create(null);
  let _rosterFetchedAt = 0;
  async function _refreshRosterCache(force) {
    const now = Date.now();
    if (!force && now - _rosterFetchedAt < 8000) return; // /roster is already polled elsewhere too
    _rosterFetchedAt = now;
    try {
      const r = await fetch("/api/orwell/roster", { credentials: "same-origin" });
      if (!r.ok) return;
      const data = await r.json();
      const roster = Array.isArray(data && data.roster) ? data.roster : [];
      const map = Object.create(null);
      for (const hg of roster) {
        if (hg && hg.id != null) map[String(hg.id)] = { portrait: hg.portrait || null, status: hg.status || "active" };
      }
      _portraitById = map;
    } catch (_) { /* fail open — every option renders the monogram fallback */ }
  }
  // Boot side-effects run only in the APP SHELL. The element-kit demo page loads this module
  // purely for ensureStyles() — there, a roster fetch is pointless network noise and the
  // backstop below would arm a timer with nothing to poll. The shell probe mirrors render()'s
  // own boot-readiness signals (#chat-history / .chat-input-bar).
  const _inAppShell = !!(document.getElementById("chat-history") || document.querySelector(".chat-input-bar"));
  if (_inAppShell) {
    _refreshRosterCache(true);
    window.addEventListener("orwell:gamechanged", () => _refreshRosterCache(true));
  }

  // The injected structural CSS is scoped to the root CLASS `.odec` (render() adds it beside
  // the element id) — NOT to `#orwell-decision-card` — so any card composing the kit's classes
  // (the live card, the element-kit demo's reference cards) is styled identically. The element
  // ID stays `orwell-decision-card` (many tests/registries + the FAB/scroll suppressions pin it);
  // only the CSS scope is class-based. Exposed as window.OrwellDecisionStyles.ensureStyles for the
  // kit demo page (element_kit_demo.html), which composes the classes statically.
  function ensureStyles() {
    if (document.getElementById("orwell-decision-css")) return;
    const st = document.createElement("style");
    st.id = "orwell-decision-css";
    st.textContent = `
      .odec {
        position: relative; /* J5-21: anchors the absolutely-positioned dismiss × in the corner */
        margin: .6rem auto; max-width: 640px; border-radius: 12px; padding: .8rem .9rem;
        background: var(--panel, #111); color: var(--fg, #9cdef2);
        border: 1px solid var(--accent, var(--red, #e06c75));
        /* Shared type system (#709): sans family + body PRESET. */
        font-family: var(--ow-ui-font); font-size: var(--ow-fs-body, .875rem); line-height: 1.5;
        /* J5-03: figure/ground — the binding card must lift off the chat stream like every
           OrwellWindow does. Reuse the kit's shadow token (it is the only interactive surface
           that was missing it). */
        box-shadow: var(--win-shadow, 0 8px 32px rgba(0, 0, 0, 0.45));
        /* J5-05: a brief entrance + a transition on the done-state dim, so a binding decision
           neither pops in nor flips to "✓ Locked in" as a silent text swap. */
        animation: odec-in .18s ease-out;
        transition: opacity .2s ease, border-color .2s ease;
      }
      @keyframes odec-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) { .odec { animation: none; transition: none; } }
      /* #642: hosted in the OrwellNotice kit card (.on-card.on-decision owns the lift/border/
         radius/anchor), the decision card goes FLAT — drop its own margin/max-width/shadow/
         border/animation so it fills the kit body (no double chrome, no squeezed note column). */
      .on-card.on-decision .odec {
        margin: 0; max-width: none; box-shadow: none; border: none; padding: 0;
        background: transparent; animation: none;
      }
      /* #753: hosted in the OrwellSheet anchored action-sheet (.ow-sheet-anchored owns the
         grabber/accent-rim/glass/anchor), the decision card goes FLAT exactly as in the notice
         host — drop its own margin/max-width/shadow/border/animation/bg so the sheet provides the
         one chrome (no double frame, no squeezed note column). */
      .ow-sheet.ow-sheet-anchored .odec {
        margin: 0; max-width: none; box-shadow: none; border: none; padding: 0;
        background: transparent; animation: none;
      }
      /* Under the glass theme the inner card must stay transparent (the sheet IS the glass) so it
         never double-glasses — mirrors the .on-card.on-decision frosted rule below. (The .odec-risk
         selector is listed FIRST so the j5_20 token-tint regex never matches this transparent rule.) */
      body.theme-frosted .ow-sheet.ow-sheet-anchored .odec.odec-risk,
      body.theme-frosted .ow-sheet.ow-sheet-anchored .odec {
        background-color: transparent; background-image: none;
        -webkit-backdrop-filter: none; backdrop-filter: none; box-shadow: none;
      }
      /* Apple Genius rendered-pixel-parity (2026-07-16): the head row had NO reserved gutter for
         the absolutely-positioned × (below), so a comp-intent card's longer title ("Competition
         round — set your approach") could run its full width UNDER the × footprint — at the
         real render width the title (and, once it wrapped, its second line) visually collided
         with the corner control, reading as if the × had drifted down into the prose instead of
         sitting cleanly in the corner. Reserve a gutter matching the ×'s footprint (right offset
         .35rem + 44px hit target, below) on the row itself, so BOTH the title and the risk badge
         (which also lives in this row) shrink-wrap clear of the × at every width — never overlap. */
      .odec .odec-head { display: flex; align-items: baseline; gap: .5rem; padding-right: 3rem; }
      .odec .odec-title { font-size: var(--ow-fs-title, .875rem); font-weight: var(--ow-fw-semibold, 600); letter-spacing: -.01em; flex: 1; }
      /* J5-21: the dismiss × stays visually in the top-right corner (absolute), but is moved to the
         END of the card's DOM so it is the LAST thing a keyboard user Tabs to — the decision options
         and Confirm come first (WCAG 2.4.3 focus order: a binding-decision surface must not put
         "skip this" ahead of the actual choice). Visual position is unchanged; only tab order moves.
         The 44×44 tap target + descriptive aria-label are preserved below. z-index keeps it above
         the head row's text at any width (belt-and-suspenders alongside the .odec-head gutter). */
      .odec .odec-x { position: absolute; top: .35rem; right: .35rem; z-index: 1; cursor: pointer; border: none; color: #16191f; background: radial-gradient(circle, rgba(255,255,255,.82) 0 12px, transparent 13px); opacity: .85; font-size: 1rem; min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; }
      /* a11y (coordinator, A-15 matrix): the × used to INHERIT the card's ink — dark #16191f pinned for the
         light kit glass — but on the exit-interview / "You have been evicted" cards the surface behind it
         measured rgb(33,58,72): dark-on-dark, 1.48:1. The control now carries its OWN light backing disc
         behind a dark glyph, so its contrast (≈9:1 on the composite) no longer depends on which host surface
         the card lands on — the polarity can't drift again (same class as #1916 / #1644). */
      .odec .odec-x:hover { opacity: 1; }
      /* J5-20: a high-stakes, irreversible decision (eviction/noms/jury vote) wears a risk skin —
         an eviction-red border + a faint red wash so it never reads as a low-stakes comp chip. The
         tint is token-driven (--color-error / --red across the house themes). Color is NEVER the
         only signal: the .odec-risk-badge below carries the same "binding / irreversible" meaning in
         text + an icon for colorblind + SR users (the badge is what AT announces). */
      .odec.odec-risk {
        border-color: var(--color-error, var(--red, #e06c75));
        background:
          linear-gradient(0deg, color-mix(in srgb, var(--color-error, var(--red, #e06c75)) 9%, transparent), color-mix(in srgb, var(--color-error, var(--red, #e06c75)) 9%, transparent)),
          var(--panel, #111);
      }
      /* #775: a SELECTED option on a risk (irreversible) card keeps the eviction-RED fill — the
         stakes signal. !important so it wins over the style.css frosted selected-pill override
         (the kit-migration's neutral selected state) on the glass tiers too. */
      .odec.odec-risk .odec-opt[aria-pressed="true"] { border-color: var(--color-error, var(--red, #e06c75)) !important; background: var(--color-error, var(--red, #e06c75)) !important; color: var(--on-accent, #fff) !important; box-shadow: inset 0 1px 0 rgba(255,255,255,0.25) !important; }
      .odec.odec-risk .odec-confirm { background: var(--color-error, var(--red, #e06c75)); }
      .odec .odec-risk-badge {
        display: inline-flex; align-items: center; gap: .3rem; margin-left: .4rem;
        /* #651: .68rem sat BELOW the --fs-2xs text floor once the fluid root shrinks at the
           phone tiers (10.3px at tiny-320) — caught by the widened crowding sweep. The --fs-xs
           caption token clears the floor at every tier. */
        padding: .08rem .45rem; border-radius: 999px; font-size: var(--fs-xs, .75rem); font-weight: 700;
        letter-spacing: .04em; text-transform: uppercase; white-space: nowrap;
        /* #1644 (rendered audit §2.2): the raw error HUE as small-caps TEXT on a faint 12% tint
           measured ~2.7:1 on a LIGHT flat theme (red-on-light-red), and the flat presets carry no
           polarity class to scope a light-only ink fix. HIG "apply colour to the background": make it
           a solid danger PLATE with white ink — white-on-danger-strong reads AA on ANY surrounding
           theme because the fill is opaque. The frosted glass tier keeps its own dark-ink-on-light-red
           override (style.css ~L21190, higher specificity). Colour is never the only signal — the ⚠
           glyph + "Irreversible — binding" text carry it for colourblind/SR users. */
        color: var(--ow-on-danger, #fff);
        border: 1px solid var(--color-danger-strong, #a4262c);
        background: var(--color-danger-strong, #a4262c);
      }
      .odec .odec-prompt { margin: .35rem 0 .55rem; opacity: .9; }
      /* 0006 staged-rounds: the "still in this round" field — the narrowed roster the player reads to adapt. */
      .odec .odec-stillin { margin: 0 0 .55rem; font-size: .82em; opacity: .92; line-height: 1.45; }
      .odec .odec-stillin strong { letter-spacing: .02em; }
      /* WCAG 2.1.1 (Keyboard): the prompt + still-in roster are focusable regions (tabindex=0,
         set in _build) so a keyboard/SR user can read the FULL prompt/roster — which caps to a
         20vh scroll region on short viewports (the media block below) — before confirming a
         binding move. Neutral iOS-blue ring, consistent with the window/gadget kits. */
      .odec .odec-prompt:focus-visible, .odec .odec-stillin:focus-visible {
        outline: 2px solid var(--ow-ios-blue, #0a84ff); outline-offset: 2px; border-radius: 4px;
      }
      .odec .odec-opts { display: flex; flex-wrap: wrap; gap: .4rem; }
      /* #775 element-kit migration (owner request): the decision OPTION chips compose the kit's
         .ow-btn .ow-btn-prominent (a liquid-glass PROMINENT CTA). On the GLASS tiers the kit owns
         the chip chrome (background/border/ink) — so the bespoke chip fill is scoped to the NORMAL
         (non-glass) tier here, and a frosted-tier SELECTED override lives in style.css. The
         layout-only bits (capsule radius, padding, tap floor) stay on both tiers. */
      .odec .odec-opt {
        cursor: pointer; border-radius: 999px; padding: .5rem .8rem; min-height: 44px;
        font: inherit;
        display: inline-flex; align-items: center; gap: .45em; /* M2-2: face + label */
      }
      /* M2-2/M3-4: houseguest options carry the shared designed-monogram-OR-portrait face
         (OrwellMonogram kit) — a person you pick, not an abstract label. A real persisted
         portrait renders when the roster cache has one; the monogram is the fallback. Small,
         round-cornered, never the tap target on its own (the whole chip is the button). */
      .odec .odec-face {
        width: 22px; height: 22px; border-radius: 6px; overflow: hidden; flex: none;
        display: inline-block; pointer-events: none;
      }
      .odec .odec-face .ow-mono-svg, .odec .odec-face img { display: block; width: 100%; height: 100%; }
      /* INT-26/VM-22: a non-binding comp-round's two NON-selected chips — dimmed + inert so
         they read as color-only, never as a live "you could change this" affordance. */
      .odec .odec-opt.odec-opt-inert { cursor: default; opacity: .4; }
      /* Normal-tier (non-glass) chip chrome — the glass tiers take the kit prominent instead. */
      body:not(.theme-frosted) .odec .odec-opt {
        /* J5-04: the plain --border (#355a66) on the chip's translucent fill is ~2.25:1 on the
           dark panel — below WCAG 1.4.11's 3:1 for a UI-component boundary. Mix toward --fg so
           the chip edge is visible (the chip is the ONLY way to make the pick). */
        border: 1px solid color-mix(in srgb, var(--border, #355a66) 55%, var(--fg, #9cdef2)); background: rgba(255,255,255,.05); color: inherit;
      }
      body:not(.theme-frosted) .odec .odec-opt[aria-pressed="true"] { border-color: var(--accent, #e06c75); background: var(--accent, #e06c75); color: var(--on-accent, #fff); }
      .odec textarea {
        width: 100%; min-height: 72px; box-sizing: border-box; margin-top: .2rem;
        background: rgba(255,255,255,.05); color: inherit; border: 1px solid var(--border, #355a66);
        border-radius: 8px; padding: .5rem; font: inherit;
      }
      /* Apple Genius rendered-pixel-parity (2026-07-16): the row (note + Confirm) carried only a
         bare margin-top — the SAME visual weight as every other internal gap on the card — so it
         never read as its OWN "footer" zone; Confirm looked like a loose, floating element beside
         the note rather than a deliberately grouped action bar. Apple form conventions (see e.g.
         Settings/Sheets footers) separate the primary action into a clearly bounded footer: a
         thin top hairline + a touch more breathing room, note/hint LEFT, action RIGHT, baseline-
         aligned. currentColor-derived so the hairline automatically follows whichever ink
         polarity the card's host (bare/flat, the Notice-kit light glass, the anchored sheet)
         already resolves .odec's color to — no theme-specific override needed.
         flex-wrap so the full-width .odec-hint (flex-basis:100%; order:99) drops to
         its OWN line instead of competing for width and crushing .odec-note (the
         description) into a one-word-per-line column. */
      .odec .odec-row {
        display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: .6rem;
        margin-top: .9rem; padding-top: .65rem;
        border-top: 1px solid color-mix(in srgb, currentColor 16%, transparent);
      }
      .odec .odec-confirm {
        cursor: pointer; border: none; border-radius: 8px; padding: .42rem .95rem; font-weight: 700;
        min-height: 44px;
        background: var(--accent, #e06c75); color: var(--on-accent, #fff); font: inherit;
      }
      .odec .odec-confirm:disabled { opacity: .4; cursor: not-allowed; }
      .odec .odec-note { opacity: .80; font-size: var(--ow-fs-body, .875rem); flex: 1; }
      /* J4-20: the disabled-Confirm hint — quiet, italicized, sits beside the button; its hidden
         attribute is toggled in sync() so it shows only while Confirm can't be pressed. */
      /* M1-4 (audit A4): no negative top margin — it pulled the hint's descenders into the card's
         bottom edge, half-clipping "Make your selection above to enable Confirm." at 1440×900. */
      .odec .odec-hint { opacity: .7; font-size: var(--ow-fs-caption, .75rem); font-style: italic; flex-basis: 100%; order: 99; margin-top: 0; line-height: 1.35; }
      .odec .odec-hint[hidden] { display: none; }
      .odec .odec-err { color: var(--color-error, var(--red, #e06c75)); margin-top: .4rem; }
      /* G15: structured field blocks for evictee/finalist/offer */
      .odec .odec-structured { padding: 8px 16px; font-size: 14px; background: rgba(128,128,128,0.08); border-radius: 6px; margin: 4px 16px; line-height: 1.4; }
      .odec .odec-structured strong { font-weight: 600; }
      .odec .odec-offer-kind { font-style: italic; opacity: 0.8; }
      .odec .odec-offer-terms { margin-top: 4px; font-size: 13px; }
      .odec.odec-done { border-color: var(--border, #355a66); opacity: .8; }
      /* Narrow: the note must not squeeze into a thin column beside the button —
         stack it full-width above a full-width Confirm. */
      @media (max-width: 480px) {
        .odec .odec-row { flex-direction: column; align-items: stretch; gap: .5rem; }
        .odec .odec-note { flex: none; order: -1; }
        .odec .odec-confirm { width: 100%; padding: .6rem .95rem; }
      }
      /* M1-4 (audit A4): on a small viewport the PROSE scrolls internally so the option chips +
         the Confirm row always stay reachable — a long ceremony prompt must never push the
         binding control below the fold (the m-1 audit shot: Confirm off-screen on 390×844). */
      @media (max-width: 480px), (max-height: 720px) {
        .odec .odec-prompt, .odec .odec-stillin {
          max-height: 20vh; overflow-y: auto; -webkit-overflow-scrolling: touch;
        }
      }
      /* ── LIQUID GLASS (body.theme-frosted) ──────────────────────────────────────
         The decision card surface must read as the SAME ONE LIGHT GLASS as the rest of the
         family. The common path hosts .odec INSIDE the OrwellNotice kit card
         (.on-card.on-decision), where it goes FLAT (transparent/no chrome) so the glass comes
         from the kit (.on-card, painted the kube LIGHT glass by style.css). In the FALLBACK
         path (no kit → mounted bare into #chat-history) the card carries its OWN solid
         var(--panel) bg, so we glass IT directly here — with the ONE LIGHT GLASS, not a dark
         veil. Owner ruling: "there should be no old dark glass at all"; "the old dark glass
         shouldn't be the frosted fallback". The inline DARK-veil glass that used to live here
         (and made the FROSTED fallback dark) is RETIRED. We also neutralize the .odec-risk
         skin's SOLID var(--panel) wash (the eviction-red MEANING stays in the BORDER), and we
         DELIBERATELY DO NOT touch .odec-confirm — the primary CONFIRM button keeps its
         sanctioned system-blue CTA fill (the one tinted action per view). Applies to BOTH tiers
         (no :not(.glass-full) — the light fill is uniform; Full adds SVG refraction on top via
         liquidGlass.js). Scoped to prefers-reduced-transparency:no-preference so the fallback
         card honors the a11y opaque preference under reduce. */
      @media (prefers-reduced-transparency: no-preference) {
      /* The ONE LIGHT GLASS for BOTH tiers (Full adds SVG refraction on top). */
      body.theme-frosted .odec,
      body.theme-frosted .odec.odec-risk {
        background-color: var(--ow-glass-light-color);
        background-image: var(--ow-glass-light-fill);
        -webkit-backdrop-filter: blur(3px) saturate(180%);
        backdrop-filter: blur(3px) saturate(180%);
        border-radius: var(--ow-glass-radius);
        /* The light-glass rim + soft light shadow (matches style.css's ONE LIGHT GLASS). */
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.65),
          inset 0 0 0 0.5px rgba(255,255,255,0.30),
          0 12px 36px rgba(0,0,0,0.10);
        color: #16191f;
        text-shadow: 0 1px 1px rgba(255,255,255,0.45);
      }
      /* #1644 (a11y contrast): the disabled-Confirm hint must FOLLOW its host surface ink, exactly
         like its sibling text nodes (.odec-title / .odec-note / .odec-prompt) and the chat-bubble
         body (body.theme-frosted .msg-ai .body sets color:inherit). The card mounts in THREE hosts,
         each of which pins .odec's ink polarity for us: the OrwellNotice kit card
         (.on-card.on-decision — LIGHT glass, style.css inks it dark #16191f), the anchored
         OrwellSheet (.ow-sheet — its own cross-faded ink), and the bare #chat-history fallback
         (ambient light --fg over the dark-compositing bottom edge). The earlier #1375-a fix
         hard-coded color:#fff for the bare/sheet dark edge, but the SAME rule also hit the COMMON
         kit path where the light glass stays LIGHT → white-on-light ≈ 1.3:1 (the #1644 BLOCKER).
         inherit inks DARK on the light kit glass and LIGHT on the dark fallback edge — the right
         polarity on every host, no special-casing. text-shadow:inherit carries the host's own
         legibility halo (a LIGHT halo under the dark kit ink, mirroring .msg-ai .body). Scoped
         inside the no-preference block so the reduced-transparency opaque fallback keeps its ink. */
      body.theme-frosted .odec .odec-hint {
        color: inherit;
        opacity: 1;
        text-shadow: inherit;
      }
      /* When hosted inside the kit card the inner decision card stays flat (the kit IS the
         glass) — keep it transparent under theme-frosted so it never double-glasses. */
      body.theme-frosted .on-card.on-decision .odec,
      body.theme-frosted .on-card.on-decision .odec.odec-risk {
        background-color: transparent;
        background-image: none;
        -webkit-backdrop-filter: none;
        backdrop-filter: none;
        box-shadow: none;
      }
      }
      /* SANCTIONED ACCENT — NOTE: the primary Confirm CTA's system-blue fill is owned by
         style.css (body.theme-frosted .odec-confirm → background: var(--ow-ios-blue,#0a84ff)
         !important, the ONE tinted CTA per view). The glass block above scopes to the CARD
         surface only and never names .odec-confirm, so it cannot wash out that CTA — the
         blue stands. We deliberately add NO .odec-confirm rule here (it would only weaken /
         duplicate the static !important system-blue rule). */
    `;
    document.head.appendChild(st);
  }

  // Build the wire payload from the current selection; null = selection incomplete.
  function buildPayload(kind, sel, freeText, useVeto) {
    if (kind === "nominations") return sel.length === 2 ? { kind, choice: sel } : null;
    if (kind === "finale-statement") return { kind, statement: freeText || "" };
    if (kind === "juror-question") return { kind, statement: freeText || "" }; // E37: scoreless free text
    if (kind === "goodbye-message" || kind === "exit-interview" || kind === "finale-interview") {
      // E34/0130: a tone/stance is required; the optional message text rides `statement`.
      return sel.length === 1 ? { kind, vote: sel[0], statement: freeText || "" } : null;
    }
    if (kind === "finale-answer") return sel.length === 1 ? { kind, appeal: sel[0] } : null;
    if (kind === "comp-intent") return sel.length === 1 ? { kind, intent: sel[0] } : null;
    // 0006 staged-rounds: the per-round approach rides `intent` exactly like comp-intent (committed for
    // THIS round only). Structured selection only — never read from prose.
    if (kind === "comp-round") return sel.length === 1 ? { kind, intent: sel[0] } : null;
    // 0061 — a confirmed self-eviction needs no pick; ONLY the explicit confirm flag binds it.
    if (kind === "self-evict") return { kind, confirmed: true };
    if (kind === "veto-decision") {
      if (useVeto === false) return { kind, use: false };
      return sel.length === 1 ? { kind, use: true, save: sel[0] } : null;
    }
    // 0025 — the secret veto: play it (use:true) or hold it (use:false). An explicit choice only.
    if (kind === "secret-veto") return useVeto === null ? null : { kind, use: useVeto === true };
    const field = SINGLE_PICK_FIELD[kind];
    if (field) return sel.length === 1 ? { kind, [field]: sel[0] } : null;
    return null;
  }

  function titleFor(kind, binding) {
    // J4-17: a binding first comp-round and a non-binding flavor round previously shared one
    // title — only the button label/note differed, so the two looked identical at a glance. The
    // binding round is the one that sets the approach the single outcome roll honors; a later
    // round is color over an already-decided result. Title them distinctly so the stakes read
    // from the heading, not just the fine print. (Copy only — the binding flag comes from the
    // engine's PendingDecisionView; this asserts no board state.)
    if (kind === "comp-round") {
      return binding === false
        ? "Competition round — keep pushing (no stakes)"
        : "Competition round — set your approach";
    }
    return {
      "nominations": "Nomination ceremony — your nominations",
      "veto-decision": "Power of Veto — your call",
      "comp-intent": "Competition — set your approach",
      "comp-round": "Competition round — your approach this round",
      "houseguests-choice": "Houseguest's Choice — pick the sixth player",
      "replacement": "Veto ceremony — name the replacement",
      "eviction-vote": "Eviction — cast your vote",
      "tie-break": "Tied vote — as HOH, you decide",
      "final-eviction": "Final 3 — you evict, personally",
      "goodbye-message": "Goodbye message — your tone, your words",
      "exit-interview": "Exit interview — your posture, your words",
      "spectator-choice": "You're out before the jury — skip ahead or keep watching?",
      "finale-interview": "Finale night — your interview",
      "finale-statement": "Opening statement — address the jury",
      "finale-answer": "Jury question — choose your appeal",
      "juror-question": "Your jury question — ask the finalist",
      "juror-vote": "Your jury vote — crown a winner",
      "self-evict": "Self-eviction — leave the game?",
      "deal-offer": "A houseguest's offer — accept or decline",
      "secret-veto": "Your secret veto — play it or hold it",
    }[kind] || "Your decision";
  }

  function confirmLabelFor(kind, binding) {
    if (kind === "self-evict") return "Confirm — leave the game (final)";
    if (kind === "deal-offer") return "Confirm your answer"; // 0123: a light social choice, not a binding fate
    if (kind === "comp-round") return binding === false ? "Push through this round" : "Lock in your approach";
    return "Confirm — this is binding";
  }

  // J4-20 (WCAG 3.3.2): the instruction shown — and announced via aria-describedby — while Confirm
  // is disabled, so the player knows what is still needed to enable it. Kind-aware so the hint names
  // the actual missing input (a tone, two nominees, a single pick). Copy only — never a board claim.
  function disabledHintFor(kind, pick, multi) {
    if (kind === "nominations") return "Select 2 houseguests to enable Confirm.";
    if (kind === "goodbye-message") return "Pick a tone to enable Confirm — your written message is optional.";
    if (kind === "exit-interview" || kind === "finale-interview") return "Pick a posture to enable Confirm — your written words are optional.";
    if (kind === "spectator-choice") return "Choose to skip ahead or keep watching, to enable Confirm.";
    if (kind === "veto-decision") return "Choose to use the veto (and who to save) or not, to enable Confirm.";
    if (kind === "secret-veto") return "Choose to play your secret veto or hold it, to enable Confirm.";
    if (multi) return `Select ${pick} to enable Confirm.`;
    return "Make your selection above to enable Confirm.";
  }

  // F-NEW-5: a kind-specific (never auto-sent) prefill cue so the dramatic context
  // of the locked-in decision carries into the player's next conversational turn —
  // a single generic line lost the moment. Falls back to the generic cue.
  function prefillCueFor(kind) {
    const cues = {
      nominations: "I've named my nominees — let's see the room when I say it out loud.",
      "veto-decision": "I've decided on the veto — time to make it official at the ceremony.",
      "finale-statement": "I've made my final case to the jury — let's see how it lands.",
      "juror-question": "I've decided what to ask — let's hear their answer.",
      "finale-answer": "I've cast my jury vote — let's see who takes it.",
      "goodbye-message": "I've recorded my goodbye message — let's see how the house reacts.",
      "exit-interview": "I've given my exit interview — that's my side of it.",
      "spectator-choice": "I've decided how to follow the rest of the season.",
      "finale-interview": "I've given my finale-night interview — that's my side of it.",
      "comp-intent": "I've set my approach for this competition — let's compete.",
      "comp-round": "I'm committing to this round — let's push on.",
      "self-evict": "I've made my choice to walk — let's see how the house takes it.",
    };
    return cues[kind] || "I've made my decision — let's see how the house takes it.";
  }

  // ORW-281 4b: a staged-ceremony WATCH step. Not a decision - no options, no Confirm, no stakes skin: the
  // engine's one Vault-free line and a Continue that moves the ceremony exactly one step (advanceGame via
  // POST /api/orwell/ceremony-continue). Mounts through the same sheet -> notice -> stream chain as the
  // decision card so it sits where the player already looks.
  function renderCeremonyStep(pending) {
    ensureStyles();
    const chatBox = document.getElementById("chat-history");
    const hasKit = !!(window.OrwellNoticeKit && document.querySelector(".chat-input-bar"));
    if (!chatBox && !hasKit) return;
    const cer = pending.ceremony || {};
    const card = document.createElement("div");
    card.id = CARD_ID;
    card.classList.add("odec", "odec-watch");
    card.role = "group";   // ARIA reflection: a watch step is not a form (the decision card keeps role=form)
    card.setAttribute("aria-label", "Ceremony");
    card.dataset.binding = "false";
    card.dataset.ceremony = String(cer.kind || "");
    card.dataset.step = String(cer.step || "");
    const head = document.createElement("div");
    head.className = "odec-head";
    const stepOf = (cer.step && cer.of) ? " \u00b7 " + cer.step + " of " + cer.of : "";
    head.innerHTML = `<span class="odec-title">${esc(_ceremonyTitle(cer.kind))}${esc(stepOf)}</span>`;
    const body = document.createElement("p");
    body.className = "odec-note";
    body.textContent = String(pending.text || pending.prompt || "");
    const btn = document.createElement("button");
    btn.className = "ow-btn ow-btn-prominent odec-confirm"; btn.type = "button";
    btn.textContent = "Continue";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const r = await fetch("/api/orwell/ceremony-continue", { method: "POST", credentials: "same-origin" });
        if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { httpStatus: r.status });
        const res = await r.json().catch(() => ({}));
        removeCard();
        if (window.orwellGameChanged) window.orwellGameChanged("ceremony-step", res && res.beatSeq);
        // The next step (or the next binding decision) arrives on the same view: mount it now.
        const nxt = res && res.pending;
        if (nxt && nxt.kind) window.dispatchEvent(new CustomEvent("orwell:pending", { detail: { pending: nxt } }));
      } catch (_) {
        if (window.OrwellReport) window.OrwellReport.fail("decision", "ceremony-continue", _); // G11: fail open, never silent
        btn.disabled = false;
        btn.textContent = "Continue (try again)";
      }
    });
    card.appendChild(head); card.appendChild(body); card.appendChild(btn);
    const hasSheet = !!(window.OrwellSheetKit && window.OrwellSheetKit.create &&
      (document.querySelector(".chat-input-bar") || document.getElementById("chat-bar") ||
       (window.OrwellNoticeKit && window.OrwellNoticeKit.ensureZone)));
    if (hasSheet) {
      _sheet = window.OrwellSheetKit.create({ id: "orwell-decision-sheet", anchored: true,
        title: _ceremonyTitle(cer.kind), role: "group", dismissible: false });
      const host = _sheet.ensure();
      const sheetHead = _sheet.el && _sheet.el.querySelector(".ow-sheet-head");
      if (sheetHead) sheetHead.style.display = "none";
      host.appendChild(card);
    } else if (hasKit) {
      _notice = window.OrwellNoticeKit.create({ id: "orwell-decision-notice", kind: "decision",
        title: _ceremonyTitle(cer.kind), role: "presentation", dismissible: false, persistDismiss: false });
      const host = _notice.ensure();
      const kitHead = _notice.el && _notice.el.querySelector(".on-head");
      if (kitHead) kitHead.style.display = "none";
      host.appendChild(card);
    } else {
      chatBox.appendChild(card);
    }
    card.scrollIntoView({ block: "nearest" });
    card.setAttribute("tabindex", "-1");
    card.focus();
  }
  // ORW-281: a decision card that is one step of a staged ceremony reads "... · 2 of 4" like the watch cards do.
  function _stepSuffix(pending) {
    const c = pending && pending.ceremony;
    return (c && c.step && c.of) ? " \u00b7 " + c.step + " of " + c.of : "";
  }
  function _ceremonyTitle(kind) {
    return ({ "nominations": "Nominations", "veto-draw": "Veto draw", "veto-ceremony": "Veto ceremony",
              "eviction": "Eviction night", "final-eviction": "Final 2 eviction" })[kind] || "Ceremony";
  }

  function render(pending) {
    removeCard();
    if (!pending || !pending.kind) return;
    if (pending.kind === "ceremony-step") { renderCeremonyStep(pending); return; }
    ensureStyles();
    // #642: the card mounts into the OrwellNotice kit's above-composer zone (the kit anchors it
    // above .chat-input-bar). Require the kit + the composer anchor; fall back to the in-stream
    // #chat-history host only if the kit is unavailable (fail-open — the card must always reach
    // the player). The chat-history existence is still the boot-readiness signal the rearm uses.
    const chatBox = document.getElementById("chat-history");
    const hasKit = !!(window.OrwellNoticeKit && document.querySelector(".chat-input-bar"));
    if (!chatBox && !hasKit) return;

    const kind = pending.kind;
    const pick = kind === "nominations" ? 2 : (typeof pending.pick === "number" ? Math.max(1, pending.pick) : 1);
    const multi = pick > 1;
    let sel = [];
    let useVeto = null; // veto-decision only: null=unchosen, true=use (pick save), false=don't

    const card = document.createElement("div");
    card.id = CARD_ID;
    // The kit's structural CSS is scoped to this root class (see ensureStyles) — the id stays
    // for the DOM registries/suppressions that pin it, but styling rides the class.
    card.classList.add("odec");
    // J4-02: role="form" makes this a named form landmark (AT users can reach it
    // via landmark navigation and know a binding decision is required).
    card.setAttribute("role", "form");
    // J4-12: link the card to the instruction note so SR users hear the decision
    // context + the "your selection only" / irreversibility instruction before
    // they Tab into options.
    card.setAttribute("aria-describedby", CARD_ID + "-note");
    // Focused-context-first: while focus is in the card, Escape belongs to the
    // card's own dismiss-only handler (the global arbiter stands down on this marker).
    card.setAttribute("data-ow-escape-scope", "");

    // J5-20: a high-stakes kind wears the risk skin (red border/wash) AND a textual "binding /
    // irreversible" badge — never color alone. The badge text rides in the title's aria-label
    // (set via the card's existing aria-label + the visible badge) so colorblind + SR users get
    // the same weight signal sighted users get from the tint.
    const risk = isHighStakes(kind);
    // CA-14 (a11y fix): `risk` must be known BEFORE the aria-label is built — the label now
    // actually concatenates the badge text ("— Irreversible, binding"), so a landmark-navigation
    // SR user (role="form") hears the stakes signal from the landmark's own name, not only by
    // reading the card's body content linearly (the code comment above previously asserted this
    // but no code did it — the badge's `role="note"` text was reachable only by linear reading).
    card.setAttribute("aria-label", titleFor(kind, pending.binding) + (risk ? " — Irreversible, binding" : ""));
    if (risk) card.classList.add("odec-risk");
    // J4-04: expose the binding state as a data attribute so a non-binding staged comp-round
    // (flavor over an already-decided result) is inspectable/testable — not only distinguishable
    // via the confirm label. `pending.binding === false` ⇒ "false"; everything else binds ⇒ "true".
    card.dataset.binding = String(pending.binding !== false);

    const head = document.createElement("div");
    head.className = "odec-head";
    // J5-20: append the risk badge after the title — "⚠ Irreversible" carries the stakes in
    // text + an icon, so the signal survives without color (the SR companion to the red tint).
    head.innerHTML = `<span class="odec-title">${esc(titleFor(kind, pending.binding))}${esc(_stepSuffix(pending))}</span>`
      + (risk ? `<span class="odec-risk-badge" role="note">⚠ Irreversible — binding</span>` : "");
    // J5-21: the dismiss × is created here (so the keydown/Escape handler can reference it) but is
    // NOT appended to the head — it is appended to the card LAST (after the row) so it falls last in
    // tab order. CSS positions it absolutely back into the top-right corner.
    const x = document.createElement("button");
    x.className = "odec-x"; x.type = "button"; x.textContent = "×";
    x.title = "Dismiss — you can decide in conversation instead";
    // J4-03: aria-label must be as descriptive as the title so AT users hear the same
    // context as sighted users who hover. "Dismiss" alone gives no intent signal.
    x.setAttribute("aria-label", "Dismiss — decide in conversation instead");
    x.addEventListener("click", () => { _userDismissed = true; _dismissedSig = _sig(pending); removeCard(); });
    card.appendChild(head);
    // F11 (DWE audit): Escape while the card holds focus = the × path — dismiss
    // only, NEVER a submit (the prose path stays open; #233's "Escape is the
    // keyboard way out" applied to the non-binding dismissal). Card-scoped so
    // the global arbiter and composer Escape behaviors are untouched.
    card.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      _userDismissed = true;
      _dismissedSig = _sig(pending);
      removeCard();
    });

    // M1-4 (audit A4): the engine's comp prompt embeds the roster ("Still in with you: …") AND the
    // structured `stillIn` field renders the same roster below — a sixteen-name wall twice over
    // (brutal on a phone). When the structured block WILL render, elide the prompt's templated
    // roster sentence; any non-matching prompt passes through untouched (closed-set prose is never
    // rewritten beyond this one known template — ADR 0005).
    const willRenderStillIn = kind === "comp-round" && Array.isArray(pending.stillIn) && pending.stillIn.length;
    if (pending.prompt) {
      const p = document.createElement("div");
      p.className = "odec-prompt";
      // WCAG 2.1.1 (Keyboard): on short viewports this caps to a 20vh scroll region (CSS media
      // block), so a long ceremony/comp prompt runs below the fold with the Confirm row pinned.
      // tabindex=0 + role=region lets a keyboard/SR user land on it and read the FULL prompt
      // (arrows/PageDown/Space) before committing a binding move.
      p.setAttribute("tabindex", "0");
      p.setAttribute("role", "region");
      p.setAttribute("aria-label", "decision prompt");
      let promptText = pending.prompt;
      // G15: structured finalist signal — who is being asked
      if (pending.finalist && pending.finalist.name) {
        promptText = `${esc(pending.finalist.name)} — ` + promptText;
      }
      if (willRenderStillIn) {
        promptText = promptText.replace(/\s*Still in with you:\s*[^.]+\s*\.\s*/, " ").replace(/\s{2,}/g, " ").trim();
      }
      p.textContent = promptText + (pending.juror && pending.juror.name ? ` (asked by ${esc(pending.juror.name)})` : "");
      card.appendChild(p);
    }

    // 0006 staged-rounds: show WHO IS STILL IN this elimination round so the player adapts their
    // approach to the narrowed field (e.g. everyone left is an ally → throw; a threat still in → compete).
    if (willRenderStillIn) {
      const still = document.createElement("div");
      still.className = "odec-stillin";
      // WCAG 2.1.1 (Keyboard): the roster also caps to a 20vh scroll region on short viewports.
      // Focusable region so a keyboard/SR user can read WHO IS STILL IN before adapting a binding move.
      still.setAttribute("tabindex", "0");
      still.setAttribute("role", "region");
      still.setAttribute("aria-label", "houseguests still in play");
      const names = pending.stillIn.map((r) => esc(r.name || String(r.id))).join(", ");
      const r = (typeof pending.round === "number" && pending.round > 0) ? `Round ${pending.round} — ` : "";
      still.innerHTML = `<strong>${r}Still in:</strong> ${names}`;
      card.appendChild(still);
    }

    // 0129 slice 4 — the INFORMED jury vote: what fellow jurors TOLD the player (their own knowledge, by finalist).
    // textContent only (model-adjacent text never goes through innerHTML). Absent ⇒ the card is unchanged.
    if (kind === "juror-vote" && Array.isArray(pending.jurorBrief) && pending.jurorBrief.length) {
      const brief = document.createElement("div");
      brief.className = "odec-stillin";
      brief.setAttribute("tabindex", "0");
      brief.setAttribute("role", "region");
      brief.setAttribute("aria-label", "what the jurors told you");
      const head = document.createElement("strong");
      head.textContent = "What the jurors told you:";
      brief.appendChild(head);
      pending.jurorBrief.forEach((b) => {
        const row = document.createElement("div");
        row.textContent = `${(b.finalist && b.finalist.name) || ""} — ${(b.heard || []).join("; ")}`;
        brief.appendChild(row);
      });
      card.appendChild(brief);
    }

    const opts = document.createElement("div");
    opts.className = "odec-opts";
    card.appendChild(opts);

    let textarea = null;
    const confirm = document.createElement("button");
    // #775 (owner request): the Confirm / "Evict" CTA composes the kit's .ow-btn .ow-btn-prominent
    // for the kit's state machinery (focus ring, press, disabled). Its legible FILL stays the
    // sanctioned system-blue (style.css body.theme-frosted .odec-confirm, !important color:#fff) —
    // or eviction-RED on a risk card — so the label is ALWAYS white-on-accent, never dark-on-dark.
    confirm.className = "ow-btn ow-btn-prominent odec-confirm"; confirm.type = "button";
    // 0006 staged-rounds: only the FIRST comp-round BINDS (the approach the single outcome roll honors);
    // later rounds are non-binding FLAVOR over an already-decided result (audit 2026-06-20) — phrase the
    // confirm so a flavor round reads as "push through", never a fresh stakes commitment. Single source
    // of truth: confirmLabelFor (also reused on the error-recovery relabel).
    confirm.textContent = confirmLabelFor(kind, pending.binding);
    confirm.disabled = true;

    // J4-20 (WCAG 3.3.2 — instructions on a disabled control): a disabled Confirm previously gave
    // no hint about WHY it was disabled or WHAT to do. Add a hint that says what's still needed; it
    // is announced to AT via the confirm button's aria-describedby and shown visibly only while the
    // button is disabled (hidden once the move is legal, so it never clutters a ready card).
    const hint = document.createElement("span");
    hint.className = "odec-hint";
    hint.id = CARD_ID + "-hint";
    hint.textContent = disabledHintFor(kind, pick, multi);

    const sync = () => {
      confirm.disabled = buildPayload(kind, sel, textarea && textarea.value.trim(), useVeto) == null;
      // J4-20: surface the hint only while Confirm can't be pressed.
      hint.hidden = !confirm.disabled;
    };

    const addChip = (label, value, person) => {
      const b = document.createElement("button");
      b.className = "ow-btn ow-btn-prominent odec-opt"; b.type = "button";
      b.setAttribute("aria-pressed", "false");
      if (person && window.OrwellMonogram) {
        // The face carries initials/portrait pixels, which would pollute the button's
        // computed name ("AB Alice") — pin the accessible name to the label alone.
        b.setAttribute("aria-label", label);
        // M2-2/M3-4: the SAME designed-monogram-or-portrait face the cast surfaces render
        // (id-seeded, Vault-free) — a real persisted portrait when the roster cache has one,
        // the monogram otherwise (OrwellMonogram.face()'s own sanctioned fallback).
        const cached = _portraitById[String(person.id)];
        const f = window.OrwellMonogram.face(
          { id: person.id, name: person.name || label,
            status: (cached && cached.status) || "active",
            portrait: cached && cached.portrait },
          { alt: label }
        );
        f.classList.add("odec-face");
        f.setAttribute("aria-hidden", "true");
        b.appendChild(f);
      }
      b.appendChild(document.createTextNode(label));
      b.addEventListener("click", () => {
        const on = b.getAttribute("aria-pressed") === "true";
        if (on) {
          // R2-01: comp-round/comp-intent are required single-picks with a pre-selected default
          // (a non-binding flavor round arms "compete" + enables "Push through"). Re-tapping the
          // lit chip must NOT clear it — that left Confirm stuck disabled with no cue. Other kinds
          // keep their toggle-off (e.g. the veto "Don't use" chip legitimately deselects).
          if (!multi && (kind === "comp-round" || kind === "comp-intent")) return;
          sel = sel.filter((v) => v !== value);
          b.setAttribute("aria-pressed", "false");
        } else {
          if (!multi) {
            sel = [];
            opts.querySelectorAll('.odec-opt[aria-pressed="true"]').forEach((n) => n.setAttribute("aria-pressed", "false"));
          } else if (sel.length >= pick) {
            return; // pick-count enforced: deselect something first
          }
          sel.push(value);
          b.setAttribute("aria-pressed", "true");
        }
        sync();
      });
      opts.appendChild(b);
      return b;
    };

    if (kind === "finale-statement") {
      textarea = document.createElement("textarea");
      textarea.placeholder = "Your opening statement to the jury…";
      textarea.setAttribute("aria-label", "Your opening statement to the jury"); // J5-02: placeholders aren't accessible names
      textarea.addEventListener("input", sync);
      card.appendChild(textarea);
      confirm.disabled = false; // a statement may be short; engine treats it as flavor
    } else if (kind === "juror-question") {
      // E37: scoreless free text — the player-juror's own question to the finalist.
      textarea = document.createElement("textarea");
      textarea.placeholder = "Your question to the finalist…";
      textarea.setAttribute("aria-label", "Your question to the finalist"); // J5-02
      textarea.addEventListener("input", sync);
      card.appendChild(textarea);
      confirm.disabled = false; // free text; the engine scores nothing here
      // G15: structured finalist label below the textarea
      if (pending.finalist && pending.finalist.name) {
        const fl = document.createElement("div");
        fl.className = "odec-structured";
        fl.setAttribute("tabindex", "0");
        fl.setAttribute("role", "region");
        fl.setAttribute("aria-label", "finalist");
        fl.innerHTML = `<strong>Asking:</strong> ${esc(pending.finalist.name)}`;
        card.appendChild(fl);
      }
    } else if (kind === "goodbye-message") {
      // E34: pick a tone (the binding part) + optional message text (the model voices it).
      (pending.options || []).forEach((o) => addChip(o.name || String(o.id), o.id));
      textarea = document.createElement("textarea");
      textarea.placeholder = "Your goodbye message (optional — the tone is what binds)…";
      textarea.setAttribute("aria-label", "Your goodbye message (optional)"); // J5-02
      textarea.addEventListener("input", sync);
      card.appendChild(textarea);
      // G15: structured evictee signal — who is saying goodbye
      if (pending.evictee && pending.evictee.name) {
        const ev = document.createElement("div");
        ev.className = "odec-structured";
        ev.setAttribute("tabindex", "0");
        ev.setAttribute("role", "region");
        ev.setAttribute("aria-label", "evictee identity");
        ev.innerHTML = `<strong>Saying goodbye:</strong> ${esc(pending.evictee.name)}`;
        card.appendChild(ev);
      }
    } else if (kind === "spectator-choice") {
      // 0133: an early-evicted player chooses how to follow the rest of the season; either way they are back
      // for the finale night. Plain-language labels over the two engine modes (skip is final, watch can be skipped later).
      const SPECTATOR_LABELS = { skip: "Skip ahead to the finale", watch: "Keep watching (a condensed season)" };
      (pending.options || []).forEach((o) => addChip(SPECTATOR_LABELS[o.id] || o.name || String(o.id), o.id));
    } else if (kind === "exit-interview" || kind === "finale-interview") {
      // 0130 / 0133: the player's own interview — pick a posture (the binding part) + optional words.
      (pending.options || []).forEach((o) => addChip(o.name || String(o.id), o.id));
      textarea = document.createElement("textarea");
      const interviewLabel = kind === "finale-interview" ? "Your finale-night interview" : "Your exit interview";
      textarea.placeholder = interviewLabel + " (optional — the posture is what binds)…";
      textarea.setAttribute("aria-label", interviewLabel + " (optional)"); // J5-02
      textarea.addEventListener("input", sync);
      card.appendChild(textarea);
    } else if (kind === "finale-answer") {
      (Array.isArray(pending.appeals) && pending.appeals.length ? pending.appeals : []).forEach((a) => addChip(String(a), String(a)));
    } else if (kind === "comp-intent" || kind === "comp-round") {
      // 0006 staged-rounds: the same compete/throw/play-safe approaches, but per-round for comp-round.
      const chips = COMP_INTENTS.map((i) => addChip(i, i));
      // audit 2026-06-20: only the FIRST comp-round binds (the intent the single outcome roll honored).
      // A later round is non-binding FLAVOR over an already-decided result — default it to "compete" so
      // the player can one-click "Push through" (still free to pick a different colour, or dismiss).
      if (kind === "comp-round" && pending.binding === false && chips[0]) {
        sel = [COMP_INTENTS[0]];
        chips[0].setAttribute("aria-pressed", "true");
        confirm.disabled = false;
        // INT-26/VM-22: a non-binding round must not LOOK like a fresh decision — tapping a
        // different chip visibly moved the selection ring exactly as if a new binding choice
        // were being made, contradicting the card's own "this is just color" disclosure. Disable
        // the two NON-selected chips (the locked approach stays the only interactive-looking one)
        // rather than leaving all three freely toggleable.
        chips.slice(1).forEach((c) => {
          c.disabled = true;
          c.classList.add("odec-opt-inert");
          c.title = "This round is flavor only — your approach was locked in round one.";
        });
      }
    } else if (kind === "self-evict") {
      // 0061: no options to pick — an explicit Confirm IS the irreversible decision (a Cancel
      // button is added to the row below, posting the engine cancel so the player plays on).
      confirm.disabled = false;
      confirm.textContent = "Confirm — leave the game (final)";
    } else if (kind === "veto-decision") {
      const dont = addChip("Don't use the veto", "__dont__");
      dont.addEventListener("click", () => {
        useVeto = useVeto === false ? null : false;
        sel = [];
        opts.querySelectorAll('.odec-opt[aria-pressed="true"]').forEach((n) => n.setAttribute("aria-pressed", "false"));
        dont.setAttribute("aria-pressed", useVeto === false ? "true" : "false");
        sync();
      });
      (pending.options || []).forEach((o) => {
        const chip = addChip("Save " + (o.name || o.id), o.id, o); // M2-2: person option
        chip.addEventListener("click", () => {
          useVeto = sel.length === 1 ? true : null;
          dont.setAttribute("aria-pressed", "false");
          sync();
        });
      });
    } else if (kind === "secret-veto") {
      // 0025: the player's private, one-time safety — play it now or hold it (no person to pick).
      const play = addChip("Play the secret veto", "__play__");
      const hold = addChip("Hold it", "__hold__");
      const choose = (v) => {
        useVeto = useVeto === v ? null : v;
        sel = [];
        play.setAttribute("aria-pressed", useVeto === true ? "true" : "false");
        hold.setAttribute("aria-pressed", useVeto === false ? "true" : "false");
        sync();
      };
      play.addEventListener("click", () => choose(true));
      hold.addEventListener("click", () => choose(false));
    } else if (kind === "deal-offer") {
      // G15: structured offer rendering (0123 accept/decline of NPC deal)
      if (pending.offer && pending.offer.from && pending.offer.from.name) {
        const of = document.createElement("div");
        of.className = "odec-structured";
        of.setAttribute("tabindex", "0");
        of.setAttribute("role", "region");
        of.setAttribute("aria-label", "offer details");
        let offerHtml = `<strong>Offer from ${esc(pending.offer.from.name)}</strong>`;
        if (pending.offer.kind) offerHtml += ` <span class="odec-offer-kind">(${esc(pending.offer.kind)})</span>`;
        if (pending.offer.terms) offerHtml += `<div class="odec-offer-terms">${esc(pending.offer.terms)}</div>`;
        of.innerHTML = offerHtml;
        card.appendChild(of);
      }
      // options chips for accept/decline
      (pending.options || []).forEach((o) => addChip(o.name || String(o.id), o.id, o));
    } else {
      // M2-2: every kind that lands here picks a HOUSEGUEST (nominations, eviction-vote,
      // replacement, houseguests-choice, tie-break, juror-vote, final-eviction) — the chip
      // carries the person's face. Tone/approach kinds branch above and stay text-only.
      (pending.options || []).forEach((o) => addChip(o.name || String(o.id), o.id, o));
    }

    const row = document.createElement("div");
    row.className = "odec-row";
    const note = document.createElement("span");
    note.className = "odec-note";
    note.id = CARD_ID + "-note";
    if (kind === "self-evict") {
      note.textContent = "This ends and forfeits your game — it cannot be undone.";
    } else if (kind === "comp-round") {
      // 0006 staged-rounds (audit 2026-06-20): the first round sets the binding approach; later rounds
      // are color over an already-decided result, so say so plainly rather than implying fresh stakes.
      note.textContent = pending.binding === false
        ? "No stakes here — your approach was locked in round one. Push through, or dismiss to play it out in conversation."
        : "This sets how you play the comp. Your selection only — never read from prose.";
    } else if (kind === "juror-question") {
      // J5-01: this card IS a prose textarea — the generic "never read from prose" note (announced
      // via aria-describedby) directly contradicted the only input on the card.
      note.textContent = "Your own words — type your question, then Confirm. Leave it blank to pass.";
    } else if (kind === "finale-statement") {
      note.textContent = "Your own words — type your statement to the jury, then Confirm.";
    } else if (kind === "goodbye-message") {
      // J5-01: the tone chip binds (the written message is optional) — say so, since Confirm stays
      // disabled until a tone is picked and nothing else explained why.
      note.textContent = "Pick a tone — that's what binds. Your written message is optional.";
    } else {
      // UX-9: this note is the card's aria-describedby source, announced at nominations /
      // the eviction vote. "never read from prose" is OOC engine-language that breaks the
      // fiction — reword to a player-facing line that still says the choice is the player's
      // (the button selection is what counts, not anything typed in chat).
      // J3-22: first-timer "binding" context — the Confirm button says "this is binding" but never
      // says what binding MEANS. Spell it out for the genuinely irreversible kinds (the high-stakes
      // set wears the ⚠ badge): once you confirm, it's locked and plays out — you can't take it back.
      const base = multi ? `Select ${pick} — only a legal move counts.` : "Your choice here is what counts — make it with the buttons.";
      note.textContent = risk ? base + " Once you confirm, it's locked in and plays out — there's no taking it back." : base;
    }
    row.appendChild(note);
    // 0061: a self-eviction confirmation gets an explicit CANCEL — declining must clear the engine
    // confirmation so the player simply plays on (never a fabricated, half-committed exit).
    if (kind === "self-evict") {
      const cancel = document.createElement("button");
      // #775: the self-evict Cancel is a standard secondary action, NOT a selectable option chip —
      // give it the kit's secondary variant (the .odec-opt layout class stays for the row sizing),
      // never the prominent option-chip treatment + aria-pressed toggle semantics.
      cancel.className = "ow-btn ow-btn-secondary odec-opt"; cancel.type = "button";
      cancel.textContent = "Cancel — stay in the house";
      // FE2-5: this is the ONE binding, irreversible-adjacent action on this card that must fail
      // SAFE — a network blip here must never tell the player "you're safe, keep playing" while
      // the engine may still hold a live self-eviction confirmation. Mirror the Confirm handler's
      // pattern: only declare success (and stop re-arming) once the POST actually reached the
      // engine; on failure, keep the card up, surface a role="alert" error, and let them retry.
      cancel.addEventListener("click", async () => {
        cancel.disabled = true;
        const prevLabel = cancel.textContent;
        cancel.textContent = "Cancelling…";
        try {
          const r = await fetch("/api/orwell/self-eviction/cancel", { method: "POST", credentials: "same-origin" });
          if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { httpStatus: r.status });
          _userDismissed = true;   // only suppress re-arming once the cancel is CONFIRMED
          _dismissedSig = _sig(pending);
          if (window.orwellGameChanged) window.orwellGameChanged("self-evict:cancel");
          removeCard();
        } catch (_) {
          if (window.OrwellReport) window.OrwellReport.fail("self-evict", "cancel-post", _); // G11: fail open, never silent
          cancel.disabled = false;
          cancel.textContent = prevLabel;
          err.textContent = "That cancel didn't reach the house — you may still be flagged to leave. Try again, or decide in conversation.";
        }
      });
      row.appendChild(cancel);
    }
    row.appendChild(confirm);
    // J4-20: the disabled-state hint rides in the row beside Confirm; sync() toggles its `hidden`.
    // Cards that start with Confirm already enabled (free-text statements/questions, the non-binding
    // flavor round, self-evict) never need it, so suppress it when Confirm is not initially disabled.
    if (confirm.disabled) { hint.hidden = false; confirm.setAttribute("aria-describedby", hint.id); row.appendChild(hint); }
    card.appendChild(row);

    // J4-09: pre-declare the error region before it might be populated — dynamic
    // live-region injection is unreliable across AT/browser pairs; a pre-existing
    // role="alert" ensures all AT pairs announce the error text when it's set.
    const err = document.createElement("div");
    err.className = "odec-err";
    err.setAttribute("role", "alert");
    err.setAttribute("aria-live", "assertive");
    err.setAttribute("aria-atomic", "true");
    card.appendChild(err);

    // J5-21: append the dismiss × LAST so it is the final tab stop — the options/textarea and Confirm
    // (built above) come first. CSS (position:absolute, top/right) keeps it visually in the corner;
    // Escape-to-dismiss still works via the card-scoped keydown handler above. Focus-on-mount below
    // targets the card itself (tabindex=-1), unaffected by DOM order.
    card.appendChild(x);

    confirm.addEventListener("click", async () => {
      const payload = buildPayload(kind, sel, textarea && textarea.value.trim(), useVeto);
      if (!payload) return;
      // CON-4 / INTEGRATION2-1: a STABLE at-most-once key derived from this card's pending signature
      // (distinct per pending, identical across a retry of THIS card). So a lost-200 retry, or a
      // double-tap across two mirrored windows both showing the card, is a verbatim engine replay —
      // never a double-apply / wrong-staged-round commit. The engine keys `submitDecision` on it (0065
      // Part B); an older engine ignores the extra field (back-compatible).
      try { payload.idempotency_key = "dec:" + _sig(pending); } catch (_) {}
      confirm.disabled = true;
      confirm.textContent = "Locking in…";
      try {
        // WS Phase-1 (ADR 0017 §3.5, fix #1866): when the OrwellWs socket is LIVE (flag ON + a
        // successful handshake), the confirm goes UP as a `decision` frame carrying the 0065
        // expectedBeatSeq CAS; the server relay now runs the EXACT post-submit seams the HTTP
        // /api/orwell/decision handler runs (F14 advance, pending cache, CON-4 reconcile, DB1
        // debounce — imported via `_post_decision_tail`): the parity claim is TRUE. DORMANT when
        // the socket is not active (the flag is OFF by default — the zero-risk Phase-1 default — or
        // the upgrade failed/downgraded to SSE): the byte-identical HTTP POST below stands. A WS
        // error is mapped onto the SAME httpStatus the catch below already branches on, so a
        // stale-beat reconciles through the existing 409 desync path exactly as the HTTP 409 does.
        const _ws = window.OrwellWs;
        const _wsLive = !!(_ws && _ws.isActive && _ws.isActive() && _ws.sendDecision);
        let _beat;
        if (_wsLive) {
          try {
            const _pinned = (_ws.lastBeatSeq && _ws.lastBeatSeq()) || undefined;
            const _sendP = _ws.sendDecision(Object.assign({}, payload, { expectedBeatSeq: _pinned }));
            // N-12: on timeout also drop the socket's retained pending entry so retries never accumulate.
            const _ack = await _withTimeout(_sendP, _submitTimeoutMs(), () => { try { if (_ws.cancelRequest) _ws.cancelRequest(_sendP); } catch (_) {} });
            // The `decision` ack carries no board body (§3.5 — the result fans out as a `state`
            // edge, which platform.js turns into the ONE orwellGameChanged('ws:state') too); read
            // the freshest beatSeq the socket has seen for the M1-3 nudge below.
            _beat = (_ws.lastBeatSeq && _ws.lastBeatSeq()) || (_ack && _ack.d && _ack.d.beatSeq) || undefined;
          } catch (e) {
            const _code = e && e.code;
            if (e && e.timedOut) throw e;   // N-12: surface the timeout (distinct copy below), not a generic connection error
            throw Object.assign(new Error(_code || "ws-decision-failed"), {
              httpStatus: _code === "stale-beat" ? 409
                : (_code === "unknown-kind" || _code === "no-game") ? 400 : undefined,
            });
          }
        } else {
          const _abort = new AbortController();
          // N-12: ONE bound covers headers AND the body read - a server that sends headers then stalls the body must not wedge Confirm.
          try {
            await _withTimeout((async () => {
              const r = await fetch("/api/orwell/decision", {
                method: "POST", credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: _abort.signal,
              });
              if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { httpStatus: r.status });
              // M1-3: best-effort read of the commit's beatSeq off the decision response so the
              // panels can verify their refetch reached it (the goodbye-card-beside-stale-board race).
              try { _beat = ((await r.json()) || {}).beatSeq; } catch (_) {}
            })(), _submitTimeoutMs(), () => _abort.abort());
          } catch (e) {
            throw e;
          }
        }
        _userDismissed = true;   // this pending is handled — stop any boot re-assert loop
        _dismissedSig = _sig(pending);
        // G15: a bound decision mutates the game — nudge every panel through the
        // shared debounced dispatcher NOW, not at the next 20–30s poll.
        if (window.orwellGameChanged) window.orwellGameChanged("decision:" + kind, _beat);
        card.classList.add("odec-done");
        card.innerHTML = `<div class="odec-head"><span class="odec-title">✓ Locked in.</span></div>`;
        // The play continues in conversation: prefill (never auto-send) so the model
        // narrates the ceremony from FRESH engine state on the player's next turn.
        // F-NEW-5: branch the prefill cue on the decision kind so the dramatic context
        // carries over — a generic "I've made my decision" loses the moment.
        const box = document.getElementById("message");
        if (box && !box.value.trim()) {
          box.value = prefillCueFor(kind);
          box.dispatchEvent(new Event("input", { bubbles: true }));
          box.focus();
        }
        _doneTimer = setTimeout(() => {
          // J5-06: only remove if THIS card is still the lingering done-card — never a card that
          // re-armed into the same id within the 4s window (removeCard() also clears this timer).
          // #642/#753: remove the host (sheet or notice) too (if any) so no empty wrapper lingers.
          if (card.isConnected && card.classList.contains("odec-done")) {
            if (_sheet) { try { _sheet.dismiss("api"); } catch (_) {} _sheet = null; }
            if (_notice) { try { _notice.hide(); } catch (_) {} _notice = null; }
            card.remove();
          }
          _doneTimer = null;
        }, 4000);
      } catch (_) {
        if (window.OrwellReport) window.OrwellReport.fail("decision", "submit-post", _); // G11: fail open, never silent
        confirm.disabled = false;
        // J4-08: restore the correct confirm label — mirrors the initial render,
        // including the self-evict irreversibility signal and non-binding round phrasing.
        confirm.textContent = confirmLabelFor(kind, pending.binding);
        // F-NEW-6: branch the recovery copy on the HTTP status — the correct next step
        // differs by failure mode and the player can't otherwise tell which. A 409 (the
        // board moved since this card armed) self-heals via the rearm seam, so we say so;
        // a 400 means the move itself was illegal (pick another); anything else (network
        // exception with no httpStatus, or a 5xx) is a connection problem. J4-09: err is
        // pre-declared role="alert" — setting textContent triggers the announcement.
        const status = _ && _.httpStatus;
        if (status === 409) {
          err.textContent = "The board moved since this card appeared — refreshing the latest state. Try again in a moment, or decide in conversation.";
          _recoverFrom409(); // API-2: actually DO the refresh the copy above promises
        } else if (_ && _.timedOut) {
          // N-12: no answer within the bound. The submit key is stable per card, so a retry is a verbatim replay (never a double-apply).
          err.textContent = "That is taking too long — it may not have reached the house. Tap Confirm to try again (it is safe).";
        } else if (status === 400) {
          err.textContent = "That move isn't legal right now — pick another, or decide in conversation.";
        } else {
          err.textContent = "Connection problem — that didn't reach the house. Try again, or decide in conversation.";
        }
      }
    });

    // #753 (Genius #15/16/17): the decision card is now a NON-BLOCKING ANCHORED ACTION-SHEET
    // (OrwellSheet, anchored placement) above the composer — deliberate, not a snap-modal that
    // blocks the whole screen, so the player can keep reading the room and still talk it out
    // instead. The sheet is the anchor/chrome (grabber + accent rim + glass fill); the existing
    // #orwell-decision-card element is appended INTO the sheet body so ALL its rich internals
    // (legal options, pick-count, the binding Confirm, the J5-20 risk skin, the per-signature
    // dismiss, the boot/poll rearm) and every CSS selector / escape-scope are untouched. The
    // decision is a live HARD-STOP affordance: the sheet renders dismissible:false (no kit ×, no
    // swipe-away) — the card carries its OWN .odec-x with the per-signature dismiss semantics, and
    // its card-scoped Escape still dismisses. Fail-open chain: OrwellSheet → the pre-#753
    // OrwellNotice anchor → the in-stream #chat-history.
    const hasSheet = !!(window.OrwellSheetKit && window.OrwellSheetKit.create &&
      (document.querySelector(".chat-input-bar") || document.getElementById("chat-bar") ||
       (window.OrwellNoticeKit && window.OrwellNoticeKit.ensureZone)));
    if (hasSheet) {
      _sheet = window.OrwellSheetKit.create({
        id: "orwell-decision-sheet",
        anchored: true,                 // non-modal: no scrim, no inert background — keep reading the room
        title: titleFor(kind, pending.binding),
        role: "group",                  // the inner card is the role="form" landmark; don't double it
        dismissible: false,             // a live hard-stop: the card owns its own .odec-x dismiss
      });
      const host = _sheet.ensure();     // the .ow-sheet-body of the anchored action-sheet
      // The sheet's title row would duplicate the card's own .odec-title — hide the sheet header so
      // the card brings the single title + risk badge (no double chrome).
      const sheetHead = _sheet.el && _sheet.el.querySelector(".ow-sheet-head");
      if (sheetHead) sheetHead.style.display = "none";
      host.appendChild(card);
    } else if (hasKit) {
      // Pre-#753 fallback: mount into the OrwellNotice kit's stacked above-composer zone (kind
      // "decision"). Suppress the kit × (dismissible:false) — the card carries its OWN .odec-x.
      _notice = window.OrwellNoticeKit.create({
        id: "orwell-decision-notice",
        kind: "decision",
        title: titleFor(kind, pending.binding),
        role: "presentation",
        dismissible: false,
        persistDismiss: false,
      });
      const host = _notice.ensure();   // the .on-body of the stacked kit card
      const kitHead = _notice.el && _notice.el.querySelector(".on-head");
      if (kitHead) kitHead.style.display = "none";
      host.appendChild(card);
    } else {
      chatBox.appendChild(card);
    }
    card.scrollIntoView({ block: "nearest" });
    // J3-18: move focus to the card so keyboard/SR users know a binding decision appeared.
    // tabindex=-1 allows programmatic focus without adding the card to the Tab order.
    card.setAttribute("tabindex", "-1");
    card.focus();
  }

  // chat.js dispatches this from advanceGame/submitDecision tool results.
  // D3/E66: a pending decision must survive a reload. The card is event-mounted
  // on live turns; on boot (and on a game change) we re-arm it from the status
  // route's cached `pending` — the engine's own legal-options view. Without this,
  // refreshing mid-decision left the player with no card and no signal.
  let _userDismissed = false;   // set when the player explicitly dismisses (×/Escape)
  // F2 (audit): the signature of the pending the player dismissed, so a later `gamechanged`
  // (or the status re-poll) re-arms a genuinely NEW decision but NEVER re-shoves the SAME card
  // the player just waved away to decide in conversation.
  let _dismissedSig = null;
  const _sig = (p) => (p && p.kind)
    ? p.kind + "|" + ((p.options || []).map((o) => o && o.id).join(",")) + "|" + (p.prompt || "")
    : "";
  async function rearmFromStatus() {
    try {
      const r = await fetch("/api/orwell/status", { credentials: "same-origin" });
      if (!r.ok) return;
      const st = await r.json();
      const pending = st && st.pending && st.pending.kind ? st.pending : null;
      if (!pending) return;
      // F2: don't re-nag the EXACT card the player dismissed — a `gamechanged` / re-poll of the
      // SAME pending must stay dismissed; only a genuinely DIFFERENT pending re-arms.
      if (_userDismissed && _sig(pending) === _dismissedSig) return;
      _userDismissed = false;   // a fresh (different) pending arrived — honor it again
      // The game build mounts #chat-history ASYNCHRONOUSLY and then renders the session's
      // history INTO it after DOMContentLoaded — a boot rearm that fired early either had
      // no host or got wiped when the history re-rendered, so a refresh mid-decision left
      // the player with no card (the E66 path was a no-op in practice). Re-assert the card
      // until it is STABLY mounted (survives the boot history render), then stop — never
      // fight an explicit dismissal or a submit (both set _userDismissed).
      let stable = 0;
      for (let i = 0; i < 25 && !_userDismissed; i++) {
        const host = document.getElementById("chat-history");
        // A lingering "✓ Locked in" (.odec-done) card from the PRIOR decision must not block a NEW
        // pending from arming (audit 2026-06-20): the next round's card could otherwise be suppressed
        // by the done-card still holding CARD_ID during its 4s fade. Treat it as absent so the fresh
        // decision card replaces it; a LIVE (not-done) card is left alone (stable branch below).
        const _doneCard = document.getElementById(CARD_ID);
        if (_doneCard && _doneCard.classList.contains("odec-done")) _doneCard.remove();
        if (host && !document.getElementById(CARD_ID)) {
          window.dispatchEvent(new CustomEvent("orwell:pending", { detail: { pending } }));
          stable = 0;
        } else if (document.getElementById(CARD_ID)) {
          if (++stable >= 3) break;   // survived ~600ms → boot settled, stop re-asserting
        }
        await new Promise((res) => setTimeout(res, 200));
      }
    } catch (_) { /* fail open */ }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", rearmFromStatus, { once: true });
  } else { rearmFromStatus(); }
  window.addEventListener("orwell:gamechanged", rearmFromStatus);
  // S4-1 (E2E audit) — the structural escape hatch: a pending player decision must be reachable
  // WITHOUT the chat agent ever dispatching it. `orwell:gamechanged` fires only on a LOCAL
  // game-mutating tool, so a pending that surfaces with no such event in this tab (the model
  // narrated past it without calling submitDecision, another device advanced, a missed tool call)
  // would otherwise sit unreachable until a reload. Poll the engine's own `pending` on a slow
  // cadence as a backstop. This deliberately does NOT call rearmFromStatus (which clears
  // _userDismissed) — it surfaces a pending ONLY when the player hasn't dismissed it and no card
  // is already up, so it never re-nags a waved-away card. Fail-open everywhere.
  async function _backstopPending() {
    try {
      // WS race guard: the interval is cleared on `orwell:ws-active`, but a `_backstopPending`
      // call ALREADY awaiting the fetch keeps running — so re-check `_wsActive()` before we start
      // AND after each await, BEFORE dispatching. Otherwise an in-flight status read could surface
      // a STALE/duplicate card after the WS `state` push has already taken over. (`_wsActive` is a
      // hoisted fn declaration below.)
      if (_wsActive()) return;
      if (document.getElementById(CARD_ID)) return;    // a card is already showing
      if (!document.getElementById("chat-history")) return;
      const r = await fetch("/api/orwell/status", { credentials: "same-origin" });
      if (!r.ok || _wsActive()) return;                // WS took over while the fetch was in flight
      const st = await r.json();
      if (_wsActive()) return;                          // …or while parsing the body — do not dispatch
      const pending = st && st.pending && st.pending.kind ? st.pending : null;
      // F-NEW-4: respect a dismissal PER SIGNATURE, not as a blanket flag — the old
      // unconditional `if (_userDismissed) return` let a dismissed low-stakes pending
      // suppress a genuinely DIFFERENT, later card (e.g. nominations) on this backstop.
      // Stay silent ONLY for the EXACT card the player waved away (the F2 signature guard);
      // a new pending surfaces normally without re-nagging the dismissed one. This still does
      // NOT clear _userDismissed (no re-nag of the waved-away card).
      if (_userDismissed && pending && _sig(pending) === _dismissedSig) return;
      if (pending && !document.getElementById(CARD_ID)) {
        window.dispatchEvent(new CustomEvent("orwell:pending", { detail: { pending } }));
      }
    } catch (_) { /* fail open — the conversation path always remains */ }
    // F14 (#1013): the eviction goodbye/vote card was surfacing a full WEEK late on the old 15s
    // cadence (the model narrates the eviction with no mutating tool, so the per-tool `orwell:pending`
    // seam never fires and only this poll catches it). Tighten to ~2.5s so a player-owned pending the
    // chat narrated past appears almost immediately. Still respects an explicit dismissal (the
    // per-signature guard above) and short-circuits when a card is already up — no extra nag, no churn.
  }
  // WS Phase-1 (§4): when the multiplexed socket is LIVE the server PUSHES a `state` frame on every
  // board change (a surfacing pending IS a board change); platform.js relays it to the ONE
  // `orwell:gamechanged` dispatcher, which already runs `rearmFromStatus` above — and that surfaces
  // the pending (respecting the same per-signature dismissal). So this 2.5s backstop STANDS DOWN in
  // WS mode and stays edge-triggered. Off/fallback ⇒ it is the PERMANENT backstop (without WS,
  // `orwell:gamechanged` fires only on a LOCAL mutating tool, so a narrated-past / cross-device
  // pending would otherwise sit unreachable until a reload). Fail-soft: any doubt ⇒ keep polling.
  function _wsActive() {
    try { return !!(window.OrwellWs && window.OrwellWs.isActive && window.OrwellWs.isActive()); }
    catch (_) { return false; }
  }
  let _backstopTimer = null;
  function _startBackstop() {
    if (_backstopTimer) { clearInterval(_backstopTimer); _backstopTimer = null; }
    if (!_wsActive()) _backstopTimer = setInterval(_backstopPending, 2500);
  }
  // Armed only in the app shell — the kit demo page loads this module for ensureStyles()
  // alone and must not run a forever-interval (see the _inAppShell probe above).
  if (_inAppShell) {
    _startBackstop();
    // Cancel the poll the instant the socket goes live; resume it if it falls back to SSE
    // (_startBackstop re-arms only while !_wsActive()).
    window.addEventListener("orwell:ws-active", () => {
      if (_backstopTimer) { clearInterval(_backstopTimer); _backstopTimer = null; }
    });
    window.addEventListener("orwell:ws-inactive", _startBackstop);
  }

  window.addEventListener("orwell:pending", (e) => {
    try {
      render(e.detail && e.detail.pending);
    } catch (_) { /* fail open — the conversation path always remains */ }
  });

  // The tiny public seam (mirrors window.OrwellNoticeKit et al): the element-kit demo page
  // composes the .odec-* classes statically and calls ensureStyles() to get the kit's
  // injected structural CSS without a live pending. Additive — the live card path is untouched.
  window.OrwellDecisionStyles = { ensureStyles };

  // ── T0-3 (issue #1778, D1 2026-07-21) — the BeatAnnouncement broadcast CHYRON ────────────────
  //
  // ADR 0003 amendment ("the chat gains a stage, not a dashboard"): every committed closed-set
  // ceremony fact (HOH winner, nominations, veto winner, the veto decision, the replacement
  // nominee, the anonymized ballot sequence, the eviction result) is now emitted by the engine as
  // a Vault-free `BeatAnnouncementView` (src/ports/GameSession.ts) on the SAME advanceGame /
  // submitDecision tool result the g15 seam and the pending card above already read — so
  // two-window mirror parity (F5) is INHERITED here, not re-derived: both windows render the
  // identical tool result via the existing SSE mirror. Extends this SAME kit/file (the .odec
  // structural conventions — entrance animation, shadow/radius tokens) but is intentionally
  // simpler than the decision card above: a chyron is a BROADCAST, not a binding guardrail — no
  // confirm, no dismiss-forfeits-your-turn semantics, no sheet-hosting. Staged CARD-BY-CARD (a
  // short stagger between announcements landing in the same batch — a veto decision immediately
  // followed by its replacement nominee, or a batch of eviction ballots) mirrors the staged
  // eviction reveal's own one-ballot(-batch)-at-a-time cadence.
  const _CHYRON_ICON = {
    "hoh-winner": "\u{1F3C6}", nominations: "\u{1F528}", "veto-winner": "\u{1F48E}",
    "veto-decision": "\u{1F48E}", "replacement-nominee": "\u{1F528}", "secret-veto": "\u{1F575}",
    "eviction-ballot": "\u{1F5F3}️", "eviction-result": "\u{1F5F3}️", "comp-round-result": "\u{1F3C1}", "final-hoh-part": "\u{1F3C6}",
    "correction": "\u{1F4FC}",  // #1785 AC3: diegetic control-room correction card
    "veto-field": "\u{1F48E}",  // ORW-281 4b: the veto field is set (the six who play)
  };
  const _CHYRON_KICKER = {
    "hoh-winner": "Head of Household", nominations: "Nominations", "veto-winner": "Power of Veto",
    "veto-decision": "Veto Ceremony", "replacement-nominee": "Replacement Nominee", "secret-veto": "Secret Veto",
    "eviction-ballot": "Live Vote", "eviction-result": "Eviction", "comp-round-result": "Competition", "final-hoh-part": "Final HOH",
    "correction": "Control Room",  // #1785 AC3: diegetic control-room correction card
    "veto-field": "Power of Veto",  // ORW-281 4b
  };
  // F4: dedup by announcement id — a chyron renders exactly once per session. Backed ALSO by a DOM
  // check (`data-chyron-id`) so a transcript replay on reload — which re-delivers the SAME historical
  // tool result before this module's in-memory Set has seen it this page load — still renders it only
  // once (the DOM already carries the prior render from the earlier page's own dispatch, OR the reload
  // path's own historical-render pass already painted it; either way this seam skips a re-paint).
  const _chyronSeen = new Set();
  function _chyronCss() {
    if (document.getElementById("orwell-chyron-css")) return;
    const st = document.createElement("style");
    st.id = "orwell-chyron-css";
    st.textContent = `
      .ow-chyron {
        margin: .5rem auto; max-width: 640px; border-radius: 12px; padding: .65rem .85rem;
        background: var(--panel, #111); color: var(--fg, #9cdef2);
        border: 1px solid var(--accent, var(--gold, #d9a441));
        font-family: var(--ow-ui-font); font-size: var(--ow-fs-body, .875rem); line-height: 1.4;
        box-shadow: var(--win-shadow, 0 8px 32px rgba(0, 0, 0, 0.45));
        animation: ow-chyron-in .22s ease-out;
        display: flex; align-items: flex-start; gap: .5rem;
      }
      .ow-chyron .ow-chyron-icon { font-size: 1.1em; line-height: 1; flex: none; }
      .ow-chyron .ow-chyron-text { flex: 1 1 auto; }
      .ow-chyron .ow-chyron-kicker {
        display: block; font-size: .7rem; letter-spacing: .06em; text-transform: uppercase;
        color: color-mix(in srgb, var(--fg, currentColor) 73%, transparent);
        margin-bottom: .15rem;
      }
      @keyframes ow-chyron-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) { .ow-chyron { animation: none; } }
    `;
    document.head.appendChild(st);
  }

  function _buildChyronCard(a) {
    _chyronCss();
    const card = document.createElement("div");
    card.className = "ow-chyron ow-chyron-" + esc(a.kind || "");
    card.setAttribute("data-chyron-id", a.id);
    card.setAttribute("role", "status");
    const icon = _CHYRON_ICON[a.kind] || "\u{1F4FA}";
    const kicker = _CHYRON_KICKER[a.kind] || "Big Brother";
    card.innerHTML =
      '<span class="ow-chyron-icon" aria-hidden="true">' + icon + "</span>" +
      '<span class="ow-chyron-text"><span class="ow-chyron-kicker">' + esc(kicker) + "</span>" +
      esc(a.headline || "") + "</span>";
    return card;
  }

  function _chyronInDom(id) {
    try { return !!document.querySelector('[data-chyron-id="' + CSS.escape(id) + '"]'); }
    catch (_) { return false; }
  }

  function _renderChyron(a) {
    if (!a || !a.id || _chyronSeen.has(a.id)) return;
    _chyronSeen.add(a.id);
    if (_chyronInDom(a.id)) return;
    const chatBox = document.getElementById("chat-history");
    if (!chatBox) return;
    const kicker = _CHYRON_KICKER[a.kind] || "Big Brother";
    chatBox.appendChild(_buildChyronCard(a));
    try { chatBox.scrollTop = chatBox.scrollHeight; } catch (_) {}
    try { if (window.orwellAnnounce) window.orwellAnnounce(esc(kicker) + ": " + esc(a.headline || "")); } catch (_) {}
  }

  // Chyron persistence: a HISTORY render (reload / soft-reload / the canonical addMessage builder) repaints the
  // announcements that were stored with the turn, in the SAME place a live card lands — immediately AFTER the turn's
  // bubble (`anchor`), in order. Synchronous (no stagger), silent (no live-region announce: the player already heard
  // it), deduped by the DOM `data-chyron-id` (the DOM is the truth on a fresh render; the in-memory Set is only
  // seeded so a later live re-delivery of the same id cannot paint it twice).
  function _renderChyronsAfter(list, anchor) {
    if (!Array.isArray(list) || !list.length || !anchor || !anchor.parentNode) return;
    let at = anchor;
    list.forEach(function(a) {
      if (!a || !a.id) return;
      _chyronSeen.add(a.id);
      let existing = null;
      try { existing = document.querySelector('[data-chyron-id="' + CSS.escape(a.id) + '"]'); } catch (_) { existing = null; }
      // Already painted (a live card, or an earlier repaint): keep ITS position in the ordered run — advance the anchor to it so the
      // cards after it land after it, never reversing a partially rendered batch.
      if (existing) { if (existing.parentNode === at.parentNode) at = existing; return; }
      const card = _buildChyronCard(a);
      at.parentNode.insertBefore(card, at.nextSibling);
      at = card;
    });
  }

  function _announceBatchCoalesced(rendered) {
    if (!rendered.length) return;
    if (rendered.length === 1) {
      try { if (window.orwellAnnounce) window.orwellAnnounce(rendered[0].kicker + ": " + rendered[0].headline); } catch (_) {}
      return;
    }
    // Check if all items share the same kicker (homogeneous batch)
    var firstKicker = rendered[0].kicker;
    var allSameKicker = rendered.every(function(r) { return r.kicker === firstKicker; });
    if (allSameKicker) {
      try { if (window.orwellAnnounce) window.orwellAnnounce(firstKicker + ": " + rendered.length + (rendered.length === 1 ? " announcement" : " announcements")); } catch (_) {}
    } else {
      // Mixed batch — join unique kicker+headline combos
      var seen = {};
      var parts = [];
      rendered.forEach(function(r) {
        var key = r.kicker + r.headline;
        if (!seen[key]) { seen[key] = true; parts.push(r.kicker + ": " + r.headline); }
      });
      try { if (window.orwellAnnounce) window.orwellAnnounce(parts.join("; ")); } catch (_) {}
    }
  }

  function _renderChyronBatch(list) {
    if (!Array.isArray(list) || !list.length) return;
    var rendered = [];
    list.forEach(function(a, i) {
      if (!a || !a.id) return;
      var willRender = !_chyronSeen.has(a.id) && !(function() {
        try { return !!document.querySelector('[data-chyron-id="' + CSS.escape(a.id) + '"]'); }
        catch (_) { return false; }
      })();
      if (i === 0) {
        _renderChyron(a);
        if (willRender) rendered.push({ kicker: _CHYRON_KICKER[a.kind] || "Big Brother", headline: a.headline || "" });
        return;
      }
      setTimeout(function() {
        _renderChyron(a);
        if (willRender) rendered.push({ kicker: _CHYRON_KICKER[a.kind] || "Big Brother", headline: a.headline || "" });
        if (i === list.length - 1) {
          setTimeout(function() {
            _announceBatchCoalesced(rendered);
          }, 300);
        }
      }, i * 260);
    });
  }

  // Fed by chat.js's tool-result seam (mirrors `orwell:pending` immediately above — the SAME
  // advanceGame/submitDecision tool result, so this needs no new transport and no new polling).
  window.addEventListener("orwell:announcements", (e) => {
    try { _renderChyronBatch(e.detail && e.detail.announcements); }
    catch (_) { /* fail open — the model's own prose still carries the beat as color */ }
  });

  // #1785 AC3: diegetic control-room correction card — piggybacks on the SAME
  // orwell:gamechanged event (no second dispatcher) via the correction detail
  // field that platform.js now carries when the engine emits a post-air correction.
  window.addEventListener("orwell:gamechanged", (e) => {
    try {
      const c = e.detail && e.detail.correction;
      if (c && typeof c === 'string' && c.trim()) {
        _renderChyron({
          kind: 'correction',
          id: 'correction-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          headline: '\u{1F4FC} The control room reviewed the tape \u2014 ' + c.trim(),
        });
      }
    } catch (_) { /* fail open */ }
  });

  // The tiny public seam (mirrors OrwellDecisionStyles): exposed for tests and the element-kit
  // demo page, and so a caller can seed the dedup set (e.g. from an already-rendered transcript
  // replay) without a live DOM query on every historical tool result.
  window.OrwellChyron = { render: _renderChyron, renderBatch: _renderChyronBatch, renderAfter: _renderChyronsAfter, _seen: _chyronSeen };
})();
