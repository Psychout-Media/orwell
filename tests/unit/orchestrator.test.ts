import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { PLAYER, npc } from "../../src/domain/ids";

const freshDir = (): string => mkdtempSync(join(tmpdir(), "orwell-0031-"));
const U = "user-a";

function hidden(sb: UserSandbox): string[] {
  return sb.engine.events.queryAll().filter((e) => e.hidden).map((e) => e.content);
}
function playerSweep(sb: UserSandbox): string {
  const p = sb.player;
  return [p.produce("player-visible log"), p.produce("scene narration"), JSON.stringify(p.getVisibleState())].join("\n");
}

describe("0031 — game orchestrator & integrity checkpoint", () => {
  it("a turn-driven advance runs off-screen life and passes the integrity checkpoint", () => {
    const dir = freshDir();
    const registry = new GameSessionRegistry(new FileSaveStore(dir));
    const orch = new Orchestrator(registry, new FakeClock(), { seed: 7 });
    registry.sandboxFor(U).session.createCharacter({ playerName: "Player One", seed: 7 });
    const savedBefore = new FileSaveStore(dir).loadLatest(U)!.events.length;

    const res = orch.advance(U, "player-turn");
    expect(res.integrity).toBe("ok");
    expect(res.events).toBeGreaterThanOrEqual(1);

    const sb = registry.sandboxFor(U);
    // A meaningful, player-witnessed day event (daily-event invariant).
    expect(sb.engine.events.query({ witnessedBy: PLAYER }).some((e) => e.type === "house-event")).toBe(true); // E58: content now varies — assert the typed day event, not one canned line
    // At least one off-screen scene the player does not witness.
    expect(hidden(sb).length).toBeGreaterThanOrEqual(1);
    // The new state is persisted (a later save with more events).
    expect(new FileSaveStore(dir).loadLatest(U)!.events.length).toBeGreaterThan(savedBefore);
  });

  it("REGRESSION (comp-variety audit): the ambient house-event fires on the REAL production trigger, not only the test-only 'player-turn'", () => {
    // Every real production path (the turn-driven tick fired from `commitPlayerTurn`) calls
    // `advance()`/`defaultApply` with trigger "offscreen-tick" — NEVER "player-turn" (that value
    // is only ever passed directly by tests; there is no wall-clock watcher). The ambient
    // house-event block used to gate on `trigger === "player-turn"`, so it was dead code for
    // every real game: the entire curated variety pool never reached a live player. This proves
    // the fix — the SAME trigger value real gameplay uses now records the ambient day event too.
    const registry = new GameSessionRegistry();
    const orch = new Orchestrator(registry, new FakeClock(), { seed: 41 });
    registry.sandboxFor(U).session.createCharacter({ playerName: "Tick", seed: 41 });

    const res = orch.advance(U, "offscreen-tick");
    expect(res.integrity).toBe("ok");

    const sb = registry.sandboxFor(U);
    const dayEvents = sb.engine.events.query({ witnessedBy: PLAYER })
      .filter((e) => e.type === "house-event" && e.content.includes("Week"));
    expect(dayEvents.length).toBeGreaterThanOrEqual(1); // the ambient E58 pick, not just a ceremony beat
    expect(dayEvents[0]!.hidden).toBe(false); // player-witnessed = not secret
  });

  it("the house lives between turns: a committed player turn runs one bounded off-screen tick, no numbers shown", () => {
    const registry = new GameSessionRegistry(new FileSaveStore(freshDir()));
    const orch = new Orchestrator(registry, new FakeClock(), { seed: 3, turnDriven: true });
    registry.sandboxFor(U).session.createCharacter({ playerName: "Idle", seed: 3 });
    const before = hidden(registry.sandboxFor(U)).length;

    // The house lives ONLY on the player's play-clock (real-time purge 2026-07-10): one player-turn
    // commit fires exactly one bounded off-screen tick — no wall-clock watcher, nothing on real time.
    orch.commitPlayerTurn(U);

    const sb = registry.sandboxFor(U);
    expect(hidden(sb).length).toBeGreaterThan(before); // new off-screen consequences
    // The player is shown no hidden/off-screen content (no opinion numbers, no Vault).
    const view = playerSweep(sb);
    for (const c of hidden(sb)) expect(view.includes(c)).toBe(false);
  });

  it("the integrity checkpoint is fail-closed (no degradation, no leak)", () => {
    const dir = freshDir();
    const registry = new GameSessionRegistry(new FileSaveStore(dir));
    const clock = new FakeClock();
    const LEAK = "LEAK-0031-SENTINEL";
    // An advance that LEAKS: the same secret appears hidden AND in a player-witnessed event.
    const leakingApply = (sb: UserSandbox): number => {
      sb.engine.events.record({ id: "leak:h", ts: 1, type: "conversation", initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: `secret ${LEAK}` });
      sb.engine.events.record({ id: "leak:v", ts: 2, type: "conversation", initiator: npc(1), witnessSet: [PLAYER, npc(1)], hidden: false, content: `secret ${LEAK}` });
      return 1;
    };
    const orch = new Orchestrator(registry, clock, { seed: 1, apply: leakingApply });
    registry.sandboxFor(U).session.createCharacter({ playerName: "Keeper", seed: 1 });
    const savedBefore = new FileSaveStore(dir).loadLatest(U)!;

    const res = orch.advance(U, "player-turn");
    expect(res.integrity).toBe("fault");
    expect(res.faults.some((f) => f.kind === "vault-leak")).toBe(true);

    // The prior persisted save is intact (the leak was never committed)...
    const savedAfter = new FileSaveStore(dir).loadLatest(U)!;
    expect(savedAfter.events.length).toBe(savedBefore.events.length);
    expect(JSON.stringify(savedAfter.events).includes(LEAK)).toBe(false);
    // ...and the live sandbox was rolled back (clean — no aborted events).
    expect(registry.sandboxFor(U).engine.events.queryAll().some((e) => e.content.includes(LEAK))).toBe(false);
    // A fault is recorded on the sandbox's health.
    const health = orch.sandboxHealth(U) as { lastIntegrity: string; faults: unknown[] };
    expect(health.lastIntegrity).toBe("fault");
    expect(health.faults.length).toBeGreaterThanOrEqual(1);
  });

  it("an off-screen tick with fewer than two living NPCs is a clean no-op, not a fault (deep endgame)", () => {
    const registry = new GameSessionRegistry();
    const orch = new Orchestrator(registry, new FakeClock(), { seed: 13 });
    registry.sandboxFor(U).session.createCharacter({ playerName: "Finalist", seed: 13 });
    // The player stands in the Final 2: every NPC but one has been evicted (B52: evictees stop
    // living), so there is no off-screen society left to run. The tick must be a clean no-op —
    // the old behavior logged a no-daily-event integrity fault on every finale turn.
    const snap = registry.snapshot(U);
    const npcs = snap.house!.npcs.map((n) => n.id);
    snap.live!.evictionOrder = npcs.slice(0, npcs.length - 1);
    snap.live!.active = [PLAYER, npcs[npcs.length - 1]!];
    registry.restore(U, snap);
    const before = registry.sandboxFor(U).engine.events.queryAll().length;

    const res = orch.advance(U, "offscreen-tick");
    expect(res.integrity).toBe("ok");
    expect(res.faults).toEqual([]);
    expect(res.events).toBe(0);
    expect(registry.sandboxFor(U).engine.events.queryAll().length).toBe(before);
    expect((orch.sandboxHealth(U) as { lastIntegrity: string }).lastIntegrity).not.toBe("fault");
  });

  it("the checkpoint detects dropped detail (degradation)", () => {
    const registry = new GameSessionRegistry();
    const orch = new Orchestrator(registry, new FakeClock(), { seed: 1 });
    registry.sandboxFor(U).session.createCharacter({ playerName: "P", seed: 1 });
    orch.advance(U, "player-turn"); // populate some persisted detail
    const baseline = registry.snapshot(U);
    expect(baseline.events.length).toBeGreaterThan(0);
    const degraded = { ...baseline, events: [] }; // dropped every persisted event
    const faults = orch.checkpoint(baseline, degraded, registry.sandboxFor(U), "player-turn");
    expect(faults.some((f) => f.kind === "degradation")).toBe(true);
  });

  it("off-screen life is deterministic and holds no game logic", () => {
    const runGame = (seed: number): string => {
      const registry = new GameSessionRegistry();
      const orch = new Orchestrator(registry, new FakeClock(), { seed });
      registry.sandboxFor(U).session.createCharacter({ playerName: "Same", seed });
      for (let i = 0; i < 3; i++) orch.advance(U, "player-turn");
      const snap = registry.snapshot(U);
      return JSON.stringify({ events: snap.events, relationships: snap.relationships });
    };
    expect(runGame(42)).toBe(runGame(42)); // same seed + same ticks ⇒ identical state

    // Turn-driven OFF (the default) ⇒ committing player turns never fires an off-screen tick, so a
    // game never advances on its own. (There is NO wall-clock watcher — nothing runs on real time.)
    const registry = new GameSessionRegistry();
    const orch = new Orchestrator(registry, new FakeClock(), { seed: 1 });
    registry.sandboxFor(U).session.createCharacter({ playerName: "Still", seed: 1 });
    const before = registry.sandboxFor(U).engine.events.queryAll().length;
    orch.commitPlayerTurn(U);
    orch.commitPlayerTurn(U);
    expect(registry.sandboxFor(U).engine.events.queryAll().length).toBe(before);
  });

  it("isolation holds while the house lives between turns across many sandboxes", () => {
    const registry = new GameSessionRegistry(new FileSaveStore(freshDir()));
    const orch = new Orchestrator(registry, new FakeClock(), { seed: 5, turnDriven: true });
    registry.sandboxFor("A").session.createCharacter({ playerName: "Alpha", seed: 11 });
    registry.sandboxFor("B").session.createCharacter({ playerName: "Bravo", seed: 22 });
    // A unique witnessed marker in each sandbox.
    registry.sandboxFor("A").engine.events.record({ id: "mk-a", ts: 0, type: "house-event", initiator: PLAYER, witnessSet: [PLAYER], hidden: false, content: "MARKER-A-7f3" });
    registry.sandboxFor("B").engine.events.record({ id: "mk-b", ts: 0, type: "house-event", initiator: PLAYER, witnessSet: [PLAYER], hidden: false, content: "MARKER-B-9k2" });

    // Each user's own play-clock drives their own off-screen life; no cross-user bleed.
    orch.commitPlayerTurn("A");
    orch.commitPlayerTurn("B");

    const aEvents = JSON.stringify(registry.sandboxFor("A").engine.events.queryAll());
    const bEvents = JSON.stringify(registry.sandboxFor("B").engine.events.queryAll());
    expect(aEvents.includes("MARKER-A-7f3")).toBe(true);
    expect(bEvents.includes("MARKER-B-9k2")).toBe(true);
    expect(aEvents.includes("MARKER-B-9k2")).toBe(false); // no cross-user content
    expect(bEvents.includes("MARKER-A-7f3")).toBe(false);
  });

  it("sandbox health is God-Mode-only metadata and is Vault-free", () => {
    const registry = new GameSessionRegistry(new FileSaveStore(freshDir()));
    const orch = new Orchestrator(registry, new FakeClock(), { seed: 9 });
    const sb = registry.sandboxFor(U);
    sb.session.createCharacter({ playerName: "Watched", seed: 9 });
    const SENT = "VAULT-0031-SENTINEL";
    sb.engine.vault.writeHidden({ id: "v1", kind: "hidden-attribute", content: `hidden ${SENT}` });
    orch.advance(U, "player-turn"); // produces off-screen hidden events

    const health = orch.sandboxHealth(U) as unknown as Record<string, unknown>;
    expect(Object.keys(health).sort()).toEqual(
      ["circuitOpen", "eventCount", "faults", "lastAdvanceAt", "lastIntegrity", "lastTrigger", "phase", "started", "user", "week"],
    );
    const json = JSON.stringify(health);
    expect(json.includes(SENT)).toBe(false); // no Vault data
    for (const c of hidden(sb)) expect(json.includes(c)).toBe(false); // no off-screen content
    // The player has no access to the health surface.
    expect((sb.player as unknown as Record<string, unknown>)["sandboxHealth"]).toBeUndefined();
  });
});

describe("A9 — a supplementary turn-driven off-screen tick with an empty society is not a fault", () => {
  const emptyApply = (): number => 0; // the off-screen society legitimately had nothing to add

  it("a supplementary tick stays integrity-ok (no no-daily-event fault); a direct tick still flags it", () => {
    const registry = new GameSessionRegistry();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const orch = new Orchestrator(registry, new FakeClock(), { seed: 4, apply: emptyApply });
      registry.sandboxFor(U).session.createCharacter({ playerName: "P", seed: 4 });

      // Supplementary (the turn-driven path, A9): an empty society this tick is a clean no-op —
      // the daily-event invariant belongs to the live loop's own beats, not this background tick.
      const supp = orch.advance(U, "offscreen-tick", { supplementary: true });
      expect(supp.integrity).toBe("ok");
      expect(supp.faults).toEqual([]);

      // A non-supplementary off-screen tick (the direct path) still flags the empty tick —
      // that daily-event guard is what opsHardening relies on to trip the circuit breaker.
      const direct = orch.advance(U, "offscreen-tick");
      expect(direct.integrity).toBe("fault");
      expect(direct.faults.some((f) => f.kind === "no-daily-event")).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("ORW-701 part 3 - a supplementary off-screen tick that throws never fails the player's turn", () => {
  it("is contained: turn stands, state rolled back to the committed baseline, typed content-free fault, streak untouched, next clean tick works", () => {
    const registry = new GameSessionRegistry();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let boom = true;
      const SECRET = "TICK-THROW-SENTINEL";
      const apply = (sb: UserSandbox): number => {
        // half-applied state, then the throw (message carries hidden-looking text that must never surface)
        sb.engine.events.record({ id: "half:h", ts: 1, type: "conversation", initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: `half ${SECRET}` });
        if (boom) throw new Error(`exploded ${SECRET}`);
        return 0;
      };
      const orch = new Orchestrator(registry, new FakeClock(), { seed: 5, apply, turnDriven: true });
      registry.sandboxFor(U).session.createCharacter({ playerName: "P", seed: 5 });
      expect(() => orch.commitPlayerTurn(U)).not.toThrow(); // first commit: baseline established, tick contained
      const committed = registry.sandboxFor(U).engine.events.queryAll().length;
      expect(() => orch.commitPlayerTurn(U)).not.toThrow(); // a second turn: the tick throws again, contained again
      const sb = registry.sandboxFor(U);
      expect(sb.engine.events.queryAll().length).toBe(committed); // no half-applied event survived
      expect(sb.engine.events.queryAll().some((e) => e.content.includes(SECRET))).toBe(false);
      const h = orch.sandboxHealth(U) as { faults: { kind: string }[]; circuitOpen: boolean; lastTrigger: string };
      expect(h.faults.some((f) => f.kind === "tick-failure")).toBe(true);
      expect(h.faults.every((f) => f.kind === "tick-failure")).toBe(true);
      expect(h.circuitOpen).toBe(false);
      for (let i = 0; i < 6; i++) orch.commitPlayerTurn(U); // many throwing turns: still not the corruption alarm
      expect((orch.sandboxHealth(U) as { circuitOpen: boolean }).circuitOpen).toBe(false);
      expect((orch.sandboxHealth(U) as { faults: unknown[] }).faults.length).toBeLessThanOrEqual(20); // capped ring (MAX_STORED_FAULTS)
      const json = JSON.stringify(orch.sandboxHealth(U));
      expect(json.includes(SECRET)).toBe(false);
      expect(json.includes("exploded")).toBe(false);
      for (const f of (orch.sandboxHealth(U) as { faults: object[] }).faults) expect(Object.keys(f).sort()).toEqual(["kind", "when"]);

      boom = false; // a clean tick afterwards works
      expect(() => orch.commitPlayerTurn(U)).not.toThrow();
      expect((orch.sandboxHealth(U) as { circuitOpen: boolean }).circuitOpen).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });
});
