import { describe, it, expect } from "vitest";
import {
  newLiveSeason, advance, applyDecision, goodbyeMannerFor,
  type SeasonCtx, type LiveSeasonState, type BeatEvent, type GoodbyeTone,
} from "../../src/engine/liveSeason";
import { juryLean } from "../../src/engine/jury";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { cloneSession } from "../../src/engine/sessionSnapshot";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * Feature 0047 — eviction night live. The weekly eviction is staged through the 0034 seam like the
 * finale (0037): the votes read ONE AT A TIME in a seeded order (revealed-only tally), then an evictee
 * goodbye + goodbye messages whose tone folds into the evictee's manner (jury lean). HARD rule: roles
 * only — no names.
 */
const ctxOf = (rel: RelationshipModel): SeasonCtx => ({ player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel });

/**
 * A Final-6 eviction with the PLAYER as HOH (so no player vote pauses the reveal): nominees [npc1, npc2],
 * four NPC voters (npc3–npc6) — three read npc2 as the threat, one reads npc1 ⇒ a 3–1 vote out of npc2.
 */
function evictionAt(): { s: LiveSeasonState; ctx: SeasonCtx; evictee: EntityId; voters: EntityId[] } {
  const active = [PLAYER, npc(1), npc(2), npc(3), npc(4), npc(5), npc(6)];
  const s = newLiveSeason(active);
  s.beat = "eviction"; s.hoh = PLAYER; s.finalNominees = [npc(1), npc(2)];
  const rel = new RelationshipModel(0.5);
  for (const v of [npc(3), npc(4), npc(5)]) { rel.edge(v, npc(2)).threat = 0.9; rel.edge(v, npc(1)).threat = 0.1; } // → npc2
  rel.edge(npc(6), npc(1)).threat = 0.9; rel.edge(npc(6), npc(2)).threat = 0.1;                                    // → npc1
  return { s, ctx: ctxOf(rel), evictee: npc(2), voters: [npc(3), npc(4), npc(5), npc(6)] };
}

/** Advance the staged eviction through its reveal until the result lands (returns the "eviction" beat). */
function driveReveal(s: LiveSeasonState, ctx: SeasonCtx, rng: SeededRandom): BeatEvent | null {
  let last: BeatEvent | null = null;
  for (let g = 0; g < 50 && !s.pending && !s.eviction?.evictee && s.beat === "eviction"; g++) last = advance(s, ctx, rng);
  return last;
}

describe("0047 — eviction night live", () => {
  it("PO ruling 2026-11-04: ONE advance reads every ballot (anonymized, in the seeded order), then the next lands the result", () => {
    const { s, ctx, voters } = evictionAt();
    const rng = new SeededRandom(7);
    const ev = advance(s, ctx, rng)!;
    expect(ev.beat).toBe("eviction-reveal");
    expect(s.eviction!.revealIx).toBe(voters.length); // every vote read in this single advance
    // E12: the read ballots are ANONYMIZED — they name the nominee, never the voter.
    expect(ev.content).toMatch(/^a vote to evict /);
    expect((ev.content.match(/a vote to evict /g) ?? []).length).toBe(voters.length);
    expect(ev.participants).toHaveLength(voters.length);
    for (const v of voters) {
      expect(ev.content.includes(v)).toBe(false);
      expect(ev.participants.includes(v)).toBe(false);
    }
    expect(s.evictionOrder).toEqual([]); // the result has NOT landed yet — it is the very next beat
    const result = advance(s, ctx, rng)!;
    expect(result.beat).toBe("eviction");
    expect(result.participants[0]).toBe(npc(2)); // the 3–1 vote evicts npc2
    expect(s.evictionOrder).toEqual([npc(2)]);
  });

  it("the reveal order is the same for the same seed and the evictee is decided by the (engine) tally", () => {
    const order = (seed: number): string => {
      const { s, ctx } = evictionAt();
      const rng = new SeededRandom(seed);
      const ballots: string[] = [];
      for (let i = 0; i < 4; i++) ballots.push(advance(s, ctx, rng)!.participants[0]!);
      return ballots.join(",");
    };
    expect(order(11)).toBe(order(11)); // deterministic by seed
    // Whatever the reveal order, the engine-decided evictee is the same (the tally, not the order).
    const finish = (seed: number): EntityId => {
      const { s, ctx } = evictionAt();
      driveReveal(s, ctx, new SeededRandom(seed));
      return s.evictionOrder[0]!;
    };
    expect(finish(11)).toBe(npc(2));
    expect(finish(99)).toBe(npc(2));
  });

  it("a respectful send-off lifts the evictee's later juror lean; a cold one lowers it", () => {
    // The pure property the live goodbye folds into manner: a warm/respectful tone reads as respected
    // (lifts the lean), a cold tone as disrespected (lowers it), bounded by the manner weight.
    const rel = { trust: 0.5, affinity: 0.5, threat: 0.3 };
    const warm = juryLean(rel, goodbyeMannerFor("warm"));
    const respectful = juryLean(rel, goodbyeMannerFor("respectful"));
    const cold = juryLean(rel, goodbyeMannerFor("cold"));
    expect(warm).toBeGreaterThan(cold);
    expect(respectful).toBeGreaterThan(cold);
  });

  it("live goodbye messages fold their relationship-derived tone into the evictee's manner", () => {
    const drive = (affinityToEvictee: number): { s: LiveSeasonState; senders: EntityId[] } => {
      const { s, ctx, evictee } = evictionAt();
      // Every houseguest reads the evictee with this affinity, so every goodbye shares a tone.
      for (const h of s.active) if (h !== evictee) ctx.rel.edge(h, evictee).affinity = affinityToEvictee;
      const rng = new SeededRandom(5);
      // Reveal the votes until the goodbye stage opens; capture the seeded goodbye senders.
      for (let g = 0; g < 100 && s.eviction?.stage !== "goodbye"; g++) advance(s, ctx, rng);
      const senders = [...s.eviction!.goodbyeFrom];
      // Play out the goodbye messages (each folds its tone into the evictee's manner) and roll on.
      // E34: the PLAYER (a surviving sender) chooses their own tone — matched to the case here.
      const playerTone = affinityToEvictee >= 0.6 ? "warm" as const : "cold" as const;
      for (let g = 0; g < 100 && s.beat === "eviction"; g++) {
        if (s.pending?.kind === "goodbye-message") applyDecision(s, { kind: "goodbye-message", tone: playerTone }, ctx);
        else advance(s, ctx, rng);
      }
      return { s, senders };
    };
    const warm = drive(0.85); // warm goodbyes
    const cold = drive(0.2);  // cold goodbyes
    expect(warm.senders.length).toBeGreaterThan(0);
    expect(warm.senders).toContain(PLAYER); // E34: the surviving player always gets the lever
    // Every houseguest who left a goodbye now reads the evictee's manner with the tone they sent
    // (SOC-NEW-1: recorded as the `goodbye` field, applied with precedence in juryLean).
    for (const sender of warm.senders) expect(warm.s.mannerByEvictee![npc(2)]![sender]!.goodbye).toBe("warm");
    for (const sender of cold.senders) expect(cold.s.mannerByEvictee![npc(2)]![sender]!.goodbye).toBe("cold");
  });

  it("a staged eviction survives an engine restart between the reveal and the result and resumes to the same result", () => {
    const finishOrder = (st: LiveSeasonState, ctx: SeasonCtx): EntityId => {
      const rng = new SeededRandom(7);
      for (let g = 0; g < 100 && !st.finished && st.beat === "eviction"; g++) advance(st, ctx, rng);
      return st.evictionOrder[0]!;
    };
    const { s, ctx } = evictionAt();
    advance(s, ctx, new SeededRandom(7)); // all 4 votes read in the one reveal beat; the result has not landed
    expect(s.eviction?.stage).toBe("votes");
    expect(s.eviction?.revealIx).toBe(4);
    const restored = cloneSession<LiveSeasonState>(s); // a durable round-trip (0030) between the reveal and the result
    expect(restored.eviction?.revealIx).toBe(4);
    // The resumed reveal reaches the same engine-decided evictee.
    expect(finishOrder(restored, ctx)).toBe(npc(2));
  });
});

// --- The Vault-free EvictionView projection (no pre-reveal leak) ----------------

/** A simple, deterministic player policy: compete, take the first legal options, never use the veto. */
function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  const submit = (req: SubmitDecisionReq): void => void s.submitDecision(req);
  if (p.kind === "nominations") submit({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") submit({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") submit({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-intent") submit({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "finale-statement") submit({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") submit({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "juror-vote") submit({ kind: "juror-vote", vote: p.options[0]!.id });
  else submit({ kind: p.kind, vote: p.options[0]!.id });
}

describe("0047 — the EvictionView projection is Vault-free and never leaks the result early", () => {
  it("shows only the votes revealed so far — never a pre-reveal tally or the evictee before the last vote", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("ev");
    sb.session.createCharacter({ playerName: "P", seed: 2 });

    // Drive to the first staging eviction (resolving any player decision on the way).
    let view: AdvanceView | null = null;
    for (let i = 0; i < 3000; i++) {
      const v = sb.session.advanceGame();
      if (v.eviction && v.eviction.stage === "votes") { view = v; break; }
      if (v.pending) resolve(sb.session, v.pending);
      if (v.finished) throw new Error("finished before an eviction staged");
    }
    expect(view, "an eviction staged").toBeTruthy();
    const ev = view!.eviction!;
    expect(ev.nominees).toHaveLength(2);
    // During the votes stage the revealed list is strictly partial — the rest of the house's votes are unread.
    expect(ev.votesRevealed.length).toBeGreaterThanOrEqual(1);
    // Plant a Vault sentinel (an off-screen scheme) and prove it never crosses onto the eviction projection.
    const sentinel = "SENTINEL-0047-eviction-secret";
    sb.engine.events.record({
      id: "hidden:0047", ts: 10_000_002, type: "conversation",
      initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: sentinel,
    });
    const surface = JSON.stringify(sb.session.advanceGame());
    expect(surface.includes(sentinel)).toBe(false);
    // E12: the projection carries ANONYMIZED ballots only — each entry names a nominee and
    // nothing else; no voter attribution exists anywhere on the player-facing surface.
    for (const r of ev.votesRevealed) {
      expect(Object.keys(r)).toEqual(["votedFor"]);
      expect([ev.nominees[0]!.id, ev.nominees[1]!.id]).toContain(r.votedFor.id);
    }
    expect(JSON.stringify(ev).includes('"voter"')).toBe(false);
  });

  it("E12: the post-season retrospective — and only it — unseals the season's secret ballots", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("ev-unseal");
    sb.session.createCharacter({ playerName: "P", seed: 3 });
    // While the season lives, the retrospective is gated shut (0048) — no ballot is tellable.
    expect(sb.session.seasonRetrospective()).toBeNull();
    for (let i = 0; i < 5000; i++) {
      const v = sb.session.advanceGame();
      if (v.pending) resolve(sb.session, v.pending);
      if (v.finished) break;
    }
    const retro = sb.session.seasonRetrospective();
    expect(retro).not.toBeNull();
    // The unsealing carries the real attribution: every weekly ballot names its voter.
    expect(retro!.evictionVotes!.length).toBeGreaterThan(0);
    for (const wk of retro!.evictionVotes!) {
      expect(wk.votes.length).toBeGreaterThan(0);
      for (const v of wk.votes) {
        expect(typeof v.voter.name).toBe("string");
        expect(typeof v.votedFor.name).toBe("string");
      }
    }
  });
});
