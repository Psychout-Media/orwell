import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { makeForPlayerScrub } from "../../src/domain/humanize";
import { PLAYER } from "../../src/domain/ids";

/**
 * PV2 (#997) — gossip / overhear SURFACING must render with a real, never-empty SOURCE and a GRADED
 * confidence vocabulary, not the flat literal that produced "(, muffled)" (empty source + one repeated
 * confidence word). The belief layer already computes graded, decaying confidence + provenance; this
 * pins that the PLAYER-FACING render reflects it across a real, multi-hop driven season.
 *
 * Roles only — the procedurally-generated cast is referenced by id, never by fixture name. The drive is
 * the orchestrator off-screen tick (the same path the live society/gossip/overhear loop runs on).
 */
describe("PV2 (#997) — a surfacing row never renders an empty source, and confidence reads graded", () => {
  it("no player-facing overhear/surfacing row is a sourceless `(, …)`, and >1 distinct confidence word appears", { timeout: 120_000 }, () => { // ORW-985: 8 games x 60 off-screen ticks: an explicit budget, not the 30 s default
    const confidenceWords = new Set<string>();
    let surfacingRows = 0;
    let emptySourceRows = 0;

    // A multi-seed, multi-hop season sweep: the society schemes off-screen, rumors diffuse along the
    // affinity graph, and adjacency overhears land on the player — exactly the surfacings PV2 governs.
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const reg = new GameSessionRegistry();
      const user = `pv2-surface-${seed}`;
      const orch = new Orchestrator(reg, { now: () => seed }, { seed });
      const sb = reg.sandboxFor(user);
      sb.session.createCharacter({ playerName: "The Player", seed });
      const roster = sb.session.getGameState().house.map((h) => ({ id: h.id, name: h.name }));
      const scrub = makeForPlayerScrub(roster);

      for (let t = 0; t < 60; t++) {
        orch.advance(user, "offscreen-tick");
        for (const k of sb.engine.knowledge.knownTo(PLAYER)) {
          // The surfacings PV2 is about: an overheard fragment (its pathway is `overheard:<eventId>`).
          if (!k.pathway.startsWith("overheard:")) continue;
          const rendered = scrub(k.content);
          surfacingRows++;
          // (1) NEVER a gutted, sourceless prefix — the #997 `(, muffled)` regression.
          if (/^\(\s*,/.test(rendered)) emptySourceRows++;
          // (2) The confidence reads as a graded clarity word, captured for the variety assertion.
          const m = /^\(overheard, (\w+)\)/.exec(rendered);
          if (m) confidenceWords.add(m[1]!);
        }
      }
    }

    expect(surfacingRows, "the season produced overhear surfacings to inspect").toBeGreaterThan(0);
    // PV2 assertion #1: NO surfacing row is rendered with an empty source.
    expect(emptySourceRows, "no surfacing row is a sourceless `(, …)`").toBe(0);
    // PV2 assertion #2: more than one distinct confidence word appears across the multi-hop season —
    // the belief layer's graded, decaying certainty actually reaches the player as varied clarity,
    // not one flat "muffled" repeated all game.
    expect(confidenceWords.size, `distinct confidence words: ${[...confidenceWords].join(", ")}`).toBeGreaterThan(1);
  });
});
