// Orwell season retrospective (feature 0048 / C17) — the post-season payoff surface.
//
// While a season is live this module shows NOTHING (the Wall is absolute; the /retrospective
// route 404s by the engine's terminal-state gate). Once a winner is crowned it offers:
//   • the season RECAP — arc highlights straight from the event record (never chat memory), and
//   • "Open the Producer's Vault" — the unsealed hidden story: the off-screen scheming, the
//     private confessionals, and the twist that never fired.
//
// Fail-open, render-only (route payloads verbatim), game-build gated. The panel AUGMENTS the
// reunion chat (the model hosts it via seasonRecap/seasonRetrospective levers); nothing here
// progresses the game.
//
// Lane F migration (2026-06-19): this panel COMPOSES the window kit — chrome, drag, minimize,
// Escape, focus, and the ONE position system (the clamped slot offset "retro") come from
// OrwellWindow; the old bespoke fixed-position + ow-dismiss banner are gone. 0054 Phase 2: it is
// DOCKABLE — the player can tuck it into the control-room rail (post-season only); the dock flag
// persists. Content-driven visibility: the panel self-display:none while live so the rail's
// observer hides it, and shows once the season is finished.
(function () {
  "use strict";

  const POLL_MS = 30000;
  const ID = "orwell-retro";
  // #780: monochrome icon language — a mono inline SVG (currentColor), not a full-color
  // emoji. A film-clapper / playback glyph for "the season, watched back". Drives the
  // dock chip (the kit renders the titlebar from `title`, kept emoji-free above).
  const ICON = "<svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='2' y='6' width='20' height='14' rx='2'/><path d='M2 10h20'/><circle cx='8' cy='15' r='2'/><circle cx='16' cy='15' r='2'/><path d='M2 6l3-3M8 6l3-3M14 6l3-3'/></svg>";
  // #1371: on a rail-visible (wide) tier the retrospective DOCKS into the control-room rail by
  // default (the existing `.gadget-rail-body > #orwell-retro { order: 8 }` slot) instead of floating
  // the top-right slot window OVER the in-flow rail cards and down into the composer band — the
  // reported occlusion (retro↔composer, retro↔status/presence, retro↔room-strip). On the narrow /
  // no-rail tier the rail is a closed drawer, so it stays a floating, dismissible/draggable sheet,
  // height-capped in the injected CSS below so it can never reach the composer. This is a tier-aware
  // DEFAULT only: a user's own dock/undock choice persists and wins (the kit's loadDocked). It is
  // resolved once at window-create time, mirroring the kit's own per-construct dock model (dock is
  // not re-homed on a live viewport resize for ANY window — the primary steady-state occlusion at
  // each tier is what's fixed; a rare resize-across-the-breakpoint case can be re-docked by hand).
  const railTier = () => {
    try { return !(window.matchMedia && window.matchMedia("(max-width: 768px)").matches); }
    catch (_) { return true; }
  };
  const ready = (fn) =>
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", fn, { once: true })
      : fn();

  let timer = null;
  let _failures = 0;
  function _pollDelay() { return Math.min(POLL_MS * Math.pow(2, _failures), 180000); }
  let unsealed = null; // cached after the player opens the Vault
  let _lastRecap = null; // last-good recap (perf/resilience): a transient recap-poll blip must not blank the open panel
  let _lastSig = null; // J5-10 (TRANS-3): signature of the last render, to skip redundant rebuilds

  async function getJSON(url) {
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  // ORW-320: the nightly reflections are written AFTER the crown by the utility model (background), so a freshly opened Vault may lack them. Re-read the
  // retrospective a few times (45s apart, at most 8) while any houseguest still has a night without one; the engine's story stands if none ever arrives.
  let _reflTries = 0, _reflTimer = null;
  function _reflectionCount(u) {
    return ((u && u.houseYouNeverSaw) || []).reduce((n, h) => n + ((h.reflections || []).length), 0);
  }
  function _reflectionsPending(u) {
    return ((u && u.houseYouNeverSaw) || []).some((h) => (h.reflectionNights || []).length > (h.reflections || []).length);
  }
  function _watchReflections() {
    if (_reflTimer || !unsealed || !_reflectionsPending(unsealed) || _reflTries >= 8) return;
    _reflTimer = setTimeout(async () => {
      _reflTimer = null; _reflTries += 1;
      try {
        const data = await getJSON("/api/orwell/retrospective");
        if (data && data.retrospective) { unsealed = data.retrospective; if (_lastRecap) render(_lastRecap); }
      } catch (_) { /* fail-open: the story stands without them */ }
      _watchReflections();
    }, 45000);
  }

  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // The kit owns chrome/drag/dock/Escape/focus + the ONE position system (slotKey
  // "retro"); this module owns only the recap body (which it re-renders each tick).
  let _win = null;
  let _body = null;
  function ensurePanel() {
    let panel = document.getElementById(ID);
    if (panel) return panel;
    const content = document.createElement("div");
    content.innerHTML = `
      <style>
        #orwell-retro { width: min(380px, 92vw); font-size: 13px; line-height: 1.5; }
        #orwell-retro .oretro-body { display: block; }
        @media (max-width: 768px) {
          #orwell-retro { width: auto !important; max-width: none !important; }
          /* #1371: on the narrow / no-rail tier the retrospective floats as a top sheet — cap the
             WINDOW so it can NEVER reach the bottom chrome. The room-strip (#orwell-notice-zone)
             sits DIRECTLY above the composer, so the retro must clear the WHOLE above-composer zone,
             not just the composer bar. The reserve = the composer band (--composer-clearance, synced
             to the live composer height in init.js) + a top-banner (--on-banner-inset) + a 178px lump
             = the slot's top chrome (~65px narrowTopBase) + a GENEROUS above-composer allowance
             (~113px — the notice-zone is dynamic: the room-strip is ~61px, but a role-badge chip or a
             transient 2nd notice card can grow it, and the composer must NEVER be occluded, so we
             reserve well past the measured strip). The window becomes a flex column so the kit
             .ow-body scrolls WITHIN the cap (nothing dropped — the receipts scroll). Scoped
             :not(.ow-docked) so it only shapes a FLOATING retro (a docked one is rail-flow — the rail
             owns its scroll). overflow:hidden is safe here: edge/corner resize is off on this tier
             (kit mobileSkip 768). vh first, dvh second (dvh tracks the keyboard-shrunk mobile
             viewport; vh is the no-dvh fallback). */
          #orwell-retro:not(.ow-docked) {
            display: flex; flex-direction: column; overflow: hidden;
            max-height: calc(100vh - var(--composer-clearance, 84px) - var(--on-banner-inset, 0px) - 178px) !important;
            max-height: calc(100dvh - var(--composer-clearance, 84px) - var(--on-banner-inset, 0px) - 178px) !important;
          }
          #orwell-retro:not(.ow-docked) .ow-body { flex: 1 1 auto; min-height: 0; max-height: none !important; }
          /* A live decision card OUTRANKS the recap on the narrow tier. A pre-jury evictee is left holding the 0133
             finale-interview card after the crown while the finished-season retro is ALSO due, and the two cannot
             co-fit a phone viewport: the retro (a top sheet) reached down over the card's anchored action-sheet above
             the composer. The card is the player's pending obligation, so the FLOATING retro yields until it is
             answered or dismissed (the card's own x / Escape); the retro then returns by itself. Pure CSS - the card
             element is the signal - so there is no second poll and no state to drift. A docked retro is rail-flow
             and never overlaps, so it is untouched. */
          body:has(#orwell-decision-card) #orwell-retro:not(.ow-docked) { display: none !important; }
        }
      </style>
      <div class="oretro-body" data-role="body"></div>`;
    _win = window.OrwellWindowKit.create({
      // #780: monochrome icon language — no full-color emoji in the titlebar (the kit
      // renders `title` verbatim). The glyph is the mono SVG `icon` slot.
      id: ID, title: "The Season, Watched Back", icon: ICON,
      // top-right slot: the retrospective must NOT share a slot with the post-season
      // "New season" window (bottom-right) — post-season both are open, and stacking
      // two windows in one corner shoved the second off-screen. Distinct slots ⇒ no
      // shared stack (the slot stacking offset is also viewport-clamped in orwellSlots).
      slot: "top-right", slotKey: "retro", role: "complementary",
      minimizable: true, closable: true, draggable: true,
      // 0054 Phase 2: dockable into the control-room rail. #1371: default DOCKED on a rail-visible
      // (wide) tier — the top-right float sat over the in-flow rail + composer — and floating on the
      // narrow / no-rail tier (where the rail is a closed drawer; the CSS cap above keeps that float
      // clear of the composer). A user's own dock/undock choice still persists and wins (loadDocked).
      dockable: true, defaultDocked: railTier(),
      content,
      onClose: () => {
        // Dismissing the floating panel for the session (mirrors the old ow-dismiss).
        try { sessionStorage.setItem("orwell-retro-dismissed", "1"); } catch (_) {}
        _win = null; _body = null;
      },
    });
    _win.open();
    panel = document.getElementById(ID);
    _body = panel.querySelector('[data-role="body"]');
    return panel;
  }

  // Show/hide via the panel root's own display (content-driven for the rail's observer).
  function showPanel(on) {
    const panel = document.getElementById(ID);
    if (!panel) return;
    if (_win && _win.isMinimized && _win.isMinimized()) return; // parked: leave it
    panel.style.display = on ? "" : "none";
  }

  function render(recap) {
    if (!recap || !recap.finished) { showPanel(false); return; }
    if (sessionStorage.getItem("orwell-retro-dismissed") === "1") { showPanel(false); return; }
    ensurePanel();
    if (!_body) return;
    // J5-10 (TRANS-3): the recap is terminal/immutable once the season is finished — re-rendering
    // the whole body on every 30s poll snapped the reader's scroll to the top and dropped keyboard/
    // SR focus to <body>. Skip the rebuild when nothing changed; only a real change (the Vault
    // unseal) re-renders. The full body teardown then happens at most twice (recap, then unsealed).
    const sig = JSON.stringify({ w: recap.winner && recap.winner.name, wk: recap.weeksPlayed,
      h: (recap.highlights || []).length, u: !!unsealed, p: recap.placement, m: recap.margin, rf: _reflectionCount(unsealed) });
    if (sig === _lastSig && _body.childNodes.length) { showPanel(true); return; }
    _lastSig = sig;
    // ORW-320: a rebuild (the post-crown reflections arriving) must not snap the reader's opened houseguest sections shut.
    const _openHouse = new Set([..._body.querySelectorAll("details.oretro-house[open]")].map((d) => d.getAttribute("data-houseguest")));
    _body.replaceChildren();

    // J5-09: the winner is the panel's apex — give it real typographic weight, not the same
    // 13px/0.9 as a mid-season highlight line.
    if (recap.winner) _body.appendChild(el("div", "margin-bottom:10px;font-size:1.1rem;font-weight:700;letter-spacing:-0.02em", "👑 " + recap.winner.name + " won the season (week " + recap.weeksPlayed + ")."));

    // J5-18: the player's OWN result is the payoff for the most common outcome (a losing player) —
    // the panel headlined only the winner. Surface the player's placement (and, if they sat in the
    // Final 2, the jury margin) with real weight, right under the crown. Route-provided & PUBLIC
    // (placement + margin are post-season facts); absent ⇒ silently skipped (fail-open).
    if (recap.placement) {
      // winner | runner-up | jury | evicted — winner is already the apex line above, so don't double it.
      const PLACE = {
        "runner-up": "You finished 2nd — runner-up.",
        jury: "You finished in the jury.",
        evicted: "You were evicted before jury.",
      };
      const line = PLACE[recap.placement];
      if (line) {
        const result = el("div",
          "margin-bottom:10px;padding:8px 10px;border-radius:8px;font-size:1rem;font-weight:600;background:var(--accent-soft, rgba(109,74,255,0.14));border-left:3px solid var(--accent, #6d4aff)",
          line);
        // Finalists lost (or won) the jury by a margin — name it. margin = winner's lead in votes.
        if (recap.placement === "runner-up" && typeof recap.margin === "number" && recap.margin > 0) {
          result.appendChild(el("div", "margin-top:4px;font-size:0.85rem;font-weight:400;opacity:0.85",
            "Lost the jury vote by " + recap.margin + (recap.margin === 1 ? " vote." : " votes.")));
        }
        _body.appendChild(result);
      }
    }

    // GADGET-8: the old -12 cap could silently drop the season's best EARLY beat (a week-1/2
    // blindside) at the one screen that's supposed to pay it off — exactly backwards for a
    // "watched back" reel. Raised to match hiddenStory's own non-degradation posture; the panel
    // body already scrolls (.ow-body in orwellWindow.js), so nothing needs to be cut to fit.
    const list = el("ul", "margin:6px 0;padding-left:18px;opacity:0.85");
    for (const h of (recap.highlights || []).slice(-40)) list.appendChild(el("li", "", h));
    _body.appendChild(list);

    const vaultWrap = el("div", "margin-top:8px");
    if (unsealed) {
      // J5-07: a real section heading (was <strong>, invisible to SR heading navigation — WCAG 1.3.1).
      // UX-4: the bare leading emoji is decorative — give an explicit accessible name
      // (emoji stripped) so a screen reader reads the heading, not "lock …".
      const _vaultHd = el("h3", "margin:4px 0 4px;font-size:inherit", "🔓 The Untold Story");
      _vaultHd.setAttribute("aria-label", "The Untold Story");
      vaultWrap.appendChild(_vaultHd);
      if (unsealed.twists && unsealed.twists.length) {
        const t = el("div", "margin:4px 0;opacity:0.9");
        t.textContent = unsealed.twists.map((x) =>
          x.firedWeek ? `a ${x.kind} fired in week ${x.firedWeek}` : `a ${x.kind} was sealed but never fired`,
        ).join(" · ");
        vaultWrap.appendChild(t);
      }
      // S6-3 (audit): hiddenStory[].type can be a raw internal pathway id (e.g.
      // "overheard:offscreen:strategy:…"); never surface it verbatim — show its leading channel
      // segment in prose. Clean enum values ("confessional", "overheard") pass through unchanged.
      const humanizeStoryType = (t) => {
        const head = String(t || "").split(/[:|/]/)[0].replace(/[_-]+/g, " ").trim().toLowerCase();
        return head || "note";
      };
      // J5-09 (SOCIAL-3): the per-voter "who really voted against you" reveal is the signature
      // secret-ballot payoff — render it FIRST (right under the twists), not buried beneath the
      // hidden-story dump below.
      // E12: eviction ballots were anonymous all season ("a vote to evict …"); the retrospective is
      // the ONE place per-voter attribution unseals. Names only (the data pairs id+name; a raw id is never rendered).
      if (unsealed.evictionVotes && unsealed.evictionVotes.length) {
        const _votesHd = el("h3", "display:block;margin:12px 0 4px;font-size:inherit", "🗳 How the votes really fell");
        _votesHd.setAttribute("aria-label", "How the votes really fell");  // UX-4: decorative emoji
        vaultWrap.appendChild(_votesHd);
        const votes = el("ul", "margin:6px 0;padding-left:18px;opacity:0.85;font-size:12.5px");
        for (const wk of unsealed.evictionVotes) {
          const against = (wk.votes || [])
            .filter((v) => v.votedFor && wk.evictee && v.votedFor.id === wk.evictee.id)
            .map((v) => v.voter && v.voter.name).filter(Boolean);
          const who = against.length ? against.join(", ") : "no one on the record";
          votes.appendChild(el("li", "",
            `Week ${wk.week}: ${(wk.evictee && wk.evictee.name) || "—"} was sent out by ${who}.`));
        }
        vaultWrap.appendChild(votes);
      }
      // ENDGAME-3: the finale jury vote unseals here too (SG7/#1030) — mirrors evictionVotes above,
      // right beneath it, same styling. Engine builds this only once the finale's votes are tallied
      // (`GameSessionAdapter.buildVaultUnseal`); absent on a pre-finale-vote season, so guarded.
      if (unsealed.juryVotes && unsealed.juryVotes.votes && unsealed.juryVotes.votes.length) {
        const _juryHd = el("h3", "display:block;margin:12px 0 4px;font-size:inherit", "🗳 How the jury voted");
        _juryHd.setAttribute("aria-label", "How the jury voted");  // UX-4: decorative emoji
        vaultWrap.appendChild(_juryHd);
        const juryList = el("ul", "margin:6px 0;padding-left:18px;opacity:0.85;font-size:12.5px");
        for (const v of unsealed.juryVotes.votes) {
          const juror = v.juror && v.juror.name;
          const votedFor = v.votedFor && v.votedFor.name;
          if (!juror || !votedFor) continue;
          juryList.appendChild(el("li", "", `${juror} voted for ${votedFor}.`));
        }
        vaultWrap.appendChild(juryList);
      }
      // ORW-98 (#1934): three things the engine already supplies at this one sanctioned unseal (0048) that
      // the panel never rendered - each evictee's exit interview (0130), the weekly Diary-Room pull-quote reel
      // (#1396) and the player's OWN confessionals (0115). Render-only, textContent, NAMES only (the engine
      // pairs id+name / speaker display names; a raw id is never shown). Each section is skipped when empty.
      // ORW-285 (#2412 note): a model-authored quote or message can carry a raw `npc:<id>`; never show it (names only).
      const clean = (t) => String(t).replace(/npc:\d+/g, "someone");
      const section = (title, items) => {
        const hd = el("h3", "display:block;margin:12px 0 4px;font-size:inherit", title);
        vaultWrap.appendChild(hd);
        const ul = el("ul", "margin:6px 0;padding-left:18px;opacity:0.85;font-size:12.5px");
        for (const t of items) ul.appendChild(el("li", "", t));
        vaultWrap.appendChild(ul);
      };
      const exits = (unsealed.exitInterviews || []).filter((x) => x && x.evictee && x.evictee.name);
      if (exits.length) {
        section("The exit interviews", exits.map((x) =>
          `Week ${x.week}: ${x.evictee.name} left ${x.stance || "quietly"}` + (x.message ? ` — “${clean(x.message)}”` : "") + "."));
      }
      if (unsealed.finaleInterview && unsealed.finaleInterview.stance) {
        section("Your finale-night interview", [`You were ${unsealed.finaleInterview.stance}` +
          (unsealed.finaleInterview.message ? ` — “${clean(unsealed.finaleInterview.message)}”` : "") + "."]);
      }
      const reel = [];
      for (const wk of (unsealed.pullQuoteReel || [])) {
        for (const q of (wk.quotes || [])) {
          if (q && q.quote && q.speaker) {
            reel.push(`Week ${wk.week} — ${q.source === "player-diary" ? "your Diary Room" : q.speaker + " (confessional)"}: “${clean(q.quote)}”`);
          }
        }
      }
      if (reel.length) section("The Diary Room reel", reel);
      const mine = (unsealed.playerConfessionals || []).filter((c) => typeof c === "string" && c.trim()).map(clean);
      if (mine.length) section("Your own confessionals", mine);
      // ORW-320 (spec 0146 slice 7): "the house you never saw" - one COLLAPSED section per houseguest (a native <details>: phone-readable, tap-to-open,
      // keyboard + SR friendly, inside this kit window). Render-only, textContent, names + days only (the engine pairs id+name and scrubs every sentence;
      // a raw id is never shown). A lie is MARKED beside what they said; a secret ballot says it was never aired. Absent/empty => skipped (fail-open).
      const house = (unsealed.houseYouNeverSaw || []).filter((h) => h && h.houseguest && h.houseguest.name);
      if (house.length) {
        const _houseHd = el("h3", "display:block;margin:12px 0 2px;font-size:inherit", "The house you never saw");
        vaultWrap.appendChild(_houseHd);
        vaultWrap.appendChild(el("div", "opacity:0.7;font-size:11.5px;margin-bottom:4px", "Who they really were, house guest by house guest. Tap a name to open."));
        for (const h of house) {
          const d = el("details", "margin:4px 0;border-radius:8px;background:var(--surface-2, rgba(127,127,127,0.10))");
          d.className = "oretro-house";
          if (_openHouse.has(h.houseguest.name)) d.open = true;
          d.setAttribute("data-houseguest", h.houseguest.name);
          const sum = el("summary", "cursor:pointer;min-height:44px;padding:10px;display:flex;align-items:center;font-weight:600;list-style-position:inside",
            h.houseguest.name + (h.leftWeek ? " (out in week " + h.leftWeek + ")" : ""));
          d.appendChild(sum);
          const inner = el("div", "padding:0 10px 10px;font-size:12.5px;line-height:1.5");
          const sub = (t) => inner.appendChild(el("div", "margin:8px 0 2px;font-weight:600", t));
          const list = (items) => { const ul = el("ul", "margin:2px 0;padding-left:18px;opacity:0.9"); for (const t of items) ul.appendChild(el("li", "", clean(t))); inner.appendChild(ul); };
          if (h.seasonAim) {
            sub("Their season aim: " + clean(h.seasonAim.aim));
            if ((h.seasonAim.why || []).length) list(["Why: " + h.seasonAim.why.map(clean).join("; ")]);
          }
          if ((h.goals || []).length) {
            sub("Their goals, in order");
            list(h.goals.map((g) => `${g.from}: ${g.aim} - ${g.ended}.` + ((g.why || []).length ? ` Because ${g.why.map(clean).join("; ")}.` : "")));
          }
          if ((h.decisions || []).length) {
            sub("What they did, and what they said");
            const ul = el("ul", "margin:2px 0;padding-left:18px;opacity:0.9");
            for (const x of h.decisions) {
              const li = el("li", "", `Week ${x.week}, day ${x.day}: ${clean(x.act)}. Real reason: ${clean(x.real)}. `
                + (x.aired === false ? "Secret ballot, never said aloud; the line they would have given: " : "They said: ") + clean(x.said));
              if (x.honesty === "lie" || x.honesty === "part-truth") {
                const tag = el("strong", "margin-left:4px;color:var(--danger, #c0392b)", x.honesty === "lie" ? "(a lie)" : "(only part of the truth)");
                tag.className = "oretro-lie";
                li.appendChild(tag);
              }
              ul.appendChild(li);
            }
            inner.appendChild(ul);
          }
          if (h.longCon) {
            sub("Their long con");
            list([`Kept ${clean(h.longCon.mark)} close from ${h.longCon.from}: ${clean(h.longCon.plan)}. ${clean(h.longCon.ended)}.`
              + ((h.longCon.why || []).length ? ` Because ${h.longCon.why.map(clean).join("; ")}.` : "")]);
          }
          if ((h.reflections || []).length) {
            sub("Their nights");
            list(h.reflections.map((r) => `Day ${r.night}: “${clean(r.text)}”`));
          }
          d.appendChild(inner);
          vaultWrap.appendChild(d);
        }
      }
      // ENDGAME-1: the full hidden story, not just the latest 40 — a completed season with off-screen
      // sim, gossip diffusion, confessionals, threads, and seeded ties easily runs to hundreds of rows,
      // and dropping the early/mid season silently guts the "you were blindsided, and it was real all
      // along" payoff (a non-degradation violation at the ONE surface whose job is the full receipts).
      // The panel scrolls (`.ow-body { overflow:auto; max-height:… }` in orwellWindow.js), so nothing
      // needs to be dropped to keep the window a sane size.
      const story = el("ul", "margin:6px 0;padding-left:18px;opacity:0.85;font-size:12.5px");
      for (const h of (unsealed.hiddenStory || [])) {
        // J5-11: prose annotation, not "[bracketed]" metadata that reads as a debug log.
        const lbl = humanizeStoryType(h.type);
        story.appendChild(el("li", "", lbl.charAt(0).toUpperCase() + lbl.slice(1) + " — " + h.content));
      }
      vaultWrap.appendChild(story);
    } else {
      // #775 element-kit migration: the unseal CTA composes .ow-btn .ow-btn-prominent — the kit is
      // the ONE source of truth for the button chrome (tap-floor, radius, weight, the frosted glass
      // treatment; emphasis by luminosity, not hue). Only the panel-specific LAYOUT (top margin)
      // stays inline — the chrome that used to live here (J5-08 tap-floor + #fff-on-accent contrast)
      // is now the kit's. Inline chrome had to go so the kit rule can take effect (inline beats it).
      const open = el("button", "margin-top:4px", "🔐 Open the Untold Story");
      open.className = "ow-btn ow-btn-prominent";
      open.setAttribute("aria-label", "Open the Untold Story");  // UX-4: decorative lock emoji
      open.addEventListener("click", async () => {
        try {
          const data = await getJSON("/api/orwell/retrospective");
          unsealed = data.retrospective || null;
          render(recap);
        } catch (_) {
          if (window.OrwellReport) window.OrwellReport.fail("retrospective", "vault-open", _); // G11: fail open, never silent
          open.textContent = "The Vault would not open — try again";
        }
      });
      vaultWrap.appendChild(open);
      vaultWrap.appendChild(el("div", "opacity:0.6;font-size:11.5px;margin-top:3px",
        "The hidden story they never showed you — scheming, confessionals, the twist that never fired."));
    }
    _body.appendChild(vaultWrap);
    showPanel(true);
    _watchReflections();
  }

  async function tick() {
    if (document.hidden) { timer = setTimeout(tick, _pollDelay()); return; }
    if (_win && _win.setLoading) _win.setLoading(true); // non-blocking refresh hint over the last recap
    try {
      const state = await getJSON("/api/orwell/state");
      if (!state || !state.started) { _lastRecap = null; render(null); unsealed = null; _failures = 0; return; }
      const data = await getJSON("/api/orwell/recap");
      _lastRecap = data ? data.recap : null;
      render(_lastRecap);
      _failures = 0;
    } catch (_) {
      _failures += 1;
      if (window.OrwellReport) window.OrwellReport.fail("retrospective", "recap-poll", _); // G11: fail open, never silent
      // Reuse the last-good recap so a transient blip never blanks an open retrospective; only an
      // honest "no game / not finished" (the try-branch above) clears it. A new game clears it via
      // the started:false branch, so a stale finished-season panel can never linger across a reset.
      if (_lastRecap) render(_lastRecap); else render(null);
    } finally {
      if (_win && _win.setLoading) _win.setLoading(false);
      timer = setTimeout(tick, _pollDelay());
    }
  }

  // Seam for the headless gate (mirrors the other panels): build + show on demand.
  window._orwellRetroEnsure = () => { ensurePanel(); return true; };

  ready(() => {
    if (document.body && document.body.dataset.gameBuild !== "1") return;
    tick();
    window.addEventListener("beforeunload", () => timer && clearTimeout(timer));
  });
})();
