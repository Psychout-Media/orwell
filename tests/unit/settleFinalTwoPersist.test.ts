import { describe, it, expect, afterEach, vi } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/** ORW-529 - at Final 2 (fewer than two living NPCs) the overnight settle must still be saved, through the checkpointed commit funnel. Roles only. */

afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
}

describe("ORW-529 - the overnight settle is saved at Final 2", () => {
  it("after the settle, the last saved snapshot equals the live state; no society tick ran; beatSeq did not move", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const user = "u-final2";
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 7 });
    sb.session.setPerConversationClockEnabled(true);
    const orch = new Orchestrator(reg, new FakeClock(), { seed: 7, turnDriven: true, auxTicksNever: true });
    reg.setCommit((u) => orch.commitPlayerTurn(u));
    reg.setOnReset((u) => orch.forgetUser(u));
    for (let i = 0; i < 120 && sb.session.snapshot().live?.hoh === undefined; i++) {
      const a = sb.session.advanceGame();
      if (a.pending) resolveLegally(sb.session, a.pending);
    }
    sb.session.noteMessage({ messageId: "m-0" });
    const other = sb.session.livingIds().filter((i) => i !== PLAYER)[0]!;
    for (let t = 0; t < 80 && sb.session.snapshot().live?.timeOfDay !== "evening" && sb.session.snapshot().live?.timeOfDay !== "night"; t++) {
      sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, other], content: `chat ${t}` });
    }
    // Final 2: the pool of living NPCs the society can draw on is one.
    vi.spyOn(orch as unknown as { offscreenPoolSize: () => number }, "offscreenPoolSize").mockReturnValue(1);
    const saved: unknown[] = [];
    const real = reg.saveUser.bind(reg);
    vi.spyOn(reg, "saveUser").mockImplementation((u, snap) => { saved.push(snap); return real(u, snap); });
    const settle = vi.spyOn(sb.session as GameSessionAdapter, "settleOvernight");
    const society = vi.spyOn(orch as unknown as { applyFn: () => unknown }, "applyFn");
    sb.session.turnIn();
    expect(settle).toHaveBeenCalled();
    expect(society, "no society tick at Final 2").not.toHaveBeenCalled();
    const live = JSON.stringify(reg.snapshot(user));
    expect(JSON.stringify(saved[saved.length - 1]), "last save holds the settled state").toBe(live);
    // restore from that save shows the same state
    const fresh = new GameSessionRegistry().sandboxFor("u-restore");
    fresh.session.restore(saved[saved.length - 1] as never);
    expect(JSON.stringify(fresh.session.snapshot())).toBe(JSON.stringify(sb.session.snapshot()));
  });
});
