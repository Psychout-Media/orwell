import { describe, it, expect } from "vitest";
import { richOffscreenStretch } from "../../src/engine/offscreen";
import { RICHNESS } from "../../src/engine/richnessConfig";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";

/**
 * #2005 / 0003 "no dumping" — a stretch (one committed moment's off-screen tick) must surface AT MOST `MAX_REVEALS_PER_MOMENT` hidden elements,
 * however many scenes it plays. Each scene's reveal is rare on its own, so the old behaviour only broke when two scenes of one tick both
 * rolled a reveal: a probabilistic, seed-dependent failure. This test is seed-independent: a LONG stretch (so many scenes would reveal
 * uncapped) must still carry at most one reveal, and across several short stretches no single stretch exceeds the cap while reveals still happen.
 * Roles only.
 */
const NPCS = [npc(1), npc(2), npc(3), npc(4)];
const hiddenElementsOf = (): { detail: string }[] => [{ detail: "has a sealed past" }];

function reveals(seed: number, interactions: number): number {
  const scenes = richOffscreenStretch({ events: new InMemoryEventStore(), rng: new SeededRandom(seed), npcs: NPCS, interactions, hiddenElementsOf: hiddenElementsOf as never });
  return scenes.filter((s) => s.event.reveal === true).length;
}

describe("0003 — the no-dumping cap is structural (per off-screen stretch)", () => {
  it("a long stretch reveals at most the per-moment cap (it would reveal many uncapped)", () => {
    for (let seed = 1; seed <= 12; seed++) {
      expect(reveals(seed, 200), `seed ${seed}`).toBeLessThanOrEqual(RICHNESS.MAX_REVEALS_PER_MOMENT);
    }
  });

  it("the cap does not suppress reveals altogether: some stretch still surfaces one", () => {
    const total = Array.from({ length: 40 }, (_, i) => reveals(i + 1, 6)).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("no short stretch of the live tick size ever exceeds the cap", () => {
    for (let seed = 1; seed <= 200; seed++) expect(reveals(seed, 4), `seed ${seed}`).toBeLessThanOrEqual(RICHNESS.MAX_REVEALS_PER_MOMENT);
  });
});
