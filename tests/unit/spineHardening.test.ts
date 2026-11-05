import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import type { HealthRecord, Trigger } from "../../src/composition/orchestrator";
import type { UserSandbox } from "../../src/composition/registry";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PersistFailureError } from "../../src/domain/errors";
import type { UserSaveStore } from "../../src/ports/UserSaveStore";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import { PLAYER, npc } from "../../src/domain/ids";

/**
 * Audit E2 / E3 / E6 / E7 / E57(R5) / R3 / R4 — the commit/persist spine hardened. Roles only.
 */
const freshDir = (): string => mkdtempSync(join(tmpdir(), "orwell-spine-"));

describe("E2 — the pre-game interview fabricates NO hidden history", () => {
  it("casting-intake commits run zero off-screen ticks: no events, no Vault confessionals", async () => {
    const runtime = composeRuntime({ clock: new FakeClock() }); // pure turn-driven
    const user = "intake";
    const mcp = runtime.registry.resolver()("player", user);

    await mcp.callTool("updateCasting", { playerName: "The Player" });
    await mcp.callTool("updateCasting", { backstory: "an answer recorded mid-interview" });

    const sb = runtime.registry.sandboxFor(user);
    // The old synthetic npc pool fabricated hidden scenes + confessionals BEFORE the season existed
    // (later humanized into the real cast's names — scheming dated before move-in).
    expect(sb.engine.events.queryAll().length).toBe(0);
    expect(sb.engine.vault.readHidden().length).toBe(0);
  });
});

describe("E57/R5 — one bounded off-screen tick per player TURN, not per tool call", () => {
  function tickCounter() {
    const clock = new FakeClock();
    const reg = new GameSessionRegistry();
    let ticks = 0;
    const apply = (sandbox: UserSandbox, trigger: Trigger, _rng: unknown, clockNow: number): number => {
      if (trigger !== "offscreen-tick") return 0;
      ticks++;
      sandbox.engine.events.record({
        id: `tick:${ticks}`, ts: clockNow, type: "conversation",
        initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: `offscreen stretch ${ticks}`,
      });
      return 1;
    };
    const orch = new Orchestrator(reg, clock, { seed: 5, turnDriven: true, apply });
    reg.setCommit((u) => orch.commitPlayerTurn(u));
    reg.setOnReset((u) => orch.forgetUser(u));
    return { clock, reg, orch, count: () => ticks };
  }

  it("recordInteraction + diaryRoom + advanceGame in one turn ⇒ exactly one off-screen tick", () => {
    const { reg, count } = tickCounter();
    const sb = reg.sandboxFor("turn");
    sb.session.createCharacter({ playerName: "The Player", seed: 4 });
    const beforeChampagneClose = count();
    sb.session.advanceGame(); // 0111: close the premiere champagne circle (a pure close earns NO tick)
    // The pure champagne close is a zero-tick commit (isPureChampagneClose): it resolves no beat, so it must
    // NOT advance the off-screen society — assert it added nothing on top of the game-start move-in tick.
    expect(count()).toBe(beforeChampagneClose);
    const afterCreate = count();

    // The measured R5 amplification: a 4-tool-call turn used to run 4 ticks (12 hidden scenes).
    sb.commands.recordInteraction({
      initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a kitchen chat", kind: "bonding",
    });
    sb.commands.diaryRoom({ entry: "private read on the week" });
    sb.session.advanceGame(); // the turn's explicit progressing act (the first HOH beat) — the ONE tick anchor

    expect(count() - afterCreate).toBe(1);
  });

  it("beat commits always earn their tick; auxiliary commits tick again only after the debounce window", () => {
    const { clock, reg, count } = tickCounter();
    const sb = reg.sandboxFor("debounce");
    sb.session.createCharacter({ playerName: "The Player", seed: 4 });
    // A11: a chat during the gathered champagne circle is now a REAL witnessed record (the witness grounding reads the same whole-house overlay the player sees), so it is a normal first
    // turn that earns its own tick. Close the circle first (a pure close earns no tick) so this test measures what it is about: debounce between two ordinary social turns.
    sb.session.advanceGame();

    const before = count();
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "chat a", kind: "bonding" });
    expect(count()).toBe(before); // same turn — debounced

    clock.advance(60_000); // a NEW player turn, minutes later
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "chat b", kind: "bonding" });
    expect(count()).toBe(before + 1); // the lingering turn still gets its house life
  });
});

describe("E7 — persist failures are their own fault class, fail-closed, sanitized", () => {
  class FlakyStore implements UserSaveStore {
    failing = false;
    saves = new Map<string, SessionSnapshot>();
    saveFor(user: string, snapshot: SessionSnapshot): void {
      if (this.failing) throw new Error("ENOSPC: no space left on device, write '/var/lib/orwell/.orwell-data/x'");
      this.saves.set(user, snapshot);
    }
    hasSave(user: string): boolean { return this.saves.has(user); }
    loadLatest(user: string): SessionSnapshot | null { return this.saves.get(user) ?? null; }
  }

  it("a failing save rolls the turn back, records a persist-failure fault, and throws typed", () => {
    const store = new FlakyStore();
    const reg = new GameSessionRegistry(store);
    const orch = new Orchestrator(reg, new FakeClock(), { seed: 2 });
    reg.setCommit((u) => orch.commitPlayerTurn(u));
    const user = "disk-full";
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 2 });
    const eventsBefore = reg.sandboxFor(user).engine.events.queryAll().length;

    store.failing = true;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let thrown: unknown;
      try {
        sb.commands.recordInteraction({
          initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a doomed chat", kind: "bonding",
        });
      } catch (e) { thrown = e; }
      // Typed — never a plain Error the HTTP edge would misread as the CALLER's fault (400)…
      expect(thrown).toBeInstanceOf(PersistFailureError);
      // …and sanitized: no data-dir path leaks in the message.
      expect((thrown as Error).message).not.toMatch(/orwell-data|\/var\//);
      // Fail-closed: the unsaved turn was rolled back, not silently kept (fail-open).
      expect(reg.sandboxFor(user).engine.events.queryAll().length).toBe(eventsBefore);
      const health = orch.sandboxHealth(user) as HealthRecord;
      expect(health.lastIntegrity).toBe("fault");
      expect(health.faults.some((f) => f.kind === "persist-failure")).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("E6 — boot preload seeds the non-degradation baseline (no checkpoint-blind first commit)", () => {
  it("a resumed sandbox that drops persisted detail faults on its FIRST commit", () => {
    const dir = freshDir();
    const user = "resume";
    {
      const r1 = composeRuntime({ saveStore: new FileSaveStore(dir), clock: new FakeClock() });
      r1.registry.sandboxFor(user).session.createCharacter({ playerName: "The Player", seed: 7 });
      r1.registry.sandboxFor(user).session.advanceGame();
    }
    // Engine restart: the boot preload resumes the save AND seeds the baseline from it.
    const r2 = composeRuntime({ saveStore: new FileSaveStore(dir), clock: new FakeClock() });
    const snap = r2.registry.snapshot(user);
    expect(snap.events.length).toBeGreaterThan(0);

    // Swap in a DEGRADED resume (dropped events) — the first commit must fault, not be accepted blind.
    const degraded = { ...snap, events: snap.events.slice(0, 1) };
    r2.registry.restore(user, degraded);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => r2.orchestrator.commitPlayerTurn(user)).toThrowError(/turn refused/);
      expect((r2.orchestrator.sandboxHealth(user) as HealthRecord).faults.some((f) => f.kind === "degradation")).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("R3 — the exported snapshot is reused across checkpoint/save/tick", () => {
  it("one beat commit serializes the full snapshot at most twice (commit + tick), and the save reuses it", () => {
    const store = new FileSaveStore(freshDir());
    const reg = new GameSessionRegistry(store);
    const orch = new Orchestrator(reg, new FakeClock(), { seed: 3, turnDriven: true });
    reg.setCommit((u) => orch.commitPlayerTurn(u));
    const sb = reg.sandboxFor("perf");
    sb.session.createCharacter({ playerName: "The Player", seed: 3 });

    const exportSpy = vi.spyOn(reg, "snapshot");
    const saveSpy = vi.spyOn(store, "saveFor");
    sb.session.advanceGame(); // one beat commit + its one turn-driven tick

    // The audited behavior was ~4 full O(events) serializations per mutation (R3's 20× curve).
    expect(exportSpy.mock.calls.length).toBeLessThanOrEqual(2);
    // The persisted snapshot IS the exported candidate — by reference, never re-serialized.
    expect(saveSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of saveSpy.mock.calls) {
      expect(exportSpy.mock.results.some((r) => r.value === call[1])).toBe(true);
    }
  });
});

describe("R4 — idle sandboxes unload (LRU) and provably rebuild from disk", () => {
  it("beyond maxResident the least-recently-used sandbox is saved, dropped, and resumes intact", () => {
    const store = new FileSaveStore(freshDir());
    const reg = new GameSessionRegistry(store, { maxResident: 2 });
    reg.sandboxFor("u1").session.createCharacter({ playerName: "The Player", seed: 1 });
    const u1Events = reg.sandboxFor("u1").session.advanceGame() && reg.sandboxFor("u1").engine.events.queryAll().length;
    reg.sandboxFor("u2").session.createCharacter({ playerName: "The Player", seed: 2 });
    reg.sandboxFor("u3").session.createCharacter({ playerName: "The Player", seed: 3 });

    expect(reg.userCount()).toBeLessThanOrEqual(2);
    expect(reg.usernames()).not.toContain("u1"); // the LRU one unloaded

    // The unloaded game RESUMES from its durable save — nothing was lost.
    const resumed = reg.sandboxFor("u1");
    expect(resumed.session.getGameState().started).toBe(true);
    expect(resumed.session.snapshot().seed).toBe(1);
    expect(resumed.engine.events.queryAll().length).toBe(u1Events);
  });

  it("without a durable store nothing unloads (an in-memory game has no disk to come back from)", () => {
    const reg = new GameSessionRegistry(undefined, { maxResident: 1 });
    reg.sandboxFor("a").session.createCharacter({ playerName: "The Player", seed: 1 });
    reg.sandboxFor("b").session.createCharacter({ playerName: "The Player", seed: 2 });
    expect(reg.userCount()).toBe(2); // both stay resident
  });
});
