import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { answerPending } from "../../features/support/answerPending";

/**
 * ORW-999: Ryne's live save sat at premiereEntrance.stage "done" with live.bedRush null (the circle had closed, no heat had run). That state is reached here by PLAYING: the premiere's entrances and toast are advanced
 * and the loop stops the moment the circle closes, before the next player message. The save's next message starts the rush. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
type Sess = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("a game sitting at stage done with no rush (Ryne's live save)", () => {
  it("its next player message starts the rush, and the houseguests begin to claim", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor("bedrush999-save").session as Sess;
    s.setPremiereEntrancesEnabled(true); // the unit lane pins the staged premiere off (tests/support/premiereTestDefault.ts); the game as shipped has it on
    s.createCharacter({ playerName: "The Player", seed: 3 });
    let m = 0, reached = false;
    for (let i = 0; i < 1500 && !reached; i++) {
      if (s.snapshot().live.premiereEntrance?.stage === "done") { reached = true; break; } // checked BEFORE the next player message: nothing has ticked the rush yet
      s.noteMessage({ messageId: `m${m++}` });
      const g = s.getGameState();
      if (g.pending && g.pending.kind !== "ceremony-step") { const r = answerPending(g.pending); if (r) s.submitDecision(r); continue; }
      const stage = s.snapshot().live.premiereEntrance?.stage;
      if (stage && stage !== "done") s.advanceGame();
    }
    expect(reached, "the circle closed by the game's own advance").toBe(true);
    expect(s.snapshot().live.bedRush ?? undefined, "positive control: the state of the report, no rush yet").toBeUndefined();
    expect((s.snapshot().live.beds?.claims ?? []).length, "and no bed claimed").toBe(0);
    s.noteMessage({ messageId: "after-the-fix" });
    expect(s.snapshot().live.bedRush, "its next message starts the rush").toBeDefined();
  }, 300_000);
});
