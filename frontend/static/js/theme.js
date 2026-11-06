// Theme system — preset themes + custom color editing, stored in localStorage
// ES6 module

import Storage from './storage.js';
import uiModule from './ui.js';
import { initColorPickers, attachColorPicker } from './colorPicker.js';
import { hexToRgb, onAccentColor } from './color/hex.js';
import { makeDraggable } from './windowDrag.js';
import { lowPowerActive, evaluateLowPower, decideLowPower, applyLowPowerClass } from './lowPower.js';
// The glass theme's wallpaper REUSES the login screen's mesh-gradient renderer
// (DRY — one mesh, both surfaces). mountMeshGradient paints the shared
// .login-bg-gradient layer (css/meshGradient.css); resolveLoginBackgroundConfig
// reads the SAME public /api/auth/login-background the login page does, so
// changing the admin login-bg palette changes the glass-theme app background too.
import { mountMeshGradient, mountParticles as _mountParticles, resolveLoginBackgroundConfig, prefersReducedMotion as _meshReducedMotion } from './login_bg.js';

export const THEMES = {
  // ── Apple "Liquid Glass" (iOS 26 / macOS 26 "Tahoe", WWDC25). The DEFAULT and
  //    FIRST entry in the picker. The material is COLORLESS/neutral by Apple's
  //    own rule — "Liquid Glass has no inherent color, and instead takes on colors
  //    from the content directly behind it" (HIG Color) — so the palette here is
  //    a neutral grey set with a desaturated (hueless) `red` accent: no accent hue
  //    on text under the glass material (the global frosted text rule keys off the
  //    body tier class, enforced in style.css). `glassTier:'full'` opts this theme
  //    into the Chromium SVG refraction (the `glass-full` body class) over the CSS
  //    blur baseline; `glass:true` flags it for any glass-aware consumer.
  glass:        { bg:'#15171c', fg:'#eef1f4', panel:'#1d2026', border:'#3a3f47', red:'#9aa3af', glassTier:'full', glass: true },
  // ── 0052 (ruling #13): the HOUSE themes lead the picker — the game's identity,
  //    first in insertion order. Each is a full token set in the preset shape; the
  //    `house: true` flag drives the frosted-chrome + micro-motion treatment
  //    (orwellHouseThemes.css) — frost never on the chat text column, motion gated
  //    by prefers-reduced-motion (never the frost), AA contrast on fg/bg.
  'the-feed':   { bg:'#050a05', fg:'#9fe8a8', panel:'#0a140b', border:'#1f4a26', red:'#ff3b30', house: true },
  'telescreen': { bg:'#101418', fg:'#d7e9ee', panel:'#151c22', border:'#2a3e4a', red:'#56c8e8', house: true },
  'room-101':   { bg:'#232823', fg:'#e8ece4', panel:'#2b302b', border:'#4a524a', red:'#d92e2e', house: true },
  'memory-wall':{ bg:'#0b0f16', fg:'#c8d6ea', panel:'#111827', border:'#2c3a52', red:'#e8b35a', house: true },
  'sequester':  { bg:'#170d10', fg:'#e6d3c4', panel:'#221318', border:'#4a2a33', red:'#c9a227', house: true },
  dark:       { bg:'#282c34', fg:'#9cdef2', panel:'#111111', border:'#355a66', red:'#e06c75' },
  light:      { bg:'#f0ebe3', fg:'#5a5248', panel:'#faf6f0', border:'#d4cdc2', red:'#c47d5a' },
  midnight:   { bg:'#0d1117', fg:'#c9d1d9', panel:'#161b22', border:'#30363d', red:'#f85149' },
  paper:      { bg:'#faf8f5', fg:'#3b3836', panel:'#ffffff', border:'#d5d0c8', red:'#c5ac4a' },
  // Spicy / fun themes
  cyberpunk:  { bg:'#0a0a0f', fg:'#0ff0fc', panel:'#12101a', border:'#9b30ff', red:'#e040fb' },
  retrowave:  { bg:'#1a1a2e', fg:'#e94560', panel:'#16213e', border:'#533483', red:'#e94560' },
  forest:     { bg:'#1b2a1b', fg:'#a8d5a2', panel:'#142414', border:'#3d6b3d', red:'#7cb871' },
  ocean:      { bg:'#0b1a2c', fg:'#64d2ff', panel:'#091422', border:'#1e5074', red:'#4facfe' },
  ume:        { bg:'#2b1b2e', fg:'#f5c2e7', panel:'#1e1420', border:'#6c4675', red:'#f5a0c0' },
  copper:     { bg:'#1c1410', fg:'#e8c39e', panel:'#140f0a', border:'#7a5533', red:'#d4764e' },
  terminal:   { bg:'#000000', fg:'#00ff41', panel:'#0a0a0a', border:'#003b00', red:'#00ff41' },
  organs:     { bg:'#0a0406', fg:'#efe1c8', panel:'#15080a', border:'#3a1519', red:'#c83240' },
  lavender:   { bg:'#f3eef8', fg:'#3d3551', panel:'#faf7ff', border:'#cec3de', red:'#9b6dcc' },
  gpt:        { bg:'#212121', fg:'#ececec', panel:'#171717', border:'#424242', red:'#949494',
                advanced: { sendBtnBg: '#949494', sendBtnHover: '#7f7f7f',
                            userBubbleBg: '#2f2f2f', aiBubbleBg: '#171717',
                            inputBg: '#2f2f2f' } },
  claude:     { bg:'#262624', fg:'#f5f4f0', panel:'#30302e', border:'#4a4a47', red:'#c6613f' },
  cute:       { bg:'#fff0f5', fg:'#d4608a', panel:'#fff8fa', border:'#f0c0d0', red:'#ff6b9d' },
};

// 0052: each preset knows its own key (drives the per-theme house treatment class).
for (const [k, v] of Object.entries(THEMES)) v._key = k;

// M2-8 (road-to-market; audit B6 / r-11): the GAME BUILD's theme picker is curated to an
// ON-BRAND allowlist. Off-brand-named inherited workspace themes ("GPT"/"claude"/"organs"/
// "cute") break the Big Brother fiction, so they are dropped from the game-build VIEW — the
// "Show all themes" reveal lists ONLY the curated set (core six + approved atmospheric extras).
// This curates the VIEW, it does NOT delete themes: the full inherited set still renders under
// ORWELL_GAME_BUILD=0 (the non-game-build else branch below), and Customize stays for power
// users. New inherited themes stay out of the fiction by default until explicitly approved here.
const GAME_BUILD_THEME_ALLOWLIST = new Set([
  // Core six — the glass default + the five 0052 house themes.
  'glass', 'the-feed', 'telescreen', 'room-101', 'memory-wall', 'sequester',
  // Approved atmospheric extras — generic, non-brand aesthetic names that fit the fiction.
  'dark', 'light', 'midnight', 'paper',
  'cyberpunk', 'retrowave', 'forest', 'ocean', 'ume', 'copper', 'terminal', 'lavender',
]);
// The dropped-from-the-game-build set is exactly the off-brand names r-11 flagged. Kept
// explicit as documentation + a belt-and-braces guard the source gate can assert against.
const GAME_BUILD_THEME_DENYLIST = new Set(['gpt', 'claude', 'organs', 'cute']);

// The Apple "Liquid Glass" theme — neutral, colorless, refraction-on — is the
// DEFAULT theme out of the box. A brand-new player, an unset preference, or a
// factory-reset / no-stored-theme session all resolve here; an explicit SAVED
// choice still wins (getSaved() short-circuits every fallback below).
const DEFAULT_THEME = 'glass';
const LS_KEY = 'orwell-theme';
const CUSTOM_THEMES_KEY = 'orwell-custom-themes';

const FONT_MAP = {
  // 'system' = the Apple SF system-font stack (typography audit #696). Real SF renders
  // on Apple devices; Inter (bundled, OFL) is the cross-platform substitute; the rest
  // are platform defaults. We do NOT bundle SF Pro (Apple license) — the system stack
  // pulls the installed SF on Apple OSes.
  system: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro', Inter, 'Segoe UI', Roboto, sans-serif",
  mono: "ui-monospace, 'SF Mono', 'Fira Code', monospace",
  sans: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
};
const DEFAULT_FONT = 'system';
const DEFAULT_DENSITY = 'comfortable';
const MAX_CUSTOM_THEMES = 8;

// Default background patterns for built-in themes
const THEME_DEFAULT_PATTERN = {
  // The glass theme's signature wallpaper — MIRRORS the login background. The
  // 'glass-mesh' sentinel resolves the SAME /api/auth/login-background config the
  // login page uses and paints whatever source it names (photo / gradient-mesh /
  // particles), so the colorless glass chrome lenses the exact same backdrop the
  // login glass did and the desktop reads as a continuation of the sign-in screen.
  // (A user wallpaper image or an explicit pattern, if chosen, supersedes it.)
  glass:      'glass-mesh',
  // A5 (ruling #18) — every HOUSE theme ships a creative particles background that fits its
  // identity, reusing the existing canvas-particle machinery (behind the chat, perf-budgeted,
  // prefers-reduced-motion / document.hidden aware). Tinted to the theme's --fg by default.
  'the-feed':   'rain',          // surveillance signal-static raining down the live feed
  'telescreen': 'perlin-flow',   // the slow phosphor flow of a 1984 CRT
  'room-101':   'synapse',       // a cold institutional monitoring lattice
  'memory-wall':'constellations',// memories as connected points of light
  'sequester':  'embers',        // a warm, slow drift in the jury house
  dark:       'none',
  light:      'dots',
  midnight:   'rain',
  paper:      'dots',
  cyberpunk:  'synapse',
  retrowave:  'embers',
  forest:     'petals',
  ocean:      'constellations',
  terminal:   'perlin-flow',
  organs:     'rain',
  ume:        'petals',
  cute:       'sparkles',
};

// Default effect colors for specific themes (overrides --fg)
const THEME_DEFAULT_EFFECT_COLOR = {
  midnight:   '#ffffff',
  organs:     '#451616',
  cute:       '#ff8cb8',
  ume:        '#f5a0c0',
};

// Default effect intensity (0..1) per theme. Any theme not listed defaults to 1.
const THEME_DEFAULT_INTENSITY = {
  // Subtle — the glass material sits ABOVE the wallpaper; the texture is a hint
  // for the lensing to grab, not noise that competes with content.
  glass:      0.5,
  midnight:   0.5,
  terminal:   0.8,
  organs:     0.65,
  // A5 — the house particles sit BEHIND the frosted chrome, so keep them subtle (texture, not noise).
  'the-feed':    0.5,
  'telescreen':  0.5,
  'room-101':    0.4,
  'memory-wall': 0.55,
  'sequester':   0.5,
};

// The glass tier ladder (Apple parity):
//   • 'full'    → body.theme-frosted + body.glass-full — the CSS glass MATERIAL
//                 PLUS the Chromium SVG refraction/lensing (the defining optic).
//   • 'frosted' → body.theme-frosted only — the CSS blur-glass baseline (the
//                 documented graceful fallback; identical except the lensing).
//   • 'normal'  → neither class — flat, solid chrome.
// COLLAPSED tier (owner ruling): the USER-FACING choice is ONE glass option —
// Glass ('full') or Flat ('normal'). 'frosted' is NO LONGER user-selectable: it was
// glass-material-minus-refraction, and the refraction ALREADY auto-downgrades
// full→frosted on constrained devices (glassTierCeiling / applyGlassTier's clamp), so
// offering it as a manual pick was redundant/invisible. 'frosted' survives ONLY as
// that automatic clamp target — the RESOLUTION layer never yields it. So every theme's
// glass DEFAULT is Glass ('full'); applyGlassTier re-drops it to frosted per device.
function defaultGlassTierFor(name) {
  const t = THEMES[name];
  if (name === 'glass' || (t && (t.glass || t.glassTier === 'full'))) return 'full';
  if (t && t.glassTier === 'normal') return 'normal';
  // Non-glass, non-Flat themes now default to Glass ('full') — the auto-downgrade
  // ceiling (not a manual 'frosted' choice) decides whether the refraction renders.
  return 'full';
}

// Resolve the glass tier for a saved/opts blob (a saved theme record OR a custom
// theme entry). Back-compat order: an explicit `glassTier` wins; else the legacy
// `frosted` bool; else the theme default. COLLAPSED tier (owner ruling): a saved
// 'frosted' (an explicit `glassTier:'frosted'` OR the legacy `frosted:true` bool)
// folds to Glass ('full') — applyGlassTier then clamps it back to frosted on a
// constrained device (its ceiling), so a legacy frosted profile renders IDENTICALLY
// on mobile and simply gains the refraction on a capable desktop ("treat as Glass,
// or its ceiling"). 'normal' (Flat) is unchanged. `name` is the theme the tier
// defaults against when nothing is stored.
function resolveGlassTier(rec, name) {
  if (rec && (rec.glassTier === 'full' || rec.glassTier === 'frosted')) return 'full';
  if (rec && rec.glassTier === 'normal') return 'normal';
  if (rec && rec.frosted !== undefined) return rec.frosted ? 'full' : 'normal';
  return defaultGlassTierFor(name);
}

// #739 — resolve the glass TINT ('clear'|'tinted') for a saved theme record. The
// DEFAULT is 'clear' (the colorless glass, #738 colorless-material default); the
// player opts INTO 'tinted' (a gentle opacity+contrast bump that keeps the
// refraction). An unset/absent preference resolves to 'clear'; only an explicit
// saved `tinted:true` returns 'tinted'. Orthogonal to the glass TIER above.
function resolveGlassTint(rec) {
  return (rec && rec.tinted === true) ? 'tinted' : 'clear';
}

// ── Custom theme persistence ──
// #582: the cross-device merge was additive-only (server themes filled in missing local ones),
// with NO record of a deletion — so a theme deleted on one device resurrected from a stale server
// copy on the next sync. We now carry a TOMBSTONE per deleted name (last-writer-wins): the stored
// blob keeps a reserved `__deleted__` map { name: deletedAtMs } and every theme is stamped with an
// `_updatedAt`. The merge skips (or removes) a server theme whose tombstone is at least as new as
// its update, and tombstones themselves merge LWW — so deletion propagates and never resurrects.
// The reserved key lives INSIDE the synced blob (the existing PUT/GET carries it across devices),
// and is stripped at the _loadCustomThemes chokepoint so no theme consumer ever sees it.
const TOMBSTONE_KEY = '__deleted__';
function _loadRaw() {
  const raw = Storage.getJSON(CUSTOM_THEMES_KEY, {});
  return (raw && typeof raw === 'object') ? raw : {};
}
function _loadCustomThemes() {
  const raw = _loadRaw();
  const out = {};
  for (const k of Object.keys(raw)) {
    if (k === TOMBSTONE_KEY) continue; // reserved — never a theme
    out[k] = raw[k];
  }
  return out;
}
function _loadTombstones() {
  const t = _loadRaw()[TOMBSTONE_KEY];
  return (t && typeof t === 'object') ? t : {};
}
// `themes` is the visible theme map (no reserved key); `tombstones` (optional) replaces the stored
// tombstone map, otherwise the existing one is preserved.
function _saveCustomThemes(themes, tombstones) {
  const blob = {};
  for (const k of Object.keys(themes || {})) {
    if (k === TOMBSTONE_KEY) continue;
    blob[k] = themes[k];
  }
  const tomb = tombstones || _loadTombstones();
  if (tomb && Object.keys(tomb).length) blob[TOMBSTONE_KEY] = tomb;
  Storage.setJSON(CUSTOM_THEMES_KEY, blob);
}
export function saveCustomTheme(name, colors, opts) {
  const ct = _loadCustomThemes();
  // Enforce limit — allow overwriting existing, block new past max
  if (!ct[name] && Object.keys(ct).length >= MAX_CUSTOM_THEMES) {
    return 'limit';
  }
  const entry = { ...colors };
  if (opts) {
    if (opts.font) entry.font = opts.font;
    if (opts.density) entry.density = opts.density;
    if (opts.bgPattern) entry.bgPattern = opts.bgPattern;
    if (opts.bgEffectColor) entry.bgEffectColor = opts.bgEffectColor;
    if (opts.bgEffectIntensity !== undefined) entry.bgEffectIntensity = opts.bgEffectIntensity;
    if (opts.bgEffectSize !== undefined) entry.bgEffectSize = opts.bgEffectSize;
    if (opts.glassTier !== undefined) entry.glassTier = opts.glassTier;
    if (opts.bgImage !== undefined) entry.bgImage = opts.bgImage;
  }
  entry._updatedAt = Date.now();      // LWW stamp
  ct[name] = entry;
  // Re-creating a previously deleted theme supersedes its tombstone.
  const tomb = _loadTombstones();
  if (tomb[name]) delete tomb[name];
  _saveCustomThemes(ct, tomb);
  _syncCustomThemesToServer();
  initThemeUI();
  return 'ok';
}
export function deleteCustomTheme(name) {
  const ct = _loadCustomThemes();
  delete ct[name];
  const tomb = _loadTombstones();
  tomb[name] = Date.now();            // tombstone — LWW against any incoming copy
  _saveCustomThemes(ct, tomb);
  _syncCustomThemesToServer();
  initThemeUI();
}
function _syncCustomThemesToServer() {
  try {
    // Push the full stored blob (themes + the reserved tombstone map) so deletions propagate.
    fetch('/api/prefs/custom-themes', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ value: _loadRaw() }),
    }).catch(e => console.warn('Theme sync (custom) failed:', e));
  } catch (e) { console.warn('Theme sync (custom) error:', e); }
}

// --- Syntax color derivation from theme base colors ---
function hexToHSL(hex) {
  const rgb = hexToRgb(hex) || { r: 0, g: 0, b: 0 };
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  const toHex = v => Math.round(v * 255).toString(16).padStart(2, '0');
  return '#' + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
}

function deriveSyntaxColors(colors) {
  const [fgH, fgS, fgL] = hexToHSL(colors.fg);
  const [bgH, bgS, bgL] = hexToHSL(colors.bg);
  const [redH, redS, redL] = hexToHSL(colors.red || '#e06c75');
  const isDark = bgL < 50;
  const codeBgL = isDark ? Math.max(bgL - 4, 0) : Math.min(bgL + 4, 100);
  return {
    bg: hslToHex(bgH, bgS, codeBgL),
    fg: colors.fg,
    keyword: hslToHex((redH + 280) % 360, Math.min(redS + 10, 80), isDark ? 70 : 45),
    string: hslToHex(40, Math.min(fgS + 20, 70), isDark ? 72 : 42),
    comment: hslToHex(fgH, Math.max(fgS - 20, 5), isDark ? (fgL * 0.5 + bgL * 0.5) : (fgL * 0.5 + bgL * 0.5)),
    function: hslToHex(210, Math.min(fgS + 20, 75), isDark ? 70 : 45),
    // Extra token colors for richer highlighting
    number: hslToHex(20, Math.min(fgS + 15, 65), isDark ? 68 : 48),
    builtin: hslToHex(180, Math.min(fgS + 15, 60), isDark ? 65 : 40),
    variable: hslToHex((fgH + 30) % 360, Math.min(fgS + 5, 60), isDark ? fgL : fgL),
    params: hslToHex(fgH, Math.max(fgS - 5, 10), isDark ? Math.min(fgL + 8, 85) : Math.max(fgL - 8, 25)),
  };
}

// Advanced picker key → CSS variable mapping
const ADV_KEYS = [
  { key: 'userBubbleBg',       css: '--user-bubble-bg',    label: 'User Chat Bubble', group: 'Chat Bubbles' },
  { key: 'aiBubbleBg',         css: '--ai-bubble-bg',      label: 'AI Chat Bubble',   group: 'Chat Bubbles' },
  { key: 'bubbleBorder',       css: '--bubble-border',     label: 'Border Chat Bubble', group: 'Chat Bubbles' },
  { key: 'sidebarBg',          css: '--sidebar-bg',        label: 'Sidebar Bg',       group: 'Sidebar' },
  { key: 'brandColor',         css: '--brand-color',       label: 'Orwell Logo',    group: 'Sidebar' },
  { key: 'hamburgerColor',     css: '--hamburger-color',   label: 'Hamburger Menu',   group: 'Sidebar' },
  { key: 'inputBg',            css: '--input-bg',          label: 'Input Bg',         group: 'Chat Input / Prompt Area' },
  { key: 'inputBorder',        css: '--input-border',      label: 'Input Border',     group: 'Chat Input / Prompt Area' },
  { key: 'sendBtnBg',          css: '--send-btn-bg',       label: 'Send Btn',         group: 'Chat Input / Prompt Area' },
  { key: 'sendBtnHover',       css: '--send-btn-hover',    label: 'Send Hover',       group: 'Chat Input / Prompt Area' },
  { key: 'codeBg',             css: '--code-bg',           label: 'Code Bg',          group: 'Code Blocks' },
  { key: 'codeFg',             css: '--code-fg',           label: 'Code Text',        group: 'Code Blocks' },
  { key: 'toggleActive',       css: '--toggle-active',     label: 'Toggle On',        group: 'Controls' },
];

function computeAdvancedDefaults(colors) {
  const syn = deriveSyntaxColors(colors);
  const red = colors.red || '#e06c75';
  return {
    userBubbleBg: colors.bg,
    aiBubbleBg: colors.panel,
    bubbleBorder: colors.border,
    sidebarBg: colors.panel,
    brandColor: red,
    hamburgerColor: colors.fg,
    inputBg: colors.panel,
    inputBorder: colors.border,
    sendBtnBg: red,
    sendBtnHover: red,
    codeBg: syn.bg,
    codeFg: syn.fg,
    toggleActive: red,
  };
}

function generateHarmonyColors(accentHex, harmonyType, mode) {
  const [h, s] = hexToHSL(accentHex);
  const isDark = mode === 'dark';

  let bgH, bgS, bgL, fgS, fgL, panelL, borderH, borderS, borderL;

  if (harmonyType === 'complementary') {
    bgH = h; bgS = Math.max(s * 0.15, 3);
    bgL = isDark ? 13 : 95; fgL = isDark ? 85 : 15; fgS = Math.max(s * 0.2, 5);
    panelL = isDark ? 8 : 98;
    borderH = h; borderS = Math.max(s * 0.25, 8); borderL = isDark ? 28 : 75;
  } else if (harmonyType === 'analogous') {
    bgH = (h - 30 + 360) % 360; bgS = Math.max(s * 0.12, 3);
    bgL = isDark ? 14 : 95; fgL = isDark ? 84 : 18; fgS = Math.max(s * 0.15, 5);
    panelL = isDark ? 9 : 97;
    borderH = (h + 30) % 360; borderS = Math.max(s * 0.3, 10); borderL = isDark ? 30 : 72;
  } else if (harmonyType === 'triadic') {
    bgH = (h + 240) % 360; bgS = Math.max(s * 0.1, 2);
    bgL = isDark ? 13 : 96; fgL = isDark ? 86 : 14; fgS = Math.max(s * 0.18, 5);
    panelL = isDark ? 8 : 99;
    borderH = (h + 120) % 360; borderS = Math.max(s * 0.2, 8); borderL = isDark ? 28 : 74;
  } else { // monochromatic
    bgH = h; bgS = Math.max(s * 0.08, 2);
    bgL = isDark ? 12 : 96; fgL = isDark ? 87 : 13; fgS = Math.max(s * 0.15, 5);
    panelL = isDark ? 7 : 99;
    borderH = h; borderS = Math.max(s * 0.2, 6); borderL = isDark ? 26 : 76;
  }

  return {
    bg: hslToHex(bgH, bgS, bgL),
    fg: hslToHex(h, fgS, fgL),
    panel: hslToHex(bgH, bgS * 0.6, panelL),
    border: hslToHex(borderH, borderS, borderL),
    red: accentHex,
  };
}

export function applyColors(colors) {
  const s = document.documentElement.style;
  s.setProperty('--bg', colors.bg);
  s.setProperty('--fg', colors.fg);
  s.setProperty('--panel', colors.panel);
  s.setProperty('--border', colors.border);
  if (colors.red) s.setProperty('--red', colors.red);

  // S6-4: luminance-aware text color for accent-backed CTAs. The accent
  // (--accent, falling back to --red) is theme-set AND user-customizable, so
  // white-on-accent can't be guaranteed AA statically — white on the brand red
  // is only ~3.2:1. Pick whichever of near-white / near-dark clears the higher
  // WCAG contrast against the resolved accent and publish it as --on-accent;
  // the CTA rules consume var(--on-accent, #fff). Resolved from the effective
  // accent (--accent isn't set in JS, so it's always --red here).
  s.setProperty('--on-accent', onAccentColor(colors.red || '#e06c75'));

  // Keep the mobile browser toolbar / status bar matched to the theme bg
  // (same as the early head-script does on first paint).
  const _mtc = document.querySelector('meta[name="theme-color"]');
  if (_mtc && colors.bg) _mtc.setAttribute('content', colors.bg);

  // Derive and apply syntax highlighting colors
  const syn = deriveSyntaxColors(colors);
  s.setProperty('--hl-bg', syn.bg);
  s.setProperty('--hl-fg', syn.fg);
  s.setProperty('--hl-keyword', syn.keyword);
  s.setProperty('--hl-string', syn.string);
  s.setProperty('--hl-comment', syn.comment);
  s.setProperty('--hl-function', syn.function);
  s.setProperty('--hl-number', syn.number);
  s.setProperty('--hl-builtin', syn.builtin);
  s.setProperty('--hl-variable', syn.variable);
  s.setProperty('--hl-params', syn.params);

  // Apply advanced overrides (or defaults)
  const adv = colors.advanced || {};
  const defaults = computeAdvancedDefaults(colors);
  for (const { key, css } of ADV_KEYS) {
    s.setProperty(css, adv[key] || defaults[key]);
  }

  // Update favicon to match theme accent color
  _updateFavicon(colors.red || '#e06c75');

  // 0052: the HOUSE treatment — frosted backdrop-blur chrome + per-theme
  // micro-motion (orwellHouseThemes.css keys off these body classes). Frost
  // never touches the chat text column; reduced-motion strips motion only.
  try {
    const body = document.body;
    for (const c of [...body.classList]) {
      if (c.startsWith('house-theme')) body.classList.remove(c);
    }
    if (colors.house) {
      body.classList.add('house-theme');
      if (colors._key) body.classList.add('house-theme--' + colors._key);
      // A translucent panel over the theme bg — the house faintly visible
      // through the chrome. Solid-at-higher-opacity fallback in the CSS.
      const m = /^#?([0-9a-f]{6})$/i.exec(colors.panel || '');
      if (m) {
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
        document.documentElement.style.setProperty('--panel-frost', `rgba(${r}, ${g}, ${b}, 0.62)`);
      }
    }
  } catch (_) {}
}

// Per-route SVG shape registry — kept in sync with the inline favicon
// script in index.html so a theme change keeps the route icon, not the
// default eye. Returns the inner SVG markup colored with `fg`.
const _ROUTE_FAVICON_SHAPES = {
  '/calendar':
    "<rect x='4' y='6' width='24' height='22' rx='2' fill='none' stroke='__C__' stroke-width='2.5'/>" +
    "<line x1='4' y1='12' x2='28' y2='12' stroke='__C__' stroke-width='2.5'/>" +
    "<line x1='10' y1='3' x2='10' y2='9' stroke='__C__' stroke-width='2.5' stroke-linecap='round'/>" +
    "<line x1='22' y1='3' x2='22' y2='9' stroke='__C__' stroke-width='2.5' stroke-linecap='round'/>",
  '/notes':
    "<rect x='6' y='4' width='20' height='24' rx='2' fill='none' stroke='__C__' stroke-width='2.5'/>" +
    "<line x1='10' y1='10' x2='22' y2='10' stroke='__C__' stroke-width='2'/>" +
    "<line x1='10' y1='15' x2='22' y2='15' stroke='__C__' stroke-width='2'/>" +
    "<line x1='10' y1='20' x2='18' y2='20' stroke='__C__' stroke-width='2'/>",
  '/cookbook':
    "<path d='M5 8 L5 26 A2 2 0 0 0 7 28 L25 28 A2 2 0 0 0 27 26 L27 8' fill='none' stroke='__C__' stroke-width='2.5' stroke-linejoin='round'/>" +
    "<path d='M9 4 L23 4 L23 8 L9 8 Z' fill='none' stroke='__C__' stroke-width='2.5' stroke-linejoin='round'/>" +
    "<line x1='11' y1='14' x2='21' y2='14' stroke='__C__' stroke-width='2'/>" +
    "<line x1='11' y1='19' x2='17' y2='19' stroke='__C__' stroke-width='2'/>",
  '/email':
    "<rect x='4' y='7' width='24' height='18' rx='2' fill='none' stroke='__C__' stroke-width='2.5'/>" +
    "<path d='M5 9 L16 17 L27 9' fill='none' stroke='__C__' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/>",
  '/memory':
    "<path d='M16 5 C10 5 6 9 6 14 C6 19 10 21 11 22 L11 26 L21 26 L21 22 C22 21 26 19 26 14 C26 9 22 5 16 5 Z' fill='none' stroke='__C__' stroke-width='2.5' stroke-linejoin='round'/>" +
    "<line x1='12' y1='28' x2='20' y2='28' stroke='__C__' stroke-width='2'/>",
  '/gallery':
    "<rect x='4' y='4' width='24' height='24' rx='2' fill='none' stroke='__C__' stroke-width='2.5'/>" +
    "<circle cx='12' cy='12' r='2.5' fill='__C__'/>" +
    "<path d='M4 22 L11 16 L18 21 L23 17 L28 22' fill='none' stroke='__C__' stroke-width='2.5' stroke-linejoin='round'/>",
  '/tasks':
    "<rect x='4' y='4' width='24' height='24' rx='3' fill='none' stroke='__C__' stroke-width='2.5'/>" +
    "<path d='M9 16 L14 21 L23 11' fill='none' stroke='__C__' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/>",
  '/library':
    "<rect x='5' y='5' width='5' height='22' rx='1' fill='none' stroke='__C__' stroke-width='2.5'/>" +
    "<rect x='13' y='5' width='5' height='22' rx='1' fill='none' stroke='__C__' stroke-width='2.5'/>" +
    "<rect x='21' y='8' width='6' height='19' rx='1' fill='none' stroke='__C__' stroke-width='2.5' transform='rotate(8 24 17)'/>",
};

function _updateFavicon(fg) {
  const path = (window.location.pathname || '').toLowerCase();
  const routeShape = _ROUTE_FAVICON_SHAPES[path];
  let svg;
  if (routeShape) {
    svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>${routeShape.split('__C__').join(fg)}</svg>`;
  } else {
    svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><path d='M2 16Q9 7 16 7Q23 7 30 16Q23 25 16 25Q9 25 2 16Z' fill='none' stroke='${fg}' stroke-width='2.5' stroke-linejoin='round'/><circle cx='16' cy='16' r='4.5' fill='${fg}'/></svg>`;
  }
  const href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  let link = document.querySelector("link[rel='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    document.head.appendChild(link);
  }
  link.href = href;
  let apple = document.querySelector("link[rel='apple-touch-icon']");
  if (!apple) {
    apple = document.createElement('link');
    apple.rel = 'apple-touch-icon';
    document.head.appendChild(apple);
  }
  apple.href = href;
}

// Cache of discovered custom fonts: { "Family Name": [ {file, url, format} ] }
let _customFonts = {};
// Track which custom font families already have @font-face injected
const _injectedFonts = new Set();

function _injectFontFace(familyName, variants) {
  if (_injectedFonts.has(familyName)) return;
  const style = document.createElement('style');
  style.dataset.customFont = familyName;
  const fmtMap = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };
  for (const v of variants) {
    style.textContent += `@font-face { font-family: '${familyName}'; src: url('${v.url}') format('${fmtMap[v.format] || v.format}'); font-display: swap; }\n`;
  }
  document.head.appendChild(style);
  _injectedFonts.add(familyName);
}

// ── Google Fonts (lazy, single-link load) ─────────────────────────────────────
// A chosen Google font is persisted in the SAME `font` field as the built-ins,
// tagged with a `gf:` prefix (e.g. "gf:Roboto Slab"). This keeps the whole
// save/sync/early-paint round-trip intact — built-ins, the custom-folder fonts,
// and Google fonts all live in one string. Built-ins stay 100% offline-safe:
// nothing here runs unless a `gf:` value is selected.
export const GOOGLE_FONT_PREFIX = 'gf:';
// The catalog asset is shipped statically (no Google Fonts Developer API key) and
// fetched once, lazily, the first time the picker is opened.
const GOOGLE_FONTS_ASSET = '/static/fonts/google-fonts.json';
// Only ever ONE dynamic <link> at a time — id lets us find + replace it cleanly.
const GOOGLE_FONT_LINK_ID = 'orwell-google-font-link';
// A weight range broad enough for body + bold UI; display=swap means the UI never
// blocks on the network — it paints the fallback immediately and swaps when ready.
const GOOGLE_FONT_WEIGHTS = 'wght@300;400;500;600;700';

function _googleFamilyFromFont(f) {
  if (typeof f !== 'string' || !f.startsWith(GOOGLE_FONT_PREFIX)) return null;
  const fam = f.slice(GOOGLE_FONT_PREFIX.length).trim();
  return fam || null;
}

// Build the CSS2 URL. The family is URL-encoded; CSS2 wants spaces as '+'.
function _googleFontHref(family) {
  const fam = encodeURIComponent(family).replace(/%20/g, '+');
  return `https://fonts.googleapis.com/css2?family=${fam}:${GOOGLE_FONT_WEIGHTS}&display=swap`;
}

// Inject (or replace) the single dynamic Google-font stylesheet link. Returns the
// quoted family token to drop at the head of the font stack.
function _loadGoogleFont(family) {
  const href = _googleFontHref(family);
  let link = document.getElementById(GOOGLE_FONT_LINK_ID);
  // Swap cleanly: if a DIFFERENT family is selected, remove the prior link first
  // so we never bulk-accumulate stylesheets.
  if (link && link.getAttribute('href') !== href) {
    link.remove();
    link = null;
  }
  if (!link) {
    link = document.createElement('link');
    link.id = GOOGLE_FONT_LINK_ID;
    link.rel = 'stylesheet';
    link.href = href;
    // Graceful fallback: if the stylesheet fails to load (offline / blocked /
    // typo'd family), drop the dynamic link so the family stack falls through to
    // the system fallback. display=swap already prevents a fontless / hung UI.
    link.addEventListener('error', () => {
      const cur = document.getElementById(GOOGLE_FONT_LINK_ID);
      if (cur) cur.remove();
    });
    document.head.appendChild(link);
  }
  return family;
}

// A Google font's family stack always carries a generic system fallback so an
// offline / failed load never leaves the UI fontless.
function _googleFontStack(family) {
  return `'${family.replace(/'/g, '')}', system-ui, -apple-system, 'Segoe UI', sans-serif`;
}

// Reflect an active Google font (gf:Family) into the built-in <select> as a
// synthetic, removable option so the select round-trips and shows the family.
// No-op for built-in / custom-folder fonts.
function _reflectGoogleFontOption(selectEl, fontValue) {
  if (!selectEl) return;
  selectEl.querySelectorAll('option[data-google-font]').forEach(o => o.remove());
  const fam = _googleFamilyFromFont(fontValue);
  if (!fam) return;
  const opt = document.createElement('option');
  opt.value = fontValue;
  opt.textContent = fam + ' (Google)';
  opt.dataset.googleFont = '1';
  selectEl.appendChild(opt);
}

// Keep the Google font text input mirroring the active font: shows the family
// when a Google font is active, blank otherwise.
function _syncGoogleFontInput(fontValue) {
  const input = document.getElementById('theme-google-font-input');
  if (!input) return;
  input.value = _googleFamilyFromFont(fontValue) || '';
}

// Lazily fetch + cache the vendored Google Fonts catalog (names + category).
// No API key — it's a static asset. Failure is non-fatal: free-text still works.
let _googleFontCatalog = null;
let _googleFontCatalogPromise = null;
function _loadGoogleFontCatalog() {
  if (_googleFontCatalog) return Promise.resolve(_googleFontCatalog);
  if (_googleFontCatalogPromise) return _googleFontCatalogPromise;
  _googleFontCatalogPromise = fetch(GOOGLE_FONTS_ASSET, { credentials: 'same-origin' })
    .then(r => r.json())
    .then(data => {
      _googleFontCatalog = (data && Array.isArray(data.families)) ? data.families : [];
      return _googleFontCatalog;
    })
    .catch(e => { console.warn('Google fonts catalog fetch failed:', e); _googleFontCatalog = []; return []; });
  return _googleFontCatalogPromise;
}

// Wire the searchable Google-font combobox: populate the datalist from the
// vendored catalog, mirror the active family, and bind Apply / Clear / Enter.
function _wireGoogleFontPicker(initFont, applyFont, clearFont) {
  const input = document.getElementById('theme-google-font-input');
  const applyBtn = document.getElementById('theme-google-font-apply');
  const clearBtn = document.getElementById('theme-google-font-clear');
  if (!input || input.dataset.gfBound === '1') return;
  input.dataset.gfBound = '1';
  _syncGoogleFontInput(initFont);
  // Populate the datalist from the vendored static list (no network catalog).
  _loadGoogleFontCatalog().then(families => {
    const list = document.getElementById('theme-google-font-list');
    if (!list) return;
    list.innerHTML = families.map(f => {
      const fam = (f && f.family) || '';
      const cat = (f && f.category) ? f.category : '';
      return `<option value="${fam.replace(/"/g, '&quot;')}">${cat}</option>`;
    }).join('');
  });
  const apply = () => { const v = input.value.trim(); if (v) applyFont(v); };
  if (applyBtn && applyBtn.dataset.gfBound !== '1') {
    applyBtn.dataset.gfBound = '1';
    applyBtn.addEventListener('click', apply);
  }
  if (clearBtn && clearBtn.dataset.gfBound !== '1') {
    clearBtn.dataset.gfBound = '1';
    clearBtn.addEventListener('click', () => { input.value = ''; clearFont(); });
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
  // Selecting straight from the datalist (a "change" with a known value) applies
  // immediately — feels like a picker, not a form field.
  input.addEventListener('change', () => { if (input.value.trim()) apply(); });
}

export function applyFontDensity(font, density) {
  const f = font || DEFAULT_FONT;
  const d = density || DEFAULT_DENSITY;
  let family = FONT_MAP[f];
  const gf = _googleFamilyFromFont(f);
  if (!family && gf) {
    // A Google font — lazily load ONLY this family, then point the CSS var at it
    // with a system fallback baked into the stack.
    _loadGoogleFont(gf);
    family = _googleFontStack(gf);
  } else if (!family && _customFonts[f]) {
    // It's a custom font from the local folder
    _injectFontFace(f, _customFonts[f]);
    family = "'" + f + "', sans-serif";
  }
  if (!family) family = FONT_MAP[DEFAULT_FONT];
  document.documentElement.style.setProperty('--font-family', family);
  document.documentElement.classList.remove('density-compact', 'density-spacious');
  if (d !== 'comfortable') document.documentElement.classList.add('density-' + d);
}

const _BG_CLASSES = ['bg-pattern-dots',
  'bg-pattern-synapse', 'bg-pattern-rain', 'bg-pattern-constellations',
  'bg-pattern-perlin-flow',
  'bg-pattern-petals', 'bg-pattern-sparkles', 'bg-pattern-embers'];
const _CANVAS_PATTERNS = { synapse: _initSynapse, rain: _initRain, constellations: _initConstellations,
  'perlin-flow': _initPerlinFlow,
  petals: _initPetals, sparkles: _initSparkles, embers: _initEmbers };

export function applyBgEffectColor(color) {
  document.documentElement.style.setProperty('--bg-effect-color', color || '');
}

export function applyBgEffectIntensity(v) {
  // v is 0..1. Default 1 (full intensity) when missing.
  const n = (v === undefined || v === null || isNaN(v)) ? 1 : Math.max(0, Math.min(1, Number(v)));
  document.documentElement.style.setProperty('--bg-effect-intensity', String(n));
}

export function applyBgEffectSize(v) {
  // v is a multiplier 0.3..2.5. Default 1 when missing.
  const n = (v === undefined || v === null || isNaN(v)) ? 1 : Math.max(0.2, Math.min(3, Number(v)));
  document.documentElement.style.setProperty('--bg-effect-size', String(n));
}

// ── #777-3: mobile / low-end glass-tier AUTO-DOWNGRADE (an automatic CEILING) ──
// The Full-glass tier runs the Chromium SVG refraction (liquidGlass.js) PLUS a
// large concurrent backdrop-filter stack — by far the most expensive thing on the
// page. On a constrained environment (a COARSE pointer, a SMALL viewport, or a
// sustained LOW frame-rate) that cost tanks scrolling/streaming, so we compute an
// automatic CEILING on the glass tier and CLAMP the applied tier DOWN to it. This
// is a RUNTIME cap, NOT a preference change: the user's saved tier is untouched
// (getSaved()/save() keep their explicit choice), the DOM just renders the capped
// tier — and the cap LIFTS again the moment the environment is capable (a desktop
// window, a larger viewport). It only ever LOWERS a tier, never raises one the user
// set lower. We cap Full→Frosted (drop the GPU-heavy refraction, KEEP the CSS glass
// material) — never down to Flat, so the glass look survives on mobile/low-end.
const _TIER_RANK = { normal: 0, frosted: 1, full: 2 };
// ≤ this viewport width ⇒ small-screen (mirrors liquidGlass.js MOBILE_W so the
// tier-drop and the SVG-refraction cap agree on what "small" means).
const LOWEND_VIEWPORT_W = 768;
let _lowFps = false;             // latched true after a sustained low-FPS sample
let _lastRequestedTier = null;   // the last UN-clamped tier requested (for a live re-apply)
let _lowEndWatchBound = false;

function _coarsePointer() {
  try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
  catch (_) { return false; }
}
function _smallViewport() {
  try { return (window.innerWidth || 1280) <= LOWEND_VIEWPORT_W; }
  catch (_) { return false; }
}
function _constrainedEnvironment() {
  return _lowFps || _coarsePointer() || _smallViewport();
}

/** The highest glass tier this environment should render. A constrained device
 *  (coarse pointer OR small viewport OR sustained low FPS) is capped at 'frosted'
 *  (no Full-glass refraction); an unconstrained one has no ceiling ('full'). */
export function glassTierCeiling() {
  // ORW-154/190: a software renderer (no GPU) defaults to Flat — no blur, no glass, no animated wallpaper — unless the
  // player explicitly chose a theme (lowPower.js owns the detection + the precedence rules).
  if (lowPowerActive()) return 'normal';
  return _constrainedEnvironment() ? 'frosted' : 'full';
}

/** Clamp a requested tier DOWN to the environment ceiling — never UP. */
function _clampTierToCeiling(tier) {
  const t = (tier === 'full' || tier === 'frosted' || tier === 'normal') ? tier : 'frosted';
  const ceil = glassTierCeiling();
  return (_TIER_RANK[t] > _TIER_RANK[ceil]) ? ceil : t;
}

// Re-apply the last requested tier when the environment changes (viewport crosses
// the small-screen threshold, pointer type flips, or a low-FPS sample lands) so the
// ceiling stays LIVE. Bound LAZILY on the first applyGlassTier so importing this
// module for its mesh-gradient helpers never spawns listeners.
function _bindLowEndWatch() {
  if (_lowEndWatchBound) return;
  _lowEndWatchBound = true;
  const reapply = () => { if (_lastRequestedTier) applyGlassTier(_lastRequestedTier); };
  let _rt = 0;
  const reeval = () => { clearTimeout(_rt); _rt = setTimeout(reapply, 150); };
  try { window.addEventListener('resize', reeval, { passive: true }); } catch (_) {}
  try {
    const mq = window.matchMedia('(pointer: coarse)');
    if (mq.addEventListener) mq.addEventListener('change', reeval);
    else if (mq.addListener) mq.addListener(reeval);
  } catch (_) {}
  try { _sampleLowFps(); } catch (_) {}
}

// Dynamic signal: sample a short rAF window ONCE, only while Full-glass is actually
// live (the expensive path — nothing to gain otherwise). If the sustained frame-rate
// is badly under budget, latch _lowFps and re-apply so the device drops Full→Frosted.
// One-shot, cheap, fully fail-soft; it can only ever DOWNGRADE.
const _FPS_SAMPLE_FRAMES = 40;
const _FPS_LOWEND_THRESHOLD = 32;   // sustained fps below this ⇒ treat as constrained
let _fpsSampled = false;
function _sampleLowFps() {
  if (_fpsSampled || _lowFps) return;
  if (!(window.requestAnimationFrame && window.performance && performance.now)) return;
  // Only worth measuring when the Full-glass refraction is on screen.
  if (!document.body || !document.body.classList.contains('glass-full')) return;
  _fpsSampled = true;
  let frames = 0;
  const t0 = performance.now();
  const tick = () => {
    if (++frames < _FPS_SAMPLE_FRAMES) { requestAnimationFrame(tick); return; }
    const elapsed = performance.now() - t0;
    const fps = elapsed > 0 ? (frames * 1000) / elapsed : 60;
    if (fps < _FPS_LOWEND_THRESHOLD) {
      _lowFps = true;
      if (_lastRequestedTier) applyGlassTier(_lastRequestedTier);
    }
  };
  try { requestAnimationFrame(tick); } catch (_) {}
}

/** Apply the global glass TIER — the Apple "Liquid Glass" material ladder.
 *  Drives two body classes (the shared contract; style.css + the glass JS
 *  modules key off them):
 *    • 'full'    → body.theme-frosted + body.glass-full
 *                  (CSS glass material PLUS the Chromium SVG refraction/lensing).
 *    • 'frosted' → body.theme-frosted only
 *                  (CSS blur-glass baseline — the documented graceful fallback).
 *    • 'normal'  → neither class (flat, solid chrome).
 *  `theme-frosted` is the material (both glass tiers); `glass-full` gates the
 *  refraction (Full only). Any unrecognized value falls back to 'frosted'.
 *  #777-3: the requested tier is CLAMPED to glassTierCeiling() so a constrained
 *  device (coarse pointer / small viewport / low FPS) never runs Full-glass — the
 *  saved preference is untouched; only the rendered tier is capped. Returns the
 *  EFFECTIVE (clamped) tier. */
export function applyGlassTier(tier) {
  const requested = (tier === 'full' || tier === 'frosted' || tier === 'normal') ? tier : 'frosted';
  _lastRequestedTier = requested;             // remember the raw request for a live re-apply
  const t = _clampTierToCeiling(requested);   // #777-3: cap down on a constrained device
  const frosted = (t === 'full' || t === 'frosted');
  const full = (t === 'full');
  document.body.classList.toggle('theme-frosted', frosted);
  document.body.classList.toggle('glass-full', full);
  applyLowPowerClass(decideLowPower());        // ORW-154/190: the body class follows the same verdict the ceiling used
  _bindLowEndWatch();                          // arm the live-ceiling watch once (lazy)
  return t;
}

/** Back-compat shim for any stray caller (e.g. the cross-device sync seam in
 *  chatStream.js): a truthy "frosted" maps to the 'frosted' tier, falsy to
 *  'normal'. New code should call applyGlassTier directly. */
export function applyFrostedGlass(on) {
  applyGlassTier(on ? 'frosted' : 'normal');
}

/** #739 — Apply the global glass TINT (the iOS 26.1 "Liquid Glass → {Clear, Tinted}"
 *  opacity control). Toggles a single body-STATE class:
 *    • 'tinted' → body.theme-tinted — raises the --ow-glass-opacity token, which the
 *                 two fill tokens derive from, so every glass chrome surface gets a
 *                 gentle neutral opacity+contrast bump (refraction damped-but-kept).
 *    • 'clear'  → class removed (the DEFAULT) — the colorless kube 0.60 glass.
 *  Orthogonal to the glass TIER (Full/Frosted/Off) and to the a11y reduce-
 *  transparency kill-switch (which forces SOLID and outranks this). Any value other
 *  than 'tinted' resolves to Clear. Neutral opacity only — no accent hue, no ink
 *  recolouring. */
export function applyGlassTint(tint) {
  document.body.classList.toggle('theme-tinted', tint === 'tinted');
}

// The fixed full-bleed wallpaper layer id. adaptiveGlass.js samples `#__wp`
// first (see its `ids` list) so the glass legibility flip reads the chosen
// image as its backdrop — keep this id in sync with that consumer.
const WALLPAPER_ID = '__wp';

/** Set (or clear) the fixed full-bleed wallpaper image behind all app content.
 *  An empty / null url REMOVES the layer. The layer is created lazily and lives
 *  at the very back (z-index:-1, pointer-events:none) so it sits behind content
 *  but in front of the document background; the glass material then lenses it. */
export function applyBgImage(url) {
  let wp = document.getElementById(WALLPAPER_ID);
  if (!url) {
    if (wp) wp.remove();
    // restore the opaque theme background (the #__wp layer is gone).
    document.body.classList.remove('has-wallpaper');
    return;
  }
  if (!wp) {
    wp = document.createElement('div');
    wp.id = WALLPAPER_ID;
    wp.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;'
      + 'background-size:cover;background-position:center;background-repeat:no-repeat;';
    document.body.appendChild(wp);
  }
  // A user image SUPERSEDES the glass mesh — drop the mesh child + marker so the
  // image isn't sitting under (or fighting) the aurora layer.
  wp.querySelectorAll('.login-bg-gradient').forEach((c) => c.remove());
  wp.classList.remove('glass-mesh-wp');
  wp.style.removeProperty('background-color');
  wp.style.backgroundImage = `url("${String(url).replace(/"/g, '\\"')}")`;
  // The page (html+body) carries an OPAQUE --bg that would cover the z-index:-1
  // wallpaper. `has-wallpaper` makes them transparent (CSS, author !important — it
  // beats the FOUC inline bg) so #__wp shows and the glass lenses it.
  document.body.classList.add('has-wallpaper');
}

// Downscale an uploaded image to <= MAX_WP_DIM on the long edge and return a
// data URL, capped at MAX_WP_BYTES. Resolves null (with a warning) if the
// encoded result is over the cap — the caller then skips it.
const MAX_WP_DIM = 1600;
const MAX_WP_BYTES = 1.5 * 1024 * 1024; // ~1.5MB cap on the stored data URL
function _downscaleImageFile(file) {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onerror = () => resolve(null);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => resolve(null);
        img.onload = () => {
          try {
            let { width: w, height: h } = img;
            const longEdge = Math.max(w, h);
            if (longEdge > MAX_WP_DIM) {
              const scale = MAX_WP_DIM / longEdge;
              w = Math.round(w * scale);
              h = Math.round(h * scale);
            }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            // Prefer the source mime for PNGs (alpha); JPEG for everything else.
            const isPng = /image\/png/i.test(file.type || '');
            let dataUrl = canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.85);
            // If a PNG blew the cap, retry as JPEG; then re-check.
            if (dataUrl.length > MAX_WP_BYTES && isPng) {
              dataUrl = canvas.toDataURL('image/jpeg', 0.82);
            }
            if (dataUrl.length > MAX_WP_BYTES) {
              console.warn('Background image too large after downscale (> ~1.5MB) — skipped.');
              resolve(null);
              return;
            }
            resolve(dataUrl);
          } catch (e) { console.warn('Background image downscale failed:', e); resolve(null); }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    } catch (e) { console.warn('Background image read failed:', e); resolve(null); }
  });
}

// Read current size multiplier for JS effects (canvas-based).
function _getEffectSize() {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bg-effect-size'));
  return isNaN(v) ? 1 : v;
}

// Patterns where the intensity/size sliders have no visible effect.
const _STATIC_PATTERNS = new Set(['none', 'dots']);

// A5 (ruling #18): the animated canvas particle layers honour prefers-reduced-motion
// — when the user asks for reduced motion we DON'T spawn the rAF generator at all
// (static or off, per spec). The CSS base layer (synapse's grid, dots) still paints,
// so the theme keeps its texture; the canvas-only patterns simply render nothing
// moving. Re-evaluated live (the media query is read each apply), so flipping the OS
// setting + re-applying the theme picks it up without a reload.
function _prefersReducedMotion() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch (_) { return false; }
}

// BG-1 / A5: under reduced-motion, don't leave canvas-only patterns BLANK — run the
// generator but settle it to a STILL frame. We bound requestAnimationFrame to a finite
// SYNCHRONOUS burst so the particle field builds up off-paint and then freezes: the
// texture is preserved (no dead background on telescreen/perlin-flow, embers, etc.) with
// ZERO ongoing motion. rAF is restored immediately after, so nothing keeps animating.
function _bgStaticInit(initFn) {
  const realRaf = window.requestAnimationFrame.bind(window);
  let n = 0;
  window.requestAnimationFrame = function (cb) {
    if (n++ < 90) { try { cb(performance.now()); } catch (_) {} }
    return 0;
  };
  try { initFn(); } finally { window.requestAnimationFrame = realRaf; }
}

// ── The glass-theme DEFAULT wallpaper — MIRRORS the login background (#__wp) ────
// The glass theme's default wallpaper reflects WHATEVER the admin configured the
// login background to be (resolveLoginBackgroundConfig().source), so the desktop
// reads as a continuation of the sign-in screen: a PHOTO login → the photo behind
// the app; a GRADIENT/mesh login → that mesh; a PARTICLES login → the particle
// field; a BUNDLED login → the mesh base (the app's own pattern system owns the
// non-glass patterns, so the glass default falls back to the shared mesh there).
// All sources drive the SAME #__wp layer adaptiveGlass samples + the glass chrome
// lenses. This is the DEFAULT path ONLY: it runs for the 'glass-mesh' sentinel
// pattern (the glass theme's THEME_DEFAULT_PATTERN). The moment a user explicitly
// picks a wallpaper image or a different pattern, that selection wins (bgImage ⇒
// applyBgImage + pattern 'none'; an explicit pattern ⇒ that pattern) and this
// never runs.
//
// Resolved-config cache so a swatch click / re-apply doesn't re-fetch every time.
let _glassMeshCfg = null;
const GLASS_MESH_PATTERN = 'glass-mesh';

// Ensure the #__wp layer exists and is marked as the glass default wallpaper.
// Clears any prior wallpaper content (image / mesh child / particle canvas) so a
// re-render or a source switch never stacks two backgrounds.
function _ensureGlassWp() {
  let wp = document.getElementById(WALLPAPER_ID);
  if (!wp) {
    wp = document.createElement('div');
    wp.id = WALLPAPER_ID;
    wp.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;';
    document.body.appendChild(wp);
  }
  wp.classList.add('glass-mesh-wp');
  wp.style.backgroundImage = '';
  wp.querySelectorAll('.login-bg-gradient, .login-bg-photo, canvas.login-bg-particles').forEach((c) => c.remove());
  return wp;
}

// PERF (#1315): the in-app mesh wallpaper is a paint-triggering background-position
// animation under the whole backdrop-filter stack. It is gated in CSS (meshGradient.css)
// to only RUN under the FULL glass tier (body.glass-full) AND while the tab is visible —
// the Frosted/Normal tiers and a hidden tab freeze it to a still frame (mirroring the
// particle field's still-frame-when-hidden decision in _renderGlassParticles). The tier
// gate is pure CSS; document.hidden has no CSS selector, so we mirror it into a body class
// here. Bound once, module-wide, on first mesh render.
let _meshVisBound = false;
function _bindMeshVisibility() {
  if (_meshVisBound) return;
  _meshVisBound = true;
  const sync = () => {
    try { document.body.classList.toggle('ow-bg-hidden', document.hidden === true); } catch (_) { /* noop */ }
  };
  try { document.addEventListener('visibilitychange', sync); } catch (_) { /* noop */ }
  sync();
}

// Paint the shared login mesh-gradient as the #__wp wallpaper. We do TWO things
// so the layer is both visually rich AND legible under adaptiveGlass:
//   1) set #__wp's OWN background-color to the preset BASE — adaptiveGlass samples
//      #__wp's computed backgroundColor/backgroundImage (NOT child elements or
//      ::before), so the base color gives it a correct luminance read.
//   2) mount the rich .login-bg-gradient child (its ::before blobs + ::after ray)
//      for the actual aurora visual the glass refracts.
// prefers-reduced-motion ⇒ a STATIC mesh (no .is-animated), exactly like login.
function _renderGlassMesh(cfg) {
  const g = (cfg && cfg.gradient) || {};
  const wp = _ensureGlassWp();
  _bindMeshVisibility();   // #1315 — mirror tab-visibility into body.ow-bg-hidden for the CSS pause
  const animate = !_meshReducedMotion();
  const el = mountMeshGradient(wp, {
    animate, preset: g.preset, speed: g.speed, intensity: g.intensity,
    extraClass: 'glass-mesh-layer',
  });
  // The mesh child fills #__wp; force it to the layer's own base so adaptiveGlass
  // reads the right backdrop luminance off #__wp itself.
  const base = getComputedStyle(el).getPropertyValue('--lbg-base').trim() || '#2a1c5e';
  wp.style.backgroundColor = base;
  document.body.classList.add('has-wallpaper');
}

// Paint the admin's login PHOTO as the #__wp wallpaper (cover/center, like login),
// over the mesh base so a slow/broken image never leaves a void. adaptiveGlass
// reads the image off #__wp's own background-image once it loads. An empty photo
// URL falls back to the bundled login image, matching the login page's behaviour.
function _renderGlassPhoto(cfg) {
  const wp = _ensureGlassWp();
  // Mesh base first (graceful fallback + a real luminance read while the image
  // loads / if it 404s) — same as the login's _mountPhoto.
  _renderGlassMeshBaseInto(wp, cfg);
  const url = (cfg && cfg.photoUrl) || '/static/img/login-bg.jpg';
  const probe = new Image();
  probe.onload = () => {
    // Still the active default? (an async load can land after a theme switch).
    if (!document.body.classList.contains('bg-pattern-' + GLASS_MESH_PATTERN)) return;
    wp.style.backgroundImage = `url("${String(url).replace(/"/g, '%22')}")`;
    wp.style.backgroundSize = 'cover';
    wp.style.backgroundPosition = 'center';
    wp.style.backgroundRepeat = 'no-repeat';
    document.body.classList.add('has-wallpaper');
  };
  probe.onerror = () => { /* keep the mesh base */ };
  probe.src = url;
}

// Paint the admin's login PARTICLE field as the #__wp wallpaper. The desktop
// mounts it STATIC (a single still frame, no rAF) for performance — the app +
// the glass refraction are already heavy, so a continuously-animating particle
// canvas behind them is too costly to run all the time (the login, alone on
// screen, animates). The mesh-base color underneath gives adaptiveGlass its read.
function _renderGlassParticles(cfg) {
  const wp = _ensureGlassWp();
  // Set the base luminance from the preset (adaptiveGlass reads #__wp itself;
  // the canvas child is transparent so a base color is required for a clean read).
  _renderGlassBaseColorOnly(wp, cfg);
  _mountParticles(wp, {
    animate: false, // STILL behind the app (documented perf decision)
    particles: cfg && cfg.particles,
    gradient: cfg && cfg.gradient,
  });
  document.body.classList.add('has-wallpaper');
}

// Mount JUST the mesh visual + base color into an already-prepared #__wp (no
// clear). Used as the photo's graceful base layer.
function _renderGlassMeshBaseInto(wp, cfg) {
  const g = (cfg && cfg.gradient) || {};
  _bindMeshVisibility();   // #1315 — the photo's mesh base also animates; keep it gated
  const animate = !_meshReducedMotion();
  const el = mountMeshGradient(wp, {
    animate, preset: g.preset, speed: g.speed, intensity: g.intensity,
    extraClass: 'glass-mesh-layer',
  });
  const base = getComputedStyle(el).getPropertyValue('--lbg-base').trim() || '#2a1c5e';
  wp.style.backgroundColor = base;
}

// Set #__wp's base color to the resolved preset's --lbg-base WITHOUT mounting the
// mesh child (the particle source draws its own field over a flat base — matching
// login_bg.js, which paints a gradient base then particles; here we keep it a flat
// preset base so adaptiveGlass reads a clean luminance and the particles dominate).
function _renderGlassBaseColorOnly(wp, cfg) {
  const g = (cfg && cfg.gradient) || {};
  // Mount a hidden mesh element only to read its computed --lbg-base, then drop it.
  const probe = mountMeshGradient(wp, { animate: false, preset: g.preset, extraClass: 'glass-mesh-layer' });
  const base = getComputedStyle(probe).getPropertyValue('--lbg-base').trim() || '#2a1c5e';
  probe.remove();
  wp.style.backgroundColor = base;
}

// Dispatch the default-wallpaper render by the resolved login-background SOURCE.
function _renderGlassDefault(cfg) {
  const source = (cfg && cfg.source) || 'gradient';
  if (source === 'photo')     { _renderGlassPhoto(cfg); return; }
  if (source === 'particles') { _renderGlassParticles(cfg); return; }
  // 'gradient' (mesh), 'bundled', and anything unknown → the shared mesh. The
  // app's own pattern engine owns the non-glass 'bundled' patterns; the glass
  // DEFAULT keeps the cohesive shared mesh rather than animating a heavy canvas.
  _renderGlassMesh(cfg);
}

/** Apply (or refresh) the glass-theme DEFAULT wallpaper. Resolves the source +
 *  palette from the same public login-background config the login page uses
 *  (cached), then renders the matching background into #__wp. Fail-soft: any
 *  error leaves the prior background. */
export function applyGlassMeshBackground() {
  try {
    if (_glassMeshCfg) { _renderGlassDefault(_glassMeshCfg); return; }
    resolveLoginBackgroundConfig().then((cfg) => {
      _glassMeshCfg = cfg || { source: 'gradient', gradient: { preset: 'aurora' } };
      // Only paint if the glass mesh is still the active pattern (the async
      // resolve may land after the user switched themes).
      if (document.body.classList.contains('bg-pattern-' + GLASS_MESH_PATTERN)) {
        _renderGlassDefault(_glassMeshCfg);
      }
    }).catch(() => {
      _glassMeshCfg = { source: 'gradient', gradient: { preset: 'aurora' } };
      if (document.body.classList.contains('bg-pattern-' + GLASS_MESH_PATTERN)) _renderGlassDefault(_glassMeshCfg);
    });
  } catch (_) { /* fail-soft: keep whatever background is showing */ }
}

// Tear down the glass default wallpaper (when switching to a non-glass pattern or
// to a user image). Removes the mesh/photo/particle content + the marker class +
// the base fill.
function _clearGlassMesh() {
  const wp = document.getElementById(WALLPAPER_ID);
  if (!wp) return;
  wp.querySelectorAll('.login-bg-gradient, .login-bg-photo, canvas.login-bg-particles').forEach((c) => c.remove());
  wp.classList.remove('glass-mesh-wp');
  if (!wp.style.backgroundImage) {
    // No image either ⇒ remove the layer entirely + restore the opaque page bg.
    wp.remove();
    document.body.classList.remove('has-wallpaper');
  } else {
    wp.style.removeProperty('background-color');
  }
}

export function applyBgPattern(pattern) {
  const p = pattern || 'none';
  document.body.classList.remove(..._BG_CLASSES);
  // Clean up any canvas backgrounds
  document.querySelectorAll('#synapse-canvas, #rain-canvas, #constellations-canvas, #perlin-flow-canvas, #petals-canvas, #sparkles-canvas, #embers-canvas').forEach(c => c.remove());
  // The glass mesh wallpaper (#__wp) is a special, non-canvas pattern: paint it
  // via the shared login renderer, mark the body class so the async resolve knows
  // it's still active, and skip the canvas machinery.
  if (p === GLASS_MESH_PATTERN) {
    document.body.classList.add('bg-pattern-' + GLASS_MESH_PATTERN);
    applyGlassMeshBackground();
    const ig0 = document.getElementById('theme-bg-intensity-group');
    const sg0 = document.getElementById('theme-bg-size-group');
    if (ig0) ig0.style.display = 'none';
    if (sg0) sg0.style.display = 'none';
    return;
  }
  // Leaving the glass mesh for any other pattern: tear the mesh layer down first.
  _clearGlassMesh();
  if (p !== 'none') document.body.classList.add('bg-pattern-' + p);
  // Reduced-motion: render a STILL frame of the canvas pattern (not a blank canvas) so
  // canvas-only backgrounds (perlin-flow, embers, …) keep their texture with zero motion (BG-1).
  if (_CANVAS_PATTERNS[p]) {
    if (_prefersReducedMotion()) _bgStaticInit(_CANVAS_PATTERNS[p]);
    else _CANVAS_PATTERNS[p]();
  }
  // Hide sliders that do nothing on static patterns.
  const hide = _STATIC_PATTERNS.has(p);
  const ig = document.getElementById('theme-bg-intensity-group');
  const sg = document.getElementById('theme-bg-size-group');
  if (ig) ig.style.display = hide ? 'none' : '';
  if (sg) sg.style.display = hide ? 'none' : '';
}

// The previous out-of-the-box default (before the Liquid Glass flip). A saved
// record that is EXACTLY the pristine old default — telescreen, its canonical
// palette, and no user customization at all — is the inherited old default, not
// a deliberate choice; we migrate it forward to the new 'glass' default so a
// returning player who never picked a theme lands on glass like a fresh one.
const _PREV_DEFAULT_THEME = 'telescreen';

// A telescreen record is "pristine old default" only if it carries NONE of the
// markers of a deliberate selection or customization: no explicit-selection
// stamp, no advanced color overrides, no wallpaper image, no non-default font/
// density/pattern/effect/tier — i.e. it looks byte-identical to what the old
// boot path auto-resolved when nothing was stored. ANY of these present ⇒ the
// user touched it; leave it alone (never stomp a deliberate choice).
function _isPristineOldDefault(obj) {
  if (!obj || obj.name !== _PREV_DEFAULT_THEME) return false;
  if (obj._explicit) return false;                 // stamped as a real selection
  const c = obj.colors || {};
  const ref = THEMES[_PREV_DEFAULT_THEME] || {};
  // Colors must match the canonical telescreen palette (a customized telescreen
  // — even via the color pickers — has different values and is left untouched).
  for (const k of ['bg', 'fg', 'panel', 'border', 'red']) {
    if ((c[k] || '').toLowerCase() !== (ref[k] || '').toLowerCase()) return false;
  }
  if (c.advanced) return false;
  if (obj.bgImage) return false;
  if (obj.font && obj.font !== DEFAULT_FONT) return false;
  if (obj.density && obj.density !== DEFAULT_DENSITY) return false;
  // The pattern/effect/tier, if present, must equal telescreen's own defaults.
  const defPattern = THEME_DEFAULT_PATTERN[_PREV_DEFAULT_THEME] || 'none';
  if (obj.bgPattern && obj.bgPattern !== defPattern) return false;
  if (obj.bgEffectColor && obj.bgEffectColor !== (THEME_DEFAULT_EFFECT_COLOR[_PREV_DEFAULT_THEME] || '')) return false;
  const defInt = THEME_DEFAULT_INTENSITY[_PREV_DEFAULT_THEME];
  if (obj.bgEffectIntensity !== undefined && defInt !== undefined && obj.bgEffectIntensity !== defInt) return false;
  if (obj.bgEffectSize !== undefined && obj.bgEffectSize !== 1) return false;
  // A non-default tier (telescreen defaults to 'frosted') is a deliberate tweak.
  const t = resolveGlassTier(obj, _PREV_DEFAULT_THEME);
  if (t !== defaultGlassTierFor(_PREV_DEFAULT_THEME)) return false;
  return true;
}

export function getSaved() {
  const obj = Storage.getJSON(LS_KEY, null);
  // Migration: 'chatgpt' preset was renamed to 'gpt'
  if (obj && obj.name === 'chatgpt') obj.name = 'gpt';
  // Migration: 'sakura' preset was renamed to 'ume'
  if (obj && obj.name === 'sakura') obj.name = 'ume';
  // Migration: a pristine, never-customized telescreen record is the stale OLD
  // default — fold it forward to the new glass default (and re-persist so the
  // server copy + every other device converge). A deliberate / customized
  // telescreen is left exactly as-is (_isPristineOldDefault returns false).
  if (_isPristineOldDefault(obj)) {
    const colors = { ...(THEMES[DEFAULT_THEME]) };
    delete colors._key;
    const migrated = {
      name: DEFAULT_THEME, colors,
      glassTier: defaultGlassTierFor(DEFAULT_THEME),
      bgPattern: THEME_DEFAULT_PATTERN[DEFAULT_THEME] || 'none',
    };
    try {
      Storage.setJSON(LS_KEY, migrated);
      _syncToServer(migrated);
    } catch (_) {}
    return migrated;
  }
  return obj;
}

export function save(name, colors, opts) {
  const obj = { name, colors };
  // ORW-154/190: EVERY save() is a deliberate player action (a swatch, a tier/tint/font/density/picker tweak, a custom theme; boot and server
  // sync write storage directly, not through here). Stamp it so the low-power default stands down and a later tweak can never drop the choice.
  obj._explicit = true;
  if (opts) {
    if (opts.font && opts.font !== DEFAULT_FONT) obj.font = opts.font;
    if (opts.density && opts.density !== DEFAULT_DENSITY) obj.density = opts.density;
    if (opts.bgPattern && opts.bgPattern !== 'none') obj.bgPattern = opts.bgPattern;
    if (opts.bgEffectColor) obj.bgEffectColor = opts.bgEffectColor;
    if (opts.bgEffectIntensity !== undefined && opts.bgEffectIntensity !== 1) obj.bgEffectIntensity = opts.bgEffectIntensity;
    if (opts.bgEffectSize !== undefined && opts.bgEffectSize !== 1) obj.bgEffectSize = opts.bgEffectSize;
    // Persist the glass TIER as a string. The user-facing control now produces only
    // 'full' (Glass) or 'normal' (Flat) — 'frosted' is no longer selectable (owner
    // ruling), though it is still READ on load (back-compat) and folded to Glass by
    // resolveGlassTier. The default varies per theme (defaultGlassTierFor), so we
    // record whatever the caller resolved — otherwise the per-theme default would
    // override the user's pick on the next boot. The legacy `frosted` bool is read on
    // load (back-compat) but no longer WRITTEN; glassTier supersedes it.
    if (opts.glassTier !== undefined) obj.glassTier = opts.glassTier;
    // #739 — persist the glass TINT only when opted-in (tinted). Clear is the
    // default, so we OMIT the field for Clear (matching the other default-omit
    // fields above) — an absent `tinted` resolves to Clear on load.
    if (opts.tinted) obj.tinted = true;
    // A chosen wallpaper image (URL or downscaled data URL). Empty ⇒ omit.
    if (opts.bgImage) obj.bgImage = opts.bgImage;
    // Stamp a DELIBERATE selection so the stale-old-default migration
    // (_isPristineOldDefault) never folds a theme the user actually chose. The
    // swatch-click handler passes this; auto-saves (live color edits etc.) don't
    // need it because they always diverge from the pristine palette anyway.
    if (opts._explicit) obj._explicit = true;
  }
  Storage.setJSON(LS_KEY, obj);
  _syncToServer(obj);
  // ORW-154/190: an explicit choice just landed — the low-power default stands down, so re-apply the tier now.
  if (obj && obj._explicit) { try { evaluateLowPower(); if (_lastRequestedTier) applyGlassTier(_lastRequestedTier); } catch (_) { /* noop */ } }
}

function _syncToServer(obj) {
  try {
    fetch('/api/prefs/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ value: obj }),
    }).catch(e => console.warn('Theme sync failed:', e));
  } catch (e) { console.warn('Theme sync error:', e); }
}

async function _loadFromServer() {
  try {
    const res = await fetch('/api/prefs/theme', { credentials: 'same-origin' });
    const data = await res.json();
    return data.value || null;
  } catch { return null; }
}


function syncPickers(colors) {
  document.getElementById('clr-bg').value = colors.bg;
  document.getElementById('clr-fg').value = colors.fg;
  document.getElementById('clr-panel').value = colors.panel;
  document.getElementById('clr-border').value = colors.border;
  document.getElementById('clr-red').value = colors.red;
  syncAdvancedPickers(colors);
}


function syncAdvancedPickers(colors) {
  const adv = colors.advanced || {};
  const defaults = computeAdvancedDefaults(colors);
  for (const { key } of ADV_KEYS) {
    const el = document.getElementById('adv-' + key);
    if (el) el.value = adv[key] || defaults[key];
  }
}

// AXE-1 (WCAG 2.1.1 Keyboard): roving-tabindex/listbox helpers for the .ow-swatch-grid grids
// (mirrors the same pattern used for the model picker's rows in models.js). Each grid
// (`#themeGrid`, `#themeUserGrid`) keeps exactly one visible `.ow-swatch` at
// tabindex="0"; Arrow keys move the roving tab stop within that same grid, Enter/Space
// activates the focused swatch.
function _visibleSwatches(gridEl) {
  return Array.prototype.filter.call(
    gridEl.querySelectorAll('.ow-swatch'),
    (el) => el.offsetParent !== null
  );
}
function _ensureSwatchTabindex(gridEl) {
  if (!gridEl) return;
  const items = _visibleSwatches(gridEl);
  if (!items.length) return;
  if (!items.some((el) => el.tabIndex === 0)) {
    items.forEach((el) => { el.tabIndex = -1; });
    items[0].tabIndex = 0;
  }
}
function _onSwatchKeydown(e) {
  const sw = e.currentTarget;
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    sw.click();
    return;
  }
  // AXE-1 / #1658: the per-tile ✕ delete control is tabindex="-1" (so the listbox stays ONE Tab stop
  // per grid, not one-per-delete-button), so expose delete as a keyboard action on the focused custom
  // option — Delete or Backspace clicks the sibling ✕ (reusing its styledConfirm + delete flow). A
  // built-in preset swatch has no ✕ (no .ow-swatch-cell wrapper) ⇒ delBtn is null ⇒ no-op.
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const delBtn = sw.parentElement && sw.parentElement.querySelector('.theme-delete-btn');
    if (delBtn) {
      e.preventDefault();
      delBtn.click();
    }
    return;
  }
  const NAV_KEYS = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (NAV_KEYS.indexOf(e.key) === -1) return;
  const gridEl = sw.closest('.ow-swatch-grid');
  if (!gridEl) return;
  const items = _visibleSwatches(gridEl);
  if (!items.length) return;
  e.preventDefault();
  const cur = items.indexOf(sw);
  let next;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = cur < 0 ? 0 : (cur + 1) % items.length;
  else next = cur < 0 ? items.length - 1 : (cur - 1 + items.length) % items.length;
  items.forEach((el) => { el.tabIndex = -1; });
  items[next].tabIndex = 0;
  items[next].focus();
}

export function initThemeUI() {
  // The Theme window's drag/geometry is now owned by the OrwellWindow kit
  // (initThemeKitWindow / togglePopup) — no bespoke makeDraggable wiring here.
  // (makeDraggable stays exported for other consumers, e.g. sessions.js.)
  initThemeKitWindow();

  // Attach the in-house color picker to every color input in the theme panel.
  // Safe to call repeatedly — the picker marks inputs it's already wrapped.
  try { initColorPickers(document); } catch (e) { console.warn('Color picker init failed', e); }

  // Populate the advanced color inputs with their computed defaults right now.
  // BUG FIX: without this, untouched inputs sat at the browser-default `#000000`
  // until the user clicked a swatch; the first edit of ANY advanced input then
  // tripped readAdvanced() into storing every other `#000000` as an override —
  // e.g. editing Chat Bubble Border turned Sidebar Bg pure black.
  try {
    const saved = getSaved();
    if (saved && saved.colors) {
      syncAdvancedPickers(saved.colors);
    }
  } catch (e) { console.warn('syncAdvancedPickers on init failed', e); }
  // Wire up theme tabs (Themes / Customize)
  const themeTabs = document.getElementById('theme-tabs');
  if (themeTabs) {
    themeTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.admin-tab');
      if (!tab) return;
      const targetId = tab.dataset.tab;
      themeTabs.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.theme-tab-panel').forEach(p => p.style.display = 'none');
      const panel = document.getElementById(targetId);
      if (panel) panel.style.display = '';
      // Show the opacity slider only on the Customize tab.
      const opWrap = document.getElementById('theme-opacity-wrap');
      if (opWrap) opWrap.classList.toggle('hidden', targetId !== 'theme-tab-customize');
      // Restore full opacity / blur on every other tab. The slider's effect
      // is meant to be Customize-only — peeking at the page while tweaking
      // colors — so swapping back to Themes (or Schedule) should look
      // exactly like the rest of the app's modals again.
      // Peek fades the KIT FRAME (.ow-window) now — fall back to #theme-popup if
      // the kit hasn't built yet.
      const popup = _themePeekTarget();
      if (popup) {
        if (targetId === 'theme-tab-customize') {
          // Reapply the Peek toggle's current state.
          if (opWrap && opWrap._apply) opWrap._apply();
        } else {
          popup.style.removeProperty('opacity');
          popup.style.removeProperty('background');
          popup.style.removeProperty('backdrop-filter');
          popup.style.removeProperty('-webkit-backdrop-filter');
          // Clear the peek tint off the kit titlebar too, so it reverts to its
          // CSS window-chrome background when leaving Customize.
          const hdr = popup.querySelector('.ow-titlebar') || document.getElementById('theme-popup-header');
          if (hdr) hdr.style.removeProperty('background-color');
          popup.querySelectorAll('.admin-card').forEach(c => {
            c.style.removeProperty('background');
            c.style.removeProperty('backdrop-filter');
            c.style.removeProperty('-webkit-backdrop-filter');
          });
        }
      }
    });
  }


  // Wire the "Peek" opacity toggle — fades the theme modal so the user can
  // see the page behind it while tweaking colors on the Customize tab.
  // On/off only (no slider); starts off, lives in the title bar, and is
  // cleared when the user swaps to Themes / Schedule.
  (function _wireOpacityToggle() {
    const toggle = document.getElementById('theme-opacity-wrap');
    if (!toggle || toggle.dataset.bound === '1') return;
    toggle.dataset.bound = '1';
    const PEEK = 55; // % opacity when peeking
    // Peek fades the KIT FRAME (.ow-window) — resolve it live each apply (it may
    // not be built/connected when this wires up). The kit titlebar fades with it
    // so the whole window — header included — goes glassy.
    const apply = (on) => {
      const popup = _themePeekTarget();
      if (!popup) return;
      const header = popup.querySelector('.ow-titlebar') || document.getElementById('theme-popup-header');
      const cards = popup.querySelectorAll('.admin-card');
      if (on) {
        // Fade the modal + each inner card via color-mix — never element
        // opacity, so text, controls and swatches stay sharp.
        const bgMix    = `color-mix(in srgb, var(--bg)    ${PEEK}%, transparent)`;
        const panelMix = `color-mix(in srgb, var(--panel) ${PEEK}%, transparent)`;
        popup.style.setProperty('background', bgMix, 'important');
        popup.style.setProperty('backdrop-filter', 'none', 'important');
        popup.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
        popup.style.removeProperty('opacity');
        if (header) header.style.setProperty('background-color', bgMix, 'important');
        cards.forEach(c => {
          c.style.setProperty('background', panelMix, 'important');
          c.style.setProperty('backdrop-filter', 'none', 'important');
          c.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
        });
      } else {
        popup.style.removeProperty('opacity');
        popup.style.removeProperty('background');
        popup.style.removeProperty('backdrop-filter');
        popup.style.removeProperty('-webkit-backdrop-filter');
        if (header) header.style.removeProperty('background-color');
        cards.forEach(c => {
          c.style.removeProperty('background');
          c.style.removeProperty('backdrop-filter');
          c.style.removeProperty('-webkit-backdrop-filter');
        });
      }
    };
    // Expose so the tab-switch handler can reapply when returning to Customize.
    toggle._apply = () => apply(toggle.classList.contains('active'));
    toggle.addEventListener('click', () => {
      const on = !toggle.classList.contains('active');
      toggle.classList.toggle('active', on);
      toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      apply(on);
    });
  })();

  const grid = document.getElementById('themeGrid');
  if (!grid) return;

  const saved = getSaved();
  const activeName = saved ? saved.name : DEFAULT_THEME;
  const customThemes = _loadCustomThemes();

  // Render preset swatches. J1-06: in the game build the curated 5 house themes (0052) are diluted
  // by ~16 inherited workspace themes (GPT/claude/cute/…) that shatter the Big Brother fiction
  // (Hick's law + brand coherence). So under the game build, show the house themes first and tuck
  // the rest behind a "Show all themes" reveal — power users keep them, and Customize is untouched.
  // The full inherited workspace (no game build) renders every theme as before.
  // J1-24: the abstract 3-dot row undersold what a theme looks like. Paint the
  // tile itself in the theme's OWN bg + fg so the swatch is a mini-preview (you
  // see the real surface + text colour), with the accent dots as a secondary
  // signal. The dual-ring dot CSS keeps each dot legible on any tile.
  // AXE-1 (WCAG 2.1.1 Keyboard): role="option" + roving tabindex so the swatch grid is fully
  // keyboard-operable (Tab reaches the grid once via the one tabindex="0" swatch, Arrow keys move
  // between swatches, Enter/Space picks) — see _ensureSwatchTabindex / _onSwatchKeydown below.
  // The tile is the .ow-swatch kit primitive (#1638): a role=option selectable tile whose
  // selected state is driven SOLELY by aria-selected (no bare `.active` co-class). `opts.extra`
  // marks a non-house tile for the game-build reveal collapse. Note: `_entries.map(_swatch)` is
  // safe — Array.map passes the index as the 2nd arg, and `(number).extra` is undefined ⇒ falsy.
  const _swatch = ([name, c], opts) => {
    const label = name === 'dark' ? 'original' : (name === 'gpt' ? 'GPT' : name.replace(/-/g, ' '));
    const _extra = !!(opts && opts.extra);
    return `
    <div class="ow-swatch ow-swatch--preview${_extra ? ' ow-swatch--extra' : ''}" data-theme="${name}"
         style="background:${c.bg};color:${c.fg};border-color:${c.panel};"
         role="option" tabindex="-1" aria-selected="${name === activeName}" aria-label="${label} theme">
      <div class="ow-swatch__dots">
        <span class="ow-swatch__dot" style="background:${c.bg}"></span>
        <span class="ow-swatch__dot" style="background:${c.panel}"></span>
        <span class="ow-swatch__dot" style="background:${c.fg}"></span>
        <span class="ow-swatch__dot" style="background:${c.red}"></span>
      </div>
      ${label}
    </div>`;
  };
  const _gameBuild = !!(document.body && document.body.hasAttribute('data-game-build'));
  const _entries = Object.entries(THEMES);
  if (_gameBuild) {
    // The glass theme (the neutral Apple default) leads alongside the house
    // themes — it's the out-of-box look, not an "extra" tucked behind the reveal.
    const _isLead = (n, c) => n === 'glass' || c.glass || c.house;
    // M2-8: curate the game-build VIEW to the on-brand allowlist. The off-brand-named
    // inherited themes (gpt/claude/organs/cute) are dropped here — but a power user whose
    // CURRENT pick is one of them still sees it up-front (never hide the active theme), and
    // it survives ORWELL_GAME_BUILD=0 (the else branch renders every theme).
    const _curated = _entries.filter(
      ([n]) => GAME_BUILD_THEME_ALLOWLIST.has(n) || n === activeName
    );
    const houseEntries = _curated.filter(([n, c]) => _isLead(n, c));
    const otherEntries = _curated.filter(([n, c]) => !_isLead(n, c));
    // Keep the active (non-house) theme visible up-front so a power user's current pick isn't hidden.
    const activeIsOther = otherEntries.some(([n]) => n === activeName);
    // The listbox (`#themeGrid`, role=listbox) owns ONLY role=option swatches — the extra
    // (non-house) tiles are direct grid children carrying `.ow-swatch--extra`, collapsed via a
    // class on the grid. The "Show all" BUTTON is a layout sibling OUTSIDE the listbox (a listbox
    // may own only options), (re)built here on each render so it never duplicates.
    const _collapsed = otherEntries.length > 0 && !activeIsOther;
    grid.classList.toggle('is-collapsed', _collapsed);
    grid.innerHTML = houseEntries.map(_swatch).join('')
      + otherEntries.map((e) => _swatch(e, { extra: true })).join('');
    const _stale = grid.parentNode && grid.parentNode.querySelector('#theme-show-all');
    if (_stale) _stale.remove();
    if (otherEntries.length) {
      const _showAll = document.createElement('button');
      _showAll.type = 'button';
      _showAll.className = 'theme-show-all';
      _showAll.id = 'theme-show-all';
      _showAll.setAttribute('aria-controls', 'themeGrid');
      _showAll.setAttribute('aria-expanded', _collapsed ? 'false' : 'true');
      _showAll.textContent = _collapsed ? `Show all themes (${otherEntries.length})` : 'Hide extra themes';
      grid.insertAdjacentElement('afterend', _showAll);
      _showAll.addEventListener('click', () => {
        const nowCollapsed = grid.classList.toggle('is-collapsed');
        _showAll.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
        _showAll.textContent = nowCollapsed ? `Show all themes (${otherEntries.length})` : 'Hide extra themes';
        // Re-home the roving tab stop among the now-visible swatches.
        _ensureSwatchTabindex(grid);
      });
    }
  } else {
    grid.innerHTML = _entries.map(_swatch).join('');
  }

  // Render custom theme swatches into separate card
  const userGrid = document.getElementById('themeUserGrid');
  const userCard = document.getElementById('themeUserCard');
  const customEntries = Object.entries(customThemes);
  if (customEntries.length > 0 && userGrid && userCard) {
    userCard.style.display = '';
    // Each custom entry is a presentational WRAPPER cell owning the role=option swatch AND the
    // delete button as SIBLINGS — the button sits OUTSIDE the option (per WAI-ARIA, an option's
    // descendants are presentational, so a nested <button> would lose its role + add a phantom
    // tab stop). The wrapper anchors the ✕'s absolute placement so the tile look is unchanged.
    userGrid.innerHTML = customEntries.map(([name, c]) => `
      <div class="ow-swatch-cell" role="presentation">
        <div class="ow-swatch ow-swatch--custom" data-theme="${name}" data-custom="1"
             role="option" tabindex="-1" aria-selected="${name === activeName}" aria-label="${name} theme">
          <div class="ow-swatch__dots">
            <span class="ow-swatch__dot" style="background:${c.bg}"></span>
            <span class="ow-swatch__dot" style="background:${c.panel}"></span>
            <span class="ow-swatch__dot" style="background:${c.fg}"></span>
            <span class="ow-swatch__dot" style="background:${c.red}"></span>
          </div>
          <span class="ow-swatch__name">${name}</span>
        </div>
        <button type="button" class="theme-delete-btn" data-delete="${name}" tabindex="-1" title="Delete theme" aria-label="Delete theme ${name}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    `).join('');
  } else if (userCard) {
    userCard.style.display = 'none';
  }

  // Helper: save with current font/density/bgPattern from UI selects
  function _getOpts() {
    const opts = {};
    const fs = document.getElementById('theme-font-select');
    const ds = document.getElementById('theme-density-select');
    const ps = document.getElementById('theme-bg-pattern-select');
    const ec = document.getElementById('theme-bg-effect-color');
    const es = document.getElementById('theme-bg-intensity');
    const sz = document.getElementById('theme-bg-size');
    if (fs) opts.font = fs.value;
    if (ds) opts.density = ds.value;
    if (ps) opts.bgPattern = ps.value;
    if (ec) opts.bgEffectColor = ec.value;
    if (es) opts.bgEffectIntensity = parseFloat(es.value) / 100;
    if (sz) opts.bgEffectSize = parseFloat(sz.value) / 100;
    // Glass tier — the 3-way control (id=theme-glass-tier). Its current value is
    // mirrored onto the control's dataset by the change handler; read that.
    const gt = document.getElementById('theme-glass-tier');
    if (gt && gt.dataset.value) opts.glassTier = gt.dataset.value;
    // #739 — glass TINT — the 2-way control (id=theme-glass-tint). Its current
    // value ('clear'|'tinted') rides the control's dataset (set by the change
    // handler + _syncGlassTintControl). Persist a boolean; absent ⇒ Clear.
    const gtint = document.getElementById('theme-glass-tint');
    if (gtint && gtint.dataset.value) opts.tinted = (gtint.dataset.value === 'tinted');
    // The wallpaper image is tracked on the bg-source control's dataset (a URL or
    // a downscaled data URL), set whenever an image is applied. Empty ⇒ omit.
    const bs = document.getElementById('theme-bg-source');
    if (bs && bs.dataset.image) opts.bgImage = bs.dataset.image;
    return opts;
  }
  function _saveFull(name, colors) { save(name, colors, _getOpts()); }

  // Click handlers for all swatches (preset + custom) across both grids
  const allGrids = [grid, userGrid].filter(Boolean);
  // Selected state is single-sourced on aria-selected (#1638): the .ow-swatch CSS keys the
  // selected ring off [aria-selected="true"], so there is no separate `.active` class to keep
  // in sync (removes the visual/AT drift risk).
  function clearAllActive() {
    allGrids.forEach(g => g.querySelectorAll('.ow-swatch').forEach(s => {
      s.setAttribute('aria-selected', 'false');
    }));
  }
  allGrids.forEach(g => {
    // AXE-1: land the roving tabindex once per grid so Tab reaches it; keydown below
    // (Arrow/Home/End/Enter/Space) is wired per-swatch alongside the existing click handler.
    _ensureSwatchTabindex(g);
    g.querySelectorAll('.ow-swatch').forEach(sw => {
      sw.addEventListener('keydown', _onSwatchKeydown);
      sw.addEventListener('click', (e) => {
        if (e.target.closest('.theme-delete-btn')) return;
        const name = sw.dataset.theme;
        const colors = sw.dataset.custom ? customThemes[name] : THEMES[name];
        if (!colors) return;
        applyColors(colors);
        clearAllActive();
        sw.setAttribute('aria-selected', 'true');
        syncPickers(colors);
        const ct = sw.dataset.custom ? customThemes[name] : null;
        const f = ct && ct.font ? ct.font : DEFAULT_FONT;
        const d = ct && ct.density ? ct.density : DEFAULT_DENSITY;
        const p = ct && ct.bgPattern ? ct.bgPattern : (THEME_DEFAULT_PATTERN[name] || 'none');
        const ec = ct && ct.bgEffectColor ? ct.bgEffectColor : (THEME_DEFAULT_EFFECT_COLOR[name] || '');
        const ei = (ct && ct.bgEffectIntensity !== undefined) ? ct.bgEffectIntensity : (THEME_DEFAULT_INTENSITY[name] !== undefined ? THEME_DEFAULT_INTENSITY[name] : 1);
        const sz = (ct && ct.bgEffectSize !== undefined) ? ct.bgEffectSize : 1;
        // #780 (glass-tier override gap): a BUILT-IN theme has no `ct`, so
        // resolveGlassTier(null, name) always returned the per-theme DEFAULT — which
        // CLOBBERED a tier the player had explicitly chosen for that same theme (e.g.
        // 'glass' forced back to 'full' on every re-select, so a saved 'frosted'/'normal'
        // never survived). When re-selecting the SAME theme that is already saved with an
        // explicit tier, preserve it; only fall to the theme default on a genuine theme change.
        const _savedRec = getSaved();
        const _tierRec = ct || ((_savedRec && _savedRec.name === name) ? _savedRec : null);
        const tier = resolveGlassTier(_tierRec, name);
        // A custom theme may carry its own wallpaper; a built-in preset has none
        // (selecting a built-in clears any active image so its pattern shows).
        const img = (ct && ct.bgImage) ? ct.bgImage : '';
        applyFontDensity(f, d);
        applyBgEffectColor(ec);
        applyBgEffectIntensity(ei);
        applyBgEffectSize(sz);
        applyGlassTier(tier);
        applyBgImage(img);
        // An image supersedes the animation; otherwise paint the pattern.
        applyBgPattern(img ? 'none' : p);
        const fs = document.getElementById('theme-font-select');
        const ds = document.getElementById('theme-density-select');
        const ps = document.getElementById('theme-bg-pattern-select');
        const ecs = document.getElementById('theme-bg-effect-color');
        const eis = document.getElementById('theme-bg-intensity');
        const szs = document.getElementById('theme-bg-size');
        if (fs) { _reflectGoogleFontOption(fs, f); fs.value = f; }
        _syncGoogleFontInput(f);
        if (ds) ds.value = d;
        if (ps) ps.value = p;
        if (ecs) ecs.value = ec || colors.fg || '#9cdef2';
        if (eis) eis.value = String(Math.round(ei * 100));
        if (szs) szs.value = String(Math.round(sz * 100));
        _syncGlassTierControl(tier);
        _syncBgSourceControls(img);
        // #739 — carry the CURRENT glass tint through a preset-swatch apply (the swatch handler
        // leaves the tint control untouched, so _getOpts().tinted is the live value); without it
        // save() would drop `tinted` from the persisted record and the next reload/sync reverts to Clear.
        save(name, colors, { font: f, density: d, bgPattern: (img ? 'none' : p), bgEffectColor: ec, bgEffectIntensity: ei, bgEffectSize: sz, glassTier: tier, tinted: _getOpts().tinted, bgImage: img, _explicit: true });
      });
    });
    g.querySelectorAll('.theme-delete-btn').forEach(btn => { // per-tile delete X (kept in-tile; out of primitive scope)
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = btn.dataset.delete;
        if (uiModule && uiModule.styledConfirm) {
          if (!await uiModule.styledConfirm(`Delete theme "${name}"?`, { confirmText: 'Delete', danger: true })) return;
        }
        deleteCustomTheme(name);
      });
    });
  });

  // Init color pickers from current theme and apply syntax colors
  const currentColors = saved ? saved.colors : THEMES[DEFAULT_THEME];
  applyColors(currentColors);
  syncPickers(currentColors);

  // Reference colors for per-picker reset (the theme you started from)
  const refName = saved ? saved.name : DEFAULT_THEME;
  const refColors = THEMES[refName] || customThemes[refName] || currentColors;
  const refDefaults = computeAdvancedDefaults(refColors);

  // Sync reset button visibility based on whether color differs from reference
  function syncResetButtons() {
    document.querySelectorAll('.ow-color-well__reset[data-reset]').forEach(btn => {
      const key = btn.dataset.reset;
      const picker = document.getElementById(pickerIds[key]);
      if (picker && refColors[key]) {
        const changed = picker.value.toLowerCase() !== refColors[key].toLowerCase();
        btn.classList.toggle('changed', changed);
        // a11y (#1638 .ow-color-well): a hidden (opacity:0/pointer-events:none) reset is still
        // keyboard-focusable — keep [disabled] in lockstep with .changed so an unchanged, invisible
        // reset is inert AND out of the tab order.
        btn.disabled = !changed;
      }
    });
    document.querySelectorAll('.ow-color-well__reset[data-reset-adv]').forEach(btn => {
      const key = btn.dataset.resetAdv;
      const picker = document.getElementById('adv-' + key);
      const ref = refDefaults[key] || '';
      if (picker && ref) {
        const changed = picker.value.toLowerCase() !== ref.toLowerCase();
        btn.classList.toggle('changed', changed);
        btn.disabled = !changed;   // sync keyboard-reachability with .changed (#1638)
      }
    });
    // The bg-effect-color reset (#1657): its reference is the TEXT color (the reset target, matching
    // the click handler's `currentColors.fg`), so an unchanged effect reset is invisible AND inert.
    document.querySelectorAll('.ow-color-well__reset[data-reset-effect]').forEach(btn => {
      const picker = document.getElementById('theme-bg-effect-color');
      const ref = currentColors.fg || '#9cdef2';
      if (picker) {
        const changed = picker.value.toLowerCase() !== ref.toLowerCase();
        btn.classList.toggle('changed', changed);
        btn.disabled = !changed;
      }
    });
  }

  // Color picker live updates.
  // NOTE: do NOT clone the input. attachColorPicker installed a value-getter
  // override + a mousedown handler on this exact element; cloning would orphan
  // both. Use a one-time bind flag instead.
  const pickerIds = { bg: 'clr-bg', fg: 'clr-fg', panel: 'clr-panel', border: 'clr-border', red: 'clr-red' };
  Object.entries(pickerIds).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.themeBound === '1') return;
    el.dataset.themeBound = '1';
    el.addEventListener('input', () => {
      // Capture the OLD basic palette before we read the new picker values.
      // Used below to decide which advanced pickers carry a real user-set
      // override (value differs from the OLD computed default) vs. ones
      // that are just stale-default and should auto-refresh.
      const _oldColors = {};
      Object.entries(pickerIds).forEach(([k, pid]) => {
        // Picker value HAS already changed (input fired) for the one the
        // user touched. For that one, reading the current value gives the
        // NEW color, which is fine — _oldDefaults uses the rest. We use
        // computeAdvancedDefaults({...new}) once for the new defaults, and
        // the CSS variables for the OLD defaults.
      });
      const _rs = getComputedStyle(document.documentElement);
      _oldColors.bg     = (_rs.getPropertyValue('--bg')    || '').trim();
      _oldColors.fg     = (_rs.getPropertyValue('--fg')    || '').trim();
      _oldColors.panel  = (_rs.getPropertyValue('--panel') || '').trim();
      _oldColors.border = (_rs.getPropertyValue('--border')|| '').trim();
      _oldColors.red    = (_rs.getPropertyValue('--red')   || '').trim();
      const _oldDefaults = computeAdvancedDefaults(_oldColors);

      const colors = {};
      Object.entries(pickerIds).forEach(([k, pid]) => {
        colors[k] = document.getElementById(pid).value;
      });

      // Build the advanced override map: only pickers whose value differs
      // from the OLD default count as user-set. Untouched pickers (still
      // matching the old default) get auto-updated to the NEW default so
      // they keep tracking the basic palette (e.g. Send Btn follows Accent).
      const _newDefaults = computeAdvancedDefaults(colors);
      const _adv = {};
      let _hasAdv = false;
      // Normalize color strings to lowercase 6-char hex so getComputedStyle
      // values (which keep whatever was set — could be #abc, #ABCDEF, or
      // rgb()) compare correctly against color-input pickers (always
      // #rrggbb lowercase). Without this, every advanced picker reads as
      // "user-set" and we'd revert to the v161 bug.
      const _norm = (raw) => {
        let h = String(raw || '').trim().toLowerCase();
        if (!h) return '';
        // rgb(r,g,b) or rgba(r,g,b,a)
        const rgb = h.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (rgb) {
          const hx = n => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0');
          return '#' + hx(rgb[1]) + hx(rgb[2]) + hx(rgb[3]);
        }
        if (h[0] !== '#') h = '#' + h;
        // Expand #rgb → #rrggbb
        if (/^#[0-9a-f]{3}$/.test(h)) {
          return '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
        }
        return h;
      };
      for (const { key } of ADV_KEYS) {
        const pEl = document.getElementById('adv-' + key);
        if (!pEl) continue;
        if (_norm(pEl.value) !== _norm(_oldDefaults[key])) {
          _adv[key] = pEl.value;
          _hasAdv = true;
        } else {
          // Untouched — slide to the new default so it tracks the new palette.
          pEl.value = _newDefaults[key];
        }
      }
      if (_hasAdv) colors.advanced = _adv;
      applyColors(colors);
      // Auto-save: if the active theme is one of the user's custom themes,
      // route changes back into it so renaming/reloading keeps the edits.
      // Otherwise fall back to the transient 'custom' slot (existing behavior).
      const _activeSaved = getSaved();
      const _activeName = _activeSaved && _activeSaved.name;
      const _customMap = _loadCustomThemes();
      if (_activeName && _customMap && _customMap[_activeName]) {
        // Preserve advanced/opts keys that aren't part of basic colors.
        saveCustomTheme(_activeName, colors, {
          font: _activeSaved.font, density: _activeSaved.density,
          bgPattern: _activeSaved.bgPattern, bgEffectColor: _activeSaved.bgEffectColor,
          bgEffectIntensity: _activeSaved.bgEffectIntensity,
          bgEffectSize: _activeSaved.bgEffectSize,
          glassTier: _activeSaved.glassTier, bgImage: _activeSaved.bgImage,
        });
        _saveFull(_activeName, colors);
      } else {
        _saveFull('custom', colors);
      }
      _flashAutosaved();
      grid.querySelectorAll('.ow-swatch').forEach(s => s.setAttribute('aria-selected', 'false'));
      syncResetButtons();
    });
  });

  // Save custom theme — inline input
  const saveNameInputOld = document.getElementById('theme-save-name');
  const saveGoBtnOld = document.getElementById('theme-save-go');
  const saveError = document.getElementById('theme-save-error');
  if (saveGoBtnOld && saveNameInputOld) {
    const newGoBtn = saveGoBtnOld.cloneNode(true);
    saveGoBtnOld.parentNode.replaceChild(newGoBtn, saveGoBtnOld);
    const newNameInput = saveNameInputOld.cloneNode(true);
    saveNameInputOld.parentNode.replaceChild(newNameInput, saveNameInputOld);
    const doSave = () => {
      saveError.style.display = 'none';
      const name = newNameInput.value.trim();
      if (!name) { saveError.textContent = 'Enter a name.'; saveError.style.display = 'block'; return; }
      const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (!slug) { saveError.textContent = 'Invalid name.'; saveError.style.display = 'block'; return; }
      if (THEMES[slug]) { saveError.textContent = 'Cannot overwrite a built-in theme.'; saveError.style.display = 'block'; return; }
      const colors = {};
      const pickerIds2 = { bg: 'clr-bg', fg: 'clr-fg', panel: 'clr-panel', border: 'clr-border', red: 'clr-red' };
      Object.entries(pickerIds2).forEach(([k, pid]) => { colors[k] = document.getElementById(pid).value; });
      const adv = {};
      const defaults = computeAdvancedDefaults(colors);
      let hasAdv = false;
      for (const { key } of ADV_KEYS) {
        const el = document.getElementById('adv-' + key);
        if (el && el.value !== defaults[key]) { adv[key] = el.value; hasAdv = true; }
      }
      if (hasAdv) colors.advanced = adv;
      const opts = _getOpts();
      const result = saveCustomTheme(slug, colors, opts);
      if (result === 'limit') { saveError.textContent = 'Max ' + MAX_CUSTOM_THEMES + ' custom themes. Delete one first.'; saveError.style.display = 'block'; return; }
      save(slug, colors, opts);
      newNameInput.value = '';
      _flashAutosaved('Theme saved');
      uiModule.showToast?.('Theme saved');
      const prevHtml = newGoBtn.innerHTML;
      newGoBtn.disabled = true;
      newGoBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>Saved</span>';
      setTimeout(() => {
        newGoBtn.disabled = false;
        newGoBtn.innerHTML = prevHtml;
      }, 1200);
    };
    newGoBtn.addEventListener('click', doSave);
    newNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
  }

  // Reset button
  const resetBtn = document.getElementById('theme-reset-btn');
  if (resetBtn) {
    const newReset = resetBtn.cloneNode(true);
    resetBtn.parentNode.replaceChild(newReset, resetBtn);
    newReset.addEventListener('click', () => {
      Storage.remove(LS_KEY);
      const colors = THEMES[DEFAULT_THEME];
      applyColors(colors);
      syncPickers(colors);
      applyFontDensity(DEFAULT_FONT, DEFAULT_DENSITY);
      // Reset to the DEFAULT theme's own glass tier + signature pattern, image off.
      const _defTier = defaultGlassTierFor(DEFAULT_THEME);
      const _defPattern = THEME_DEFAULT_PATTERN[DEFAULT_THEME] || 'none';
      applyGlassTier(_defTier);
      applyGlassTint('clear');   // #739 — reset returns to the Clear default
      applyBgImage('');
      applyBgPattern(_defPattern);
      // Drop any active Google font (synthetic option + the dynamic <link>).
      const _gl = document.getElementById(GOOGLE_FONT_LINK_ID);
      if (_gl) _gl.remove();
      _syncGoogleFontInput(DEFAULT_FONT);
      const fs = document.getElementById('theme-font-select');
      const ds = document.getElementById('theme-density-select');
      const ps = document.getElementById('theme-bg-pattern-select');
      if (fs) { fs.querySelectorAll('option[data-google-font]').forEach(o => o.remove()); fs.value = DEFAULT_FONT; }
      if (ds) ds.value = DEFAULT_DENSITY;
      if (ps) ps.value = _defPattern;
      _syncGlassTierControl(_defTier);
      _syncGlassTintControl('clear');   // #739
      _syncBgSourceControls('');
      grid.querySelectorAll('.ow-swatch').forEach(s => s.setAttribute('aria-selected', 'false'));
      const defSwatch = grid.querySelector('[data-theme="' + DEFAULT_THEME + '"]');
      if (defSwatch) defSwatch.setAttribute('aria-selected', 'true');
    });
  }

  // Advanced section toggle
  const advToggle = document.getElementById('theme-adv-toggle');
  const advSection = document.getElementById('themeAdvanced');
  if (advToggle && advSection) {
    const newToggle = advToggle.cloneNode(true);
    advToggle.parentNode.replaceChild(newToggle, advToggle);
    newToggle.addEventListener('click', () => {
      advSection.classList.toggle('hidden');
      newToggle.classList.toggle('open');
      // Re-scan rows so advanced color inputs get the hover-highlight too.
      const root = document.getElementById('theme-tab-customize');
      if (root) root.dataset.zoneBound = '';
      initThemeZoneHighlight();
    });
  }
  // Wire hover-highlights on color rows so the user sees which UI zone
  // each input edits.
  initThemeZoneHighlight();

  // Advanced color picker live updates
  function readCurrentColors() {
    const pickerIds2 = { bg: 'clr-bg', fg: 'clr-fg', panel: 'clr-panel', border: 'clr-border', red: 'clr-red' };
    const c = {};
    Object.entries(pickerIds2).forEach(([k, pid]) => { c[k] = document.getElementById(pid).value; });
    return c;
  }

  function readAdvanced() {
    const adv = {};
    const base = readCurrentColors();
    const defaults = computeAdvancedDefaults(base);
    let hasOverrides = false;
    for (const { key } of ADV_KEYS) {
      const el = document.getElementById('adv-' + key);
      if (!el) continue;
      const v = (el.value || '').toLowerCase();
      // Skip empty or never-populated inputs so we don't accidentally store
      // them as overrides (and then write '#000000' to the CSS var).
      if (!v || !/^#[0-9a-f]{6}$/.test(v)) continue;
      if (v !== (defaults[key] || '').toLowerCase()) {
        adv[key] = el.value;
        hasOverrides = true;
      }
    }
    return hasOverrides ? adv : undefined;
  }

  for (const { key } of ADV_KEYS) {
    const el = document.getElementById('adv-' + key);
    if (!el || el.dataset.themeBound === '1') continue;
    el.dataset.themeBound = '1';
    el.addEventListener('input', () => {
      const base = readCurrentColors();
      base.advanced = readAdvanced();
      applyColors(base);
      // Same auto-save routing as the basic color inputs above — write
      // to the active custom theme if there is one, else fall back to
      // the transient 'custom' slot.
      const _activeSaved = getSaved();
      const _activeName = _activeSaved && _activeSaved.name;
      const _customMap = _loadCustomThemes();
      if (_activeName && _customMap && _customMap[_activeName]) {
        saveCustomTheme(_activeName, base, {
          font: _activeSaved.font, density: _activeSaved.density,
          bgPattern: _activeSaved.bgPattern, bgEffectColor: _activeSaved.bgEffectColor,
          bgEffectIntensity: _activeSaved.bgEffectIntensity,
          bgEffectSize: _activeSaved.bgEffectSize,
        });
        _saveFull(_activeName, base);
      } else {
        _saveFull('custom', base);
      }
      _flashAutosaved();
      grid.querySelectorAll('.ow-swatch').forEach(s => s.setAttribute('aria-selected', 'false'));
      syncResetButtons();
    });
  }

  // Clear advanced overrides button
  const advClearBtn = document.getElementById('theme-adv-clear');
  if (advClearBtn) {
    const newClear = advClearBtn.cloneNode(true);
    advClearBtn.parentNode.replaceChild(newClear, advClearBtn);
    newClear.addEventListener('click', () => {
      const base = readCurrentColors();
      delete base.advanced;
      applyColors(base);
      _saveFull('custom', base);
      syncAdvancedPickers(base);
      syncResetButtons();
    });
  }

  // Per-picker reset buttons (base colors)
  document.querySelectorAll('.ow-color-well__reset[data-reset]').forEach(btn => {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
      const key = newBtn.dataset.reset;
      const picker = document.getElementById(pickerIds[key]);
      if (picker && refColors[key]) {
        picker.value = refColors[key];
        picker.dispatchEvent(new Event('input'));
      }
    });
  });

  // Effect color reset button
  document.querySelectorAll('.ow-color-well__reset[data-reset-effect]').forEach(btn => {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
      const ec = document.getElementById('theme-bg-effect-color');
      if (ec) {
        const fg = currentColors.fg || '#9cdef2';
        ec.value = fg;
        applyBgEffectColor('');
        const s = getSaved(); if (s) _saveFull(s.name, s.colors);
        syncResetButtons();   // #1657: the effect reset is now itself synced (.changed + [disabled])
      }
    });
  });

  // Per-picker reset buttons (advanced colors)
  document.querySelectorAll('.ow-color-well__reset[data-reset-adv]').forEach(btn => {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
      const key = newBtn.dataset.resetAdv;
      const picker = document.getElementById('adv-' + key);
      if (picker) {
        picker.value = refDefaults[key] || computeAdvancedDefaults(refColors)[key];
        picker.dispatchEvent(new Event('input'));
      }
    });
  });

  // Initial sync of reset button visibility
  syncResetButtons();

  // Font, density, background pattern controls
  const _initFont = (saved && saved.font) || DEFAULT_FONT;
  const _initDensity = (saved && saved.density) || DEFAULT_DENSITY;
  // The active pattern resolves for the ACTIVE theme name (saved.name OR the DEFAULT_THEME for a
  // brand-new / factory-reset / no-stored-theme session) — exactly like the colors do (L975). The
  // old `(saved && THEME_DEFAULT_PATTERN[saved.name])` form dropped to 'none' whenever `saved` was
  // null, so a fresh player never got the default theme's signature particle background
  // (telescreen → perlin-flow) until they explicitly picked a theme. activeName is from L855.
  const _initPattern = (saved && saved.bgPattern) || THEME_DEFAULT_PATTERN[activeName] || 'none';
  const _initEffectColor = (saved && saved.bgEffectColor) || (saved && THEME_DEFAULT_EFFECT_COLOR[saved.name]) || '';
  const _initEffectIntensity = (saved && saved.bgEffectIntensity !== undefined)
    ? saved.bgEffectIntensity
    : (saved && THEME_DEFAULT_INTENSITY[saved.name] !== undefined ? THEME_DEFAULT_INTENSITY[saved.name] : 1);
  const _initEffectSize = (saved && saved.bgEffectSize !== undefined) ? saved.bgEffectSize : 1;
  const _initTier = resolveGlassTier(saved, saved ? saved.name : DEFAULT_THEME);
  const _initTint = resolveGlassTint(saved);   // #739 — Clear by default
  const _initBgImage = (saved && saved.bgImage) ? saved.bgImage : '';
  applyFontDensity(_initFont, _initDensity);
  applyBgEffectColor(_initEffectColor);
  applyBgEffectIntensity(_initEffectIntensity);
  applyBgEffectSize(_initEffectSize);
  applyGlassTier(_initTier);
  applyGlassTint(_initTint);
  applyBgImage(_initBgImage);
  // A saved wallpaper supersedes the animated pattern.
  applyBgPattern(_initBgImage ? 'none' : _initPattern);

  const fontSelect = document.getElementById('theme-font-select');
  const densitySelect = document.getElementById('theme-density-select');
  const patternSelect = document.getElementById('theme-bg-pattern-select');

  if (fontSelect) {
    const nf = fontSelect.cloneNode(true); fontSelect.parentNode.replaceChild(nf, fontSelect);
    // If the saved font is a Google font (gf:Family), it has no built-in <option>.
    // Add a synthetic option so the select round-trips + shows the active family.
    _reflectGoogleFontOption(nf, _initFont);
    nf.value = _initFont;
    nf.addEventListener('change', () => {
      applyFontDensity(nf.value, document.getElementById('theme-density-select').value);
      const s = getSaved(); if (s) _saveFull(s.name, s.colors);
      // Picking a built-in / custom font from the select drops the Google font;
      // keep the Google input mirror in sync.
      _syncGoogleFontInput(nf.value);
    });
    // Fetch custom fonts from local folder and populate dropdown
    fetch('/api/fonts/custom', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(data => {
        _customFonts = data.fonts || {};
        const families = Object.keys(_customFonts);
        nf.querySelectorAll('option[data-custom-font]').forEach(o => o.remove());
        for (const fam of families) {
          const opt = document.createElement('option');
          opt.value = fam;
          opt.textContent = fam;
          opt.dataset.customFont = '1';
          nf.appendChild(opt);
        }
        // Restore saved value after options are populated
        _reflectGoogleFontOption(nf, _initFont);
        nf.value = _initFont;
      })
      .catch(e => console.warn('Custom fonts fetch failed:', e));
  }

  // ── Google Fonts picker (searchable + free-text) ──
  // Apply a Google family: tag it gf:, apply live, reflect it in the <select>,
  // and persist through the existing save path so it survives reload (per-user).
  function _applyGoogleFont(family) {
    const fam = (family || '').trim();
    if (!fam) return;
    const value = GOOGLE_FONT_PREFIX + fam;
    const ds = document.getElementById('theme-density-select');
    applyFontDensity(value, ds ? ds.value : DEFAULT_DENSITY);
    const sel = document.getElementById('theme-font-select');
    if (sel) { _reflectGoogleFontOption(sel, value); sel.value = value; }
    const s = getSaved(); if (s) _saveFull(s.name, s.colors);
    _syncGoogleFontInput(value);
  }
  // Clear back to the default built-in font (offline-safe).
  function _clearGoogleFont() {
    const ds = document.getElementById('theme-density-select');
    applyFontDensity(DEFAULT_FONT, ds ? ds.value : DEFAULT_DENSITY);
    const sel = document.getElementById('theme-font-select');
    if (sel) {
      // Drop any synthetic gf option, then select the default built-in.
      sel.querySelectorAll('option[data-google-font]').forEach(o => o.remove());
      sel.value = DEFAULT_FONT;
    }
    const link = document.getElementById(GOOGLE_FONT_LINK_ID);
    if (link) link.remove();
    const s = getSaved(); if (s) _saveFull(s.name, s.colors);
    _syncGoogleFontInput(DEFAULT_FONT);
  }
  _wireGoogleFontPicker(_initFont, _applyGoogleFont, _clearGoogleFont);
  if (densitySelect) {
    const nd = densitySelect.cloneNode(true); densitySelect.parentNode.replaceChild(nd, densitySelect);
    nd.value = _initDensity;
    nd.addEventListener('change', () => {
      applyFontDensity(document.getElementById('theme-font-select').value, nd.value);
      const s = getSaved(); if (s) _saveFull(s.name, s.colors);
    });
  }
  if (patternSelect) {
    const np = patternSelect.cloneNode(true); patternSelect.parentNode.replaceChild(np, patternSelect);
    np.value = _initPattern;
    np.addEventListener('change', () => {
      // Choosing an animation supersedes any wallpaper image — clear #__wp and
      // flip the bg-source control back to 'animation'.
      applyBgImage('');
      _syncBgSourceControls('');
      const bs = document.getElementById('theme-bg-source');
      if (bs) bs.value = 'animation';
      applyBgPattern(np.value);
      const s = getSaved(); if (s) _saveFull(s.name, s.colors);
    });
  }

  const effectColorPicker = document.getElementById('theme-bg-effect-color');
  if (effectColorPicker) {
    effectColorPicker.value = _initEffectColor || currentColors.fg || '#9cdef2';
    effectColorPicker.addEventListener('input', () => {
      applyBgEffectColor(effectColorPicker.value);
      const s = getSaved(); if (s) _saveFull(s.name, s.colors);
      syncResetButtons();   // #1657: reflect the effect reset's .changed / [disabled] on every edit
    });
    syncResetButtons();   // #1657: correct the effect reset's initial state (value set just above)
  }

  const intensitySlider = document.getElementById('theme-bg-intensity');
  if (intensitySlider) {
    intensitySlider.value = String(Math.round(_initEffectIntensity * 100));
    intensitySlider.addEventListener('input', () => {
      applyBgEffectIntensity(parseFloat(intensitySlider.value) / 100);
      const s = getSaved(); if (s) _saveFull(s.name, s.colors);
    });
  }

  const sizeSlider = document.getElementById('theme-bg-size');
  if (sizeSlider) {
    sizeSlider.value = String(Math.round(_initEffectSize * 100));
    sizeSlider.addEventListener('input', () => {
      applyBgEffectSize(parseFloat(sizeSlider.value) / 100);
      const s = getSaved(); if (s) _saveFull(s.name, s.colors);
    });
  }

  // ── Glass tier — TWO mirrored controls, BOTH the COLLAPSED 2-way ladder (full |
  // normal): id=theme-glass-tier (Customize -> Font & Layout) and the #1316 picker-level
  // quick control id=theme-glass-tier-quick (Browse tab), each labeled Glass / Flat.
  // COLLAPSED tier (owner ruling): 'frosted' is no longer a user-selectable segment — it
  // survives only as the applyGlassTier auto-downgrade target — so a 'frosted' value
  // handed to the sync FOLDS to the Glass (full) segment (never leaves the control blank).
  // The two representable, mutually-exclusive states are Glass ('full') and Flat
  // ('normal'). Each container holds one [data-tier] button per value; the active one
  // carries .active + aria-pressed, and the chosen value is mirrored to the container's
  // dataset.value so _getOpts can read it (it reads #theme-glass-tier specifically, which
  // this function always keeps in lockstep with the quick control). (Function
  // declarations below are hoisted, so the swatch handler can call these helpers.)
  const GLASS_TIER_CONTROL_IDS = ['theme-glass-tier', 'theme-glass-tier-quick'];
  function _syncGlassTierControl(tier) {
    // Flat stays Flat; everything else (Glass, a stray/legacy 'frosted', or an
    // unrecognized value) shows the Glass segment — frosted is not a user-facing tier.
    const t = (tier === 'normal') ? 'normal' : 'full';
    for (const id of GLASS_TIER_CONTROL_IDS) {
      const ctrl = document.getElementById(id);
      if (!ctrl) continue;
      ctrl.dataset.value = t;
      ctrl.querySelectorAll('[data-tier]').forEach((b) => {
        const on = b.dataset.tier === t;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
  }
  // #739 — mirror the glass TINT ('clear'|'tinted') onto the 2-way control: the
  // active button gets .active + aria-pressed, and the value rides dataset.value
  // so _getOpts can read it. Anything but 'tinted' resolves to Clear (the default).
  function _syncGlassTintControl(tint) {
    const ctrl = document.getElementById('theme-glass-tint');
    if (!ctrl) return;
    const t = (tint === 'tinted') ? 'tinted' : 'clear';
    ctrl.dataset.value = t;
    ctrl.querySelectorAll('[data-tint]').forEach((b) => {
      const on = b.dataset.tint === t;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  // Reflect the active wallpaper into the bg-source select + URL input. An image
  // ⇒ source='image' and the URL field shows it (unless it's a data: upload);
  // none ⇒ source='animation' and the field clears. The chosen image string is
  // stashed on the source control's dataset so _getOpts can persist it.
  function _syncBgSourceControls(img) {
    const bs = document.getElementById('theme-bg-source');
    const urlInput = document.getElementById('theme-bg-image-url');
    if (bs) {
      bs.dataset.image = img || '';
      bs.value = img ? 'image' : 'animation';
    }
    if (urlInput) urlInput.value = (img && !/^data:/i.test(img)) ? img : '';
    _syncBgSourceVisibility(img ? 'image' : 'animation');
  }
  // Show the pattern controls under 'animation' and the URL/file controls under
  // 'image' (style.css owns the look; this just toggles display).
  function _syncBgSourceVisibility(source) {
    const animWrap = document.getElementById('theme-bg-anim-group');
    const imgWrap = document.getElementById('theme-bg-image-group');
    const isImg = source === 'image';
    if (animWrap) animWrap.style.display = isImg ? 'none' : '';
    if (imgWrap) imgWrap.style.display = isImg ? '' : 'none';
  }

  // #1316: bind BOTH the Customize 3-way control and the Browse-tab quick 2-way control —
  // either one applies + persists identically (applyGlassTier + _saveFull), and
  // _syncGlassTierControl keeps the other in lockstep so they never disagree.
  for (const _gtId of GLASS_TIER_CONTROL_IDS) {
    const ctrl = document.getElementById(_gtId);
    if (!ctrl || ctrl.dataset.bound === '1') continue;
    ctrl.dataset.bound = '1';
    ctrl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tier]');
      if (!btn) return;
      const tier = btn.dataset.tier;
      applyGlassTier(tier);
      _syncGlassTierControl(tier);
      const s = getSaved(); if (s) _saveFull(s.name, s.colors);
    });
  }
  _syncGlassTierControl(_initTier);

  // #739 — glass TINT control (Clear ↔ Tinted). Mirrors the tier control: apply
  // the body-state class, sync the control, then persist through _getOpts (which
  // reads dataset.value). Tint is a GLOBAL taste control — switching themes never
  // resets it (the swatch handler leaves body.theme-tinted untouched).
  const glassTintCtrl = document.getElementById('theme-glass-tint');
  if (glassTintCtrl && glassTintCtrl.dataset.bound !== '1') {
    glassTintCtrl.dataset.bound = '1';
    glassTintCtrl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tint]');
      if (!btn) return;
      const tint = btn.dataset.tint;
      applyGlassTint(tint);
      _syncGlassTintControl(tint);
      const s = getSaved(); if (s) _saveFull(s.name, s.colors);
    });
  }
  _syncGlassTintControl(_initTint);

  // ── Background source (animation vs image) + the URL / file inputs.
  const bgSourceSelect = document.getElementById('theme-bg-source');
  if (bgSourceSelect && bgSourceSelect.dataset.bound !== '1') {
    bgSourceSelect.dataset.bound = '1';
    bgSourceSelect.addEventListener('change', () => {
      const src = bgSourceSelect.value;
      _syncBgSourceVisibility(src);
      if (src === 'animation') {
        // Drop the wallpaper, restore the current pattern.
        applyBgImage('');
        bgSourceSelect.dataset.image = '';
        const ps = document.getElementById('theme-bg-pattern-select');
        applyBgPattern(ps ? ps.value : 'none');
      } else {
        // Switching to image: if one is already stashed, paint it; pattern off.
        const img = bgSourceSelect.dataset.image || '';
        if (img) { applyBgImage(img); applyBgPattern('none'); }
      }
      const s = getSaved(); if (s) _saveFull(s.name, s.colors);
    });
  }
  const bgImageUrl = document.getElementById('theme-bg-image-url');
  if (bgImageUrl && bgImageUrl.dataset.bound !== '1') {
    bgImageUrl.dataset.bound = '1';
    const applyUrl = () => {
      const url = bgImageUrl.value.trim();
      if (!url) return;
      applyBgImage(url);
      applyBgPattern('none');
      if (bgSourceSelect) { bgSourceSelect.dataset.image = url; bgSourceSelect.value = 'image'; }
      _syncBgSourceVisibility('image');
      const s = getSaved(); if (s) _saveFull(s.name, s.colors);
    };
    bgImageUrl.addEventListener('change', applyUrl);
    bgImageUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyUrl(); } });
  }
  const bgImageFile = document.getElementById('theme-bg-image-file');
  if (bgImageFile && bgImageFile.dataset.bound !== '1') {
    bgImageFile.dataset.bound = '1';
    bgImageFile.addEventListener('change', async () => {
      const file = bgImageFile.files && bgImageFile.files[0];
      if (!file) return;
      const dataUrl = await _downscaleImageFile(file);
      bgImageFile.value = ''; // allow re-picking the same file
      if (!dataUrl) {
        uiModule.showToast?.('Image too large — pick one under ~1.5MB.');
        return;
      }
      applyBgImage(dataUrl);
      applyBgPattern('none');
      if (bgSourceSelect) { bgSourceSelect.dataset.image = dataUrl; bgSourceSelect.value = 'image'; }
      _syncBgSourceVisibility('image');
      const s = getSaved(); if (s) _saveFull(s.name, s.colors);
    });
  }
  // Reflect the saved wallpaper into the bg-source controls on init.
  _syncBgSourceControls(_initBgImage);

  // --- Color Harmony Generator (inside Advanced section) ---
  const harmonyGenBtnEl = document.getElementById('harmony-generate-btn');
  const harmonyAccentEl = document.getElementById('harmony-accent');
  // Make sure the in-house color picker really attached to this one. The
  // global initColorPickers() call earlier in initThemeUI should have grabbed
  // it, but in older sessions / partial loads it sometimes wasn't wrapped —
  // call attachColorPicker idempotently so the popover, suggestions, recents
  // and hex syncing all match every other color row.
  if (harmonyAccentEl) {
    try { attachColorPicker(harmonyAccentEl); } catch (_) {}
  }
  // Keep the hex display chip in sync with whatever the picker reports.
  const _harmonyHex = document.getElementById('harmony-accent-hex');
  if (harmonyAccentEl && _harmonyHex) {
    _harmonyHex.textContent = harmonyAccentEl.value || '#e06c75';
    harmonyAccentEl.addEventListener('input', () => {
      _harmonyHex.textContent = harmonyAccentEl.value;
    });
  }
  if (harmonyGenBtnEl) {
    const newGen = harmonyGenBtnEl.cloneNode(true);
    harmonyGenBtnEl.parentNode.replaceChild(newGen, harmonyGenBtnEl);
    newGen.addEventListener('click', () => {
      const accent = document.getElementById('harmony-accent').value;
      const type = document.getElementById('harmony-type').value;
      const mode = document.getElementById('harmony-mode').value;
      const colors = generateHarmonyColors(accent, type, mode);
      applyColors(colors);
      syncPickers(colors);
      _saveFull('custom', colors);
      grid.querySelectorAll('.ow-swatch').forEach(s => s.setAttribute('aria-selected', 'false'));
      const prev = document.getElementById('harmony-preview');
      if (prev) prev.innerHTML = [colors.bg, colors.panel, colors.fg, colors.border, colors.red].map(c => `<span style="background:${c}"></span>`).join('');
    });
  }
  if (harmonyAccentEl) {
    const newAcc = harmonyAccentEl.cloneNode(true);
    harmonyAccentEl.parentNode.replaceChild(newAcc, harmonyAccentEl);
    // Re-attach the in-house color picker to the fresh clone. cloneNode
    // copies the data-cp-attached="1" flag but NOT the listeners, so we
    // have to clear the flag first or attachColorPicker bails as a no-op.
    delete newAcc.dataset.cpAttached;
    newAcc.type = 'color'; // clone may have been type=text from prior attach
    try { attachColorPicker(newAcc); } catch (_) {}
    newAcc.addEventListener('input', () => {
      const type = document.getElementById('harmony-type').value;
      const mode = document.getElementById('harmony-mode').value;
      const colors = generateHarmonyColors(newAcc.value, type, mode);
      const prev = document.getElementById('harmony-preview');
      if (prev) prev.innerHTML = [colors.bg, colors.panel, colors.fg, colors.border, colors.red].map(c => `<span style="background:${c}"></span>`).join('');
      // Sync the hex chip beside the picker.
      const hex = document.getElementById('harmony-accent-hex');
      if (hex) hex.textContent = newAcc.value;
    });
  }

  // --- Import / Export ---
  const exportBtnEl = document.getElementById('theme-export-btn');
  const importBtnEl = document.getElementById('theme-import-btn');
  const importAreaEl = document.getElementById('theme-import-area');
  const importActionsEl = document.getElementById('theme-import-actions');
  const importGoEl = document.getElementById('theme-import-go');
  const importCancelEl = document.getElementById('theme-import-cancel');

  if (exportBtnEl) {
    const newExp = exportBtnEl.cloneNode(true);
    exportBtnEl.parentNode.replaceChild(newExp, exportBtnEl);
    newExp.addEventListener('click', () => {
      const colors = readCurrentColors();
      const adv = readAdvanced();
      if (adv) colors.advanced = adv;
      const cur = getSaved();
      const obj = { name: cur ? cur.name : 'custom', colors };
      if (cur && cur.font) obj.font = cur.font;
      if (cur && cur.density) obj.density = cur.density;
      if (cur && cur.bgPattern) obj.bgPattern = cur.bgPattern;
      if (cur && cur.bgEffectColor) obj.bgEffectColor = cur.bgEffectColor;
      const json = JSON.stringify(obj, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'orwell_' + (obj.name || 'theme') + '.json';
      a.click();
      URL.revokeObjectURL(url);
      newExp.innerHTML = '&#x2713; Downloaded!';
      setTimeout(() => { newExp.innerHTML = '&#x2913; Export'; }, 1500);
    });
  }

  if (importBtnEl && importAreaEl && importActionsEl) {
    const newImp = importBtnEl.cloneNode(true);
    importBtnEl.parentNode.replaceChild(newImp, importBtnEl);
    newImp.addEventListener('click', () => {
      importAreaEl.classList.toggle('hidden');
      importActionsEl.classList.toggle('hidden');
      importAreaEl.value = '';
      saveError.style.display = 'none';
    });
  }

  if (importGoEl && importAreaEl) {
    const newGo = importGoEl.cloneNode(true);
    importGoEl.parentNode.replaceChild(newGo, importGoEl);
    newGo.addEventListener('click', () => {
      saveError.style.display = 'none';
      let parsed;
      try { parsed = JSON.parse(importAreaEl.value.trim()); }
      catch { saveError.textContent = 'Invalid JSON.'; saveError.style.display = 'block'; return; }
      let colors = parsed.colors || parsed;
      const name = parsed.name || 'imported';
      const required = ['bg', 'fg', 'panel', 'border', 'red'];
      const missing = required.filter(k => !colors[k]);
      if (missing.length) { saveError.textContent = 'Missing: ' + missing.join(', '); saveError.style.display = 'block'; return; }
      const hexRe = /^#[0-9a-fA-F]{6}$/;
      for (const k of required) {
        if (!hexRe.test(colors[k])) { saveError.textContent = 'Bad hex for ' + k; saveError.style.display = 'block'; return; }
      }
      const colorData = { bg: colors.bg, fg: colors.fg, panel: colors.panel, border: colors.border, red: colors.red };
      if (colors.advanced && typeof colors.advanced === 'object') colorData.advanced = colors.advanced;
      const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'imported';
      const opts = {};
      if (parsed.font) opts.font = parsed.font;
      if (parsed.density) opts.density = parsed.density;
      if (parsed.bgPattern) opts.bgPattern = parsed.bgPattern;
      if (parsed.bgEffectColor) opts.bgEffectColor = parsed.bgEffectColor;
      const result = saveCustomTheme(slug, colorData, opts);
      if (result === 'limit') { saveError.textContent = 'Max ' + MAX_CUSTOM_THEMES + ' custom themes. Delete one first.'; saveError.style.display = 'block'; return; }
      save(slug, colorData, opts);
      applyColors(colorData);
      applyFontDensity(opts.font || DEFAULT_FONT, opts.density || DEFAULT_DENSITY);
      applyBgEffectColor(opts.bgEffectColor || '');
      applyBgPattern(opts.bgPattern || 'none');
      importAreaEl.classList.add('hidden');
      importActionsEl.classList.add('hidden');
    });
  }

  if (importCancelEl && importAreaEl && importActionsEl) {
    const newCancel = importCancelEl.cloneNode(true);
    importCancelEl.parentNode.replaceChild(newCancel, importCancelEl);
    newCancel.addEventListener('click', () => {
      importAreaEl.classList.add('hidden');
      importActionsEl.classList.add('hidden');
      importAreaEl.value = '';
      saveError.style.display = 'none';
    });
  }

  // Theme popup now uses standard modal frame (not draggable)
}

// ── Zone highlighter ───────────────────────────────────────────────────
// Maps each color input id to a selector for the part of the UI it affects.
// When the user hovers the color row, we overlay a translucent box on the
// matching elements so it's obvious what's being edited.
const _THEME_ZONE_MAP = {
  'clr-bg':            'body',
  'clr-fg':            '.msg .body, .chat-input-bar',
  'clr-panel':         '.sidebar',
  'clr-border':        '.chat-input-bar, .sidebar, .msg .body',
  'clr-red':           '.send-btn, .icon-rail-btn.active',
  'theme-bg-effect-color': 'body',
  'adv-userBubbleBg':  '.msg.msg-user .body',
  'adv-aiBubbleBg':    '.msg.msg-ai .body',
  'adv-bubbleBorder':  '.msg .body',
  'adv-sidebarBg':     '.sidebar',
  'adv-sectionAccent': '.sidebar h4',
  'adv-brandColor':    '#sidebar-brand-btn',
  'adv-inputBg':       '#message',
  'adv-inputBorder':   '.chat-input-bar',
  'adv-sendBtnBg':     '.send-btn',
  'adv-sendBtnHover':  '.send-btn',
  'adv-codeBg':        'pre, code',
  'adv-codeFg':        'pre code, p code',
  'adv-toggleBg':      '.mode-toggle, .ow-switch',
  'adv-toggleActive':  '.mode-toggle-btn.active, .ow-switch input:checked + .ow-switch-track',
  'adv-accentPrimary': '.send-btn, .icon-rail-btn.active',
  'adv-accentError':   '.toast.error',
};

function _showThemeZoneHighlight(selector) {
  _clearThemeZoneHighlight();
  if (!selector) return;
  let els;
  try { els = document.querySelectorAll(selector); }
  catch { return; }
  els.forEach(el => {
    // Skip elements inside the theme modal — highlighting itself is noise.
    if (el.closest && el.closest('#theme-modal')) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const overlay = document.createElement('div');
    overlay.className = 'theme-zone-highlight';
    overlay.style.top    = (r.top - 2) + 'px';
    overlay.style.left   = (r.left - 2) + 'px';
    overlay.style.width  = (r.width + 4) + 'px';
    overlay.style.height = (r.height + 4) + 'px';
    document.body.appendChild(overlay);
  });
}

function _clearThemeZoneHighlight() {
  document.querySelectorAll('.theme-zone-highlight').forEach(el => el.remove());
}

let _flashTimer = null;
function _flashAutosaved(label = 'Auto-saved') {
  let pill = document.getElementById('theme-autosaved-pill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'theme-autosaved-pill';
    pill.className = 'theme-autosaved-pill';
    pill.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span></span>';
    // Anchor inside the customize tab so it floats with the form.
    const customizeTab = document.getElementById('theme-tab-customize');
    (customizeTab || document.body).appendChild(pill);
  }
  const labelEl = pill.querySelector('span');
  if (labelEl) labelEl.textContent = label;
  pill.classList.add('visible');
  clearTimeout(_flashTimer);
  _flashTimer = setTimeout(() => pill.classList.remove('visible'), 1100);
}

// Wire hover-to-highlight on every color row inside the theme modal. Call
// once after the modal markup is in the DOM. Idempotent.
export function initThemeZoneHighlight() {
  const root = document.getElementById('theme-tab-customize');
  if (!root || root.dataset.zoneBound === '1') return;
  root.dataset.zoneBound = '1';
  root.querySelectorAll('.ow-color-well').forEach(row => {
    const input = row.querySelector('input[type="color"]');
    if (!input) return;
    const sel = _THEME_ZONE_MAP[input.id];
    if (!sel) return;
    row.addEventListener('mouseenter', () => _showThemeZoneHighlight(sel));
    row.addEventListener('mouseleave', _clearThemeZoneHighlight);
    // Also trigger when the picker actually opens (input focus)
    input.addEventListener('focus', () => _showThemeZoneHighlight(sel));
    input.addEventListener('blur', _clearThemeZoneHighlight);
  });
  // Clear highlight when the modal closes.
  const modal = document.getElementById('theme-modal');
  if (modal) {
    new MutationObserver(() => {
      if (modal.classList.contains('hidden')) _clearThemeZoneHighlight();
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  }
}

// The generic `makeDraggable(el, handle)` helper now lives in windowDrag.js
// (re-exported below via themeModule for its remaining legacy consumers, e.g.
// sessions.js). The game-build Theme window itself no longer hand-wires drag —
// it composes the OrwellWindow kit's native drag (F-3 / #660 residual: the
// theme window's drag is the kit's, and theme.js no longer calls the drag
// engine directly, so it drops out of the F-3 GRANDFATHERED_DRAG set).

// ── The Theme window is an OrwellWindow kit window (mirrors settings.js) ───────
// It composes the unified kit: macOS traffic-light controls, the glass chrome,
// the sans UI font, centered modal placement, scrim + inert background +
// focus-trap (modal:true), Escape via the ui.js arbiter, and the F5 cross-
// session geometry. The content node is the existing #theme-popup card, hosted
// (hidden) in #theme-host until the kit's first open() moves it into .ow-body —
// exactly the settings pattern (every el('theme-…') wiring still finds it in the
// display:none host before then). The kit window keeps the id "theme-modal" so
// every existing consumer (slashCommands tour, keyboard shortcuts, modalManager,
// the Escape handler) keeps finding it: getElementById('theme-modal') resolves
// to the .ow-window WHILE OPEN (no `hidden` class ⇒ "open"), and null when closed
// (the consumers already treat null/hidden as "closed / needs opening").
let _themeWin = null;

// The element the "Peek" opacity fade targets: the kit frame (.ow-window) once
// built, else the static #theme-popup card (pre-kit / fallback).
function _themePeekTarget() {
  return (_themeWin && _themeWin.el) || document.getElementById('theme-popup');
}

function initThemeKitWindow() {
  if (_themeWin || !window.OrwellWindowKit) return _themeWin;
  const content = document.getElementById('theme-popup');
  if (!content) return null;
  _themeWin = window.OrwellWindowKit.create({
    id: 'theme-modal',
    title: 'Theme',
    modal: true,            // scrim + inert background + focus-trap + Escape via ui.js
    minimizable: false,     // a modal dialog dismisses on Escape — opt out of minimize
    slotKey: 'theme',       // F5: persisted geometry across sessions
    resizable: true,
    minWidth: 320, minHeight: 320,
    content,                // moved into .ow-body on first open()
  });
  return _themeWin;
}

// On first open the kit has built its titlebar + moved the content into .ow-body.
// Lift the salvaged "Peek" toggle into the kit titlebar (a right-side accessory,
// NOT a traffic light) and drop the now-redundant legacy .modal-header (the kit
// chrome provides the title + close ×). Idempotent. Mirrors settings.js.
function _promoteThemeChrome() {
  if (!_themeWin || !_themeWin.el) return;
  const titlebar = _themeWin.el.querySelector('.ow-titlebar');
  const peek = _themeWin.el.querySelector('#theme-opacity-wrap');
  if (titlebar && peek && peek.parentElement !== titlebar) {
    peek.classList.add('ow-titlebar-accessory');
    titlebar.appendChild(peek);
  }
  const legacyHeader = _themeWin.el.querySelector('.modal-header.theme-popup-header')
    || _themeWin.el.querySelector('.modal-header');
  if (legacyHeader) legacyHeader.remove();
}

// Toggle the popup (open if closed, close if open). The kit window is connected
// only while open, so isConnected is the open-state probe (replaces the old
// .hidden toggle). Lazily builds the kit on first call.
export function togglePopup() {
  const win = initThemeKitWindow();
  if (!win) return;
  if (win.el && win.el.isConnected) { win.close(); return; }
  win.open(document.activeElement);
  _promoteThemeChrome();
}

export function closePopup() {
  // The kit owns the close animation, focus-return, and scrim teardown.
  if (_themeWin) _themeWin.close();
}

// Open (idempotent) — used where an explicit open (not a toggle) is wanted.
export function openPopup() {
  const win = initThemeKitWindow();
  if (!win) return;
  if (!(win.el && win.el.isConnected)) { win.open(document.activeElement); _promoteThemeChrome(); }
}

// Expose for app.js wiring + AI ui_control
export function getCustomThemes() { return _loadCustomThemes(); }

// ── Synapse background effect ──
// Uses the CSS grid pattern as base, overlays fast-moving small light pulses on grid lines
function _initSynapse() {
  if (document.getElementById('synapse-canvas')) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'synapse-canvas';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  // Decorative background effect — hide from assistive tech so screen readers
  // don't announce an empty canvas and axe's "region" rule doesn't flag it.
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const GRID = 24; // matches CSS grid size
  const MAX_PULSES = 20;
  const SPEED_MIN = 2;
  const SPEED_MAX = 22;
  const TRAIL_LEN = 12; // pixels of trailing glow

  let W, H, cols, rows, pulses = [];

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(W / GRID); rows = Math.ceil(H / GRID);
  }
  resize();
  const _onResize = () => resize();
  window.addEventListener('resize', _onResize);

  function getColor() {
    const s = getComputedStyle(document.documentElement);
    return s.getPropertyValue('--bg-effect-color').trim() || s.getPropertyValue('--fg').trim() || '#9cdef2';
  }

  function spawnPulse() {
    const speed = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);
    if (Math.random() > 0.5) {
      // Horizontal — pick a grid row
      const row = Math.floor(Math.random() * (rows + 1));
      pulses.push({ x: -TRAIL_LEN, y: row * GRID, dx: speed, dy: 0 });
    } else {
      // Vertical — pick a grid column
      const col = Math.floor(Math.random() * (cols + 1));
      pulses.push({ x: col * GRID, y: -TRAIL_LEN, dx: 0, dy: speed });
    }
  }

  function draw() {
    if (!document.body.classList.contains('bg-pattern-synapse')) {
      window.removeEventListener('resize', _onResize);
      canvas.remove();
      return;
    }
    requestAnimationFrame(draw);
    ctx.clearRect(0, 0, W, H);
    const c = getColor();

    // Spawn
    if (pulses.length < MAX_PULSES && Math.random() < 0.12) spawnPulse();

    // Draw pulses as small bright dots with a short trail
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      p.x += p.dx; p.y += p.dy;

      // Off screen — remove
      if (p.x > W + TRAIL_LEN || p.y > H + TRAIL_LEN) { pulses.splice(i, 1); continue; }

      // Trail (line gradient fading behind the dot)
      const tx = p.x - (p.dx > 0 ? TRAIL_LEN : 0);
      const ty = p.y - (p.dy > 0 ? TRAIL_LEN : 0);
      const grad = ctx.createLinearGradient(tx, ty, p.x, p.y);
      grad.addColorStop(0, 'transparent');
      grad.addColorStop(1, c);
      ctx.strokeStyle = grad;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();

      // Bright dot at head
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
  }
  draw();
}

// ── Rain — thin vertical streaks falling ──
function _initRain() {
  if (document.getElementById('rain-canvas')) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'rain-canvas';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  // Decorative background effect — hide from assistive tech so screen readers
  // don't announce an empty canvas and axe's "region" rule doesn't flag it.
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W, H;
  const drops = [];
  const MAX_DROPS = 130;

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  const _onResize = () => resize();
  window.addEventListener('resize', _onResize);

  function getColor() {
    const s = getComputedStyle(document.documentElement);
    return s.getPropertyValue('--bg-effect-color').trim() || s.getPropertyValue('--fg').trim() || '#9cdef2';
  }

  function spawn() {
    const len = 20 + Math.random() * 40;
    const speed = 4 + Math.random() * 8;
    drops.push({ x: Math.random() * W, y: -len, len, speed, alpha: 0.32 + Math.random() * 0.28 });
  }

  function draw() {
    if (!document.body.classList.contains('bg-pattern-rain')) {
      window.removeEventListener('resize', _onResize);
      canvas.remove();
      return;
    }
    requestAnimationFrame(draw);
    ctx.clearRect(0, 0, W, H);
    const c = getColor();
    // Intensity also controls rain speed + spawn rate (feels slower/lighter when dim)
    const intenCss = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bg-effect-intensity'));
    const inten = isNaN(intenCss) ? 1 : intenCss;
    const speedMult = 0.35 + inten * 0.65;
    const sizeMult = _getEffectSize();

    if (drops.length < MAX_DROPS * inten && Math.random() < 0.6 * inten) spawn();

    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.y += d.speed * speedMult;
      if (d.y > H + d.len * sizeMult) { drops.splice(i, 1); continue; }

      const effLen = d.len * sizeMult;
      const grad = ctx.createLinearGradient(d.x, d.y - effLen, d.x, d.y);
      grad.addColorStop(0, 'transparent');
      grad.addColorStop(1, c);
      ctx.strokeStyle = grad;
      ctx.globalAlpha = d.alpha;
      ctx.lineWidth = 1.3 * Math.min(2, Math.max(0.6, sizeMult));
      ctx.beginPath();
      ctx.moveTo(d.x, d.y - effLen);
      ctx.lineTo(d.x, d.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  draw();
}

// ── Constellations — static dots that slowly form/dissolve connecting lines ──
function _initConstellations() {
  if (document.getElementById('constellations-canvas')) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'constellations-canvas';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  // Decorative background effect — hide from assistive tech so screen readers
  // don't announce an empty canvas and axe's "region" rule doesn't flag it.
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W, H;
  const STAR_COUNT = 50;
  const CONNECT_DIST = 120;
  let stars = [];

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (stars.length === 0) initStars();
  }

  function initStars() {
    stars = [];
    for (let i = 0; i < STAR_COUNT; i++) {
      stars.push({
        x: Math.random() * W, y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.15,
        vy: (Math.random() - 0.5) * 0.15,
        r: 0.8 + Math.random() * 0.8,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  resize();
  const _onResize = () => { resize(); initStars(); };
  window.addEventListener('resize', _onResize);

  function getColor() {
    const s = getComputedStyle(document.documentElement);
    return s.getPropertyValue('--bg-effect-color').trim() || s.getPropertyValue('--fg').trim() || '#9cdef2';
  }

  let t = 0;
  function draw() {
    if (!document.body.classList.contains('bg-pattern-constellations')) {
      window.removeEventListener('resize', _onResize);
      canvas.remove();
      return;
    }
    requestAnimationFrame(draw);
    t += 0.01;
    ctx.clearRect(0, 0, W, H);
    const c = getColor();

    // Move stars gently
    for (const s of stars) {
      s.x += s.vx; s.y += s.vy;
      if (s.x < 0) s.x = W; if (s.x > W) s.x = 0;
      if (s.y < 0) s.y = H; if (s.y > H) s.y = 0;
    }

    // Draw connections
    ctx.strokeStyle = c;
    ctx.lineWidth = 0.5;
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        const dx = stars[i].x - stars[j].x;
        const dy = stars[i].y - stars[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < CONNECT_DIST) {
          ctx.globalAlpha = (1 - dist / CONNECT_DIST) * 0.15;
          ctx.beginPath();
          ctx.moveTo(stars[i].x, stars[i].y);
          ctx.lineTo(stars[j].x, stars[j].y);
          ctx.stroke();
        }
      }
    }

    // Draw stars with subtle twinkle
    ctx.fillStyle = c;
    for (const s of stars) {
      const twinkle = 0.5 + 0.5 * Math.sin(t * 2 + s.phase);
      ctx.globalAlpha = 0.15 + twinkle * 0.25;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  draw();
}

// ── Noise helper for Perlin effects ──
function _bgNoise2d(x, y) { const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return n - Math.floor(n); }
function _bgSmoothNoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const a = _bgNoise2d(ix, iy), b = _bgNoise2d(ix + 1, iy), cc = _bgNoise2d(ix, iy + 1), d = _bgNoise2d(ix + 1, iy + 1);
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * ux + (cc - a) * uy + (a - b - cc + d) * ux * uy;
}

// ── Perlin Flow — colored particle streams ──
function _initPerlinFlow() {
  if (document.getElementById('perlin-flow-canvas')) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'perlin-flow-canvas';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  // Decorative background effect — hide from assistive tech so screen readers
  // don't announce an empty canvas and axe's "region" rule doesn't flag it.
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W, H, t = 0;
  const particles = [];
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (particles.length === 0) for (let i = 0; i < 200; i++) particles.push({ x: Math.random() * W, y: Math.random() * H, life: Math.random() });
  }
  resize();
  const _onResize = () => resize();
  window.addEventListener('resize', _onResize);
  function getColor() { const s = getComputedStyle(document.documentElement); return s.getPropertyValue('--bg-effect-color').trim() || s.getPropertyValue('--fg').trim() || '#9cdef2'; }
  function getBg() { return getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#282c34'; }
  let _cachedBg = '', _fadeStyle = '';
  function getFade() {
    const bg = getBg();
    if (bg !== _cachedBg) {
      _cachedBg = bg;
      // Parse hex to rgb for rgba fade
      const { r, g, b } = hexToRgb(bg) || { r: 0, g: 0, b: 0 };
      _fadeStyle = `rgba(${r},${g},${b},0.02)`;
    }
    return _fadeStyle;
  }
  function draw() {
    if (!document.body.classList.contains('bg-pattern-perlin-flow')) { window.removeEventListener('resize', _onResize); canvas.remove(); return; }
    requestAnimationFrame(draw);
    ctx.fillStyle = getFade();
    ctx.fillRect(0, 0, W, H);
    const c = getColor();
    particles.forEach(p => {
      const n = _bgSmoothNoise(p.x * 0.004 + t * 0.0008, p.y * 0.004 + 100);
      const angle = n * Math.PI * 6;
      const speed = 1 + _bgSmoothNoise(p.x * 0.003, p.y * 0.003 + 50) * 1.5;
      p.x += Math.cos(angle) * speed; p.y += Math.sin(angle) * speed; p.life -= 0.001;
      if (p.life <= 0 || p.x < 0 || p.x > W || p.y < 0 || p.y > H) { p.x = Math.random() * W; p.y = Math.random() * H; p.life = 1; }
      ctx.beginPath(); ctx.arc(p.x, p.y, 1, 0, Math.PI * 2);
      ctx.fillStyle = c; ctx.globalAlpha = p.life * 0.15; ctx.fill();
    });
    ctx.globalAlpha = 1;
    t++;
  }
  draw();
}

// ── Petals — gentle falling flower petals ──
function _initPetals() {
  if (document.getElementById('petals-canvas')) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'petals-canvas';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  // Decorative background effect — hide from assistive tech so screen readers
  // don't announce an empty canvas and axe's "region" rule doesn't flag it.
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W, H;
  const petals = [];
  function makePetal() {
    return {
      x: Math.random() * W, y: -10 - Math.random() * 40,
      size: 3 + Math.random() * 5, rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.03, vy: 0.3 + Math.random() * 0.6,
      drift: Math.random() * Math.PI * 2, driftSpeed: 0.008 + Math.random() * 0.012,
      wobble: 0.3 + Math.random() * 0.8
    };
  }
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (petals.length === 0) for (let i = 0; i < 30; i++) { const p = makePetal(); p.y = Math.random() * H; petals.push(p); }
  }
  resize();
  const _onResize = () => resize();
  window.addEventListener('resize', _onResize);
  function getColor() { const s = getComputedStyle(document.documentElement); return s.getPropertyValue('--bg-effect-color').trim() || s.getPropertyValue('--fg').trim() || '#9cdef2'; }
  function draw() {
    if (!document.body.classList.contains('bg-pattern-petals')) { window.removeEventListener('resize', _onResize); canvas.remove(); return; }
    requestAnimationFrame(draw);
    ctx.clearRect(0, 0, W, H);
    const c = getColor();
    const sz = _getEffectSize();
    petals.forEach(p => {
      p.y += p.vy; p.rot += p.vr; p.drift += p.driftSpeed;
      p.x += Math.sin(p.drift) * p.wobble;
      if (p.y > H + 15) Object.assign(p, makePetal());
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = 0.2;
      // petal shape — two overlapping ellipses
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.ellipse(-p.size * 0.2 * sz, 0, p.size * 0.6 * sz, p.size * 0.3 * sz, 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.15;
      ctx.beginPath(); ctx.ellipse(p.size * 0.2 * sz, 0, p.size * 0.6 * sz, p.size * 0.3 * sz, -0.3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    });
    ctx.globalAlpha = 1;
  }
  draw();
}

// ── Sparkles — twinkling star-shaped sparkles ──
function _initSparkles() {
  if (document.getElementById('sparkles-canvas')) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'sparkles-canvas';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  // Decorative background effect — hide from assistive tech so screen readers
  // don't announce an empty canvas and axe's "region" rule doesn't flag it.
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W, H;
  const sparkles = [];
  function makeSpark() {
    return { x: Math.random() * W, y: Math.random() * H, size: 2 + Math.random() * 5, phase: Math.random() * Math.PI * 2, speed: 0.015 + Math.random() * 0.03, life: 0.5 + Math.random() * 0.5 };
  }
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (sparkles.length === 0) for (let i = 0; i < 35; i++) sparkles.push(makeSpark());
  }
  resize();
  const _onResize = () => resize();
  window.addEventListener('resize', _onResize);
  function getColor() { const s = getComputedStyle(document.documentElement); return s.getPropertyValue('--bg-effect-color').trim() || s.getPropertyValue('--fg').trim() || '#9cdef2'; }
  function drawStar(x, y, r, c, alpha) {
    ctx.save(); ctx.translate(x, y); ctx.fillStyle = c; ctx.globalAlpha = alpha;
    // 4-point star
    ctx.beginPath();
    ctx.moveTo(0, -r); ctx.quadraticCurveTo(r * 0.15, -r * 0.15, r, 0);
    ctx.quadraticCurveTo(r * 0.15, r * 0.15, 0, r);
    ctx.quadraticCurveTo(-r * 0.15, r * 0.15, -r, 0);
    ctx.quadraticCurveTo(-r * 0.15, -r * 0.15, 0, -r);
    ctx.fill();
    ctx.restore();
  }
  function draw() {
    if (!document.body.classList.contains('bg-pattern-sparkles')) { window.removeEventListener('resize', _onResize); canvas.remove(); return; }
    requestAnimationFrame(draw);
    ctx.clearRect(0, 0, W, H);
    const c = getColor();
    const sizeMult = _getEffectSize();
    sparkles.forEach(s => {
      s.phase += s.speed;
      const twinkle = Math.sin(s.phase);
      const alpha = Math.max(0, twinkle) * 0.25 * s.life;
      const scale = 0.5 + Math.max(0, twinkle) * 0.5;
      if (alpha > 0.01) drawStar(s.x, s.y, s.size * scale * sizeMult, c, alpha);
      // respawn when cycle completes
      if (s.phase > Math.PI * 6) Object.assign(s, makeSpark());
    });
    ctx.globalAlpha = 1;
  }
  draw();
}

// ── Embers — warm particles rising with glow and occasional spark bursts ──
function _initEmbers() {
  if (document.getElementById('embers-canvas')) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'embers-canvas';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  // Decorative background effect — hide from assistive tech so screen readers
  // don't announce an empty canvas and axe's "region" rule doesn't flag it.
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W, H;
  const embers = [];
  function makeEmber() {
    return {
      x: Math.random() * W,
      y: H + Math.random() * 40,
      vx: (Math.random() - 0.5) * 0.3,
      vy: -0.3 - Math.random() * 0.8,
      r: 0.3 + Math.random() * 0.6,
      life: 0,
      maxLife: 220 + Math.random() * 220,
      wobble: Math.random() * Math.PI * 2,
      spark: false,
    };
  }
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (embers.length === 0) {
      for (let i = 0; i < 60; i++) { const e = makeEmber(); e.y = Math.random() * H; e.life = Math.random() * e.maxLife; embers.push(e); }
    }
  }
  resize();
  const _onResize = () => resize();
  window.addEventListener('resize', _onResize);
  function getColor() {
    const s = getComputedStyle(document.documentElement);
    return s.getPropertyValue('--bg-effect-color').trim() || s.getPropertyValue('--fg').trim() || '#c9a95a';
  }
  function rgba(hex, a) {
    const { r, g, b } = hexToRgb(hex) || { r: 0, g: 0, b: 0 };
    return `rgba(${r},${g},${b},${a})`;
  }
  function draw() {
    if (!document.body.classList.contains('bg-pattern-embers')) {
      window.removeEventListener('resize', _onResize);
      canvas.remove();
      return;
    }
    requestAnimationFrame(draw);
    // Fade previous frame (destination-out keeps canvas transparent where no embers)
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    const color = getColor();
    for (let i = embers.length - 1; i >= 0; i--) {
      const e = embers[i];
      e.wobble += 0.03;
      e.x += e.vx + Math.sin(e.wobble) * 0.5;
      e.y += e.vy;
      e.life++;
      if (e.life > e.maxLife || e.y < -20) {
        embers.splice(i, 1);
        if (embers.length < 70) embers.push(makeEmber());
        continue;
      }
      if (!e.spark && Math.random() < 0.003) e.spark = true;
      const lifeRatio = e.life / e.maxLife;
      const fade = Math.min(1, Math.min(lifeRatio * 4, (1 - lifeRatio) * 3));
      const sz = _getEffectSize();
      const r = e.r * (e.spark ? 2.4 : 1) * sz;
      const a = (e.spark ? 0.9 : 0.55) * fade;
      const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r * 4);
      g.addColorStop(0, rgba(color, a));
      g.addColorStop(0.4, rgba(color, a * 0.3));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(e.x - r * 4, e.y - r * 4, r * 8, r * 8);
      ctx.fillStyle = rgba('#ffffff', a * 0.6);
      ctx.beginPath();
      ctx.arc(e.x, e.y, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
      e.spark = false;
    }
    if (Math.random() < 0.015) {
      const bx = Math.random() * W;
      for (let i = 0; i < 5; i++) {
        const e = makeEmber();
        e.x = bx + (Math.random() - 0.5) * 40;
        e.y = H - 10;
        e.vy *= 1.5;
        embers.push(e);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  draw();
}

const themeModule = { initThemeUI, togglePopup, closePopup, openPopup, makeDraggable,
                       THEMES, applyColors, applyFontDensity, applyBgPattern,
                       applyBgEffectColor, applyBgEffectIntensity, applyBgEffectSize,
                       applyGlassTier, glassTierCeiling, applyFrostedGlass, applyGlassTint, applyBgImage, applyGlassMeshBackground,
                       save, getSaved, saveCustomTheme, deleteCustomTheme,
                       getCustomThemes };

export default themeModule;

// F-S1-H: the /login page is UNAUTHENTICATED, but this module gets pulled in there whenever the
// admin's login background is the "bundled" perlin-flow source (login_bg.js dynamically imports
// theme.js to reuse its wallpaper generator). Its two cross-device sync fetches below
// (GET /api/prefs/theme, GET /api/prefs/custom-themes) are session-gated, so pre-auth they only
// ever 401 — two red console lines on every login load. Skip the server round-trip on /login: the
// login page reads its palette straight from localStorage (its inline bootstrap) and needs no
// server prefs, so this drops the noise with no visual or behavioral change.
function _onLoginPage() {
  try { return (window.location.pathname || '').toLowerCase().startsWith('/login'); }
  catch (_) { return false; }
}

// Init on DOM ready, with server-side sync fallback
async function _initWithSync() {
  // F-S1-H: pre-auth on /login the authed prefs fetches can only 401 — skip them (no console noise).
  // initThemeUI() still runs exactly as it did before, so nothing else about boot changes.
  if (_onLoginPage()) { initThemeUI(); return; }
  // If no local theme, try loading from server (cross-device sync)
  if (!getSaved()) {
    const serverTheme = await _loadFromServer();
    if (serverTheme && serverTheme.colors) {
      if (serverTheme.name === 'sakura') serverTheme.name = 'ume';
      Storage.setJSON(LS_KEY, serverTheme);
      applyColors(serverTheme.colors);
    }
  }
  // Also sync custom themes from server
  try {
    const res = await fetch('/api/prefs/custom-themes', { credentials: 'same-origin' });
    const data = await res.json();
    if (data.value && typeof data.value === 'object') {
      const local = _loadCustomThemes();
      const localTomb = _loadTombstones();
      const serverTomb = (data.value[TOMBSTONE_KEY] && typeof data.value[TOMBSTONE_KEY] === 'object')
        ? data.value[TOMBSTONE_KEY] : {};
      let changed = false;
      // #582: merge tombstones LWW (keep the latest deletion timestamp per name).
      for (const [name, ts] of Object.entries(serverTomb)) {
        const t = Number(ts) || 0;
        if (!localTomb[name] || t > localTomb[name]) { localTomb[name] = t; changed = true; }
      }
      // A live local theme that a NEWER tombstone deletes is removed (the deletion wins).
      for (const name of Object.keys(local)) {
        const upd = Number(local[name] && local[name]._updatedAt) || 0;
        if (localTomb[name] && localTomb[name] >= upd) { delete local[name]; changed = true; }
      }
      // Server themes fill in missing local ones — UNLESS a tombstone at least as new as the
      // server copy's update deletes it (so a deleted theme never resurrects from a stale copy).
      for (const [name, colors] of Object.entries(data.value)) {
        if (name === TOMBSTONE_KEY) continue;
        if (local[name]) continue;
        const upd = Number(colors && colors._updatedAt) || 0;
        if (localTomb[name] && localTomb[name] >= upd) continue; // tombstoned — skip resurrection
        local[name] = colors; changed = true;
      }
      if (changed) _saveCustomThemes(local, localTomb);
    }
  } catch (e) { console.warn('Custom theme server sync failed:', e); }
  initThemeUI();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => _initWithSync());
} else {
  _initWithSync();
}
