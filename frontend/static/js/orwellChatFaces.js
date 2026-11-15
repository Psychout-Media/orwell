// OWN-8 — chat-transcript sender faces. Every rendered chat message row in the GAME build
// carries a small designed face (the shared OrwellMonogram kit, M2-2) beside its role label:
//   · player rows ("You")      → the player's REAL casting headshot — the roster player card's
//                                portrait (G26/G27: the cropped photo IS the portrait + avatar),
//                                or the finalized account avatar pre-season — monogram fallback;
//   · NPC-voiced rows          → that houseguest's persisted roster portrait (the #1324 shared
//                                cache), designed monogram fallback;
//   · Production/narrator rows → the kit monogram seeded by the Production name (the designed
//                                neutral mark — never bare initials, never an invented logo).
//
// ONE seam covers every render path. Chat rows land in #chat-history as direct children on the
// history/reload render (chatRenderer.addMessage), the live stream + finalize (chat.js), resume
// (resumeStream), reconcile (chatReconcile.softReloadHistory) AND the ADR 0012 mirror — so this
// decorates via a MutationObserver on the transcript container instead of forking each builder.
// That choice is deliberate for a second reason: chat.js's `_setRoleModelLabel` legitimately
// WIPES the .role element's children on every live relabel (it re-appends only the timestamp),
// so a face inserted at build time would not survive a live relabel anyway — the observer
// re-decorates on exactly that mutation, and rows already carrying a current face are skipped
// via a signature (cheap + idempotent).
//
// Render-only and Vault-free by construction: the inputs are the row's own PUBLIC label text
// (the visible attribution) + the public roster card (id/name/status/portrait — the same card
// every cast surface renders). Portraits are PRIMARY (owner ruling); the designed monogram is
// the no-photo fallback only; small faces take the kit's tight face-weighted crop
// (`ow-mono-crop`). The face is decorative chrome (~24px, rounded like .odec-face), aria-hidden,
// and (ORW-359) a tap target only when it resolves to a roster houseguest.
//
// NON-GAME build: hard-gated on body[data-game-build] (the M2-7 pattern) — the observer bails,
// no face is ever inserted, and the injected CSS is scoped under body[data-game-build], so the
// inherited workspace look is byte-identical.
//
// g15: this file only LISTENS for `orwell:gamechanged` (platform.js's ONE debounced dispatcher)
// — to re-resolve faces once the shared portrait cache warms — plus `orwell:avatarchanged`
// (the G27 headshot-finalize event). It never dispatches, never polls (one-shot settle timers
// only, no setInterval), and never fetches: all data comes from the kit cache / OrwellAvatar.
(function () {
  "use strict";
  // Monotonic per-page generation of the player's ACCOUNT avatar — bumped on every
  // orwell:avatarchanged so a replaced photo mints a fresh face sig + fetch url.
  let _avatarGen = 0;

  function gameBuild() {
    return !!(document.body && document.body.hasAttribute("data-game-build"));
  }
  function narratorName() {
    return (typeof window !== "undefined" && window.ORWELL_GAME_NARRATOR) || "Production";
  }

  function ensureCss() {
    if (document.getElementById("ow-chatfaces-css")) return;
    const s = document.createElement("style");
    s.id = "ow-chatfaces-css";
    s.textContent =
      // The face holder slots into the .role flex row (style.css: display:flex; gap:6px),
      // sized with the kit's small-chip family (.odec-face is 22px/r6) and NEVER the tap
      // target (the role label keeps its own hit area; the face is pointer-inert).
      "body[data-game-build] #chat-history .msg > .role .ow-chatface {" +
      "  width: 24px; height: 24px; border-radius: 7px; overflow: hidden;" +
      "  flex: 0 0 auto; display: inline-block; position: relative; pointer-events: none; }" +
      // ORW-359: a face that resolves to a roster houseguest is a tap target (the chat's delegated
      // listener in orwellChatNames.js opens the cast card); the role label keeps its own hit area.
      "body[data-game-build] #chat-history .msg > .role .ow-chatface[data-hg] { pointer-events: auto; cursor: pointer; }" +
      "body[data-game-build] #chat-history .msg > .role .ow-chatface .ow-mono-face {" +
      "  width: 100%; height: 100%; }" +
      // The face replaces the generic model dot (same slot, same rhythm as .has-logo).
      "body[data-game-build] #chat-history .msg > .role.ow-has-face::before { display: none; }";
    document.head.appendChild(s);
  }

  // The row's visible attribution: the .role element's TEXT NODES only (the label), never the
  // timestamp span / status tags / this face itself. Both builders write the label as a text
  // node (chatRenderer sets textContent then appends the timestamp; chat.js writes esc(label)
  // + the timestamp span), so text nodes ARE the label.
  function labelOf(roleEl) {
    let t = "";
    for (const n of roleEl.childNodes) {
      if (n.nodeType === 3) t += n.textContent;
    }
    return t.trim();
  }

  function accountName() {
    const el = document.getElementById("user-bar-name");
    const t = el ? (el.textContent || "").trim() : "";
    return t && t !== "User" ? t : null;
  }

  // PURE face resolution — kind: 'user' | 'ai'; label: the row's visible attribution; deps:
  // {narrator, playerCard, cardFor, avatarPresent, playerName} (injected so the Node test can
  // drive it headless). Returns {sig, card, crop, forceMono} or null (defer — e.g. no label yet).
  // Portraits are PRIMARY: a real photo always wins; the monogram is the no-photo fallback.
  function resolveFaceDescriptor(kind, label, deps) {
    if (kind === "user") {
      const pc = deps.playerCard ? deps.playerCard() : null;
      let portrait = (pc && pc.portrait) || null;
      // The avatar route is a FIXED url, so a REPLACED avatar would reuse the old sig and the
      // signature-gated decorate() would skip the refresh — ride the avatarchanged generation
      // into the url so both the sig and the <img> fetch move with the new photo.
      if (!portrait && deps.avatarPresent && deps.avatarPresent()) {
        portrait = "/api/orwell/avatar?v=" + (deps.avatarGen ? deps.avatarGen() : 0);
      }
      const name = (pc && pc.name) || (deps.playerName ? deps.playerName() : null) || "You";
      return {
        sig: "u|" + ((pc && pc.id) || "") + "|" + (portrait || "mono:" + name),
        card: { id: (pc && pc.id) || "player", name: name, portrait: portrait },
        hg: (pc && pc.id) || null,
        crop: !!portrait,
        forceMono: false,
      };
    }
    if (!label) return null; // not yet labeled (spinner/placeholder) — decorate on relabel
    const narrator = deps.narrator();
    if (label === narrator || label === "Orwell" || label.indexOf(narrator + " ") === 0) {
      // The show's production voice: the designed kit monogram seeded by the narrator name — the
      // season's producer once the engine resolves it (#1626), else the "Production" default. The
      // seed tracks `narratorName()` (window.ORWELL_GAME_NARRATOR), so the mark stays in lock-step
      // with the byline text and is stable per season.
      return {
        sig: "p|" + narrator,
        card: { id: narrator, name: narrator, portrait: null },
        crop: false,
        forceMono: true,
      };
    }
    const card = deps.cardFor ? deps.cardFor(label) : null;
    if (card) {
      return {
        sig: "n|" + card.id + "|" + (card.portrait || ""),
        card: { id: card.id, name: card.name || label, status: card.status, portrait: card.portrait || null },
        hg: card.id,
        crop: !!card.portrait,
        forceMono: false,
      };
    }
    // Unknown attribution (cold cache / non-roster voice): still a DESIGNED tile, seeded by the
    // public label — upgrades to the portrait on the next sweep once the cache resolves it.
    return {
      sig: "x|" + label,
      card: { id: label, name: label, portrait: null },
      crop: false,
      forceMono: true,
    };
  }

  const _deps = {
    narrator: narratorName,
    playerCard: function () {
      const M = window.OrwellMonogram;
      return M && typeof M.playerCard === "function" ? M.playerCard() : null;
    },
    cardFor: function (ref) {
      const M = window.OrwellMonogram;
      return M && typeof M.cardFor === "function" ? M.cardFor(ref) : null;
    },
    avatarPresent: function () {
      const A = window.OrwellAvatar;
      return !!(A && typeof A.present === "function" && A.present());
    },
    avatarGen: function () { return _avatarGen; },
    playerName: accountName,
  };

  function decorate(wrap) {
    if (!wrap || wrap.nodeType !== 1 || !wrap.classList.contains("msg")) return;
    if (!(wrap.classList.contains("msg-user") || wrap.classList.contains("msg-ai"))) return;
    const M = window.OrwellMonogram;
    if (!M || typeof M.face !== "function") return;
    const roleEl = wrap.querySelector(":scope > .role");
    if (!roleEl) return;
    const kind = wrap.classList.contains("msg-user") ? "user" : "ai";
    const r = resolveFaceDescriptor(kind, labelOf(roleEl), _deps);
    if (!r) return;
    // Idempotent: same identity + same portrait AND the face still in the DOM ⇒ nothing to do.
    // (chat.js's _setRoleModelLabel wipes .role children on relabel — the dataset survives, the
    // face doesn't — so presence is checked, not assumed.)
    if (roleEl.dataset.owfaceSig === r.sig && roleEl.querySelector(".ow-chatface")) return;
    ensureCss();
    const old = roleEl.querySelector(".ow-chatface");
    if (old) old.remove();
    const holder = document.createElement("span");
    holder.className = "ow-chatface";
    if (r.hg) {
      // ORW-359: a roster face opens that houseguest's cast card (delegated click + keydown).
      holder.setAttribute("data-hg", String(r.hg));
      holder.setAttribute("role", "button");
      holder.setAttribute("aria-label", "Open " + (r.card.name || "houseguest") + "'s cast card");
      holder.tabIndex = 0;
    } else {
      holder.setAttribute("aria-hidden", "true"); // decorative — the label text is the name
    }
    try {
      holder.appendChild(M.face(r.card, { alt: "", forceMono: r.forceMono, crop: r.crop }));
    } catch (_) {
      return; // fail open — the row keeps its plain label
    }
    roleEl.insertBefore(holder, roleEl.firstChild);
    roleEl.classList.add("ow-has-face");
    roleEl.dataset.owfaceSig = r.sig;
  }

  // ── scheduling: coalesce mutation bursts into one microtask pass ─────────────────────────
  const _pending = new Set();
  let _flushQueued = false;
  function schedule(el) {
    if (!el) return;
    _pending.add(el);
    if (_flushQueued) return;
    _flushQueued = true;
    queueMicrotask(function () {
      _flushQueued = false;
      if (!gameBuild()) { _pending.clear(); return; }
      const batch = Array.from(_pending);
      _pending.clear();
      for (const el of batch) {
        try { decorate(el); } catch (_) { /* fail open, row by row */ }
      }
    });
  }

  function sweep() {
    if (!gameBuild()) return;
    const box = document.getElementById("chat-history");
    if (!box) return;
    box.querySelectorAll(":scope > .msg").forEach(schedule);
  }

  function onMutations(records) {
    if (!gameBuild()) return;
    for (const rec of records) {
      const t = rec.target;
      // A relabel wipes .role's children (see above) — re-decorate that row.
      if (t && t.nodeType === 1 && t.classList && t.classList.contains("role")) {
        const wrap = t.closest ? t.closest(".msg") : null;
        if (wrap) schedule(wrap);
      }
      for (const n of rec.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.classList && n.classList.contains("msg")) schedule(n);
        else if (n.querySelectorAll) n.querySelectorAll(".msg").forEach(schedule);
      }
    }
  }

  function boot() {
    const box = document.getElementById("chat-history");
    if (!box) return;
    try {
      new MutationObserver(onMutations).observe(box, { childList: true, subtree: true });
    } catch (_) { /* decoration becomes sweep-only — still fail open */ }
    sweep();
    // Settle passes (one-shot, NOT polls): the kit's portrait cache + the avatar probe are
    // async at boot — re-resolve once they have had a chance to land.
    setTimeout(sweep, 1600);
    setTimeout(sweep, 4500);
  }

  // Cache-warm re-resolution: the kit refreshes its roster cache off the same events; give its
  // fetch a beat to land, then upgrade monogram → portrait in place (signature-gated).
  function resweepSoon() { sweep(); setTimeout(sweep, 1200); }
  window.addEventListener("orwell:gamechanged", resweepSoon);
  // Bump the generation FIRST so the resweep resolves a fresh avatar sig (see resolveFaceDescriptor).
  window.addEventListener("orwell:avatarchanged", function () { _avatarGen++; resweepSoon(); });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();

  // Exposed for tests / other kit surfaces (render-only helpers, no I/O).
  window.OrwellChatFaces = { resolveFaceDescriptor: resolveFaceDescriptor, refresh: sweep };
})();
