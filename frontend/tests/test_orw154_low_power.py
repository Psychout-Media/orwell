"""ORW-154 / ORW-190 - low-power (reduced effects) mode by default on a GPU-less device.

Root cause (audit report A, 3.1): the default look (glass chrome, per-bubble backdrop blur, an animated 54px-blurred wallpaper, SVG refraction) assumes a GPU and NOTHING detected a software
renderer; the only guard was a one-shot FPS probe at boot that could only drop one rung. On a VM over remote desktop every frame is CPU-rasterised and re-encoded.

Fix: `static/js/lowPower.js` reads the WebGL UNMASKED_RENDERER_WEBGL string (SwiftShader / llvmpipe / Software / Microsoft Basic Render, or no WebGL context at all) and, unless the player made an
EXPLICIT theme choice (`_explicit` in the saved theme) or overrode it, sets `body.low-power` and lowers theme.js's glass ceiling to Flat. A JS-set body class only: index.html and sw.js are untouched.

Legs: the detection function unit-tested in Node (fake WebGL), the decision matrix, and a real-browser test that the class is applied when the renderer is software (and not when it is hardware / the
player chose a theme explicitly).
"""
import json
import os
import shutil
import subprocess

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(FRONTEND, "static")
_NODE = shutil.which("node")


def _read(*parts):
    with open(os.path.join(STATIC, *parts), encoding="utf-8") as f:
        return f.read()


_PROGRAM = r"""
const fs = require('fs');
const src = fs.readFileSync(process.argv[1], 'utf8').replace(/export default [^;]*;/, '').replace(/export /g, '');
const lib = new Function(src + '; return { isSoftwareRendererString, detectSoftwareRenderer, hasExplicitThemeChoice, setThemeChoiceClassifier, readOverride, shouldUseLowPower, decideLowPower, evaluateLowPower, _resetLowPowerForTests };')();
const out = {};

const strings = {
  swiftshader: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  llvmpipe: 'llvmpipe (LLVM 15.0.7, 256 bits)',
  software: 'Mesa Software Rasterizer',
  basic: 'Microsoft Basic Render Driver',
  nvidia: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  apple: 'Apple M2',
  intel: 'Intel(R) Iris(R) Xe Graphics',
};
out.strings = Object.fromEntries(Object.entries(strings).map(([k, v]) => [k, lib.isSoftwareRendererString(v)]));
out.nonStrings = [null, undefined, '', 42, {}].map((v) => lib.isSoftwareRendererString(v));

function fakeDoc(renderer, opts = {}) {
  const gl = {
    RENDERER: 0x1F01,
    getExtension: (n) => (n === 'WEBGL_debug_renderer_info' && !opts.noExt ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null),
    getParameter: (p) => (p === 0x9246 ? renderer : 'WebKit WebGL'),
  };
  return { createElement: () => ({ getContext: (k) => { if (opts.throws) throw new Error('boom'); return opts.noContext ? null : (opts.onlyWebgl1 && k === 'webgl2' ? null : gl); } }) };
}
out.detect = {
  swiftshader: lib.detectSoftwareRenderer(fakeDoc(strings.swiftshader)),
  nvidia: lib.detectSoftwareRenderer(fakeDoc(strings.nvidia)),
  webgl1Only: lib.detectSoftwareRenderer(fakeDoc(strings.llvmpipe, { onlyWebgl1: true })),
  noContext: lib.detectSoftwareRenderer(fakeDoc('x', { noContext: true })),
  throws: lib.detectSoftwareRenderer(fakeDoc('x', { throws: true })),
  noExtMaskedRenderer: lib.detectSoftwareRenderer(fakeDoc(strings.llvmpipe, { noExt: true })),
};

const D = { software: true, explicit: false, override: null };
out.decide = {
  softwareDefault: lib.shouldUseLowPower(D),
  hardwareDefault: lib.shouldUseLowPower({ ...D, software: false }),
  softwareExplicit: lib.shouldUseLowPower({ ...D, explicit: true }),
  forceOn: lib.shouldUseLowPower({ software: false, explicit: true, override: 'on' }),
  forceOff: lib.shouldUseLowPower({ ...D, override: 'off' }),
  automationSkipsDetection: lib.shouldUseLowPower({ ...D, automated: true }),   // a WebDriver/Playwright browser is a harness: glass stays the default
  automationAutoOverride: lib.shouldUseLowPower({ ...D, automated: true, override: 'auto' }),
  automationForceOn: lib.shouldUseLowPower({ ...D, automated: true, override: 'on' }),
};

const store = (rec) => ({ getItem: (k) => (k === 'orwell-theme' ? (rec === undefined ? null : typeof rec === 'string' ? rec : JSON.stringify(rec)) : null) });
out.explicit = {
  none: lib.hasExplicitThemeChoice(store(undefined)),
  autoSeeded: lib.hasExplicitThemeChoice(store({ name: 'glass' })),
  explicit: lib.hasExplicitThemeChoice(store({ name: 'dark', _explicit: true })),
  corrupt: lib.hasExplicitThemeChoice(store('{not json')),
};
out.override = { q1: lib.readOverride(null, '?a=1&lowpower=1'), qauto: lib.readOverride(null, '?lowpower=auto'), q0: lib.readOverride(null, '?lowpower=0'), none: lib.readOverride({ getItem: () => null }, ''), ls: lib.readOverride({ getItem: () => '0' }, '') };

// evaluateLowPower toggles the body class and follows an explicit choice live (probe memoised)
const cls = new Set();
const body = { classList: { toggle: (c, on) => { on ? cls.add(c) : cls.delete(c); } } };
let probes = 0;
const detect = () => { probes++; return { software: true, renderer: 'SwiftShader', reason: 'renderer' }; };
global.window = {};
lib._resetLowPowerForTests();
out.eval = {};
out.eval.first = lib.evaluateLowPower({ storage: store(undefined), search: '', detect, body });
out.eval.classOn = cls.has('low-power');
out.eval.afterExplicit = lib.evaluateLowPower({ storage: store({ name: 'glass', _explicit: true }), search: '', detect, body });
out.eval.classOff = !cls.has('low-power');
out.eval.probes = probes;

// a FAILED probe (no WebGL) is not memoised for good: it is re-probed after the 5 s window, and a later success is then kept
lib._resetLowPowerForTests();
let n = 0;
const flaky = () => { n++; return n === 1 ? { software: true, renderer: null, reason: 'no-webgl' } : { software: false, renderer: 'NVIDIA', reason: 'hardware' }; };
const env = (now) => ({ storage: store(undefined), search: '', detect: flaky, automated: false, now });
const f1 = lib.decideLowPower(env(1000));            // probe fails -> low-power
const f2 = lib.decideLowPower(env(2000));            // inside the 5 s window: not re-probed
const f3 = lib.decideLowPower(env(7000));            // window over: re-probed, now a real GPU
const f4 = lib.decideLowPower(env(8000));            // success is memoised
out.failure = { first: f1.on, within: f2.on, after: f3.on, probes: n, memoised: f4.on };
// no-webgl never beats an explicit choice
lib._resetLowPowerForTests();
out.failureExplicit = lib.decideLowPower({ storage: store({ name: 'dark', _explicit: true }), search: '', detect: () => ({ software: true, renderer: null, reason: 'no-webgl' }), automated: false }).on;
// the second signal: a context that only exists with a major performance caveat
function perfCaveatDoc() {
  const gl = { RENDERER: 1, getExtension: (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 2 } : null), getParameter: (p) => (p === 2 ? 'Some Unknown GPU' : 'x') };
  return { createElement: () => ({ getContext: (k, o) => (o && o.failIfMajorPerformanceCaveat ? null : gl) }) };
}
out.perfCaveat = lib.detectSoftwareRenderer(perfCaveatDoc());

// theme.js injects its full classifier (a pre-stamp customised record counts as a choice); lowPower.js must use it everywhere, survive a
// classifier that throws (fall back to the `_explicit` stamp) and ignore a non-function
const SW = () => ({ software: true, renderer: 'llvmpipe', reason: 'renderer' });
lib.setThemeChoiceClassifier((r) => r._explicit === true || !!r.tinted || r.name !== 'glass');
lib._resetLowPowerForTests();
out.classifier = {
  legacyTinted: lib.hasExplicitThemeChoice(store({ name: 'glass', tinted: true })),
  legacyOtherTheme: lib.hasExplicitThemeChoice(store({ name: 'dark' })),
  untouchedDefault: lib.hasExplicitThemeChoice(store({ name: 'glass' })),
  decideLegacyTinted: lib.decideLowPower({ storage: store({ name: 'glass', tinted: true }), search: '', detect: SW, automated: false, fresh: true }).on,
  decideUntouched: lib.decideLowPower({ storage: store({ name: 'glass' }), search: '', detect: SW, automated: false, fresh: true }).on,
};
lib.setThemeChoiceClassifier(() => { throw new Error('boom'); });
lib.setThemeChoiceClassifier('not a function');   // ignored: the throwing classifier above stays installed
out.classifierThrows = { stamped: lib.hasExplicitThemeChoice(store({ name: 'glass', _explicit: true })), unstamped: lib.hasExplicitThemeChoice(store({ name: 'dark' })) };
console.log(JSON.stringify(out));
"""


@pytest.fixture(scope="module")
def unit():
    if not _NODE:
        pytest.skip("node not available")
    p = subprocess.run([_NODE, "-e", _PROGRAM, os.path.join(STATIC, "js", "lowPower.js")], capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr[-1500:]
    return json.loads(p.stdout.strip().splitlines()[-1])


def test_renderer_strings(unit):
    s = unit["strings"]
    assert s["swiftshader"] and s["llvmpipe"] and s["software"] and s["basic"]
    assert not s["nvidia"] and not s["apple"] and not s["intel"]
    assert unit["nonStrings"] == [False] * 5  # unknown is not "software"


def test_detection_from_a_webgl_context(unit):
    d = unit["detect"]
    assert d["swiftshader"]["software"] and d["swiftshader"]["reason"] == "renderer"
    assert not d["nvidia"]["software"] and d["nvidia"]["reason"] == "hardware"
    assert d["webgl1Only"]["software"]  # falls back to webgl1, still reads the renderer
    assert d["noContext"] == {"software": True, "renderer": None, "reason": "no-webgl"}  # a failed context counts as software
    assert d["throws"]["software"] and d["throws"]["reason"] == "no-webgl"
    assert not d["noExtMaskedRenderer"]["software"]  # no debug extension => the generic RENDERER string; not provably software


def test_decision_matrix_explicit_theme_always_wins_over_detection(unit):
    d = unit["decide"]
    assert d["softwareDefault"] is True
    assert d["hardwareDefault"] is False
    assert d["softwareExplicit"] is False  # the player's explicit theme choice wins
    assert d["forceOn"] is True and d["forceOff"] is False  # the explicit override beats everything
    # CI determinism: an automated browser (software-rendered runner) keeps the glass default unless it opts in with 'auto' or 'on'
    assert d["automationSkipsDetection"] is False and d["automationAutoOverride"] is True and d["automationForceOn"] is True


def test_explicit_choice_and_override_parsing(unit):
    e = unit["explicit"]
    assert e == {"none": False, "autoSeeded": False, "explicit": True, "corrupt": False}
    assert unit["override"] == {"q1": "on", "qauto": "auto", "q0": "off", "none": None, "ls": "off"}


def test_evaluate_toggles_the_body_class_and_follows_an_explicit_choice(unit):
    ev = unit["eval"]
    assert ev["first"] is True and ev["classOn"]
    assert ev["afterExplicit"] is False and ev["classOff"]
    assert ev["probes"] == 1  # the WebGL probe is memoised: one canvas per page load


def test_a_failed_probe_is_not_memoised_and_never_beats_an_explicit_choice(unit):
    f = unit["failure"]
    assert f == {"first": True, "within": True, "after": False, "probes": 2, "memoised": False}, f  # re-probed after 5 s; the later success stuck
    assert unit["failureExplicit"] is False
    assert unit["perfCaveat"]["software"] and unit["perfCaveat"]["reason"] == "perf-caveat"  # second signal


def test_every_save_stamps_an_explicit_choice():
    theme = _read("js", "theme.js")
    body = theme[theme.index("export function save(name, colors, opts) {"):]
    body = body[:body.index("\n}\n")]
    assert "obj._explicit = true;" in body  # swatch, tier, tint, font, picker, custom theme: none of them can drop the choice
    assert "decideLowPower()" in theme and "applyLowPowerClass(" in theme  # the ceiling decides; applyGlassTier applies the class


def test_wiring_theme_ceiling_and_css():
    theme = _read("js", "theme.js")
    assert "from './lowPower.js';" in theme
    ceiling = theme[theme.index("export function glassTierCeiling()"):]
    ceiling = ceiling[:ceiling.index("\n}\n")]
    assert "if (lowPowerActive()) return 'normal';" in ceiling
    css = _read("css", "game-trim.css")
    assert "body.low-power *::after" in css and "backdrop-filter: none !important" in css
    assert "animation: none !important" in css
    # the HTML shell and the service worker are owned by another lane and must not know about this
    assert "low-power" not in _read("index.html") and "low-power" not in _read("sw.js")


def test_an_injected_classifier_decides_explicit_and_survives_a_throw(unit):
    """Greptile on #2262: a record saved before every save() stamped `_explicit` (a colour edit, a custom theme, a tint/tier/font tweak) is
    still the player's choice. theme.js injects that classifier; lowPower.js must use it for the decision, not only the stamp."""
    assert unit["classifier"] == {"legacyTinted": True, "legacyOtherTheme": True, "untouchedDefault": False,
                                  "decideLegacyTinted": False, "decideUntouched": True}, unit["classifier"]
    assert unit["classifierThrows"] == {"stamped": True, "unstamped": False}, unit["classifierThrows"]


def test_theme_js_registers_its_classifier_and_a_first_tier_pick_is_saved():
    theme = _read("js", "theme.js")
    assert "setThemeChoiceClassifier(isDeliberateThemeRecord);" in theme
    assert "export function isDeliberateThemeRecord(obj)" in theme
    # Greptile on #2262: the Glass/Flat control saves even when nothing is saved yet (it used to skip the save, so on a software renderer
    # the low-power ceiling kept a first Glass pick Flat)
    ctrl = theme[theme.index("const GLASS_TIER_CONTROL_IDS"):]
    ctrl = ctrl[:ctrl.index("_syncGlassTierControl(_initTier);")]
    assert "const s = getSaved() || _untouchedDefaultRecord();" in ctrl
    assert "if (s) _saveFull" not in ctrl
    # the stale-old-default migration keeps its own rules (only the shared field checks moved)
    mig = theme[theme.index("function _isPristineOldDefault(obj) {"):]
    mig = mig[:mig.index("\n}\n")]
    assert "obj.name !== _PREV_DEFAULT_THEME" in mig and "if (obj._explicit) return false;" in mig and "_isUncustomizedRecordOf(obj, _PREV_DEFAULT_THEME)" in mig
