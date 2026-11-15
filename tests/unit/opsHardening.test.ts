import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { AdminVisibleState } from "../../src/ports/GameStateRepository";
import { PLAYER, npc } from "../../src/domain/ids";

/**
 * B58 — ops hardening (audit E4+E5+E6): bounded save retention, a LIVE admin surface, and
 * faults an operator can actually see (stderr + health + a circuit breaker). Roles only.
 */

const tinySnapshot = (n: number): SessionSnapshot => ({
  started: true, week: n, phase: "x", ceremony: { nominees: [], vetoUsed: false },
  house: null, events: [], relationships: [],
});

describe("E4 — bounded save retention (no O(n²) disk)", () => {
  it("a long soak keeps a bounded file count and the LATEST save intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "orwell-prune-"));
    try {
      // ORW-404: the retention policy is pinned in sync mode. In the default background mode nothing is synced inside a synchronous loop,
      // and a user with no synced save keeps every file (up to 200) until one fsync completes (covered in saveNeverSyncedAndShutdown.test.ts).
      const store = new FileSaveStore(dir, { fsyncMode: "sync" });
      for (let i = 1; i <= 500; i++) store.saveFor("soak-user", tinySnapshot(i));
      const userDir = readdirSync(dir)[0]!;
      const files = readdirSync(join(dir, userDir)).filter((f) => /^v\d+\.json$/.test(f));
      // Recent window (5) + retained checkpoints (3): bounded, never one-file-per-mutation.
      expect(files.length).toBeLessThanOrEqual(8);
      // The latest save is intact and is the newest state (the 0007 superset lives in content).
      expect(store.loadLatest("soak-user")?.week).toBe(500);
      // The newest checkpoint survives pruning (the long-tail archive exists).
      expect(files.some((f) => f === "v000500.json" || f === "v000450.json")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PERSIST-11: a checkpoint boundary near `latest` doesn't waste a retained-checkpoint slot", () => {
    // RETAIN_RECENT=5, CHECKPOINT_EVERY=50, RETAIN_CHECKPOINTS=3. At latest=201 the FIRST checkpoint
    // candidate (201 - 201%50 = 200) falls INSIDE the already-kept recent window (197..201) — a
    // redundant hit. Before the fix, that redundant hit still consumed one of the 3 checkpoint
    // slots, leaving only 2 genuinely-older checkpoints (150, 100) instead of the intended 3
    // (150, 100, 50) — the long-tail archive one save shallower than designed.
    const dir = mkdtempSync(join(tmpdir(), "orwell-prune-boundary-"));
    try {
      const store = new FileSaveStore(dir, { fsyncMode: "sync" });
      for (let i = 1; i <= 201; i++) store.saveFor("boundary-user", tinySnapshot(i));
      const userDir = readdirSync(dir)[0]!;
      const files = readdirSync(join(dir, userDir)).filter((f) => /^v\d+\.json$/.test(f));
      const versions = files.map((f) => Number(f.match(/\d+/)![0])).sort((a, b) => a - b);
      // Recent window: 197..201. The genuinely-older checkpoint archive must reach all 3 slots
      // (150, 100, 50) — not stop early at 2 (150, 100) because 200 wastefully double-counted.
      expect(versions).toEqual([50, 100, 150, 197, 198, 199, 200, 201]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("E5 — the admin surface is live, not decorative", () => {
  it("inspect reflects the live week/phase/roster after the game advances", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("admin-live");
    sb.session.createCharacter({ playerName: "The Player", seed: 3 });
    let view = sb.admin.inspect();
    expect(view.week).toBe(1);
    expect(view.houseguests.length).toBe(16); // roles-only roster (player + 15 NPCs)
    expect(view.houseguests.every((h) => ["player", "npc"].includes(h.role))).toBe(true);

    // Drive a few beats; the admin's state tracks the live session, not a stub.
    for (let i = 0; i < 30; i++) {
      const v = sb.session.advanceGame();
      if (v.pending) {
        const p = v.pending;
        if (p.kind === "nominations") sb.session.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
        else if (p.kind === "veto-decision") sb.session.submitDecision({ kind: "veto-decision", use: false });
        else if (p.kind === "comp-intent") sb.session.submitDecision({ kind: "comp-intent", intent: "compete" });
        else if (p.options[0]) sb.session.submitDecision({ kind: p.kind, vote: p.options[0].id, replacement: p.options[0].id } as never);
      }
    }
    view = sb.admin.inspect();
    expect(view.phase).toBe(sb.session.gameStatus().phase);
    expect(view.week).toBe(sb.session.gameStatus().week);
    // Roles only — no name from the generated cast crosses to the admin roster.
    expect(JSON.stringify(view.houseguests)).not.toMatch(/name/i);
  });

  it("manageSandbox reset re-onboards the REAL game (routes to registry.resetUser)", async () => {
    const reg = new GameSessionRegistry();
    const user = "admin-reset";
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 4 });
    expect(reg.sandboxFor(user).session.getGameState().started).toBe(true);

    await sb.mcp.admin.callTool("manageSandbox", { op: "reset" });
    // The registry now serves a FRESH sandbox: the game is back at onboarding.
    expect(reg.sandboxFor(user).session.getGameState().started).toBe(false);
    expect(reg.userCount()).toBe(1);
  });

  it("sandboxHealth is a real admin tool (Vault-free metadata)", async () => {
    const reg = new GameSessionRegistry();
    const user = "admin-health";
    const orch = new Orchestrator(reg, { now: () => 7 }, { seed: 1 });
    reg.setHealthProvider((u) => orch.sandboxHealth(u));
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 5 });
    orch.advance(user, "offscreen-tick");

    const health = (await sb.mcp.admin.callTool("sandboxHealth", {})) as { lastIntegrity: string; circuitOpen: boolean };
    expect(health).toBeTruthy();
    expect(health.lastIntegrity).toBe("ok");
    expect(health.circuitOpen).toBe(false);
    // Vault-free: metadata only — no hidden event content rides along.
    const hidden = sb.engine.events.queryAll().filter((e) => e.hidden).map((e) => e.content);
    const blob = JSON.stringify(health);
    for (const c of hidden) expect(blob.includes(c)).toBe(false);
  });
});

describe("E6 — faults are loud, capped, and breaker-protected", () => {
  /** An apply step that plants a hidden event whose content it ALSO leaks into... nothing —
   *  simplest reliable fault: produce no events at all, tripping the daily-event checkpoint. */
  const faultyApply = (): number => 0;

  it("a faulting sandbox logs to stderr, surfaces in health, and opens the circuit after K", () => {
    const reg = new GameSessionRegistry();
    const user = "faulty";
    const orch = new Orchestrator(reg, { now: () => 1 }, { seed: 2, apply: faultyApply });
    reg.setHealthProvider((u) => orch.sandboxHealth(u));
    reg.sandboxFor(user).session.createCharacter({ playerName: "The Player", seed: 6 });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Three consecutive faults open the circuit…
      for (let i = 0; i < 3; i++) {
        expect(orch.advance(user, "offscreen-tick").integrity).toBe("fault");
      }
      expect(errSpy).toHaveBeenCalled();
      expect(String(errSpy.mock.calls[0]![0])).toMatch(/integrity fault user=faulty .*no-daily-event/);

      const health = orch.sandboxHealth(user) as { circuitOpen: boolean; faults: unknown[] };
      expect(health.circuitOpen).toBe(true);
      expect(health.faults.length).toBeLessThanOrEqual(20); // capped, never unbounded

      // …and further off-screen ticks SKIP the sandbox (no identical blind retry).
      const before = errSpy.mock.calls.length;
      expect(orch.advance(user, "offscreen-tick").integrity).toBe("fault");
      expect(errSpy.mock.calls.length).toBe(before); // skipped — no new apply, no new log
    } finally {
      errSpy.mockRestore();
    }
  });

  it("stored faults are capped at the most recent window", () => {
    const reg = new GameSessionRegistry();
    const user = "fault-cap";
    const orch = new Orchestrator(reg, { now: () => 1 }, { seed: 2, apply: () => 0 });
    reg.sandboxFor(user).session.createCharacter({ playerName: "The Player", seed: 6 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let i = 0; i < 60; i++) orch.advance(user, "player-turn"); // player turns bypass the breaker
      const health = orch.sandboxHealth(user) as { faults: unknown[] };
      expect(health.faults.length).toBeLessThanOrEqual(20);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("the wall holds through the new surfaces", () => {
  it("the live admin mirror and health carry no hidden content", () => {
    const reg = new GameSessionRegistry();
    const user = "admin-wall";
    const orch = new Orchestrator(reg, { now: () => 9 }, { seed: 3 });
    reg.setHealthProvider((u) => orch.sandboxHealth(u));
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 7 });
    const sentinel = "SENTINEL-B58-admin";
    sb.engine.events.record({
      id: "b58:hidden", ts: 9_100_000, type: "conversation",
      initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: sentinel,
    });
    sb.engine.vault.writeHidden({ id: "b58:vault", kind: "confessional", content: sentinel });
    sb.session.advanceGame(); // a persisted mutation re-syncs the admin mirror
    const blob = JSON.stringify(sb.admin.inspect()) + JSON.stringify(sb.admin.health());
    expect(blob).not.toContain(sentinel);
    expect(blob).not.toMatch(/soul|hiddenElement|trust|threat/i); // metadata only — no hidden layer
  });
});
