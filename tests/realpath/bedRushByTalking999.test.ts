import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { answerPending } from "../../features/support/answerPending";

/**
 * ORW-999 (Ryne's live report, prod): in the premiere bed rush nobody claimed a bed. His save sat at premiereEntrance.stage "done" with live.bedRush null: the circle had closed, but the rush only ticked inside
 * `advanceGame`, and a player who is talking never produces the lull the front end nudges on, so no heat ever ran while the houseguests drifted between the bedrooms. Now a player MESSAGE during the rush is one heat.
 * Played, not set by hand: seeds 3 and 7; the premiere's entrances and toast are advanced as the game needs, then the player ONLY TALKS (a message each turn, no advanceGame) and the rush must run to its end.
 * Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
type Sess = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function talkOnly(seed: number): { stageDone: boolean; claims: number; living: number; bedRush: { tick: number; done?: boolean; windowEnded?: boolean } | undefined; messagesAfter: number } {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`bedrush999-${seed}`).session as Sess;
  s.createCharacter({ playerName: "The Player", seed });
  let m = 0, after = 0;
  for (let i = 0; i < 1500 && after < 12; i++) {
    s.noteMessage({ messageId: `m${m++}` });
    const live = s.snapshot().live, g = s.getGameState();
    if (g.pending && g.pending.kind !== "ceremony-step") { const r = answerPending(g.pending); if (r) s.submitDecision(r); continue; }
    if (live.premiereEntrance && live.premiereEntrance.stage !== "done") { s.advanceGame(); continue; } // the staged entrances and the toast need the game's own advance
    if (live.premiereEntrance?.stage === "done") after++; // from here the player only talks
  }
  const live = s.snapshot().live;
  return { stageDone: live.premiereEntrance?.stage === "done", claims: (live.beds?.claims ?? []).length, living: s.livingIds().length - 1, bedRush: live.bedRush ?? undefined, messagesAfter: after };
}

describe("a player who only talks still runs the bed rush (played premiere)", () => {
  for (const seed of [3, 7]) {
    it(`seed ${seed}: after the circle closes, messages alone start the rush, houseguests claim beds, and the window ends`, () => {
      const r = talkOnly(seed);
      expect(r.stageDone, "positive control: the premiere reached the closed circle").toBe(true);
      expect(r.messagesAfter, "positive control: the player talked after it").toBeGreaterThanOrEqual(12);
      expect(r.bedRush, "the rush started").toBeDefined();
      expect(r.claims, "houseguests claimed beds").toBeGreaterThan(0);
      expect(r.bedRush!.done || r.bedRush!.windowEnded, "the rush ran to its end").toBe(true);
    }, 300_000);
  }
});
