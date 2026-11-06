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
// Precedence: an explicit override (`localStorage['orwell-low-power']` = '1' force on / '0' force off, or `?lowpower=1|0`) beats
// everything; else an explicit saved theme (`_explicit: true`, stamped by every theme save) wins over detection; else detection.
// AUTOMATION: a browser driven by WebDriver/Playwright (`navigator.webdriver`) is a test harness, not a player, and CI runners are
// software-rendered: so detection is skipped there (glass stays the deterministic default for the mirror, screenshot, a11y and perf
// jobs) unless the override is '1' or 'auto' (`localStorage['orwell-low-power']='auto'` / `?lowpower=auto` = detect even under automation).

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
    if (isSoftwareRendererString(renderer)) return { software: true, renderer, reason: 'renderer' };
    // second signal: the browser itself says a GPU-less context is a "major performance caveat" (it refuses it when asked to)
    try {
      const strict = doc.createElement('canvas');
      const g2 = strict.getContext('webgl', { failIfMajorPerformanceCaveat: true });
      if (g2 === null) return { software: true, renderer, reason: 'perf-caveat' };
      try { const l2 = g2.getExtension && g2.getExtension('WEBGL_lose_context'); if (l2) l2.loseContext(); } catch (_) { /* noop */ }
    } catch (_) { /* a browser that rejects the option: no second signal */ }
    return { software: false, renderer, reason: 'hardware' };
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

/** 'on' | 'off' | 'auto' | null from the query string / localStorage escape hatch ('auto' = detect even under automation). */
export function readOverride(storage, search) {
  let v = null;
  try {
    const m = /[?&]lowpower=(1|0|auto)\b/.exec(search || '');
    if (m) v = m[1];
    else if (storage) v = storage.getItem(OVERRIDE_KEY);
  } catch (_) { /* noop */ }
  return v === '1' ? 'on' : v === '0' ? 'off' : v === 'auto' ? 'auto' : null;
}

/**
 * The pure decision. override wins; else automation (a test harness) is never low-power; else an explicit theme choice wins over
 * detection; else software => on.
 * @param {{software:boolean, explicit:boolean, override:'on'|'off'|'auto'|null, automated?:boolean}} p
 */
export function shouldUseLowPower({ software, explicit, override, automated }) {
  if (override === 'on') return true;
  if (override === 'off') return false;
  if (automated && override !== 'auto') return false;
  if (explicit) return false;
  return !!software;
}

let _detected = null;      // memoised WebGL probe: a SUCCESSFUL answer is kept for the page (one canvas per page load)
let _failedAt = 0;         // a FAILED probe (no WebGL / threw) is never memoised for good: re-probed at most every 5 s

/** Decide (pure of the DOM: no class is touched). The WebGL probe is memoised only when it succeeded. */
export function decideLowPower(env) {
  env = env || {};
  const storage = env.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const search = env.search !== undefined ? env.search : (typeof location !== 'undefined' ? location.search : '');
  const automated = env.automated !== undefined ? env.automated : (typeof navigator !== 'undefined' && navigator.webdriver === true);
  const detect = env.detect || detectSoftwareRenderer;
  const now = env.now !== undefined ? env.now : Date.now();
  if (!_detected || env.fresh) {
    if (!(_failedAt && now - _failedAt < 5000 && !env.fresh)) {
      const d = detect();
      if (d.reason === 'no-webgl') _failedAt = now; else { _detected = d; _failedAt = 0; }
      _lastProbe = d;
    }
  }
  const probe = _detected || _lastProbe || { software: false, renderer: null, reason: 'hardware' };
  const explicit = hasExplicitThemeChoice(storage);
  const override = readOverride(storage, search);
  const on = shouldUseLowPower({ software: probe.software, explicit, override, automated });
  return { on, explicit, override, automated, ...probe };
}
let _lastProbe = null;

/** Apply a verdict: toggle `body.low-power` and record `window.__orwellLowPower` for diagnostics. */
export function applyLowPowerClass(verdict, body) {
  body = body || (typeof document !== 'undefined' ? document.body : null);
  if (body) body.classList.toggle('low-power', !!verdict.on);
  try { if (typeof window !== 'undefined') window.__orwellLowPower = verdict; } catch (_) { /* noop */ }
}

/** Decide + apply (kept for callers/tests that want both). */
export function evaluateLowPower(env) {
  const verdict = decideLowPower(env);
  applyLowPowerClass(verdict, env && env.body);
  return verdict.on;
}

/** True when the reduced-effects default applies right now. Pure: it never touches the DOM (see applyLowPowerClass). */
export function lowPowerActive() {
  return decideLowPower().on;
}

/** Test seam: forget the memoised probe. */
export function _resetLowPowerForTests() { _detected = null; _failedAt = 0; _lastProbe = null; }

export default { isSoftwareRendererString, detectSoftwareRenderer, hasExplicitThemeChoice, shouldUseLowPower, decideLowPower, applyLowPowerClass, evaluateLowPower, lowPowerActive };
