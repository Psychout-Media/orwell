// adaptiveGlass.js — DYNAMIC legibility for Liquid Glass over ANY background.
//
// Apple's Regular variant "blurs AND adjusts the luminosity of background content to
// maintain legibility" — the material is more muted over BRIGHT content and stays
// translucent/lit over DARK content, so foreground text/controls stay readable on any
// backdrop (a photo, a light theme, a gradient, the dark chat). A single static veil
// can't do that: tuned translucent for dark, it fails over a bright photo; tuned opaque
// for bright, it reads as a heavy slab over dark.
//
// So this module is the "smart" layer: for each glass surface it SAMPLES the backdrop
// luminance directly behind that surface and scales the surface's neutral veil opacity
// to it — gentle over dark, stronger over bright — keeping the theme's --fg text legible
// regardless of what's behind. It is theme-correct by construction: the veil is the
// theme's own --panel (dark panel on dark themes, light panel on light themes), which is
// already the right contrast for the theme's --fg, so it floors contrast in EITHER
// polarity. It runs on EVERY engine (not Chromium-gated) and composes with the SVG
// refraction (that sets backdrop-filter; this sets background-color — no conflict).

(function () {
  "use strict";

  // Surfaces that carry the glass material (mirror style.css's frosted set + liquidGlass).
  // Adaptive legibility runs under BOTH glass tiers (keyed on theme-frosted), so this
  // list must cover EVERY newly-glassed surface — chrome, chat bubbles, transient
  // indicators — or those surfaces lose adaptive ink/veil. #orwell-headshot is excluded
  // (gating dialog, kept opaque in CSS).
  var SURFACES = [
    // — Chrome / large panels (no flip → mute) —
    ".ow-window", "#sidebar", ".icon-rail", ".modal-content", ".admin-card",
    ".chat-top-bar", ".og-card", ".on-card", ".toast",
    ".orwell-chat-hint", ".attach-card", ".dropdown", ".cp-popover",
    // — Chat bubbles (large → mute, no flip) —
    ".msg-ai", ".msg-user", ".msg-ooc",
    // — Small bars / transient pills (flip ink) —
    ".chat-input-bar", "#minimized-dock.ow-has-rows", ".thinking-section", ".tool-indicator",
  ].join(", ");
  var EXCLUDE_IDS = { "orwell-headshot": 1 };

  // The ONLY surface that adapts under the glass theme: the RECEIVED chat bubble. #1601 /
  // OWN-2 — the chat column is ONE LIGHT-GLASS FAMILY, so the received bubble now PREFERS a
  // fixed light glass (a LIGHT frost + DARK ink) matching the composer/chrome, instead of the
  // old wallpaper-driven flip to a dark frost + light ink (that dark-bubble-vs-light-composer
  // split was the OWN-2 bug). resolveBubbleScrim keeps a rare alternate-polarity / harden
  // fallback purely as a legibility terminator, but the light frost essentially always wins by
  // adapting the scrim OPACITY: it escalates --ai-scrim-alpha per-bubble so the dark ink clears
  // APCA over ANY backdrop (the frost climbs toward opaque near-white over a dark/busy wall —
  // the fixed-light-glass move). Chrome does NOT adapt (also fixed light glass), and the SENT
  // (blue) bubble never adapts (blue + white). So this is just .msg-ai.
  var BUBBLE_ADAPTIVE = ".msg-ai";
  // ── #763 — the WELCOME HERO over the bare wallpaper ───────────────────────────
  // The hero (the big "Orwell" wordmark, the subtitle, the inline "type /setup" link)
  // sits DIRECTLY over the wallpaper (#__wp) — NOT over the light glass chrome. So a
  // single fixed ink (the old light var(--fg)) is light-on-light over a LIGHT wallpaper
  // (~1.13:1, invisible). Like Apple's monochrome labels over content and like the
  // .msg-ai bubbles above, the hero must FLIP polarity with the wallpaper. Unlike a
  // bubble there is NO frost plate, so the ink sits on the wallpaper DIRECTLY: we pick
  // polarity at the linear-Y flip point, then verify APCA(ink ↔ wallpaper) clears the
  // floor, and ESCALATE the ink toward pure black / pure white (not a scrim — a free
  // wordmark over a photo wants a halo, not a plate) plus a contrasting halo backstop.
  // Ink-only + halo; no veil/background is ever painted (it's not a glass surface).
  var HERO_ADAPTIVE = "#welcome-screen .welcome-name, #welcome-screen .welcome-sub";
  var HERO_INK_DARK = [22, 25, 31];        // #16191f — the dark ink (matches the CSS default + chrome)
  var HERO_INK_LIGHT = [238, 241, 244];    // #eef1f4 — the light ink over a dark wallpaper
  var HERO_HALO_LIGHT = "0 1px 2px rgba(255,255,255,0.60), 0 0 3px rgba(255,255,255,0.50)"; // under DARK ink
  var HERO_HALO_DARK = "0 1px 2px rgba(0,0,0,0.62), 0 0 3px rgba(0,0,0,0.52)";              // under LIGHT ink
  // the LIGHT frost a received bubble takes over a BRIGHT backdrop (Apple's light received
  // bubble) — a near-white translucent material that reads with the dark INK_DARK label.
  // The DARK frost (over a dark/mid wall) is the CSS default (rgba(56,60,68,a)); its alpha
  // is the CSS var --ai-scrim-alpha so we can ESCALATE it per-bubble (see #744 below).
  var BUBBLE_LIGHT_RGB = [245, 246, 248];   // near-white frost tint over a BRIGHT wall
  var BUBBLE_DARK_RGB = [56, 60, 68];       // neutral dark frost tint (matches style.css default)

  // The adaptive surfaces under the glass theme (kept in ONE place so the hot pass, the
  // scoped mutation collector, and the standdown drop all agree): the RECEIVED chat
  // bubbles (#744) + the welcome HERO (#763). Everything else (fixed light glass chrome)
  // stands down. (Kept as `BUBBLE_ADAPTIVE + ", " + HERO_ADAPTIVE` — the source-pinned form.)
  var ADAPTIVE_SEL = BUBBLE_ADAPTIVE + ", " + HERO_ADAPTIVE;

  // ── F-CONTRAST-1 (HIG Color / Materials; broadens #738 item 19) ───────────────
  // Secondary UI text — the `--fg-muted` token (de-facto #888) used for captions / gadget rows /
  // settings sub-labels — sits over the SAME fixed light glass the chrome does. adaptiveGlass
  // stands the chrome down under the glass theme (it is a FIXED light glass, no per-surface veil),
  // so #744's per-bubble floor never reached that muted text: over a DARK backdrop showing through
  // the 0.60 white fill the effective surface is light-but-muted, and #888 on it drops well under a
  // legible floor. We floor it the SAME way the received bubble does — measure APCA against the real
  // composited surface, then ESCALATE the ink toward the theme `--fg` until it clears — but ONCE at
  // the TOKEN level (a single `--fg-muted` override), not per surface, so the chrome keeps standing
  // down. Promoting `--fg-muted` toward `--fg` is exactly the audit's sanctioned fix.
  var MUTED_BASE_RGB = [136, 136, 136];   // the documented `--fg-muted` fallback (#888)
  // The ONE light glass fill (style.css --ow-glass-light-color = rgba(255,255,255,0.60), the kube
  // 0.60 white). The muted ink's true surface = this fill composited over the sampled backdrop.
  var GLASS_LIGHT_RGB = [255, 255, 255];
  var GLASS_FILL_ALPHA = 0.60;
  // MUTED floor = Lc 45. APCA "bronze" sets Lc 45 as the minimum for SECONDARY / non-body text
  // (body prose is Lc 60 — the bubble floor above). Muted captions are intentionally de-emphasized,
  // so 45 keeps them legible without promoting them all the way to full `--fg` (which would erase the
  // visual hierarchy). Only escalate PAST #888 when the backdrop-through-glass actually starves it.
  var MUTED_FLOOR = 45;

  // ── #744 — APCA legibility floor for the RECEIVED transcript ──────────────────
  // The chat transcript IS the game (read for hours) and is the most-cited legibility gap.
  // Polarity-flip ALONE (a dark-ink/light-ink choice at a single Y threshold) is not enough:
  // over a BUSY or SATURATED MID-TONE wallpaper neither pure-dark nor pure-white ink clears a
  // real contrast floor through a thin frost. So after we pick ink polarity we measure the
  // ACTUAL perceptual contrast with APCA (the algorithm WCAG 3 / the bronze guidance use), and
  // if it fails we ESCALATE this ONE bubble's scrim toward opaque until it clears. This is a
  // LOCAL per-bubble escalation (the CSS var --ai-scrim-alpha on that element) — NOT a global
  // theme-tinted body state (#739, blocked on #730); we stay strictly local and Vault-free.
  //
  // FLOOR = Lc 60. APCA "bronze" puts Lc 60 as the floor for fluent body text (the next rung,
  // Lc 75/90, is for fine/small text). The transcript is body prose read for a long sitting, so
  // 60 is the defensible minimum — high enough to never be the cited gap, low enough that a clear
  // wallpaper still reads as glass rather than a solid plate. (APCA Lc is unsigned-magnitude here;
  // we take |Lc| because polarity is already chosen.)
  var APCA_FLOOR = 60;
  // Per-bubble scrim escalation band: start at the CSS default and climb toward near-opaque.
  var SCRIM_BASE = 0.46;     // mirrors the style.css --ai-scrim-alpha default (worst-case floor)
  var SCRIM_MAX = 0.92;      // near-opaque cap — still a frost, never a flat solid slab
  var SCRIM_STEP = 0.06;     // climb granularity when APCA fails for this bubble's backdrop
  // #738-19 — the LAST-RESORT hard clamp. When even the stronger polarity + pure-extreme ink can't
  // reach the floor over a badly starved mid-tone, the scrim goes fully SOLID so the ink sits on the
  // frost tint alone (which clears the floor by construction). The floor is non-negotiable — at the
  // very edge the glass look yields to legibility. This fires vanishingly rarely (SCRIM_MAX=0.92
  // already nearly obscures the wallpaper); it exists so the guarantee is absolute, not empirical.
  var SCRIM_SOLID = 1.0;

  // Apple's adaptation is SIZE-DEPENDENT (WWDC25 219 + HIG Color):
  //   • SMALL bars/tiles (toolbars, tab bars — our composer bar, gadget tiles, the dock):
  //     the glass stays CLEAR and the SYMBOLS FLIP light↔dark to mirror the backdrop
  //     ("symbols and glyphs … flip from light to dark and vice versa … to maximize
  //     contrast"). No darkening of the glass.
  //   • LARGE surfaces (sidebars, windows, modals, menus): they "don't flip from light to
  //     dark — their surface area is too big and transitions would be distracting." Instead
  //     the Regular glass continuously "blurs AND adjusts the luminosity of background
  //     content to maintain legibility" — so we keep LIGHT --fg symbols and let a stronger
  //     adaptive veil mute a bright backdrop just enough to keep them legible.
  // The only darkening Apple sanctions is the Clear variant's literal 35% dimmer over bright
  // media (not used here — our surfaces carry text, so Regular is correct).
  var VEIL_MIN = 14;             // % --panel at a dark backdrop (translucent/lit) — both sizes
  var VEIL_MAX_SMALL = 22;       // small bars stay genuinely CLEAR (the symbol flip does the legibility work)
  var VEIL_MAX_LARGE = 48;       // large surfaces don't flip → glass mutes, but stays translucent (no opaque slab)
  // Linear-Y at which each veil reaches its cap. Small bars cross over WITH the ink flip
  // (steeper); large surfaces ramp gently so a bright backdrop still shows through the glass
  // ("adjusted luminosity," not a wall — Apple Regular over light content).
  var VEIL_FULL_AT_SMALL = 0.35;
  var VEIL_FULL_AT_LARGE = 0.62;
  // Small bars/tiles that FLIP (everything else in SURFACES is treated as large / no-flip).
  // The composer bar, gadget tiles, the dock, and the small transient pills (the
  // typing/thinking indicator, the tool-indicator chip) are small bars → flip the ink.
  // Large surfaces (windows, sidebar, modals, admin-card, toasts, chat bubbles, menus)
  // are NOT here → they mute via the adaptive veil and keep light --fg.
  var FLIP_SET = ".chat-input-bar, .og-card, #minimized-dock.ow-has-rows, .thinking-section, .tool-indicator";
  // LINEAR-Y flip point: backdrop above this ⇒ DARK ink. The WCAG black-vs-white crossover is
  // L≈0.18; the small bar's own veil darkens the effective background a touch, so the flip
  // sits just above it at 0.22 (≈ perceptual mid-grey sRGB≈0.5). 0.36 fired far too late —
  // surfaces over a perceptually half-bright backdrop kept light ink and washed out.
  var INK_THRESHOLD = 0.22;
  var INK_DARK = "#11151c";   // dark symbol/label colour over bright backdrops
  var DEBOUNCE_MS = 120;
  var SAMPLE_GRID = 5;        // NxN samples across the surface's backdrop region

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  // Proper relative luminance: sRGB → linear, then Rec.709 weights (matches Apple/WCAG).
  function _lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function relLum(r, g, b) { return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b); }

  // ── APCA (Accessible Perceptual Contrast Algorithm, the WCAG 3 / SAPC-APCA model) ──
  // A faithful, dependency-free port of the APCA-W3 0.1.9 core (the public-domain reference by
  // Andrew Somers / Myndex). We use it for the #744 transcript legibility floor: unlike WCAG 2's
  // luminance-ratio (which over/under-states contrast on mid-tones and for light-on-dark), APCA
  // models perceived lightness contrast and is polarity-aware — the right tool for "does this ink
  // clear a floor over THIS backdrop." Returns Lc (lightness contrast); sign encodes polarity, so
  // callers take Math.abs() when polarity is already chosen.
  function _apcaY(r, g, b) {
    // sRGB → screen luminance (APCA uses simple ^2.4 on 0..1, NOT the WCAG piecewise curve).
    var Rs = Math.pow(r / 255, 2.4), Gs = Math.pow(g / 255, 2.4), Bs = Math.pow(b / 255, 2.4);
    return 0.2126729 * Rs + 0.7151522 * Gs + 0.0721750 * Bs;
  }
  function apcaContrast(txt, bg) {
    // txt/bg = [r,g,b]. Constants are the APCA-W3 0.1.9 published values.
    var Ytxt = _apcaY(txt[0], txt[1], txt[2]);
    var Ybg = _apcaY(bg[0], bg[1], bg[2]);
    var BLK_THRS = 0.022, BLK_CLMP = 1.414;
    var SCALE_BoW = 1.14, SCALE_WoB = 1.14;
    var LO_CLIP = 0.1, DELTA_MIN = 0.0005;
    // soft-clamp blacks
    Ytxt = Ytxt > BLK_THRS ? Ytxt : Ytxt + Math.pow(BLK_THRS - Ytxt, BLK_CLMP);
    Ybg = Ybg > BLK_THRS ? Ybg : Ybg + Math.pow(BLK_THRS - Ybg, BLK_CLMP);
    if (Math.abs(Ybg - Ytxt) < DELTA_MIN) return 0;
    var out;
    if (Ybg > Ytxt) {            // normal polarity: dark text on lighter bg
      out = (Math.pow(Ybg, 0.56) - Math.pow(Ytxt, 0.57)) * SCALE_BoW;
      out = out < LO_CLIP ? 0 : out - 0.027;
    } else {                     // reverse polarity: light text on darker bg
      out = (Math.pow(Ybg, 0.65) - Math.pow(Ytxt, 0.62)) * SCALE_WoB;
      out = out > -LO_CLIP ? 0 : out + 0.027;
    }
    return out * 100;            // Lc
  }
  // Composite an opaque scrim (tint at alpha) over an opaque backdrop → the effective bubble
  // surface the ink actually sits on (standard src-over alpha blend; backdrop alpha = 1).
  //
  // #738-19 — this stays a straight sRGB src-over blend ON PURPOSE. An OKLCH mix was considered for
  // the scrim/ink derivation but is NOT a clean improvement HERE: the browser composites the bubble's
  // rgba() frost fill over the backdrop in sRGB, so this JS estimate must mirror that space to keep
  // the APCA(ink↔surface) measurement faithful to what actually renders. An OKLCH mix would DIVERGE
  // from the rendered surface and degrade the floor estimate. (OKLCH earns its keep on decorative hue
  // mixing — the specular/fringe tokens in style.css — not on a legibility scrim.) Deferred, kept
  // byte-identical; revisit only if the fill itself moves to an OKLCH color space.
  function compositeOver(tint, alpha, backdrop) {
    var a = clamp(alpha, 0, 1);
    return [
      Math.round(tint[0] * a + backdrop[0] * (1 - a)),
      Math.round(tint[1] * a + backdrop[1] * (1 - a)),
      Math.round(tint[2] * a + backdrop[2] * (1 - a)),
    ];
  }
  function prefersContrast() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-contrast: more)").matches); } catch (_) { return false; }
  }

  // #738-19 — Safari's CSS `contrast-color()` (progressive enhancement). Where the UA supports it,
  // the browser natively picks the maximally-contrasting black/white ink for a given surface — a
  // guaranteed-correct polarity pick done in the engine, not our JS approximation. Feature-detected
  // via CSS.supports and cached; EVERYWHERE it is absent we fall back to the JS APCA computation
  // (which itself floors legibility). This never REPLACES the JS path — it layers on top of it where
  // available, and the halo/scrim we compute stay authoritative either way.
  var _ccSupport = null;
  function supportsContrastColor() {
    if (_ccSupport !== null) return _ccSupport;
    try { _ccSupport = !!(window.CSS && window.CSS.supports && window.CSS.supports("color", "contrast-color(white)")); }
    catch (_) { _ccSupport = false; }
    return _ccSupport;
  }

  // ── unified backdrop canvas (image OR gradient OR solid — composited) ─────────
  // The "background" can be ANYTHING: a solid theme colour, faint CSS pattern
  // gradients, a full-viewport wallpaper image, or any combination. A url()-only
  // path missed gradients entirely (they carry no url), so we paint ONE downscaled
  // viewport canvas from the page's actual backdrop layers — base colour, then each
  // background-image gradient, then any wallpaper image (back-to-front) — and sample
  // regions of it per surface. That makes the adaptation correct over a photo, a
  // light theme, a gradient theme, the dark chat, or a layered mix of them.
  var BACKDROP_MAXW = 96;   // downscaled viewport-canvas width (cheap to getImageData)
  var _bd = { cv: null, ctx: null, w: 0, h: 0, sig: "", base: null, tainted: false };
  var _imgCache = {};       // url -> { img } | 'pending' | 'failed'

  function clamp255(x) { return Math.max(0, Math.min(255, Math.round(parseFloat(x)))); }
  function parseAlpha(x) { x = String(x).trim(); return x.indexOf("%") >= 0 ? parseFloat(x) / 100 : parseFloat(x); }
  function rgbaStr(c) { return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + (c[3] == null ? 1 : c[3]) + ")"; }

  // Parse a CSS colour (computed values resolve var()/color-mix() → rgb/rgba). Returns [r,g,b,a] or null.
  function parseColor(s) {
    if (!s) return null; s = String(s).trim();
    if (s === "transparent") return [0, 0, 0, 0];
    var m = s.match(/^rgba?\(([^)]+)\)/i);
    if (m) {
      var p = m[1].split(/[,\/\s]+/).filter(function (x) { return x !== ""; });
      if (p.length >= 3) return [clamp255(p[0]), clamp255(p[1]), clamp255(p[2]), p[3] !== undefined ? parseAlpha(p[3]) : 1];
    }
    var h = s.match(/^#([0-9a-fA-F]{3,8})$/);
    if (h) {
      var x = h[1];
      if (x.length === 3) x = x[0] + x[0] + x[1] + x[1] + x[2] + x[2];
      if (x.length >= 6) {
        var a = x.length >= 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1;
        return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16), a];
      }
    }
    return null;
  }

  // Split on a top-level separator only (commas inside rgb()/gradient() are kept).
  function splitTopLevel(s, sep) {
    var out = [], depth = 0, cur = "";
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === "(") depth++; else if (c === ")") depth--;
      if (c === sep && depth === 0) { out.push(cur); cur = ""; } else cur += c;
    }
    if (cur.trim() !== "") out.push(cur);
    return out;
  }

  function parseAngle(h) {
    h = h.trim().toLowerCase();
    if (h.indexOf("deg") >= 0) return parseFloat(h);
    if (h.indexOf("turn") >= 0) return parseFloat(h) * 360;
    if (h.indexOf("grad") >= 0) return parseFloat(h) * 0.9;
    if (h.indexOf("rad") >= 0) return parseFloat(h) * 180 / Math.PI;
    var map = { "to top": 0, "to right": 90, "to bottom": 180, "to left": 270,
      "to top right": 45, "to right top": 45, "to bottom right": 135, "to right bottom": 135,
      "to bottom left": 225, "to left bottom": 225, "to top left": 315, "to left top": 315 };
    return map[h] != null ? map[h] : 180;
  }

  // Colour stops from the gradient body parts; fill missing positions by interpolation.
  function parseStops(parts) {
    var stops = [];
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].trim();
      // colour first, then an OPTIONAL position (% only — px positions are ignored).
      var cm = t.match(/^(rgba?\([^)]*\)|#[0-9a-fA-F]+|[a-zA-Z]+)(?:\s+([-\d.]+)%)?/);
      if (!cm) continue;
      var col = parseColor(cm[1]); if (!col) continue;
      var pos = cm[2] !== undefined ? parseFloat(cm[2]) / 100 : null;
      stops.push({ col: col, pos: pos });
    }
    if (!stops.length) return stops;
    if (stops[0].pos == null) stops[0].pos = 0;
    if (stops[stops.length - 1].pos == null) stops[stops.length - 1].pos = 1;
    for (var j = 1; j < stops.length - 1; j++) {
      if (stops[j].pos != null) continue;
      var prev = j - 1, next = j + 1;
      while (next < stops.length && stops[next].pos == null) next++;
      var p0 = stops[prev].pos, p1 = stops[next].pos != null ? stops[next].pos : 1;
      stops[j].pos = p0 + (p1 - p0) * ((j - prev) / (next - prev));
    }
    return stops;
  }

  function avgColor(stops) {
    var r = 0, g = 0, b = 0, a = 0;
    for (var i = 0; i < stops.length; i++) { r += stops[i].col[0]; g += stops[i].col[1]; b += stops[i].col[2]; a += (stops[i].col[3] == null ? 1 : stops[i].col[3]); }
    var n = stops.length || 1;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n), a / n];
  }

  function paintGradient(ctx, w, h, css) {
    var lp = css.indexOf("(");
    var open = css.slice(0, lp).trim().toLowerCase();
    var inner = css.slice(lp + 1, css.lastIndexOf(")"));
    var parts = splitTopLevel(inner, ",");
    if (!parts.length) return;
    var radial = open.indexOf("radial") >= 0, conic = open.indexOf("conic") >= 0;
    var head = parts[0].trim();
    var headIsConfig = /^(to\s|[-\d.]+deg|[-\d.]+turn|[-\d.]+g?rad|circle|ellipse|at\s|closest|farthest|from\s)/i.test(head);
    var stops = parseStops(headIsConfig ? parts.slice(1) : parts);
    if (!stops.length) return;
    if (conic) { ctx.fillStyle = rgbaStr(avgColor(stops)); ctx.fillRect(0, 0, w, h); return; }
    var g;
    if (radial) {
      g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
    } else {
      var a = (headIsConfig ? parseAngle(head) : 180) * Math.PI / 180;
      var dx = Math.sin(a), dy = -Math.cos(a);
      var len = Math.abs(w * dx) + Math.abs(h * dy);
      g = ctx.createLinearGradient(w / 2 - dx * len / 2, h / 2 - dy * len / 2, w / 2 + dx * len / 2, h / 2 + dy * len / 2);
    }
    for (var i = 0; i < stops.length; i++) { try { g.addColorStop(clamp(stops[i].pos, 0, 1), rgbaStr(stops[i].col)); } catch (_) {} }
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }

  function drawCover(ctx, img, w, h) {
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    var s = Math.max(w / iw, h / ih), dw = iw * s, dh = ih * s;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  function ensureImg(url) {
    var rec = _imgCache[url];
    if (rec && rec !== "pending" && rec !== "failed") return rec;
    if (rec === "pending" || rec === "failed") return null;
    _imgCache[url] = "pending";
    var img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = function () { _imgCache[url] = { img: img }; schedule(); };
    img.onerror = function () { _imgCache[url] = "failed"; };
    img.src = url;
    return null;
  }

  // The backdrop element chain, back-to-front (html → body → known wallpaper containers).
  function backdropChain() {
    var chain = [];
    if (document.documentElement) chain.push(document.documentElement);
    if (document.body) chain.push(document.body);
    var ids = ["__wp", "wallpaper", "app-bg", "background", "desktop"];
    for (var i = 0; i < ids.length; i++) { var e = document.getElementById(ids[i]); if (e) chain.push(e); }
    return chain;
  }

  // Build (or reuse) the unified downscaled backdrop canvas. Returns the cache record.
  function buildBackdrop() {
    var vw = window.innerWidth || 1280, vh = window.innerHeight || 800;
    var w = BACKDROP_MAXW, h = Math.max(1, Math.round(BACKDROP_MAXW * vh / vw));
    var chain = backdropChain();
    // First scan: a signature + the layer plan, so we don't repaint on every scroll.
    var sig = w + "x" + h, plan = [], base = null;
    for (var i = 0; i < chain.length; i++) {
      var cs; try { cs = getComputedStyle(chain[i]); } catch (_) { continue; }
      var col = parseColor(cs.backgroundColor);
      if (col && col[3] > 0.05) { base = col; sig += "|c" + col.join(","); plan.push({ fill: col }); }
      var bi = cs.backgroundImage || "";
      if (bi && bi !== "none") {
        var imgs = splitTopLevel(bi, ",");
        for (var j = imgs.length - 1; j >= 0; j--) {   // CSS paints first-listed on top → reverse
          var layer = imgs[j].trim();
          var u = layer.match(/^url\((['"]?)(.*?)\1\)$/);
          if (u) { plan.push({ url: u[2] }); sig += "|u" + u[2]; }
          else if (/gradient\(/i.test(layer)) { plan.push({ grad: layer }); sig += "|g" + layer.length; }
        }
      }
    }
    if (_bd.sig === sig && _bd.cv) return _bd;
    var cv = _bd.cv || document.createElement("canvas");
    cv.width = w; cv.height = h;
    var ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = base ? rgbaStr(base) : "#282c34"; ctx.fillRect(0, 0, w, h);
    var pending = false;
    for (var p = 0; p < plan.length; p++) {
      var it = plan[p];
      if (it.fill) { ctx.fillStyle = rgbaStr(it.fill); ctx.fillRect(0, 0, w, h); }
      else if (it.grad) { try { paintGradient(ctx, w, h, it.grad); } catch (_) {} }
      else if (it.url) {
        var rec = ensureImg(it.url);
        if (!rec) { pending = true; continue; }
        try { drawCover(ctx, rec.img, w, h); } catch (_) {}
      }
    }
    var tainted = false;
    try { ctx.getImageData(0, 0, 1, 1); } catch (_) { tainted = true; }
    // sig keeps a |p marker while an image is still loading so the next pass rebuilds.
    _bd = { cv: cv, ctx: ctx, w: w, h: h, sig: pending ? sig + "|p" : sig, base: base, tainted: tainted };
    return _bd;
  }

  // Average luminance of the backdrop behind `rect` (viewport px). Returns 0..1 or null.
  function backdropLuminance(rect) {
    var vw = window.innerWidth || 1280, vh = window.innerHeight || 800;
    var bd = buildBackdrop();
    if (bd && bd.cv && !bd.tainted) {
      var sx = bd.w / vw, sy = bd.h / vh, total = 0, n = 0;
      for (var gy = 0; gy < SAMPLE_GRID; gy++) {
        for (var gx = 0; gx < SAMPLE_GRID; gx++) {
          var vx = rect.left + (rect.width * (gx + 0.5)) / SAMPLE_GRID;
          var vy = rect.top + (rect.height * (gy + 0.5)) / SAMPLE_GRID;
          var ix = clamp(Math.round(vx * sx), 0, bd.w - 1), iy = clamp(Math.round(vy * sy), 0, bd.h - 1);
          try {
            var d = bd.ctx.getImageData(ix, iy, 1, 1).data;
            total += relLum(d[0], d[1], d[2]); n++;
          } catch (_) {}
        }
      }
      if (n) return total / n;
    }
    // Tainted (cross-origin wallpaper w/o CORS): use the resolved base colour if we have it.
    if (bd && bd.base) return relLum(bd.base[0], bd.base[1], bd.base[2]);
    // Deepest fallback: the computed background-color of the element behind the centre.
    try {
      var cx = clamp(rect.left + rect.width / 2, 0, vw - 1);
      var cy = clamp(rect.top + rect.height / 2, 0, vh - 1);
      var els = document.elementsFromPoint(cx, cy);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.closest && el.closest(SURFACES)) continue; // skip the glass itself / glass chrome
        var c2 = parseColor(getComputedStyle(el).backgroundColor || "");
        if (c2 && (c2[3] == null || c2[3] > 0.4)) return relLum(c2[0], c2[1], c2[2]);
      }
    } catch (_) {}
    return null;
  }

  // Average RGB of the backdrop behind `rect` (viewport px). Returns [r,g,b] or null. Used by
  // the #744 APCA floor — we need the backdrop COLOUR (not just its luminance) so we can composite
  // the scrim over it and measure the real ink↔surface contrast.
  function backdropAvgColor(rect) {
    var vw = window.innerWidth || 1280, vh = window.innerHeight || 800;
    var bd = buildBackdrop();
    if (bd && bd.cv && !bd.tainted) {
      var sx = bd.w / vw, sy = bd.h / vh, rs = 0, gs = 0, bs = 0, n = 0;
      for (var gy = 0; gy < SAMPLE_GRID; gy++) {
        for (var gx = 0; gx < SAMPLE_GRID; gx++) {
          var vx = rect.left + (rect.width * (gx + 0.5)) / SAMPLE_GRID;
          var vy = rect.top + (rect.height * (gy + 0.5)) / SAMPLE_GRID;
          var ix = clamp(Math.round(vx * sx), 0, bd.w - 1), iy = clamp(Math.round(vy * sy), 0, bd.h - 1);
          try { var d = bd.ctx.getImageData(ix, iy, 1, 1).data; rs += d[0]; gs += d[1]; bs += d[2]; n++; } catch (_) {}
        }
      }
      if (n) return [Math.round(rs / n), Math.round(gs / n), Math.round(bs / n)];
    }
    if (bd && bd.base) return [bd.base[0], bd.base[1], bd.base[2]];
    return null;
  }

  // PERF (#1315) — sample the backdrop behind `rect` ONCE for BOTH the luminance (L) and the
  // average colour (rgb). The bubble path needs both (L picks polarity, rgb feeds the APCA
  // composite); computing them in two passes doubled the getImageData work per bubble. The
  // canvas path here is byte-identical to calling backdropLuminance + backdropAvgColor
  // separately (same grid, same math); only the RARE fallbacks defer to those originals.
  function _sampleBackdrop(rect) {
    var vw = window.innerWidth || 1280, vh = window.innerHeight || 800;
    var bd = buildBackdrop();
    if (bd && bd.cv && !bd.tainted) {
      var sx = bd.w / vw, sy = bd.h / vh, total = 0, rs = 0, gs = 0, bs = 0, n = 0;
      for (var gy = 0; gy < SAMPLE_GRID; gy++) {
        for (var gx = 0; gx < SAMPLE_GRID; gx++) {
          var vx = rect.left + (rect.width * (gx + 0.5)) / SAMPLE_GRID;
          var vy = rect.top + (rect.height * (gy + 0.5)) / SAMPLE_GRID;
          var ix = clamp(Math.round(vx * sx), 0, bd.w - 1), iy = clamp(Math.round(vy * sy), 0, bd.h - 1);
          try {
            var d = bd.ctx.getImageData(ix, iy, 1, 1).data;
            total += relLum(d[0], d[1], d[2]); rs += d[0]; gs += d[1]; bs += d[2]; n++;
          } catch (_) {}
        }
      }
      if (n) return { L: total / n, rgb: [Math.round(rs / n), Math.round(gs / n), Math.round(bs / n)] };
    }
    // Rare fallbacks (tainted cross-origin / no canvas): reuse the originals so behaviour matches.
    return { L: backdropLuminance(rect), rgb: backdropAvgColor(rect) };
  }

  // #744 — for a received bubble over a sampled backdrop, pick the polarity (per the existing
  // linear-Y flip), then ESCALATE this bubble's scrim alpha until the APCA(ink↔composited-surface)
  // contrast clears APCA_FLOOR (or we hit SCRIM_MAX). Returns { ink, frostRgb, scrimAlpha, lc }.
  // The surface the ink truly sits on = the frost tint composited over the wallpaper at scrimAlpha
  // (the bubble blurs the wall but the scrim is opaque-over the blurred result), so that is what we
  // measure. Polarity-flip alone is the floor; the scrim escalation is the guarantee.
  // Escalate ONE polarity's scrim: composite the frost over the sampled backdrop and climb the
  // LOCAL per-bubble scrim alpha (from the CSS default toward the near-opaque cap) until
  // APCA(ink↔surface) clears the floor — or we hit the cap. Returns the best {alpha, lc} this
  // polarity can reach over THIS backdrop.
  function _escalateScrim(ink, frost, bgRgb) {
    var a = SCRIM_BASE, lc = 0, surface;
    for (;;) {
      surface = compositeOver(frost, a, bgRgb);
      lc = Math.abs(apcaContrast(ink, surface));
      if (lc >= APCA_FLOOR || a >= SCRIM_MAX) break;
      a = Math.min(SCRIM_MAX, a + SCRIM_STEP);
    }
    return { alpha: a, lc: lc };
  }

  // #738-19 — the FLOOR IS NON-NEGOTIABLE. When neither polarity's scrim escalation reaches the APCA
  // floor over a starved mid-tone (the frost tint composited over the wallpaper still can't clear Lc
  // 60 even at SCRIM_MAX), push HARDER: first escalate the INK toward its polarity extreme (pure
  // black / pure white — the same move the hero ink makes) against the current surface; then, only if
  // the pure extreme STILL can't clear it, clamp the scrim SOLID (alpha 1.0) so the ink sits on the
  // frost tint alone — dark ink on the near-white light frost, or white ink on the neutral dark frost,
  // both clear the floor by construction. This is a guaranteed terminator: it ALWAYS returns at/above
  // the floor. Returns { ink, alpha, lc }.
  function _hardenToFloor(ink, dark, frost, alpha, bgRgb) {
    var target = dark ? [0, 0, 0] : [255, 255, 255];
    var a = alpha, curInk = ink.slice(), surface, lc;
    for (var step = 0; step < 6; step++) {
      surface = compositeOver(frost, a, bgRgb);
      lc = Math.abs(apcaContrast(curInk, surface));
      if (lc >= APCA_FLOOR) return { ink: curInk, alpha: a, lc: lc };
      curInk = [
        Math.round(curInk[0] + (target[0] - curInk[0]) * 0.5),
        Math.round(curInk[1] + (target[1] - curInk[1]) * 0.5),
        Math.round(curInk[2] + (target[2] - curInk[2]) * 0.5),
      ];
    }
    // The pure extreme at the CURRENT alpha — try it before spending translucency: a mid-tone that
    // starved a partial ink often clears once the ink is pure black/white, with the scrim still glass.
    curInk = target.slice();
    surface = compositeOver(frost, a, bgRgb);
    lc = Math.abs(apcaContrast(curInk, surface));
    if (lc >= APCA_FLOOR) return { ink: curInk, alpha: a, lc: lc };
    // Last resort: pure-extreme ink + a SOLID frost — the surface is now the frost tint alone, which
    // the extreme ink clears by construction (the absolute guarantee behind the empirical escalation).
    a = SCRIM_SOLID;
    surface = compositeOver(frost, a, bgRgb);
    lc = Math.abs(apcaContrast(curInk, surface));
    return { ink: curInk, alpha: a, lc: lc };
  }

  function resolveBubbleScrim(L, bgRgb) {
    // #1601 / OWN-2 — ONE LIGHT-GLASS FAMILY: the received bubble is a FIXED light glass, so we
    // ALWAYS prefer the light-frost/DARK-ink polarity (never the old dark-frost/white-ink flip
    // that read as a dark slab beside the light composer). The scrim escalation below floors
    // legibility over any backdrop — a light frost climbs toward opaque near-white over a
    // dark/busy wall, where dark ink clears APCA by a wide margin — so this preferred polarity
    // essentially always wins. The alt-polarity branch is retained ONLY as the non-negotiable
    // legibility terminator (it never fires for a light frost, which always clears via opacity).
    // `L` is intentionally no longer consulted for polarity (kept in the signature for the
    // caller/tests); the fixed light glass is polarity-independent.
    var darkPref = true;
    var darkInk = parseColor(INK_DARK).slice(0, 3), lightInk = [255, 255, 255];
    var prefInk = darkPref ? darkInk : lightInk;
    var prefFrost = darkPref ? BUBBLE_LIGHT_RGB : BUBBLE_DARK_RGB;
    var pref = _escalateScrim(prefInk, prefFrost, bgRgb);
    var dark = darkPref, ink = prefInk, frost = prefFrost, a = pref.alpha, lc = pref.lc;
    // The legibility FLOOR is the non-negotiable; the polarity FLIP is the aesthetic preference.
    // At the extremes (a clearly bright or clearly dark wall) the preferred polarity always wins
    // on contrast, so this is a no-op there. Only when a STARVED mid-tone right at the flip
    // boundary can't reach the floor with the preferred polarity even at the scrim cap do we fall
    // back to whichever polarity contrasts MORE — so a received bubble is legible over ANY
    // wallpaper, not just the threshold-preferred half.
    if (pref.lc < APCA_FLOOR) {
      var altInk = darkPref ? lightInk : darkInk;
      var altFrost = darkPref ? BUBBLE_DARK_RGB : BUBBLE_LIGHT_RGB;
      var alt = _escalateScrim(altInk, altFrost, bgRgb);
      if (alt.lc > pref.lc) {
        dark = !darkPref; ink = altInk; frost = altFrost; a = alt.alpha; lc = alt.lc;
      }
    }
    // #738-19 — if the BEST polarity STILL misses the floor at the scrim cap (a badly starved
    // mid-tone that neither polarity's escalation could clear), harden until it does: escalate the
    // ink toward the extreme, then clamp the scrim solid as the last resort. The floor is guaranteed.
    if (lc < APCA_FLOOR) {
      var hard = _hardenToFloor(ink, dark, frost, a, bgRgb);
      ink = hard.ink; a = hard.alpha; lc = hard.lc;
    }
    return { ink: ink, frostRgb: frost, scrimAlpha: a, lc: lc, dark: dark };
  }

  // #763 — for the welcome hero over a sampled wallpaper, pick ink polarity (the same
  // linear-Y flip the small bars use), then verify APCA(ink ↔ wallpaper) clears the floor
  // and ESCALATE the ink toward pure black / pure white until it does (or it's already
  // maxed). The hero has no frost plate, so the ink sits on the wallpaper DIRECTLY — that
  // is the pair we measure. Returns { ink, halo, dark, lc }. A contrasting halo is the
  // backstop floor for a free wordmark over a busy/edge backdrop (mirrors the bubble halo).
  function resolveHeroInk(L, bgRgb) {
    var dark = L >= INK_THRESHOLD;          // bright wallpaper → DARK ink; dark wallpaper → LIGHT ink
    var ink = dark ? HERO_INK_DARK.slice() : HERO_INK_LIGHT.slice();
    var target = dark ? [0, 0, 0] : [255, 255, 255];  // escalate toward this if the floor isn't met
    var lc = Math.abs(apcaContrast(ink, bgRgb));
    // climb the ink toward pure black/white in a few steps if a mid-tone wallpaper starves it.
    for (var step = 0; step < 6 && lc < APCA_FLOOR; step++) {
      ink = [
        Math.round(ink[0] + (target[0] - ink[0]) * 0.5),
        Math.round(ink[1] + (target[1] - ink[1]) * 0.5),
        Math.round(ink[2] + (target[2] - ink[2]) * 0.5),
      ];
      lc = Math.abs(apcaContrast(ink, bgRgb));
    }
    return { ink: ink, halo: dark ? HERO_HALO_LIGHT : HERO_HALO_DARK, dark: dark, lc: lc };
  }

  // F-CONTRAST-1 — floor the `--fg-muted` token over the fixed light glass. The muted base (#888)
  // sits on the glass surface = the 0.60 white fill composited over the sampled backdrop. Measure
  // APCA(muted ↔ surface); if it misses the secondary-text floor, ESCALATE the muted ink toward the
  // theme `--fg` (the sanctioned "promote --fg-muted toward --fg" fix — the light glass stays light
  // even over a dark backdrop, so darker ink is the right move) until it clears — or it is already
  // maxed. Mirrors the received-bubble/hero escalation, at the TOKEN level (one value for the theme,
  // never per-surface, so the fixed-light-glass chrome keeps standing down). Returns
  // { ink, lc, floored }; `floored` is false when #888 already clears (⇒ leave the design untouched).
  function resolveMutedInk(bgRgb, fgRgb) {
    var surface = compositeOver(GLASS_LIGHT_RGB, GLASS_FILL_ALPHA, bgRgb);
    var ink = MUTED_BASE_RGB.slice();
    var lc = Math.abs(apcaContrast(ink, surface));
    var floored = false;
    for (var step = 0; step < 8 && lc < MUTED_FLOOR; step++) {
      ink = [
        Math.round(ink[0] + (fgRgb[0] - ink[0]) * 0.5),
        Math.round(ink[1] + (fgRgb[1] - ink[1]) * 0.5),
        Math.round(ink[2] + (fgRgb[2] - ink[2]) * 0.5),
      ];
      lc = Math.abs(apcaContrast(ink, surface));
      floored = true;
    }
    return { ink: ink, lc: lc, floored: floored };
  }

  // Read a CSS custom property as [r,g,b] (resolving var()/color-mix() via computed style). Falls
  // back to the supplied default when unset/unparseable. Used by the F-CONTRAST-1 token floor.
  function _readVarRgb(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      if (!v && document.body) v = getComputedStyle(document.body).getPropertyValue(name).trim();
      var c = parseColor(v);
      if (c) return [c[0], c[1], c[2]];
    } catch (_) {}
    return fallback;
  }

  // F-CONTRAST-1 — compute + apply the floored `--fg-muted` token under the glass theme. Sample the
  // whole-viewport backdrop (one token for the theme, matching how the chrome is one fixed glass),
  // resolve the theme `--fg` as the escalation target, and set `--fg-muted` on <html> ONLY when the
  // base #888 actually misses the floor (otherwise remove any prior override so the design stands).
  // Vault-free; purely a legibility floor. `data-muted-apca-lc` on <html> is the probe hook.
  function _floorMutedToken() {
    var root = document.documentElement;
    try {
      var bg = backdropAvgColor({ left: 0, top: 0,
        width: window.innerWidth || 1280, height: window.innerHeight || 800 });
      if (!bg) { root.style.removeProperty("--fg-muted"); root.removeAttribute("data-muted-apca-lc"); return; }
      var fg = _readVarRgb("--fg", [22, 25, 31]);   // #16191f — the glass-chrome dark ink default
      var m = resolveMutedInk(bg, fg);
      if (m.floored) root.style.setProperty("--fg-muted", "rgb(" + m.ink[0] + "," + m.ink[1] + "," + m.ink[2] + ")");
      else root.style.removeProperty("--fg-muted");
      root.setAttribute("data-muted-apca-lc", Math.round(m.lc));
    } catch (_) {}
  }

  // Drop the F-CONTRAST-1 muted-token override (standdown paths let the CSS backstop / base stand).
  function _clearMutedToken() {
    try {
      document.documentElement.style.removeProperty("--fg-muted");
      document.documentElement.removeAttribute("data-muted-apca-lc");
    } catch (_) {}
  }

  // ── apply ───────────────────────────────────────────────────────────────────
  function isFrosted() { return !!(document.body && document.body.classList.contains("theme-frosted")); }

  // ── PERF (#1315): scoped-pass dirty tracking ──────────────────────────────────
  // The old pass re-walked EVERY .msg-ai on every scheduled tick — O(transcript) per streamed
  // delta, dozens of times per reply. Now a "full" trigger (scroll/resize/theme/backdrop change —
  // anything that moves what's behind the bubbles) marks ALL dirty, while a chat DOM mutation marks
  // only the AFFECTED bubbles dirty. A scoped pass then touches just those, so streaming costs
  // O(changed bubbles), not O(all). `_allDirty` short-circuits the set (a full pass supersedes it).
  var _allDirty = true;   // the first pass is full (nothing sampled yet)
  var _dirtyEls = null;   // Set of specific adaptive elements when NOT _allDirty
  function _markAllDirty() {
    _allDirty = true;
    _dirtyEls = null;   // the full pass supersedes any pending scoped set — DROP it. Without this,
                        // elements marked before a full trigger would linger: the full pass consumes
                        // _allDirty (covering them), then the NEXT scoped mutation would re-sample the
                        // stale set on top of its own target (a silent partial re-walk regression).
  }
  function _markElDirty(el) {
    if (_allDirty || !el) return;   // short-circuit: a pending full pass already covers everything
    if (!_dirtyEls) _dirtyEls = new Set();
    _dirtyEls.add(el);
  }
  // Resolve the adaptive element(s) a mutation touched — the closest .msg-ai / hero ANCESTOR of the
  // record target, plus any adaptive elements the added subtree CONTAINS (a freshly-rendered bubble).
  function _collectAdaptive(node) {
    if (_allDirty || !node || node.nodeType !== 1) return;
    try {
      if (node.closest) {
        var b = node.closest(BUBBLE_ADAPTIVE); if (b) _markElDirty(b);
        var h = node.closest(HERO_ADAPTIVE); if (h) _markElDirty(h);
      }
      if (node.matches && node.matches(ADAPTIVE_SEL)) _markElDirty(node);
      if (node.querySelectorAll) {
        var found = node.querySelectorAll(ADAPTIVE_SEL);
        for (var i = 0; i < found.length; i++) _markElDirty(found[i]);
      }
    } catch (_) {}
  }

  // PERF (#1315): `cachedRect` lets the hot pass read EVERY bubble's getBoundingClientRect in a
  // single batched read phase (no read↔write layout thrash), then apply here without a fresh
  // layout read. `presampled` ({L, rgb}) is the one-shot backdrop sample taken in that same read
  // phase. Both are OPTIONAL — called bare (no cache), applyTo is standalone-correct as before.
  function applyTo(el, cachedRect, presampled) {
    try {
      if (el.id && EXCLUDE_IDS[el.id]) return;
      var r = cachedRect || el.getBoundingClientRect();
      // The hero text (esp. the one-line subtitle) is a THIN strip — a flat 24px floor
      // skipped .welcome-sub entirely (it stayed at the dark CSS default, unreadable over
      // a dark/busy wallpaper). Hero elements are text, so a thin sample is fine; relax the
      // height floor for them (keep the width floor so a collapsed/empty node is still skipped).
      var heroEl = false; try { heroEl = el.matches(HERO_ADAPTIVE); } catch (_) {}
      var minH = heroEl ? 10 : 24;
      if (r.width < 24 || r.height < minH) return;
      var L = presampled ? presampled.L
        : backdropLuminance({ left: r.left, top: r.top, width: r.width, height: r.height });
      if (L == null) {
        el.style.removeProperty("background-color");
        el.style.removeProperty("color"); el.style.removeProperty("text-shadow");
        el.style.removeProperty("-webkit-text-fill-color");
        el.removeAttribute("data-adaptive-veil"); el.removeAttribute("data-adaptive-ink");
        return;
      }
      // CHAT BUBBLE polarity (Apple Messages received bubble). Over a BRIGHT wallpaper the
      // bubble becomes a LIGHT frost + DARK ink; over a DARK one it keeps the CSS dark frost
      // + light ink (we just clear our overrides). Chrome never reaches here (pass() sends
      // only bubbles under the glass theme), so the old per-surface dark veil can't crawl back.
      var isBubble = false; try { isBubble = el.matches(BUBBLE_ADAPTIVE); } catch (_) {}
      if (isBubble) {
        // #744 — guarantee the transcript clears the APCA floor over ANY wallpaper. Sample the
        // backdrop COLOUR (not just L), pick polarity, then escalate THIS bubble's scrim alpha
        // until APCA(ink↔composited-surface) ≥ APCA_FLOOR. Frost-only, local, Vault-free.
        var bg = presampled ? presampled.rgb
          : backdropAvgColor({ left: r.left, top: r.top, width: r.width, height: r.height });
        if (!bg) { // no readable backdrop colour → fall back to the CSS default (already floored at SCRIM_BASE)
          el.style.removeProperty("background-color"); el.style.removeProperty("color");
          el.style.removeProperty("text-shadow"); el.style.removeProperty("--ai-scrim-alpha");
          el.removeAttribute("data-adaptive-veil"); el.removeAttribute("data-adaptive-ink");
          el.removeAttribute("data-apca-lc");
          return;
        }
        var s = resolveBubbleScrim(L, bg);
        // Drive the scrim alpha through the CSS var so the floored fill (style.css) and the JS
        // escalation share ONE source of truth; set the frost tint + ink to match the polarity.
        el.style.setProperty("--ai-scrim-alpha", s.scrimAlpha.toFixed(3));
        el.style.setProperty("background-color",
          "rgba(" + s.frostRgb[0] + "," + s.frostRgb[1] + "," + s.frostRgb[2] + ",var(--ai-scrim-alpha))", "important");
        // #738-19 — the surface the ink actually sits on (frost tint composited over the sampled
        // wallpaper at the escalated/hardened alpha). Where the UA supports Safari's contrast-color()
        // we hand the ink pick to it (native, guaranteed-max-contrast black/white against that
        // surface); everywhere else we apply our JS-resolved (floor-hardened) ink. The halo tracks our
        // polarity — which equals the max-contrast pick, since the frost polarity follows the backdrop
        // polarity — so the two paths never disagree on which halo to draw.
        var _surf = compositeOver(s.frostRgb, s.scrimAlpha, bg);
        var _ccInk = supportsContrastColor()
          ? "contrast-color(rgb(" + _surf[0] + "," + _surf[1] + "," + _surf[2] + "))" : null;
        if (s.dark) {
          // dark ink over the light frost — use the hardened ink (byte-identical to INK_DARK in the
          // common case; darker only when a starved mid-tone forced the harden step).
          el.style.setProperty("color",
            _ccInk || ("rgb(" + s.ink[0] + "," + s.ink[1] + "," + s.ink[2] + ")"), "important");
          el.style.setProperty("text-shadow", "none", "important");
          el.setAttribute("data-adaptive-ink", "dark");
        } else {
          // white ink over the dark frost — keep the legibility halo from the CSS default.
          if (_ccInk) el.style.setProperty("color", _ccInk, "important");
          else el.style.removeProperty("color");
          el.style.setProperty("text-shadow", "0 1px 2px rgba(0,0,0,0.55), 0 0 2px rgba(0,0,0,0.40)", "important");
          el.setAttribute("data-adaptive-ink", "light");
        }
        el.setAttribute("data-adaptive-veil", "bubble");
        el.setAttribute("data-apca-lc", Math.round(s.lc));   // probe hook for the smoke test
        return;
      }
      // #763 — the WELCOME HERO (wordmark + subtitle) over the bare wallpaper. Ink-only
      // polarity flip with the APCA floor measured DIRECTLY against the wallpaper (no
      // frost plate). We never paint a background here — only the ink + a contrasting
      // halo. The CSS default is dark-ink+light-halo; we restate or flip it per backdrop.
      var isHero = false; try { isHero = el.matches(HERO_ADAPTIVE); } catch (_) {}
      if (isHero) {
        var hbg = presampled ? presampled.rgb
          : backdropAvgColor({ left: r.left, top: r.top, width: r.width, height: r.height });
        if (!hbg) {  // no readable wallpaper colour → let the CSS default stand
          el.style.removeProperty("color");
          el.style.removeProperty("-webkit-text-fill-color");
          el.style.removeProperty("text-shadow");
          el.removeAttribute("data-adaptive-ink"); el.removeAttribute("data-apca-lc");
          return;
        }
        var h = resolveHeroInk(L, hbg);
        var hcss = "rgb(" + h.ink[0] + "," + h.ink[1] + "," + h.ink[2] + ")";
        el.style.setProperty("color", hcss, "important");
        // .welcome-name uses -webkit-text-fill-color (it was a clipped gradient) — drive it too.
        el.style.setProperty("-webkit-text-fill-color", hcss, "important");
        el.style.setProperty("text-shadow", h.halo, "important");
        el.setAttribute("data-adaptive-ink", h.dark ? "dark" : "light");
        el.setAttribute("data-apca-lc", Math.round(h.lc));
        return;
      }

      var small = false;
      try { small = el.matches(FLIP_SET); } catch (_) {}
      // SMALL bars stay CLEAR (low veil); LARGE surfaces don't flip, so their glass adapts
      // (a stronger veil over bright) to keep the light --fg symbols legible.
      var vmax = small ? VEIL_MAX_SMALL : VEIL_MAX_LARGE;
      // Reach the cap by the per-size full-mute point. Small bars cross over WITH the ink
      // flip (steeper); large surfaces ramp gently so a bright backdrop still shows through
      // (Apple "adjusted luminosity," never an opaque slab).
      var f = clamp(L / (small ? VEIL_FULL_AT_SMALL : VEIL_FULL_AT_LARGE), 0, 1);
      var pct = Math.round(clamp(VEIL_MIN + (vmax - VEIL_MIN) * f, VEIL_MIN, vmax));
      el.style.setProperty("background-color",
        "color-mix(in srgb, var(--panel, var(--bg)) " + pct + "%, transparent)", "important");
      el.setAttribute("data-adaptive-veil", String(pct));

      if (small && L >= INK_THRESHOLD) {
        // SMALL + BRIGHT: flip symbols DARK (the glass stays clear). Faint light halo = margin.
        el.style.setProperty("color", INK_DARK, "important");
        el.style.setProperty("text-shadow", "0 0 2px rgba(255,255,255,0.55)", "important");
        el.setAttribute("data-adaptive-ink", "dark");
      } else {
        // SMALL+dark, or any LARGE surface: keep light --fg (large elements never flip).
        el.style.removeProperty("color");
        // Stronger dark halo: light ink lingers on near-threshold mid-tones (the transition
        // band), so floor its legibility there until the flip takes over.
        el.style.setProperty("text-shadow", "0 1px 3px rgba(0,0,0,0.55)", "important");
        el.setAttribute("data-adaptive-ink", "light");
      }
    } catch (_) {}
  }

  function isGlassFull() { return !!(document.body && document.body.classList.contains("glass-full")); }

  function pass() {
    // Accessibility wins over the optics (WWDC25): under Increase Contrast the system goes
    // predominantly black/white + a contrasting border — the subtle adaptive flip is dropped.
    // Drop our overrides and let the CSS high-contrast treatment stand.
    //
    // UNIFORMITY (owner: "every light surface needs the SAME properties — the kube music
    // player recreated everywhere"; "there should be no old dark glass at all"): under the
    // GLASS THEME — BOTH tiers (Full Glass = theme-frosted+glass-full, Frosted = theme-frosted
    // alone) — the surface is now a FIXED light glass (the kube 0.60 light fill from style.css,
    // identical on every surface; Full adds SVG refraction + specular, Frosted a CSS blur). The
    // adaptive layer used to paint a per-surface, backdrop-varying DARK veil — that was the "old
    // dark glass" the owner is retiring: it would make each surface look DIFFERENT and darken the
    // fixed light fill. So adaptiveGlass STANDS DOWN whenever theme-frosted is active (it never
    // paints a veil/ink under the glass theme). The module + its functions (SURFACES, FLIP_SET,
    // INK_THRESHOLD, the backdrop sampler, etc.) are kept intact for the source-pinned tests; only
    // the runtime is gated. There is no longer any glass tier that wants the adaptive veil.
    // (isGlassFull is retained as a named helper for the source-pinned tests; the standdown is
    // now keyed on theme-frosted, which covers BOTH tiers, so glass-full is a subset of it.)
    // Accessibility wins: under Increase Contrast the system goes black/white + a border;
    // drop ALL our overrides and let the CSS high-contrast treatment stand.
    if (prefersContrast()) { _dropTagged(null); _clearMutedToken(); return; }

    // GLASS THEME (BOTH tiers — theme-frosted): the CHROME is a FIXED light glass (the kube
    // 0.60 fill; Full adds SVG refraction, Frosted a CSS blur). The old per-surface, backdrop-
    // varying DARK veil is RETIRED and must NOT crawl back — so chrome STANDS DOWN. The ONLY
    // adaptive surfaces are the RECEIVED chat bubbles (.msg-ai), which flip polarity like
    // Apple's Messages (light frost+dark ink over a bright wall, dark frost+light ink over a
    // dark one). So: clear every NON-bubble override, then run the adaptive pass on bubbles.
    // (isGlassFull is retained as a named helper for the source-pinned tests; the standdown is
    // keyed on theme-frosted, which covers BOTH tiers, so glass-full is a subset of it.)
    if (isFrosted() || isGlassFull()) {
      // The adaptive surfaces under the glass theme: the RECEIVED chat bubbles (#744) AND the
      // welcome HERO over the bare wallpaper (#763). Both flip ink polarity with the backdrop;
      // everything else (the fixed light glass chrome) stands down.
      //
      // PERF (#1315): a "full" trigger (scroll/resize/theme/backdrop change → the backdrop behind
      // the bubbles moved) re-samples every VISIBLE bubble; a chat DOM mutation re-samples only the
      // bubbles it touched. So a streamed reply costs O(changed bubbles), not O(whole transcript).
      var full = _allDirty;
      _allDirty = false;   // consume it up front — a mutation mid-pass re-schedules a fresh one
      var candidates;
      if (full) {
        _dirtyEls = null;   // belt-and-braces: a full pass covers everything — no scoped leftovers
        // Chrome (+ anything non-adaptive) drops; bubbles + hero kept. Only a full pass needs this —
        // a scoped pass touches no chrome, and its dirty bubbles are re-applied in place below.
        _dropTagged(ADAPTIVE_SEL);      // uses `BUBBLE_ADAPTIVE + ", " + HERO_ADAPTIVE`
        candidates = document.querySelectorAll(ADAPTIVE_SEL);
      } else {
        var pend = _dirtyEls; _dirtyEls = null;
        candidates = [];
        if (pend) pend.forEach(function (el) {
          try { if (el.isConnected && el.matches(ADAPTIVE_SEL)) candidates.push(el); } catch (_) {}
        });
      }
      if (candidates.length) {
        buildBackdrop();   // unified backdrop canvas (cached); the samples below read it
        // ── READ PHASE — layout reads ONLY (visibility + rect + viewport cull + one backdrop sample
        // per bubble). No style writes here, so the batched getBoundingClientRect calls never force a
        // per-element reflow (the read↔write thrash the old interleaved loop caused).
        var vh = window.innerHeight || 800, margin = vh;   // one viewport of look-ahead proximity
        var work = [];
        for (var j = 0; j < candidates.length; j++) {
          var el = candidates[j];
          if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") continue;
          var r = el.getBoundingClientRect();
          // Viewport-proximity cap: skip bubbles far off-screen — the wallpaper is fixed, so they
          // get re-sampled on the scroll that brings them near (and unstyled bubbles show the CSS
          // floor, which is legible by construction). The hero is never culled (welcome, in view).
          var hero = false; try { hero = el.matches(HERO_ADAPTIVE); } catch (_) {}
          if (!hero && (r.bottom < -margin || r.top > vh + margin)) continue;
          work.push([el, r, _sampleBackdrop({ left: r.left, top: r.top, width: r.width, height: r.height })]);
        }
        // ── WRITE PHASE — canvas reads + style writes only (no layout reads → no thrash).
        for (var k = 0; k < work.length; k++) applyTo(work[k][0], work[k][1], work[k][2]);
      }
      if (full) {
        // F-CONTRAST-1 — floor the shared `--fg-muted` token against the fixed light glass (only
        // overrides when #888 misses the secondary-text floor). It reads the WHOLE-viewport backdrop,
        // which only moves on a full trigger — so a scoped streaming pass leaves it untouched.
        _floorMutedToken();
      }
      return;
    }

    // No glass theme → full standdown (the static CSS stands).
    _dropTagged(null);
    _clearMutedToken();
  }

  // Remove our inline overrides from previously-tagged elements. keepSel (a selector) is
  // spared so a bubble's live adaptive ink isn't cleared on the same pass that re-applies it.
  function _dropTagged(keepSel) {
    var tagged = document.querySelectorAll("[data-adaptive-veil],[data-adaptive-ink]");
    for (var i = 0; i < tagged.length; i++) {
      var el = tagged[i];
      if (keepSel) { try { if (el.matches(keepSel)) continue; } catch (_) {} }
      el.style.removeProperty("background-color");
      el.style.removeProperty("color");
      el.style.removeProperty("-webkit-text-fill-color");   // #763 — drop the hero ink override too
      el.style.removeProperty("text-shadow");
      el.style.removeProperty("--ai-scrim-alpha");   // #744 — drop the per-bubble scrim escalation too
      el.removeAttribute("data-adaptive-veil");
      el.removeAttribute("data-adaptive-ink");
      el.removeAttribute("data-apca-lc");
    }
  }

  var _t = 0;
  function schedule() {
    if (_t) return;
    _t = setTimeout(function () { _t = 0; pass(); }, DEBOUNCE_MS);
  }
  // A "full" schedule: the backdrop behind the bubbles moved (scroll/resize/theme/backdrop) — every
  // visible bubble must be re-sampled. Chat DOM mutations use _collectAdaptive (scoped) instead.
  function fullSchedule() { _markAllDirty(); schedule(); }

  // ORW-158: a SCROLL is a full trigger too (bubbles slide over the fixed wallpaper) but it fires continuously - the chat auto-scrolls on every streamed delta - and each full pass is a querySelectorAll
  // + a getBoundingClientRect and a canvas read per visible bubble + style writes (which wake the gadget-rail observer). So a scroll burst is debounced to ONE pass after it goes idle
  // (SCROLL_IDLE_MS), with a max wait (SCROLL_MAX_WAIT_MS) so ink still catches up during a long continuous scroll. Resize/theme/backdrop stay on the immediate fullSchedule.
  var SCROLL_IDLE_MS = 250, SCROLL_MAX_WAIT_MS = 1200;
  var _scrollT = 0, _scrollFirst = 0;
  function scrollSchedule() {
    _markAllDirty();   // cheap flag; the heavy pass waits for the burst to settle
    var now = Date.now();
    if (!_scrollFirst) _scrollFirst = now;
    if (_scrollT) clearTimeout(_scrollT);
    var wait = Math.max(0, Math.min(SCROLL_IDLE_MS, SCROLL_MAX_WAIT_MS - (now - _scrollFirst)));
    _scrollT = setTimeout(function () { _scrollT = 0; _scrollFirst = 0; schedule(); }, wait);
  }

  function init() {
    try {
      schedule();   // the first pass is full (_allDirty starts true)
      window.addEventListener("resize", fullSchedule);
      window.addEventListener("scroll", scrollSchedule, { passive: true, capture: true });
      // re-sample when the theme or the backdrop changes (no new event — observe body). Class/style
      // flips + wallpaper add/remove all move the backdrop → a FULL re-sample.
      var mo = new MutationObserver(fullSchedule);
      mo.observe(document.body, { attributes: true, attributeFilter: ["class", "style"], childList: true, subtree: false });
      // re-sample when CHAT MESSAGES are added/stream in — the body observer is subtree:false, so a
      // freshly-rendered received bubble (.msg-ai) would keep its default light-on-dark ink over a
      // BRIGHT wallpaper until an unrelated scroll/resize fired. Observe #chat-history and mark ONLY
      // the affected bubbles dirty (#1315 scoped pass) so a streamed reply doesn't re-walk the whole
      // transcript. Debounced (schedule). (chat-history is static in index.html, so it exists at init.)
      var _chat = document.getElementById("chat-history");
      if (_chat) {
        var cmo = new MutationObserver(function (muts) {
          for (var i = 0; i < muts.length; i++) {
            var m = muts[i];
            if (m.addedNodes) for (var a = 0; a < m.addedNodes.length; a++) _collectAdaptive(m.addedNodes[a]);
            var t = m.target;
            if (t && t.nodeType === 1) _collectAdaptive(t);
            else if (t && t.parentNode) _collectAdaptive(t.parentNode);
          }
          schedule();
        });
        cmo.observe(_chat, { childList: true, subtree: true });
      }
      ["(prefers-reduced-transparency: reduce)", "(prefers-contrast: more)"].forEach(function (q) {
        try { var mq = window.matchMedia(q); (mq.addEventListener ? mq.addEventListener : mq.addListener).call(mq, "change", fullSchedule); } catch (_) {}
      });
      // #744 — expose the APCA helpers + the floor so the browser-smoke probe can MEASURE the
      // resolved fg/bg pair clears the floor (and the source-pinned test can assert their presence).
      window.OrwellAdaptiveGlass = {
        refresh: fullSchedule, _pass: pass,   // external refresh ⇒ re-sample everything (backdrop may have changed)
        apcaContrast: apcaContrast, compositeOver: compositeOver,
        resolveBubbleScrim: resolveBubbleScrim, APCA_FLOOR: APCA_FLOOR,
        supportsContrastColor: supportsContrastColor,   // #738-19 — Safari contrast-color() PE probe
        resolveMutedInk: resolveMutedInk, MUTED_FLOOR: MUTED_FLOOR,   // F-CONTRAST-1 — muted-text floor probe
      };
    } catch (_) {
      try { window.OrwellAdaptiveGlass = { refresh: function () {} }; } catch (__) {}
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else { init(); }
})();
