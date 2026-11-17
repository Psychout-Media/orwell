import { describe, it, expect } from "vitest";
import { REPUTATION, standing, composeWithCredibility, dealWillingnessShift } from "../../src/engine/reputation";
import { CREDIBILITY } from "../../src/engine/credibilityConstants";
import { recordClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { GameSessionRegistry } from "../../src/composition/registry";

/** Feature 0184 (Theme 3 slice 8, part 1): reputations as one observer holds them. Roles only. */
const wrong = (week = 1, confidence = 0.8) => ({ week, confidence });

describe("the pure standing", () => {
  it("nothing heard is 1; more heard never raises it; it is bounded and never zero", () => {
    expect(standing([], 0, 3)).toBe(1);
    const one = standing([wrong()], 0, 1), two = standing([wrong(), wrong()], 0, 1);
    expect(one).toBeLessThan(1); expect(two).toBeLessThan(one);
    expect(standing(Array.from({ length: 400 }, () => wrong(1, 1)), 0, 1)).toBe(REPUTATION.floor);
    expect(REPUTATION.floor).toBeGreaterThan(0);
  });
  it("a heard wrong is half-forgiven with the weeks, never fully", () => {
    expect(standing([wrong(1)], 0, 1)).toBeLessThan(standing([wrong(1)], 0, 20));
    expect(standing([wrong(1)], 0, 41)).toBeLessThan(1);
  });
  it("kept promises soften it, up to a cap, and never above 1", () => {
    const bad = standing([wrong(), wrong()], 0, 1);
    expect(standing([wrong(), wrong()], 1, 1)).toBeGreaterThan(bad);
    expect(standing([wrong(), wrong()], 2, 1)).toBeGreaterThan(standing([wrong(), wrong()], 1, 1));
    expect(standing([wrong(), wrong()], 1000, 1)).toBe(standing([wrong(), wrong()], 1000000, 1));
    expect(standing([], 50, 1)).toBe(1);
  });
  it("composes with credibility as a bounded product, never below the credibility floor", () => {
    expect(composeWithCredibility(1, 1, CREDIBILITY.floor)).toBe(1);
    expect(composeWithCredibility(0.5, 0.5, CREDIBILITY.floor)).toBeCloseTo(0.25, 12);
    expect(composeWithCredibility(CREDIBILITY.floor, REPUTATION.floor, CREDIBILITY.floor)).toBe(CREDIBILITY.floor);
    expect(composeWithCredibility(0.9, 0.9, CREDIBILITY.floor)).toBeGreaterThan(composeWithCredibility(0.9, 0.5, CREDIBILITY.floor));
  });
  it("the deal shift is zero for a clean name and a bounded drag otherwise", () => {
    expect(Math.abs(dealWillingnessShift(1))).toBe(0);
    expect(dealWillingnessShift(0.5)).toBeLessThan(0);
    expect(dealWillingnessShift(0)).toBeGreaterThan(-REPUTATION.dealDrag);
  });
});

type Internals = {
  live: { active: string[]; week: number; playedGame?: boolean; beliefs?: BeliefStore };
  deals: { make(p: [string, string], k: string, t: string, e?: string, w?: number): { status: string; brokenBy?: string } };
  reputationOf(o: string, t: string): number; credibilityOf(o: string, s: string): number;
  snapshot(): unknown; restore(c: unknown): void; setReputationEnabled(on: boolean): void; getMomentPrompt(a: unknown): { systemPrompt: string };
};
const PLAYER = "player";
const start = (seed: number, n: string, on = true) => {
  const sb = new GameSessionRegistry().sandboxFor(`g184-${n}-${seed}-${on}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  (sb.session as unknown as Internals).setReputationEnabled(on);
  sb.session.noteMessage({ messageId: "m1" });
  return { sb, s: sb.session as unknown as Internals };
};
const npcs = (s: Internals): string[] => s.live.active.filter((x) => x.startsWith("npc:"));
const hear = (s: Internals, holder: string, subject: string, nature: "lying" | "betrayal", week = 1) => {
  s.live.beliefs ??= {};
  recordClaim(s.live.beliefs, { holder, kind: "heard-rumor", subject, object: "npc:other", nature, value: true, origin: "told", confidence: 0.8, week });
};

describe("observer-scoped, in a played game", () => {
  it("a snake record lowers the standing for those who heard it and leaves the rest at 1", () => {
    const { s } = start(3, "a"); const [A, B, T] = npcs(s);
    hear(s, A!, T!, "lying"); hear(s, A!, T!, "betrayal", 2);
    expect(s.reputationOf(A!, T!)).toBeLessThan(1);
    expect(s.reputationOf(B!, T!)).toBe(1);
    expect(s.reputationOf(T!, T!)).toBe(1);
  });
  it("a wrong done to the observer is credibility's, not counted again here", () => {
    const { s } = start(3, "b"); const [A, , T] = npcs(s);
    s.live.beliefs ??= {};
    recordClaim(s.live.beliefs, { holder: A!, kind: "lied-to-me", subject: T!, value: true, origin: "witnessed", confidence: 0.9, week: 1 });
    expect(s.reputationOf(A!, T!)).toBe(1);
    expect(s.credibilityOf(A!, T!)).toBeLessThan(1);
  });
  it("a promise the target kept to the observer softens it", () => {
    const { s } = start(3, "c"); const [A, , T] = npcs(s);
    hear(s, A!, T!, "lying"); hear(s, A!, T!, "lying", 2);
    const bad = s.reputationOf(A!, T!);
    s.deals.make([A!, T!], "safety", "terms", undefined, 1).status = "kept";
    expect(s.reputationOf(A!, T!)).toBeGreaterThan(bad);
  });
  it("the player is a target too: what NPCs heard of the player's turns lowers the player's standing", () => {
    const { s } = start(3, "d"); const [A, B] = npcs(s);
    hear(s, A!, PLAYER, "betrayal");
    expect(s.reputationOf(A!, PLAYER)).toBeLessThan(1);
    expect(s.reputationOf(B!, PLAYER)).toBe(1);
  });
  it("flag off, or a game nobody plays: always 1, and the snapshot is byte-identical", () => {
    for (const seed of [3, 11]) {
      const on = start(seed, "e"), off = start(seed, "e", false);
      const [A, , T] = npcs(on.s); hear(off.s, A!, T!, "lying"); hear(on.s, A!, T!, "lying");
      expect(off.s.reputationOf(A!, T!)).toBe(1);
      expect(JSON.stringify(off.s.snapshot())).toBe(JSON.stringify(on.s.snapshot()));
      const headless = new GameSessionRegistry().sandboxFor(`g184-h-${seed}`);
      headless.session.createCharacter({ playerName: "The Player", seed });
      const h = headless.session as unknown as Internals; hear(h, A!, T!, "lying");
      expect(h.reputationOf(A!, T!)).toBe(1);
    }
  });
  it("survives save and restore (it is read from records that are saved)", () => {
    const { s } = start(3, "f"); const [A, , T] = npcs(s); hear(s, A!, T!, "lying");
    const v = s.reputationOf(A!, T!);
    const snap = JSON.parse(JSON.stringify(s.snapshot()));
    const { s: t } = start(3, "f2"); t.restore(snap);
    expect(t.reputationOf(A!, T!)).toBe(v);
  });
  it("the wall: a heard wrong adds no reputation or standing word to any projection, prompt or admin read", async () => {
    const surfaces = async (withClaim: boolean) => {
      const { sb, s } = start(3, withClaim ? "g1" : "g2"); const [A, , T] = npcs(s);
      if (withClaim) { hear(s, A!, T!, "lying"); s.reputationOf(A!, T!); }
      return JSON.stringify([
        await sb.mcp.admin.callTool("inspectNonVaultState", {}),
        await sb.mcp.player.callTool("getGameState", {}),
        s.getMomentPrompt({ moment: "social" }).systemPrompt,
      ]).toLowerCase();
    };
    const [dirty, clean] = [await surfaces(true), await surfaces(false)];
    for (const w of ["reputation", "standing", "snake", "reputationof"]) expect(dirty.split(w).length, w).toBe(clean.split(w).length);
  });
});

type Tellable = { tellClaim(i: unknown): unknown; setNpcBeliefsEnabled(on: boolean): void; setCredibilityEnabled(on: boolean): void; setLiesCaughtEnabled(on: boolean): void; credibilityOf(o: string, s: string): number };
describe("seam 1: how readily a listener credits a speaker's word", () => {
  const told = (on: boolean, heardWrong: boolean, who: "npc" | "player") => {
    const { s } = start(3, `t${on}${heardWrong}${who}`, on);
    const t = s as unknown as Internals & Tellable;
    t.setNpcBeliefsEnabled(true); t.setCredibilityEnabled(true); t.setLiesCaughtEnabled(true);
    const [A, B, C] = npcs(s); const speaker = who === "npc" ? B! : PLAYER;
    if (heardWrong) { hear(s, A!, speaker, "lying"); hear(s, A!, speaker, "betrayal", 2); }
    t.tellClaim({ speaker, listener: A!, kind: "targets-you", subject: C!, isTrue: true, intent: "warn" });
    const bs = s.live.beliefs![A!]!;
    return { conf: bs[bs.length - 1]!.confidence, cred: t.credibilityOf(A!, speaker) };
  };
  it("a speaker the listener heard of as a snake is credited less; a clean one is not; credibility itself is untouched", () => {
    const clean = told(true, false, "npc"), snake = told(true, true, "npc");
    expect(snake.conf).toBeLessThan(clean.conf);
    expect(snake.conf).toBeGreaterThan(0);
    expect(snake.cred).toBe(clean.cred); // no double count: the listener caught no lie of their own
    expect(snake.conf).toBeGreaterThanOrEqual(clean.conf * REPUTATION.floor - 1e-9);
  });
  it("the player as speaker: a player heard of as a turncoat is credited less", () => {
    expect(told(true, true, "player").conf).toBeLessThan(told(true, false, "player").conf);
  });
  it("flag off: the same world is credited exactly as before", () => {
    expect(told(false, true, "npc").conf).toBe(told(false, false, "npc").conf);
  });
});

describe("seam 2: how willing a houseguest is to deal with the player", () => {
  const refusals = (heard: boolean): number => {
    const { s } = start(3, `r${heard}`);
    const r = s as unknown as Internals & { dealConsentRefusal(n: string, k: string): unknown };
    let n = 0;
    for (const id of npcs(s)) {
      if (heard) for (let i = 0; i < 12; i++) hear(s, id, PLAYER, i % 2 ? "lying" : "betrayal", 1 + i % 3);
      if (r.dealConsentRefusal(id, "safety") !== null) n++;
    }
    return n;
  };
  it("a player with a bad name among the house is refused at least as often, never less", () => {
    expect(refusals(true)).toBeGreaterThanOrEqual(refusals(false));
  });
});
