import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { DEAL_NOMS } from "../../src/engine/dealNomConstants";
import { resolvePending } from "../../features/support/answerPending";

/**
 * ORW-84 (ORWELL_DEAL_NOMS) - deals feed nominations, proven through a REAL season. For each seed two identical sandboxes are driven by the production advance loop to the moment an NPC HOH is about
 * to nominate. The control makes no deal; the other makes ONE open protective ("safety") deal between that HOH and the control's first nominee, and the two differ in nothing else (the live state is
 * asserted byte-identical at that moment). With the flag ON the deal changes who the HOH puts up on enough seeds; with the flag OFF the deal changes nothing (SHA-neutral). Roles only.
 */
type G = { setDealNomsEnabled(on: boolean): void; deals: { make(parties: [string, string], kind: string, terms: string): unknown } };
type Live = { beat?: string; hoh?: string | null; nominees?: string[] };

function atNpcNominations(seed: number, user: string) {
  const sb = new GameSessionRegistry().sandboxFor(user);
  const s = sb.session;
  s.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  for (let i = 0; i < 400; i++) {
    const live = s.snapshot().live as Live | undefined;
    if (live?.beat === "nominations" && live.hoh && live.hoh !== PLAYER) return { sb, hoh: live.hoh };
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    if (v.finished) break;
  }
  throw new Error(`no NPC-HOH nominations moment for seed ${seed}`);
}
const nomineesAfter = (sb: ReturnType<typeof atNpcNominations>["sb"]): string[] => {
  const s = sb.session;
  for (let i = 0; i < 6; i++) {
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    const live = s.snapshot().live as Live;
    if (live.beat !== "nominations" && live.nominees && live.nominees.length === 2) return [...live.nominees].sort();
  }
  throw new Error("nominations did not resolve");
};

function trial(seed: number, flagOn: boolean) {
  const control = atNpcNominations(seed, `dn-c-${seed}-${flagOn}`);
  const treated = atNpcNominations(seed, `dn-t-${seed}-${flagOn}`);
  expect(JSON.stringify(treated.sb.session.snapshot().live), "identical live state before the deal").toBe(JSON.stringify(control.sb.session.snapshot().live));
  (control.sb.session as unknown as G).setDealNomsEnabled(flagOn);
  (treated.sb.session as unknown as G).setDealNomsEnabled(flagOn);
  const base = nomineesAfter(control.sb);
  // The treated run: an open protective deal between the HOH and the control's first nominee (the person the HOH would have put up).
  (treated.sb.session as unknown as G).deals.make([treated.hoh, base[0]!], "safety", "you're safe with me");
  const withDeal = nomineesAfter(treated.sb);
  return { base, withDeal, protectedOne: base[0]! };
}
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

describe("ORW-84: an open protective deal changes who an NPC HOH nominates (live season)", () => {
  it("flag ON: the protected houseguest comes off the block on at least one seed, and the push is the only difference", () => {
    const results = SEEDS.map((seed) => trial(seed, true));
    const moved = results.filter((r) => !r.withDeal.includes(r.protectedOne));
    expect(moved.length, `the deal moved the HOH on ${moved.length}/${SEEDS.length} seeds`).toBeGreaterThan(0);
  }, 600_000);
  it("flag OFF: the same deal changes nothing on any seed (byte-identical nominations)", () => {
    for (const seed of SEEDS) {
      const r = trial(seed, false);
      expect(r.withDeal, `seed ${seed}`).toEqual(r.base);
    }
  }, 600_000);
  it("the push lives in ONE constants module: negative, bounded, and no inline literal remains in the adapter", () => {
    expect(DEAL_NOMS.protectivePush).toBeLessThan(0);
    expect(DEAL_NOMS.protectivePush).toBeGreaterThanOrEqual(-0.5);
    const src = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
    expect(src).toMatch(/return bound \? DEAL_NOMS\.protectivePush : 0;/);
    expect(src).not.toMatch(/return bound \? -0\.\d+ : 0;/);
  });
});
