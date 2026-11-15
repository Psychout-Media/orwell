import { describe, it, expect } from "vitest";
import {
  runPlayerOOBE, startNewGame, generateHouse, ARCHETYPES,
  NPC_STAT_RANGE, playerAptitudesWithinNpcBounds,
  NAME_CORPORA, isCorpusName, DEFAULT_ARCHETYPE, resolveStrategyStyle,
} from "../../src/engine/characterFactory";
import type { Houseguest } from "../../src/engine/characterFactory";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolveCompetition, CompetitionIntents } from "../../src/domain/competitionOutcome";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

/** A houseguest's full IDENTITY (E38): with real-name corpora a bare first name MAY recur across
 *  seeds (real names repeat in the real world) — what must never carry over is the identity. */
const identityOf = (n: Houseguest): string =>
  `${n.name}|${n.character.archetype}|${n.character.background}|${n.character.appearance}`;

describe("0015 — character creation (OOBE)", () => {
  it("validates: an incomplete profile is rejected, a complete one is consistent", () => {
    expect(() => runPlayerOOBE({ name: "" })).toThrow();
    expect(() => runPlayerOOBE({ name: "   " })).toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => runPlayerOOBE({} as any)).toThrow();
    const p = runPlayerOOBE({ name: "Author", archetype: "mastermind", strategyStyle: "strategic" });
    expect(p.authored).toBe("oobe");
    expect(p.character.archetype).toBe("mastermind");
    expect(p.character.strategyStyle).toBe("strategic");
  });

  it("splits the player into a static Character + an initial Soul with no relationship beliefs", () => {
    const p = runPlayerOOBE({ name: "Author", backstory: "a long road here" });
    expect(p.character.stats).toBeDefined();
    expect(p.character.background).toContain("long road");
    expect(p.soul.emotionalBaseline).toBeGreaterThanOrEqual(0);
    expect(p.soul.memory).toEqual([]); // empty memory; relationship beliefs are NOT stored on the soul
    expect(p.soul.emotionalHistory).toEqual([]); // the season arc (0041) starts empty; it grows live
    expect(Object.keys(p.soul).sort()).toEqual(["emotionalBaseline", "emotionalHistory", "emotionalState", "memory", "volatility"]);
  });

  it("anti-sycophancy: authored aptitudes always fall within the NPC bounds (no min-maxing)", () => {
    for (const spec of ARCHETYPES) {
      const p = runPlayerOOBE({ name: "MaxMe", archetype: spec.archetype });
      expect(playerAptitudesWithinNpcBounds(p)).toBe(true);
      for (const v of Object.values(p.character.stats)) {
        expect(v).toBeGreaterThanOrEqual(NPC_STAT_RANGE.min);
        expect(v).toBeLessThanOrEqual(NPC_STAT_RANGE.max);
      }
    }
  });

  it("seeds exactly one authored profile (player) + 15 generated NPCs", () => {
    const house = startNewGame({ seed: 1, playerName: "Author" });
    expect(house.player.authored).toBe("oobe");
    expect(house.npcs).toHaveLength(15);
    expect(house.npcs.every((n) => n.authored === "generated")).toBe(true);
  });

  it("no carryover: two saves share no houseguest IDENTITIES (E38 — names are raw material)", () => {
    const a = startNewGame({ seed: 1, playerName: "Author" });
    const b = startNewGame({ seed: 2, playerName: "Author" });
    const an = new Set(a.npcs.map(identityOf));
    const overlap = b.npcs.filter((n) => an.has(identityOf(n)));
    expect(overlap).toHaveLength(0);
  });

  it("E38 realism gate: every generated name part comes from the vendored corpora; the legacy cast stays banned", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { npcs } = generateHouse(new SeededRandom(seed));
      for (const n of npcs) {
        expect(isCorpusName(n.name), `"${n.name}" must be corpus-sampled`).toBe(true);
        expect(n.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      }
      // No two houseguests in one season share a given name (sampling without replacement).
      const firsts = npcs.map((n) => n.name.split(" ")[0]!);
      expect(new Set(firsts).size).toBe(firsts.length);
    }
    // The legacy Bible's sample names are banned BY CONSTRUCTION: they are not in the corpora.
    // (Roles-only rule: the banned set is read from the corpus exclusion, not asserted by name here —
    // the corpora are data, and the replayability BDD keeps the explicit legacy deny check.)
    expect(NAME_CORPORA.given.length).toBeGreaterThanOrEqual(300);
    expect(NAME_CORPORA.surnames.length).toBeGreaterThanOrEqual(400);
    expect(new Set(NAME_CORPORA.given).size).toBe(NAME_CORPORA.given.length);
    expect(new Set(NAME_CORPORA.surnames).size).toBe(NAME_CORPORA.surnames.length);
  });

  it("C6/#529: an absent archetype yields NEUTRAL stats (no fabricated identity) and is surfaced", () => {
    const p = runPlayerOOBE({ name: "Author" }); // no archetype supplied
    expect(p.archetypeDefaulted).toBe(true);
    // #529: absence ⇒ NEUTRAL/unbiased stats, NOT the fabricated "floater" bias. The engine never
    // deals an archetype's stat profile to a human who never chose one.
    expect(p.character.stats).toEqual({ physical: 0.5, mental: 0.5, social: 0.5 });
    const floaterBias = ARCHETYPES.find((s) => s.archetype === DEFAULT_ARCHETYPE)!.bias;
    expect(p.character.stats).not.toEqual(floaterBias);
    // The default's stats are NOT the global max of any aptitude (anti-sycophancy via fallback is dead).
    const globalMax = Math.max(...ARCHETYPES.flatMap((s) => [s.bias.physical, s.bias.mental, s.bias.social]));
    for (const v of Object.values(p.character.stats)) expect(v).toBeLessThan(globalMax);
    // A recognized archetype is honored and NOT flagged.
    const q = runPlayerOOBE({ name: "Author", archetype: "mastermind" });
    expect(q.archetypeDefaulted).toBeUndefined();
    expect(q.character.stats).toEqual(ARCHETYPES.find((s) => s.archetype === "mastermind")!.bias);
    // The defaulted flag crosses to the casting card (qualitative surface only).
    const s = new GameSessionAdapter();
    const view = s.createCharacter({ playerName: "Author", seed: 7 });
    expect(view.player!.castingCard!.defaulted).toBe(true);
  });

  it("#529: the engine never fabricates player canon — absence yields EMPTY, not invented content", () => {
    // Name-only intake: appearance/age/presentation/background must NOT be improvised.
    const p = runPlayerOOBE({ name: "Author" });
    // (a) NO name-hash-derived appearance — the player authored no look, so it stays empty.
    expect(p.character.appearance).toBe("");
    expect(p.character.age).toBe(0);
    expect(p.character.presentation).toBe("");
    // A different name must NOT yield a different (i.e. name-hash-improvised) appearance.
    const q = runPlayerOOBE({ name: "Someone Else Entirely" });
    expect(q.character.appearance).toBe("");
    expect(q.character.age).toBe(0);
    expect(q.character.presentation).toBe("");
    // (b) NO placeholder background presented as canon.
    expect(p.character.background).toBe("");
    // (c) NO invented persona — only the player's OWN words populate it; absent ⇒ omitted.
    expect(p.persona).toBeUndefined();
    // Authored fields ARE honored (absence ⇒ empty, presence ⇒ kept).
    const authored = runPlayerOOBE({ name: "Author", backstory: "a long road here", personaArchetype: "the quiet one" });
    expect(authored.character.background).toContain("long road");
    expect(authored.persona).toEqual({ archetype: "the quiet one" });
    // The neutral stats still sit inside the cast's bounds (no min-maxing).
    expect(playerAptitudesWithinNpcBounds(p)).toBe(true);
  });

  it("#529: a name-only player produces NO improvised portrait prompt (no name-hash face)", () => {
    const s = new GameSessionAdapter();
    const view = s.createCharacter({ playerName: "Author", seed: 7 });
    // The player authored no look, so there is nothing to draw — no fabricated portrait prompt.
    expect(s.getPortraitPrompt(view.player!.id)).toBeNull();
    // NPCs (engine-generated looks) still get prompts — only the human is appearance-empty.
    const anyNpc = view.house[0]!;
    expect(s.getPortraitPrompt(anyNpc.id)).not.toBeNull();
  });

  it("E39/C7: with NO explicit seed, the same player name does not replay the identical season", () => {
    const a = new GameSessionAdapter();
    const b = new GameSessionAdapter();
    a.createCharacter({ playerName: "Author" });
    b.createCharacter({ playerName: "Author" });
    // The entropy default is persisted (reproducible AFTER creation) and differs per creation.
    const seedA = a.snapshot().seed;
    const seedB = b.snapshot().seed;
    expect(typeof seedA).toBe("number");
    expect(seedA).not.toBe(seedB);
    // An EXPLICIT seed stays first-class for tests/replays: byte-identical houses.
    const c = new GameSessionAdapter();
    const d = new GameSessionAdapter();
    c.createCharacter({ playerName: "Author", seed: 11 });
    d.createCharacter({ playerName: "Author", seed: 11 });
    expect(JSON.stringify(c.snapshot().house)).toBe(JSON.stringify(d.snapshot().house));
  });

  it("no outcome protection: the authored player can and does lose seeded competitions", () => {
    const house = startNewGame({ seed: 3, playerName: "Author", archetype: "floater" });
    const field = [
      { id: house.player.id, stats: house.player.character.stats, emotionalState: 0.5 },
      ...house.npcs.map((n) => ({ id: n.id, stats: n.character.stats, emotionalState: n.soul.emotionalState })),
    ];
    let playerWins = 0;
    for (let s = 1; s <= 60; s++) {
      const { winner } = resolveCompetition(field, "endurance", new CompetitionIntents(), new SeededRandom(s));
      if (winner === house.player.id) playerWins++;
    }
    expect(playerWins).toBeLessThan(60); // unprotected — the player loses real competitions
  });

  it("the house is a balanced ensemble (a spread of archetypes, not a clump)", () => {
    const { npcs } = generateHouse(new SeededRandom(9));
    const archetypes = new Set(npcs.map((n) => n.character.archetype));
    expect(archetypes.size).toBeGreaterThanOrEqual(5);
  });
});

/** ORW-208 - a requested strategy style outside the archetype's own list is substituted, but never silently. */
describe("ORW-208 — strategy-style substitution is reported, not silent", () => {
  it("resolveStrategyStyle keeps an in-list style and reports nothing", () => {
    expect(resolveStrategyStyle("mastermind", "strategic")).toEqual({ applied: "strategic" });
  });
  it("an out-of-list style is replaced by the archetype's first style AND the substitution is reported", () => {
    // the archetype whose list does not offer `strategic` (the live case: a wildcard asked for strategic)
    const r = resolveStrategyStyle("wildcard", "strategic");
    expect(r.applied).toBe("emotional");
    expect(r.adjusted).toEqual({ requested: "strategic", applied: "emotional" });
  });
  it("no requested style or an unauthored archetype reports nothing (the neutral placeholder is not a coercion)", () => {
    expect(resolveStrategyStyle("wildcard", undefined).adjusted).toBeUndefined();
    expect(resolveStrategyStyle(undefined, "strategic").adjusted).toBeUndefined();
  });
  it("runPlayerOOBE stores exactly what resolveStrategyStyle applies (the stored closed set is unchanged)", () => {
    expect(runPlayerOOBE({ name: "Author", archetype: "wildcard", strategyStyle: "strategic" }).character.strategyStyle).toBe("emotional");
    expect(runPlayerOOBE({ name: "Author", archetype: "wildcard", strategyStyle: "aggressive" }).character.strategyStyle).toBe("aggressive");
  });
  it("createCharacter surfaces the substitution in its result (and only then)", () => {
    const adjusted = new GameSessionAdapter().createCharacter({ playerName: "Author", seed: 7, archetype: "wildcard", strategyStyle: "strategic" });
    expect(adjusted.strategyStyleAdjusted).toEqual({ requested: "strategic", applied: "emotional", archetype: "wildcard" });
    const clean = new GameSessionAdapter().createCharacter({ playerName: "Author", seed: 7, archetype: "wildcard", strategyStyle: "aggressive" });
    expect(clean.strategyStyleAdjusted).toBeUndefined();
    const none = new GameSessionAdapter().createCharacter({ playerName: "Author", seed: 7 });
    expect(none.strategyStyleAdjusted).toBeUndefined();
  });
});

