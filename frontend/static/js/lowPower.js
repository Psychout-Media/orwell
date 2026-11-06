// lowPower.js - ORW-154 / ORW-190: low-power ("reduced effects") mode, ON BY DEFAULT on a GPU-less device.
//
// The default look (glass chrome, a per-bubble backdrop blur, an animated 54px-blurred wallpaper, SVG refraction) assumes a
// GPU. On a software renderer (a VM over remote desktop: SwiftShader / llvmpipe / "Microsoft Basic Render Driver") every
// frame of that is rasterised on the CPU and re-encoded by the remote-desktop codec, and nothing ever detected it.
//
// This module detects a software renderer from WebGL and, unless the player has made an EXPLICIT theme choice, sets
// `body.low-power` and lowers the glass ceiling to Flat (theme.js `glassTierCeiling()` asks `lowPowerActive()`), so:
// no backdrop blur, no animated wallpaper, no glass, no refraction. It is a body class set from JS at startup, so the
// HTML shell and the service worker are untouched.
//
// Precedence: an explicit saved theme (`_explicit: true`, stamped when the player picks a theme/tier) always wins, and an
// explicit override (`localStorage['orwell-low-power']` = '1' force on / '0' force off, or `?lowpower=1|0`) beats detection.

const THEME_KEY = 'orwell-theme';
const OVERRIDE_KEY = 'orwell-low-power';

// WebGL UNMASKED_RENDERER_WEBGL strings of CPU rasterisers. (softpipe/lavapipe are Mesa's other software drivers.)
export const SOFTWARE_RENDERER_RE = /swiftshader|llvmpipe|softpipe|lavapipe|software|microsoft basic render/i;

/** Does this WebGL renderer string name a software rasteriser? Non-string / empty => false (unknown is not "software"). */
export function isSoftwareRendererString(renderer) {
  return typeof renderer === 'string' && SOFTWARE_RENDERER_RE.test(renderer);
}

/**
 * Probe WebGL once. A context that cannot be created (or a throw while probing) counts as software: a GPU-less browser
 * is exactly where WebGL is blocked. `doc` is injectable for tests.
 * @returns {{ software: boolean, renderer: string|null, reason: 'renderer'|'no-webgl'|'hardware' }}
 */
export function detectSoftwareRenderer(doc) {
  doc = doc || (typeof document !== 'undefined' ? document : null);
  if (!doc) return { software: false, renderer: null, reason: 'hardware' };
  let gl = null;
  try {
    const canvas = doc.createElement('canvas');
    gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return { software: true, renderer: null, reason: 'no-webgl' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return { software: isSoftwareRendererString(renderer), renderer, reason: isSoftwareRendererString(renderer) ? 'renderer' : 'hardware' };
  } catch (_) {
    return { software: true, renderer: null, reason: 'no-webgl' };
  } finally {
    try { const lose = gl && gl.getExtension && gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch (_) { /* noop */ }
  }
}

/** Has the player made an explicit theme choice? (`_explicit` is stamped by the swatch / glass-tier pick, see theme.js save().) */
export function hasExplicitThemeChoice(storage) {
  try {
    const raw = storage && storage.getItem(THEME_KEY);
    if (!raw) return false;
    const rec = JSON.parse(raw);
    return !!(rec && rec._explicit === true);
  } catch (_) { return false; }
}

/** 'on' | 'off' | null from the query string / localStorage escape hatch. */
export function readOverride(storage, search) {
  let v = null;
  try {
    const m = /[?&]lowpower=([01])\b/.exec(search || '');
    if (m) v = m[1];
    else if (storage) v = storage.getItem(OVERRIDE_KEY);
  } catch (_) { /* noop */ }
  return v === '1' ? 'on' : v === '0' ? 'off' : null;
}

/**
 * The pure decision. override wins; else an explicit theme choice wins over detection; else software => on.
 * @param {{software:boolean, explicit:boolean, override:'on'|'off'|null}} p
 */
export function shouldUseLowPower({ software, explicit, override }) {
  if (override === 'on') return true;
  if (override === 'off') return false;
  if (explicit) return false;
  return !!software;
}

let _detected = null; // memoised WebGL probe (one canvas per page load)

/**
 * Evaluate and apply: toggles `body.low-power`, records `window.__orwellLowPower` for diagnostics, returns the verdict.
 * Cheap to call repeatedly (the WebGL probe is memoised; the explicit/override reads are two localStorage lookups), so
 * theme.js calls it each time the glass ceiling is asked, and the verdict follows the player's choice live.
 */
export function evaluateLowPower(env) {
  env = env || {};
  const storage = env.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const search = env.search !== undefined ? env.search : (typeof location !== 'undefined' ? location.search : '');
  const detect = env.detect || detectSoftwareRenderer;
  if (!_detected || env.fresh) _detected = detect();
  const explicit = hasExplicitThemeChoice(storage);
  const override = readOverride(storage, search);
  const on = shouldUseLowPower({ software: _detected.software, explicit, override });
  const body = env.body || (typeof document !== 'undefined' ? document.body : null);
  if (body) body.classList.toggle('low-power', on);
  try {
    if (typeof window !== 'undefined') window.__orwellLowPower = { on, explicit, override, ..._detected };
  } catch (_) { /* noop */ }
  return on;
}

/** True when the reduced-effects default applies right now. */
export function lowPowerActive() {
  return evaluateLowPower();
}

/** Test seam: forget the memoised probe. */
export function _resetLowPowerForTests() { _detected = null; }

export default { isSoftwareRendererString, detectSoftwareRenderer, hasExplicitThemeChoice, shouldUseLowPower, evaluateLowPower, lowPowerActive };
