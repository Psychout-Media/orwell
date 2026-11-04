import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import { recordClaim, claimsOf, BELIEF_CAP_PER_HOLDER, type BeliefStore } from "../../src/engine/beliefStore";
import { resolvePending } from "../../features/support/answerPending";
import { npc } from "../../src/domain/ids";

/**
 * #2017 S0a — the NPC belief store is DATA MODEL + PLUMBING ONLY. Gates: (1) the pure store (idempotent, bounded, deterministic);
 * (2) the same-seed byte-identity gate (the 0100 pattern): a whole season played flag OFF vs ON produces byte-identical season state EXCEPT the new
 * `beliefs` key (no rng consumed, nothing reads it), and OFF never creates the key; (3) ON actually records engine-only claims, persisted and restored;
 * (4) nothing in any outward projection mentions beliefs. Roles only.
 */
const SEED = 7;
let seq = 0;

function playSeason(on: boolean, deduction = true): { s: GameSessionAdapter; live: LiveSeasonState } {
  vi.stubEnv("ORWELL_NPC_BELIEFS", on ? "1" : "0");
  vi.stubEnv("ORWELL_NPC_BELIEF_NOMS", "0"); // isolate the store from the (default-ON since P4f) nomination/vote term
  const s = new GameSessionRegistry().sandboxFor(`bs${seq++}`).session;
  s.setVoteDeductionEnabled(deduction);
  s.createCharacter({ playerName: "P", seed: SEED });
  for (let i = 0; i < 8000; i++) {
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    if (v.finished) break;
  }
  return { s, live: s.snapshot().live as LiveSeasonState };
}
const sha = (x: unknown): string => createHash("sha256").update(JSON.stringify(x)).digest("hex");

afterEach(() => vi.unstubAllEnvs());

describe("the belief store (pure)", () => {
  const base = { holder: npc(1), kind: "voted-against-me" as const, subject: npc(2), value: true, origin: "deduced" as const, week: 3 };
  it("is idempotent by id and keeps the higher confidence on a re-record", () => {
    const st: BeliefStore = {};
    expect(recordClaim(st, { ...base, confidence: 0.5 })).toBe(true);
    expect(recordClaim(st, { ...base, confidence: 0.4 })).toBe(false);
    expect(recordClaim(st, { ...base, confidence: 0.8 })).toBe(true);
    expect(claimsOf(st, npc(1))).toHaveLength(1);
    expect(claimsOf(st, npc(1))[0]!.confidence).toBe(0.8);
  });
  it("is bounded per holder and compaction is deterministic: lowest confidence first, then oldest; never the claim just written", () => {
    const st: BeliefStore = {};
    // fill exactly to the cap with distinct confidences; week i is the age (0 = oldest)
    const conf = (i: number): number => 0.5 + (i % 5) / 20;           // 0.50 .. 0.70
    for (let i = 0; i < BELIEF_CAP_PER_HOLDER; i++) recordClaim(st, { ...base, subject: npc(100 + i), week: i, confidence: conf(i) });
    // the lowest confidence is 0.50 (weeks 0,5,10,...): the OLDEST of those is week 0, so it goes first
    recordClaim(st, { ...base, subject: npc(900), week: 900, confidence: 0.9 });
    expect(claimsOf(st, npc(1)).map((c) => c.week)).not.toContain(0);
    expect(claimsOf(st, npc(1)).map((c) => c.week)).toContain(5);
    // a second overflow takes the NEXT-oldest of the lowest tier (week 5)
    recordClaim(st, { ...base, subject: npc(901), week: 901, confidence: 0.9 });
    expect(claimsOf(st, npc(1)).map((c) => c.week)).not.toContain(5);
    expect(claimsOf(st, npc(1)).map((c) => c.week)).toContain(10);
    expect(claimsOf(st, npc(1))).toHaveLength(BELIEF_CAP_PER_HOLDER);
    // the claim just written always survives, even at the lowest confidence
    recordClaim(st, { ...base, subject: npc(902), week: 902, confidence: 0.01 });
    expect(claimsOf(st, npc(1)).map((c) => c.week)).toContain(902);
  });
});

describe("the belief store in a live season (S0a)", () => {
  it("OFF never creates the store; ON changes NOTHING else in the season state (byte-identical, no rng consumed)", () => {
    const off = playSeason(false);
    const on = playSeason(true);
    expect(off.live.beliefs, "OFF: the key is never created").toBeUndefined();
    expect("beliefs" in off.live).toBe(false);
    expect(on.live.beliefs, "ON records claims").toBeDefined();
    const { beliefs: _b, ...onRest } = on.live as LiveSeasonState & { beliefs?: BeliefStore };
    expect(sha(onRest), "everything but `beliefs` is byte-identical off vs on").toBe(sha(off.live));
    expect(on.live.winner).toBe(off.live.winner);
    expect(on.live.evictionOrder).toEqual(off.live.evictionOrder);
  }, 300_000);

  it("ON records the evictee's deduced voters as engine-only claims, and they survive a snapshot→restore", () => {
    const on = playSeason(true);
    const store = on.live.beliefs!;
    const all = Object.values(store).flat();
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((c) => c.kind === "voted-against-me" && c.origin === "deduced" && c.value === true && c.confidence > 0 && c.confidence < 1)).toBe(true);
    // the claims ARE the evictee's deduced voters (same subjects, same order), not an independent computation
    // (A battle-back returnee is evicted TWICE, so a holder can carry claims from two evictions; `deducedCulprits` keeps the latest — compare that week's claims.)
    for (const [holder, claims] of Object.entries(store)) {
      const latest = Math.max(...claims.map((c) => c.week));
      expect(claims.filter((c) => c.week === latest).map((c) => c.subject), `the latest claims for ${holder} mirror live.deducedCulprits`)
        .toEqual([...new Set(on.live.deducedCulprits![holder] ?? [])]);
    }
    const holders = Object.keys(store);
    expect(holders.every((h) => (on.live.evictionOrder ?? []).includes(h)), "the holder is the evictee who deduced it").toBe(true);
    const core = JSON.parse(JSON.stringify(on.s.snapshot()));
    const revived = new GameSessionRegistry().sandboxFor(`bs${seq++}`).session;
    revived.restore(core);
    expect((revived.snapshot().live as LiveSeasonState).beliefs, "restored intact").toEqual(store);
  }, 300_000);

  it("with vote deduction OFF the store records nothing (the true ballot is never labelled a deduced guess)", () => {
    const on = playSeason(true, false);
    // Beliefs are ON by default (P4f), so the store may exist and hold OTHER claim kinds (targets-me, from campaigns/rumors); the invariant is that the true ballot is never labelled a deduced guess.
    const deduced = Object.values(on.live.beliefs ?? {}).flat().filter((c) => c.kind === "voted-against-me");
    expect(deduced, "ON but no deduction ⇒ no voted-against-me claims").toEqual([]);
  }, 300_000);

  it("no outward projection mentions beliefs or claim kinds", () => {
    const on = playSeason(true);
    const seen = JSON.stringify([on.s.getGameState(), on.s.seasonRetrospective()]);
    expect(seen).not.toMatch(/beliefs|voted-against-me|BeliefClaim/);
  }, 300_000);
});
