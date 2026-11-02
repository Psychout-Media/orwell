import { composeRuntime } from "./composition/runtime";
import { startHttpMcp } from "./adapters/mcp/HttpMcpServer";
import { createEmbeddingsStatusTracker } from "./adapters/embedding/embeddingsStatus";

/**
 * target). Brings up the permissioned MCP server over HTTP; the Orwell
 * front-end connects to it via `ORWELL_ENGINE_MCP_URL`. Port comes from the
 * environment (no secrets here) — `ORWELL_ENGINE_PORT` is the documented engine
 * port (8765, per docs/INSTALL.md); `ORWELL_PORT` is kept as a legacy fallback.
 */
// parseInt + trim guards against stray whitespace or inline-comment fragments that some
// systemd EnvironmentFile parsers pass through (a real crash we hit: Number("8765 # ...") → NaN).
function parsePort(raw: string | undefined, fallback: number): number {
  const n = parseInt((raw ?? "").trim(), 10);
  return n > 0 && n < 65536 ? n : fallback;
}
// ORWELL_* are the primary names; BBAI_* are kept as silent deprecated fallbacks so a pre-rename
// .env keeps working.
const port = parsePort(
  process.env["ORWELL_ENGINE_PORT"] ?? process.env["BBAI_ENGINE_PORT"] ??
  process.env["ORWELL_PORT"] ?? process.env["BBAI_PORT"],
  8765,
);
// The live runtime (0031): one long-lived per-user registry (0021) — each authenticated user
// (asserted over the x-orwell-user header) gets an isolated sandbox, recalled from a disk-backed
// save store (0030) so a started game survives an engine restart. The game runs ONLY on the
// player's play-clock (ruling 2026-06-10; real-time purge 2026-07-10): pure turn-driven — the house
// lives between the player's own turns (one bounded off-screen tick per turn) and does NOT exist
// while the player is away. There is NO wall-clock watcher and NO real-world clock: nothing advances
// the game on real time, by design (deleted, not disabled). Data dir from ORWELL_DATA_DIR
// (BBAI_DATA_DIR legacy fallback).
// Semantic recall provider (ADR 0004 / E86a): ORWELL_EMBEDDINGS=fastembed (the deploy
// default — orwell-install.sh writes it and prefetches the pinned model) warms up the real
// local-ONNX provider BEFORE any sandbox exists, committing the whole process to one vector
// space. Any warm-up failure (no model cache + no network, missing native runtime) falls
// back to the deterministic provider for the WHOLE process — recall degrades gracefully,
// the game never breaks, and the next restart may upgrade again. Unset/anything-else keeps
// the deterministic provider (tests, dev).
const embedMode = (process.env["ORWELL_EMBEDDINGS"] ?? "").trim().toLowerCase();
// G1: the embeddings-provider status surfaced on /health (the admin Health & Logs card).
// `provider` is the EFFECTIVE provider right now; `degraded` is true when fastembed was requested
// but the process is (or has fallen) on the deterministic fallback. A STABLE closure over mutable
// state, so the warm-up — which now runs AFTER the server binds (prod incident 2026-06-19), so a
// cold/blocked model can NEVER delay /health — updates what /health reports without re-wiring
// startHttpMcp. The actual warm-up is at the very bottom, after the listen.
//
// PERSIST-5: a boot-time-only snapshot is assigned once, immediately after a successful warm-up, at
// which point the fresh provider's `degraded` is definitionally false (degrade only ever happens on a
// LATER failed `embed()` call, mid-process — a worker crash/timeout, see FastembedEmbedding.degraded).
// A snapshot alone never re-reads that flag, so a mid-process degrade (PERSIST-1's trigger condition)
// was invisible to `/health` forever — an operator would see "fastembed: healthy" even after recall
// had silently fallen back. `createEmbeddingsStatusTracker` (`adapters/embedding/embeddingsStatus.ts`)
// retains the live provider reference so `status()` re-checks its CURRENT `.degraded` flag every call.
const embeddingsTracker = createEmbeddingsStatusTracker();
const embeddingsStatus = embeddingsTracker.status;

// deferResume: bind the HTTP server + warm the embedder FIRST, then resume saved games (at the
// bottom) — so a cold/blocked embedding model can never delay /health, and resumed souls still
// capture the real embedder once it is warm (prod incident 2026-06-19).
const runtime = composeRuntime({ durable: true, deferResume: true });

// Network-edge guardrails (audit E1 / B34). Default to a trusted-loopback single-tenant deploy;
// any of these can be turned on for an exposed / multi-user deployment:
//   ORWELL_ENGINE_HOST      bind address (default 127.0.0.1 — loopback, matching docs/INSTALL.md)
//   ORWELL_ENGINE_TOKEN     shared secret required on every tool route (401 on mismatch)
//   ORWELL_ENGINE_ADMIN_TOKEN  SEPARATE secret demanded on /admin/* (audit E27) — the player
//                           token must not grant God Mode; admin's accepted on player routes
//   ORWELL_ENGINE_MULTIUSER reject a missing x-orwell-user header (400) instead of routing to "default"
const host = process.env["ORWELL_ENGINE_HOST"] ?? process.env["BBAI_ENGINE_HOST"] ?? "127.0.0.1";
const token = process.env["ORWELL_ENGINE_TOKEN"] || process.env["BBAI_ENGINE_TOKEN"] || undefined;
const adminToken = process.env["ORWELL_ENGINE_ADMIN_TOKEN"] || undefined;
const requireUser = /^(1|true|yes|on)$/i.test(process.env["ORWELL_ENGINE_MULTIUSER"] ?? "");
// A user is "known" once they have a live sandbox or a durable save — so an anonymous caller can't
// spray ids to mint unlimited sandboxes (only createCharacter may start a fresh one).
const knownUser = (user: string): boolean => runtime.knownUser(user);

startHttpMcp({ resolve: runtime.registry.resolver() }, port, { token, adminToken, requireUser, knownUser, embeddingsStatus, timeOfDayStatus: runtime.timeOfDayStatus }, host);
// Clean shutdown (no background timers to tear down — the runtime is purely turn-driven).
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => process.exit(0));
}
// eslint-disable-next-line no-console
console.log(`Orwell engine MCP server listening on http://${host}:${port}`);

// Warm up the real embedder AFTER /health is already answering (prod incident 2026-06-19): a cold
// cache or a blocked/slow model CDN can NEVER delay boot now. Bounded by ORWELL_EMBED_WARMUP_MS so
// even a stalled download falls through to the deterministic fallback. Saved games are resumed only
// AFTER this, so they still capture fastembed when it is available; on timeout/failure they resume
// on the deterministic fallback. Skipped entirely unless ORWELL_EMBEDDINGS=fastembed.
if (embedMode === "fastembed") {
  const dataDir = process.env["ORWELL_DATA_DIR"] ?? process.env["BBAI_DATA_DIR"] ?? "./.orwell-data";
  const cacheDir = process.env["ORWELL_EMBED_CACHE"] || `${dataDir.replace(/\/$/, "")}/models`;
  const warmupMs = Number(process.env["ORWELL_EMBED_WARMUP_MS"]) || 45000;
  try {
    const { createFastembedEmbedding } = await import("./adapters/embedding/FastembedEmbedding");
    const provider = await Promise.race([
      createFastembedEmbedding({ workerUrl: new URL("./embedWorker.js", import.meta.url), cacheDir }),
      new Promise<never>((_, reject) => {
        const t = setTimeout(
          () => reject(new Error(`fastembed warm-up exceeded ${warmupMs}ms — staying on deterministic recall`)),
          warmupMs,
        );
        if (typeof t.unref === "function") t.unref();
      }),
    ]);
    const { setRuntimeEmbedding } = await import("./composition/engineRoot");
    setRuntimeEmbedding(provider);
    // PERSIST-5: wire the live provider so `embeddingsStatus` can re-check `.degraded` on every
    // `/health` call — a warm-up-time crash is caught below (a boot-time snapshot is enough there,
    // since it can never recover), but THIS reference is what catches a degrade that happens LATER,
    // mid-process (a worker timeout/crash while the game is already live).
    embeddingsTracker.setLiveProvider(provider);
    embeddingsTracker.setBootState(
      provider.degraded
        ? { provider: "deterministic", degraded: true } // worker died mid-process — permanent for this run
        : { provider: "fastembed", degraded: false },
    );
    // eslint-disable-next-line no-console
    console.log(`[orwell] semantic recall: fastembed (local ONNX, dim=${provider.dim}, cache=${cacheDir})`);
  } catch (e) {
    embeddingsTracker.setBootState({ provider: "deterministic", degraded: true });
    console.error(
      `[orwell] fastembed warm-up failed (${e instanceof Error ? e.message : String(e)}); ` +
        `semantic recall uses deterministic embeddings this run. ` +
        `Prefetch the model (node dist/embedWorker.js --prefetch --cache-dir ${cacheDir}) and restart to upgrade.`,
    );
  }
}
// Resume saved games now — after warm-up — so resumed souls capture the real embedder when warm.
// (Before this, a request for a saved user still works: the resolver builds their sandbox lazily.)
runtime.resumeSaved();
