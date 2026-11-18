import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { deriveNotoriety, notorietyBias, type OpenSetSeasonOutcome } from "../../src/engine/notoriety";
import { NOTORIETY } from "../../src/engine/notorietyConstants";
import { recordClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { PLAYER } from "../../src/domain/ids";
import type { UserNotorietyStore } from "../../src/ports/UserNotorietyStore";

/** 0208 B2 (ORW-664, flag ORWELL_SEASON_MEMORY): a returning player's reputation walks in deeper - the house's heard record of broken word feeds the carried treachery. Roles only; step prefix "reputation:". */
const BASE: OpenSetSeasonOutcome = { placement: 3, castSize: 16, playerCompWins: 1, playerEvictionRoles: [], reachedJury: true, reachedFinalTwo: false, juryVoteShare: 0 };

describe("reputation: the pure derivation", () => {
  it("an absent or zero heard record changes nothing (byte-identical to today)", () => {
    expect(deriveNotoriety({ ...BASE, houseHeardWrong: 0 })).toEqual(deriveNotoriety(BASE));
  });
  it("a heard record of broken word raises the carried treachery, bounded, and the legend names the name they carry", () => {
    const quiet = deriveNotoriety(BASE), loud = deriveNotoriety({ ...BASE, houseHeardWrong: 0.4 });
    expect(loud.reputation.treachery).toBeGreaterThan(quiet.reputation.treachery);
    expect(deriveNotoriety({ ...BASE, houseHeardWrong: 9 }).reputation.treachery).toBeLessThanOrEqual(1);
    expect(loud.legendBeats.length).toBeGreaterThan(quiet.legendBeats.length);
    expect(loud.legendBeats.length).toBeLessThanOrEqual(NOTORIETY.maxLegendBeats);
    expect(deriveNotoriety({ ...BASE, houseHeardWrong: NOTORIETY.brokenWordKnownAt / 2 }).legendBeats).toEqual(quiet.legendBeats);
  });
  it("the day-one lean it feeds is warier: threat up, trust down, same recognition", () => {
    const quiet = deriveNotoriety(BASE), loud = deriveNotoriety({ ...BASE, houseHeardWrong: 0.4 });
    expect(notorietyBias(loud, "loyalist", "threat", 1)).toBeGreaterThan(notorietyBias(quiet, "loyalist", "threat", 1));
    expect(notorietyBias(loud, "loyalist", "trust", 1)).toBeLessThan(notorietyBias(quiet, "loyalist", "trust", 1));
  });
});

type Internals = {
  live: { active: string[]; week: number; finished?: boolean; winner?: string; playedGame?: boolean; beliefs?: BeliefStore };
  openSetOutcome(): OpenSetSeasonOutcome | null; setSeasonMemoryEnabled(on: boolean): void; snapshot(): unknown;
  setNotoriety(n: unknown): void; carriedNotoriety(): unknown;
};
const play = (seed: number, user: string, on = true) => {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const s = sb.session as unknown as Internals;
  s.setSeasonMemoryEnabled(on);
  sb.session.noteMessage({ messageId: "m1" });
  return { reg, sb, s };
};
const npcs = (s: Internals): string[] => s.live.active.filter((x) => x.startsWith("npc:"));
const heard = (s: Internals, holder: string, nature: string, sentinel?: string) => {
  s.live.beliefs ??= {};
  recordClaim(s.live.beliefs, { holder, kind: "heard-rumor", subject: PLAYER, object: "npc:other", nature, value: true, origin: "told", confidence: 0.9, week: 1, ...(sentinel ? { content: sentinel } : {}) } as never);
};
const finish = (s: Internals) => { s.live.finished = true; s.live.winner = "npc:other"; };

describe("reputation: the season-end record in a played game", () => {
  it("the mean of what the cast heard of the player's wrongs becomes the bounded record; a public-fact positive control", () => {
    const { s } = play(5, "r-a");
    finish(s);
    expect(s.openSetOutcome()!.houseHeardWrong).toBe(0);
    for (const n of npcs(s).slice(0, 5)) { heard(s, n, "lying"); heard(s, n, "betrayal"); }
    const v = s.openSetOutcome()!.houseHeardWrong!;
    expect(v).toBeGreaterThan(0.05);
    expect(v).toBeLessThan(1);
  });
  it("a claim that names no wrong, and any hidden-fact sentinel, never reaches the record or the summary", () => {
    const SENT = "SENTINEL-HIDDEN-FACT";
    const { s } = play(5, "r-b");
    finish(s);
    for (const n of npcs(s)) heard(s, n, "kindness", SENT);
    const o = s.openSetOutcome()!;
    expect(o.houseHeardWrong).toBe(0);
    expect(JSON.stringify([o, deriveNotoriety(o)])).not.toContain(SENT);
  });
  it("flag off, or a game nobody plays: the record is absent (today's outcome)", () => {
    const off = play(5, "r-c", false); finish(off.s);
    for (const n of npcs(off.s)) heard(off.s, n, "lying");
    expect(off.s.openSetOutcome()).not.toHaveProperty("houseHeardWrong");
    const headless = new GameSessionRegistry().sandboxFor("r-d");
    headless.session.createCharacter({ playerName: "The Player", seed: 5 });
    const h = headless.session as unknown as Internals; finish(h);
    expect(h.openSetOutcome()).not.toHaveProperty("houseHeardWrong");
  });
  it("it is deterministic for a seed", () => {
    const one = () => { const { s } = play(7, "r-e"); finish(s); for (const n of npcs(s).slice(0, 3)) heard(s, n, "lying"); return s.openSetOutcome(); };
    expect(one()).toEqual(one());
  });
});

describe("reputation: only a return carries it; the store deepens, never thins", () => {
  it("the dead season's record accumulates per user at the cutover; a different user never sees it", () => {
    const { reg, s } = play(5, "r-f");
    finish(s);
    for (const n of npcs(s)) { heard(s, n, "lying"); heard(s, n, "betrayal"); }
    reg.resetUser("r-f");
    const store = (reg as unknown as { notorietyStore: UserNotorietyStore }).notorietyStore;
    const mine = store.read("r-f")!;
    expect(mine.reputation.treachery).toBeGreaterThan(0);
    expect(store.read("r-other")).toBeNull();
    const again = deriveNotoriety({ ...BASE, houseHeardWrong: 0 });
    expect(mine.reputation.treachery).toBeGreaterThan(again.reputation.treachery);
  });
  it("a new start folds nothing: the same seed with and without the flag is byte-identical when no notoriety is carried", () => {
    const a = play(9, "r-g", true), b = play(9, "r-g2", false);
    expect(a.s.carriedNotoriety()).toBeNull();
    expect(JSON.stringify(a.s.snapshot())).toBe(JSON.stringify(b.s.snapshot()));
  });
  it("a returning player with a heard record arrives warier than one without (same seed, bounded)", () => {
    const edges = (rec: number) => {
      const reg = new GameSessionRegistry(); const sb = reg.sandboxFor(`r-h${rec}`);
      (sb.session as unknown as Internals).setNotoriety(deriveNotoriety({ ...BASE, houseHeardWrong: rec }));
      sb.session.createCharacter({ playerName: "The Player", seed: 11 });
      const ids = (sb.session.snapshot().house?.npcs ?? []).map((n) => n.id);
      return ids.map((id) => sb.engine.relationships.edge(id, PLAYER).threat);
    };
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(edges(0.5))).toBeGreaterThan(mean(edges(0)));
    for (const t of edges(1)) { expect(t).toBeGreaterThanOrEqual(0); expect(t).toBeLessThanOrEqual(1); }
  });
});
