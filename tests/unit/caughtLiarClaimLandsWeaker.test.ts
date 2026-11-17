import { describe, expect, it } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { BeliefStore } from "../../src/engine/beliefStore";
import { tellClaim, type ClaimContext, type ClaimLog } from "../../src/engine/spokenClaims";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/** ORW-587 (T2-4): a speaker the listener caught lying lands weaker with that listener. Roles only. */
const [SPEAKER, LISTENER, SUBJECT] = ["npc:a", "npc:b", "npc:c"];
const base: ClaimContext = { week: 2, living: [PLAYER, SPEAKER, LISTENER, SUBJECT], trustOf: () => 0.8 };
const tell = (cred?: number): number => {
  const log: ClaimLog = { seq: 0, items: [] }; const beliefs: BeliefStore = {};
  tellClaim(log, beliefs, { speaker: SPEAKER, listener: LISTENER, kind: "targets-you", subject: SUBJECT, isTrue: true, intent: "warn" },
    cred === undefined ? base : { ...base, credibility: () => cred });
  return beliefs[LISTENER]![0]!.confidence;
};

describe("ORW-587 a caught liar lands weaker (pure)", () => {
  it("scales confidence by credibility: monotone, bounded, unchanged at 1 and when absent", () => {
    const none = tell(); 
    expect(tell(1)).toBe(none);
    expect(tell(0.5)).toBeLessThan(none);
    expect(tell(0.2)).toBeLessThan(tell(0.5));
    expect(tell(0.05)).toBeGreaterThan(0);
    expect(tell(7)).toBe(none); expect(tell(-3)).toBeGreaterThanOrEqual(0);
  });
});

type G = GameSessionAdapter;
const liveOf = (s: G) => (s as unknown as { live: { playedGame?: boolean; beliefs: BeliefStore } }).live;
const season = (played: boolean): { s: G; a: EntityId; b: EntityId; c: EntityId } => {
  const s = new GameSessionRegistry().sandboxFor(`liar-${Math.random()}`).session as G;
  s.setNpcBeliefsEnabled(true); s.setCredibilityEnabled(true); s.setLiesCaughtEnabled(true);
  s.createCharacter({ playerName: "P", seed: 3 });
  if (played) liveOf(s).playedGame = true;
  const [a, b, c] = s.livingIds().filter((id) => id !== PLAYER);
  return { s, a: a!, b: b!, c: c! };
};
const told = (s: G, speaker: EntityId, listener: EntityId, subject: EntityId): number => {
  s.tellClaim({ speaker, listener, kind: "targets-you", subject, isTrue: true, intent: "warn" });
  const bs = liveOf(s).beliefs[listener]!;
  return bs[bs.length - 1]!.confidence;
};

describe("ORW-587 through the adapter", () => {
  it("the hearer who caught the liar holds the next claim weaker; a hearer who did not is unaffected; played games only", () => {
    const { s, a, b, c } = season(true);
    const d = s.livingIds().filter((id) => id !== PLAYER && ![a, b, c].includes(id))[0]!;
    const before = told(s, a, b, c);
    (s as unknown as { writeLieCaught(h: EntityId, l: EntityId, conf: number, how: string): void }).writeLieCaught(b, a, 0.9, "told");
    expect(s.credibilityOf(b, a)).toBeLessThan(1);
    expect(s.credibilityOf(d, a)).toBe(1);
    const after = told(s, a, b, d);
    expect(JSON.stringify(liveOf(s).beliefs[b])).not.toMatch(/credib/i); // no credibility number is stored on the belief
    expect(after).toBeLessThan(before);
    expect(told(s, a, c, d)).toBeCloseTo(told(season(true).s, a, c, d), 10); // unaffected hearer: same as a never-caught world
  });
  it("headless (not a played game): byte-identical, the caught liar is not discounted", () => {
    const x = season(false), y = season(false);
    (x.s as unknown as { writeLieCaught(h: EntityId, l: EntityId, conf: number, how: string): void }).writeLieCaught(x.b, x.a, 0.9, "told");
    expect(told(x.s, x.a, x.b, x.c)).toBe(told(y.s, y.a, y.b, y.c));
  });
  it("the player as speaker: an NPC who caught the player lying weighs the player's word less", () => {
    const { s, a, b } = season(true);
    (s as unknown as { writeLieCaught(h: EntityId, l: EntityId, conf: number, how: string): void }).writeLieCaught(a, PLAYER, 0.9, "told");
    const control = season(true);
    const caught = told(s, PLAYER, a, b);
    const never = told(control.s, PLAYER, control.a, control.b);
    expect(caught).toBeLessThan(never);
    expect(s.credibilityOf(a, PLAYER)).toBeLessThan(1);
  });
});
