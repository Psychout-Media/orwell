import { describe, it, expect } from "vitest";
import { newLiveSeason, advance, applyDecision, type SeasonCtx, type LiveSeasonState, type BeatEvent } from "../../src/engine/liveSeason";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * 0128 - the THREE-PART Final HOH (behind ORWELL_FINAL_HOH_THREE_PART, default OFF). Part 1 endurance (all three finalists) -> its winner skips to Part 3;
 * Part 2 hybrid (physical+mental) between the two Part-1 losers -> its winner advances; Part 3 quiz between the two part-winners -> the Final HOH, who then
 * personally evicts one of the other two (0045, unchanged). Roles only.
 */
const ctxOf = (over: Partial<SeasonCtx> = {}): SeasonCtx => ({
  player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel: new RelationshipModel(0.5), ...over,
});
function finalThree(finalists: EntityId[]): LiveSeasonState {
  const s = newLiveSeason(finalists);
  s.week = 11; s.beat = "hoh-competition";
  return s;
}
/** Drive the Final-3 HOH until the structural beat leaves `hoh-competition` (answering the player's cards with `compete`). Returns every event. */
function drive(s: LiveSeasonState, ctx: SeasonCtx, rng: SeededRandom, onPending?: (kind: string, field: EntityId[]) => void): BeatEvent[] {
  const evs: BeatEvent[] = [];
  for (let i = 0; i < 400 && s.beat === "hoh-competition"; i++) {
    const ev = advance(s, ctx, rng);
    if (ev) evs.push(ev);
    if (s.pending) {
      const p = s.pending as { kind: string; stillIn?: EntityId[] };
      onPending?.(p.kind, p.stillIn ?? []);
      const ev2 = applyDecision(s, { kind: "comp-round", intent: "compete" } as never, ctx, rng);
      if (ev2) evs.push(ev2);
    }
  }
  return evs;
}
const partEvents = (evs: BeatEvent[]) => evs.filter((e) => e.beat === "final-hoh-part");

describe("0128 three-part Final HOH", () => {
  it("flag OFF: the single-comp 0045 path - one crown, no part events, nothing persisted", () => {
    const s = finalThree([npc(1), npc(2), npc(3)]);
    const evs = drive(s, ctxOf(), new SeededRandom(5));
    expect(partEvents(evs)).toHaveLength(0);
    expect(evs.filter((e) => e.beat === "hoh-competition")).toHaveLength(1);
    expect(s.beat).toBe("final-eviction");
    expect(s.finalHohPart).toBeUndefined();
  });

  it("flag ON (all-NPC finalists): Part 1 all three, Part 2 the two Part-1 losers, Part 3 the two part-winners; win two to win", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const f = [npc(1), npc(2), npc(3)];
      const s = finalThree(f);
      const ctx = ctxOf({ finalHohThreePart: true });
      const rng = new SeededRandom(seed);
      const evs = drive(s, ctx, rng);
      const parts = partEvents(evs);
      expect(parts, `seed ${seed}`).toHaveLength(2);
      // a part event's participants = [winner, ...the rest of that part's FIELD]
      const p1 = parts[0]!.participants[0]!, p2 = parts[1]!.participants[0]!;
      expect(parts[0]!.participants.slice().sort()).toEqual(f.slice().sort());                       // Part 1: all three
      expect(parts[1]!.participants.slice().sort()).toEqual(f.filter((x) => x !== p1).sort());        // Part 2: the two Part-1 losers
      expect(p1).not.toBe(p2);
      const loserBoth = f.find((x) => x !== p1 && x !== p2)!;
      expect(s.hoh, `seed ${seed}`).not.toBe(loserBoth);                                 // lose two and you're out
      expect([p1, p2]).toContain(s.hoh);                                                  // Part 3 = the two part-winners, so the Final HOH won a prior part too
      expect(s.beat).toBe("final-eviction");                                              // 0045 unchanged: the HOH then evicts one of the other two
      expect(evs.filter((e) => e.beat === "hoh-competition")).toHaveLength(1);           // exactly one HOH crown event (Part 3)
      expect(s.finalHohPart).toBeUndefined();                                             // tournament state cleared once Part 3 crowns
    }
  });

  it("is seed-deterministic and engine-decided (the same seed crowns the same Final HOH)", () => {
    const run = (): EntityId => { const s = finalThree([npc(1), npc(2), npc(3)]); drive(s, ctxOf({ finalHohThreePart: true }), new SeededRandom(9)); return s.hoh!; };
    expect(run()).toBe(run());
  });

  it("player agency: the player is asked per part they are IN; winning Part 1 rests them through Part 2", () => {
    let sawRest = false, sawBoth = false;
    for (let seed = 1; seed <= 60 && !(sawRest && sawBoth); seed++) {
      const s = finalThree([PLAYER, npc(1), npc(2)]);
      const asked: EntityId[][] = [];
      const evs = drive(s, ctxOf({ finalHohThreePart: true }), new SeededRandom(seed), (kind, field) => { if (kind === "comp-round") asked.push(field); });
      const parts = partEvents(evs);
      expect(parts).toHaveLength(2);
      const p1 = parts[0]!.participants[0]!;
      if (p1 === PLAYER) {
        sawRest = true;
        expect(asked).toHaveLength(2);                          // Part 1 and Part 3 only
        expect(asked.every((a) => a.includes(PLAYER))).toBe(true);
      } else {
        // the player lost Part 1: they play Part 2, and Part 3 only if they won Part 2
        const p2 = parts[1]!.participants[0]!;
        expect(asked.length).toBe(p2 === PLAYER ? 3 : 2);
        if (p2 === PLAYER) sawBoth = true;
      }
      expect(s.beat).toBe("final-eviction");
    }
    expect(sawRest, "a seed where the player wins Part 1").toBe(true);
    expect(sawBoth, "a seed where the player plays all three parts").toBe(true);
  });

  it("a mid-tournament restart resumes: the persisted part pointer + winners survive a JSON round-trip", () => {
    const f = [npc(1), npc(2), npc(3)];
    const ctx = ctxOf({ finalHohThreePart: true });
    const ref = finalThree(f); drive(ref, ctx, new SeededRandom(4));
    const s = finalThree(f);
    const rng = new SeededRandom(4);
    let restored: LiveSeasonState | undefined;
    for (let i = 0; i < 400 && s.beat === "hoh-competition"; i++) {
      const ev = advance(s, ctx, rng);
      if (ev?.beat === "final-hoh-part" && !restored) restored = JSON.parse(JSON.stringify(s)) as LiveSeasonState;
    }
    expect(restored, "reached the end of Part 1").toBeDefined();
    expect(restored!.finalHohPart).toBe(2);
    expect(restored!.p1Winner).toBeDefined();
    // The restored state is advanced with the SAME rng position the original had after Part 1 would require; here we only assert the pointer resumes at Part 2.
    const rng2 = new SeededRandom(4);
    const resumed = restored!;
    // burn the draws the original consumed up to the end of Part 1 by replaying on a scratch copy
    const scratch = finalThree(f); const r3 = new SeededRandom(4);
    while (scratch.finalHohPart !== 2) advance(scratch, ctx, r3);
    void rng2;
    for (let i = 0; i < 400 && resumed.beat === "hoh-competition"; i++) advance(resumed, ctx, r3);
    expect(resumed.hoh).toBe(ref.hoh);
  });

  it("announces Part 1 and Part 2 (a chyron fact each) and Part 3 as the new Head of Household", async () => {
    const { buildBeatAnnouncements, announcementHeadline } = await import("../../src/engine/beatAnnouncement");
    const f = [npc(1), npc(2), npc(3)];
    const s = finalThree(f);
    const ctx = ctxOf({ finalHohThreePart: true });
    const rng = new SeededRandom(2);
    const heads: string[] = [];
    for (let i = 0; i < 400 && s.beat === "hoh-competition"; i++) {
      const ev = advance(s, ctx, rng);
      if (ev?.beat === "final-hoh-part" || ev?.beat === "hoh-competition") for (const a of buildBeatAnnouncements(ev, s)) heads.push(announcementHeadline(a, (id) => `[${id}]`));
    }
    expect(heads).toHaveLength(3);
    expect(heads[0]).toMatch(/wins Part 1 of the final Head of Household/);
    expect(heads[1]).toMatch(/wins Part 2 of the final Head of Household/);
    expect(heads[2]).toMatch(/is the new Head of Household/);
  });

  it("Part 2 is a physical+mental HYBRID (the blend is applied without the 0127 flag)", () => {
    // npc(1) wins Part 1 by construction is not controllable, so assert on the Part-2 FIELD of whichever two lose: a one-dimensional physical specialist vs a well-rounded
    // mental one. Pure physical would make the specialist win Part 2 nearly always; the blend lets the well-rounded finalist win a clear share.
    const stats = (id: EntityId) => (id === npc(1) ? { physical: 0.95, mental: 0.05, social: 0.5 } : id === npc(2) ? { physical: 0.55, mental: 0.95, social: 0.5 } : { physical: 0.99, mental: 0.1, social: 0.5 });
    let specialistWins = 0, roundedWins = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const s = finalThree([npc(1), npc(2), npc(3)]);
      const evs = drive(s, ctxOf({ finalHohThreePart: true, statsOf: stats }), new SeededRandom(seed));
      const p = partEvents(evs);
      const f2 = p[1]!.participants;
      if (f2.includes(npc(1)) && f2.includes(npc(2))) { if (p[1]!.participants[0] === npc(1)) specialistWins++; else roundedWins++; }
    }
    expect(specialistWins + roundedWins).toBeGreaterThan(20);
    expect(roundedWins / (specialistWins + roundedWins), "the mental secondary lifts the well-rounded finalist").toBeGreaterThan(0.3);
  });
});
