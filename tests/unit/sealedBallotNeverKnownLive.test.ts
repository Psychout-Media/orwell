import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { claimsOf, type BeliefStore } from "../../src/engine/beliefStore";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * Watch list item 3 (ORW-106): a named eviction ballot never shows up in anything a houseguest knows or says. Drives a REAL eviction through the
 * live loop (not the hook called by hand), with ORWELL_ASSURANCES on and an open "vote" assurance from EVERY other houseguest to BOTH nominees, so every ballot
 * resolves an assurance. Afterwards, nothing the nominees hold can single out a real voter: no lied-to-me claim names a voter, no witness holds a break/keep memory
 * about a voter, and the nominees' break/keep memory of each voter is identical across all voters (a smeared share, so the real voter is not an outlier).
 * The test fails if the ballot is attributed (the vote count stops passing the voter pool to the assurance hooks). Roles only.
 */

afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

type Mem = { kind: string; severity: number };
type Live = { beliefs?: BeliefStore; npcMemory?: Record<string, Record<string, Mem[]>>; assurances?: { items: Array<{ status: string }> } };

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id });
}

/** Play to the first eviction vote the player is asked to cast, plant the assurances, cast it, and return the sandbox. */
function playOneEviction(seed: number) {
  const sb = new GameSessionRegistry().sandboxFor(`sealed-live-${seed}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  sb.session.setAssurancesEnabled(true);
  const g = sb.session as GameSessionAdapter;
  g.setNpcBeliefsEnabled(true);
  g.setMemoryPromisesEnabled(true);
  let voteCard: NonNullable<AdvanceView["pending"]> | undefined;
  for (let i = 0; i < 80 && !voteCard; i++) {
    const a = sb.session.advanceGame();
    if (a.finished) break;
    if (a.pending?.kind === "eviction-vote") voteCard = a.pending;
    else if (a.pending) resolveLegally(sb.session, a.pending);
  }
  return { sb, g, voteCard };
}

describe("a sealed eviction ballot is never attributable from what a houseguest holds (real loop, ORWELL_ASSURANCES on)", () => {
  for (const seed of [7, 3]) {
    it(`seed ${seed}: no claim, no witness memory, and an identical break/keep share across every possible voter`, () => {
      const { sb, g, voteCard } = playOneEviction(seed);
      expect(voteCard, "the player is asked to cast an eviction vote").toBeTruthy();
      const nominees = voteCard!.options.map((o) => o.id);
      const live = () => sb.session.snapshot().live as Live;
      // The HOH does not vote (they only break a tie), so they are not a possible suspect.
      const hoh = (live() as { hoh?: string }).hoh;
      const voters = sb.session.livingIds().filter((id) => id !== PLAYER && id !== hoh && !nominees.includes(id));
      expect(voters.length, "enough voters to hide among").toBeGreaterThanOrEqual(3);
      for (const v of voters) for (const n of nominees) g.recordAssurance({ from: v, to: n, kind: "vote", sincerity: 1, source: "npc", heardBy: voters.filter((w) => w !== v).slice(0, 2) });

      sb.session.submitDecision({ kind: "eviction-vote", vote: nominees[0]! });

      // 0. POSITIVE CONTROL: the ballots really resolved assurances and the nominees really hold ballot-made memory. Without this every check below could pass on an empty house.
      const resolved = (live().assurances?.items ?? []).filter((a) => a.status !== "open").length;
      expect(resolved, "the vote resolved assurances (broken or kept)").toBeGreaterThan(0);
      const mem0 = live().npcMemory ?? {};
      const ballotEntries = nominees.flatMap((n) => voters.flatMap((v) => (mem0[n]?.[v] ?? []).filter((e) => e.kind === "deal-broken" || e.kind === "deal-kept")));
      expect(ballotEntries.length, "the nominees hold ballot-made break/keep memory").toBeGreaterThan(0);

      // 1. No nominee holds a lied-to-me claim that names any voter.
      for (const n of nominees) {
        const named = claimsOf(live().beliefs ?? {}, n).filter((c) => c.kind === "lied-to-me" && voters.includes(c.subject));
        expect(named, `nominee holds no lied-to-me claim about a voter`).toEqual([]);
      }
      // 2. A witness who merely heard a promise holds no break/keep memory about any voter (nothing attributes the ballot to them).
      const mem = live().npcMemory ?? {};
      for (const w of voters) {
        for (const v of voters) {
          const m = (mem[w]?.[v] ?? []).filter((e) => e.kind === "deal-broken" || e.kind === "deal-kept");
          expect(m, `witness ${w} holds nothing about voter ${v}`).toEqual([]);
        }
      }
      // 3. Each nominee's break/keep memory is the same for every voter: the real voter is not an outlier among the suspects.
      for (const n of nominees) {
        for (const kind of ["deal-broken", "deal-kept"]) {
          // Compare only suspects whose ledger holds nothing but the ballot's own entries: a voter with an unrelated memory (a veto grudge) can lose a share to the per-pair cap of 6, which is the
          // cap, not an attribution.
          const clean = voters.filter((v) => (mem[n]?.[v] ?? []).every((e) => e.kind === "deal-broken" || e.kind === "deal-kept"));
          expect(clean.length, "most suspects are clean, so the comparison is not a handful").toBeGreaterThanOrEqual(Math.ceil(voters.length / 2));
          const shares = clean.map((v) => (mem[n]?.[v] ?? []).filter((e) => e.kind === kind).reduce((s, e) => s + e.severity, 0));
          for (const x of shares) expect(x, `${kind} share is identical across the clean suspects`).toBeCloseTo(shares[0]!, 9);
        }
      }
    });
  }
});
