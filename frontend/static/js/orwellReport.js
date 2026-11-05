// Orwell failure ring, browser side (Lane G11) — the standard sink for fail-open catches.
//
// The house style for user-facing feature failure is fail-OPEN: the panel simply isn't
// there, the chip doesn't render, the portrait stays a placeholder. Correct UX —
// structurally SILENT: every failure renders as absence, and nobody learns anything
// (the image-gen complaint, generalized). This module fixes the silence WITHOUT
// changing the UX: a fail-open catch adds ONE line — OrwellReport.fail(surface,
// errorClass, detail) — and the failure lands in the G1b LIVE ring (POST
// /api/orwell/fe-report → logger.info("[fe-fail] …")), visible on /admin/status.
//
// Contract: throttled client-side (max ~10/min), rate-limited server-side, and it
// NEVER throws — reporting a failure must never become one. Loaded as a plain
// script BEFORE the orwell panels, so window.OrwellReport exists when they run;
// call sites still guard (`window.OrwellReport && …`) in case this file 404s.
(function () {
  "use strict";

  const ENDPOINT = "/api/orwell/fe-report";
  const MAX_PER_MIN = 10; // client-side throttle; the route enforces its own on top
  let stamps = [];        // send timestamps inside the sliding minute

  // Startup-race suppression (G11 follow-up). At boot the HUD polls (status / deals /
  // night / presence) fire BEFORE the engine connection is ready, so the browser throws
  // a network `TypeError: Failed to fetch`. Those are benign startup races, not feature
  // failures — they should not log as noise at INFO. We tag a report as `startup` when it
  // is a network "Failed to fetch" AND we have NOT yet had a confirmed engine contact
  // (latched by markConnected on the first successful poll) AND we are still inside the
  // known boot grace window. The server downgrades a `startup`-tagged report to DEBUG;
  // every genuine post-connect failure still tags nothing and logs at INFO. So real
  // outages stay visible; only the boot races quiet down.
  const BOOT_GRACE_MS = 12000;     // generous boot window for a cold engine connection
  const PAGE_LOADED_AT = Date.now();
  let connected = false;           // flips true on the first confirmed engine contact

  function clip(v, n) {
    try { return String(v == null ? "" : v).slice(0, n); } catch (_) { return ""; }
  }

  // A browser network failure (fetch never reached the server) reads as a TypeError whose
  // message is "Failed to fetch" (Chromium) / "NetworkError when attempting to fetch
  // resource." (Firefox) / "Load failed" (WebKit). Only THESE are the benign startup race;
  // a 500/JSON-shape error is a real failure and must never be quieted.
  function isNetworkFetchError(err) {
    try {
      const name = err && err.name ? String(err.name) : "";
      const msg = err && err.message ? String(err.message) : String(err == null ? "" : err);
      if (name !== "TypeError" && name !== "") return false; // a non-TypeError is a real failure
      return /failed to fetch|networkerror|load failed/i.test(msg);
    } catch (_) { return false; }
  }

  // Latch a confirmed engine contact. Call from any poll's SUCCESS path. Once connected,
  // no later failure is treated as a startup race (a mid-game outage stays at INFO).
  function markConnected() { connected = true; }

  function fail(surface, errorClass, detail, opts) {
    try {
      const now = Date.now();
      stamps = stamps.filter((t) => now - t < 60000);
      if (stamps.length >= MAX_PER_MIN) return;
      stamps.push(now);
      const startup = !connected &&
                      (now - PAGE_LOADED_AT) < BOOT_GRACE_MS &&
                      isNetworkFetchError(detail);
      const body = JSON.stringify({
        surface: clip(surface, 80),
        errorClass: clip(errorClass, 120),
        detail: clip(detail, 300),
        ...(startup ? { startup: true } : {}),
        // A42 (#1599): `opts.red` raises the RED-eligible health event for an ALLOWLISTED surface (the server enforces the allowlist); `opts.corrected` names what auto-corrected it.
        ...(opts && opts.red ? { red: true, corrected: clip(opts.corrected || '', 80) } : {}),
      });
      let sent = false;
      try {
        // sendBeacon survives page unload; a Blob carries the JSON content type.
        if (navigator.sendBeacon) sent = navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
      } catch (_) { sent = false; }
      if (!sent) {
        fetch(ENDPOINT, {
          method: "POST", credentials: "same-origin", keepalive: true,
          headers: { "Content-Type": "application/json" }, body,
        }).catch(() => {});
      }
    } catch (_) { /* never throws — the report is an addition, never new behavior */ }
  }

  window.OrwellReport = { fail, markConnected };
})();
