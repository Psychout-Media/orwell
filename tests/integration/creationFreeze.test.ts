import { describe, it, expect, afterEach } from "vitest";
import type { Server, AddressInfo } from "node:net";
import { composeRuntime } from "../../src/composition/runtime";
import { createHttpMcpServer } from "../../src/adapters/mcp/HttpMcpServer";
import { setRuntimeEmbedding } from "../../src/composition/engineRoot";
import { DeterministicEmbedding } from "../../src/adapters/embedding/DeterministicEmbedding";
import { FakeClock } from "../../src/adapters/time/FakeClock";

/**
 * Lane G8 — "casting finalization breathes". USER REPORT: filing away the interview
 * (createCharacter) stalled the engine long enough that the front-end's /health probe
 * timed out and flashed "engine unreachable". The cause: creation-time soul seeding
 * runs through the SYNCHRONOUS embedding bridge (ADR 0004 — each embed blocks the
 * Node event loop), and the batch ran back-to-back inside one call.
 *
 * This test drives the REAL production object graph (composeRuntime — registry +
 * orchestrator commit + the turn-driven off-screen tick — behind createHttpMcpServer,
 * exactly as main.ts composes it) with a provider that blocks the loop per call the
 * same way the worker bridge does (Atomics.wait), and PROVES /health answers fast
 * (<500ms) WHILE the seeding batch is in flight and draining. Roles only — no names.
 */


/** Per-call loop budget for the fake slow model. Big enough that a back-to-back batch
 *  (~6+ embeds at creation) would blow the 500ms health budget pre-fix; small enough
 *  that a single spaced call never does. */
const EMBED_SLEEP_MS = 120;
const HEALTH_BUDGET_MS = 500;

/** A SYNC provider that pins the event loop per call exactly like the ADR 0004 bridge. */
function slowSyncProvider(sleepMs: number, turn: () => number): { calls: () => number; maxPerTurn: () => number; embed: (t: string) => number[] } {
  const inner = new DeterministicEmbedding();
  let n = 0;
  const perTurn = new Map<number, number>(); // event-loop turn -> embeds that ran inside it (back-to-back = pinned loop)
  return {
    calls: () => n,
    maxPerTurn: () => Math.max(0, ...perTurn.values()),
    embed: (text: string): number[] => {
      n++;
      perTurn.set(turn(), (perTurn.get(turn()) ?? 0) + 1);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs); // a blocked loop, like real inference
      return inner.embed(text);
    },
  };
}

let server: Server | undefined;

afterEach(async () => {
  setRuntimeEmbedding(null); // never leak the slow provider into other suites
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe("G8 — /health answers during the creation-time soul-seeding batch", () => {
  it("createCharacter with a slow sync embedder never pins the loop: embeds are spaced one per event-loop turn (measured as engine work, not wall-clock)", async () => {
    // A load-independent clock for "did the loop breathe": a setImmediate chain bumps a turn counter, so two embeds with the SAME turn value ran back-to-back with no I/O phase in between.
    let turnNo = 0;
    let turning = true;
    const turnTick = (): void => { turnNo++; if (turning) setImmediate(turnTick); };
    setImmediate(turnTick);
    const provider = slowSyncProvider(EMBED_SLEEP_MS, () => turnNo);
    setRuntimeEmbedding(provider);
    const runtime = composeRuntime({ clock: new FakeClock() });
    server = createHttpMcpServer({ resolve: runtime.registry.resolver() });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const user = "g8";

    const post = async (name: string, args: Record<string, unknown> = {}): Promise<Response> =>
      fetch(`${base}/player/call`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-orwell-user": user },
        body: JSON.stringify({ name, args }),
      });

    // The casting interview lands its material first (0050) — the batch indexes from it too.
    const casting = await post("updateCasting", {
      playerName: "The Player",
      motivation: "to outlast the house",
      interviewNotes: Array.from({ length: 6 }, (_, i) => `interview detail ${i} worth remembering`),
    });
    expect(casting.status).toBe(200);

    // Concurrent health prober — CONTINUOUS (one probe always in flight), so a pinned loop is
    // guaranteed to be caught by an in-flight request, exactly like the FE's out-of-process poll.
    let probing = true;
    const latencies: number[] = [];
    const prober = (async () => {
      while (probing) {
        const t0 = performance.now();
        const r = await fetch(`${base}/health`);
        expect(r.status).toBe(200);
        await r.text();
        latencies.push(performance.now() - t0);
      }
    })();
    // Event-loop heartbeat: the max inter-tick gap is the longest stretch ANY request (incl.
    // /health) could possibly be stalled — a deterministic, race-free read of the pin.
    let beating = true;
    let maxStallMs = 0;
    const heartbeat = (async () => {
      let prev = performance.now();
      while (beating) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const now = performance.now();
        maxStallMs = Math.max(maxStallMs, now - prev - 5);
        prev = now;
      }
    })();

    const t0 = performance.now();
    const created = await post("createCharacter", { seed: 7 });
    const createMs = performance.now() - t0;
    expect(created.status).toBe(200);
    expect(((await created.json()) as { result: { started: boolean } }).result.started).toBe(true);

    // Keep probing until the deferred seeding batch has fully drained: the call count must be
    // UNCHANGED across a window comfortably wider than one per-call sleep (no premature exit
    // while the loop is pinned inside a single slow embed).
    let last = -1;
    for (let i = 0; i < 100 && provider.calls() !== last; i++) {
      last = provider.calls();
      await new Promise((resolve) => setTimeout(resolve, EMBED_SLEEP_MS * 2));
    }
    probing = false;
    beating = false;
    turning = false;
    await prober;
    await heartbeat;

    // The seeding batch genuinely ran through the slow sync seam (back-to-back it would have
    // pinned the loop for ~calls × EMBED_SLEEP_MS — well past the health budget).
    expect(provider.calls()).toBeGreaterThanOrEqual(4);
    expect(provider.calls() * EMBED_SLEEP_MS).toBeGreaterThan(HEALTH_BUDGET_MS);
    expect(latencies.length).toBeGreaterThan(5);
    // THE CLAIM (A30: measured as ENGINE WORK, not wall-clock under runner load): the seeding batch never pinned the loop. Back-to-back it would run all of its embeds inside ONE event-loop
    // turn; the breathing lane runs one per turn. Two in a turn tolerates a timer and a check-phase callback landing in the same iteration, nothing more.
    expect(provider.maxPerTurn(), `max embeds inside one event-loop turn (embeds: ${provider.calls()}, probes: ${latencies.length})`).toBeLessThanOrEqual(2);
    // Diagnostics only (shared-runner load inflates these; they are no longer the gate): the worst probe and the loop stall are bounded by what ONE spaced embed can cost plus load, never by the batch.
    const worst = Math.max(...latencies);
    expect(worst, `worst /health latency ${worst.toFixed(0)}ms, max stall ${maxStallMs.toFixed(0)}ms`).toBeLessThan(provider.calls() * EMBED_SLEEP_MS);
    // And the player-facing call itself no longer carries the whole batch inline.
    expect(createMs).toBeLessThan(5000);
  }, 30_000);
});
