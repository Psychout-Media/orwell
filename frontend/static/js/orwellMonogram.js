// M2-2 (audit B3) — the designed monogram portrait system + role badges. ONE component,
// consumed by the cast window, the rail chips (cast pin), and the decision cards, so a
// portrait-less roster reads as sixteen DESIGNED cast cards, never flat letter-rectangles.
//
// The template (owner mock: docs/mocks/m2-2-monogram-template.html):
//   • a two-tone diagonal gradient — hue seeded from the houseguest id (deterministic across
//     reloads/devices; Vault-free: the id/name are the public roster card),
//   • a low-opacity broadcast pattern (scanlines / dot grid / signal arcs / chevrons — the
//     family is id-seeded too, so tiles differ in TEXTURE, not just hue),
//   • two-letter initials in tight, heavy type + a thin inner "camera bug" ring.
// Role badges (fixed set per the M2-2 DoR): HOH crown · nominee target · veto V · winner star —
// composited bottom-right on ANY face (generated portrait or monogram). Eviction is NOT a badge:
// it stays the L16 grayscale rule (the only monochrome state), which the component owns.
//
// Everything here is render-only and Vault-free by construction: inputs are the public roster
// card ({id, name, status, portrait}) + a public ceremony role. No fetches, no numbers, no
// hidden state — a surface that has roles passes them; one that doesn't renders plain faces.
(function () {
  "use strict";

  // FNV-1a over the id string — the one deterministic seed for hue AND pattern. The id is
  // stable for the season (the roster card id), so every surface derives the same tile.
  function hash(id) {
    let h = 0x811c9dc5;
    const s = String(id == null ? "" : id);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    // Murmur3-style avalanche finalizer: plain FNV-1a leaves near-identical short ids
    // ("hg-1"…"hg-16") with correlated hues — sixteen tiles read as four color families.
    // The finalizer decorrelates single-char differences so the roster spreads the wheel.
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }

  function hueFor(id) { return hash(id) % 360; }

  const PATTERNS = ["lines", "dots", "arcs", "chevrons"];
  function patternFor(id) { return PATTERNS[(hash(id) >>> 9) % PATTERNS.length]; }

  function initialsFor(name) {
    const words = String(name || "?").trim().split(/\s+/).filter(Boolean);
    let ini = "?";
    if (words.length === 1) ini = words[0].slice(0, 2).toUpperCase();
    else if (words.length > 1) ini = (words[0][0] + words[words.length - 1][0]).toUpperCase();
    // The svg string is consumed via innerHTML — strip markup-significant chars so a
    // hostile "name" can never smuggle structure (names are corpus-sourced; this is belt).
    return ini.replace(/[&<>"']/g, "").trim() || "?";
  }

  // The pattern families — drawn in the LIGHT tone at low opacity so they read as broadcast
  // texture behind the initials, never as noise. Each is authored for a 100×100 viewBox.
  function patternMarkup(kind, hue, uid) {
    const tone = `hsl(${hue} 65% 78%)`;
    if (kind === "dots") {
      let c = "";
      for (let y = 10; y < 100; y += 16) {
        for (let x = 10; x < 100; x += 16) c += `<circle cx="${x}" cy="${y}" r="2.1"/>`;
      }
      return `<g fill="${tone}" opacity=".13">${c}</g>`;
    }
    if (kind === "arcs") {
      let c = "";
      for (let r = 18; r <= 120; r += 20) c += `<circle cx="100" cy="0" r="${r}"/>`;
      return `<g fill="none" stroke="${tone}" stroke-width="3" opacity=".12">${c}</g>`;
    }
    if (kind === "chevrons") {
      let c = "";
      for (let y = -10; y < 120; y += 22) c += `<path d="M-5 ${y} L50 ${y + 14} L105 ${y}"/>`;
      return `<g fill="none" stroke="${tone}" stroke-width="4" opacity=".11">${c}</g>`;
    }
    // "lines" — diagonal scanlines, the broadcast default.
    let c = "";
    for (let i = -100; i < 110; i += 13) c += `<line x1="${i}" y1="110" x2="${i + 110}" y2="0"/>`;
    return `<g stroke="${tone}" stroke-width="3.5" opacity=".12">${c}</g>`;
  }

  // The designed monogram tile as an SVG string (square, scales to its holder). `uid`
  // namespaces the gradient id so multiple tiles on one page never cross-reference.
  let _uidSeq = 0;
  function svg(card, opts) {
    const id = (card && card.id) || (card && card.name) || "?";
    const hue = hueFor(id);
    const hue2 = (hue + 40) % 360;
    const pat = patternFor(id);
    const uid = "owm" + (++_uidSeq);
    const ini = initialsFor(card && card.name);
    const fontSize = ini.length > 1 ? 34 : 40;
    return (
      `<svg class="ow-mono-svg" viewBox="0 0 100 100" role="img" aria-hidden="true" focusable="false">` +
      `<defs><linearGradient id="${uid}" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="hsl(${hue} 55% 34%)"/>` +
      `<stop offset="1" stop-color="hsl(${hue2} 60% 17%)"/>` +
      `</linearGradient></defs>` +
      `<rect width="100" height="100" fill="url(#${uid})"/>` +
      patternMarkup(pat, hue, uid) +
      // the thin inner "camera bug" ring — the frame that makes it a CARD, not a swatch
      `<rect x="4.5" y="4.5" width="91" height="91" fill="none" rx="3"` +
      ` stroke="hsl(${hue} 70% 85%)" stroke-opacity=".22" stroke-width="1.5"/>` +
      `<text x="50" y="50" dy=".36em" text-anchor="middle"` +
      ` font-family="-apple-system, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif"` +
      ` font-weight="800" font-size="${fontSize}" letter-spacing="-1"` +
      ` fill="hsl(${hue} 30% 94%)" fill-opacity=".95">${ini}</text>` +
      `</svg>`
    );
  }

  // ── the fixed role-badge set (M2-2 DoR) ───────────────────────────────────────────────
  // Small circular chips composited bottom-right; monochrome white glyph on a role tint.
  // Eviction is deliberately NOT here — grayscale (L16) is the eviction language.
  const BADGES = {
    hoh:     { tint: "#c9930f", label: "Head of Household",
               glyph: '<path d="M5 13.5 L5 7.5 L8.2 10.2 L12 5 L15.8 10.2 L19 7.5 L19 13.5 Z" fill="#fff"/>' +
                      '<rect x="5" y="15" width="14" height="2.4" rx="1" fill="#fff"/>' },
    nominee: { tint: "#b83a2e", label: "Nominated",
               glyph: '<circle cx="12" cy="12" r="6.4" fill="none" stroke="#fff" stroke-width="2"/>' +
                      '<circle cx="12" cy="12" r="2.1" fill="#fff"/>' },
    veto:    { tint: "#1c7f86", label: "Veto holder",
               glyph: '<path d="M6.5 6 L12 18 L17.5 6" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>' },
    winner:  { tint: "#c9930f", label: "Winner",
               glyph: '<path d="M12 4.4 L14.2 9.4 L19.6 9.9 L15.6 13.5 L16.8 18.8 L12 16 L7.2 18.8 L8.4 13.5 L4.4 9.9 L9.8 9.4 Z" fill="#fff"/>' },
  };

  function badgeSvg(role) {
    const b = BADGES[role];
    if (!b) return "";
    // role="img" so the accessible name (aria-label) is PERMITTED: a bare <span> defaults to
    // the `generic` role, which prohibits naming — axe flags `aria-prohibited-attr` (#1375-g).
    // The badge is a single labeled icon; its inner <svg> stays aria-hidden, so the span is the
    // one exposed image, named "Winner" / "Head of Household" / … for assistive tech. Visual
    // is untouched (role/aria attrs paint nothing).
    return (
      `<span class="ow-mono-badge ow-mono-badge-${role}" role="img" title="${b.label}" aria-label="${b.label}"` +
      ` style="background:${b.tint}">` +
      `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${b.glyph}</svg></span>`
    );
  }

  function ensureCss() {
    if (document.getElementById("ow-monogram-css")) return;
    const s = document.createElement("style");
    s.id = "ow-monogram-css";
    s.textContent =
      // the face holder: square, clipped, position anchor for the badge composite
      ".ow-mono-face { position: relative; display: block; width: 100%; height: 100%;" +
      "  border-radius: inherit; overflow: hidden; }" +
      ".ow-mono-face .ow-mono-svg, .ow-mono-face img { display: block; width: 100%; height: 100%;" +
      "  object-fit: cover; }" +
      // eviction = the L16 monochrome rule, owned here so every consumer agrees
      ".ow-mono-face.ow-mono-evicted img, .ow-mono-face.ow-mono-evicted .ow-mono-svg" +
      "  { filter: grayscale(1) brightness(.82); }" +
      // OWN-8 — the TIGHT face-weighted crop for SMALL avatars (chat rows, speaker chips,
      // decision chips: ≲32px). Portraits are head-and-shoulders framings; at chip size the
      // face reads too small, so small consumers opt in via opts.crop / .ow-mono-crop and the
      // kit zooms toward the upper-center face region. Photos only — the designed monogram
      // (initials tile) is already composed for tiny sizes and never crops.
      ".ow-mono-face.ow-mono-crop img { object-position: 50% 24%;" +
      "  transform: scale(1.45); transform-origin: 50% 26%; }" +
      // the badge chip: bottom-right, ~34% of the face, white glyph on the role tint
      ".ow-mono-badge { position: absolute; right: 3%; bottom: 3%; width: 34%; height: 34%;" +
      "  min-width: 13px; min-height: 13px; max-width: 30px; max-height: 30px;" +
      "  border-radius: 50%; display: flex; align-items: center; justify-content: center;" +
      "  box-shadow: 0 1px 3px rgba(0,0,0,.45), inset 0 0 0 1.5px rgba(255,255,255,.75); }" +
      ".ow-mono-badge svg { width: 72%; height: 72%; display: block; }";
    document.head.appendChild(s);
  }

  // The one shared entry point: a face element for a roster card.
  //   card: {id, name, status, portrait} (the public roster card; portrait may be null)
  //   opts: {role: 'hoh'|'nominee'|'veto'|'winner'|null, forceMono: bool, alt: string,
  //          crop: bool — OWN-8: the tight face-weighted crop for small (≲32px) consumers;
  //          photos only, the monogram is untouched}
  // Returns a .ow-mono-face element — portrait <img> when a ref exists (unless forceMono),
  // else the designed monogram; badge composited on either; evicted ⇒ grayscale on either.
  function face(card, opts) {
    ensureCss();
    opts = opts || {};
    const el = document.createElement("span");
    el.className = "ow-mono-face";
    const status = (card && card.status) || "active";
    if (status === "evicted") el.className += " ow-mono-evicted";
    if (opts.crop) el.className += " ow-mono-crop";
    if (card && card.portrait && !opts.forceMono) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = opts.alt || (card.name || "");
      // #11: a still-generating / 404 portrait ref must heal to the designed monogram, not
      // show the browser's broken-image glyph (this is the shared face used by ceremony slates,
      // decision cards, the premiere strip and the docked rail). Rebuild the monogram inner +
      // re-composite the role badge, exactly as the else-branch below would have.
      img.onerror = function () {
        img.onerror = null;
        // The monogram svg is aria-hidden, so the swap would drop the only accessible name the
        // <img> alt carried. Move that label onto the .ow-mono-face wrapper so the face keeps its
        // name on the broken-portrait path.
        // role="group" (NOT "img"): role="img" makes descendants presentational, which would drop
        // the composited role-badge chip out of the accessibility tree; group keeps the badge in the
        // tree while still carrying the portrait's accessible name via aria-label.
        const _label = img.alt || (card && card.name) || "";
        if (_label) { el.setAttribute("role", "group"); el.setAttribute("aria-label", _label); }
        el.innerHTML = svg(card, opts);
        if (opts.role && BADGES[opts.role]) el.insertAdjacentHTML("beforeend", badgeSvg(opts.role));
      };
      img.src = card.portrait;
      el.appendChild(img);
    } else {
      el.innerHTML = svg(card, opts);
    }
    if (opts.role && BADGES[opts.role]) el.insertAdjacentHTML("beforeend", badgeSvg(opts.role));
    return el;
  }

  // Public ceremony roles from the status payload (/api/orwell/status) — a tiny shared
  // mapper so every consumer derives id→role identically. Precedence when one houseguest
  // holds several (SG-15): winner > hoh > veto > nominee (the rarer, more decision-critical
  // state wins the single badge slot; surfaces with room can show text for the rest).
  function rolesFrom(status) {
    const roles = {};
    if (!status || typeof status !== "object") return roles;
    const id = (v) => (v && typeof v === "object" ? v.id || v.name : v);
    (status.nominees || []).forEach((n) => { const k = id(n); if (k) roles[k] = "nominee"; });
    const veto = id((status.veto || {}).holder);
    if (veto) roles[veto] = "veto";
    const hoh = id(status.hoh);
    if (hoh) roles[hoh] = "hoh";
    const winner = id(status.winner);
    if (winner) roles[winner] = "winner";
    return roles;
  }

  // ── SHARED PORTRAIT CACHE (issue #1324) ───────────────────────────────────────────────
  // Two `face()` consumers were permanently starved of real portraits: ceremony slates
  // (orwellToolBeats.js) never passed `portrait` at all, and the premiere cast strip
  // (orwellStatusPanel.js) hard-coded `portrait: null, forceMono: true`. orwellDecision.js and
  // orwellFinale.js already solved this — each keeps its OWN private id→portrait cache, fetched
  // from the public roster route and refreshed on the ONE `orwell:gamechanged` dispatcher event
  // (platform.js — CLAUDE.md's g15 rule: exactly one dispatcher, no new poll, no ad-hoc
  // CustomEvent). Centralizing that pattern here means every current AND future face-drawing
  // surface gets real portraits for free instead of re-deriving its own copy.
  //
  // Vault-free by construction: reads ONLY the public roster projection (id/name/status/portrait
  // — the same public card every cast surface already renders). Best-effort/fail-open: an
  // unfetched or failed cache simply leaves `portraitFor()` returning null, so every face falls
  // back to the designed monogram (the sanctioned default) and self-heals on the next refresh —
  // it never blocks or delays a render. `svg()`/`face()` stay pure and synchronous; only this
  // cache does I/O, and it does so out-of-band from any render call.
  const _portraitById = Object.create(null);
  const _idByName = Object.create(null); // OWN-8: public name (lowercased) → roster id
  let _rosterFetchedAt = 0;
  let _rosterFetchSeq = 0; // out-of-order guard: only the LATEST in-flight refresh may apply
  function portraitFor(id) {
    if (id == null) return null;
    return _portraitById[String(id)] || null;
  }
  // OWN-8 — the full public roster card for an id OR a public display name (the roster names
  // are the same public identity every cast surface renders; still Vault-free). Returns
  // {id, name, status, portrait, isPlayer} or null while the cache is cold/missing.
  function cardFor(ref) {
    if (ref == null) return null;
    const k = String(ref);
    if (_portraitById[k]) return Object.assign({ id: k }, _portraitById[k]);
    const byName = _idByName[k.trim().toLowerCase()];
    if (byName && _portraitById[byName]) return Object.assign({ id: byName }, _portraitById[byName]);
    return null;
  }
  // OWN-8 — the player's OWN roster card (isPlayer: true — /api/orwell/roster serves it first),
  // so surfaces that draw the player (chat rows) find the casting headshot the same way NPC
  // surfaces find portraits. Null pre-season / while the cache is cold.
  function playerCard() {
    for (const k of Object.keys(_portraitById)) {
      if (_portraitById[k].isPlayer) return Object.assign({ id: k }, _portraitById[k]);
    }
    return null;
  }
  // ORW-359 — every cached public roster card (player included), for the chat name-link pass.
  function allCards() {
    return Object.keys(_portraitById).map((k) => Object.assign({ id: k }, _portraitById[k]));
  }
  async function refreshPortraitCache(force) {
    if (typeof fetch !== "function") return; // non-browser eval (node-executed test harnesses)
    const now = Date.now();
    if (!force && now - _rosterFetchedAt < 8000) return; // /roster is already polled elsewhere too
    _rosterFetchedAt = now;
    const seq = ++_rosterFetchSeq;
    try {
      const r = await fetch("/api/orwell/roster", { credentials: "same-origin" });
      if (seq !== _rosterFetchSeq) return; // a newer refresh superseded this one — drop the stale response
      if (!r.ok) {
        // The server answered and said no (no game / reset / unauthorized): clear so a NEW
        // season with reused ids can never render the OLD game's faces (greptile P1 on #1328).
        // A transient network REJECTION (catch below) deliberately keeps the cache — the true
        // reset path always reaches here or the successful repopulate.
        for (const k of Object.keys(_portraitById)) delete _portraitById[k];
        for (const k of Object.keys(_idByName)) delete _idByName[k];
        return;
      }
      const data = await r.json();
      if (seq !== _rosterFetchSeq) return; // (json() awaited too — re-check before applying)
      const roster = Array.isArray(data && data.roster) ? data.roster : [];
      for (const k of Object.keys(_portraitById)) delete _portraitById[k];
      for (const k of Object.keys(_idByName)) delete _idByName[k];
      for (const hg of roster) {
        if (hg && hg.id != null) {
          // OWN-8: keep the WHOLE public card (name/isPlayer joined the portrait/status pair)
          // so cardFor()/playerCard() can serve every face consumer from the one cache.
          _portraitById[String(hg.id)] = {
            portrait: hg.portrait || null,
            status: hg.status || "active",
            name: hg.name || null,
            isPlayer: !!hg.isPlayer,
          };
          if (hg.name) _idByName[String(hg.name).trim().toLowerCase()] = String(hg.id);
        }
      }
    } catch (_) { /* fail open — every consumer keeps rendering the monogram fallback */ }
  }
  if (typeof window !== "undefined") {
    refreshPortraitCache(true);
    window.addEventListener("orwell:gamechanged", () => refreshPortraitCache(true));
    // OWN-8 — close the M3-2 dangling seam: markdown.js's speaker chips already probe
    // `window.orwellResolveHouseguestId(name)` to seed a chip by the REAL roster id (exact
    // cross-surface hue + portrait-cache key match) but nothing ever defined it. The shared
    // cache is the natural owner. Fail-soft: cold cache ⇒ null ⇒ the chip seeds by name.
    if (typeof window.orwellResolveHouseguestId !== "function") {
      window.orwellResolveHouseguestId = function (name) {
        const c = cardFor(name);
        return c ? c.id : null;
      };
    }
  }

  window.OrwellMonogram = {
    face, svg, badgeSvg, rolesFrom, hueFor, patternFor, initialsFor, ensureCss,
    portraitFor, refreshPortraitCache, cardFor, playerCard, allCards,
  };
})();
