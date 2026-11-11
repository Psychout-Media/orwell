import type { EntityId } from "../domain/ids";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { SeededRandom } from "../adapters/random/SeededRandom";
import { hashSeed } from "./characterFactory";
import type { Houseguest } from "./characterFactory";
import { nameGenderOf, pickGivenNameFor } from "./data/nameGender";
import type { NameGender } from "./data/nameGender";
import {
  MIN_BIPOC, MIN_QUEER, MIN_PER_BINARY_GENDER, MIN_PER_AGE_BAND, MAX_PER_AGE_BAND,
  AGE_BANDS, AGE_ELIGIBILITY_FLOOR, ageBandOf,
  BIPOC_ETHNICITIES, NON_BIPOC_ETHNICITIES, ALL_ETHNICITIES, MAX_PER_ETHNICITY,
  GENDER_PRESENTATIONS, MAX_NONBINARY,
  ORIENTATIONS, QUEER_ORIENTATIONS, PUBLICLY_OUT_PROB,
} from "./diversityConstants";
import type { EthnicityIdentity, GenderPresentation, Orientation } from "./diversityConstants";

/**
 * Feature 0063 — the casting diversity floor: engine-guaranteed FLOORS (BIPOC ≥ MIN_BIPOC, LGBTQ+ ≥
 * MIN_QUEER, gender roughly balanced, ages spread across bands), an ethnicity-grounded identity facet,
 * and a character-driven sexual-orientation model split across the Vault Wall by DISCLOSURE.
 *
 * RNG ISOLATION (the #338 lesson — CRITICAL): EVERY diversity-attribute draw (ethnicity / gender /
 * orientation / disclosure) runs on a DEDICATED, isolated seeded sub-stream forked off the cast seed via
 * `hashSeed`, NEVER the shared house/competition/vote stream. These attributes are DESCRIPTIVE ONLY —
 * they never feed a competition, a vote, or any outcome — so the public competition/vote sequence is
 * byte-for-byte unchanged with or without them. (Verified by the juryReach gate + a golden test.)
 *
 * VALIDATE / REPAIR (the L28 caps' symmetric operation): the layer is DEALT off the sub-stream, then a
 * post-pass CHECKS each floor and REPAIRS the minimum number of picks to satisfy it (swap the next
 * legal-ish draw, never spin — the same guard-budget discipline `spreadFacet` uses). Deterministic per
 * seed and player-INDEPENDENT (the sub-stream keys off the cast's seeded NAMES, never the player).
 *
 * THE VAULT SPLIT: the layer returns PUBLIC facets (ethnicity, gender presentation, an out orientation)
 * that fold onto the byte-stable public Character, AND a HIDDEN `privateOrientations` map (closeted /
 * not-yet-out houseguests) that the caller seals into the Vault — it NEVER appears on any player or
 * admin projection until a 0002 pathway surfaces it.
 */

/** The PUBLIC, Vault-free diversity facets that fold onto a houseguest's byte-stable Character. */
export interface PublicDiversityFacets {
  /** The heritage / cultural-identity label — a lived facet of a full character (§3.2). */
  ethnicity: string;
  /** Whether this houseguest counts toward the BIPOC floor (engine-internal; not a projected stat). */
  bipoc: boolean;
  /** The grounded complexion cue 0058's physicalCharacteristics.skinTone reads (so text+portrait agree). */
  skinTone: string;
  /** How the houseguest presents — descriptive PUBLIC facet, never a competition input (§3.3). */
  genderPresentation: GenderPresentation;
  /**
   * #1140 — the (possibly RE-PICKED) display name. The given-name TOKEN is swapped to one of the final
   * `genderPresentation` (KEEPING the surname) whenever the drawn name disagreed with the final facet, so
   * the NAME, the portrait, and the narration all read the same gender (no "Marlon, a woman" mismatch).
   * PRESENT only when the name actually changed from the drawn one; ABSENT ⇒ the drawn name already cohered
   * (the caller keeps the existing Character name). Descriptive-only — a public string, never a game input.
   */
  name?: string;
  /**
   * The (possibly age-spread-REPAIRED) age — descriptive only (age is NOT a competition/vote input), so
   * the caller writes it back onto the public Character to satisfy the age-band floor. Equal to the
   * drawn age when no repair was needed. The ageLook (0058) then reads this so text+portrait agree.
   */
  age: number;
  /**
   * #1140 — now ALWAYS true by construction: after the gender repairs are final, any draft whose name
   * disagreed with the final presentation has its given name RE-PICKED to match (above). Retained as
   * provenance (`coherenceFlipped` still records that the gender-balance repair flipped a draft), and as a
   * standing invariant the tests assert: `nameGenderOf(name)` agrees with `genderPresentation` for everyone.
   */
  nameCoheres: boolean;
  /** A PUBLICLY-OUT orientation (the house knows it) — a public facet; ABSENT when held privately. */
  outOrientation?: Orientation;
}

/**
 * The AI-driven half of the 0063 diversity floor (the 2026-06-23 ruling, issue #544) — the LLM-PROPOSED
 * descriptive identity facets for ONE houseguest, written BACK to the engine via `recordCastIdentity`.
 * Every field is OPTIONAL and DESCRIPTIVE-ONLY (heritage / gender presentation / orientation / disclosure /
 * age) — NEVER a hidden game weight (those stay engine-seeded; anti-sycophancy + the juryReach calibration
 * depend on the seeded, net-zero-balanced Day-1 read).
 *
 * The engine does NOT trust this blindly: each proposed value is matched against the known pools and folded
 * in as the INITIAL deal (replacing the seeded random pick), then the SAME validate/repair pipeline runs to
 * GUARANTEE the four floors hold regardless of what the model returns (a lazy/biased model can never skew
 * the cast). An unrecognized/absent field falls back to the engine's seeded deal for that houseguest — so
 * with NO proposal the layer is byte-identical to `generateDiversityLayer` (graceful degradation).
 */
export interface ProposedIdentityFacets {
  /** The proposed heritage label — matched (case-insensitively) against `ALL_ETHNICITIES`; unknown ⇒ seeded deal. */
  ethnicity?: string;
  /** The proposed gender presentation — accepted only if it is one of the known presentations. */
  genderPresentation?: GenderPresentation;
  /** The proposed orientation — accepted only if it is one of the known orientations. */
  orientation?: Orientation;
  /** Whether the (queer) orientation is publicly out; absent ⇒ the engine's seeded disclosure roll decides. */
  out?: boolean;
  /** The proposed age — accepted only at/above the eligibility floor (descriptive; never a game input). */
  age?: number;
}

/** The per-houseguest layer: public facets + (when private) the Vault-sealed orientation. */
export interface DiversityLayer {
  /** Public facets per NPC id — fold onto the byte-stable Character. */
  public: Record<EntityId, PublicDiversityFacets>;
  /**
   * The HIDDEN, Vault-sealed orientation per NPC id — present ONLY for houseguests who hold their
   * orientation privately (closeted / not-yet-out). The caller seals these; they NEVER project. Out
   * houseguests are absent here (their orientation is the public `outOrientation`).
   */
  privateOrientations: Record<EntityId, Orientation>;
}

/** Internal working record (one per NPC) — assembled, then validated/repaired, then split. */
interface Draft {
  id: EntityId;
  name: string;
  nameGender: NameGender;
  age: number;
  ethnicity: EthnicityIdentity;
  genderPresentation: GenderPresentation;
  orientation: Orientation;
  /** True when the orientation is public (out); false when held privately (Vault-sealed). */
  out: boolean;
  /** True when the balance repair had to flip a clearly-gendered name (a bounded, documented exception). */
  coherenceFlipped?: boolean;
  /** #1140 — the RE-PICKED display name when the drawn name disagreed with the final gender presentation
   * (given-name token swapped to the target gender, surname kept). Absent ⇒ the drawn name already cohered. */
  renamed?: string;
}

const orientationSpec = (o: Orientation) => ORIENTATIONS.find((s) => s.orientation === o)!;
const isQueer = (o: Orientation): boolean => orientationSpec(o).queer;

/** Counts toward the LGBTQ+ floor: a non-straight orientation OR a nonbinary presentation (owner #4). */
function countsQueer(d: Pick<Draft, "orientation" | "genderPresentation">): boolean {
  return isQueer(d.orientation) || d.genderPresentation === "nonbinary";
}

/**
 * A WEIGHTED capped draw (owner amendment 2026-06-23): pick from `pool` proportional to `weightOf`,
 * restricted to entries still under their per-key `maxEach`. This is what makes a cast approximate U.S.
 * population rates instead of dealing uniformly over a BIPOC-heavy pool (the old ~70% skew). The cap
 * still flattens the high-weight heritages so no single one dominates. Deterministic off the seeded rng;
 * relaxes to the full pool (never spins) if every entry has hit its cap.
 */
function pickWeightedCapped<T>(
  rng: RandomnessSource, pool: readonly T[], keyOf: (t: T) => string,
  uses: Map<string, number>, maxEach: number, weightOf: (t: T) => number,
): T {
  const avail = pool.filter((v) => (uses.get(keyOf(v)) ?? 0) < maxEach);
  const from = avail.length ? avail : pool;
  const total = from.reduce((s, v) => s + Math.max(0, weightOf(v)), 0);
  let pick: T = from[from.length - 1]!;
  if (total > 0) {
    let r = rng.next() * total;
    for (const v of from) {
      r -= Math.max(0, weightOf(v));
      if (r <= 0) { pick = v; break; }
    }
  } else {
    pick = from[rng.int(from.length)]!; // all-zero weights ⇒ uniform fallback
  }
  uses.set(keyOf(pick), (uses.get(keyOf(pick)) ?? 0) + 1);
  return pick;
}

/** Case-insensitive lookup of a proposed heritage label against the known pool (unknown ⇒ undefined). */
function ethnicityByHeritage(label: string | undefined): EthnicityIdentity | undefined {
  if (!label) return undefined;
  const want = label.trim().toLowerCase();
  return want ? ALL_ETHNICITIES.find((e) => e.heritage.toLowerCase() === want) : undefined;
}

const isKnownGenderPresentation = (v: unknown): v is GenderPresentation =>
  v === "man" || v === "woman" || v === "nonbinary";
const isKnownOrientation = (v: unknown): v is Orientation =>
  typeof v === "string" && ORIENTATIONS.some((o) => o.orientation === v);

/**
 * Generate + validate/repair the diversity layer for the whole cast off a DEDICATED isolated sub-stream.
 * `seed` is the cast seed; the sub-streams fork off it via `hashSeed` (never the shared house stream).
 * The houseguests supply their seed-stable NAME (for gender coherence) and AGE (for the age-band floor);
 * NO competition-relevant draw happens here, so the season's outcome sequence is unchanged.
 *
 * `proposed` (issue #544 — the AI-driven half) optionally supplies the LLM's PROPOSED descriptive facets
 * per NPC id; each recognized field SEEDS the initial deal in place of the seeded random pick (an
 * unrecognized/absent field falls back to the seeded pick), then the SAME repair pipeline below runs.
 * Absent `proposed` (the live-game path / no model) is byte-identical to the pre-#544 deal.
 *
 * #1140 — the gender-coherent RENAME pass (step 7.5) avoids collisions only with given names already in THIS
 * cast. CROSS-SEASON name memory (NAME-1/#547) is applied SEPARATELY by the caller AFTER this layer (the
 * `decollidePriorNames` post-pass in GameSessionAdapter), so the warm-cast and plain-restart paths — which
 * adopt vs. re-seed — stay byte-identical here (this layer never sees prior-season names).
 */
export function generateDiversityLayer(
  seed: number, npcs: readonly Houseguest[], proposed?: Record<EntityId, ProposedIdentityFacets>,
): DiversityLayer {
  // Dedicated, isolated sub-streams — each forked off the cast seed, NEVER the shared house stream.
  const ethRng = new SeededRandom(hashSeed(`${seed}:diversity:ethnicity`));
  const genRng = new SeededRandom(hashSeed(`${seed}:diversity:gender`));
  const orRng = new SeededRandom(hashSeed(`${seed}:diversity:orientation`));
  const discRng = new SeededRandom(hashSeed(`${seed}:diversity:disclosure`));

  // ── 1. Initial deal (capped spreads, off the sub-streams) ────────────────────────────────────────
  // The seeded RANDOM picks are ALWAYS DRAWN (every NPC consumes one ethnicity + one gender pick off the
  // sub-streams), so the sub-stream consumption — and therefore the layer when no proposal is present —
  // is byte-identical to the pre-#544 deal. An accepted PROPOSED facet then OVERRIDES the drawn value for
  // that NPC. Drawing-then-overriding (never skipping the draw) keeps the deal player-/proposal-position-
  // independent and preserves the #338 RNG isolation: these are descriptive sub-streams, never the outcome
  // stream, so the public competition/vote sequence is unchanged regardless of any proposal.
  const ethUses = new Map<string, number>();
  const drafts: Draft[] = npcs.map((n) => {
    const want = proposed?.[n.id];
    const nameGender = nameGenderOf(n.name);
    // Gender presentation defaults to the name's typical gender; unisex names get a seeded pick (man/
    // woman here — nonbinary is assigned later, only among unisex names, capped). Keeps name+presentation
    // coherent: a clearly-gendered name always presents that way at the deal. A PROPOSED presentation (when
    // recognized) overrides the deal; the seeded pick is still consumed off the sub-stream above it.
    const dealtGender: GenderPresentation =
      nameGender === "man" ? "man"
      : nameGender === "woman" ? "woman"
      : genRng.next() < 0.5 ? "man" : "woman";
    const genderPresentation: GenderPresentation =
      want && isKnownGenderPresentation(want.genderPresentation) ? want.genderPresentation : dealtGender;
    // Ethnicity dealt off the whole pool, U.S.-population-WEIGHTED + capped (owner 2026-06-23) — so the
    // cast centers near the real ~40% BIPOC mix rather than the old uniform ~70% skew. BIPOC is still
    // repaired UP below in the rare tail where a weighted deal falls under the small-cast floor. A PROPOSED
    // heritage (when it matches a known pool entry AND is still UNDER the per-heritage cap) overrides the
    // dealt one; the dealt pick is still drawn (sub-stream isolation). A proposal that piles ALL 15 onto one
    // heritage is REPAIRED at the source: the first MAX_PER_ETHNICITY proposers get it, the OVERFLOW falls
    // back to the seeded capped deal — so even a monochrome proposal can never violate the spread cap.
    const dealtEthnicity = pickWeightedCapped(ethRng, ALL_ETHNICITIES, (e) => e.heritage, ethUses, MAX_PER_ETHNICITY, (e) => e.weight);
    const proposedEthnicity = ethnicityByHeritage(want?.ethnicity);
    const proposedUnderCap = proposedEthnicity !== undefined
      && (ethUses.get(proposedEthnicity.heritage) ?? 0) < MAX_PER_ETHNICITY;
    const ethnicity = proposedUnderCap ? proposedEthnicity! : dealtEthnicity;
    if (proposedUnderCap && proposedEthnicity!.heritage !== dealtEthnicity.heritage) {
      // Keep `ethUses` counting the FINAL heritages so the per-heritage cap stays honest for later NPCs:
      // un-count the dealt pick that was overridden, count the proposed one instead. (No-op when no
      // proposal — that branch never runs, so the pre-#544 deal is byte-identical.)
      ethUses.set(dealtEthnicity.heritage, Math.max(0, (ethUses.get(dealtEthnicity.heritage) ?? 1) - 1));
      ethUses.set(ethnicity.heritage, (ethUses.get(ethnicity.heritage) ?? 0) + 1);
    }
    // Orientation: a recognized proposed orientation overrides the seeded pick (still drawn for isolation).
    const dealtOrientation = ORIENTATIONS[orRng.int(ORIENTATIONS.length)]!.orientation;
    const orientation = want && isKnownOrientation(want.orientation) ? want.orientation : dealtOrientation;
    // Age: a proposed age at/above the eligibility floor overrides the seeded age (descriptive only — age
    // is NOT a competition/vote input, so this never perturbs the outcome stream; the age-band repair below
    // still guarantees the spread). Below the floor / absent ⇒ the seed-stable Character age stands.
    const age = want && typeof want.age === "number" && want.age >= AGE_ELIGIBILITY_FLOOR
      ? Math.floor(want.age) : n.character.age;
    return { id: n.id, name: n.name, nameGender, age, ethnicity, genderPresentation, orientation, out: true };
  });

  // ── 2. Repair — BIPOC floor (swap non-BIPOC drafts up to BIPOC heritages, respecting the cap) ────
  const bipocCount = () => drafts.filter((d) => d.ethnicity.bipoc).length;
  if (bipocCount() < MIN_BIPOC) {
    const bipocUses = new Map<string, number>();
    for (const d of drafts) if (d.ethnicity.bipoc) bipocUses.set(d.ethnicity.heritage, (bipocUses.get(d.ethnicity.heritage) ?? 0) + 1);
    for (const d of drafts) {
      if (bipocCount() >= MIN_BIPOC) break;
      if (d.ethnicity.bipoc) continue;
      d.ethnicity = pickWeightedCapped(ethRng, BIPOC_ETHNICITIES, (e) => e.heritage, bipocUses, MAX_PER_ETHNICITY, (e) => e.weight);
    }
  }

  // ── 2.5. Repair — nonbinary CAP DOWN (issue #544): a proposal can over-supply nonbinary, which the deal
  //     never does on its own (nonbinary is assigned ONLY by step 4 below, capped). Convert the surplus
  //     beyond MAX_NONBINARY back to a coherent binary BEFORE the gender-balance repair, so the cap holds
  //     and the converted drafts can satisfy the binary floors. Deterministic + RNG-free (resolve to the
  //     name-gender when clear, else to the currently under-represented binary) — so the no-proposal path,
  //     where no draft is nonbinary yet, runs this as a pure no-op and stays byte-identical.
  const nbCountNow = (): number => drafts.filter((d) => d.genderPresentation === "nonbinary").length;
  if (nbCountNow() > MAX_NONBINARY) {
    const countBinary = (g: GenderPresentation): number => drafts.filter((d) => d.genderPresentation === g).length;
    for (const d of drafts) {
      if (nbCountNow() <= MAX_NONBINARY) break;
      if (d.genderPresentation !== "nonbinary") continue;
      d.genderPresentation = d.nameGender === "man" ? "man"
        : d.nameGender === "woman" ? "woman"
        : countBinary("man") <= countBinary("woman") ? "man" : "woman";
    }
  }

  // ── 3. Repair — gender balance (bring each binary up to its floor) ───────────────────────────────
  // Coherence-first: flip UNISEX-named drafts (a "Jordan" presents either way) before anything else.
  // Only if the seeded NAME draw skewed so hard that unisex flips can't reach the floor does it fall back
  // to flipping a draft from the OVER-represented side — marking it `coherenceFlipped` so the test treats
  // it as a documented, bounded exception (names are byte-stable on the calibration stream, so an extreme
  // single-gender name draw is genuinely possible; the floor is the owner's locked guarantee).
  const countGender = (g: GenderPresentation) => drafts.filter((d) => d.genderPresentation === g).length;
  for (const target of ["man", "woman"] as const) {
    const other: GenderPresentation = target === "man" ? "woman" : "man";
    let guard = 0;
    while (countGender(target) < MIN_PER_BINARY_GENDER && guard++ < 100) {
      // (a) a unisex-named draft on the other binary, then (b) a unisex draft currently nonbinary…
      let flip = drafts.find((d) => d.nameGender === "unisex" && d.genderPresentation === other)
        ?? drafts.find((d) => d.nameGender === "unisex" && d.genderPresentation === "nonbinary");
      // (c) last resort: a clearly-gendered draft from the SURPLUS side (only while it stays in surplus).
      if (!flip && countGender(other) > MIN_PER_BINARY_GENDER) {
        flip = drafts.find((d) => d.genderPresentation === other);
        if (flip) flip.coherenceFlipped = true;
      }
      if (!flip) break; // nothing flippable without dropping the other side below its floor — give up
      flip.genderPresentation = target;
    }
  }

  // ── 4. Nonbinary — assign a sparse few among UNISEX names (counts toward MIN_QUEER), capped ───────
  // Done after the binary floor so it never undercuts it: only flip a unisex draft to nonbinary while
  // BOTH binaries stay at/above their floor.
  let nb = drafts.filter((d) => d.genderPresentation === "nonbinary").length;
  for (const d of drafts) {
    if (nb >= MAX_NONBINARY) break;
    if (d.nameGender !== "unisex" || d.genderPresentation === "nonbinary") continue;
    if (discRng.next() >= 0.5) continue; // sparse + seeded — often not
    const from = d.genderPresentation;
    if (countGender(from) <= MIN_PER_BINARY_GENDER) continue; // never drop a binary below its floor
    d.genderPresentation = "nonbinary";
    nb++;
  }

  // ── 5. Repair — age-band spread (the AGES are byte-stable; the floor only VALIDATES + repairs the
  //     stored ages would re-baseline the stream, so instead we ASSERT via the report and, when a band
  //     is short, BUMP a surplus-band draft's age into the short band on the DEDICATED sub-stream — the
  //     age is NOT a competition input, so this never perturbs outcomes). ────────────────────────────
  const ageRng = new SeededRandom(hashSeed(`${seed}:diversity:age`));
  const bandCount = (id: string) => drafts.filter((d) => ageBandOf(d.age) === id).length;
  for (const band of AGE_BANDS) {
    let guard = 0;
    while (bandCount(band.id) < MIN_PER_AGE_BAND && guard++ < 100) {
      // Pull from the most-overfull band (one with > MIN_PER_AGE_BAND), so the spread evens out.
      const donorBand = [...AGE_BANDS]
        .filter((b) => b.id !== band.id && bandCount(b.id) > MIN_PER_AGE_BAND)
        .sort((a, b) => bandCount(b.id) - bandCount(a.id))[0];
      if (!donorBand) break;
      const donor = drafts.find((d) => ageBandOf(d.age) === donorBand.id);
      if (!donor) break;
      // A concrete in-band age (deterministic): the band floor + a seeded offset within the band.
      const span = Math.min(band.maxExclusive, 70) - band.min;
      donor.age = Math.max(AGE_ELIGIBILITY_FLOOR, band.min + ageRng.int(Math.max(1, span)));
    }
  }

  // ── 6. Repair — LGBTQ+ floor (queer orientations / nonbinary), counted across the cast ───────────
  const queerCount = () => drafts.filter((d) => countsQueer(d)).length;
  if (queerCount() < MIN_QUEER) {
    for (const d of drafts) {
      if (queerCount() >= MIN_QUEER) break;
      if (countsQueer(d)) continue;
      // Assign a seeded queer orientation (never nonbinary here — that's gender, repaired above).
      d.orientation = QUEER_ORIENTATIONS[orRng.int(QUEER_ORIENTATIONS.length)]!.orientation;
    }
  }

  // ── 7. Disclosure — character-driven: some queer houseguests are OUT (public), some PRIVATE ───────
  // A seeded per-houseguest roll (NOT a uniform rule). Only NON-straight orientations can be "private";
  // a straight orientation is simply public/unremarkable. A nonbinary-but-straight houseguest's gender
  // is public (presentation is observable) but carries no private-orientation secret. The seeded roll is
  // ALWAYS consumed (sub-stream isolation), and a PROPOSED `out` (issue #544, when present) then overrides
  // it for a queer houseguest — the model may author whether this person is out or holds it privately.
  for (const d of drafts) {
    if (!isQueer(d.orientation)) { d.out = true; continue; }
    const rolledOut = discRng.next() < PUBLICLY_OUT_PROB;
    const want = proposed?.[d.id];
    d.out = want && typeof want.out === "boolean" ? want.out : rolledOut;
  }
  // §4/§5 guarantee: a season should reliably carry BOTH an out queer houseguest AND a private one when
  // it has ≥2 queer houseguests — so the scenarios always have a subject. If the roll made them ALL out
  // (or all private), flip exactly one of the queer-by-orientation drafts to the missing side.
  const queerByOrientation = drafts.filter((d) => isQueer(d.orientation));
  if (queerByOrientation.length >= 2) {
    if (!queerByOrientation.some((d) => !d.out)) queerByOrientation[queerByOrientation.length - 1]!.out = false;
    if (!queerByOrientation.some((d) => d.out)) queerByOrientation[0]!.out = true;
  }

  // ── 7.5. #1140 — RE-PICK the given name to MATCH the final gender presentation ────────────────────
  // Root cause: the NAME is drawn FIRST on the byte-stable MAIN house stream; the gender presentation is
  // decided HERE, LATER, and can DISAGREE with the name (the gender-balance flip above, a unisex-overlap
  // name like "Adrian"/"Marlon"/"Shawn" that reads gendered to an image model, or an AI-override via
  // recordCastIdentity). The PORTRAIT reads the FACET but also puts the NAME in the prompt, so the image
  // model renders the NAME's gender — the face contradicts the stored facet. Fix: now that every gender
  // repair is FINAL, swap the given-name TOKEN to one of the target gender (KEEPING the surname) for any
  // draft whose final presentation is a GENDERED value the name doesn't already read as. The name then
  // reads the SAME gender the portrait + narration encode — coherence by construction.
  //
  // CALIBRATION-NEUTRALITY (load-bearing): this runs on a DEDICATED `:diversity:rename` sub-stream forked
  // off the cast seed (NEVER the shared house/competition/vote stream, NOR any other diversity sub-stream),
  // and mutates ONLY a descriptive `name` STRING — never an outcome input. So the seeded competition / vote
  // / jury sequence is BYTE-IDENTICAL with the rename on vs. off (proven by the heavy jury + gradient gates
  // and the ORWELL_DISABLE_DIVERSITY golden path).
  //
  // CAVEAT (why the re-pick is HERE, not earlier): the drawn name is the seed key for several SIDE streams
  // (appearance / hidden / voice in characterFactory.ts), which run BEFORE this diversity layer. The re-pick
  // is applied AFTER generation (here / at the fold), so it does NOT retroactively change those side draws —
  // which is CORRECT for byte-stability. Do NOT move this earlier: re-picking the name on the MAIN stream
  // would shift every downstream stat / volatility / age draw and break the calibration goldens.
  const renRng = new SeededRandom(hashSeed(`${seed}:diversity:rename`));
  // Track the given names in play so a re-pick keeps the cast's given names unique (the main-stream draw's
  // own invariant) — seeded with every current first token, then updated as each draft is renamed. (Cross-
  // season avoidance is a SEPARATE post-pass in the caller — see the doc-comment above.)
  const usedGiven = new Set(drafts.map((d) => d.name.split(" ")[0]!));
  for (const d of drafts) {
    const g = d.genderPresentation;
    if (g !== "man" && g !== "woman") continue; // nonbinary keeps its (unisex-coherent) name
    if (nameGenderOf(d.name) === g) continue; // name already reads UNAMBIGUOUSLY as the final gender
    const parts = d.name.split(" ");
    const oldGiven = parts[0]!;
    const surname = parts.slice(1).join(" "); // keep the whole surname (the corpus surname is one token)
    usedGiven.delete(oldGiven); // free the old given name before picking the replacement
    const newGiven = pickGivenNameFor(g, renRng, usedGiven);
    usedGiven.add(newGiven);
    d.renamed = surname ? `${newGiven} ${surname}` : newGiven;
  }

  // ── 8. Split across the Vault Wall ───────────────────────────────────────────────────────────────
  const pub: Record<EntityId, PublicDiversityFacets> = {};
  const privateOrientations: Record<EntityId, Orientation> = {};
  for (const d of drafts) {
    // #1140 — the FINAL name (the re-pick when one happened, else the drawn name). Coherence is now a
    // GUARANTEE the step-7.5 pass establishes, so we compute `nameCoheres` against the FINAL name as a
    // standing self-check: a gendered presentation reads its own name-gender, and nonbinary keeps a unisex
    // name. (The `coherenceFlipped` provenance is retained on the draft but no longer makes a name incohere.)
    const finalName = d.renamed ?? d.name;
    const finalNameGender = nameGenderOf(finalName);
    const nameCoheres =
      d.genderPresentation === "nonbinary"
        ? finalNameGender === "unisex"
        : finalNameGender === d.genderPresentation;
    pub[d.id] = {
      ethnicity: d.ethnicity.heritage,
      bipoc: d.ethnicity.bipoc,
      skinTone: d.ethnicity.skinTone,
      genderPresentation: d.genderPresentation,
      // PRESENT only when the name actually changed (the caller writes it back onto the Character); ABSENT
      // ⇒ the drawn name already cohered and the existing Character name stands.
      ...(d.renamed !== undefined ? { name: d.renamed } : {}),
      age: d.age,
      nameCoheres,
      ...(d.out && isQueer(d.orientation) ? { outOrientation: d.orientation } : {}),
    };
    if (isQueer(d.orientation) && !d.out) privateOrientations[d.id] = d.orientation;
  }
  return { public: pub, privateOrientations };
}

/**
 * The AI-driven repair entry (issue #544): take the LLM's PROPOSED descriptive identity facets per NPC id
 * and produce the engine-GUARANTEED diversity layer. Recognized proposed facets seed the initial deal; the
 * SAME validate/repair pipeline then enforces the four floors (BIPOC / gender balance / age spread / LGBTQ+)
 * and the per-heritage cap — so a lazy/biased/monochrome proposal can NEVER skew the cast, and `skinTone`
 * is always re-grounded from the FINAL (possibly repaired) heritage. Deterministic per seed + proposal, and
 * still player-INDEPENDENT (the sub-streams key off the seeded NAMES, never the player). Calibration-neutral:
 * these are descriptive facets on isolated sub-streams, never a competition/vote input. An EMPTY proposal is
 * byte-identical to `generateDiversityLayer` (the deterministic floor — what stands when no model is wired).
 */
export function repairDiversityLayer(
  seed: number, npcs: readonly Houseguest[], proposed: Record<EntityId, ProposedIdentityFacets>,
): DiversityLayer {
  return generateDiversityLayer(seed, npcs, proposed);
}

// ── Vault sealing helper for a private orientation (engine-only — never projected) ──────────────────
/** The Vault kind a sealed private orientation rides under (a hidden attribute; no schema change). */
export const PRIVATE_ORIENTATION_KIND = "hidden-attribute" as const;

/** Stable Vault id for one NPC's sealed private orientation (idempotent re-seal on restore). */
export function privateOrientationVaultId(sourceId: EntityId): string {
  return `private-orientation:${sourceId}`;
}

/** ORW-261 / spec 0141: placeholder tuning for a houseguest choosing to tell the player a private orientation. Trust bar guards it; risk = their own stakes; pressure sits below a straight confidence press. */
export const ORIENTATION_DISCLOSURE = {
  trustBar: 0.5, risk: 0.55, pressure: 0.6,
  /** the UNPROMPTED variant (nobody pressed): a higher trust bar, no press, and a further rarity draw - far rarer than the pressed path (spec 0141). */
  unpromptedTrustBar: 0.75, unpromptedPressure: 0, unpromptedRarity: 0.35,
} as const;

/** ORW-261: the houseguest's own words when they choose to tell. Roles only; no label shown on any panel - the narrator voices it as speech. */
export function orientationDisclosureText(orientation: Orientation): string {
  return `They tell you, in confidence and in their own words, that they are ${orientation}.`;
}

/** Serialize a private orientation to ONE engine-only Vault record content string (never projected). */
export function privateOrientationToVaultContent(sourceId: EntityId, orientation: Orientation): string {
  return `private-orientation ${sourceId}: ${orientation} (hidden — surfaces only via a 0002 pathway, never forced)`;
}

// ── §4.1 — orientation-aware showmance ELIGIBILITY (the 0059 tie) ───────────────────────────────────
// The full per-NPC identity the showmance plausibility predicate reads — assembled from the layer's
// PUBLIC facets + the (engine-only) private orientations. Used ONLY engine-side, never projected.
export interface ShowmanceIdentity {
  orientation: Orientation;
  genderPresentation: GenderPresentation;
}

/**
 * Reassemble each NPC's full identity (public + private orientation) from a generated layer — for the
 * 0059 showmance ELIGIBILITY check. Engine-only; the private orientation here never leaves the engine.
 */
export function showmanceIdentities(layer: DiversityLayer): Record<EntityId, ShowmanceIdentity> {
  const out: Record<EntityId, ShowmanceIdentity> = {};
  for (const [id, pub] of Object.entries(layer.public)) {
    const orientation: Orientation =
      pub.outOrientation ?? layer.privateOrientations[id] ?? "straight";
    out[id] = { orientation, genderPresentation: pub.genderPresentation };
  }
  return out;
}

/**
 * Is a romance between two houseguests PLAUSIBLE given their identities (owner decision #3 —
 * eligibility-only gating)? A QUEER showmance is a FIRST-CLASS possible pairing (the genesis design
 * explicitly wanted one), never a special case. The predicate is permissive by design — it only rules
 * OUT a pairing that makes no sense for both parties (e.g. two strictly straight same-gender houseguests,
 * or two strictly gay/lesbian different-gender houseguests). Bi/pan/queer pair with anyone. It NEVER
 * forces a showmance — the L40 sparseness/earned discipline still dominates; this only gates WHO is eligible.
 */
export function showmancePlausible(a: ShowmanceIdentity, b: ShowmanceIdentity): boolean {
  const sameGender = a.genderPresentation === b.genderPresentation;
  // "Open" orientations (attracted regardless of gender) make any pairing plausible from that side.
  const open = (o: Orientation): boolean => o === "bisexual" || o === "pansexual" || o === "queer";
  const attractedSame = (o: Orientation): boolean => open(o) || o === "gay" || o === "lesbian";
  const attractedDiff = (o: Orientation): boolean => open(o) || o === "straight";
  return sameGender
    ? attractedSame(a.orientation) && attractedSame(b.orientation)
    : attractedDiff(a.orientation) && attractedDiff(b.orientation);
}

// re-export so the cap is a single source of truth in tests/imports
export { MAX_PER_AGE_BAND };
