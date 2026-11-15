import { describe, it, expect } from "vitest";
import { buildEngineCore } from "../../src/composition/engineRoot";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { PLAYER, npc } from "../../src/domain/ids";

// ORW-401 — played games: no hard cap, a shrinking per-window effect, damped near the extremes, persisted counts.
function setup(window: { v: string | null }) {
  const core = buildEngineCore();
  const cmd = new EngineCommandsAdapter(core.events, core.knowledge, core.relationships);
  cmd.setFoldWindowProvider(() => window.v);
  const edge = () => core.relationships.read(npc(1), PLAYER).signals.affinity;
  const scene = () =>
    cmd.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a friendly chat", kind: "bonding" });
  return { core, cmd, edge, scene };
}

describe("ORW-401 relationship metering (played game)", () => {
  it("30 friendly scenes in one window never reach the extreme and each later scene moves it less", () => {
    const { edge, scene } = setup({ v: "d1:morning" });
    const steps: number[] = [];
    let prev = edge();
    for (let i = 0; i < 30; i++) {
      scene();
      const now = edge();
      steps.push(now - prev);
      prev = now;
    }
    expect(prev).toBeLessThan(0.95);
    expect(steps[0]!).toBeGreaterThan(0);
    for (let i = 1; i < steps.length; i++) expect(steps[i]!, `scene ${i + 1} moves it less than scene ${i}`).toBeLessThan(steps[i - 1]!);
    expect(steps[29]!).toBeGreaterThan(0); // no hard cap: the scene still moves it a little
  });

  it("a new window restores the full first-step effect", () => {
    const w = { v: "d1:morning" };
    const { edge, scene } = setup(w);
    const a0 = edge(); scene(); const first = edge() - a0;
    for (let i = 0; i < 6; i++) scene();
    w.v = "d1:evening";
    const b0 = edge(); scene(); const next = edge() - b0;
    expect(next).toBeGreaterThan(first * 0.5);
  });

  it("restore drops NaN, negative and fractional counts instead of storing them (review of #2687)", () => {
    const w = { v: "d1:morning" };
    const a = setup(w);
    a.cmd.restoreFoldMeter({ key: "d1:morning", counts: { x: Number.NaN, y: -3, z: 1.5, ok: 2 } });
    expect(a.cmd.foldMeterState()?.counts).toEqual({ ok: 2 });
  });

  it("snapshot/restore mid-window keeps the counts (a restart does not refill them)", () => {
    const w = { v: "d1:morning" };
    const a = setup(w);
    for (let i = 0; i < 5; i++) a.scene();
    const state = a.cmd.foldMeterState();
    expect(state).toBeDefined();
    const b = setup(w);
    b.cmd.restoreFoldMeter(JSON.parse(JSON.stringify(state)));
    const fresh = setup(w);
    const b0 = b.edge(); b.scene(); const restored = b.edge() - b0;
    const f0 = fresh.edge(); fresh.scene(); const first = fresh.edge() - f0;
    expect(restored).toBeLessThan(first * 0.2);
  });

  it("headless (no window) keeps the legacy hard cap", () => {
    const { edge, scene } = setup({ v: null });
    for (let i = 0; i < 3; i++) scene();
    const after3 = edge();
    for (let i = 0; i < 5; i++) scene();
    expect(edge()).toBe(after3);
  });
});

describe("review of #2687: the window key of a legacy save without dayNumber follows the week", () => {
  it("falls back to the live week, not day 1", async () => {
    const { GameSessionAdapter } = await import("../../src/adapters/engine/GameSessionAdapter");
    const g = new GameSessionAdapter();
    g.createCharacter({ playerName: "P", seed: 3 });
    GameSessionAdapter.setTimeOfDayEnabled(true);
    g.noteMessage({ messageId: "m1" });
    const p = g as unknown as { messageMode: boolean; live: { playedGame?: boolean; timeOfDay?: string; dayNumber?: number; week: number } };
    p.messageMode = true; p.live.playedGame = true; p.live.timeOfDay = "morning";
    delete p.live.dayNumber; p.live.week = 4;
    try { expect(g.foldWindowKey()).toBe("d4:morning"); } finally { GameSessionAdapter.setTimeOfDayEnabled(null); }
  });
});
