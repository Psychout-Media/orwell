import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/** ORW-513 - the hours a competition takes are recorded as elapsed when its (tick-suppressed) commit returns, so the next off-screen tick does not count them again. Roles only. */

afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
}

describe("ORW-513 - a competition's hours are counted once", () => {
  // ORW-955: vitest 2 never enforced the 30 s limit on synchronous tests; this keeps that behaviour explicit
  it("after a competition-suppressed commit the tick anchor is the current in-game hour", { timeout: 120_000 }, () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const reg = new GameSessionRegistry();
    const user = "u-comp-hours";
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 7 });
    sb.session.setPerConversationClockEnabled(true);
    const orch = new Orchestrator(reg, new FakeClock(), { seed: 7, turnDriven: true, auxTicksNever: true });
    reg.setCommit((u) => orch.commitPlayerTurn(u));
    reg.setOnReset((u) => orch.forgetUser(u));
    for (let i = 0; i < 120 && sb.session.snapshot().live?.hoh === undefined; i++) {
      if (!(sb.session as GameSessionAdapter).milestoneDue()) { // let the played clock run until the next beat is due
        const other = sb.session.livingIds().filter((x) => x !== PLAYER)[0]!;
        if (sb.session.snapshot().live?.timeOfDay === "evening" || sb.session.snapshot().live?.timeOfDay === "late-night") sb.session.turnIn();
        else { sb.session.noteMessage({ messageId: `m-${i + 1}` }); sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, other], content: `chat ${i}` }); }
        continue;
      }
      const a = sb.session.advanceGame();
      if (a.pending) resolveLegally(sb.session, a.pending);
    }
    sb.session.noteMessage({ messageId: "m-0" }); // a person is playing
    const anchors = orch as unknown as { lastSocietyTickAbs: Map<string, number>; lastSocietyTickHour: Map<string, number> };
    let checked = 0;
    for (let i = 0; i < 200 && checked < 1; i++) {
      anchors.lastSocietyTickAbs.set(user, -50); // a stale anchor: a competition-suppressed commit must refresh it
      anchors.lastSocietyTickHour.delete(user);
      if (!(sb.session as GameSessionAdapter).milestoneDue()) { // let the played clock run until the next beat is due
        const other = sb.session.livingIds().filter((x) => x !== PLAYER)[0]!;
        if (sb.session.snapshot().live?.timeOfDay === "evening" || sb.session.snapshot().live?.timeOfDay === "late-night") sb.session.turnIn();
        else { sb.session.noteMessage({ messageId: `m-${i + 1}` }); sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, other], content: `chat ${i}` }); }
        continue;
      }
      const a = sb.session.advanceGame();
      const inComp = a.pending?.kind === "comp-round" || a.pending?.kind === "comp-intent";
      if (inComp) {
        checked++;
        expect(anchors.lastSocietyTickAbs.get(user)).toBe(sb.session.inGameAbsHour());
        expect(anchors.lastSocietyTickHour.get(user)).toBe(sb.session.inGameHour());
      }
      if (a.pending) resolveLegally(sb.session, a.pending);
    }
    expect(checked, "the season reached a competition").toBeGreaterThan(0);
  });
});

describe("ORW-513 - the tick anchor survives a resume and a restart", () => {
  it("a resumed save is anchored on its saved clock; a new season clears the old anchor", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const reg = new GameSessionRegistry();
    const user = "u-anchor";
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 3 });
    sb.session.setPerConversationClockEnabled(true);
    const orch = new Orchestrator(reg, new FakeClock(), { seed: 3, turnDriven: true, auxTicksNever: true });
    const anchors = (orch as unknown as { lastSocietyTickAbs: Map<string, number> }).lastSocietyTickAbs;
    expect(anchors.has(user)).toBe(false);
    orch.seedBaselineIfAbsent(user);
    expect(anchors.get(user)).toBe(sb.session.inGameAbsHour());
    anchors.set(user, -50);
    orch.dropBaseline(user);
    orch.seedBaselineIfAbsent(user);
    expect(anchors.get(user), "an existing anchor is never overwritten").toBe(-50);
    orch.forgetUser(user);
    expect(anchors.has(user)).toBe(false);
  });
});
