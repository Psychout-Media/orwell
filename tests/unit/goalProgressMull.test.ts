import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { Agenda } from "../../src/engine/agenda";
import { startPlayedSandbox } from "../support/agendaSeasonDriver";

/**
 * ORW-571: the nightly mull used to fade EVERY goal (its `progressed` input was never passed), so season goals gave up around night 7. A goal the holder acted for
 * today (an hourly step made for it) or reasoned a decision from is progress, and does not fade. A neglected goal still does. Roles only.
 */
type Probe = {
  live: { agendas?: Record<string, Agenda>; nightDepth?: number };
  livingIds(): string[];
  houseLifeStretch(events: unknown, awake: readonly string[], i: number): unknown[];
  settleOvernight(n: number): number;
  snapshot(): { live: { agendas?: Record<string, Agenda> } };
};
function play(act: boolean, nights: number): { held: number; gaveUp: number; sawServed: boolean; s: GameSessionAdapter } {
  const { s: sess, sb } = startPlayedSandbox(5);
  const s = sess as unknown as Probe;
  const awake = s.livingIds().filter((i) => i !== PLAYER);
  let sawServed = false;
  for (let n = 0; n < nights; n++) {
    if (act) {
      for (let i = 0; i < 8; i++) { s.live.nightDepth = (s.live.nightDepth ?? 8) + 1; s.houseLifeStretch(sb.engine.events, awake, n * 8 + i); }
      if (Object.values(s.live.agendas!).some((a) => a.served?.length)) sawServed = true;
    }
    s.settleOvernight(1);
  }
  const ag = Object.values(s.live.agendas!);
  const held = ag.reduce((t, a) => t + a.goals.filter((g) => g.horizon === "season" && g.formedDay <= 2).length, 0);
  const gaveUp = ag.reduce((t, a) => t + a.history.filter((g) => g.horizon === "season" && g.endNote === "gave up").length, 0);
  return { held, gaveUp, sawServed, s: sess };
}

describe("ORW-571: goals being served persist; goals being neglected still fade", () => {
  it("12 nights of acting keep more season goals than 12 nights of neglect, and fewer are given up", () => {
    const acted = play(true, 12), idle = play(false, 12);
    expect(acted.sawServed, "the hourly steps are recorded on the agenda").toBe(true);
    expect(idle.gaveUp, "neglect still fades goals (the mull is not switched off)").toBeGreaterThan(0);
    expect(acted.held).toBeGreaterThan(idle.held);
    expect(acted.gaveUp).toBeLessThan(idle.gaveUp);
  }, 120_000);

  it("the served record is saved and restored with the agenda, and the night spends it", () => {
    const { s, sb } = startPlayedSandbox(5);
    const p = s as unknown as Probe;
    const awake = p.livingIds().filter((i) => i !== PLAYER);
    for (let i = 0; i < 8; i++) { p.live.nightDepth = (p.live.nightDepth ?? 8) + 1; p.houseLifeStretch(sb.engine.events, awake, i); }
    const before = JSON.parse(JSON.stringify(p.snapshot().live.agendas));
    expect(Object.values(before as Record<string, Agenda>).some((a) => a.served?.length)).toBe(true);
    const b = new GameSessionRegistry().sandboxFor(`pm-${Math.random()}`).session as GameSessionAdapter;
    b.restore(JSON.parse(JSON.stringify(s.snapshot())));
    expect((b.snapshot().live as unknown as { agendas: unknown }).agendas).toEqual(before);
    p.settleOvernight(1);
    expect(Object.values(p.live.agendas!).every((a) => a.served === undefined)).toBe(true);
  }, 60_000);
});
