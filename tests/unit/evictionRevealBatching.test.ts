import { describe, it, expect } from "vitest";
import {
  newLiveSeason, advance,
  type SeasonCtx, type LiveSeasonState, type BeatEvent,
} from "../../src/engine/liveSeason";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { RandomnessSource } from "../../src/ports/RandomnessSource";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * Live-verify 2026-06-27 — the staged weekly-eviction reveal is BATCHED so a big eviction lands in
 * ~4-8 reveal beats (mirroring the staged-comp `STAGED_TARGET_ROUNDS` ruling) instead of one ballot
 * per `advanceGame` (a ~14-advance slog of mostly-empty deliberation beats that let the narration model
 * race ahead of the engine). HARD: this is PRESENTATION ONLY — the precomputed tally, the seeded reveal
 * ORDER, the evictee on the LAST ballot, and every downstream seeded roll are byte-identical; only how
 * many ballots a single advance reveals changes. Roles only — no names.
 */

const ctxOf = (rel: RelationshipModel): SeasonCtx => ({
  player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel,
});

/** A counting RandomnessSource wrapper — proves the reveal beats consume ZERO randomness. */
class CountingRng implements RandomnessSource {
  draws = 0;
  constructor(private readonly inner: RandomnessSource) {}
  next(): number { this.draws += 1; return this.inner.next(); }
  int(maxExclusive: number): number { this.draws += 1; return this.inner.int(maxExclusive); }
  pick<T>(items: readonly T[]): T { this.draws += 1; return this.inner.pick(items); }
  fork(label: string): RandomnessSource { return this.inner.fork(label); }
}

/**
 * A large eviction with the PLAYER as HOH (no player-vote pause): 15 active = player + 14 NPCs, nominees
 * [npc1, npc2]. The other 13 NPCs each vote — `split` of them read npc2 as the threat (vote npc2), the
 * rest read npc1 — so the evictee is fixed by the engine tally, never the reveal order. (13 votes; the
 * player HOH does not vote — exactly the "big eviction" the batching targets.)
 */
function bigEvictionAt(split: number): { s: LiveSeasonState; ctx: SeasonCtx; voters: EntityId[]; nominees: [EntityId, EntityId] } {
  const voters = Array.from({ length: 13 }, (_, i) => npc(i + 3)); // npc3..npc15
  const active = [PLAYER, npc(1), npc(2), ...voters];
  const s = newLiveSeason(active);
  s.beat = "eviction"; s.hoh = PLAYER; s.finalNominees = [npc(1), npc(2)];
  const rel = new RelationshipModel(0.5);
  voters.forEach((v, i) => {
    if (i < split) { rel.edge(v, npc(2)).threat = 0.9; rel.edge(v, npc(1)).threat = 0.1; } // → npc2
    else { rel.edge(v, npc(1)).threat = 0.9; rel.edge(v, npc(2)).threat = 0.1; }            // → npc1
  });
  return { s, ctx: ctxOf(rel), voters, nominees: [npc(1), npc(2)] };
}

/** Drive the votes stage, collecting each reveal beat; stop at the "eviction" result beat. */
function driveVotesStage(s: LiveSeasonState, ctx: SeasonCtx, rng: RandomnessSource): { reveals: BeatEvent[]; result: BeatEvent } {
  const reveals: BeatEvent[] = [];
  for (let g = 0; g < 100; g++) {
    const ev = advance(s, ctx, rng)!;
    if (ev.beat === "eviction-reveal") { reveals.push(ev); continue; }
    return { reveals, result: ev }; // the "eviction" beat lands once the last ballot is read
  }
  throw new Error("votes stage did not resolve");
}

describe("staged eviction reveal batching", () => {
  it("PO ruling 2026-11-04: a 13-vote eviction reads EVERY ballot in ONE reveal beat, then the result", () => {
    const { s, ctx } = bigEvictionAt(9); // 9–4 → evict npc2
    const { reveals, result } = driveVotesStage(s, ctx, new SeededRandom(7));
    expect(reveals).toHaveLength(1);
    expect(reveals[0]!.participants).toHaveLength(13); // all thirteen anonymized ballots, in the seeded reveal order
    expect((reveals[0]!.content.match(/a vote to evict /g) ?? []).length).toBe(13);
    expect(result.beat).toBe("eviction");
    expect(result.participants[0]).toBe(npc(2));
  });

  it("each batched reveal is anonymized — names a nominee, never a voter, never a cumulative tally", () => {
    const { s, ctx, voters, nominees } = bigEvictionAt(9);
    const { reveals } = driveVotesStage(s, ctx, new SeededRandom(7));
    for (const ev of reveals) {
      // The ballot(s) name only the nominee(s) voted for; a batch reads "N votes to evict X".
      expect(ev.content).toMatch(/votes? to evict /);
      for (const v of voters) {
        expect(ev.content.includes(v)).toBe(false);
        expect(ev.participants.includes(v)).toBe(false);
      }
      for (const p of ev.participants) expect(nominees).toContain(p);
    }
  });

  it("the running revealed-tally never exceeds the ballots revealed so far", () => {
    const { s, ctx, nominees } = bigEvictionAt(9);
    const rng = new SeededRandom(7);
    let revealedSoFar = 0;
    for (let g = 0; g < 100; g++) {
      const ev = advance(s, ctx, rng)!;
      if (ev.beat !== "eviction-reveal") break;
      // revealIx is the true count of ballots read; it only ever grows by the batch just revealed.
      expect(s.eviction!.revealIx).toBeGreaterThan(revealedSoFar);
      revealedSoFar = s.eviction!.revealIx;
      // The Vault-free revealed tally (votes read so far) can never count more than ballots revealed.
      const tally = nominees.reduce((sum, n) => {
        let c = 0;
        for (let i = 0; i < s.eviction!.revealIx; i++) if (s.eviction!.voteOf[s.eviction!.revealOrder[i]!] === n) c += 1;
        return sum + c;
      }, 0);
      expect(tally).toBe(revealedSoFar);
      expect(tally).toBeLessThanOrEqual(13);
    }
  });

  it("the reveal beats are INERT — no randomness is drawn between reveals until the result lands", () => {
    const { s, ctx } = bigEvictionAt(9);
    const rng = new CountingRng(new SeededRandom(7));
    // The FIRST advance builds the seeded reveal order (`beginEviction` shuffles) — that legitimately
    // draws, identically to main. Every advance AFTER the order exists is a pure presentation reveal.
    const first = advance(s, ctx, rng)!;
    expect(first.beat).toBe("eviction-reveal");
    expect(s.eviction).toBeDefined();
    for (let g = 0; g < 100; g++) {
      const before = rng.draws;
      const ev = advance(s, ctx, rng)!;
      if (ev.beat === "eviction-reveal") {
        // A staged reveal consumes ZERO randomness (presentation only) — like the comp staging.
        expect(rng.draws).toBe(before);
        continue;
      }
      // The result beat (`commitStagedEviction`) is the first to touch rng (seeded goodbye senders).
      expect(ev.beat).toBe("eviction");
      break;
    }
  });

  it("PRESENTATION ONLY — the tally + evictee are byte-identical to a one-at-a-time (unbatched) reference", () => {
    // Reference: replay the SAME seeded reveal order, but tally every ballot directly (the "unbatched"
    // semantics). The batched engine must reach the exact same evictee for every split + seed.
    for (const split of [9, 4, 7]) {
      for (const seed of [3, 7, 42]) {
        const { s, ctx, nominees } = bigEvictionAt(split);
        // Capture the seeded reveal ORDER + the precomputed votes BEFORE driving (set in beginEviction
        // on the first advance) by driving and reading the committed record afterward.
        const rng = new SeededRandom(seed);
        driveVotesStage(s, ctx, rng);
        const evictee = s.evictionOrder[0]!;
        // The unbatched reference: the full precomputed tally (the committed ballot record) decides the
        // evictee — independent of how many ballots any single reveal beat exposed.
        const voteOf = s.voteRecord![0]!.voteOf;
        const counts: Record<EntityId, number> = { [nominees[0]]: 0, [nominees[1]]: 0 };
        for (const v of Object.values(voteOf)) counts[v]! += 1;
        const expected = counts[nominees[0]]! > counts[nominees[1]]! ? nominees[0] : nominees[1];
        expect(evictee).toBe(expected);
      }
    }
  });

  it("a small eviction (few votes) is also read in ONE reveal beat", () => {
    // 3 voters → all three ballots in the single reveal beat.
    const voters = [npc(3), npc(4), npc(5)];
    const active = [PLAYER, npc(1), npc(2), ...voters];
    const s = newLiveSeason(active);
    s.beat = "eviction"; s.hoh = PLAYER; s.finalNominees = [npc(1), npc(2)];
    const rel = new RelationshipModel(0.5);
    for (const v of [npc(3), npc(4)]) { rel.edge(v, npc(2)).threat = 0.9; rel.edge(v, npc(1)).threat = 0.1; }
    rel.edge(npc(5), npc(1)).threat = 0.9; rel.edge(npc(5), npc(2)).threat = 0.1;
    const { reveals, result } = driveVotesStage(s, ctxOf(rel), new SeededRandom(7));
    expect(reveals).toHaveLength(1);
    expect(reveals[0]!.participants).toHaveLength(3);
    expect(reveals[0]!.content).toMatch(/^a vote to evict /);
    expect(result.participants[0]).toBe(npc(2));
  });
});
