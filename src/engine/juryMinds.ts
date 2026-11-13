/**
 * ORW-253 slice 6 core - JURY AND FINAL HOH FROM CHARACTER (theme 1, NPC minds; design approved by Ryne 2026-11-12, vault "NPC Minds
 * Design Theme 1", section 5).
 *
 *  1. `jurorArchetypeFor` - a juror's voting style comes from WHO THEY ARE (archetype, strategy style, how stubborn/forgiving), not from a
 *     hash of their id (today's `jurorProfile`). A hothead holds grudges, a strategist rewards good play, a peacemaker forgives, a loyalist
 *     rewards loyalty. The id hash survives only as a small tie-break jitter. Returns one of the five existing juror archetypes, so the
 *     existing weight rows (`jurorProfile.ts` ARCHETYPES) are reused unchanged. Note: the old uniform draw kept the HOUSE-MEAN weight of each
 *     term exactly; a character-driven draw follows the cast instead. Balance is measured and reported, never a gate (Ryne 11-05/11-06).
 *  2. `finalHohChoice` - the NPC Final HOH asks who they can BEAT in front of the jury, not only who scares them. For each possible final
 *     two, the HOH's OWN estimate of their jury share (from their reads of the jurors) is blended with threat and bond by character: a
 *     strategist leans on jury odds, a loyalist takes their ally, a hothead cuts their biggest threat.
 *
 * Pure and deterministic. Engine-only. Nothing calls this yet; the slice 6 wiring swaps `jurorProfile` for this archetype and the
 * "evict the higher-threat rival" line (liveSeason.ts ~3106) for `finalHohChoice`, then reports the before/after win spread.
 */
import type { EntityId } from "../domain/ids";
import type { JurorArchetype } from "./jurorProfile";
import type { AgendaCharacter } from "./agenda";
import { agendaRoll } from "./agenda";
import { JURY_MINDS } from "./juryMindsConstants";
import { sumVals, whyOption, type WhySink } from "./decisionWhy";

/** The juror archetype from the juror's own character; a tiny seeded jitter breaks near-ties only. */
export function jurorArchetypeFor(c: AgendaCharacter, juror: EntityId, seed: number): JurorArchetype {
  const fromType = JURY_MINDS.byArchetype[c.archetype] ?? {};
  const fromStyle = JURY_MINDS.byStyle[c.strategyStyle] ?? {};
  const all: JurorArchetype[] = ["competitor", "loyalist", "grudge-holder", "forgiver", "pragmatist"];
  const scored = all.map((a) => ({ a, w: (fromType[a] ?? 0) + (fromStyle[a] ?? 0) + agendaRoll(seed, juror, `juror:${a}`) * JURY_MINDS.jitter }))
    .sort((x, y) => y.w - x.w || x.a.localeCompare(y.a));
  return scored[0]!.a;
}

export interface FinalHohOption {
  /** The houseguest the HOH would evict. */
  evict: EntityId;
  /** The houseguest the HOH would then sit beside in the final two. */
  keep: EntityId;
  /** The HOH's OWN estimate (0..1) of the share of jurors who would vote for the HOH against `keep`. */
  myJuryShareVsKeep: number;
  /** The HOH's threat read of `evict` and bond (affinity) with `evict` (0..1). */
  threatOfEvict: number;
  bondWithEvict: number;
}

export interface FinalHohDecision { evict: EntityId; reason: "beatable-in-finale" | "biggest-threat" | "loyal-to-ally" }

/**
 * The NPC Final HOH's eviction. Each option scores: juryOdds x (jury share vs the kept one) + threat x (threat of the evicted) - bond x
 * (bond with the evicted), with the three weights set by the HOH's character. Ties go to the higher jury share. Deterministic.
 */
export function finalHohChoice(hoh: AgendaCharacter, options: readonly FinalHohOption[], why?: WhySink): FinalHohDecision {
  if (options.length === 0) throw new Error("finalHohChoice: no options");
  const w = { ...JURY_MINDS.finalHoh.base, ...(JURY_MINDS.finalHoh.byArchetype[hoh.archetype] ?? {}) };
  // ORW-305: one pass - the three named terms in the order the score adds them; the score is their sum (`a - b` is `a + (-b)` bit for bit).
  const vals = (o: FinalHohOption): number[] => [w.juryOdds * o.myJuryShareVsKeep, w.threat * o.threatOfEvict, -(w.bond * o.bondWithEvict)];
  const score = (o: FinalHohOption): number => sumVals(vals(o));
  const best = [...options].sort((a, b) => score(b) - score(a) || b.myJuryShareVsKeep - a.myJuryShareVsKeep || a.evict.localeCompare(b.evict))[0]!;
  // The real reason: what the chosen option was best at. Best jury odds => "beatable"; else the biggest threat; else they kept their ally.
  const top = (f: (o: FinalHohOption) => number): FinalHohOption => [...options].sort((x, y) => f(y) - f(x) || x.evict.localeCompare(y.evict))[0]!;
  const reason: FinalHohDecision["reason"] = top((o) => o.myJuryShareVsKeep) === best && w.juryOdds >= w.bond ? "beatable-in-finale"
    : top((o) => o.threatOfEvict) === best && w.threat >= w.bond ? "biggest-threat" : "loyal-to-ally";
  if (why) {
    const nm = ["jury-odds", "threat", "bond"] as const;
    const ru = options.find((o) => o !== best);
    why({ kind: "final-hoh-eviction", rule: reason, options: ru ? [whyOption(best.evict, "chosen", nm, vals(best), score(best)), whyOption(ru.evict, "runner-up", nm, vals(ru), score(ru))] : [whyOption(best.evict, "chosen", nm, vals(best), score(best))] });
  }
  return { evict: best.evict, reason };
}

/**
 * ORW-318: the Final HOH's OWN estimate of their jury share against `keep` if they evict `evictee`. Reads only what the HOH can see:
 * their own bond with each juror, how close they have seen `keep` act with each juror (keep's own warmth toward them, observable), the
 * public resume, and that the evictee joins the jury holding the eviction against them. Never a juror's hidden lean or ballot.
 * `bond(a, b)` is a's (trust + affinity) / 2 toward b. Pure.
 */
export function estimateJuryShare(
  hoh: EntityId, keep: EntityId, evictee: EntityId, jurorsSoFar: readonly EntityId[],
  bond: (a: EntityId, b: EntityId) => number, resume: (id: EntityId) => number,
): number {
  const jury = [...jurorsSoFar, evictee];
  const E = JURY_MINDS.estimate;
  const resumeTerm = (resume(hoh) - resume(keep)) * E.resumePerWin;
  const shares = jury.map((j) => {
    const p = 0.5 + (bond(hoh, j) - bond(keep, j)) + resumeTerm - (j === evictee ? E.evicteeGrudge : 0);
    return p < 0 ? 0 : p > 1 ? 1 : p;
  });
  return shares.reduce((a, b) => a + b, 0) / Math.max(1, shares.length);
}
