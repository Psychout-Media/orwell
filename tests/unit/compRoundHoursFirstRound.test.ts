import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import { beatFeltHours } from "../../src/engine/daySchedule";

/** ORW-550 - the player's answer to the first staged comp-round resolves that elimination, so it must charge that round's share of the comp's hours like every other round. Roles only. */

afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
}

describe("ORW-550 - the first staged round charges its share of the hours", () => {
  it("after the player answers the first comp-round, every elimination so far has been charged", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const reg = new GameSessionRegistry();
    const user = "u-comp-r1";
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 7 });
    sb.session.setPerConversationClockEnabled(true);
    const orch = new Orchestrator(reg, new FakeClock(), { seed: 7, turnDriven: true, auxTicksNever: true });
    reg.setCommit((u) => orch.commitPlayerTurn(u));
    reg.setOnReset((u) => orch.forgetUser(u));
    const g = sb.session as GameSessionAdapter;
    let checked = false;
    for (let i = 0; i < 400 && !checked; i++) {
      sb.session.noteMessage({ messageId: `m-${i}` }); // a person is playing
      if (!g.milestoneDue()) {
        const other = sb.session.livingIds().filter((x) => x !== PLAYER)[0]!;
        if (sb.session.snapshot().live?.timeOfDay === "evening" || sb.session.snapshot().live?.timeOfDay === "late-night") sb.session.turnIn();
        else sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, other], content: `chat ${i}` });
        continue;
      }
      const a = sb.session.advanceGame();
      if (a.pending?.kind === "comp-round") {
        const live = (g as unknown as { live: { competition: { field: string[]; round: number }; compClock?: { spent: number }; beat: string } }).live;
        sb.session.submitDecision({ kind: "comp-round", intent: "compete" });
        const c = live.competition;
        const rounds = Math.max(2, Math.ceil((c.field.length - 1) / Math.max(1, Math.ceil((c.field.length - 1) / 5))));
        const share = (beatFeltHours(live.beat as never) ?? 0) / rounds;
        const eliminationsDone = c.round - 1; // round counter is 1-based: rounds resolved so far
        expect(eliminationsDone).toBeGreaterThan(0);
        expect(live.compClock?.spent ?? 0).toBeCloseTo(eliminationsDone * share, 6);
        checked = true;
      } else if (a.pending) resolveLegally(sb.session, a.pending);
    }
    expect(checked, "the season reached a player comp-round").toBe(true);
  });
});
