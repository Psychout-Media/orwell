import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/** ORW-481 (review of the staged-competition hours): the player's own `comp-round` answer resolves the FIRST elimination, and that round's share of the competition's hours is charged at once (not left for the crown). Roles only. */

afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
}

describe("a staged competition's first round is charged when the player answers it", () => {
  it("the first comp-round answer spends its share of the comp's hours on the clock budget", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const reg = new GameSessionRegistry();
    const user = "u-first-round";
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 7 });
    sb.session.setPerConversationClockEnabled(true);
    const orch = new Orchestrator(reg, new FakeClock(), { seed: 7, turnDriven: true, auxTicksNever: true });
    reg.setCommit((u) => orch.commitPlayerTurn(u));
    reg.setOnReset((u) => orch.forgetUser(u));
    const spent = (): number => ((sb.session.snapshot().live as { compClock?: { spent: number } } | undefined)?.compClock?.spent) ?? 0;
    let checked = 0;
    for (let i = 0; i < 300 && checked < 1; i++) {
      sb.session.noteMessage({ messageId: `m-${i}` });
      if (!(sb.session as GameSessionAdapter).milestoneDue()) { // let the played clock run until the next beat is due
        const other = sb.session.livingIds().filter((x) => x !== PLAYER)[0]!;
        if (sb.session.snapshot().live?.timeOfDay === "evening" || sb.session.snapshot().live?.timeOfDay === "late-night") sb.session.turnIn();
        else sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, other], content: `chat ${i}` });
        continue;
      }
      const a = sb.session.advanceGame();
      if (a.pending?.kind === "comp-round" && spent() === 0) {
        const hourBefore = sb.session.inGameAbsHour()!;
        const view = sb.session.submitDecision({ kind: "comp-round", intent: "compete" });
        if (view.event?.beat !== "comp-elimination") { if (view.pending) resolveLegally(sb.session, view.pending); continue; }
        checked++;
        // a 16-person field plays 5 staged rounds of a 3-hour comp (0.6h each); this answer resolves the first and the chained step plays the second: both are paid
        expect(spent(), "the answered round and the chained round each paid their share").toBeCloseTo(1.2, 9);
        expect(sb.session.inGameAbsHour()!, "and the clock moved by it").toBeGreaterThan(hourBefore);
        continue;
      }
      if (a.pending) resolveLegally(sb.session, a.pending);
    }
    expect(checked, "the season reached a staged competition's first round").toBe(1);
  });
});
