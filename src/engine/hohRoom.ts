import type { EntityId } from "../domain/ids";
import { agendaRoll } from "./agenda";

/**
 * Feature 0199 (ORW-629) - the HOH room reveal. PURE and ENGINE-ONLY (Vault class): when a houseguest is crowned, EVERYONE is invited up to their room. Skipping is a rare, engine-decided snub the house
 * reads as rude. Once up there, a houseguest whose true feeling toward the HOH differs from the warm face the visit asks for either hides it or lets it slip, by how well they can act: the Social
 * aptitude plus a keyed per-person roll (never flat, never a list of traits). Only the SLIP is ever observable; the true feeling and the mask are never stored, shown or sent to any prompt. The photos and
 * the letter reveal one true thing from the HOH's own public backstory, picked by a keyed roll over the facets that very character carries.
 *
 * Every roll is a keyed `agendaRoll` (no shared rng), so a seeded game stays byte-identical; total, deterministic, no I/O. Every tunable lives in `HOH_ROOM` (B59).
 */
export const HOH_ROOM = {
  /** The chance any invited houseguest skips for no deep reason, and the extra a strong feeling against the HOH adds (squared: only a strong one matters), capped. */
  snubBase: 0.012,
  snubFeelingScale: 0.26,
  snubCap: 0.3,
  /** Baselines the edge reads are measured from (the relationship baseline). */
  affinityBaseline: 0.25,
  affinitySpan: 0.5,
  threatBaseline: 0.1,
  threatSpan: 0.5,
  /** How much a held grudge adds to the resentment read, against the affinity read. */
  grudgeShare: 0.4,
  /** The least feeling against the HOH that there is anything to hide. */
  feelingMin: 0.12,
  /** How much of the Social aptitude (the rest is a keyed per-person roll) makes a good actor. */
  socialShare: 0.55,
  /** The slip chance is feeling x (1 - acting) x this, clamped. */
  slipScale: 1.4,
  /** Small, bounded bond moves (directed): the HOH toward a skipper, each other guest toward a skipper, the HOH toward someone whose mask slipped. */
  snubByHoh: { affinity: -0.07, trust: -0.05 },
  snubByHouse: { affinity: -0.02, trust: -0.01 },
  slipByHoh: { affinity: -0.04, trust: -0.03 },
  /** A biography sentence shorter than this is not a fact worth a letter. */
  minSentence: 14,
} as const;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

export type SlipDirection = "resentment" | "fear";

/** What one guest holds toward the HOH, from the directed edge and a held grudge (all 0..1 inputs except the edge, which is the relationship scale). */
export interface FeelingInput { affinity: number; threat: number; grudge?: number }

/** How strongly (0..1) they feel against the HOH, and which way. A pure read; the result is never stored or shown. */
export function feelingAgainst(f: FeelingInput): { level: number; kind: SlipDirection } {
  const cold = clamp01((HOH_ROOM.affinityBaseline - f.affinity) / HOH_ROOM.affinitySpan);
  const resent = clamp01(cold * (1 - HOH_ROOM.grudgeShare) + clamp01(f.grudge ?? 0) * HOH_ROOM.grudgeShare);
  const fear = clamp01((f.threat - HOH_ROOM.threatBaseline) / HOH_ROOM.threatSpan);
  return fear > resent ? { level: fear, kind: "fear" } : { level: resent, kind: "resentment" };
}

/** How well this houseguest can act, 0..1: their Social aptitude and a keyed roll of their own (a person, not a class). Stable for the season. */
export function actingSkill(seed: number, id: EntityId, social: number): number {
  return clamp01(HOH_ROOM.socialShare * clamp01(social) + (1 - HOH_ROOM.socialShare) * agendaRoll(seed, id, "hoh-room:acting"));
}

/** The chance this invited houseguest skips the visit. */
export function snubChance(level: number): number {
  return Math.min(HOH_ROOM.snubCap, HOH_ROOM.snubBase + HOH_ROOM.snubFeelingScale * level * level);
}

export interface GuestInput { id: EntityId; social: number; affinity: number; threat: number; grudge?: number }
export interface VisitOutcome {
  /** Everyone invited (the whole living house but the HOH). */
  invited: EntityId[];
  attended: EntityId[];
  snubbed: EntityId[];
  /** Attendees whose real feeling showed through. Direction only: the strength is not carried. */
  slipped: Array<{ id: EntityId; direction: SlipDirection }>;
}

/** Decide one HOH room visit. Ids are sorted so the result never depends on input order. */
export function decideVisit(seed: number, week: number, hoh: EntityId, guests: readonly GuestInput[]): VisitOutcome {
  const sorted = [...guests].sort((a, b) => a.id.localeCompare(b.id));
  const out: VisitOutcome = { invited: sorted.map((g) => g.id), attended: [], snubbed: [], slipped: [] };
  for (const g of sorted) {
    const f = feelingAgainst(g);
    if (agendaRoll(seed, g.id, `hoh-room:snub:${week}:${hoh}`) < snubChance(f.level)) { out.snubbed.push(g.id); continue; }
    out.attended.push(g.id);
    if (f.level < HOH_ROOM.feelingMin) continue;
    const slip = clamp01(f.level * (1 - actingSkill(seed, g.id, g.social)) * HOH_ROOM.slipScale);
    if (agendaRoll(seed, g.id, `hoh-room:slip:${week}:${hoh}`) < slip) out.slipped.push({ id: g.id, direction: f.kind });
  }
  return out;
}

/** The public backstory facets this character carries: its own stored fields only. Never a menu. */
export function backstoryFacets(c: { vocation?: string; hometown?: string; background?: string; biography?: string; biographyDraft?: boolean }): Array<{ field: string; text: string }> {
  const out: Array<{ field: string; text: string }> = [];
  const add = (field: string, text: string | undefined): void => { const t = text?.trim(); if (t) out.push({ field, text: t }); };
  add("vocation", c.vocation);
  add("hometown", c.hometown);
  add("background", c.background);
  if (!c.biographyDraft && c.biography) {
    for (const s of c.biography.split(/(?<=[.!?])\s+/)) if (s.trim().length >= HOH_ROOM.minSentence) add("biography", s);
  }
  return out;
}

/** A keyed pick over the facets (never one already used for this HOH). Undefined when none is left. */
export function pickBackstoryFact(seed: number, hoh: EntityId, week: number, facets: ReadonlyArray<{ field: string; text: string }>, used: ReadonlySet<string>): { field: string; text: string } | undefined {
  let best: { field: string; text: string } | undefined; let bw = -1;
  for (const f of facets) {
    if (used.has(f.text)) continue;
    const w = agendaRoll(seed, hoh, `hoh-room:fact:${week}:${f.field}:${f.text}`);
    if (w > bw) { bw = w; best = f; }
  }
  return best;
}
