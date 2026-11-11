// ORW-143: client-side single-flight + ~1 s TTL for the shared game-state READS.
// ~10 panels (HUD, room strip, cast, presence, night, decision...) each re-fetch /api/orwell/state,
// /status, /roster, /season and /health on every `orwell:gamechanged` and on their own timers, so one
// tab measured ~47 reads/min with bursts of 169 in one second. This wraps window.fetch for those GETs
// ONLY: identical concurrent reads share one network request, and a result is reused for at most
// TTL_MS. Correctness over savings (closed-set truth surface): the cache is dropped on every
// `orwell:gamechanged` (the ONE dispatcher stays platform.js; this only LISTENS) and on any
// non-GET /api/ request, failures are never cached, and callers with an AbortSignal bypass it.
(function () {
  "use strict";
  if (typeof window === "undefined" || typeof window.fetch !== "function" || window.__orwellReadCoalesce) return;
  var TTL_MS = 1000;
  var PATHS = { "/api/orwell/state": 1, "/api/orwell/status": 1, "/api/orwell/roster": 1,
                "/api/orwell/season": 1, "/api/orwell/health": 1 };
  var realFetch = window.fetch.bind(window);
  var cache = {};   // url -> { p: Promise<Response>, t: ms }
  function clear() { cache = {}; }
  function pathOf(u) {
    try { return new URL(u, window.location.href).pathname; } catch (_) { return ""; }
  }
  window.fetch = function (input, init) {
    var isStr = typeof input === "string";
    var u = isStr ? input : ((input && input.url) || "");
    var path = pathOf(u);
    var method = String((init && init.method) || (!isStr && input && input.method) || "GET").toUpperCase();
    if (method !== "GET") {
      if (path.indexOf("/api/") === 0) clear();   // any write invalidates the shared reads
      return realFetch(input, init);
    }
    var hasSignal = (init && init.signal) || (!isStr && input && input.signal);
    if (!PATHS[path] || !isStr || hasSignal || (init && init.cache)) return realFetch(input, init);
    var now = Date.now(), hit = cache[u];
    if (!hit || now - hit.t > TTL_MS) {
      var p = realFetch(input, init);
      hit = cache[u] = { p: p, t: now };
      var mine = hit;
      p.then(function (r) { if (!r || !r.ok) { if (cache[u] === mine) delete cache[u]; } },
             function () { if (cache[u] === mine) delete cache[u]; });
    }
    return hit.p.then(function (r) { return r.clone(); });
  };
  window.__orwellReadCoalesce = { clear: clear, ttlMs: TTL_MS };
  window.addEventListener("orwell:gamechanged", clear);
})();
