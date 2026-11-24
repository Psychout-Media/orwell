import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { HealthRecord } from "../../src/composition/orchestrator";
import type { AdvanceView, GameStateView } from "../../src/ports/GameSession";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * Audit E1 + D1 + R1 — the ONE sanctioned restart door. The headline production bug: the FE's
 * reset path restarts via the player channel's `createCharacter` + `confirmRestart`, which used to
 * restart the SESSION in place while the orchestrator kept the dead season's non-degradation
 * baseline and the save store kept appending to the dead season's history — so every season-2
 * commit faulted as a "degradation", nothing persisted, and the dead season resurrected on engine
 * restart. Both restart surfaces must now converge on `registry.resetUser`: orchestrator baseline
 * forgotten, saves rotated, a clean sandbox. HARD rule: roles only — no fixture names.
 */
/** ORW-783: the dead seasons a restart moved into this user's archive folder. */
const archivedSeasons = (dirOf: string, u: string): string[] => { const p = join(dirOf, "save-archive", Buffer.from(u, "utf8").toString("hex")); return existsSync(p) ? readdirSync(p) : []; };
const freshDir = (): string => mkdtempSync(join(tmpdir(), "orwell-e1-"));

function resolveLegally(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.options[0]) s.submitDecision({ kind: p.kind, vote: p.options[0].id, replacement: p.options[0].id } as never);
}

/** Drive the live loop a few beats so season 1 accumulates real persisted detail. */
function playBeats(s: GameSessionAdapter, beats: number): void {
  for (let i = 0; i < beats; i++) {
    const v = s.advanceGame();
    if (v.pending) resolveLegally(s, v.pending);
    if (v.finished) break;
  }
}

describe("E1/D1/R1 — the one sanctioned restart door (player channel → registry.resetUser)", () => {
  it("a confirmed player-channel restart resets the orchestrator baseline: season 2 commits clean", async () => {
    const dir = freshDir();
    const runtime = composeRuntime({ saveStore: new FileSaveStore(dir), clock: new FakeClock() });
    const user = "restart-door";
    const mcp = runtime.registry.resolver()("player", user);

    await mcp.callTool("createCharacter", { playerName: "The Player", seed: 11 });
    playBeats(runtime.registry.sandboxFor(user).session, 8); // season 1 accrues real history
    const season1Events = runtime.registry.sandboxFor(user).engine.events.queryAll().length;
    expect(season1Events).toBeGreaterThan(4);

    // The FE's reset path: createCharacter + confirmRestart on the PLAYER channel (D1/R1 step 1).
    const view = (await mcp.callTool("createCharacter", {
      playerName: "The Player", seed: 22, confirmRestart: true,
    })) as GameStateView;
    expect(view.started).toBe(true);

    // The registry now serves a CLEAN season-2 sandbox — not the old one restarted in place.
    const fresh = runtime.registry.sandboxFor(user);
    expect(fresh.session.snapshot().seed).toBe(22);
    expect(fresh.engine.events.queryAll().length).toBeLessThan(season1Events);

    // THE BUG: every post-restart commit used to fault as a count regression vs. the dead season.
    playBeats(fresh.session, 4); // would throw TurnRefusedError before the fix
    const health = runtime.orchestrator.sandboxHealth(user) as HealthRecord;
    expect(health.lastIntegrity).toBe("ok");
    expect(health.circuitOpen).toBe(false);
    expect(health.faults).toEqual([]);
  });

  it("the restart rotates the dead season's saves off the live path (R1: no zombie resurrection)", async () => {
    const dir = freshDir();
    const store = new FileSaveStore(dir);
    const runtime = composeRuntime({ saveStore: store, clock: new FakeClock() });
    const user = "rotate";
    const mcp = runtime.registry.resolver()("player", user);

    await mcp.callTool("createCharacter", { playerName: "The Player", seed: 5 });
    playBeats(runtime.registry.sandboxFor(user).session, 6);

    await mcp.callTool("createCharacter", { playerName: "The Player", seed: 6, confirmRestart: true });

    // The latest durable save IS season 2 (the old behavior kept season 1 as the latest save)…
    expect(store.loadLatest(user)?.seed).toBe(6);
    // …and the dead season was ROTATED (kept for inspection), never silently destroyed.
    expect(archivedSeasons(dir, user)).toHaveLength(1); // ORW-783: in the user's dated archive (save-archive/<hex-user>/<stamp>), not beside the live dirs
    expect(readdirSync(dir).some((d) => d.includes(".retired-"))).toBe(false);
  });

  it("without confirmRestart a second createCharacter stays a no-op (B36 intact)", async () => {
    const runtime = composeRuntime({ clock: new FakeClock() });
    const user = "noop";
    const mcp = runtime.registry.resolver()("player", user);
    await mcp.callTool("createCharacter", { playerName: "The Player", seed: 3 });
    const before = JSON.stringify(runtime.registry.sandboxFor(user).session.snapshot());

    const again = (await mcp.callTool("createCharacter", { playerName: "Imposter", seed: 999 })) as GameStateView;
    expect(again.started).toBe(true);
    expect(JSON.stringify(runtime.registry.sandboxFor(user).session.snapshot())).toBe(before);
  });

  it("the admin door (manageSandbox reset) goes through the SAME hinge — baseline forgotten too", async () => {
    const dir = freshDir();
    const store = new FileSaveStore(dir);
    const runtime = composeRuntime({ saveStore: store, clock: new FakeClock() });
    const user = "admin-door";
    const sb = runtime.registry.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 9 });
    playBeats(sb.session, 6);

    await sb.mcp.admin.callTool("manageSandbox", { op: "reset" });
    expect(archivedSeasons(dir, user)).toHaveLength(1); // saves rotated into the user's dated archive (ORW-783)

    // Season 2 starts and commits clean against a forgotten baseline.
    const fresh = runtime.registry.sandboxFor(user);
    fresh.session.createCharacter({ playerName: "The Player", seed: 10 });
    playBeats(fresh.session, 4);
    expect((runtime.orchestrator.sandboxHealth(user) as HealthRecord).lastIntegrity).toBe("ok");
    expect(store.loadLatest(user)?.seed).toBe(10);
  });

  it("a stale pre-restart tool reference still lands in the fresh sandbox (no split-brain)", async () => {
    const runtime = composeRuntime({ clock: new FakeClock() });
    const user = "stale-ref";
    const staleMcp = runtime.registry.resolver()("player", user); // resolved BEFORE the restart
    await staleMcp.callTool("createCharacter", { playerName: "The Player", seed: 1 });
    playBeats(runtime.registry.sandboxFor(user).session, 4);

    // The restart through the STALE reference must still produce the registry's fresh sandbox.
    const view = (await staleMcp.callTool("createCharacter", {
      playerName: "The Player", seed: 2, confirmRestart: true,
    })) as GameStateView;
    expect(view.started).toBe(true);
    expect(runtime.registry.sandboxFor(user).session.snapshot().seed).toBe(2);
  });
});
