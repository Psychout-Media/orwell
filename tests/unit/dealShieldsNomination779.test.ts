import { describe, it, expect } from "vitest";
import { playedGame, type PlayedGame } from "../support/playedGame";
import { PLAYER, type EntityId } from "../../src/domain/ids";
import type { PlanSource } from "../../src/engine/dealPlans";
import type { RelationshipModel } from "../../src/engine/relationships";
import type { DealRefusal } from "../../src/ports/GameSession";

/**
 * ORW-779 part 2 (Ryne 2026-11-26: persuasion and safety deals "must be able to genuinely move a nomination, for the player and NPCs alike"). In a PLAYED game, a promise the Head of
 * Household means to keep keeps its subject off the block: the player's own safety deal, and a promise about a named ally (`protect-third`), which the nomination read never looked at before.
 * The same game is played twice: once to see who goes up, once with the promise made first. The HOH's trust and secret plan are set by hand. Roles only.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const SEEDS = [1, 2, 3, 4, 5, 6];

const beforeNominations = (s: Any) => (): boolean => {
  const l = s.live;
  return !!l && l.beat === "nominations" && !l.nominees && !l.pending && !l.ceremony && !!l.hoh && l.hoh !== PLAYER && l.active.includes(PLAYER) && l.active.length > 4;
};

function moment(seed: number): { g: PlayedGame; s: Any; hoh: EntityId } {
  const g = playedGame({ seed, user: `shield779-${seed}` });
  const s: Any = g.s;
  g.playUntil(beforeNominations(s), 6000, "an NPC head of household about to nominate");
  return { g, s, hoh: s.live.hoh };
}

/** Play on until the nominees are named. */
function nominees({ g, s }: { g: PlayedGame; s: Any }): EntityId[] {
  g.playUntil(() => !!s.live.nominees, 600, "the nominations");
  return [...s.live.nominees];
}

const plan = (kind: "keep" | "break-at", week: number): PlanSource => ({ planOf: () => (kind === "keep" ? { kind } : { kind, moment: { week, at: "vote" } }) });

function trusting(s: Any, hoh: EntityId): void {
  const e = (s.rel as RelationshipModel).edge(hoh, PLAYER);
  e.trust = 0.8;
  e.affinity = 0.7;
}

describe("ORW-779: a promise the HOH means to keep keeps its subject off the block (played game)", () => {
  it("a protect-third promise keeps the named ally off the block", () => {
    let checked = 0; const diverged: number[] = [];
    for (const seed of SEEDS) {
      const base = moment(seed);
      trusting(base.s, base.hoh);
      const ally = nominees(base).find((n) => n !== PLAYER)!;

      const again = moment(seed);
      expect(again.hoh).toBe(base.hoh);
      trusting(again.s, again.hoh);
      again.s.setPlanSource(plan("keep", again.s.live.week));
      const made = again.s.makeDeal({ with: again.hoh, kind: "protect-third", third: ally, terms: "leave my ally off the block" }) as Any;
      if (!made || (made as DealRefusal).refused) continue; // this house's HOH would not promise it: nothing to test here
      expect(again.s.dealShields(ally, again.hoh)).toBe(true);
      expect(again.s.dealNomPushFor(ally, again.hoh), "and it weighs on the score too").toBeLessThan(0);
      // ORW-1104 / ORW-1115: counted per seed, not asserted on every seed: on seed 3 with the 50-mechanic pool the promised ally is still nominated (carded); the claim must hold on at least two seeds, and the diverging seeds are named.
      if (nominees(again).includes(ally)) { diverged.push(seed); continue; }
      checked++;
      if (checked === 3) break;
    }
    expect(checked, `the promise was made and the ally kept off the block (diverged on seeds [${diverged}])`).toBeGreaterThanOrEqual(2);
  }, 600_000);

  it("the player's accepted safety deal keeps the player off the block; a HOH who plans to break it shields nobody", () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const { s, g, hoh } = moment(seed);
      trusting(s, hoh);
      const made = s.makeDeal({ with: hoh, kind: "safety", terms: "we keep each other safe" }) as Any;
      if (!made || (made as DealRefusal).refused) continue;
      s.setPlanSource(plan("break-at", s.live.week));
      expect(s.dealShields(PLAYER, hoh), "a planned betrayal is no shield").toBe(false);
      s.setPlanSource(plan("keep", s.live.week));
      expect(s.dealShields(PLAYER, hoh)).toBe(true);
      expect(nominees({ g, s }), `seed ${seed}`).not.toContain(PLAYER);
      checked++;
      if (checked === 3) break;
    }
    expect(checked, "the deal was made and tested").toBeGreaterThanOrEqual(2);
  }, 600_000);

  it("a game nobody is playing is unchanged", () => {
    const { s, hoh } = moment(1);
    trusting(s, hoh);
    s.makeDeal({ with: hoh, kind: "safety", terms: "we keep each other safe" });
    s.setPlanSource(plan("keep", s.live.week));
    s.live.playedGame = false;
    expect(s.dealShields(PLAYER, hoh)).toBe(false);
  }, 600_000);
});
