#!/usr/bin/env python3
"""ORW-1016: time-to-interactive and interaction-lag measurement for the player page, with a generous regression guard.

Boots the front end alone (the same way scripts/browser_smoke.py does: uvicorn, game build, no engine, no model) and, in headless Chromium,
for each of three viewports (1920x1080, 3840x2160, and a phone 390x844 at device-scale 3 with touch), measures:

  COLD   a fresh browser context (empty HTTP cache): navigation timing (response end, DOMContentLoaded, load event), first contentful paint,
         largest contentful paint, time to INTERACTIVE, requests and bytes on the wire.
  WARM   the same context loaded again (HTTP cache primed): the same numbers, plus how many requests still reached the network
         (resource entries whose transferSize is not 0: a 304 revalidation counts, a cache hit does not).
  LAG    typing into the composer and tapping/clicking it: Event Timing (input to next paint durations), reported as the worst and the
         95th percentile, and the longest long task while typing.

Time to interactive is the Lighthouse definition made simple: the end of the last long task (>50 ms) before the first 5-second window after
first contentful paint with no long task and at most 2 requests in flight; if the page is still busy when observation ends it is reported
as the end of observation (a hang shows as a big number, never a missing one). The composer (#message) must also be mounted and enabled;
the reported TTI is the later of the two.

Each viewport is measured `--runs` times (default 3) and the MEDIAN of each number is reported, which tames runner noise.

GUARD: the ceilings in CEILINGS are deliberately generous (several times the values measured on the CI-class runner, quoted on ORW-1016) so
only a real regression (a module load flood, a main-thread stall) trips them. `--enforce` makes a breach exit 3; otherwise report-only.
Raise a ceiling only with a measurement. Exit 2 means the harness itself could not run.

Output: a table on stdout, JSON (`--out`, default perf-load.json) for the CI artifact, markdown appended to $GITHUB_STEP_SUMMARY.

Run:  cd frontend && python3 scripts/perf_load.py [--runs 3] [--cpu-throttle 1] [--out perf-load.json] [--enforce]
Needs: `playwright install chromium`. No engine bundle is needed.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # frontend/
PY = os.environ.get("PYTHON", sys.executable)
PORT = int(os.environ.get("ORWELL_FE_PERF_LOAD_PORT", "8197"))

VIEWPORTS = {
    "1080p": {"viewport": {"width": 1920, "height": 1080}, "device_scale_factor": 1, "is_mobile": False, "has_touch": False},
    "4k": {"viewport": {"width": 3840, "height": 2160}, "device_scale_factor": 1, "is_mobile": False, "has_touch": False},
    "phone": {"viewport": {"width": 390, "height": 844}, "device_scale_factor": 3, "is_mobile": True, "has_touch": True},
}

# ORW-1016 GUARD. Milliseconds or counts, medians over --runs. Each ceiling is a generous multiple of the measured baseline (card ORW-1016).
# Never loosen one to make a red run green: find the regression.
CEILINGS = {
    "cold_load_event_ms": 15000,
    "cold_tti_ms": 25000,
    "warm_load_event_ms": 10000,
    "warm_tti_ms": 25000,
    "worst_interaction_ms": 8000,
    "warm_network_requests": 200,
}

INIT_JS = r"""
(() => {
  const P = window.__p = { long: [], paint: {}, lcp: 0, events: [] };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) P.long.push([e.startTime, e.duration]); })
    .observe({ type: 'longtask', buffered: true }); } catch (e) {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) P.paint[e.name] = e.startTime; })
    .observe({ type: 'paint', buffered: true }); } catch (e) {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) P.lcp = e.startTime; })
    .observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) P.events.push([e.name, e.duration, e.processingStart - e.startTime]); })
    .observe({ type: 'event', durationThreshold: 16, buffered: true }); } catch (e) {}
})();
"""

COLLECT_JS = r"""
() => {
  const P = window.__p, n = performance.getEntriesByType('navigation')[0] || {};
  const res = performance.getEntriesByType('resource');
  const ext = (u) => { try { return new URL(u).pathname.split('.').pop(); } catch (e) { return ''; } };
  const js = res.filter(r => ext(r.name) === 'js'), css = res.filter(r => ext(r.name) === 'css');
  const c = document.querySelector('#message');
  return {
    response_end: n.responseEnd || 0, dcl: n.domContentLoadedEventEnd || 0, load: n.loadEventEnd || 0,
    fcp: P.paint['first-contentful-paint'] || 0, lcp: P.lcp || 0,
    long: P.long.slice(), now: performance.now(), tz: performance.timeOrigin,
    requests: res.length + 1, network_requests: res.filter(r => r.transferSize !== 0).length + 1,
    transfer_bytes: res.reduce((a, r) => a + (r.transferSize || 0), 0) + (n.transferSize || 0),
    js_requests: js.length, css_requests: css.length,
    js_transfer: js.reduce((a, r) => a + (r.transferSize || 0), 0), css_transfer: css.reduce((a, r) => a + (r.transferSize || 0), 0),
    composer: !!c && !c.disabled,
    windows: res.map(r => [r.startTime, r.responseEnd]),
  };
}
"""

EVENTS_JS = "() => ({ events: window.__p.events.slice(), long: window.__p.long.slice() })"


def compute_tti(fcp: float, long_tasks: list, request_windows: list, observed_until: float) -> float:
    """Pure: Lighthouse-style time to interactive, ms from navigation start.

    `long_tasks` is [(start, duration)], `request_windows` [(start, end)] for every request, `observed_until` the end of observation.
    Finds the first 5000 ms window starting at or after `fcp` with no long task and at most 2 requests in flight; returns the end of the
    last long task before that window (or `fcp` if none). If no such window fits before `observed_until`, returns `observed_until`."""
    quiet = 5000.0
    t = fcp
    while t + quiet <= observed_until:
        busy = [s + d for s, d in long_tasks if s < t + quiet and s + d > t]
        if busy:
            t = max(busy)
            continue
        edges = sorted({t, t + quiet} | {x for w in request_windows for x in w if t < x < t + quiet})
        heavy_until = None
        for a, b in zip(edges, edges[1:]):
            mid = (a + b) / 2
            if sum(1 for s, e in request_windows if s <= mid < e) > 2:
                heavy_until = b
        if heavy_until is None:
            return max([fcp] + [s + d for s, d in long_tasks if s + d <= t])
        t = heavy_until
    return observed_until


def median(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else 0.0


def pctl(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * q))] if xs else 0.0


def ceiling_violations(res: dict) -> list:
    """Pure: the ceilings this result breaks, as human-readable lines (empty = within the guard). `res["viewports"]` maps name -> medians."""
    out = []
    for vp, m in (res.get("viewports") or {}).items():
        for key, limit in CEILINGS.items():
            v = m.get(key)
            if v is not None and v > limit:
                out.append(f"{vp}: {key} {v} > ceiling {limit}")
    return out


def measure_load(page, base: str, observe_ms: int, key: str) -> dict:
    page.goto(base + "/", wait_until="load")
    t0 = time.monotonic()
    try:
        page.wait_for_function("() => { const c = document.querySelector('#message'); return !!c && !c.disabled; }", timeout=30000)
    except Exception:  # noqa: BLE001  (a missing composer is reported through the TTI below; do not abort the run)
        pass
    page.wait_for_timeout(observe_ms)
    d = page.evaluate(COLLECT_JS)
    tti = compute_tti(d["fcp"], [tuple(x) for x in d["long"]], [tuple(w) for w in d["windows"]], d["now"])
    if not d["composer"]:
        tti = d["now"]
    return {
        f"{key}_response_end_ms": round(d["response_end"], 1), f"{key}_dcl_ms": round(d["dcl"], 1), f"{key}_load_event_ms": round(d["load"], 1),
        f"{key}_fcp_ms": round(d["fcp"], 1), f"{key}_lcp_ms": round(d["lcp"], 1), f"{key}_tti_ms": round(tti, 1),
        f"{key}_requests": d["requests"], f"{key}_network_requests": d["network_requests"],
        f"{key}_transfer_kb": round(d["transfer_bytes"] / 1024.0, 1),
        f"{key}_js_requests": d["js_requests"], f"{key}_css_requests": d["css_requests"],
        f"{key}_js_transfer_kb": round(d["js_transfer"] / 1024.0, 1), f"{key}_css_transfer_kb": round(d["css_transfer"] / 1024.0, 1),
        f"{key}_long_tasks": len(d["long"]), f"{key}_long_task_total_ms": round(sum(x[1] for x in d["long"]), 1),
    }


def measure_lag(page, touch: bool) -> dict:
    """Click/tap the composer and type into it; read Event Timing durations (input to next paint) and the long tasks it produced."""
    before = page.evaluate(EVENTS_JS)
    # The first-run onboarding scrim covers the composer and swallows pointer actionability checks, so aim at the composer's coordinates
    # directly: the pointer events still run the page's handlers, which is the lag being measured.
    box = page.locator("#message").bounding_box() or {"x": 100, "y": 100, "width": 10, "height": 10}
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    for _ in range(5):
        page.touchscreen.tap(x, y) if touch else page.mouse.click(x, y)
        page.wait_for_timeout(120)
    page.focus("#message")
    page.keyboard.type("The quick brown fox jumps over the lazy dog", delay=40)
    page.wait_for_timeout(800)
    after = page.evaluate(EVENTS_JS)
    ev = after["events"][len(before["events"]):]
    durs = [e[1] for e in ev]
    long_new = after["long"][len(before["long"]):]
    return {
        "interaction_events": len(ev),
        "worst_interaction_ms": round(max(durs), 1) if durs else 0.0,  # 0 = every event painted inside the 16 ms Event Timing floor
        "p95_interaction_ms": round(pctl(durs, 0.95), 1) if durs else 0.0,
        "worst_input_delay_ms": round(max((e[2] for e in ev), default=0.0), 1),
        "lag_longest_long_task_ms": round(max((x[1] for x in long_new), default=0.0), 1),
    }


def run(base: str, runs: int, throttle: float, observe_ms: int) -> dict:
    from playwright.sync_api import sync_playwright

    out = {"cpu_throttle": throttle, "runs": runs, "viewports": {}, "raw": {}}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for name, opts in VIEWPORTS.items():
            samples = []
            for _ in range(runs):
                ctx = browser.new_context(**opts)  # a fresh context = an empty HTTP cache = a true cold load
                page = ctx.new_page()
                page.add_init_script(INIT_JS)
                if throttle and throttle > 1:
                    cdp = ctx.new_cdp_session(page)
                    cdp.send("Emulation.setCPUThrottlingRate", {"rate": throttle})
                s = {}
                s.update(measure_load(page, base, observe_ms, "cold"))
                s.update(measure_load(page, base, observe_ms, "warm"))
                s.update(measure_lag(page, opts["has_touch"]))
                samples.append(s)
                ctx.close()
            out["raw"][name] = samples
            out["viewports"][name] = {k: median([s[k] for s in samples]) for k in samples[0]}
        browser.close()
    return out


def render_rows(res: dict):
    cols = list(res["viewports"].keys())
    rows = [
        ("COLD  response end (ms)", "cold_response_end_ms"), ("COLD  DOMContentLoaded (ms)", "cold_dcl_ms"),
        ("COLD  load event (ms)", "cold_load_event_ms"), ("COLD  first contentful paint (ms)", "cold_fcp_ms"),
        ("COLD  largest contentful paint (ms)", "cold_lcp_ms"), ("COLD  time to interactive (ms)", "cold_tti_ms"),
        ("COLD  requests", "cold_requests"), ("COLD  transferred (KB)", "cold_transfer_kb"),
        ("COLD  JS files / CSS files", ("cold_js_requests", "cold_css_requests")),
        ("COLD  long tasks (count)", "cold_long_tasks"),
        ("WARM  load event (ms)", "warm_load_event_ms"), ("WARM  time to interactive (ms)", "warm_tti_ms"),
        ("WARM  requests / reaching the network", ("warm_requests", "warm_network_requests")),
        ("WARM  transferred (KB)", "warm_transfer_kb"),
        ("LAG   worst interaction, input to paint (ms; 0 = under 16)", "worst_interaction_ms"),
        ("LAG   p95 interaction (ms)", "p95_interaction_ms"), ("LAG   interactions at or over 16 ms", "interaction_events"),
        ("LAG   longest long task while typing (ms)", "lag_longest_long_task_ms"),
    ]
    for label, key in rows:
        vals = []
        for c in cols:
            m = res["viewports"][c]
            vals.append(" / ".join(str(m[k]) for k in key) if isinstance(key, tuple) else str(m[key]))
        yield label, vals


def render_table(res: dict) -> str:
    cols = list(res["viewports"].keys())
    rows = list(render_rows(res))
    w = max(len(k) for k, _ in rows)
    head = f"Orwell player page load and interaction (median of {res['runs']}), cpu throttle {res['cpu_throttle']}x"
    lines = [head, " " * w + "  " + "  ".join(c.rjust(14) for c in cols)]
    lines += [k.ljust(w) + "  " + "  ".join(v.rjust(14) for v in vals) for k, vals in rows]
    return "\n".join(lines)


def render_markdown(res: dict, bad: list) -> str:
    cols = list(res["viewports"].keys())
    md = [f"### Player page load and interaction (median of {res['runs']}, cpu throttle {res['cpu_throttle']}x)", "",
          "| Measure | " + " | ".join(cols) + " |", "|---|" + "---|" * len(cols)]
    md += [f"| {k} | " + " | ".join(vals) + " |" for k, vals in render_rows(res)]
    md.append("")
    md.append("Guard ceilings (ms or count): " + ", ".join(f"{k} {v}" for k, v in CEILINGS.items()))
    if bad:
        md += ["", "**Guard breached:**"] + [f"- {b}" for b in bad]
    return "\n".join(md) + "\n"


def boot_server() -> subprocess.Popen:
    env = dict(os.environ, ORWELL_GAME_BUILD="1", AUTH_ENABLED="false", LOCALHOST_BYPASS="true")
    proc = subprocess.Popen([PY, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(PORT)], cwd=ROOT, env=env,
                            stdout=open(f"/tmp/fe-perf-load-{PORT}.log", "w"), stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{PORT}"
    for _ in range(180):
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-perf-load-{PORT}.log")
        try:
            urllib.request.urlopen(base + "/", timeout=2).read(1)
            return proc
        except Exception:  # noqa: BLE001
            time.sleep(1)
    proc.terminate()
    raise RuntimeError("the front end did not answer in 180 s")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--runs", type=int, default=int(os.environ.get("PERF_LOAD_RUNS", "3")))
    ap.add_argument("--cpu-throttle", type=float, default=float(os.environ.get("PERF_CPU_THROTTLE", "1")))
    ap.add_argument("--observe-ms", type=int, default=6000, help="quiet observation after load, so TTI's 5 s window fits")
    ap.add_argument("--out", default=os.environ.get("PERF_LOAD_OUT", "perf-load.json"))
    ap.add_argument("--label", default=os.environ.get("PERF_LABEL", ""))
    ap.add_argument("--base", default="", help="measure an already running front end instead of booting one")
    ap.add_argument("--enforce", action="store_true", help="exit 3 when a guard ceiling is exceeded")
    args = ap.parse_args()

    proc = None
    try:
        if args.base:
            base = args.base.rstrip("/")
        else:
            proc = boot_server()
            base = f"http://127.0.0.1:{PORT}"
        res = run(base, args.runs, args.cpu_throttle, args.observe_ms)
    except BaseException as e:  # noqa: BLE001
        print(f"[perf-load] harness failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=15)
            except Exception:  # noqa: BLE001
                proc.kill()
    res["label"] = args.label
    res["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    res["git_sha"] = os.environ.get("GITHUB_SHA", "")
    res["ceilings"] = CEILINGS
    bad = ceiling_violations(res)
    print(render_table(res))
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(res, fh, indent=2)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(render_markdown(res, bad))
    for line in bad:
        print(f"[perf-load] GUARD BREACHED: {line}", file=sys.stderr)
    return 3 if (bad and args.enforce) else 0


if __name__ == "__main__":
    sys.exit(main())
