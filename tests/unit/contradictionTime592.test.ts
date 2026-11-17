import { describe, expect, it } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { BeliefStore } from "../../src/engine/beliefStore";
import { sameMoment } from "../../src/engine/claimMoment";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/** ORW-592 (T2-9): the contradiction check reads time. Roles only. */
type G = GameSessionAdapter;
type Live = { week: number; dayNumber?: number; beliefs: BeliefStore };
const liveOf = (s: G) => (s as unknown as { live: Live }).live;
const season = () => {
  const s = new GameSessionRegistry().sandboxFor(`t592-${Math.random()}`).session as G;
  s.setNpcBeliefsEnabled(true); s.setLiesCaughtEnabled(true);
  s.createCharacter({ playerName: "P", seed: 3 });
  const [a, b, c, d] = s.livingIds().filter((id) => id !== PLAYER) as EntityId[];
  return { s, speaker: a!, listener: b!, other: c!, third: d! };
};
const caught = (s: G, listener: EntityId): boolean => (liveOf(s).beliefs?.[listener] ?? []).some((x) => x.kind === "lied-to-me");

describe("ORW-592 contradiction is read at one moment", () => {
  it("sameMoment: votes clash within a week, stances within a day", () => {
    expect(sameMoment({ kind: "voted-to-keep", week: 1, day: 1 }, { kind: "voted-against", week: 1, day: 4 })).toBe(true);
    expect(sameMoment({ kind: "voted-to-keep", week: 1 }, { kind: "voted-against", week: 2 })).toBe(false);
    expect(sameMoment({ kind: "final-two-with", week: 1, day: 1 }, { kind: "going-after", week: 1, day: 3 })).toBe(false);
    expect(sameMoment({ kind: "final-two-with", week: 1, day: 2 }, { kind: "going-after", week: 1, day: 2 })).toBe(true);
  });
  it("an honest change of position weeks later is not a lie", () => {
    const { s, speaker, listener, other, third } = season();
    liveOf(s).week = 1;
    s.tellClaim({ speaker, listener, kind: "final-two-with", subject: other, object: third, isTrue: true, intent: "inform" });
    liveOf(s).week = 3;
    s.tellClaim({ speaker, listener, kind: "going-after", subject: other, object: third, isTrue: true, intent: "inform" });
    expect(caught(s, listener)).toBe(false);
  });
  it("a real contradiction in the same moment is still caught", () => {
    const { s, speaker, listener, other, third } = season();
    liveOf(s).week = 2;
    s.tellClaim({ speaker, listener, kind: "final-two-with", subject: other, object: third, isTrue: true, intent: "inform" });
    s.tellClaim({ speaker, listener, kind: "going-after", subject: other, object: third, isTrue: false, intent: "mislead" });
    expect(caught(s, listener)).toBe(true);
  });
});
