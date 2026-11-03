import { describe, it, expect } from "vitest";
import { npc, PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { ARCHETYPES } from "../../src/engine/characterFactory";
import { GIVEN_NAMES } from "../../src/engine/data/givenNames";
import {
  validateCastGenesis, clampStatsIntoBand, castVarianceOk, isPlausibleGenesisName,
  hitsLegacyDenyList, generateSeasonBrief, assignGenesisSlots, renderSlotDirective,
  LEGACY_BIBLE_NAMES,
} from "../../src/engine/castGenesis";
import {
  GENESIS_ROLE_MAX_PER_CAST, GENESIS_CEREBRAL_MAX_PER_CAST, GENESIS_AMPLIFIED_MIN,
} from "../../src/engine/genesisConstants";
import type {
  CastGenesisProposal, GenesisContext, GenesisNpcContext, GenesisNpcProposal,
} from "../../src/engine/castGenesis";
import {
  GENESIS_TOTAL_BAND, GENESIS_STAT_CLAMP,
} from "../../src/engine/genesisConstants";

// Feature 0116 — the ENGINE VALIDATION ENVELOPE. Roles only: NPCs are engine ids (npc:1..15); test
// display names are OBVIOUSLY-SYNTHETIC military-phonetic-alphabet fixtures (NEVER a corpus/legacy cast).

// NATO-alphabet given/surname tokens — plausible-shaped, obviously not a real BB cast, corpus-clean.
const NATO = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India",
  "Juliet", "Kilo", "Lima", "Mike", "Oscar", "Papa", "Quebec", "Romeo", "Sierra", "Tango", "Uniform",
  "Victor", "Whiskey", "Yankee", "Zulu", "Nova", "Onyx", "Perry", "Reed", "Sable", "Vesper"];
const synthName = (i: number): string => `${NATO[i % NATO.length]} ${NATO[(i + 7) % NATO.length]}`;

const biasOf = (a: number): { physical: number; mental: number; social: number } => ARCHETYPES[a % ARCHETYPES.length]!.bias;

/** A warmed floor-cast context of `n` NPCs (npc:1..n), archetypes/stats cycling the real table. */
function mkCtx(n: number, extra: Partial<GenesisContext> = {}): GenesisContext {
  const npcs: GenesisNpcContext[] = Array.from({ length: n }, (_, i) => ({
    id: npc(i + 1),
    floorArchetype: ARCHETYPES[i % ARCHETYPES.length]!.archetype,
    floorStats: { ...biasOf(i) },
    floorName: synthName(i),
  }));
  return { npcs, playerId: PLAYER, ...extra };
}

/** A full 15-NPC proposal, one field-overridden per NPC by `perNpc`. */
function mkProposal(ctx: GenesisContext, perNpc: (i: number, id: EntityId) => GenesisNpcProposal): CastGenesisProposal {
  return { npcs: ctx.npcs.map((c, i) => ({ id: c.id, ...perNpc(i, c.id) })) };
}

/** A spread of in-band stats so a whole-cast proposal clears the variance floor by default. */
function variedStats(i: number): { physical: number; mental: number; social: number } {
  const base = 0.3 + ((i * 37) % 55) / 100; // 0.30..0.84, well spread
  const p = Math.min(0.9, Math.max(0.2, base + 0.2));
  const m = Math.min(0.9, Math.max(0.2, 0.9 - base));
  const s = Math.min(0.9, Math.max(0.2, 0.3 + ((i * 53) % 50) / 100));
  return { physical: p, mental: m, social: s };
}

describe("0116 — the seeded season brief (§2 DECIDED #5)", () => {
  it("same seed ⇒ byte-equal brief; independent of any player field", () => {
    const a = generateSeasonBrief(4242);
    const b = generateSeasonBrief(4242);
    expect(a).toEqual(b);
    // Player-independent by construction: the generator takes ONLY the seed.
    expect(generateSeasonBrief.length).toBe(1);
  });
  it("different seeds steer (usually) different briefs", () => {
    const briefs = new Set(Array.from({ length: 12 }, (_, i) => JSON.stringify(generateSeasonBrief(1000 + i))));
    expect(briefs.size).toBeGreaterThan(1); // finite space, but distinct seeds spread
  });
});

describe("0116 — the seeded per-slot casting cards (assignGenesisSlots)", () => {
  const CEREBRAL = new Set(["mastermind", "analyst", "superfan gamebot"]);
  it("is deterministic + honors the casting quota, physical floor, accent minority, and loud contingent", () => {
    for (const seed of [108108, 0, 5, 7, 42, 999, 2147483647]) {
      const slots = assignGenesisSlots(seed, 15);
      expect(assignGenesisSlots(seed, 15)).toEqual(slots); // deterministic
      // cap ANY casting role at 2; combined cerebral capped at 3.
      const roleCounts = new Map<string, number>();
      for (const s of slots) roleCounts.set(s.role, (roleCounts.get(s.role) ?? 0) + 1);
      for (const v of roleCounts.values()) expect(v).toBeLessThanOrEqual(GENESIS_ROLE_MAX_PER_CAST);
      let cerebral = 0;
      for (const [r, v] of roleCounts) if (CEREBRAL.has(r)) cerebral += v;
      expect(cerebral).toBeLessThanOrEqual(GENESIS_CEREBRAL_MAX_PER_CAST);
      // 3–4 genuine physical comp threats.
      const physical = slots.filter((s) => s.physical).length;
      expect(physical).toBeGreaterThanOrEqual(3);
      expect(physical).toBeLessThanOrEqual(4);
      // the accent is a seeded 20–30% minority.
      const accented = slots.filter((s) => s.accent !== null).length;
      expect(accented).toBeGreaterThanOrEqual(Math.round(0.2 * 15) - 1);
      expect(accented).toBeLessThanOrEqual(Math.round(0.3 * 15) + 1);
      // a loud/reactive/main-character contingent is GUARANTEED (never a uniformly reserved cast).
      expect(slots.filter((s) => s.amplified).length).toBeGreaterThanOrEqual(GENESIS_AMPLIFIED_MIN);
      const louds = slots.filter((s) =>
        /loud|unfiltered|over-sharing/.test(s.expressiveness) || /main-character/.test(s.socialGravity)).length;
      expect(louds).toBeGreaterThanOrEqual(4);
      // every archetype tag is a valid mechanical enum member (the role→archetype map stays in the 12).
      for (const s of slots) expect(ARCHETYPES.some((a) => a.archetype === s.archetype)).toBe(true);
    }
  });
});

describe("0116 — banded stat clamp (§3/§8: no model number escapes)", () => {
  it("an over-budget total is clamped + renormalized inside the band, shape preserved, nothing raw", () => {
    const s = clampStatsIntoBand({ physical: 0.9, mental: 0.8, social: 0.7 }); // total 2.4 > band.hi
    const total = s.physical + s.mental + s.social;
    expect(total).toBeGreaterThanOrEqual(GENESIS_TOTAL_BAND.lo - 1e-6);
    expect(total).toBeLessThanOrEqual(GENESIS_TOTAL_BAND.hi + 1e-6);
    // relative shape preserved (physical > mental > social)
    expect(s.physical).toBeGreaterThan(s.mental);
    expect(s.mental).toBeGreaterThan(s.social);
    // no committed stat outside the per-stat clamp
    for (const v of [s.physical, s.mental, s.social]) {
      expect(v).toBeGreaterThanOrEqual(GENESIS_STAT_CLAMP.min - 1e-9);
      expect(v).toBeLessThanOrEqual(GENESIS_STAT_CLAMP.max + 1e-9);
    }
  });
  it("wildly out-of-range raw numbers never commit unclamped", () => {
    const s = clampStatsIntoBand({ physical: 42, mental: -9, social: 100 });
    const total = s.physical + s.mental + s.social;
    for (const v of [s.physical, s.mental, s.social]) {
      expect(v).toBeGreaterThanOrEqual(GENESIS_STAT_CLAMP.min - 1e-9);
      expect(v).toBeLessThanOrEqual(GENESIS_STAT_CLAMP.max + 1e-9);
    }
    expect(total).toBeGreaterThanOrEqual(GENESIS_TOTAL_BAND.lo - 1e-6);
    expect(total).toBeLessThanOrEqual(GENESIS_TOTAL_BAND.hi + 1e-6);
  });
  it("an under-budget total is scaled UP into the band (real floaters still clear the floor)", () => {
    const s = clampStatsIntoBand({ physical: 0.2, mental: 0.2, social: 0.2 }); // total 0.6 < band.lo
    const total = s.physical + s.mental + s.social;
    expect(total).toBeGreaterThanOrEqual(GENESIS_TOTAL_BAND.lo - 1e-6);
    expect(total).toBeLessThanOrEqual(GENESIS_TOTAL_BAND.hi + 1e-6);
  });
  it("a partly-clamped under-budget line still fits the band (water-fill residual)", () => {
    const s = clampStatsIntoBand({ physical: 0.9, mental: 0.2, social: 0.2 }); // clamp→1.3<lo, physical pinned at max
    const total = s.physical + s.mental + s.social;
    expect(total).toBeGreaterThanOrEqual(GENESIS_TOTAL_BAND.lo - 1e-6);
    expect(total).toBeLessThanOrEqual(GENESIS_TOTAL_BAND.hi + 1e-6);
  });
  it("real comp beasts AND real floaters both commit without repair when already in band", () => {
    const ctx = mkCtx(15);
    const proposal = mkProposal(ctx, (i) => {
      if (i === 0) return { stats: { physical: 0.9, mental: 0.7, social: 0.5 } };     // total 2.1 top
      if (i === 1) return { stats: { physical: 0.5, mental: 0.5, social: 0.47 } };    // total 1.47 bottom
      return { stats: variedStats(i) };
    });
    const res = validateCastGenesis(proposal, ctx);
    expect(res.varianceOk).toBe(true);
    // Both in-band proposals commit UNCHANGED (no clamp needed).
    expect(res.npcs[0]!.stats).toEqual({ physical: 0.9, mental: 0.7, social: 0.5 });
    expect(res.npcs[1]!.stats).toEqual({ physical: 0.5, mental: 0.5, social: 0.47 });
    // No stat-scoped re-roll violation for either.
    expect(res.violations.some((v) => v.npcId === npc(1) && v.field.startsWith("stat"))).toBe(false);
  });
});

describe("0116 — cast-wide variance floor (§3/§8)", () => {
  it("a flat cast fails the variance floor: stats dropped, cast-scope re-roll raised", () => {
    const ctx = mkCtx(15);
    const proposal = mkProposal(ctx, () => ({ stats: { physical: 0.6, mental: 0.6, social: 0.6 } }));
    const res = validateCastGenesis(proposal, ctx);
    expect(res.varianceOk).toBe(false);
    expect(res.npcs.every((n) => n.stats === undefined)).toBe(true); // floor stands
    expect(res.violations.some((v) => v.scope === "cast" && v.field === "stats.variance")).toBe(true);
  });
  it("a genuinely varied cast clears the floor and commits its clamped stats", () => {
    const ctx = mkCtx(15);
    const proposal = mkProposal(ctx, (i) => ({ stats: variedStats(i) }));
    const res = validateCastGenesis(proposal, ctx);
    expect(res.varianceOk).toBe(true);
    expect(res.npcs.every((n) => n.stats !== undefined)).toBe(true);
  });
  it("castVarianceOk: identical totals fail, a spread passes", () => {
    const flat = Array.from({ length: 15 }, () => ({ physical: 0.6, mental: 0.6, social: 0.6 }));
    expect(castVarianceOk(flat)).toBe(false);
    const varied = Array.from({ length: 15 }, (_, i) => variedStats(i));
    expect(castVarianceOk(varied)).toBe(true);
  });
});

describe("0116 — names are validated, not pooled (§3)", () => {
  it("isPlausibleGenesisName: shape / single-token / digits / markup / length", () => {
    expect(isPlausibleGenesisName("Alpha Bravo")).toBe(true);
    expect(isPlausibleGenesisName("Charlie")).toBe(false);         // single token
    expect(isPlausibleGenesisName("Alpha Br4vo")).toBe(false);     // digit
    expect(isPlausibleGenesisName("Alpha <b>Bravo</b>")).toBe(false); // markup
    expect(isPlausibleGenesisName("Xzcvbn Qwrtp")).toBe(false);    // no-vowel / consonant run gibberish
    expect(isPlausibleGenesisName(`Alpha ${"B".repeat(40)}ravo`)).toBe(false); // over length
  });
  it("hitsLegacyDenyList catches a legacy-Bible given name in any token", () => {
    expect(hitsLegacyDenyList(`${LEGACY_BIBLE_NAMES[0]} Bravo`)).toBe(true);
    expect(hitsLegacyDenyList("Alpha Bravo")).toBe(false);
  });
  it("the legacy deny-list names are ALSO absent from the vendored corpus (both paths, §5)", () => {
    for (const n of LEGACY_BIBLE_NAMES) expect(GIVEN_NAMES).not.toContain(n);
  });

  function nameCase(name: string, extraCtx: Partial<GenesisContext> = {}): ReturnType<typeof validateCastGenesis> {
    const ctx = mkCtx(15, extraCtx);
    const proposal = mkProposal(ctx, (i, id) => (id === npc(1) ? { name } : {}));
    return validateCastGenesis(proposal, ctx);
  }
  const rerolled = (res: ReturnType<typeof validateCastGenesis>): boolean =>
    res.npcs[0]!.name === undefined && res.violations.some((v) => v.npcId === npc(1) && v.field === "name" && v.action === "re-roll");

  it("a plausible unique name is accepted", () => {
    const res = nameCase("Vesper Onyx");
    expect(res.npcs[0]!.name).toBe("Vesper Onyx");
  });
  it("a legacy-Bible name is refused for that NPC", () => {
    expect(rerolled(nameCase(`${LEGACY_BIBLE_NAMES[1]} Onyx`))).toBe(true);
  });
  it("a single-token / digit / markup / over-length name is refused (shape rule)", () => {
    expect(rerolled(nameCase("Solo"))).toBe(true);
    expect(rerolled(nameCase("Alpha 2Bravo"))).toBe(true);
    expect(rerolled(nameCase(`Alpha ${"B".repeat(40)}ravo`))).toBe(true);
  });
  it("a name colliding with the player is refused", () => {
    expect(rerolled(nameCase("Sable Reed", { playerName: "Sable Reed" }))).toBe(true);
  });
  it("a name repeating a prior season is refused", () => {
    expect(rerolled(nameCase("Perry Nova", { priorSeasonNames: ["Perry Quondam"] }))).toBe(true);
  });
  it("a duplicate given/surname WITHIN the cast is refused for the later NPC", () => {
    const ctx = mkCtx(15);
    const proposal = mkProposal(ctx, (i, id) => {
      if (id === npc(1)) return { name: "Nova Sable" };
      if (id === npc(2)) return { name: "Nova Vesper" }; // duplicate given "Nova"
      return {};
    });
    const res = validateCastGenesis(proposal, ctx);
    expect(res.npcs[0]!.name).toBe("Nova Sable");
    expect(res.npcs[1]!.name).toBeUndefined();
    expect(res.violations.some((v) => v.npcId === npc(2) && v.field === "name")).toBe(true);
  });
});

describe("0116 — freeform identity verbatim + archetype derived (§3)", () => {
  it("the freeform identity is stored byte-equal; a valid tag rides beside it; an invalid tag falls to the floor", () => {
    const ctx = mkCtx(15);
    const concept = "a chaos-agent podcaster who treats the house like a live show";
    const proposal = mkProposal(ctx, (i, id) => {
      if (id === npc(1)) return { identity: concept, archetype: "villain" };
      if (id === npc(2)) return { identity: "a quiet strategist", archetype: "not-a-real-archetype" };
      return {};
    });
    const res = validateCastGenesis(proposal, ctx);
    expect(res.npcs[0]!.identityConcept).toBe(concept);
    expect(res.npcs[0]!.archetype).toBe("villain");
    // invalid tag ⇒ no committed archetype (adapter keeps floor) + a repaired violation
    expect(res.npcs[1]!.identityConcept).toBe("a quiet strategist");
    expect(res.npcs[1]!.archetype).toBeUndefined();
    expect(res.violations.some((v) => v.npcId === npc(2) && v.field === "archetype")).toBe(true);
  });
});

describe("0116 — hidden elements: kinds closed, C9-gated, count-clamped (§3)", () => {
  it("a kind outside the closed set is stripped with a violation", () => {
    const ctx = mkCtx(15);
    const proposal = mkProposal(ctx, (i, id) => (id === npc(1) ? {
      hiddenElements: [
        { kind: "made-up-kind", detail: "x" },
        { kind: "divergent-persona", detail: "smiles through a grudge" },
        { kind: "pre-game-tie", detail: "knew a producer" },
        { kind: "secret-motive", detail: "wants the fame" },
      ],
    } : {}));
    const res = validateCastGenesis(proposal, ctx);
    // Below the 3-element floor after the strip (only 3 valid) — actually exactly 3 remain ⇒ accepted.
    expect(res.violations.some((v) => v.npcId === npc(1) && v.field === "hiddenElements.kind")).toBe(true);
    expect((res.npcs[0]!.hiddenElements ?? []).every((e) => (e.kind as string) !== "made-up-kind")).toBe(true);
  });
  it("a concealed-aptitude the stats don't back is stripped (C9)", () => {
    const ctx = mkCtx(15);
    // floor archetype for npc:1 is ARCHETYPES[0] (comp-beast, physical bias high). A MENTAL concealed
    // aptitude with LOW committed mental stat is not stat-backed ⇒ stripped.
    const proposal = mkProposal(ctx, (i, id) => (id === npc(1) ? {
      stats: { physical: 0.8, mental: 0.25, social: 0.5 },
      hiddenElements: [
        { kind: "concealed-aptitude", detail: "is far sharper at puzzles than they pretend" }, // mental — not backed
        { kind: "divergent-persona", detail: "acts like a harmless floater while reading the whole house" },
        { kind: "pre-game-tie", detail: "shares a hometown with someone" },
        { kind: "secret-motive", detail: "is here for redemption" },
      ],
    } : { stats: variedStats(i) }));
    const res = validateCastGenesis(proposal, ctx);
    expect(res.violations.some((v) => v.npcId === npc(1) && v.field === "hiddenElements.concealed-aptitude")).toBe(true);
    expect((res.npcs[0]!.hiddenElements ?? []).some((e) => e.kind === "concealed-aptitude")).toBe(false);
  });
  it("at most one secret-motive commits; the excess is stripped", () => {
    const ctx = mkCtx(15);
    const proposal = mkProposal(ctx, (i, id) => (id === npc(1) ? {
      hiddenElements: [
        { kind: "secret-motive", detail: "wants the fame far more than the prize" },
        { kind: "secret-motive", detail: "is here for redemption after a public failure" },
        { kind: "divergent-persona", detail: "seems naive but clocks every move" },
        { kind: "pre-game-tie", detail: "once crossed paths with a houseguest" },
      ],
    } : {}));
    const res = validateCastGenesis(proposal, ctx);
    const motives = (res.npcs[0]!.hiddenElements ?? []).filter((e) => e.kind === "secret-motive");
    expect(motives.length).toBe(1);
    expect(res.violations.some((v) => v.npcId === npc(1) && v.field === "hiddenElements.secret-motive")).toBe(true);
  });
  it("a shortfall (too few valid elements) drops the whole set to the floor + re-roll", () => {
    const ctx = mkCtx(15);
    const proposal = mkProposal(ctx, (i, id) => (id === npc(1) ? {
      hiddenElements: [{ kind: "secret-motive", detail: "wants fame" }, { kind: "bogus", detail: "x" }],
    } : {}));
    const res = validateCastGenesis(proposal, ctx);
    expect(res.npcs[0]!.hiddenElements).toBeUndefined(); // floor stands
    expect(res.violations.some((v) => v.npcId === npc(1) && v.field === "hiddenElements" && v.action === "re-roll")).toBe(true);
  });
  it("the count is capped at the range max (excess trimmed)", () => {
    const ctx = mkCtx(15);
    const proposal = mkProposal(ctx, (i, id) => (id === npc(1) ? {
      hiddenElements: Array.from({ length: 9 }, (_, k) => ({ kind: "divergent-persona", detail: `distinct secret ${k}` })),
    } : {}));
    const res = validateCastGenesis(proposal, ctx);
    expect((res.npcs[0]!.hiddenElements ?? []).length).toBeLessThanOrEqual(6);
  });
  it("no committed hidden element is ever a 'trigger' (0091 arms those engine-side)", () => {
    const ctx = mkCtx(15);
    const proposal = mkProposal(ctx, (i, id) => (id === npc(1) ? {
      hiddenElements: [
        { kind: "trigger", detail: "a buried temper" },
        { kind: "divergent-persona", detail: "smiles through a grudge" },
        { kind: "pre-game-tie", detail: "knew a producer" },
        { kind: "secret-motive", detail: "wants the fame" },
      ],
    } : {}));
    const res = validateCastGenesis(proposal, ctx);
    expect((res.npcs[0]!.hiddenElements ?? []).some((e) => e.kind === "trigger")).toBe(false);
  });
});

describe("0116 — tie-graph sanity (§3 / 0059 sparseness)", () => {
  it("an oversized tie graph is dropped to the budget; committed ties seal 'sealed'", () => {
    const ctx = mkCtx(15);
    const proposal: CastGenesisProposal = {
      npcs: ctx.npcs.map((c) => ({ id: c.id })),
      ties: [
        { a: npc(1), b: npc(2), nature: "shared-hometown" },
        { a: npc(3), b: npc(4), nature: "mutual-friend" },
        { a: npc(5), b: npc(6), nature: "old-acquaintance" }, // over budget (2)
      ],
    };
    const res = validateCastGenesis(proposal, ctx);
    expect(res.ties.length).toBe(2);
    expect(res.ties.every((t) => t.exposure === "sealed")).toBe(true);
    expect(res.violations.some((v) => v.field === "ties")).toBe(true);
  });
  it("a tie to the player, a self-tie, and an NPC in two ties are all refused", () => {
    const ctx = mkCtx(15);
    const proposal: CastGenesisProposal = {
      npcs: ctx.npcs.map((c) => ({ id: c.id })),
      ties: [
        { a: npc(1), b: PLAYER },          // to the player
        { a: npc(2), b: npc(2) },           // self
        { a: npc(3), b: npc(4) },           // valid
        { a: npc(3), b: npc(5) },           // npc:3 doubled
      ],
    };
    const res = validateCastGenesis(proposal, ctx);
    expect(res.ties.length).toBe(1);
    expect(res.ties[0]).toMatchObject({ a: npc(3), b: npc(4) });
    expect(res.violations.filter((v) => v.field === "ties").length).toBeGreaterThanOrEqual(3);
  });
  it("#1909: a model-authored tie nature is kept; a legacy 'showmance' aliases to 'prior-romance'; an unknown one falls back", () => {
    const ctx = mkCtx(15);
    const res = validateCastGenesis({
      npcs: ctx.npcs.map((c) => ({ id: c.id })),
      ties: [
        { a: npc(1), b: npc(2), nature: "family" },
        { a: npc(3), b: npc(4), nature: "showmance" as never }, // a pre-#1909 prompt/output
      ],
    }, ctx);
    expect(res.ties.map((t) => t.nature)).toEqual(["family", "prior-romance"]);
    const unknown = validateCastGenesis({
      npcs: ctx.npcs.map((c) => ({ id: c.id })),
      ties: [{ a: npc(1), b: npc(2), nature: "not-a-nature" as never }],
    }, ctx);
    expect(unknown.ties[0]!.nature).toBe("old-acquaintance");
  });
  it("a duplicate pair is dropped", () => {
    const ctx = mkCtx(15);
    const proposal: CastGenesisProposal = {
      npcs: ctx.npcs.map((c) => ({ id: c.id })),
      ties: [{ a: npc(1), b: npc(2) }, { a: npc(2), b: npc(1) }],
    };
    const res = validateCastGenesis(proposal, ctx);
    expect(res.ties.length).toBe(1);
  });
});

describe("0116 — hidden game weights are never proposable (§3 last row)", () => {
  it("influence / volatility / a day-one read are ignored + flagged, never committed", () => {
    const ctx = mkCtx(15);
    const proposal = mkProposal(ctx, (i, id) => (id === npc(1) ? {
      influence: { persuasiveness: 0.99 },
      volatility: 0.9,
      dayOnePerception: { trustLean: 0.9, threatLean: -0.9 },
    } as GenesisNpcProposal : {}));
    const res = validateCastGenesis(proposal, ctx);
    const committed = res.npcs[0]! as unknown as Record<string, unknown>;
    for (const k of ["influence", "volatility", "dayOnePerception", "persuasiveness"]) {
      expect(committed[k]).toBeUndefined();
    }
    expect(res.violations.some((v) => v.npcId === npc(1) && v.action === "ignored" && v.field === "influence")).toBe(true);
    expect(res.violations.some((v) => v.npcId === npc(1) && v.action === "ignored" && v.field === "volatility")).toBe(true);
  });
});

describe("0116 — post-hoc near-duplicate nudge (§2)", () => {
  it("an NPC mirroring the player's vocation + hometown re-rolls the vocation, keeps the rest", () => {
    const ctx = mkCtx(15, { playerVocation: "ER nurse", playerHometown: "Austin, TX" });
    const proposal = mkProposal(ctx, (i, id) => (id === npc(1)
      ? { vocation: "ER nurse", hometown: "Austin, TX", identity: "a warm floor-nurse", biography: "a real bio" }
      : {}));
    const res = validateCastGenesis(proposal, ctx);
    expect(res.npcs[0]!.vocation).toBeUndefined(); // colliding facet re-rolled ⇒ floor vocation stands
    expect(res.npcs[0]!.hometown).toBe("Austin, TX"); // the rest of the identity preserved
    expect(res.npcs[0]!.identityConcept).toBe("a warm floor-nurse");
    expect(res.violations.some((v) => v.npcId === npc(1) && v.field === "vocation" && v.action === "re-roll")).toBe(true);
  });
});

describe("2026-07-21 prompt audit — cross-cast facet dedupe backstop (the 'San Diego ×2' defect)", () => {
  it("a duplicate hometown CITY is dropped (state-spelling variants collide); the first stands", () => {
    const ctx = mkCtx(15);
    const proposal = mkProposal(ctx, (i, id) => {
      if (id === npc(1)) return { hometown: "San Diego, CA" };
      if (id === npc(2)) return { hometown: "San Diego, California" }; // same city, different spelling
      return { hometown: `Distinct Town ${i}, TX` };
    });
    const res = validateCastGenesis(proposal, ctx);
    expect(res.npcs[0]!.hometown).toBe("San Diego, CA");
    expect(res.npcs[1]!.hometown).toBeUndefined(); // dropped ⇒ the floor's unique dealt hometown stands
    expect(res.violations.some((v) => v.npcId === npc(2) && v.field === "hometown" && v.action === "dropped")).toBe(true);
  });
  it("a vocation already used twice is dropped for the third houseguest (mirrors MAX_PER_VOCATION)", () => {
    const ctx = mkCtx(15);
    const proposal = mkProposal(ctx, (i, id) => {
      if (id === npc(1) || id === npc(2) || id === npc(3)) return { vocation: "Barista" };
      return { vocation: `distinct job ${i}` };
    });
    const res = validateCastGenesis(proposal, ctx);
    expect(res.npcs[0]!.vocation).toBe("Barista");
    expect(res.npcs[1]!.vocation).toBe("Barista");
    expect(res.npcs[2]!.vocation).toBeUndefined(); // third pile-up dropped ⇒ the floor's capped deal stands
    expect(res.violations.some((v) => v.npcId === npc(3) && v.field === "vocation" && v.action === "dropped")).toBe(true);
  });
});

describe("2026-07-21 prompt audit — the seeded LOOK LANE (the visible-ink budget)", () => {
  it("deals 2-4 inked slots per cast; every other slot carries a suggested feature; deterministic", () => {
    for (const seed of [108108, 0, 5, 7, 42, 999, 2147483647]) {
      const slots = assignGenesisSlots(seed, 15);
      expect(assignGenesisSlots(seed, 15)).toEqual(slots); // deterministic (the new lane included)
      const inked = slots.filter((s) => s.ink);
      expect(inked.length).toBeGreaterThanOrEqual(2);
      expect(inked.length).toBeLessThanOrEqual(4); // a real cast's small tattooed minority, never 15/15
      for (const s of slots) {
        if (s.ink) expect(s.lookFeature).toBe("");
        else expect(s.lookFeature.length).toBeGreaterThan(0);
      }
    }
  });
  it("the rendered casting card carries the look line (ink grant vs no-ink + feature)", () => {
    const slots = assignGenesisSlots(108108, 15);
    const inkedIx = slots.findIndex((s) => s.ink);
    const plainIx = slots.findIndex((s) => !s.ink);
    expect(renderSlotDirective(npc(inkedIx + 1), slots[inkedIx]!)).toContain("visible tattoos ARE part of their look");
    const plain = renderSlotDirective(npc(plainIx + 1), slots[plainIx]!);
    expect(plain).toContain("NO visible tattoos");
    expect(plain).toContain(slots[plainIx]!.lookFeature);
  });
});

describe("0116 — a valid full proposal commits inside the envelope", () => {
  it("15 NPCs, varied stats, valid names, ties — all commit, no re-roll violations", () => {
    const ctx = mkCtx(15);
    const proposal: CastGenesisProposal = {
      npcs: ctx.npcs.map((c, i) => ({
        id: c.id,
        name: synthName(i),
        identity: `a distinct houseguest number ${i}`,
        stats: variedStats(i),
        hiddenElements: [
          { kind: "divergent-persona", detail: `plays a role, number ${i}` },
          { kind: "pre-game-tie", detail: `a quiet pre-show pact, number ${i}` },
          { kind: "secret-motive", detail: `a private reason, number ${i}` },
        ],
      })),
      ties: [{ a: npc(1), b: npc(2), nature: "casting-callback" }],
    };
    const res = validateCastGenesis(proposal, ctx);
    expect(res.varianceOk).toBe(true);
    expect(res.npcs.length).toBe(15);
    expect(res.npcs.every((n) => n.name !== undefined && n.stats !== undefined && (n.hiddenElements ?? []).length >= 3)).toBe(true);
    expect(res.ties.length).toBe(1);
    expect(res.violations.filter((v) => v.action === "re-roll").length).toBe(0);
  });
});
