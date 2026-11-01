import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { InMemoryUserNotorietyStore } from "../../src/adapters/engine/FileUserNotorietyStore";
import {
  deriveNotoriety, accumulateNotoriety, notorietyBias, recognitionFor,
  type NotorietySummary, type OpenSetSeasonOutcome,
} from "../../src/engine/notoriety";
import { NOTORIETY } from "../../src/engine/notorietyConstants";
import { RELATIONSHIP_CONSTANTS } from "../../src/engine/relationshipConstants";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER } from "../../src/domain/ids";
import type { Archetype } from "../../src/engine/characterFactory";

/**
 * Feature 0104 — season-over-season NOTORIETY: a bounded, OPEN-SET reputation that precedes the
 * returning player into a NEW cast and biases the new houseguests' day-one reads — DIRECTION only.
 *
 * The four mandates are load-bearing here and each has a hard gate:
 *  • Vault Wall (player AND admin) — the summary is open-set; no number / no sealed content on any
 *    player or admin projection (the sentinel sweep below + `notorietyVault.test.ts`).
 *  • Anti-sycophancy — the engine owns outcome magnitude; notoriety touches ONLY day-one edges, never a
 *    comp/vote/jury roll (proven byte-identical in `notorietyOutcomeNeutral.test.ts`).
 *  • Cross-user isolation (0021) — a user's new season reflects ONLY their own prior seasons (below).
 *  • Non-degradation — `accumulate` is monotonic; reputation deepens, never thins (below).
 *
 * HARD testing rule: roles only — no fixture names.
 */

// A treacherous, blindside-heavy season outcome (the player a known assassin) and a loyal, beloved one.
const TREACHEROUS: OpenSetSeasonOutcome = {
  placement: 2, castSize: 16, playerCompWins: 3,
  playerEvictionRoles: [
    { blindsided: true, betrayed: true }, { blindsided: true }, { betrayed: true }, { blindsided: true },
  ],
  reachedJury: true, reachedFinalTwo: true, juryVoteShare: 0.3,
};
const LOYAL: OpenSetSeasonOutcome = {
  placement: 2, castSize: 16, playerCompWins: 1,
  playerEvictionRoles: [{ respected: true }, { respected: true }, { respected: true }],
  reachedJury: true, reachedFinalTwo: true, juryVoteShare: 0.7,
};

describe("0104 deriveNotoriety — a bounded, open-set summary", () => {
  it("derives a fixed-shape summary with bounded reputation facets in [-1,1]", () => {
    const n = deriveNotoriety(TREACHEROUS);
    expect(n.seasonsPlayed).toBe(1);
    expect(n.lastPlacement).toBe(2);
    expect(n.bestPlacement).toBe(2);
    for (const v of Object.values(n.reputation)) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
    // A blindside-heavy run reads as treacherous + a competition threat; not as a loyalist.
    expect(n.reputation.treachery).toBeGreaterThan(0.3);
    expect(n.reputation.competitor).toBeGreaterThan(0);
    expect(n.reputation.loyalty).toBeLessThan(n.reputation.treachery);
  });

  it("a loyal, jury-respected run reads warm, not treacherous", () => {
    const n = deriveNotoriety(LOYAL);
    expect(n.reputation.loyalty).toBeGreaterThan(0.3);
    expect(n.reputation.social).toBeGreaterThan(0.3);
    expect(n.reputation.treachery).toBe(0); // no blindsides recorded ⇒ exactly zero
  });

  it("legendBeats are short, Vault-free glosses, capped", () => {
    const n = deriveNotoriety(TREACHEROUS);
    expect(n.legendBeats.length).toBeLessThanOrEqual(NOTORIETY.maxLegendBeats);
    expect(n.legendBeats.length).toBeGreaterThan(0);
    for (const b of n.legendBeats) expect(typeof b).toBe("string");
  });
});

describe("0104 accumulateNotoriety — monotonic, never thins (non-degradation)", () => {
  it("seasonsPlayed only ever rises; bestPlacement keeps the better; reputation keeps the larger magnitude", () => {
    const s1 = deriveNotoriety({ ...LOYAL, placement: 1 });          // a win, beloved
    const s2 = deriveNotoriety({ ...TREACHEROUS, placement: 8 });    // a later, worse, treacherous season
    const merged = accumulateNotoriety(s1, s2);
    expect(merged.seasonsPlayed).toBe(2);                            // rose
    expect(merged.bestPlacement).toBe(1);                            // kept the win
    expect(merged.lastPlacement).toBe(8);                            // tracks the most recent
    // The loyalty earned in s1 is NOT thinned by the treacherous s2; the treachery from s2 is added.
    expect(merged.reputation.loyalty).toBeGreaterThanOrEqual(s1.reputation.loyalty);
    expect(Math.abs(merged.reputation.treachery)).toBeGreaterThanOrEqual(Math.abs(s1.reputation.treachery));
  });

  it("accumulating onto a null prior is the fresh summary", () => {
    const s = deriveNotoriety(LOYAL);
    expect(accumulateNotoriety(null, s)).toEqual(s);
  });

  it("the in-memory store accumulates monotonically per user", () => {
    const store = new InMemoryUserNotorietyStore();
    store.accumulate("u", deriveNotoriety({ ...LOYAL, placement: 3 }));
    store.accumulate("u", deriveNotoriety({ ...LOYAL, placement: 1 }));
    const got = store.read("u")!;
    expect(got.seasonsPlayed).toBe(2);
    expect(got.bestPlacement).toBe(1);
  });
});

describe("0104 notorietyBias — bounded, signed, archetype-shaded direction", () => {
  it("a treacherous reputation biases threat UP and trust DOWN; bounded by the weight", () => {
    const n = deriveNotoriety(TREACHEROUS);
    const recognition = 1; // full recognition
    const threat = notorietyBias(n, "mastermind", "threat", recognition);
    const trust = notorietyBias(n, "mastermind", "trust", recognition);
    expect(threat).toBeGreaterThan(0);
    expect(trust).toBeLessThan(0);
    // The bias magnitude can never escape the weight bound (× the largest plausible shade).
    const bound = NOTORIETY.weight * (1 + NOTORIETY.shadeSpread);
    for (const b of [threat, trust]) expect(Math.abs(b)).toBeLessThanOrEqual(bound + 1e-9);
  });

  it("a loyal reputation biases affinity/trust UP", () => {
    const n = deriveNotoriety(LOYAL);
    expect(notorietyBias(n, "loyalist", "affinity", 1)).toBeGreaterThan(0);
    expect(notorietyBias(n, "loyalist", "trust", 1)).toBeGreaterThan(0);
  });

  it("no summary / weight 0 / zero recognition ⇒ exactly zero (the byte-identical floor)", () => {
    const n = deriveNotoriety(TREACHEROUS);
    for (const sig of ["trust", "affinity", "threat"] as const) {
      expect(notorietyBias(null, "villain", sig, 1)).toBe(0);
      expect(notorietyBias(n, "villain", sig, 0)).toBe(0);
    }
  });

  it("archetype SHADES the read: a wary archetype reads a threat more than a bonding one", () => {
    const n = deriveNotoriety(TREACHEROUS);
    const wary = notorietyBias(n, "mastermind", "threat", 1);
    const bond = notorietyBias(n, "peacemaker", "threat", 1);
    expect(wary).toBeGreaterThan(bond); // the schemer reads the assassin as more dangerous
  });

  it("recognition modulates the bias proportionally (lower awareness ⇒ fainter)", () => {
    const n = deriveNotoriety(TREACHEROUS);
    const full = notorietyBias(n, "analyst", "threat", 1);
    const faint = notorietyBias(n, "analyst", "threat", NOTORIETY.recognitionFloor);
    expect(Math.abs(faint)).toBeLessThan(Math.abs(full));
  });
});

describe("0104 recognitionFor — per-NPC awareness, some distorted (R2)", () => {
  it("most NPCs read in the [floor,1] band; a minority hold a distorted (weaker/possibly inverted) read", () => {
    const rng = new SeededRandom(12345);
    let distorted = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const r = recognitionFor(rng);
      // A true read sits in [floor, 1]; a distorted one is scaled (and may go negative).
      if (r < NOTORIETY.recognitionFloor - 1e-9 || r < 0) distorted++;
      // Never exceeds 1 (no NPC over-reads the reputation).
      expect(r).toBeLessThanOrEqual(1 + 1e-9);
    }
    // Some are distorted but it stays a MINORITY (reputation matters, never rigidly overrides discovery).
    expect(distorted).toBeGreaterThan(0);
    expect(distorted).toBeLessThan(N * 0.5);
  });

  it("not everyone reads the reputation equally — recognition genuinely varies across the cast", () => {
    const rng = new SeededRandom(99);
    const draws = Array.from({ length: 15 }, () => recognitionFor(rng));
    const distinct = new Set(draws.map((d) => d.toFixed(4)));
    expect(distinct.size).toBeGreaterThan(5); // a real spread, not one flat value
  });
});

// ── End-to-end through the live game: notoriety precedes the player into a new cast ────────────────

/** Read every NPC→player edge in the live house (the hidden move-in layer), roles-only. */
function npcToPlayerEdges(sb: ReturnType<GameSessionRegistry["sandboxFor"]>): Array<{ trust: number; affinity: number; threat: number }> {
  const core = sb.session.snapshot();
  const npcs = core.house?.npcs ?? [];
  return npcs.map((n) => {
    const e = sb.engine.relationships.edge(n.id, PLAYER);
    return { trust: e.trust, affinity: e.affinity, threat: e.threat };
  });
}

/** Mean of a numeric series. */
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

describe("0104 — notoriety precedes the player into a new cast (live, role-only)", () => {
  it("a treacherous past ⇒ warier / higher-threat day-one reads than no prior season (same seed)", () => {
    const SEED = 7;
    // Baseline: a fresh game with NO notoriety.
    const regA = new GameSessionRegistry();
    const sbA = regA.sandboxFor("u-fresh");
    sbA.session.createCharacter({ playerName: "The Player", seed: SEED });
    const fresh = npcToPlayerEdges(sbA);

    // The same seed, but the session carries a strong treacherous notoriety (the diegetic carry).
    const regB = new GameSessionRegistry();
    const sbB = regB.sandboxFor("u-known");
    sbB.session.setNotoriety(deriveNotoriety(TREACHEROUS));
    sbB.session.createCharacter({ playerName: "The Player", seed: SEED });
    const known = npcToPlayerEdges(sbB);

    expect(known.length).toBe(fresh.length);
    // The house, on average, reads the known assassin as more of a threat and trusts them less.
    expect(mean(known.map((e) => e.threat))).toBeGreaterThan(mean(fresh.map((e) => e.threat)));
    expect(mean(known.map((e) => e.trust))).toBeLessThan(mean(fresh.map((e) => e.trust)));
  });

  it("a beloved past ⇒ warmer day-one reads than no prior season (same seed)", () => {
    const SEED = 13;
    const regA = new GameSessionRegistry();
    const sbA = regA.sandboxFor("u-fresh2");
    sbA.session.createCharacter({ playerName: "The Player", seed: SEED });
    const fresh = npcToPlayerEdges(sbA);

    const regB = new GameSessionRegistry();
    const sbB = regB.sandboxFor("u-beloved");
    sbB.session.setNotoriety(deriveNotoriety(LOYAL));
    sbB.session.createCharacter({ playerName: "The Player", seed: SEED });
    const known = npcToPlayerEdges(sbB);

    expect(mean(known.map((e) => e.affinity))).toBeGreaterThan(mean(fresh.map((e) => e.affinity)));
  });

  it("the bias rides INSIDE the move-in scatter envelope — never pushes an edge outside the band", () => {
    const SEED = 42;
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("u-bounded");
    // A maximal reputation (clamped facets) to stress the bound.
    const maxRep: NotorietySummary = {
      seasonsPlayed: 5, lastPlacement: 1, bestPlacement: 1,
      reputation: { loyalty: 1, treachery: 1, competitor: 1, social: 1 },
      legendBeats: [],
    };
    sb.session.setNotoriety(maxRep);
    sb.session.createCharacter({ playerName: "The Player", seed: SEED });
    const edges = npcToPlayerEdges(sb);
    // The dayOnePerception + notoriety together still keep every edge a valid [0,1] signal (clamped),
    // and the additional notoriety tilt is bounded by the weight inside MOVE_IN.spread — a tilt, not a jump.
    const { MOVE_IN } = RELATIONSHIP_CONSTANTS;
    const maxNotorietyTilt = MOVE_IN.spread * NOTORIETY.weight * (1 + NOTORIETY.shadeSpread);
    expect(maxNotorietyTilt).toBeLessThan(MOVE_IN.spread); // the tilt is strictly under one scatter width
    for (const e of edges) {
      for (const v of [e.trust, e.affinity, e.threat]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("determinism: same seed + same notoriety ⇒ identical biased day-one edges", () => {
    const make = (): Array<{ trust: number; affinity: number; threat: number }> => {
      const reg = new GameSessionRegistry();
      const sb = reg.sandboxFor("u-det");
      sb.session.setNotoriety(deriveNotoriety(TREACHEROUS));
      sb.session.createCharacter({ playerName: "The Player", seed: 101 });
      return npcToPlayerEdges(sb);
    };
    expect(make()).toEqual(make());
  });
});

// ── The diegetic opt-in (R4): return-as-same-character carries it; a new character does not ─────────

describe("0104 — the diegetic opt-in (R4): keepCharacter carries notoriety, a new character is a clean slate", () => {
  it("returning as the SAME character carries notoriety into the new cast's reads", () => {
    const reg = new GameSessionRegistry();
    const user = "u-return";
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 7 });
    // Finish the first season so the dead-season notoriety is derived at the cutover.
    expect(sb.session.advanceToFinale().finished).toBe(true);
    // Return as the SAME character (the diegetic carry) — confirmRestart + keepCharacter.
    sb.session.createCharacter({ playerName: "The Player", seed: 7, confirmRestart: true, keepCharacter: true });
    // The fresh sandbox (post-reset) is the live one now.
    const after = reg.sandboxFor(user);
    expect(after.session.notorietySummary()).not.toBeNull();
    // The full record (season count, facets) is engine-internal — read via the non-port accessor.
    expect(after.session.carriedNotoriety()!.seasonsPlayed).toBeGreaterThanOrEqual(1);
  });

  it("the outward notorietySummary port method returns ONLY the legend — never the hidden reputation numbers", async () => {
    // #1791 first shipped notorietySummary as a player tool returning the WHOLE summary (facets included);
    // 86c4af51 removed the tool. Defense in depth: the outward port method itself is now a legend-only
    // projection, and the tool stays OFF the player channel — both pinned here.
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("u-legend-projection");
    sb.session.setNotoriety({
      seasonsPlayed: 4, lastPlacement: 3, bestPlacement: 2,
      reputation: { loyalty: -0.8137, treachery: 0.9311, competitor: 0.7719, social: -0.4223 },
      legendBeats: ["blindsided their own ally"],
    });
    sb.session.createCharacter({ playerName: "The Player", seed: 7 });
    const view = sb.session.notorietySummary();
    expect(view).toEqual({ legendBeats: ["blindsided their own ally"] });
    const wire = JSON.stringify(view);
    for (const leak of ["0.8137", "0.9311", "0.7719", "0.4223", "reputation", "seasonsPlayed", "lastPlacement", "bestPlacement"]) {
      expect(wire.includes(leak), `notorietySummary leaked ${leak}`).toBe(false);
    }
    // The leaky tool stays removed from the player channel (86c4af51).
    expect(sb.mcp.player.listTools().some((t) => t.name === "notorietySummary")).toBe(false);
    await expect(sb.mcp.player.callTool("notorietySummary", {})).rejects.toThrow(/not available/);
  });

  it("creating a NEW character (no keepCharacter) is a clean slate — no notoriety folded", () => {
    const reg = new GameSessionRegistry();
    const user = "u-newchar";
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 7 });
    expect(sb.session.advanceToFinale().finished).toBe(true);
    // A fresh start (confirmRestart but NO keepCharacter) — the clean slate.
    sb.session.createCharacter({ playerName: "The Player", seed: 7, confirmRestart: true });
    const after = reg.sandboxFor(user);
    expect(after.session.notorietySummary()).toBeNull();
  });
});

// ── Cross-user isolation (R3) — a HARD gate beside the Vault sentinel ──────────────────────────────

describe("0104 — cross-user isolation (R3): a user's new season reflects only their OWN prior games", () => {
  it("two users with different histories: each new season folds only its own user's notoriety", () => {
    const SEED = 7;
    // ONE registry (shared notoriety store), TWO physical users with opposite reputations.
    const reg = new GameSessionRegistry();
    const A = "user-A";
    const B = "user-B";
    // Seed each user's account-level notoriety directly via the (per-user) store the registry holds.
    // (We assert the registry NEVER reads the other user's row when seeding day one.)
    const sbA = reg.sandboxFor(A);
    sbA.session.setNotoriety(deriveNotoriety(TREACHEROUS)); // A is a known assassin
    sbA.session.createCharacter({ playerName: "The Player", seed: SEED });

    const sbB = reg.sandboxFor(B);
    sbB.session.setNotoriety(deriveNotoriety(LOYAL));       // B is a known loyalist
    sbB.session.createCharacter({ playerName: "The Player", seed: SEED });

    const edgesA = npcToPlayerEdges(sbA);
    const edgesB = npcToPlayerEdges(sbB);
    // Same seed, opposite reputations ⇒ A's house reads warier (higher threat) than B's.
    expect(mean(edgesA.map((e) => e.threat))).toBeGreaterThan(mean(edgesB.map((e) => e.threat)));
    expect(mean(edgesB.map((e) => e.affinity))).toBeGreaterThan(mean(edgesA.map((e) => e.affinity)));
  });

  it("the per-user store NEVER returns another user's notoriety (the isolation invariant)", () => {
    const store = new InMemoryUserNotorietyStore();
    store.accumulate("A", deriveNotoriety(TREACHEROUS));
    expect(store.read("A")).not.toBeNull();
    expect(store.read("B")).toBeNull(); // B has no notoriety; A's never leaks across
  });

  it("end-to-end: user A finishing a treacherous season never colors user B's fresh game", () => {
    const reg = new GameSessionRegistry();
    // A plays + finishes a treacherous-ish season, then returns as the same character.
    const sbA = reg.sandboxFor("A2");
    sbA.session.createCharacter({ playerName: "The Player", seed: 7 });
    sbA.session.advanceToFinale();
    // B is a brand-new physical user with NO history — their day-one reads must be the clean baseline.
    const regFresh = new GameSessionRegistry();
    const sbBfresh = regFresh.sandboxFor("B2");
    sbBfresh.session.createCharacter({ playerName: "The Player", seed: 7 });
    const baselineB = npcToPlayerEdges(sbBfresh);
    // The SAME B-user inside A's registry must read identically (A's finished season never touched B).
    const sbBsame = reg.sandboxFor("B2");
    sbBsame.session.createCharacter({ playerName: "The Player", seed: 7 });
    expect(npcToPlayerEdges(sbBsame)).toEqual(baselineB);
    // And B carries no notoriety.
    expect(sbBsame.session.notorietySummary()).toBeNull();
  });
});

// ── archetypeShade smoke — the bias is signed, never flipped by the shade ──────────────────────────

describe("0104 — the shade never flips the sign of the bias", () => {
  const ARCHES: Archetype[] = [
    "comp-beast", "mastermind", "social-butterfly", "floater", "villain", "underdog",
    "flirt", "loyalist", "wildcard", "analyst", "hothead", "peacemaker",
  ];
  it("for every archetype, a positive base lean stays positive and a negative stays negative", () => {
    const n = deriveNotoriety(TREACHEROUS); // threat lean is positive, trust lean negative
    for (const a of ARCHES) {
      expect(notorietyBias(n, a, "threat", 1)).toBeGreaterThanOrEqual(0);
      expect(notorietyBias(n, a, "trust", 1)).toBeLessThanOrEqual(0);
    }
  });
});

// ── FEATURE-01791: notorietyLegend surfaces the RETURNING-CAST block on premiere/early-social ─────

describe("01791 — notorietyLegend appears on premiere/early-social with legendBeats", () => {
  it("a returning player (notoriety set) gets notorietyLegend on premiere", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("u-got-legend");
    sb.session.setNotoriety(deriveNotoriety(TREACHEROUS));
    sb.session.createCharacter({ playerName: "The Player", seed: 7 });
    const view = sb.session.getGameState();
    expect(view.notorietyLegend).toBeDefined();
    expect(view.notorietyLegend!.length).toBeGreaterThan(0);
    // Every clause is a Vault-free string (never a number, never hidden state)
    for (const b of view.notorietyLegend!) {
      expect(typeof b).toBe("string");
    }
  });

  it("a fresh player (no notoriety) has no notorietyLegend on premiere", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("u-fresh-legend");
    sb.session.createCharacter({ playerName: "The Player", seed: 7 });
    const view = sb.session.getGameState();
    expect(view.notorietyLegend).toBeUndefined();
  });

  it("notorietyLegend is absent on a non-premiere, non-early-social phase (week 3 HOH comp / nominations)", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("u-late-social");
    sb.session.setNotoriety(deriveNotoriety(TREACHEROUS));
    sb.session.createCharacter({ playerName: "The Player", seed: 7 });
    // Advance past premiere through the first HOH, nominations, veto — by week 3 the gate is closed.
    // Advance through the loop until we're past week 1
    for (let i = 0; i < 30; i++) {
      const adv = sb.session.advanceGame();
      if (adv.finished) break;
      const view = sb.session.getGameState();
      // If we're past premiere and past week 1 social, the legend should be absent
      if (view.week >= 2) break;
      if (view.finished) break;
    }
    const view = sb.session.getGameState();
    // By week 2+ the early-social gate is closed
    expect(view.notorietyLegend).toBeUndefined();
  });
});
