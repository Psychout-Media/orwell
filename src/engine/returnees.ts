import type { EntityId } from "../domain/ids";
import { clamp01Raw as clamp01 } from "../domain/num";
import {
  castsReturner, carriedClaims, pickReturner, softenedFeelings,
  type ArchivedHouseguest, type ArchivedPersona, type CarriedClaim, type EndFeelings, type SeasonStart,
} from "./seasonMemory";
import { agendaRoll } from "./agenda";
import { ARCHETYPES, CONCEALED_APTITUDES, type Character, type HiddenElement } from "./characterFactory";
import { HIDDEN_ELEMENT_GATES } from "./characterFactory";
import { RELATIONSHIP_CONSTANTS } from "./relationshipConstants";
import type { BeliefClaim, ClaimKind } from "./beliefStore";

/**
 * THEME B slice B1 (ORW-663, spec 0208): RETURNING HOUSEGUESTS. Pure: no I/O, no shared rng (every roll is a keyed `agendaRoll`), no Vault handle.
 *
 * Ryne's hard rule: ONLY a real houseguest from a season THIS player actually played may return. The per-user archive (written at a finished, played
 * season's end) is the only source; `resolveReturnee` is the validator that makes it structural: anything that does not resolve to a complete archived
 * entry (season + id + name + persona on file) is rejected, and the caller falls back to a fresh cast member. Cast genesis cannot propose one at all
 * (`returnee`/`returning` are structurally unproposable keys in castGenesis).
 *
 * The wall: the archive keeps the static PUBLIC persona (never `hiddenElements`), the placement/juror fact (public), the returner's own end feelings
 * toward the player and their own claims about the player (hidden layer, ENGINE-ONLY, never projected). They re-enter as a softened residue folded into
 * the hidden edge and as the returner's OWN beliefs; the player sees no number, and hears an account only in a scene via the usual claim pathways.
 */

/** A proposal that a particular past houseguest return (what a model or any caller would hand over): matched exactly against the archive. */
export interface ReturneeProposal { season: number; npcId: string; name?: string }

/** The validator: an archived entry only when the proposal matches one COMPLETE real entry exactly; otherwise undefined (fail-closed). */
export function resolveReturnee(proposal: ReturneeProposal | undefined | null, archive: readonly ArchivedHouseguest[]): ArchivedHouseguest | undefined {
  if (!proposal || typeof proposal.season !== "number" || typeof proposal.npcId !== "string") return undefined;
  const hit = archive.find((h) => h.season === proposal.season && h.npcId === proposal.npcId && h.characterRef === `${h.season}:${h.npcId}`);
  if (!hit || !hit.persona || typeof hit.name !== "string" || hit.name.trim() === "") return undefined;
  if (proposal.name !== undefined && proposal.name.trim().toLowerCase() !== hit.name.trim().toLowerCase()) return undefined;
  return hit;
}

/** The current season's number: one past the latest archived (the archive is append-only, seasons count up). */
export const nextSeasonNumber = (archive: readonly ArchivedHouseguest[]): number => archive.reduce((m, h) => Math.max(m, h.season), 0) + 1;

/** A static CHARACTER without its hidden layer (a deep copy, so the archive never aliases live state). */
export function archivePersona(c: Character): ArchivedPersona {
  const { hiddenElements: _dropped, ...rest } = c;
  void _dropped;
  return JSON.parse(JSON.stringify(rest)) as ArchivedPersona;
}

/** One finished-season NPC as the archive reads it (all from the live season at the crown). */
export interface SeasonNpcRecord {
  id: EntityId;
  name: string;
  character: Character;
  placement: number;
  juror: boolean;
  /** The NPC->player edge at the crown. */
  edge: { trust: number; affinity: number; threat: number };
  /** The NPC's beliefs about the player (subject = the player) at the crown. */
  beliefsAboutPlayer: readonly BeliefClaim[];
}

/** Claim kinds that read the same in a new cast (no `object`: an object id would name someone from the old cast). */
const CARRYABLE_ORIGINS: ReadonlySet<string> = new Set(["witnessed", "told"]);

/** The archive entries for one finished season. `endToward` is the deviation from the move-in baseline (signed), so softening pulls back toward a stranger's read. */
export function buildSeasonArchive(season: number, npcs: readonly SeasonNpcRecord[]): ArchivedHouseguest[] {
  const base = RELATIONSHIP_CONSTANTS.baseline;
  return npcs.map((n) => {
    const claims: CarriedClaim[] = n.beliefsAboutPlayer
      .filter((b) => b.value && b.refuted !== true && b.object === undefined && CARRYABLE_ORIGINS.has(b.origin))
      .map((b) => ({ kind: b.kind, ...(b.nature !== undefined ? { nature: b.nature } : {}), week: b.week, witnessed: b.origin === "witnessed" }));
    return {
      season, npcId: n.id, characterRef: `${season}:${n.id}`, name: n.name, persona: archivePersona(n.character),
      placement: n.placement, juror: n.juror,
      endToward: { trust: n.edge.trust - base.trust, affinity: n.edge.affinity - base.affinity, threat: Math.max(0, n.edge.threat - base.threat) },
      claims: carriedClaims(claims),
    };
  });
}

/** Seasons between the archived one and the one being cast (the last season is 1). */
export const seasonsSince = (h: ArchivedHouseguest, currentSeason: number): number => Math.max(1, currentSeason - h.season);

/** How much of its edge-feel a claim keeps: the same decay the feelings take (never zero). */
const CLAIM_CONFIDENCE = { floor: 0.2, span: 0.4 } as const;

/** The returner's own beliefs about the player, as they carried them (their account; softened confidence). */
export function returnerBeliefs(holder: EntityId, player: EntityId, h: ArchivedHouseguest, currentSeason: number): Array<Omit<BeliefClaim, "id">> {
  const soft = softenedFeelings({ trust: 1, affinity: 1, threat: 1 }, seasonsSince(h, currentSeason)).trust; // the decay share still held
  return h.claims.map((c) => ({
    holder, kind: c.kind as ClaimKind, subject: player, value: true,
    origin: c.witnessed ? "witnessed" as const : "told" as const,
    ...(c.nature !== undefined ? { nature: c.nature } : {}),
    confidence: clamp01(CLAIM_CONFIDENCE.floor + CLAIM_CONFIDENCE.span * soft), week: 0,
  }));
}

/** The decision, wholly keyed (no shared stream): does this cast carry a returner, who, and in which seat. Undefined = no return (fresh cast, byte-identical). */
export function planReturner(
  seed: number, start: SeasonStart, archive: readonly ArchivedHouseguest[], castNames: readonly string[], playerName: string, seats: readonly EntityId[],
): { entry: ArchivedHouseguest; seat: EntityId } | undefined {
  if (seats.length === 0) return undefined;
  const taken = new Set([...castNames, playerName].map((n) => n.trim().toLowerCase()));
  // Only complete, real entries are ever a candidate (the validator), and never a name already in this house.
  const candidates = archive.filter((h) => resolveReturnee({ season: h.season, npcId: h.npcId }, archive) !== undefined && !taken.has((h.name ?? "").trim().toLowerCase()));
  // ORW-960 (B2-7): a person who has played more than one season has one archive entry per season; only their LATEST can be cast (the older one carries a season-old persona and feelings). Archive order is kept, so an
  // archive with no repeat person yields the same pool as before.
  const latest = new Map<string, ArchivedHouseguest>();
  for (const h of candidates) { const k = (h.name ?? "").trim().toLowerCase(); const cur = latest.get(k); if (!cur || h.season > cur.season) latest.set(k, h); }
  const pool = candidates.filter((h) => latest.get((h.name ?? "").trim().toLowerCase()) === h);
  if (!castsReturner(start, pool.length, agendaRoll(seed, "returner" as EntityId, "cast"))) return undefined;
  const entry = pickReturner(pool, new Set(), agendaRoll(seed, "returner" as EntityId, "pick"));
  if (!entry) return undefined;
  const seat = seats[Math.min(seats.length - 1, Math.floor(agendaRoll(seed, "returner" as EntityId, "seat") * seats.length))]!;
  return { entry, seat };
}

/** The new seat's character: the archived PUBLIC persona over the slot's own fresh hidden layer (concealed aptitudes the carried stats/archetype cannot back are dropped). */
export function returnerCharacter(entry: ArchivedHouseguest, fresh: Character): Character {
  const persona = JSON.parse(JSON.stringify(entry.persona)) as ArchivedPersona;
  const bias = ARCHETYPES.find((a) => a.archetype === persona.archetype)?.bias;
  const G = HIDDEN_ELEMENT_GATES;
  const hidden: HiddenElement[] = fresh.hiddenElements.filter((e) => {
    if (e.kind !== "concealed-aptitude") return true;
    const stat = CONCEALED_APTITUDES.find((a) => a.detail === e.detail)?.stat;
    return stat !== undefined && persona.stats[stat] >= G.statFloor && (bias?.[stat] ?? 1) <= G.publicBiasCeiling;
  });
  return { ...persona, hiddenElements: hidden };
}

/** The carried feeling as a signed nudge on the NPC->player edge: the softened end deviation (monotone in seasons, never above the original). */
export function carriedNudge(h: ArchivedHouseguest, currentSeason: number): EndFeelings {
  return softenedFeelings(h.endToward, seasonsSince(h, currentSeason));
}
