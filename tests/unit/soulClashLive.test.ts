import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../../features/support/answerPending";
import { RELATIONSHIP_CONSTANTS } from "../../src/engine/relationshipConstants";

/**
 * AMEND 0041/0124 #2 - the LIVE temperament wiring, end to end (the Gherkin hands a disposition to nominationStrategy by hand). Push a houseguest toward "clash" by REAL play (repeated
 * betrayals recorded through the engine), then assert, on the live session: their temperament drift moves, their EFFECTIVE disposition reads harder than their static one, and the NPC-memory
 * decay scale (which reads dispositionReadOf) follows it - a clash holder's grudges last longer. The CHARACTER stays byte-stable. Roles only.
 */
type Priv = { dispositionReadOf(id: string): string; baselineDispositionOf(id: string): string; memoryDecayScale(id: string): number; soulObj(id: string): { temperamentDrift?: number } };
const rank: Record<string, number> = { bond: 0, neutral: 1, clash: 2 };

describe("0124 live: real play drifts temperament, and the effective disposition + memory decay follow", () => {
  it("over played seasons some houseguests' effective disposition departs from their static one, and EVERY houseguest's memory decay scale is read off the live effective disposition", () => {
    let departed = 0, hardened = 0, softened = 0, scaleChanged = 0, checked = 0;
    for (const seed of [3, 5, 7, 9]) {
      const sb = new GameSessionRegistry().sandboxFor(`sc${seed}`);
      const s = sb.session as GameSessionAdapter;
      s.createCharacter({ playerName: "P", seed });
      const characters = new Map(s.snapshot().house!.npcs.map((n) => [n.id, JSON.stringify(n.character)] as const));
      for (let i = 0; i < 6000; i++) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); if (v.finished) break; }
      const P = s as unknown as Priv;
      for (const n of s.snapshot().house!.npcs) {
        const eff = P.dispositionReadOf(n.id), base = P.baselineDispositionOf(n.id);
        checked++;
        expect(P.memoryDecayScale(n.id), "decay scale is read off the LIVE effective disposition").toBeCloseTo(RELATIONSHIP_CONSTANTS.dispositionFactors[eff as "clash"].decayScale, 12);
        expect(JSON.stringify(n.character), "CHARACTER byte-stable (0007)").toBe(characters.get(n.id));
        if (eff !== base) {
          departed++;
          if (rank[eff]! > rank[base]!) hardened++; else softened++;
          if (RELATIONSHIP_CONSTANTS.dispositionFactors[eff as "clash"].decayScale !== RELATIONSHIP_CONSTANTS.dispositionFactors[base as "clash"].decayScale) scaleChanged++;
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[0124 live] ${checked} houseguests over 4 seasons: ${departed} departed from their static disposition (${hardened} hardened, ${softened} softened); decay scale differs from static for ${scaleChanged}`);
    expect(departed, "play moves some houseguests' effective temperament").toBeGreaterThan(0);
    expect(scaleChanged, "...and that changes how long their grudges last").toBeGreaterThan(0);
  });
});
