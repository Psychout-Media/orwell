import type { EntityId } from "../domain/ids";
import { SeededRandom } from "../adapters/random/SeededRandom";
import {
  hashSeed, ARCHETYPES, isPlausibleArchetype,
  HIDDEN_ELEMENT_GATES, CONCEALED_APTITUDES,
} from "./characterFactory";
import type { Archetype, HiddenElement, HiddenElementKind } from "./characterFactory";
import { normalizeTieNature } from "./seededRelationships";
import type { PreGameTie, TieNature } from "./seededRelationships";
import {
  GENESIS_TOTAL_BAND, GENESIS_STAT_CLAMP, GENESIS_VARIANCE_FLOOR,
  GENESIS_HIDDEN_ELEMENT_RANGE, GENESIS_TIE_BUDGET,
  BRIEF_DEMOGRAPHIC_SKEWS, BRIEF_REGIONAL_FLAVORS,
  GENESIS_ENSEMBLE_ACCENTS, GENESIS_ENERGY_AXIS, GENESIS_REGISTER_AXIS,
  GENESIS_EXPRESSIVENESS_AXIS, GENESIS_ACCENT_FRACTION,
  GENESIS_EMOTIONAL_REGISTER_AXIS, GENESIS_SELF_AWARENESS_AXIS, GENESIS_SOCIAL_GRAVITY_AXIS,
  GENESIS_ENERGY_LOUD, GENESIS_EXPRESSIVENESS_LOUD, GENESIS_EMOTIONAL_REGISTER_LOUD,
  GENESIS_SOCIAL_GRAVITY_LOUD, GENESIS_AMPLIFIED_MIN, GENESIS_AMPLIFIED_SPAN,
  GENESIS_AGE_BANDS, GENESIS_CASTING_ROLES, GENESIS_ROLE_MAX_PER_CAST, GENESIS_CEREBRAL_MAX_PER_CAST,
  GENESIS_INK_MIN, GENESIS_INK_SPAN, GENESIS_LOOK_FEATURES,
} from "./genesisConstants";
import type { GenesisCastingRole } from "./genesisConstants";
import { clamp } from "../domain/num";

/**
 * Feature 0116 — model-authored cast genesis: the ENGINE VALIDATION ENVELOPE (pure, no I/O).
 *
 * The narration model proposes the ENTIRE 15-NPC skeleton (names, freeform identities, personas,
 * hidden elements, the pre-show tie graph, per-NPC stats); this module VALIDATES that proposal against
 * the envelope the engine OWNS (the §3 contract table), clamps/repairs what it can, re-rolls what it
 * cannot, and produces a COMMITTED skeleton the adapter folds onto the (already-warmed, deterministic)
 * cast. It generalizes ADR 0005 to world-generation: **identity is open-set** (the model authors it, the
 * engine records it faithfully and never normalizes it) and **power is closed-set** (the engine dictates
 * stat magnitudes, banded + clamped, and every hidden game weight stays engine-seeded).
 *
 * PURE + player-blind by construction: the envelope reads the proposal + a small validation CONTEXT
 * (the warmed floor cast's ids/archetypes/stats/names for fallback, plus the player's name/vocation/
 * hometown ONLY for the post-hoc near-duplicate NUDGE — never woven into the accepted identity). No
 * model number escapes the clamp (mandate #3); no hidden game weight is ever proposable (§3 last row).
 *
 * The deterministic FLOOR is unchanged: with no model wired there is no proposal, this module is never
 * consulted, and the cast is byte-identical to today's `CharacterFactory` (the §7/§8 byte-neutrality
 * gate). Nothing here touches the seeded competition/vote/jury stream — it validates identity + banded
 * stat magnitudes, both descriptive of who the cast IS, not how the seeded loop resolves.
 */

// ── The seeded SEASON BRIEF (§2 DECIDED #5) ─────────────────────────────────────────────────────────
export interface SeasonBrief {
  demographicSkew: string;
  regionalFlavor: string;
}

/**
 * Derive the seeded season brief off a DEDICATED side-stream (`:genesis:brief`) — same seed ⇒ same
 * brief (replayable), player-INDEPENDENT (derived only from the seed). It STEERS the model's open-ended
 * generation; it never binds a validator (only the engine's caps/floors/bands bind, §3). The dimension
 * space is finite, so distinct seeds can occasionally deal a similar brief — the brief steers variety,
 * it is not a uniqueness guarantee (§2).
 *
 * The old house-wide `ensembleVibe` was REMOVED (it homogenized the whole cast); the ensemble mood now
 * rides per-slot as an ACCENT on a seeded 20–30% minority (`assignGenesisSlots`). Removing that third
 * `pick` does not perturb the first two — `demographicSkew`/`regionalFlavor` still come off the same two
 * leading draws — so the brief stays deterministic and player-independent (arity 1, seed only).
 */
export function generateSeasonBrief(seed: number): SeasonBrief {
  const rng = new SeededRandom(hashSeed(`${seed}:genesis:brief`));
  return {
    demographicSkew: rng.pick(BRIEF_DEMOGRAPHIC_SKEWS),
    regionalFlavor: rng.pick(BRIEF_REGIONAL_FLAVORS),
  };
}

/** Render the brief as one short casting-direction line (for the FE sketch prompt — the follow-on driver). */
export function renderSeasonBrief(b: SeasonBrief): string {
  return `This season: ${b.demographicSkew}; ${b.regionalFlavor}.`;
}

// ── The seeded PER-SLOT casting directives (the whole-cast constraints, computed up front) ───────────
/**
 * One houseguest slot's SEEDED casting card — the whole-cast constraints computed up front and injected
 * into each PER-NPC sketch prompt (genesis now authors ONE houseguest per LLM call, so a call cannot see
 * its siblings; every cross-cast constraint is dealt here, seeded + deterministic, and the model is told
 * to honor the card). PURE creative steering (open set) — never a validator. Mirrored byte-for-byte by
 * the FE (`orwell_cast_genesis.assign_genesis_slots`).
 */
export interface GenesisSlotDirective {
  /** The rich CASTING ROLE (prompt flavor — the classic BB "type"). */
  role: string;
  /** The role's one-line casting note (what makes this type tick). */
  roleNote: string;
  /** The mechanical ARCHETYPE tag the role maps to (∈ the 12-member enum) — the engine's committed tag. */
  archetype: Archetype;
  /** A physical competitor — steer toward a high physical stat + an athletic/first-responder/performer job. */
  physical: boolean;
  /** The seeded AGE band `[lo, hi]` (a real-world cast age curve) — the model picks the exact age + name era. */
  ageLo: number;
  ageHi: number;
  /** An ensemble-mood ACCENT (only a seeded 20–30% of slots carry one; the rest are `null`, their own people). */
  accent: string | null;
  /** A seeded "big personality" — draws ONLY from the LOUD ends so the cast is never uniformly reserved. */
  amplified: boolean;
  /** Independent per-slot delivery dials so per-person variety is seeded, not left to sampling temperature. */
  energy: string;
  register: string;
  expressiveness: string;
  emotionalRegister: string;
  selfAwareness: string;
  socialGravity: string;
  /**
   * 2026-07-21 prompt audit (the cast-uniformity index case): the seeded LOOK LANE. A seeded 2-4 slots
   * per cast are the visibly-tattooed contingent (`ink: true`); every other slot is explicitly
   * no-visible-ink and carries a suggested distinguishing `lookFeature` (empty string on an ink slot).
   * Steering only — the model elaborates; it never invents the ink budget itself.
   */
  ink: boolean;
  lookFeature: string;
}

/** Fisher–Yates in-place shuffle driven by a seeded RNG (identical stream ⇒ identical permutation; the FE mirrors it). */
function seededShuffle<T>(arr: T[], rng: SeededRandom): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
}

const ROLE_BY_LABEL = new Map<string, GenesisCastingRole>(GENESIS_CASTING_ROLES.map((r) => [r.role, r]));
const roleOf = (label: string): GenesisCastingRole => ROLE_BY_LABEL.get(label)!;
// The believable BB casting recipe, in essential→optional order (role labels). Walked with the per-role +
// combined-cerebral caps to fill the cast; a seeded flex on the underdog slot adds inter-season variety.
const GENESIS_CASTING_RECIPE: readonly string[] = [
  "comp-beast (humble)", "mastermind", "floater", "villain", "showmance instigator", "flirt",
  "hothead", "america's sweetheart", "mom/dad figure", "underdog", "comp-threat self-mastermind",
  "under-the-radar assassin", "wildcard", "loyalist", "floater", "analyst",
];
const GENESIS_UNDERDOG_FLEX: readonly string[] = ["underdog", "analyst", "superfan gamebot"];

/** Build the seeded casting PLAN — a believable role multiset honoring the per-role + cerebral caps. */
function buildCastingPlan(rng: SeededRandom, count: number): GenesisCastingRole[] {
  const plan: GenesisCastingRole[] = [];
  const roleCounts = new Map<string, number>();
  let cerebral = 0;
  const tryAdd = (label: string): boolean => {
    const r = roleOf(label);
    if ((roleCounts.get(label) ?? 0) >= GENESIS_ROLE_MAX_PER_CAST) return false;
    if (r.cerebral && cerebral >= GENESIS_CEREBRAL_MAX_PER_CAST) return false;
    plan.push(r);
    roleCounts.set(label, (roleCounts.get(label) ?? 0) + 1);
    if (r.cerebral) cerebral++;
    return true;
  };
  for (const label of GENESIS_CASTING_RECIPE) {
    if (plan.length >= count) break;
    tryAdd(label);
  }
  // Pad (large cast) by cycling the recipe again under the caps; then trim to count.
  let guard = 0;
  while (plan.length < count && guard++ < count * GENESIS_CASTING_RECIPE.length) {
    let added = false;
    for (const label of GENESIS_CASTING_RECIPE) {
      if (plan.length >= count) break;
      if (tryAdd(label)) added = true;
    }
    if (!added) break;
  }
  // Seeded flex: swap the (first) underdog for a seeded alternate — inter-season variety in the cerebral slot.
  const flex = GENESIS_UNDERDOG_FLEX[rng.int(GENESIS_UNDERDOG_FLEX.length)]!;
  if (flex !== "underdog") {
    const idx = plan.findIndex((r) => r.role === "underdog");
    const alt = roleOf(flex);
    if (idx >= 0 && !(alt.cerebral && cerebral >= GENESIS_CEREBRAL_MAX_PER_CAST)) plan[idx] = alt;
  }
  seededShuffle(plan, rng);
  return plan;
}

/** Build the seeded AGE plan — the real-world cast age curve, one `[lo,hi]` band per slot, shuffled. */
function buildAgePlan(rng: SeededRandom, count: number): Array<{ lo: number; hi: number }> {
  const bands: Array<{ lo: number; hi: number }> = [];
  const baseTotal = GENESIS_AGE_BANDS.reduce((a, b) => a + b.count, 0);
  for (const band of GENESIS_AGE_BANDS) {
    // Scale the band's count to the actual cast size (round), so the curve holds for any N.
    const n = Math.max(0, Math.round((band.count / baseTotal) * count));
    for (let i = 0; i < n; i++) bands.push({ lo: band.lo, hi: band.hi });
  }
  // Pad/trim to exactly count (rounding can drift by one), padding from the youngest band.
  while (bands.length < count) bands.push({ lo: GENESIS_AGE_BANDS[0]!.lo, hi: GENESIS_AGE_BANDS[0]!.hi });
  bands.length = count;
  seededShuffle(bands, rng);
  return bands;
}

/**
 * Deal the seeded per-slot casting cards for a roster of `count` houseguests (roster order). Each cross-cast
 * constraint runs on its OWN dedicated side-stream (the #338 RNG-isolation lesson) so adding/removing one
 * never perturbs the others:
 *   - ROLE (`:genesis:roles`): a believable BB casting plan (rich roles → mechanical archetype tags), capped
 *     per-role at 2 and cerebral-combined at 3, shuffled onto the slots.
 *   - AGE (`:genesis:ages`): a real-world age curve (`GENESIS_AGE_BANDS`), one band per slot, shuffled.
 *   - ACCENT (`:genesis:accent`): a seeded 20–30% of slots carry a distinct ensemble accent (the rest none).
 *   - AXES (`:genesis:axes`): six delivery dials drawn per slot; a seeded 4–5 "amplified" slots draw ONLY
 *     from the LOUD ends so a loud/reactive/main-character contingent is GUARANTEED.
 * GENDER is deliberately NOT seeded — the identity model proposes correct, diverse, name-coherent genders,
 * and `diversity.ts` remains the coherence authority (§ gender course-correction). PURE + player-blind
 * (seed + count only). Mirrored byte-for-byte by the FE.
 */
export function assignGenesisSlots(seed: number, count: number): GenesisSlotDirective[] {
  if (count <= 0) return [];

  // 1. ROLE — the believable casting plan (rich roles mapped to mechanical archetype tags).
  const rolePlan = buildCastingPlan(new SeededRandom(hashSeed(`${seed}:genesis:roles`)), count);
  // 2. AGE — the real-world age curve.
  const agePlan = buildAgePlan(new SeededRandom(hashSeed(`${seed}:genesis:ages`)), count);

  // 3. ACCENT — a seeded 20–30% carry a distinct ensemble accent; the rest are their own people.
  const cRng = new SeededRandom(hashSeed(`${seed}:genesis:accent`));
  const fraction = GENESIS_ACCENT_FRACTION.min + cRng.next() * (GENESIS_ACCENT_FRACTION.max - GENESIS_ACCENT_FRACTION.min);
  const accentCount = Math.max(0, Math.min(count, Math.floor(count * fraction + 0.5)));
  const carry: boolean[] = [...Array(accentCount).fill(true), ...Array(count - accentCount).fill(false)];
  seededShuffle(carry, cRng);
  const accentPool = [...GENESIS_ENSEMBLE_ACCENTS];
  seededShuffle(accentPool, cRng);
  let accentCursor = 0;

  // 3.5. LOOK LANE (2026-07-21 prompt audit) — a seeded 2-4 slots carry the cast's visible ink; every
  // other slot is explicitly no-visible-ink with a suggested distinguishing feature from a shuffled
  // wide pool. Its OWN dedicated side-stream (`:genesis:looks`) so it never perturbs the other deals.
  const lRng = new SeededRandom(hashSeed(`${seed}:genesis:looks`));
  const inkCount = Math.max(0, Math.min(count, GENESIS_INK_MIN + lRng.int(GENESIS_INK_SPAN + 1)));
  const inked: boolean[] = [...Array(inkCount).fill(true), ...Array(count - inkCount).fill(false)];
  seededShuffle(inked, lRng);
  const featurePool = [...GENESIS_LOOK_FEATURES];
  seededShuffle(featurePool, lRng);
  let featureCursor = 0;

  // 4. AXES — six delivery dials; a seeded 4–5 "amplified" slots draw ONLY from the loud ends.
  const xRng = new SeededRandom(hashSeed(`${seed}:genesis:axes`));
  const amplifiedCount = Math.max(0, Math.min(count, GENESIS_AMPLIFIED_MIN + xRng.int(GENESIS_AMPLIFIED_SPAN + 1)));
  const amplified: boolean[] = [...Array(amplifiedCount).fill(true), ...Array(count - amplifiedCount).fill(false)];
  seededShuffle(amplified, xRng);
  const pick = (full: readonly string[], loud: readonly string[], amp: boolean): string =>
    amp ? loud[xRng.int(loud.length)]! : full[xRng.int(full.length)]!;

  const out: GenesisSlotDirective[] = [];
  for (let i = 0; i < count; i++) {
    const role = rolePlan[i]!;
    const amp = amplified[i]!;
    out.push({
      role: role.role,
      roleNote: role.note,
      archetype: role.archetype,
      physical: role.physical,
      ageLo: agePlan[i]!.lo,
      ageHi: agePlan[i]!.hi,
      accent: carry[i] ? accentPool[accentCursor++ % accentPool.length]! : null,
      amplified: amp,
      energy: pick(GENESIS_ENERGY_AXIS, GENESIS_ENERGY_LOUD, amp),
      register: GENESIS_REGISTER_AXIS[xRng.int(GENESIS_REGISTER_AXIS.length)]!,
      expressiveness: pick(GENESIS_EXPRESSIVENESS_AXIS, GENESIS_EXPRESSIVENESS_LOUD, amp),
      emotionalRegister: pick(GENESIS_EMOTIONAL_REGISTER_AXIS, GENESIS_EMOTIONAL_REGISTER_LOUD, amp),
      selfAwareness: GENESIS_SELF_AWARENESS_AXIS[xRng.int(GENESIS_SELF_AWARENESS_AXIS.length)]!,
      socialGravity: pick(GENESIS_SOCIAL_GRAVITY_AXIS, GENESIS_SOCIAL_GRAVITY_LOUD, amp),
      ink: inked[i]!,
      lookFeature: inked[i] ? "" : featurePool[featureCursor++ % featurePool.length]!,
    });
  }
  return out;
}

/** Render one slot's casting card as a compact fixed-input line for the sketch prompt (mirrored by the FE). */
export function renderSlotDirective(id: EntityId, d: GenesisSlotDirective): string {
  const accent = d.accent ? `house-accent: ${d.accent}` : "no house-accent (their own person)";
  const phys = d.physical ? " PHYSICAL COMPETITOR (give a high physical stat + an athletic/first-responder/performer vocation)." : "";
  const big = d.amplified ? " BIG PERSONALITY — write them genuinely loud/reactive/unfiltered; do NOT let the accent tone them down." : "";
  const look = d.ink
    ? "look: visible tattoos ARE part of their look (one of the cast's few inked houseguests — make the ink specific and personal)"
    : `look: NO visible tattoos; distinguishing feature, if any: ${d.lookFeature}`;
  return `${id} — cast as: ${d.role} (${d.roleNote}); archetype tag: ${d.archetype}; `
    + `age ~${d.ageLo}-${d.ageHi} (name from that birth era); ${accent}; `
    + `energy: ${d.energy}; register: ${d.register}; expressiveness: ${d.expressiveness}; `
    + `reactivity: ${d.emotionalRegister}; self-awareness: ${d.selfAwareness}; social-gravity: ${d.socialGravity}; `
    + `${look}.`
    + phys + big;
}

// ── The legacy-Bible deny-list (§5 ruling-#1 amendment) ─────────────────────────────────────────────
/**
 * The 3 DISTINCTIVE legacy-Bible sample given names, banned on BOTH paths (§5): excluded from the
 * corpora (the floor) AND enforced by the genesis name validator (this module). A genesis proposal whose
 * ANY name token matches one of these (case-insensitive) is refused for that NPC — the deny-list gate
 * holds on the genesis path exactly as it holds on the floor. (Kept as a small explicit list, grep-able,
 * matching the `data/givenNames.ts` header note; a test asserts none appear in the corpus either.)
 */
export const LEGACY_BIBLE_NAMES: readonly string[] = ["Ryne", "Marcus", "Felix"];

// ── The proposal shape (LOOSE / untrusted — the model's raw output) ────────────────────────────────
/** One proposed stat line (raw model numbers — the engine owns the band; nothing here is trusted). */
export interface GenesisStatProposal {
  physical?: number;
  mental?: number;
  social?: number;
}

/** One proposed hidden element (kind ∈ the closed set is VALIDATED; detail is open-set prose). */
export interface GenesisHiddenElementProposal {
  kind?: string;
  detail?: string;
}

/** One proposed pre-show tie — references two NPC ids (never the player); nature/backstory are flavor. */
export interface GenesisTieProposal {
  a?: EntityId;
  b?: EntityId;
  nature?: string;
  backstory?: string;
}

/**
 * One proposed NPC skeleton. Every field is OPTIONAL: an omitted (or validation-failing) field falls
 * back to the deterministic floor for that NPC, so the committed cast is always complete (the
 * recordCastProfile per-field-fallback discipline). The `id` binds the proposal to the warmed cast slot.
 *
 * The HIDDEN-GAME-WEIGHT fields (`influence`/`volatility`/`dayOnePerception`/`persuasiveness`/
 * `susceptibility`) are typed here ONLY so the envelope can DETECT + FLAG + IGNORE them — they are
 * structurally unproposable (§3 last row / mandate #3). They never commit.
 */
export interface GenesisNpcProposal {
  id?: EntityId;
  name?: string;
  /** The freeform identity concept, in the model's own words — stored VERBATIM (open set). */
  identity?: string;
  /** The nearest canonical archetype tag — validated ∈ enum; invalid/absent ⇒ the floor tag stands. */
  archetype?: string;
  vocation?: string;
  hometown?: string;
  demeanor?: string;
  background?: string;
  biography?: string;
  presentation?: string;
  appearance?: string;
  age?: number;
  stats?: GenesisStatProposal;
  hiddenElements?: GenesisHiddenElementProposal[];
  // 0063 descriptive identity facets — typed here ONLY so a proposal carrying them still parses; they are
  // NOT validated, forwarded, or committed by this envelope (and the adapter drops them too — the port DTO
  // deliberately omits them). Heritage/gender/orientation route EXCLUSIVELY through the separate
  // `recordCastIdentity` (#544) pipeline, which the FE runs AFTER genesis so the identity model coheres
  // each facet with the genesis-committed NAMES, and whose `repairDiversityLayer` floors/caps stay the one
  // authority. (Bundle audit 2026-07-13: this comment previously claimed the adapter forwards these as a
  // ProposedIdentityFacets map — it never did; corrected so nobody wires a duplicate facet path here.)
  ethnicity?: string;
  genderPresentation?: string;
  orientation?: string;
  out?: boolean;
  // Structurally UNPROPOSABLE hidden game weights — detected + flagged + ignored, never committed.
  influence?: unknown;
  volatility?: unknown;
  dayOnePerception?: unknown;
  persuasiveness?: unknown;
  susceptibility?: unknown;
  trigger?: unknown;
}

/** The whole-cast proposal (expected 15 NPCs + 0–2 ties). */
export interface CastGenesisProposal {
  npcs: GenesisNpcProposal[];
  ties?: GenesisTieProposal[];
}

// ── The validation CONTEXT (the warmed floor cast + player facets for the nudge) ────────────────────
export interface GenesisNpcContext {
  id: EntityId;
  floorArchetype: Archetype;
  floorStats: { physical: number; mental: number; social: number };
  floorName: string;
}
export interface GenesisContext {
  /** The warmed floor cast, in order — the per-NPC fallback source (archetype/stats/name). */
  npcs: readonly GenesisNpcContext[];
  /** The player id (never a valid tie endpoint) — omit pre-name (defaults to none). */
  playerId?: EntityId;
  /** The player's name — the post-hoc name near-duplicate NUDGE (ignored when < 3 chars). */
  playerName?: string;
  /** The player's vocation + hometown — the post-hoc vocation+hometown near-duplicate NUDGE. */
  playerVocation?: string;
  playerHometown?: string;
  /** NAME-1 (#547): prior seasons' names the new cast must avoid (given-token exclusion). */
  priorSeasonNames?: readonly string[];
}

// ── Structured VIOLATIONS (what the FE driver echoes into a bounded re-roll) ─────────────────────────
/** The engine's action on a proposal field that failed a validator (§3 "On violation"). */
export type GenesisAction = "clamped" | "repaired" | "stripped" | "re-roll" | "ignored" | "dropped";
export interface GenesisViolation {
  /** Per-NPC (re-roll that ONE NPC) vs cast-wide (re-roll the cast slice) — §4. */
  scope: "npc" | "cast";
  /** The affected NPC (present for scope "npc"). */
  npcId?: EntityId;
  /** The proposal field/area that failed. */
  field: string;
  /** The rule it broke (a short, Vault-free label — never echoes a hidden value). */
  rule: string;
  action: GenesisAction;
}

// ── The COMMITTED per-NPC skeleton (validated / clamped / repaired — the adapter folds this) ─────────
export interface CommittedGenesisNpc {
  id: EntityId;
  /** Accepted display name — present iff a valid, non-colliding, deny-list-clear name passed. Else the floor name stands. */
  name?: string;
  /** The freeform identity concept, stored VERBATIM (C8-capped) — present iff proposed non-empty. */
  identityConcept?: string;
  /** The derived archetype tag — present iff a valid enum tag was proposed (else the adapter keeps the floor tag). */
  archetype?: Archetype;
  /** The clamped banded stat line — present iff proposed AND the cast cleared the variance floor. */
  stats?: { physical: number; mental: number; social: number };
  /** The validated hidden elements — present iff proposed (count-clamped, kind-checked, C9-gated). Else the floor stands. */
  hiddenElements?: HiddenElement[];
  // Public persona prose (C8-neutralized/-capped, recorded faithfully — never normalized). Present iff proposed non-empty.
  vocation?: string;
  hometown?: string;
  demeanor?: string;
  background?: string;
  biography?: string;
  presentation?: string;
  appearance?: string;
  age?: number;
}

/** The whole envelope result — the committed skeleton, the validated tie graph, and the violation set. */
export interface CastGenesisResult {
  npcs: CommittedGenesisNpc[];
  /** The validated pre-show ties — ≤ budget, distinct pairs, no NPC doubled, never the player, exposure "sealed". */
  ties: PreGameTie[];
  violations: GenesisViolation[];
  /**
   * The cast cleared the stat variance floor. When FALSE, the proposed stats are NOT committed (every
   * NPC's `stats` is absent ⇒ the floor stands, which is guaranteed varied) and a cast-scope violation
   * is raised so the FE re-rolls the cast slice — the committed cast is never a flat super-/dud-cast.
   */
  varianceOk: boolean;
}

// ── C8 prose neutralization (structure is the attack surface; the castingIntake precedent) ──────────
const PROSE_MAX = 500;
const SHORT_PROSE_MAX = 160;
/** Flatten control chars / collapse whitespace / length-cap a prompt-echoed value (C8). Empty ⇒ undefined. */
function neutralizeProse(v: string | undefined, max = SHORT_PROSE_MAX): string | undefined {
  if (typeof v !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const flat = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  if (flat.length === 0) return undefined;
  return flat.length <= max ? flat : flat.slice(0, max);
}

/**
 * ORW-286 item 7: the PUBLIC prose a genesis model writes (the freeform `identity`, which the portrait prompt echoes as "Character: ..." and the player reads) is proposed in the same breath as
 * that houseguest's HIDDEN elements (Vault-bound). The model never receives hidden content, but it writes both, and nothing stopped it echoing a hidden element's text into the public identity:
 * "the model cannot leak what it never receives" does not cover what it invents in the same proposal. This is the structural check: does the public prose repeat a distinctive run of words from any
 * of the same NPC's hidden-element details? A window of `window` consecutive words (default 4; a detail shorter than 3 words is too generic to match on and is skipped) found in the prose counts.
 * Deliberately conservative: a paraphrase is not caught (no word list can be), but a verbatim echo is, and the cost of a false positive is only that one NPC's identity falls back to the floor.
 * Pure; no I/O; never logs or returns the hidden text.
 */
export function publicProseRepeatsHidden(prose: string, hiddenDetails: readonly string[], window = 4): boolean {
  const words = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter((w) => w.length > 0);
  const haystack = ` ${words(prose).join(" ")} `;
  for (const detail of hiddenDetails) {
    const dw = words(detail);
    if (dw.length < 3) continue;
    const w = Math.min(window, dw.length);
    for (let i = 0; i + w <= dw.length; i++) {
      if (haystack.includes(` ${dw.slice(i, i + w).join(" ")} `)) return true;
    }
  }
  return false;
}

// ── Name validation (§3 "Names": validated, not pooled) ─────────────────────────────────────────────
const NAME_TOKEN_RE = /^[A-Z][a-z]*([-'][A-Z]?[a-z]+)?$/;
const NAME_VOWEL_RE = /[aeiouy]/i;
const NAME_CONSONANT_RUN_RE = /[bcdfghjklmnpqrstvwxz]{4,}/i;
/** Max total display-name length (C8 cap) + token bounds — a name is prompt-echoed everywhere. */
export const GENESIS_NAME_MAX_LEN = 48;
const NAME_TOKEN_MIN = 2;
const NAME_TOKEN_MAX = 14;

/**
 * Is `s` a plausibly-shaped human display name for the genesis path (a sibling of the adapter's
 * `isReasonableName`, kept engine-side so `src/engine` never imports an adapter): 2–4 whitespace tokens,
 * each a capitalized name part (optional hyphen/apostrophe compound), 2–14 chars, with a vowel and no
 * 4+ consonant run, and NO digits or markup (the token regex admits only letters + one hyphen/apostrophe,
 * so digits/markup fail structurally), under the total length cap. Rejects a single token, gibberish, and
 * anything smuggling structure. Pure.
 */
export function isPlausibleGenesisName(s: string): boolean {
  const name = s.trim();
  if (name.length === 0 || name.length > GENESIS_NAME_MAX_LEN) return false;
  const tokens = name.split(/\s+/);
  if (tokens.length < 2 || tokens.length > 4) return false;
  for (const t of tokens) {
    if (t.length < NAME_TOKEN_MIN || t.length > NAME_TOKEN_MAX) return false;
    if (!NAME_TOKEN_RE.test(t)) return false;
    if (!NAME_VOWEL_RE.test(t)) return false;
    if (NAME_CONSONANT_RUN_RE.test(t)) return false;
  }
  return true;
}

/** A name token collides with the legacy-Bible deny-list (case-insensitive, whole-token). */
export function hitsLegacyDenyList(name: string): boolean {
  const tokens = name.trim().toLowerCase().split(/\s+/);
  const deny = new Set(LEGACY_BIBLE_NAMES.map((n) => n.toLowerCase()));
  return tokens.some((t) => deny.has(t));
}

// ── Stat band clamp + renormalize (§3 "Stats": no model number escapes the clamp) ───────────────────
const STAT = GENESIS_STAT_CLAMP;

/**
 * Clamp a proposed stat line into the engine-owned band (§3/§8). FIRST per-stat clamp into [min,max]
 * (so NO raw model number is ever committed unclamped), THEN scale the total proportionally toward the
 * nearest band edge (preserving the proposal's relative SHAPE), THEN re-fit any stat the scale pushed
 * past a bound by water-filling the residual among the stats with headroom. The band `[lo,hi]` sits
 * strictly inside `[3·min, 3·max]`, so a feasible fit always exists and the loop converges. Pure.
 */
export function clampStatsIntoBand(raw: GenesisStatProposal): { physical: number; mental: number; social: number } {
  const num = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0.5);
  // 1. Per-stat clamp — no raw value escapes [min,max].
  const s: [number, number, number] = [
    clamp(num(raw.physical), STAT.min, STAT.max),
    clamp(num(raw.mental), STAT.min, STAT.max),
    clamp(num(raw.social), STAT.min, STAT.max),
  ];
  const { lo, hi } = GENESIS_TOTAL_BAND;
  // 2. Proportional total-band scale (preserves relative shape) + 3. water-fill the residual.
  for (let iter = 0; iter < 8; iter++) {
    const total = s[0] + s[1] + s[2];
    if (total >= lo - 1e-9 && total <= hi + 1e-9) break;
    const target = total > hi ? hi : lo;
    if (iter === 0 && total > 0) {
      // First pass: proportional scale — ratios preserved exactly in the common (no re-clamp) case.
      const factor = target / total;
      for (let i = 0; i < 3; i++) s[i] = clamp(s[i] * factor, STAT.min, STAT.max);
      continue;
    }
    // Subsequent passes: distribute the remaining delta ONLY among stats with headroom in that direction.
    const delta = target - total;
    const adjustable = [0, 1, 2].filter((i) => (delta < 0 ? s[i] > STAT.min : s[i] < STAT.max));
    if (adjustable.length === 0) break;
    const share = delta / adjustable.length;
    for (const i of adjustable) s[i] = clamp(s[i] + share, STAT.min, STAT.max);
  }
  return { physical: s[0], mental: s[1], social: s[2] };
}

/** Population standard deviation of a number list (0 for < 2 entries). */
function popStdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const varc = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
  return Math.sqrt(varc);
}

/**
 * Does the committed-candidate cast clear the cast-wide VARIANCE FLOOR (§3/§8)? A real dispersion of
 * TOTALS AND of EACH stat across the cast — no super-cast, no dud-cast, no fifteen identical mid-liners.
 * A flat cast has ~0 dispersion and fails. Pure.
 */
export function castVarianceOk(stats: ReadonlyArray<{ physical: number; mental: number; social: number }>): boolean {
  if (stats.length < 2) return true; // a degenerate/tiny cast has nothing to spread
  const totals = stats.map((s) => s.physical + s.mental + s.social);
  if (popStdev(totals) < GENESIS_VARIANCE_FLOOR.totalStdev) return false;
  for (const key of ["physical", "mental", "social"] as const) {
    if (popStdev(stats.map((s) => s[key])) < GENESIS_VARIANCE_FLOOR.perStatStdev) return false;
  }
  return true;
}

// ── Hidden-element validation (§3 "Hidden elements": kinds closed, C9 consistency) ──────────────────
const HIDDEN_KIND_SET: ReadonlySet<string> = new Set<HiddenElementKind>([
  "secret-motive", "pre-game-tie", "concealed-aptitude", "divergent-persona", "trigger",
]);
const CONCEALED_APTITUDE_DETAILS: ReadonlyMap<string, "physical" | "mental" | "social"> =
  new Map(CONCEALED_APTITUDES.map((a) => [a.detail, a.stat]));

/**
 * Validate one NPC's proposed hidden elements (§3 / the C9 gates, applied to the genesis path):
 *   - kind ∈ the closed `HiddenElementKind` set (an unknown kind is STRIPPED — the KINDS are mechanical
 *     couplings; only the DETAILS are open-set prose);
 *   - a `concealed-aptitude` must be genuinely STAT-BACKED (the committed stat clears `statFloor`) AND
 *     publicly CONCEALED (the public archetype bias sits under `publicBiasCeiling`) — else stripped;
 *   - at most one `secret-motive` (a character can't play for redemption AND fame) — the excess stripped;
 *   - the per-NPC COUNT is clamped into `HIDDEN_ELEMENT_RANGE` (3–6): excess trimmed; a shortfall is a
 *     RE-ROLL signal (the engine can't invent coherent secrets — the floor stands and the FE re-rolls).
 * Returns the accepted elements + the violations. Never emits a `trigger` (0091 arms triggers on its own
 * dedicated side-rng from an already-minted volatile wording — never a model proposal).
 */
export function validateHiddenElements(
  proposed: readonly GenesisHiddenElementProposal[] | undefined,
  committedStats: { physical: number; mental: number; social: number },
  publicBias: { physical: number; mental: number; social: number },
  npcId: EntityId,
): { elements: HiddenElement[] | undefined; violations: GenesisViolation[] } {
  const violations: GenesisViolation[] = [];
  if (!Array.isArray(proposed) || proposed.length === 0) {
    // Nothing proposed ⇒ the floor stands (absent ⇒ no fold; not a violation).
    return { elements: undefined, violations };
  }
  const G = HIDDEN_ELEMENT_GATES;
  const out: HiddenElement[] = [];
  const seen = new Set<string>();
  let motives = 0;
  for (const el of proposed) {
    const kind = typeof el?.kind === "string" ? el.kind.trim() : "";
    const detail = neutralizeProse(el?.detail, PROSE_MAX);
    if (!HIDDEN_KIND_SET.has(kind) || kind === "trigger") {
      violations.push({ scope: "npc", npcId, field: "hiddenElements.kind", rule: "kind outside the closed set", action: "stripped" });
      continue;
    }
    if (!detail) {
      violations.push({ scope: "npc", npcId, field: "hiddenElements.detail", rule: "empty detail", action: "stripped" });
      continue;
    }
    if (kind === "concealed-aptitude") {
      const backedStat = CONCEALED_APTITUDE_DETAILS.get(detail);
      // C9: a concealed aptitude must name a KNOWN stat-backed detail, be genuinely stat-backed, and be
      // publicly concealed. A free-text "concealed aptitude" the engine can't verify is stripped.
      const backed = backedStat !== undefined
        && committedStats[backedStat] >= G.statFloor
        && publicBias[backedStat] <= G.publicBiasCeiling;
      if (!backed) {
        violations.push({ scope: "npc", npcId, field: "hiddenElements.concealed-aptitude", rule: "aptitude not stat-backed or not concealed (C9)", action: "stripped" });
        continue;
      }
    }
    if (kind === "secret-motive" && motives >= G.maxSecretMotives) {
      violations.push({ scope: "npc", npcId, field: "hiddenElements.secret-motive", rule: "more than one secret motive (C9)", action: "stripped" });
      continue;
    }
    const key = `${kind}::${detail}`;
    if (seen.has(key)) continue; // dedupe silently
    seen.add(key);
    out.push({ kind: kind as HiddenElementKind, detail });
    if (kind === "secret-motive") motives++;
    if (out.length >= GENESIS_HIDDEN_ELEMENT_RANGE.max) break; // count cap — trim the excess
  }
  if (out.length > GENESIS_HIDDEN_ELEMENT_RANGE.max) out.length = GENESIS_HIDDEN_ELEMENT_RANGE.max;
  if (out.length < GENESIS_HIDDEN_ELEMENT_RANGE.min) {
    // Shortfall: too few coherent elements survived — the engine can't invent them, so DROP the whole
    // authored set (the deterministic floor's 3–6 coherent secrets stand) and signal a re-roll.
    violations.push({ scope: "npc", npcId, field: "hiddenElements", rule: `count below ${GENESIS_HIDDEN_ELEMENT_RANGE.min}`, action: "re-roll" });
    return { elements: undefined, violations };
  }
  return { elements: out, violations };
}

// ── Hidden-game-weight detection (§3 last row: structurally unproposable) ───────────────────────────
const FORBIDDEN_WEIGHT_KEYS: readonly string[] = [
  "influence", "volatility", "dayOnePerception", "persuasiveness", "susceptibility", "trigger",
  "trustLean", "affinityLean", "threatLean", "emotionalBaseline", "emotionalState",
];
/** Which forbidden hidden-weight keys a proposed NPC illegally carried (present ⇒ flagged + ignored). */
function forbiddenWeightKeys(p: GenesisNpcProposal): string[] {
  return FORBIDDEN_WEIGHT_KEYS.filter((k) => (p as Record<string, unknown>)[k] !== undefined);
}

// ── The whole-cast envelope ─────────────────────────────────────────────────────────────────────────
const bias = new Map<Archetype, { physical: number; mental: number; social: number }>(
  ARCHETYPES.map((a) => [a.archetype, a.bias]),
);

/**
 * Validate + clamp + repair the whole-cast genesis proposal against the envelope the engine owns (§3),
 * returning the committed skeleton + the structured violations + the validated tie graph. PURE.
 *
 * Per-NPC, in order: resolve the display name (validators, not a pool), the freeform identity (verbatim),
 * the archetype tag (∈ enum, else the floor tag), the banded stats (clamped — no raw number escapes), the
 * hidden elements (kinds closed, C9-gated, count-clamped), and the persona prose (C8-capped, recorded
 * faithfully). Cast-wide: the stat VARIANCE floor (fail ⇒ drop the stats, re-roll the slice), the tie
 * graph sanity (≤ budget, distinct pairs, no NPC doubled, never the player), and the post-hoc player
 * near-duplicate NUDGE (name / vocation+hometown collision ⇒ re-roll that facet). Hidden game weights are
 * detected, flagged, and ignored — never committed.
 */
export function validateCastGenesis(proposal: CastGenesisProposal, ctx: GenesisContext): CastGenesisResult {
  const violations: GenesisViolation[] = [];
  const byId = new Map<EntityId, GenesisNpcContext>(ctx.npcs.map((n) => [n.id, n]));
  const proposals = Array.isArray(proposal?.npcs) ? proposal.npcs : [];

  // Bind each proposal to a warmed cast slot by id; fall back to positional binding for a proposal that
  // omitted its id (the model authored a slot but didn't echo the engine id).
  const boundById = new Map<EntityId, GenesisNpcProposal>();
  const unbound: GenesisNpcProposal[] = [];
  for (const p of proposals) {
    if (p?.id !== undefined && byId.has(p.id) && !boundById.has(p.id)) boundById.set(p.id, p);
    else unbound.push(p);
  }

  // Cross-cast name-uniqueness sets (given / surname / full — the #853 discipline) + prior-season memory.
  const usedGiven = new Set<string>();
  const usedSurname = new Set<string>();
  const usedFull = new Set<string>();
  // 2026-07-21 prompt audit — cross-cast FACET dedupe backstop (the "San Diego ×2" defect): per-NPC
  // genesis calls can't see their siblings, so the model repeats hometowns (and piles up a vocation).
  // The prompt-side used-facet ledger reduces it; THIS is the authoritative backstop. Keyed on the CITY
  // token (before the comma, lowercased) so "San Diego, CA" and "San Diego, California" collide. A
  // duplicate is DROPPED (the floor's dealt hometown — unique per cast — stands); a vocation already
  // used twice (mirroring the floor's MAX_PER_VOCATION) is likewise dropped.
  const usedHometownCities = new Set<string>();
  const vocationUses = new Map<string, number>();
  const GENESIS_MAX_PER_VOCATION = 2;
  const cityKey = (s: string): string => s.split(",")[0]!.trim().toLowerCase();
  const priorGiven = new Set<string>((ctx.priorSeasonNames ?? []).map((n) => (n ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "").filter(Boolean));
  const playerName = (ctx.playerName ?? "").trim();
  const playerLower = playerName.toLowerCase();

  const committed: CommittedGenesisNpc[] = [];
  const committedStatsForVariance: Array<{ physical: number; mental: number; social: number }> = [];
  const statsById = new Map<EntityId, { physical: number; mental: number; social: number }>();

  let cursor = 0;
  for (const cx of ctx.npcs) {
    const p = boundById.get(cx.id) ?? unbound[cursor++] ?? {};
    const out: CommittedGenesisNpc = { id: cx.id };

    // Hidden game weights — detect, flag, ignore (never commit). §3 last row / mandate #3.
    for (const k of forbiddenWeightKeys(p)) {
      violations.push({ scope: "npc", npcId: cx.id, field: k, rule: "hidden game weight is not proposable", action: "ignored" });
    }

    // NAME — validated, not pooled. Reject: implausible shape / digits / markup / length, the legacy
    // deny-list, a player-name collision, a prior-season repeat, and an in-cast duplicate (given/surname/
    // full). A rejected name falls back to the floor name (which is corpus-clean + unique) — the NPC is
    // never broken. (The post-hoc near-duplicate name nudge is folded into the player-collision check.)
    if (typeof p.name === "string" && p.name.trim().length > 0) {
      const name = p.name.trim();
      const tokens = name.split(/\s+/);
      const given = tokens[0]!.toLowerCase();
      const surname = tokens[tokens.length - 1]!.toLowerCase();
      const full = name.toLowerCase();
      let rejectRule: string | null = null;
      if (!isPlausibleGenesisName(name)) rejectRule = "implausible name shape / length / markup";
      else if (hitsLegacyDenyList(name)) rejectRule = "legacy-Bible deny-list name";
      else if (playerLower.length >= 3 && (full === playerLower || given === playerLower.split(/\s+/)[0]))
        rejectRule = "collides with the player's name";
      else if (priorGiven.has(given)) rejectRule = "repeats a prior season's houseguest";
      else if (usedFull.has(full) || usedGiven.has(given) || usedSurname.has(surname))
        rejectRule = "duplicate name within the cast";
      if (rejectRule) {
        violations.push({ scope: "npc", npcId: cx.id, field: "name", rule: rejectRule, action: "re-roll" });
      } else {
        out.name = name;
        usedGiven.add(given); usedSurname.add(surname); usedFull.add(full);
      }
    }

    // FREEFORM IDENTITY — stored verbatim (C8-capped), the open-set concept the narrator voices.
    const identity = neutralizeProse(p.identity, PROSE_MAX);
    if (identity) out.identityConcept = identity;

    // ARCHETYPE TAG — the derived coupling key. Keep a valid proposed enum member; else the adapter keeps
    // the floor tag (re-derive engine-side). The freeform identity rides beside it, never replaced by it.
    let archetype: Archetype = cx.floorArchetype;
    if (typeof p.archetype === "string" && isPlausibleArchetype(p.archetype.trim())) {
      archetype = p.archetype.trim() as Archetype;
      out.archetype = archetype;
    } else if (p.archetype !== undefined) {
      violations.push({ scope: "npc", npcId: cx.id, field: "archetype", rule: "archetype tag outside the enum", action: "repaired" });
    }

    // STATS — banded variable totals; no raw number escapes the clamp. Proposed ⇒ clamp into the band;
    // absent ⇒ the floor stats stand. (Committed only if the cast-wide variance floor holds — checked below.)
    const statLine = p.stats && typeof p.stats === "object" ? clampStatsIntoBand(p.stats) : cx.floorStats;
    if (p.stats && typeof p.stats === "object") {
      out.stats = statLine; // provisional — cleared below if the cast fails the variance floor
    }
    statsById.set(cx.id, statLine);
    committedStatsForVariance.push(statLine);

    // HIDDEN ELEMENTS — kinds closed, C9-gated, count-clamped (against the COMMITTED stats + archetype bias).
    const hb = bias.get(archetype)!;
    const he = validateHiddenElements(p.hiddenElements, statLine, hb, cx.id);
    if (he.elements) out.hiddenElements = he.elements;
    violations.push(...he.violations);
    // ORW-286 item 7: the public identity must not repeat a hidden element the same proposal carried. Stripped (the floor stands without a freeform identity), never echoed in the violation.
    if (out.identityConcept && out.hiddenElements && publicProseRepeatsHidden(out.identityConcept, out.hiddenElements.map((e) => e.detail))) {
      delete out.identityConcept;
      violations.push({ scope: "npc", npcId: cx.id, field: "identity", rule: "public identity repeats a hidden element", action: "stripped" });
    }

    // PUBLIC PERSONA PROSE — recorded faithfully (C8-capped), never normalized (ADR 0005 open set).
    // The 2026-07-21 cross-cast facet backstop: a DUPLICATE hometown city or an over-represented
    // vocation is dropped (the floor facet — dealt unique/capped — stands); the accepted value is
    // recorded VERBATIM (dedupe never rewrites prose, ADR 0005).
    const vocation = neutralizeProse(p.vocation);
    const hometown = neutralizeProse(p.hometown);
    if (vocation) {
      const vKey = vocation.toLowerCase();
      if ((vocationUses.get(vKey) ?? 0) >= GENESIS_MAX_PER_VOCATION) {
        violations.push({ scope: "npc", npcId: cx.id, field: "vocation", rule: "vocation already used twice within the cast", action: "dropped" });
      } else {
        vocationUses.set(vKey, (vocationUses.get(vKey) ?? 0) + 1);
        out.vocation = vocation;
      }
    }
    if (hometown) {
      const hKey = cityKey(hometown);
      if (usedHometownCities.has(hKey)) {
        violations.push({ scope: "npc", npcId: cx.id, field: "hometown", rule: "duplicate hometown within the cast", action: "dropped" });
      } else {
        usedHometownCities.add(hKey);
        out.hometown = hometown;
      }
    }
    const demeanor = neutralizeProse(p.demeanor);
    if (demeanor) out.demeanor = demeanor;
    const background = neutralizeProse(p.background);
    if (background) out.background = background;
    const biography = neutralizeProse(p.biography, PROSE_MAX);
    if (biography) out.biography = biography;
    const presentation = neutralizeProse(p.presentation);
    if (presentation) out.presentation = presentation;
    const appearance = neutralizeProse(p.appearance, PROSE_MAX);
    if (appearance) out.appearance = appearance;
    if (typeof p.age === "number" && Number.isFinite(p.age)) out.age = Math.max(18, Math.min(75, Math.floor(p.age)));

    // Post-hoc near-duplicate NUDGE (§2): a committed-candidate NPC that mirrors the player's
    // vocation+hometown re-rolls the colliding FACET (drop the vocation), preserving the rest of the
    // identity. (The name collision is already handled in the name gate above.)
    if (
      out.vocation && out.hometown && ctx.playerVocation && ctx.playerHometown
      && out.vocation.toLowerCase() === ctx.playerVocation.trim().toLowerCase()
      && out.hometown.toLowerCase() === ctx.playerHometown.trim().toLowerCase()
    ) {
      violations.push({ scope: "npc", npcId: cx.id, field: "vocation", rule: "mirrors the player's vocation + hometown", action: "re-roll" });
      delete out.vocation; // drop the colliding facet ⇒ the floor vocation stands; identity preserved
    }

    committed.push(out);
  }

  // CAST-WIDE variance floor — fail ⇒ DROP every proposed stat line (the floor's guaranteed-varied stats
  // stand) and raise a cast-scope re-roll. Never commit a flat super-/dud-cast.
  const varianceOk = castVarianceOk(committedStatsForVariance);
  if (!varianceOk) {
    for (const c of committed) delete c.stats;
    violations.push({ scope: "cast", field: "stats.variance", rule: "cast-wide stat variance floor not met", action: "re-roll" });
  }

  // TIE GRAPH — sanity (§3 / 0059 sparseness): valid distinct NPC pairs, never the player, no NPC in two
  // ties, ≤ budget; excess dropped; nature validated; exposure sealed. The affinity fold magnitude stays
  // engine-owned (folded at createCharacter time, never here).
  const ties: PreGameTie[] = [];
  const tiedNpcs = new Set<EntityId>();
  const seenPairs = new Set<string>();
  for (const t of proposal?.ties ?? []) {
    if (ties.length >= GENESIS_TIE_BUDGET) {
      violations.push({ scope: "cast", field: "ties", rule: `more than ${GENESIS_TIE_BUDGET} ties (sparse by design)`, action: "dropped" });
      continue;
    }
    const a = t?.a; const b = t?.b;
    const invalidEndpoint =
      a === undefined || b === undefined || a === b
      || !byId.has(a) || !byId.has(b)
      || a === ctx.playerId || b === ctx.playerId;
    if (invalidEndpoint) {
      violations.push({ scope: "cast", field: "ties", rule: "tie endpoint invalid (self / unknown / the player)", action: "re-roll" });
      continue;
    }
    const pairKey = [a, b].sort().join("|");
    if (seenPairs.has(pairKey)) {
      violations.push({ scope: "cast", field: "ties", rule: "duplicate tie pair", action: "dropped" });
      continue;
    }
    if (tiedNpcs.has(a) || tiedNpcs.has(b)) {
      violations.push({ scope: "cast", field: "ties", rule: "a houseguest carries more than one tie", action: "re-roll" });
      continue;
    }
    seenPairs.add(pairKey);
    tiedNpcs.add(a); tiedNpcs.add(b);
    const nature: TieNature = normalizeTieNature(t?.nature) ?? "old-acquaintance"; // a legacy "showmance" aliases to "prior-romance"
    ties.push({ a, b, nature, exposure: "sealed" });
  }

  return { npcs: committed, ties, violations, varianceOk };
}
