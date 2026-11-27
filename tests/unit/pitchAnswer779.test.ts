import { describe, it, expect } from "vitest";
import { playedGame, type PlayedGame } from "../support/playedGame";
import { PITCH_ANSWER, pitchAgreeChance, pitchAnswer } from "../../src/engine/lobbying";
import { PLAYER, type EntityId } from "../../src/domain/ids";
import type { RelationshipModel } from "../../src/engine/relationships";

/**
 * ORW-779 (Ryne 2026-11-26: "Social play can definitely work"): the player's plea for safety gets a private answer from the Head of Household. A yes they mean keeps the player off the block;
 * it is never certain, a distrustful or hostile HOH never says it, and a yes can be faked. Played games only. The HOH's trust is set by hand. Roles only.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe("ORW-779: the answer to a plea for safety", () => {
  const warm = { trust: 0.8, threat: 0.3, cunning: 0.5, hostile: false };
  it("is never certain, and never yes from a hostile or distrustful head of household", () => {
    expect(pitchAgreeChance(warm)).toBeGreaterThan(0.5);
    expect(pitchAgreeChance({ ...warm, trust: 1, threat: 0 })).toBeLessThanOrEqual(PITCH_ANSWER.chanceAtFloor + PITCH_ANSWER.chanceAdded);
    expect(PITCH_ANSWER.chanceAtFloor + PITCH_ANSWER.chanceAdded).toBeLessThan(1);
    expect(pitchAgreeChance({ ...warm, hostile: true })).toBe(0);
    expect(pitchAgreeChance({ ...warm, trust: PITCH_ANSWER.trustFloor - 0.01 })).toBe(0);
    expect(pitchAgreeChance({ ...warm, threat: 0.95 }), "a feared player is harder to promise").toBeLessThan(pitchAgreeChance(warm));
  });

  it("more trust only helps, and a cunning head of household can say yes without meaning it", () => {
    expect(pitchAgreeChance(warm)).toBeGreaterThan(pitchAgreeChance({ ...warm, trust: 0.35 }));
    expect(pitchAnswer({ ...warm, cunning: 1 }, { agree: 0, fake: 0 })).toEqual({ agreed: true, sincere: false });
    expect(pitchAnswer({ ...warm, cunning: 0 }, { agree: 0, fake: 0 })).toEqual({ agreed: true, sincere: true });
    expect(pitchAnswer(warm, { agree: 0.999, fake: 0.999 })).toEqual({ agreed: false, sincere: false });
  });
});

function moment(seed: number, trust: number): { g: PlayedGame; s: Any; hoh: EntityId } {
  const g = playedGame({ seed, user: `plea779-${seed}` });
  const s: Any = g.s;
  g.playUntil(() => {
    const l = s.live;
    return !!l && l.beat === "nominations" && !l.nominees && !l.pending && !l.ceremony && !!l.hoh && l.hoh !== PLAYER && l.active.includes(PLAYER) && l.active.length > 4;
  }, 6000, "an NPC head of household about to nominate");
  const hoh = s.live.hoh as EntityId;
  const e = (s.rel as RelationshipModel).edge(hoh, PLAYER);
  e.trust = trust;
  e.threat = 0.3;
  return { g, s, hoh };
}
const plead = (s: Any, hoh: EntityId): void => { s.notePlayerTalk([hoh], "strategy", undefined); };

describe("ORW-779: a plea in a played game", () => {
  it("a yes the head of household means keeps the player off the block", () => {
    let checked = 0;
    for (let seed = 1; seed <= 20 && checked < 2; seed++) {
      const { g, s, hoh } = moment(seed, 0.8);
      plead(s, hoh);
      if (!s.pitchShields(PLAYER, hoh)) continue;
      expect(s.live.pitchAnswer).toMatchObject({ hoh, agreed: true, sincere: true });
      const first = JSON.stringify(s.live.pitchAnswer);
      plead(s, hoh);
      expect(JSON.stringify(s.live.pitchAnswer), "asking again never re-rolls a yes").toBe(first);
      g.playUntil(() => !!s.live.nominees, 600, "the nominations");
      expect(s.live.nominees, `seed ${seed}`).not.toContain(PLAYER);
      checked++;
    }
    expect(checked, "some head of household said yes").toBeGreaterThan(0);
  }, 600_000);

  it("a distrustful head of household is not moved, and a game nobody is playing records no answer", () => {
    const { s, hoh } = moment(1, 0.1);
    plead(s, hoh);
    expect(s.live.pitchAnswer).toMatchObject({ agreed: false, sincere: false });
    expect(s.pitchShields(PLAYER, hoh)).toBe(false);
    const other = moment(1, 0.8);
    other.s.live.playedGame = false;
    plead(other.s, other.hoh);
    expect(other.s.live.pitchAnswer).toBeUndefined();
  }, 600_000);
});
