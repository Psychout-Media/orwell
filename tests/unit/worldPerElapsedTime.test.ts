import { describe, it, expect, afterEach, vi } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator, elapsedWorldPlan, EXTRA_TICK_CAP, SETTLE_CAP } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { hashSeed } from "../../src/engine/characterFactory";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/** ORW-256 - the background world runs per elapsed game time: sleep = inner processing only, waking beats = extra ticks on a side stream, headless = untouched. Roles only. */

afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
}

function harness(seed: number, user: string, playing: boolean) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.setPerConversationClockEnabled(true);
  const orch = new Orchestrator(reg, new FakeClock(), { seed, turnDriven: true, auxTicksNever: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  reg.setOnReset((u) => orch.forgetUser(u));
  for (let i = 0; i < 120 && sb.session.snapshot().live?.hoh === undefined; i++) {
    const a = sb.session.advanceGame();
    if (a.pending) resolveLegally(sb.session, a.pending);
  }
  if (playing) sb.session.noteMessage({ messageId: "m-0" });
  return { sb, orch };
}

describe("elapsedWorldPlan (pure)", () => {
  it("a headless driver (not playing) gets nothing, whatever the elapsed time", () => {
    expect(elapsedWorldPlan(false, true, 9)).toEqual({ extraTicks: 0, settleSteps: 0 });
    expect(elapsedWorldPlan(false, false, 9)).toEqual({ extraTicks: 0, settleSteps: 0 });
  });
  it("sleep: inner settling only, never a scheming tick; capped", () => {
    expect(elapsedWorldPlan(true, true, 8)).toEqual({ extraTicks: 0, settleSteps: Math.min(SETTLE_CAP, 5) });
    expect(elapsedWorldPlan(true, true, 1)).toEqual({ extraTicks: 0, settleSteps: 0 });
  });
  it("a waking beat: the base tick covers the first 1.5h, each further 1.5h earns one more (capped)", () => {
    expect(elapsedWorldPlan(true, false, 1.4).extraTicks).toBe(0);
    expect(elapsedWorldPlan(true, false, 3).extraTicks).toBe(1);
    expect(elapsedWorldPlan(true, false, 100).extraTicks).toBe(EXTRA_TICK_CAP);
    expect(elapsedWorldPlan(true, false, 3).settleSteps).toBe(0);
  });
});

describe("ORW-256 - wiring", () => {
  it("a person's night settles moods and runs NO extra scheming ticks; a headless night does neither", () => {
    for (const playing of [true, false]) {
      const { sb, orch } = harness(7, `u-night-${playing}`, playing);
      const settle = vi.spyOn(sb.session as GameSessionAdapter, "settleOvernight");
      for (let t = 0; t < 80 && sb.session.snapshot().live?.timeOfDay !== "evening" && sb.session.snapshot().live?.timeOfDay !== "night"; t++) {
        sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, sb.session.livingIds().filter((i) => i !== PLAYER)[0]!], content: `chat ${t}` });
      }
      const adv = vi.spyOn(orch, "advance");
      sb.session.turnIn();
      const rolled = adv.mock.calls.filter((c) => c[2]?.rng !== undefined).length;
      expect(rolled, "a sleeping house gets no extra scene ticks").toBe(0);
      if (playing) expect(settle.mock.calls.length).toBe(1);
      else expect(settle).not.toHaveBeenCalled();
    }
  });
  it("extra ticks use a side stream, never the shared per-user one", () => {
    const { sb, orch } = harness(5, "u-side", true);
    const adv = vi.spyOn(orch, "advance");
    const other = sb.session.livingIds().filter((x) => x !== PLAYER)[0]!;
    for (let t = 0; t < 200; t++) {
      if ((sb.session as GameSessionAdapter).milestoneDue()) { const a = sb.session.advanceGame(); if (a.pending) resolveLegally(sb.session, a.pending); }
      else if (sb.session.snapshot().live?.timeOfDay === "evening" || sb.session.snapshot().live?.timeOfDay === "late-night") sb.session.turnIn();
      else { sb.session.noteMessage({ messageId: `m-${t + 1}` }); sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, other], content: `chat ${t}` }); }
    }
    const side = adv.mock.calls.filter((c) => c[2]?.rng !== undefined);
    // A person's played days: every extra tick (if any beat covered >= 3 waking hours) rides a side stream and is an off-screen tick; sleeps never produce one (asserted above).
    for (const c of side) expect(c[1]).toBe("offscreen-tick");
  });
});

describe("ORW-256 slice 2 - an extra waking-hour tick runs the WHOLE world, on its own stream", () => {
  it("one side-stream tick moves the house, advances campaigns and records scenes; the shared per-user stream is not drawn from", () => {
    const { sb, orch } = harness(7, "w-slice2", true);
    const s = sb.session as unknown as { presenceTick: (r: unknown) => void; campaignTick: () => void };
    const presence = vi.spyOn(s, "presenceTick");
    const campaigns = vi.spyOn(s, "campaignTick");
    const eventsBefore = sb.engine.events.count();
    const shared = vi.spyOn(orch as unknown as { rngFor: (u: string) => unknown }, "rngFor");
    const side = new SeededRandom(hashSeed("slice2-side"));
    orch.advance("w-slice2", "offscreen-tick", { supplementary: true, rng: side });
    expect(presence).toHaveBeenCalledTimes(1);   // movement
    expect(campaigns).toHaveBeenCalledTimes(1);  // campaign progress (its own dedicated stream inside)
    expect(sb.engine.events.count()).toBeGreaterThan(eventsBefore); // scenes (the gossip source) were recorded
    expect(presence.mock.calls[0]![0]).toBe(side); // the tick's draws came from the side stream
    expect(shared).not.toHaveBeenCalled();         // never the shared per-user stream
  });
});
