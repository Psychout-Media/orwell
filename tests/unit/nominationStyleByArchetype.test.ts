import "../support/pinFlagsOff";
import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { NOMINATION_STYLE_BY_ARCHETYPE, NOMINATION_STYLES } from "../../src/engine/decisionConstants";
import type { NominationStyle } from "../../src/engine/decisionConstants";
import { nominationPlan } from "../../src/engine/season";
import { RelationshipModel } from "../../src/engine/relationships";
import { PLAYER, npc } from "../../src/domain/ids";

/**
 * Feature 0044 (A-14 AMEND) — every ARCHETYPE maps to its nomination STYLE, and the live adapter hands that style to
 * the season engine (`ctx.nominationStyleOf`). Until now a dead or swapped style passed every required check (only the
 * nightly calibration bands noticed). Principle: an NPC HOH decides from the NPC's OWN perspective, to benefit that NPC —
 * the style is a property of WHO THEY ARE (their archetype), never random and never the player's wishes (the player's
 * own proxy always reads as a threat hunter so the player's character never picks an NPC lens). Roles only.
 */
const EXPECTED: Record<string, NominationStyle> = {
  "comp-beast": "threat-hunter", hothead: "threat-hunter", analyst: "threat-hunter", floater: "threat-hunter",
  villain: "floater-cleaner",
  mastermind: "duo-breaker", wildcard: "duo-breaker",
  "social-butterfly": "loyalist", underdog: "loyalist", flirt: "loyalist", loyalist: "loyalist", peacemaker: "loyalist",
};

describe("0044 — archetype → nomination style", () => {
  it("the table pins every archetype's style exactly (a swapped or dropped entry fails)", () => {
    expect(NOMINATION_STYLE_BY_ARCHETYPE).toEqual(EXPECTED);
  });

  it("the four styles are DISTINCT lenses (a no-op style would make two of them identical)", () => {
    const sig = (s: NominationStyle) => JSON.stringify(NOMINATION_STYLES[s]);
    const all = (Object.keys(NOMINATION_STYLES) as NominationStyle[]).map(sig);
    expect(new Set(all).size).toBe(4);
  });

  it("the live adapter resolves each houseguest's style through their ACTUAL archetype; the player and unknowns read as threat hunters", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", seed: 7 });
    const priv = s as unknown as {
      ctx(): { nominationStyleOf?: (id: string) => NominationStyle };
      house: { npcs: Array<{ id: string; character: { archetype: string } }> };
    };
    const style = priv.ctx().nominationStyleOf!;
    expect(style(PLAYER)).toBe("threat-hunter");
    expect(style("npc:does-not-exist")).toBe("threat-hunter");
    const seen = new Set<string>();
    for (const n of priv.house.npcs) {
      expect(style(n.id), `archetype ${n.character.archetype}`).toBe(EXPECTED[n.character.archetype] ?? "threat-hunter");
      seen.add(n.character.archetype);
    }
    expect(seen.size).toBeGreaterThan(2); // the house really carries several archetypes (the check is not vacuous)
  });

  it("the style changes WHO the HOH nominates (a no-op style would nominate identically)", () => {
    // a house with one floater and one tightly-bonded pair: the four styles must not all nominate the same two
    const rel = new RelationshipModel(0.5);
    const hoh = npc(1), t = npc(2), partner = npc(3), c1 = npc(4), floater = npc(5);
    const active = [hoh, t, partner, c1, floater];
    rel.edge(hoh, t).threat = 0.9; rel.edge(hoh, c1).threat = 0.5; rel.edge(hoh, partner).threat = 0.1; rel.edge(hoh, floater).threat = 0.05;
    for (const [a, b] of [[t, partner], [c1, partner], [c1, t]] as const) for (const [x, y] of [[a, b], [b, a]] as const) { const e = rel.edge(x, y); e.trust = 0.95; e.affinity = 0.95; }
    const pairs = (Object.keys(NOMINATION_STYLES) as NominationStyle[]).map((st) =>
      [...nominationPlan(hoh, active, rel, { style: st, disposition: "neutral" }).nominees].sort().join("+"));
    expect(new Set(pairs).size).toBeGreaterThan(1);
  });
});
