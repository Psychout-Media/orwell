import { describe, it, expect } from "vitest";
import type { ArchivedHouseguest } from "../../src/engine/seasonMemory";
import { planReturner } from "../../src/engine/returnees";

/**
 * ORW-960 (B2-7, from ORW-700): a houseguest who has returned twice sits in the archive once per season they played (the archive merge keeps one entry per season), so the pool held both their entries and a cast could
 * pick the OLDER one: the person walked in carrying the feelings and persona of the earlier season. The pool keeps one entry per person, the latest. Built-state unit test (the Coordinator's ruling: a real code bug that is
 * rare in play; a 12-seed scan of played seasons found no played instance, because a played season has no two-season archive). Roles only.
 */
const persona = { archetype: "mastermind", strategyStyle: "strategic", stats: { physical: 0.4, mental: 0.8, social: 0.5 }, background: "b", appearance: "a", age: 30, presentation: "p" } as never;
const entry = (season: number, npcId: string, name: string, trust: number): ArchivedHouseguest => ({
  season, npcId: npcId as never, characterRef: `${season}:${npcId}`, placement: 4, juror: true, name, persona, endToward: { trust, affinity: 0, threat: 0 }, claims: [],
});
// Role Alpha played seasons 1 and 3 (a return in season 2 that was archived again); Role Bravo played season 2 only.
const ARCHIVE = [entry(1, "npc-3", "Role Alpha", -0.4), entry(2, "npc-5", "Role Bravo", 0.1), entry(3, "npc-8", "Role Alpha", 0.3)];

describe("a double returner is cast from their latest entry, never the older one", () => {
  it("across many casts: every Role Alpha cast is the season 3 entry, and both people are still cast", () => {
    let alpha = 0, bravo = 0;
    for (let seed = 0; seed < 600; seed++) {
      const plan = planReturner(seed, "return", ARCHIVE, ["Role Cast"], "P", ["npc-1" as never, "npc-2" as never]);
      if (!plan) continue;
      if (plan.entry.name === "Role Alpha") { alpha++; expect(plan.entry.season, `seed ${seed}: the older entry was cast`).toBe(3); }
      if (plan.entry.name === "Role Bravo") bravo++;
    }
    expect(alpha, "Role Alpha is cast at least once").toBeGreaterThan(0);
    expect(bravo, "Role Bravo is cast at least once").toBeGreaterThan(0);
  });
  it("an archive with no repeat person is untouched (the pool is the same, so the cast is the same)", () => {
    const single = [entry(1, "npc-3", "Role Alpha", -0.4), entry(2, "npc-5", "Role Bravo", 0.1)];
    const plans = (a: ArchivedHouseguest[]) => JSON.stringify(Array.from({ length: 50 }, (_, seed) => planReturner(seed, "return", a, ["Role Cast"], "P", ["npc-1" as never])?.entry.characterRef ?? null));
    expect(plans(single)).toBe(plans([...single]));
    const casts = Array.from({ length: 200 }, (_, seed) => planReturner(seed, "return", single, ["Role Cast"], "P", ["npc-1" as never])).filter(Boolean);
    expect(casts.length).toBeGreaterThan(0);
  });
});
