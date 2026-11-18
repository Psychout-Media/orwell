import { describe, it, expect } from "vitest";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { RelationshipModel } from "../../src/engine/relationships";
import { generateHouse } from "../../src/engine/characterFactory";
import { newLiveSeason, advance, applyDecision, autoDecision, type SeasonCtx, type LiveSeasonState } from "../../src/engine/liveSeason";
import { replacementPick } from "../../src/engine/season";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-639 (Fable stacking audit S-10): the replacement nominee reads the same deal / pre-show-tie / lobbying / kept-assurance terms as the original
 * nominations (they were dropped before). Roles only. The pure read is proven on `replacementPick`; the wiring (the flag) is proven on whole seeded seasons.
 */
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

/** Play seasons with extra hooks on the ctx; return every NPC replacement record as {chosen, other?, by}. */
function replacements(extra: (x: string, seasonOf: () => LiveSeasonState) => Partial<SeasonCtx>, on: boolean): Array<{ chosen: string; other?: string; x: string }> {
  const out: Array<{ chosen: string; other?: string; x: string }> = [];
  for (const seed of SEEDS) {
    const { npcs } = generateHouse(new SeededRandom(seed));
    const ids = [PLAYER, ...npcs.map((n) => n.id)];
    const x = ids[5]!; // the houseguest the hooks bend
    const rng = new SeededRandom(seed);
    const rel = new RelationshipModel(0.5);
    for (const a of ids) for (const b of ids) if (a !== b) { const e = rel.edge(a, b); e.trust = rng.next(); e.affinity = rng.next(); e.threat = rng.next(); e.confidence = 0.5; }
    let s: LiveSeasonState;
    const ctx: SeasonCtx = { player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel, ...(on ? { replacementFullTerms: true } : {}), ...extra(x, () => s) };
    s = newLiveSeason(ids);
    for (let g = 0; g < 10_000 && !s.finished; g++) s.pending ? applyDecision(s, autoDecision(s, ctx, rng), ctx, rng) : advance(s, ctx, rng);
    for (const w of s.decisionWhy ?? []) if (w.kind === "replacement" && w.by !== PLAYER) out.push({ chosen: w.options[0]!.option, other: w.options[1]?.option, x });
  }
  return out;
}
const named = (r: ReturnType<typeof replacements>): number => r.filter((e) => e.chosen === e.x).length;

describe("ORW-639: the replacement reads the nomination terms it used to drop", () => {
  const shield = (hook: (x: string, seasonOf: () => LiveSeasonState) => Partial<SeasonCtx>): void => {
    const off = replacements(hook, false);
    const on = replacements(hook, true);
    expect(off.length).toBeGreaterThan(5);
    expect(named(off)).toBeGreaterThan(0); // before: the shielded houseguest is named the replacement as if unprotected
    expect(on.filter((e) => e.chosen === e.x && e.other !== undefined).length).toBe(0); // now: never, while another legal option remains
  };
  it("a protective deal push shields the houseguest as a replacement", () => shield((x) => ({ dealNomPushFor: (t) => (t === x ? -100 : 0) })));
  it("a pre-show tie shields the houseguest as a replacement", () => shield((x) => ({ tieNomPushFor: (t) => (t === x ? -100 : 0) })));
  it("a kept assurance shields the houseguest as a replacement", () => shield((x) => ({ assuranceProtects: (t) => t === x })));
  it("a lobbying pitch pulls the replacement toward the pitched houseguest", () => {
    // the pitch bites only once the veto has saved someone (so the houseguest is not nominated first and stays a replacement option)
    const hook = (x: string, seasonOf: () => LiveSeasonState): Partial<SeasonCtx> => ({ pitchTiltFor: (t) => (t === x && seasonOf().saved !== undefined ? 100 : 0) });
    const off = replacements(hook, false);
    const on = replacements(hook, true);
    expect(named(on)).toBeGreaterThan(named(off));
  });
  it("flag off (or hooks absent) is the old read: same replacements", () => {
    const hook = (x: string): Partial<SeasonCtx> => ({ dealNomPushFor: (t) => (t === x ? -100 : 0) });
    expect(replacements(hook, false)).toEqual(replacements(hook, false));
    expect(replacements(() => ({}), true)).toEqual(replacements(() => ({}), false)); // no hooks => the flag moves nothing
  });
});

describe("ORW-639: replacementPick with the shared terms (pure)", () => {
  const npc = (n: number): string => `n${n}`;
  const active = [1, 2, 3, 4, 5, 6].map(npc);
  const rel = new RelationshipModel(0.5);
  const options = [npc(3), npc(4), npc(5)];
  const base = replacementPick(npc(1), npc(2), options, active, rel, { target: npc(2) });
  it("a deal push, a tie, or an assurance moves the pick off a protected houseguest; a pitch moves it onto the pitched one", () => {
    expect(replacementPick(npc(1), npc(2), options, active, rel, { target: npc(2), dealPush: (t) => (t === base ? -9 : 0) })).not.toBe(base);
    expect(replacementPick(npc(1), npc(2), options, active, rel, { target: npc(2), protectedByAssurance: (t) => t === base })).not.toBe(base);
    const other = options.find((o) => o !== base)!;
    expect(replacementPick(npc(1), npc(2), options, active, rel, { target: npc(2), pitchPush: (t) => (t === other ? 9 : 0) })).toBe(other);
  });
  it("when everyone is assured the shield stands down (one seat must be filled)", () => {
    expect(options).toContain(replacementPick(npc(1), npc(2), options, active, rel, { target: npc(2), protectedByAssurance: () => true }));
  });
});
