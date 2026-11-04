import { describe, it, expect, afterEach } from "vitest";
import type { Server, AddressInfo } from "node:net";
import { composeRuntime } from "../../src/composition/runtime";
import type { Runtime } from "../../src/composition/runtime";
import { createHttpMcpServer } from "../../src/adapters/mcp/HttpMcpServer";
import { setRuntimeEmbedding } from "../../src/composition/engineRoot";
import { DeterministicEmbedding } from "../../src/adapters/embedding/DeterministicEmbedding";
import { SoulStore } from "../../src/adapters/engine/SoulStore";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { UserSaveStore } from "../../src/ports/UserSaveStore";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

/**
 * Lane G12 — EVERY soul-write burst breathes, not just creation (G8). The ADR 0004
 * embedding bridge is synchronous per call, so any batched soul write used to pin the
 * Node event loop for the whole batch. G8 moved the (derived) indexing onto a queued,
 * one-embed-per-macrotask drain at the `recordToSoul` seam; G12 makes that lane ONE
 * shared, process-wide lane and proves the two remaining burst classes breathe:
 *
 *   1. the EVICTION-NIGHT burst — vote tally → consequence folds → confessionals →
 *      the per-turn off-screen tick, all recording to souls in one player turn;
 *   2. the RESTORE-TIME index rebuild — an engine restart's boot preload replays a
 *      mid-season arc (`rebuildSoulIndex`) for every saved user.
 *
 * Like creationFreeze (G8), each test drives the REAL production object graph
 * (composeRuntime behind createHttpMcpServer, exactly as main.ts composes it) with a
 * provider that blocks the loop per call the same way the worker bridge does
 * (Atomics.wait), and PROVES /health answers fast (<500ms) while the burst drains.
 * Roles only — no names.
 */


/** Per-call loop budget for the fake slow model: big enough that a back-to-back burst
 *  (≥5 embeds) would blow the health budget pre-fix; small enough that one spaced call
 *  never does. Same calibration as creationFreeze. */
const EMBED_SLEEP_MS = 120;
const HEALTH_BUDGET_MS = 500;

/** A SYNC provider that pins the loop per call like the ADR 0004 bridge — but flip-able,
 *  so a test can play TO the burst fast and make only the burst window expensive. */
function flippableSlowProvider(sleepMs: number): {
  slowCalls: () => number;
  setSlow: (on: boolean) => void;
  embed: (t: string) => number[];
} {
  const inner = new DeterministicEmbedding();
  let slow = false;
  let nSlow = 0;
  return {
    slowCalls: () => nSlow,
    setSlow: (on: boolean) => { slow = on; },
    embed: (text: string): number[] => {
      if (slow) {
        nSlow++;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs); // a blocked loop, like real inference
      }
      return inner.embed(text);
    },
  };
}

/** Continuous /health prober (one probe always in flight) + an event-loop heartbeat —
 *  the same two instruments creationFreeze proved the G8 claim with. */
function startWatch(base: string): {
  stop: () => Promise<void>;
  latencies: number[];
  maxStall: () => number;
} {
  let on = true;
  const latencies: number[] = [];
  let maxStallMs = 0;
  const prober = (async () => {
    while (on) {
      const t0 = performance.now();
      const r = await fetch(`${base}/health`);
      expect(r.status).toBe(200);
      await r.text();
      latencies.push(performance.now() - t0);
    }
  })();
  const heartbeat = (async () => {
    let prev = performance.now();
    while (on) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const now = performance.now();
      maxStallMs = Math.max(maxStallMs, now - prev - 5);
      prev = now;
    }
  })();
  return {
    stop: async () => { on = false; await prober; await heartbeat; },
    latencies,
    maxStall: () => maxStallMs,
  };
}

// ── A minimal never-use-veto auto-player (the UAT's strategy, verbatim semantics) ──

interface NamedRef { id: string; name: string }
interface Pending { kind: string; options: NamedRef[]; appeals?: string[] }
interface Adv {
  started: boolean;
  finished: boolean;
  pending: Pending | null;
  status: { week: number; phase: string };
}

function autoResolve(p: Pending): Record<string, unknown> {
  switch (p.kind) {
    case "nominations": return { kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] };
    case "veto-decision": return { kind: "veto-decision", use: false };
    case "comp-intent": return { kind: "comp-intent", intent: "compete" };
    case "comp-round": return { kind: "comp-round", intent: "compete" }; // 0006 staged-rounds
    case "houseguests-choice": return { kind: "houseguests-choice", vote: p.options[0]!.id };
    case "replacement": return { kind: "replacement", replacement: p.options[0]!.id };
    case "eviction-vote": return { kind: "eviction-vote", vote: p.options[0]!.id };
    case "tie-break": return { kind: "tie-break", vote: p.options[0]!.id };
    case "final-eviction": return { kind: "final-eviction", vote: p.options[0]!.id };
    case "goodbye-message": return { kind: "goodbye-message", vote: p.options[0]!.id, statement: "Take care." };
    case "secret-veto": return { kind: "secret-veto", use: false }; // hold the sealed safety (the one-turn reveal moved the trajectory onto this pending)
    case "finale-statement": return { kind: "finale-statement", statement: "I played my own game." };
    case "finale-answer": return { kind: "finale-answer", appeal: p.appeals?.[0] ?? "own-game" };
    case "juror-question": return { kind: "juror-question", statement: "What was your biggest move?" };
    case "juror-vote": return { kind: "juror-vote", vote: p.options[0]!.id };
    default: return { kind: p.kind };
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the shared soul-index lane is fully drained (cap: the suite must never wedge). */
async function drained(timeoutMs = 60_000): Promise<void> {
  const t0 = Date.now();
  while (SoulStore.pendingTotal() > 0) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`soul-index backlog stuck at ${SoulStore.pendingTotal()}`);
    await sleep(10);
  }
}

/** A minimal in-memory durable store (FORMAT only) — enough for composeRuntime's boot preload. */
function memorySaveStore(): UserSaveStore & { snaps: Map<string, SessionSnapshot> } {
  const snaps = new Map<string, SessionSnapshot>();
  return {
    snaps,
    saveFor: (u, s) => { snaps.set(u, s); },
    hasSave: (u) => snaps.has(u),
    loadLatest: (u) => snaps.get(u) ?? null,
    listUsers: () => [...snaps.keys()],
  };
}

let server: Server | undefined;
let provider: ReturnType<typeof flippableSlowProvider> | undefined;

afterEach(async () => {
  provider?.setSlow(false); // a failed assertion must never wedge the suite on a slow drain
  await drained();
  setRuntimeEmbedding(null); // never leak the slow provider into other suites
  provider = undefined;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function listen(runtime: Runtime): Promise<string> {
  server = createHttpMcpServer({ resolve: runtime.registry.resolver() });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe("G12 — /health answers during every soul-write burst (the G8 breathing, generalized)", () => {
  it("eviction night: the fold+confessional+tick burst drains breathing — every probe answers <500ms", async () => {
    provider = flippableSlowProvider(EMBED_SLEEP_MS);
    setRuntimeEmbedding(provider);
    const runtime = composeRuntime({ clock: new FakeClock() });
    const base = await listen(runtime);
    const user = "g12-eviction";

    const post = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const res = await fetch(`${base}/player/call`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-orwell-user": user },
        body: JSON.stringify({ name, args }),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { result: T }).result;
    };

    await post("createCharacter", { playerName: "The Player", seed: 11 });
    const watch = startWatch(base);

    // Play the REAL weekly loop over HTTP. The moment the eviction-night window opens
    // (the eviction beat / its decision family), the embedding seam turns slow — so the
    // eviction burst (vote tally → folds → confessionals → the per-turn off-screen tick)
    // queues against a provider that pins the loop per call, exactly like live inference.
    const evictionKinds = new Set(["eviction-vote", "tie-break", "goodbye-message", "final-eviction"]);
    let inWindow = false;
    for (let i = 0; i < 300; i++) {
      const adv = await post<Adv>("advanceGame");
      expect(adv.started).toBe(true);
      if (!inWindow && (adv.status.phase === "eviction" || evictionKinds.has(adv.pending?.kind ?? ""))) {
        inWindow = true;
        provider.setSlow(true);
      }
      if (adv.pending && adv.pending.options.length >= (adv.pending.kind === "nominations" ? 2 : 0)) {
        await post<Adv>("submitDecision", autoResolve(adv.pending));
      }
      // Stop once the window has provably pushed MORE slow embeds than the health budget
      // could absorb back-to-back (pre-fix this much work pinned the loop in one block).
      if (inWindow && provider.slowCalls() * EMBED_SLEEP_MS > HEALTH_BUDGET_MS * 1.3) break;
      if (adv.finished) break;
    }
    expect(inWindow).toBe(true);

    // Let any still-queued burst keep draining on the slow seam (probes still flying)…
    for (let i = 0; i < 500 && SoulStore.pendingTotal() > 0
      && provider.slowCalls() * EMBED_SLEEP_MS <= HEALTH_BUDGET_MS * 1.3; i++) {
      await sleep(20);
    }
    provider.setSlow(false); // …then finish the tail fast and settle.
    await drained();
    await watch.stop();

    // The eviction-night burst genuinely crossed the slow sync seam at a scale that
    // would have pinned the loop well past the health budget back-to-back…
    expect(provider.slowCalls()).toBeGreaterThanOrEqual(5);
    expect(provider.slowCalls() * EMBED_SLEEP_MS).toBeGreaterThan(HEALTH_BUDGET_MS);
    expect(watch.latencies.length).toBeGreaterThan(5);
    // …yet every concurrent /health probe answered inside the budget,
    const worst = Math.max(...watch.latencies);
    expect(worst, `worst /health latency ${worst.toFixed(0)}ms (probes: ${watch.latencies.length}, slow embeds: ${provider.slowCalls()})`)
      .toBeLessThan(HEALTH_BUDGET_MS);
    // …and the loop itself NEVER stalled past it (deterministic — no probe-timing race).
    expect(watch.maxStall(), `max event-loop stall ${watch.maxStall().toFixed(0)}ms`).toBeLessThan(HEALTH_BUDGET_MS);
  }, 60_000);

  it("engine restart: the restore-time index rebuild over a mid-season save drains breathing", async () => {
    provider = flippableSlowProvider(EMBED_SLEEP_MS);
    setRuntimeEmbedding(provider);
    const store = memorySaveStore();
    const user = "g12-restore";

    // Season process #1: play a few REAL weeks fast so the durable save carries a deep arc.
    const first = composeRuntime({ clock: new FakeClock(), saveStore: store });
    const resolve = first.registry.resolver();
    const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> =>
      (await resolve("player", user).callTool(name, args)) as T;
    await call("createCharacter", { playerName: "The Player", seed: 5 });
    let week = 0;
    for (let i = 0; i < 400; i++) {
      const adv = await call<Adv>("advanceGame");
      week = adv.status.week;
      if (adv.pending && adv.pending.options.length >= (adv.pending.kind === "nominations" ? 2 : 0)) {
        await call<Adv>("submitDecision", autoResolve(adv.pending));
      }
      if (adv.finished || adv.status.week >= 4) break;
    }
    expect(week).toBeGreaterThanOrEqual(3); // a genuinely mid-season save
    await drained(); // process #1's lane is clear — only the RESTORE flood is measured below

    // The save's arc is big enough that a back-to-back rebuild would blow the budget many times over.
    const house = store.snaps.get(user)!.house!;
    const memTotal = [house.player, ...house.npcs].reduce((n, hg) => n + hg.soul.memory.length, 0);
    expect(memTotal * EMBED_SLEEP_MS).toBeGreaterThan(HEALTH_BUDGET_MS);

    // Engine restart: a fresh runtime over the SAME store, the slow seam live from boot.
    // The boot preload restores every saved user — `rebuildSoulIndex` replays the whole arc.
    provider.setSlow(true);
    const t0 = performance.now();
    const second = composeRuntime({ clock: new FakeClock(), saveStore: store });
    const composeMs = performance.now() - t0;
    // The rebuild QUEUED its embeds instead of running them inline — boot is not pinned…
    expect(SoulStore.pendingTotal()).toBeGreaterThan(0);
    expect(composeMs, `composeRuntime over a mid-season save took ${composeMs.toFixed(0)}ms`)
      .toBeLessThan(HEALTH_BUDGET_MS);

    // …and while the backlog drains on the slow seam, /health answers throughout.
    const base = await listen(second);
    const watch = startWatch(base);
    for (let i = 0; i < 500 && SoulStore.pendingTotal() > 0
      && provider.slowCalls() * EMBED_SLEEP_MS <= HEALTH_BUDGET_MS * 1.3; i++) {
      await sleep(20);
    }
    provider.setSlow(false);
    await drained();
    await watch.stop();

    expect(provider.slowCalls() * EMBED_SLEEP_MS).toBeGreaterThan(HEALTH_BUDGET_MS);
    expect(watch.latencies.length).toBeGreaterThan(5);
    const worst = Math.max(...watch.latencies);
    expect(worst, `worst /health latency ${worst.toFixed(0)}ms (probes: ${watch.latencies.length}, slow embeds: ${provider.slowCalls()})`)
      .toBeLessThan(HEALTH_BUDGET_MS);
    expect(watch.maxStall(), `max event-loop stall ${watch.maxStall().toFixed(0)}ms`).toBeLessThan(HEALTH_BUDGET_MS);

    // The resumed game is whole: the season is where it was, and the re-derived index
    // actually recalls the persisted arc (derived state rebuilt, nothing thinned — 0007/0030).
    const sb = second.registry.sandboxFor(user);
    expect(sb.session.gameStatus().week).toBeGreaterThanOrEqual(3);
    const arced = [house.player, ...house.npcs].find((hg) => hg.soul.memory.length > 0)!;
    expect(sb.engine.soul.recall(arced.id, arced.soul.memory[0]!, 3).length).toBeGreaterThan(0);
  }, 60_000);
});
