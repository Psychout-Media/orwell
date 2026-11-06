#!/usr/bin/env python3
"""ORW-189-lite: the REPORT-ONLY front-end performance job.

Boots the real stack the same way the real-stack browser tests do (built engine bundle + real FE + a scripted
OpenAI-compatible stub as the fake narrator; see tests/test_m0_3_midgen_join.py `_stack`), opens the game page in
headless Chromium with a 4x CPU throttle (CDP `Emulation.setCPUThrottlingRate`) and measures, in one page session:

  1. LOAD     JS / CSS bytes (raw, gzip-6 estimate, and as transferred), request count to first settle.
  2. IDLE     requests per minute on the idle game page (default 60 s) and the largest one-second burst.
  3. STREAM   a scripted ~2,000-character narrator reply streaming in: total long-task time, blocking time,
              main-thread script / layout / style-recalc / task time (CDP Performance.getMetrics), frame
              intervals (rAF), and MutationObserver callbacks + records fired.

It prints a small table, writes JSON (`--out`, default perf-report.json) and appends a markdown table to
$GITHUB_STEP_SUMMARY when set. It never gates: it exits 0 even if a number is bad (gating comes later, in the ratchet).
It exits non-zero only if the harness itself could not run, so a silent dead harness is visible.

Every perf PR quotes its before/after numbers from this script. Run it twice (main vs branch) on the same runner
class; the numbers are for comparison, not absolute truth (the CI runner is not Ryne's VM).

Run:  cd frontend && python3 scripts/perf_report.py [--idle-seconds 60] [--cpu-throttle 4] [--out perf-report.json]
Needs: `npm run build` at the repo root (dist/main.js) and `playwright install chromium`.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # frontend/

# ── in-page probes (installed before any page script runs) ────────────────────────────────────────────────────────
INIT_JS = r"""
(() => {
  const P = window.__perf = { long: [], frames: [], moCb: 0, moRec: 0, moBy: {}, recording: false };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) P.long.push([e.startTime, e.duration]); })
      .observe({ type: 'longtask', buffered: true });
  } catch (e) {}
  const NativeMO = window.MutationObserver;
  window.MutationObserver = class extends NativeMO {
    constructor(cb) {
      let site = 'unknown';
      try {
        for (const l of new Error().stack.split('\n').slice(2)) {
          const m = /\/static\/([^:)\s]+:\d+)/.exec(l);
          if (m) { site = m[1]; break; }
        }
      } catch (e) {}
      super(function (recs, obs) {
        if (P.recording) {
          P.moCb++; P.moRec += recs.length;
          const e = P.moBy[site] || (P.moBy[site] = { cb: 0, rec: 0 });
          e.cb++; e.rec += recs.length;
        }
        return cb.call(this, recs, obs);
      });
    }
  };
  let last = 0;
  const tick = (t) => { if (P.recording && last) P.frames.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})();
"""

SETTLED_JS = """(n) => {
  const a = Array.from(document.querySelectorAll('#chat-history .msg.msg-ai')).filter(e => e.style.display !== 'none');
  const e = a[a.length - 1];
  return a.length > n && !!e.querySelector('.msg-footer button');
}"""
COUNT_AI_JS = """() => Array.from(document.querySelectorAll('#chat-history .msg.msg-ai')).filter(e => e.style.display !== 'none').length"""
REPLY_LEN_JS = """() => {
  const a = Array.from(document.querySelectorAll('#chat-history .msg.msg-ai')).filter(e => e.style.display !== 'none');
  const e = a[a.length - 1]; const b = e && e.querySelector('.body');
  return b ? b.textContent.length : 0;
}"""

_SENTENCES = [
    "The kitchen hums with low voices. ",
    "Someone laughs near the sink. ",
    "A door opens and closes again. ",
    "Footsteps cross the living room. ",
    "The cameras swing toward the couch. ",
    "A quiet argument starts by the fridge. ",
    "Rain taps against the big window. ",
    "Nobody quite looks at the clock. ",
]


def scripted_reply(target_chars: int = 2000) -> list[str]:
    """Narrator-style deltas: one sentence per delta (the game-build scrub buffers to sentence boundaries), a paragraph
    break every fourth sentence, until ~target_chars characters."""
    out: list[str] = []
    total = 0
    i = 0
    while total < target_chars:
        s = _SENTENCES[i % len(_SENTENCES)]
        i += 1
        if i % 4 == 0:
            s = s.rstrip() + "\n\n"
        out.append(s)
        total += len(s)
    return out


def _unwrap_fixture(fx):
    """pytest 8.4+/9 wrap fixtures in a FixtureFunctionDefinition; older versions return the function."""
    for getter in ("_get_wrapped_function",):
        if hasattr(fx, getter):
            return getattr(fx, getter)()
    if hasattr(fx, "__wrapped__"):
        return fx.__wrapped__
    if hasattr(fx, "__pytest_wrapped__"):
        return fx.__pytest_wrapped__.obj
    return fx


def _metrics(cdp) -> dict[str, float]:
    return {m["name"]: m["value"] for m in cdp.send("Performance.getMetrics")["metrics"]}


def _delta(a: dict[str, float], b: dict[str, float], name: str) -> float:
    return round((b.get(name, 0.0) - a.get(name, 0.0)) * 1000.0, 1)  # seconds -> ms


def run(stack: dict, idle_seconds: int, throttle: float, reply_chars: int, low_power: str = "") -> dict:
    from playwright.sync_api import sync_playwright
    import test_m0_3_midgen_join as m03
    from test_p0h_day1_clock_e2e import _session

    sid = _session(stack, "perf-report")
    result: dict = {"cpu_throttle": throttle, "idle_seconds": idle_seconds, "low_power": low_power or "default"}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        page = ctx.new_page()
        page.add_init_script(INIT_JS)
        if low_power in ("0", "1", "auto"):
            # the low-power default (ORW-154/190) is skipped under automation unless opted in; '0' pins glass, '1' pins low-power
            page.add_init_script("try { localStorage.setItem('orwell-low-power', '%s'); } catch (e) {}" % low_power)
        cdp = ctx.new_cdp_session(page)
        cdp.send("Network.enable")
        cdp.send("Performance.enable")
        cdp.send("Emulation.setCPUThrottlingRate", {"rate": throttle})

        req_times: list[float] = []
        phase = {"name": "load"}
        req_log: list[tuple[str, float]] = []
        page.on("request", lambda r: (req_times.append(time.monotonic()), req_log.append((phase["name"], time.monotonic()))))

        types: dict[str, str] = {}
        transferred: dict[str, int] = {"js": 0, "css": 0}
        raw: dict[str, int] = {"js": 0, "css": 0}
        gz: dict[str, int] = {"js": 0, "css": 0}
        files: dict[str, int] = {"js": 0, "css": 0}

        def on_resp_received(p):
            types[p["requestId"]] = p.get("type", "")

        def on_finished(p):
            t = types.get(p["requestId"], "")
            if phase["name"] != "load":
                return
            if t == "Script":
                transferred["js"] += int(p.get("encodedDataLength", 0))
            elif t == "Stylesheet":
                transferred["css"] += int(p.get("encodedDataLength", 0))

        cdp.on("Network.responseReceived", on_resp_received)
        cdp.on("Network.loadingFinished", on_finished)

        def on_response(resp):
            if phase["name"] != "load":
                return
            kind = {"script": "js", "stylesheet": "css"}.get(resp.request.resource_type)
            if not kind:
                return
            try:
                body = resp.body()
            except Exception:  # noqa: BLE001  (redirects / aborted loads have no body)
                return
            files[kind] += 1
            raw[kind] += len(body)
            gz[kind] += len(gzip.compress(body, 6))

        page.on("response", on_response)

        # 1. LOAD ─────────────────────────────────────────────────────────────────────────────────────────────────
        t0 = time.monotonic()
        page.goto(stack["fe"] + "/", wait_until="load")
        page.wait_for_timeout(5000)  # let the module graph, session load and first polls settle
        load_requests = len(req_log)
        result["load"] = {
            "requests": load_requests,
            "js_files": files["js"], "css_files": files["css"],
            "js_raw_bytes": raw["js"], "css_raw_bytes": raw["css"],
            "js_gzip_bytes": gz["js"], "css_gzip_bytes": gz["css"],
            "js_transferred_bytes": transferred["js"], "css_transferred_bytes": transferred["css"],
            "seconds_to_settle": round(time.monotonic() - t0, 1),
        }

        # 2. IDLE ─────────────────────────────────────────────────────────────────────────────────────────────────
        phase["name"] = "idle"
        idle_start = time.monotonic()
        page.wait_for_timeout(int(idle_seconds * 1000))
        idle_end = time.monotonic()
        idle_ts = [t for (ph, t) in req_log if ph == "idle"]
        buckets: dict[int, int] = {}
        for t in idle_ts:
            buckets[int(t - idle_start)] = buckets.get(int(t - idle_start), 0) + 1
        span = max(idle_end - idle_start, 1e-6)
        result["idle"] = {
            "requests": len(idle_ts),
            "requests_per_minute": round(len(idle_ts) * 60.0 / span, 1),
            "max_burst_per_second": max(buckets.values()) if buckets else 0,
        }

        # 3. STREAM ───────────────────────────────────────────────────────────────────────────────────────────────
        phase["name"] = "stream"
        deltas = scripted_reply(reply_chars)
        base_n = page.evaluate(COUNT_AI_JS)
        m03.STUB.script.append({"deltas": deltas, "delay": 0.03})
        page.fill("#message", "Perf report: tell me what the house sounds like.")
        m_before = _metrics(cdp)
        win_start = page.evaluate("() => { window.__perf.recording = true; return performance.now(); }")
        t_stream = time.monotonic()
        page.keyboard.press("Enter")
        settled = True
        try:
            page.wait_for_function(SETTLED_JS, arg=base_n, timeout=180_000, polling=200)
        except Exception as e:  # noqa: BLE001
            settled = False
            print(f"[perf] the scripted reply never settled: {type(e).__name__}", file=sys.stderr)
        page.wait_for_timeout(1500)  # the post-stream reconcile / adopt pass belongs to the cost of a reply
        stream_seconds = time.monotonic() - t_stream
        m_after = _metrics(cdp)
        probe = page.evaluate(
            """(start) => { const P = window.__perf; P.recording = false;
              const long = P.long.filter(([s]) => s >= start).map(([, d]) => d);
              const fr = P.frames.slice();
              fr.sort((a, b) => a - b);
              return { long_count: long.length, long_total: long.reduce((a, b) => a + b, 0),
                blocking: long.reduce((a, b) => a + Math.max(0, b - 50), 0), long_max: long.length ? Math.max(...long) : 0,
                frames: fr.length, frame_p50: fr.length ? fr[Math.floor(fr.length * 0.5)] : 0,
                frame_p95: fr.length ? fr[Math.floor(fr.length * 0.95)] : 0, frame_max: fr.length ? fr[fr.length - 1] : 0,
                frames_over_50ms: fr.filter(x => x > 50).length, mo_callbacks: P.moCb, mo_records: P.moRec, mo_by: P.moBy }; }""",
            win_start,
        )
        reply_len = page.evaluate(REPLY_LEN_JS)
        result["stream"] = {
            "settled": settled,
            "reply_chars_scripted": sum(len(d) for d in deltas),
            "reply_chars_rendered": reply_len,
            "deltas": len(deltas),
            "window_seconds": round(stream_seconds, 1),
            "long_tasks": probe["long_count"],
            "long_task_total_ms": round(probe["long_total"], 1),
            "blocking_time_ms": round(probe["blocking"], 1),
            "long_task_max_ms": round(probe["long_max"], 1),
            "script_ms": _delta(m_before, m_after, "ScriptDuration"),
            "layout_ms": _delta(m_before, m_after, "LayoutDuration"),
            "style_recalc_ms": _delta(m_before, m_after, "RecalcStyleDuration"),
            "task_ms": _delta(m_before, m_after, "TaskDuration"),
            "frames": probe["frames"],
            "frame_p50_ms": round(probe["frame_p50"], 1),
            "frame_p95_ms": round(probe["frame_p95"], 1),
            "frames_over_50ms": probe["frames_over_50ms"],
            "mutation_observer_callbacks": probe["mo_callbacks"],
            "mutation_observer_records": probe["mo_records"],
            "mutation_observers_by_site": dict(sorted(probe["mo_by"].items(), key=lambda kv: -kv[1]["cb"])[:12]),
        }
        browser.close()
    result["session"] = sid
    return result


def _rows(res: dict) -> list[tuple[str, str]]:
    l, i, s = res["load"], res["idle"], res["stream"]
    kb = lambda n: f"{n / 1024:,.0f} KB"  # noqa: E731
    rows = [
        ("LOAD  JS transferred / gzip-6 / raw", f"{kb(l['js_transferred_bytes'])} / {kb(l['js_gzip_bytes'])} / {kb(l['js_raw_bytes'])} ({l['js_files']} files)"),
        ("LOAD  CSS transferred / gzip-6 / raw", f"{kb(l['css_transferred_bytes'])} / {kb(l['css_gzip_bytes'])} / {kb(l['css_raw_bytes'])} ({l['css_files']} files)"),
        ("LOAD  requests to settle", str(l["requests"])),
        (f"IDLE  requests in {res['idle_seconds']} s", f"{i['requests']}  ({i['requests_per_minute']}/min)"),
        ("IDLE  largest 1-second burst", str(i["max_burst_per_second"])),
        (f"STREAM reply ({s['reply_chars_rendered']}/{s['reply_chars_scripted']} chars, {s['deltas']} deltas)", "settled" if s["settled"] else "DID NOT SETTLE"),
        ("STREAM long tasks (count / total / blocking / max)", f"{s['long_tasks']} / {s['long_task_total_ms']} ms / {s['blocking_time_ms']} ms / {s['long_task_max_ms']} ms"),
        ("STREAM main-thread script", f"{s['script_ms']} ms"),
        ("STREAM main-thread layout + style recalc", f"{s['layout_ms']} + {s['style_recalc_ms']} ms"),
        ("STREAM main-thread task total", f"{s['task_ms']} ms"),
        ("STREAM frames (n / p50 / p95 / >50ms)", f"{s['frames']} / {s['frame_p50_ms']} / {s['frame_p95_ms']} ms / {s['frames_over_50ms']}"),
        ("STREAM MutationObserver native wake-ups / records (a frame-batched observer still wakes, but defers its work)", f"{s['mutation_observer_callbacks']} / {s['mutation_observer_records']}"),
    ]
    for site, v in (s.get("mutation_observers_by_site") or {}).items():
        rows.append((f"  observer {site}", f"{v['cb']} callbacks / {v['rec']} records"))
    return rows


def render_table(res: dict) -> str:
    rows = _rows(res)
    w = max(len(k) for k, _ in rows)
    head = f"Orwell front-end performance (report-only), {res['cpu_throttle']}x CPU throttle, low-power={res.get('low_power', 'default')}"
    return head + "\n" + "\n".join(f"{k.ljust(w)}  {v}" for k, v in rows)


def render_markdown(res: dict) -> str:
    lines = [f"### Front-end performance (report-only, {res['cpu_throttle']}x CPU throttle, low-power={res.get('low_power', 'default')})", "", "| Measure | Value |", "|---|---|"]
    lines += [f"| {k} | {v} |" for k, v in _rows(res)]
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--idle-seconds", type=int, default=int(os.environ.get("PERF_IDLE_SECONDS", "60")))
    ap.add_argument("--cpu-throttle", type=float, default=float(os.environ.get("PERF_CPU_THROTTLE", "4")))
    ap.add_argument("--reply-chars", type=int, default=2000)
    ap.add_argument("--out", default=os.environ.get("PERF_OUT", "perf-report.json"))
    ap.add_argument("--low-power", default=os.environ.get("PERF_LOW_POWER", ""), choices=["", "0", "1", "auto"],
                    help="pin the low-power mode (ORW-154/190): 1 = reduced effects, 0 = glass, auto = detect, '' = leave the app default")
    ap.add_argument("--label", default=os.environ.get("PERF_LABEL", ""))
    args = ap.parse_args()

    sys.path.insert(0, ROOT)
    sys.path.insert(0, os.path.join(ROOT, "tests"))
    import test_m0_3_midgen_join as m03

    fn = _unwrap_fixture(m03._stack)
    gen = fn()
    try:
        stack = next(gen)
    except BaseException as e:  # noqa: BLE001  (pytest.skip raises Skipped, a BaseException)
        print(f"[perf] could not boot the stack: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    try:
        res = run(stack, args.idle_seconds, args.cpu_throttle, args.reply_chars, args.low_power)
    finally:
        gen.close()  # the fixture's teardown: restore settings, stop engine + FE + stub
    res["label"] = args.label
    res["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    res["git_sha"] = os.environ.get("GITHUB_SHA", "")

    table = render_table(res)
    print(table)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(res, fh, indent=2)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(render_markdown(res))
    return 0


if __name__ == "__main__":
    sys.exit(main())
