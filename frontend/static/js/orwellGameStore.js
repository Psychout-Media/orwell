// ORW-165 (slice 1): ONE client game-state store for the shared /api/orwell/{state,status,roster} reads.
// Before this, each panel (HUD, room strip, cast roster, ...) fetched and kept its own copy, so one
// `orwell:gamechanged` wave cost ~23 requests and two panels could paint different answers at the same moment.
// Now consumers call OrwellGame.get(kind) and share ONE fetch + ONE snapshot per freshness window.
//
//   OrwellGame.get(kind, { force })  -> Promise<json>  (rejects Error("HTTP n") on a non-ok answer; failures are never stored)
//   OrwellGame.peek(kind)            -> last good snapshot, or undefined
//   OrwellGame.subscribe(kind, fn)   -> unsubscribe fn; fn(snapshot) runs on every fresh snapshot of that kind
//
// Single-flight: concurrent get()s for a kind join one in-flight request. Freshness: a snapshot is served for
// FRESH_MS. `orwell:gamechanged` is only LISTENED to here (invalidating the window) - the ONE dispatcher stays
// platform.js (g15). `force` skips the freshness window (a catch-up read must see a newer commit) but still joins
// a force-flight started in the last few ms so a burst of forced reads is one request.
(function () {
  "use strict";
  if (typeof window === "undefined" || window.OrwellGame) return;
  var FRESH_MS = 400, FORCE_JOIN_MS = 150;
  var PATHS = { state: "/api/orwell/state", status: "/api/orwell/status", roster: "/api/orwell/roster" };
  var snap = {};      // kind -> { v, t }
  var flight = {};    // kind -> { p, t, force }
  var subs = { state: [], status: [], roster: [] };
  var epoch = 0;      // bumped on invalidate: a flight that started before it never lands as "fresh"

  function invalidate() { epoch++; snap = {}; flight = {}; }  // a flight begun before the change is never joined or stored

  function fetchKind(kind, force) {
    var myEpoch = epoch;
    var p = fetch(PATHS[kind], { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (v) {
      if (epoch === myEpoch) snap[kind] = { v: v, t: Date.now() };
      subs[kind].slice().forEach(function (fn) { try { fn(v); } catch (_) { /* a subscriber never breaks the store */ } });
      return v;
    });
    var f = { p: p, t: Date.now(), force: !!force };
    flight[kind] = f;
    var clear = function () { if (flight[kind] === f) delete flight[kind]; };
    p.then(clear, clear);
    return p;
  }

  function get(kind, opts) {
    if (!PATHS[kind]) return Promise.reject(new Error("unknown game-state kind: " + kind));
    var force = !!(opts && opts.force), now = Date.now();
    var s = snap[kind];
    if (!force && s && now - s.t <= FRESH_MS) return Promise.resolve(s.v);
    var f = flight[kind];
    if (f && (force ? (f.force && now - f.t <= FORCE_JOIN_MS) : true)) return f.p;
    return fetchKind(kind, force);
  }

  function peek(kind) { return snap[kind] ? snap[kind].v : undefined; }

  function subscribe(kind, fn) {
    if (!subs[kind] || typeof fn !== "function") return function () {};
    subs[kind].push(fn);
    return function () { var i = subs[kind].indexOf(fn); if (i >= 0) subs[kind].splice(i, 1); };
  }

  window.OrwellGame = { get: get, peek: peek, subscribe: subscribe, invalidate: invalidate };
  // LISTEN only (g15): the debounced dispatcher lives in platform.js.
  window.addEventListener("orwell:gamechanged", invalidate);
})();
