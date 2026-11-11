import type { UpdateCastingReq, CastingStatusView } from "../ports/GameSession";
import { nameGenderOf } from "./data/nameGender";

/**
 * The casting interview's incremental intake (feature 0050).
 *
 * OOBE is not one atomic call: the producer records each answer AS IT LANDS
 * (`updateCasting`), the engine accumulates the building blocks here, and the
 * captured/missing status — computed by THIS module, not the model — determines
 * the interview's next step. `createCharacter` finalizes from the intake.
 *
 * Everything here is the player's OWN authored material (Vault-free by nature);
 * the intake is part of the durable session core, so a half-done interview
 * survives a restart (0030) and the producer resumes instead of re-asking.
 */

/** The accumulated intake. Same fields as the update request; notes always present. */
export type CastingIntake = Omit<UpdateCastingReq, "interviewNotes"> & { interviewNotes: string[] };

/**
 * Intake bounds (audit C8). The interview is an UNTRUSTED, durable input surface that is
 * echoed into every pre-game system prompt — without caps it is an unbounded prompt-
 * injection/payload store. Scalars and notes are hard-capped at merge time (never at
 * read time, so persisted detail is never re-truncated — mandate #4 applies to what
 * was actually accepted).
 */
export const CASTING_LIMITS = {
  /** Max characters accepted per scalar field (name, backstory, …). */
  scalarMax: 500,
  /** Max characters accepted per interview note. */
  noteMax: 280,
  /** Max number of accumulated notes; later notes are refused once full. */
  notesMax: 40,
} as const;

/**
 * Neutralize a captured value for echoing into a SYSTEM PROMPT (audit C8): structure is
 * the attack surface, so newlines/control characters collapse to single spaces (a value
 * can never fake a new prompt line, list bullet, or section header) and the echo is
 * length-capped. The stored intake keeps the accepted value; only the ECHO is flattened.
 */
export function neutralizeForPrompt(value: string, max = 160): string {
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function emptyIntake(): CastingIntake {
  return { interviewNotes: [] };
}

/**
 * The interview's coverage, in the engine's ask-order. `ask` is the producer-facing phrasing of
 * the next step; the scalar fields echo back in `known` so a resumed interview never re-asks.
 */
export const CASTING_COVERAGE: ReadonlyArray<{ field: keyof CastingIntake; ask: string }> = [
  // Casting step #1 — "what do you look like?" (the photo-first OOBE re-sequence): the producers
  // open the interview here, BEFORE any other question, so `next` on a fresh interview points at the
  // cast photo first. It is an ORDINARY scalar (it flows through merge/overwrite/capture/status like
  // every other field), but it is OPTIONAL by design — `ready` stays name-only (below), so an
  // unanswered/"skipped" photo never blocks finalization. The FE sets it to "uploaded" (a photo was
  // finalized) or "skipped" (the player declined) when the in-chat photo box closes; any non-empty
  // string marks the step handled. Vault-free: it is the player's own metadata, never secret.
  { field: "castPhoto", ask: "their cast photo — what they look like (the in-chat photo box opens for this; it's optional)" },
  { field: "playerName", ask: "their name — what the feeds should call them" },
  { field: "backstory", ask: "their life outside the house, in their words" },
  { field: "motivation", ask: "why they came to play / what they're playing for" },
  { field: "personaArchetype", ask: "how they think they'll come across (their own words)" },
  { field: "personaStrategyStyle", ask: "how they'd describe their way of playing" },
  { field: "privateStrategy", ask: "how they ACTUALLY plan to play (assure them it stays with production)" },
  { field: "interviewNotes", ask: "get-to-know material worth remembering (record notes as they land)" },
  { field: "archetype", ask: "your canonical casting-sheet mapping of who they are" },
  { field: "strategyStyle", ask: "your canonical casting-sheet mapping of how they'll play" },
  // #1326 — APPENDED at the end (never reorder the entries above it): the player's OWN pronouns/gender
  // presentation, mirroring a houseguest's public `genderPresentation` facet. OPTIONAL by design — it
  // does NOT gate `ready` (name-only) or `finalizable` (the floor above), so a player who declines to
  // answer never blocks casting. Landing it LAST keeps it the lowest-priority ask, asked only once
  // everything else the floor/finalize gate actually needs is already on file.
  { field: "genderPresentation", ask: "their pronouns / how they present — man, woman, or nonbinary (optional; never re-ask if they'd rather skip it)" },
];

/**
 * Common synonyms the narration model actually emits for a casting field (issue #1033 / F-1). The
 * model proposes e.g. `name` when the engine field is `playerName`; without an alias the value lands
 * under an unrecognized key and is SILENTLY DROPPED (the intake stays empty, `createCharacter` never
 * finalizes, casting wedges). Mapping the obvious synonyms to their canonical field BEFORE the merge
 * makes the engine robust to how the model phrases the call — a `name` write fills `playerName`.
 *
 * Conservative on purpose: only unambiguous synonyms map. A genuinely unknown key still falls through
 * to `ignoredCastingKeys` (echoed back so the producer re-files) rather than being mis-merged. A
 * canonical field already present in the request always wins over an alias (no silent overwrite).
 */
const CASTING_KEY_ALIASES: Readonly<Record<string, keyof UpdateCastingReq>> = {
  name: "playerName",
  playername: "playerName",
  player_name: "playerName",
  displayname: "playerName",
  display_name: "playerName",
  notes: "interviewNotes",
  note: "interviewNotes",
  interviewnote: "interviewNotes",
  interview_notes: "interviewNotes",
  bio: "backstory",
  background: "backstory",
  story: "backstory",
  why: "motivation",
  goal: "motivation",
  persona: "personaArchetype",
  strategy: "personaStrategyStyle",
  playstyle: "personaStrategyStyle",
  play_style: "personaStrategyStyle",
  secretstrategy: "privateStrategy",
  secret_strategy: "privateStrategy",
  photo: "castPhoto",
  cast_photo: "castPhoto",
  // #1326 — the obvious synonyms a model reaches for instead of the canonical `genderPresentation`.
  pronouns: "genderPresentation",
  gender: "genderPresentation",
  gender_presentation: "genderPresentation",
} as const;

/**
 * Rewrite recognized-synonym keys onto their canonical casting field (issue #1033). A canonical key
 * already present in the request is never clobbered by an alias; `interviewNotes` aliases MERGE into
 * the notes array (notes append) rather than overwrite. Keys that are neither canonical nor a known
 * alias pass through untouched — they remain visible to `ignoredCastingKeys`. The input is treated as
 * read-only; a fresh object is returned.
 */
export function aliasCastingKeys(req: object): UpdateCastingReq {
  const src = req as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Canonical keys land first so an explicit canonical value always wins over an aliased one.
  for (const k of Object.keys(src)) {
    if (CASTING_FIELDS.has(k)) out[k] = src[k];
  }
  for (const k of Object.keys(src)) {
    if (CASTING_FIELDS.has(k)) continue;
    const canonical = CASTING_KEY_ALIASES[k.toLowerCase()];
    if (canonical === undefined) continue; // unknown ⇒ left for ignoredCastingKeys
    if (canonical === "interviewNotes") {
      const existing = Array.isArray(out["interviewNotes"]) ? (out["interviewNotes"] as unknown[]) : [];
      const incoming = Array.isArray(src[k]) ? (src[k] as unknown[]) : [src[k]];
      out["interviewNotes"] = [...existing, ...incoming];
    } else if (out[canonical] === undefined) {
      out[canonical] = src[k];
    }
  }
  return out as UpdateCastingReq;
}

/**
 * Merge one update into the intake: scalars set/overwrite when provided; notes APPEND (never
 * replace). Every accepted value is hard-capped (C8): scalars to `scalarMax`, notes to `noteMax`
 * each and `notesMax` total — the durable intake can never become an unbounded payload store.
 *
 * Recognized-synonym keys are aliased onto their canonical field first (issue #1033), so a model that
 * writes `name`/`notes` fills `playerName`/`interviewNotes` instead of being silently dropped.
 */
export function mergeCastingUpdate(intake: CastingIntake, rawReq: UpdateCastingReq): CastingIntake {
  const req = aliasCastingKeys(rawReq);
  const next: CastingIntake = { ...intake, interviewNotes: [...intake.interviewNotes] };
  for (const { field } of CASTING_COVERAGE) {
    if (field === "interviewNotes") continue;
    const v = req[field];
    if (typeof v === "string" && v.trim().length > 0) next[field] = v.trim().slice(0, CASTING_LIMITS.scalarMax);
  }
  for (const raw of req.interviewNotes ?? []) {
    const note = String(raw).trim().slice(0, CASTING_LIMITS.noteMax);
    if (note.length > 0 && !next.interviewNotes.includes(note) && next.interviewNotes.length < CASTING_LIMITS.notesMax) {
      next.interviewNotes.push(note);
    }
  }
  return next;
}

/**
 * Which scalar fields this update OVERWRITES (audit C8): a field already captured whose value the
 * update replaces with a DIFFERENT (post-cap, trimmed) value. A first write to an empty field is a
 * capture, not an overwrite; a re-write of the identical value is a no-op. Notes APPEND, so they
 * are never overwrites. The producer surfaces these so it can confirm, never silently clobber.
 */
export function overwrittenScalars(intake: CastingIntake, rawReq: UpdateCastingReq): string[] {
  const req = aliasCastingKeys(rawReq);
  const hits: string[] = [];
  for (const { field } of CASTING_COVERAGE) {
    if (field === "interviewNotes") continue;
    const v = req[field];
    if (typeof v !== "string" || v.trim().length === 0) continue;
    const prev = intake[field];
    const incoming = v.trim().slice(0, CASTING_LIMITS.scalarMax);
    if (typeof prev === "string" && prev.trim().length > 0 && prev !== incoming) hits.push(field);
  }
  return hits;
}

/** The recognized casting fields — exactly the `UpdateCastingReq` keys (the coverage set). */
const CASTING_FIELDS: ReadonlySet<string> = new Set<string>(CASTING_COVERAGE.map(({ field }) => field));

/**
 * Keys the caller passed that the engine did NOT merge (audit R4-01). A recognized synonym (`name`,
 * `notes`, …) is now aliased onto its canonical field (issue #1033) and is therefore NOT ignored —
 * only a genuinely unknown key (a typo, an off-schema field) is reported, so the producer learns the
 * answer didn't land and can re-file it. Echoing these is the casting-seam counterpart of the FE's
 * under-call error correction: a wrong-key write self-corrects instead of silently vanishing.
 */
export function ignoredCastingKeys(req: object): string[] {
  return Object.keys(req).filter(
    (k) => !CASTING_FIELDS.has(k) && CASTING_KEY_ALIASES[k.toLowerCase()] === undefined,
  );
}

/** True when a field has been captured (notes: at least one recorded). */
function captured(intake: CastingIntake, field: keyof CastingIntake): boolean {
  if (field === "interviewNotes") return intake.interviewNotes.length > 0;
  const v = intake[field];
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Where the interview stands. `ready` is the hard gate (a name exists); `missing`/`next` are the
 * engine-ordered coverage still to acquire — the producer follows the engine, not its own memory.
 */
export function castingStatusOf(intake: CastingIntake, overwrote: string[] = []): CastingStatusView {
  const known: Record<string, string> = {};
  const missing: string[] = [];
  let next: string | null = null;
  for (const { field, ask } of CASTING_COVERAGE) {
    if (captured(intake, field)) {
      known[field] = field === "interviewNotes"
        ? `${intake.interviewNotes.length} note${intake.interviewNotes.length === 1 ? "" : "s"}`
        : (intake[field] as string);
    } else {
      missing.push(field);
      if (next === null) next = ask;
    }
  }
  const status: CastingStatusView = {
    known,
    missing,
    next,
    ready: captured(intake, "playerName"),
    finalizable: castingFinalizable(intake),
  };
  if (overwrote.length > 0) status.overwrote = overwrote;
  return status;
}

/** True when nothing has been captured yet (a fresh interview — nothing to persist or resume). */
export function intakeIsEmpty(intake: CastingIntake): boolean {
  return CASTING_COVERAGE.every(({ field }) => !captured(intake, field));
}

/**
 * The FINALIZE floor (the mobile short-circuit fix, feature 0050): `ready` (name-only) is the floor
 * for an EXPLICIT, player-driven finalize, but it is NOT enough to FORCE-finalize from an automated
 * fallback — name+photo alone produced a "floater with no stats." `finalizable` requires that a
 * genuine interview actually happened: a name, a backstory, a motivation, AND at least one persona/
 * strategy answer. `castPhoto` is OPTIONAL and never counts toward it.
 */
export const CASTING_FINALIZE_FLOOR: ReadonlyArray<keyof CastingIntake> = [
  "playerName",
  "backstory",
  "motivation",
] as const;

/** At least one of these must be captured for the interview to be finalizable. */
const CASTING_FINALIZE_ANY_OF: ReadonlyArray<keyof CastingIntake> = [
  "personaArchetype",
  "personaStrategyStyle",
  "privateStrategy",
] as const;

/**
 * True when a genuine interview has happened — enough authored substance that a finalize mints a real
 * houseguest, not the default floater. The hard floor (name+backstory+motivation) plus at least one
 * persona/strategy answer. `castPhoto` does NOT count.
 */
export function castingFinalizable(intake: CastingIntake): boolean {
  return (
    CASTING_FINALIZE_FLOOR.every((field) => captured(intake, field)) &&
    CASTING_FINALIZE_ANY_OF.some((field) => captured(intake, field))
  );
}

// ── Dossier coherence validator (feature 0116 / RC5 — the single identity spine) ────────────────────
//
// A model-authored cast dossier (`castGenesis` skeleton + the `recordCastIdentity` gender facet + the
// deep-authored `recordCastProfile` body) is assembled from THREE model calls, so a houseguest can ship
// INTERNALLY CONTRADICTORY — the live bundle produced 5: `genderPresentation:'man'` alongside `she`/`her`
// self-references and a `his forearm` mark (Lily Evans npc:13), a "spent thirty years / grandmother"
// biography on a 22-year-old (Donna), and a public vocation that disagrees with the cover-story vocation
// (concierge/bar, mortgage/teacher, home-aide/pharma). `portraitPrompts.ts` and the narration framing both
// read ONLY the pinned `genderPresentation` pair (§S4a) — so a dossier whose PROSE disagrees with that pin
// renders one sex while the narration voices the other.
//
// This validator is the enforcement spine: the pinned `genderPresentation` is authoritative, and every
// SELF-REFERENTIAL field (appearance / demeanor / distinguishingMark / the structured physical facet) must
// agree with it. It reject-or-repairs a dossier on a HARD contradiction and returns the fields to
// RE-AUTHOR (never a full-cast re-roll — §S4b: re-author only the contradicting field once). Name /
// ethnicity mismatches are SOFT flags only (may be a deliberate diversity choice — the engine allows the
// name to disagree with the gender). Pure — no I/O, no rng, no Vault handle (it runs engine-side over an
// already-assembled dossier; the optional `coverVocation` is passed IN by the caller, never read here).

/** The dossier fields the coherence validator inspects. All are the assembled (post-commit) values. */
export interface DossierForCoherence {
  /** The PINNED identity spine — authoritative; every other field must agree with it. */
  genderPresentation?: "man" | "woman" | "nonbinary";
  /** The houseguest's display name — its GIVEN token is checked against the pin (a SOFT flag; F5). */
  name?: string;
  /** Self-referential subject-descriptive prose (pronouns here describe THE SUBJECT). */
  appearance?: string;
  demeanor?: string;
  distinguishingMark?: string;
  /** The structured physical facet — its free-text members are self-referential too. */
  physicalCharacteristics?: { distinguishingMark?: string; facialFeatures?: string; hair?: string; heightBuild?: string };
  /** Third-party-prone prose — scanned only for age/year-span coherence, NOT hard pronoun rejection. */
  biography?: string;
  background?: string;
  age?: number;
  /** The public occupation. */
  vocation?: string;
  /** Engine-side only: the cover-story vocation the persona claims (passed in; a mismatch is HARD). */
  coverVocation?: string;
}

export type CoherenceSeverity = "hard" | "soft";
export interface CoherenceContradiction {
  /** The dossier field that carries the contradiction (the one to re-author). */
  field: string;
  /** A short, Vault-free label of the rule it broke. */
  rule: string;
  severity: CoherenceSeverity;
}

export interface DossierCoherenceResult {
  /** True iff NO hard contradiction exists — a dossier that fails this must be rejected/repaired. */
  ok: boolean;
  contradictions: CoherenceContradiction[];
  /** The DISTINCT fields to re-author — every hard contradiction PLUS a nonbinary pin's stray binary
   * self-pronouns (soft, `ok` stays true, but still scrubbed) — repair touches only these. */
  repairFields: string[];
}

const MASC_PRONOUN_RE = /\b(he|him|his|himself)\b/i;
const FEM_PRONOUN_RE = /\b(she|her|hers|herself)\b/i;

/** Number-word → integer for the low tens the biographies actually use ("thirty years", …). */
const TENS_WORDS: Readonly<Record<string, number>> = {
  ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/**
 * ORW-145 — a sentence whose SUBJECT is a relative ("His parents spent thirty years building a company", "Her
 * family has lived on the same street for decades") states the relative's span, not the houseguest's.
 */
const RELATIVE_SUBJECT_RE =
  /^\W*(?:(?:and|but|so|then)\s+)?(?:her|his|their|my|our)\s+(?:[a-z'-]+\s+){0,2}?(?:parents|family|mother|father|mom|mum|dad|grandparents|grandmother|grandfather|grandma|grandpa|uncles?|aunts?|brothers?|sisters?|siblings|husband|wife|partner|cousins?|relatives)\b/i;

/**
 * Extract every year-span count a biography states about the HOUSEGUEST ("spent thirty years", "3 years", "a
 * decade"). ORW-145: an attributive age ("a 40-year-old diner", "decades-old") describes a thing, and a sentence
 * whose subject is a relative states the relative's span, so neither counts. A predicative "40 years old" still
 * counts (it is usually the houseguest's own age).
 */
function statedYearSpans(text: string): number[] {
  const spans: number[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (RELATIVE_SUBJECT_RE.test(sentence)) continue;
    const lower = sentence.toLowerCase();
    const digitRe = /(\d{1,3})[\s-]+years?\b(?!-old)/g;
    for (let m = digitRe.exec(lower); m; m = digitRe.exec(lower)) spans.push(parseInt(m[1]!, 10));
    const wordRe = /\b(ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-]+years?\b(?!-old)/g;
    for (let m = wordRe.exec(lower); m; m = wordRe.exec(lower)) spans.push(TENS_WORDS[m[1]!]!);
    const decadeRe = /\b(a|one)\s+decade\b(?!-old)/g;
    for (let m = decadeRe.exec(lower); m; m = decadeRe.exec(lower)) spans.push(10);
    const decadesRe = /\bdecades\b(?!-old)/g;
    if (decadesRe.test(lower)) spans.push(20);
  }
  return spans;
}

/**
 * A grandparent SELF-reference implausible for a young houseguest. ORW-145: a grandparent word after a possessive
 * ("her grandmother", "his grandfather's farm", "her great-grandmother") names a RELATIVE, so it is not one;
 * "grandkids" / "grandchildren" always make the houseguest the grandparent.
 */
const GRANDPARENT_WORD_RE =
  /\b((?:her|his|their|my|our|your)\s+(?:(?:late|beloved|own|dear)\s+|great-)*)?grand(mother|father|ma|pa|parent|kids?|children)\b/gi;
function grandparentSelfReference(text: string): boolean {
  for (const m of text.matchAll(GRANDPARENT_WORD_RE)) {
    const kind = m[2]!.toLowerCase();
    if (kind.startsWith("kid") || kind === "children") return true;
    if (!m[1]) return true;
  }
  return false;
}
/** Below this age a grandparent self-reference is treated as a hard contradiction. */
const GRANDPARENT_MIN_AGE = 34;

/** Strip stopwords + punctuation → the significant lowercase word set (for vocation overlap). */
function significantWords(s: string): Set<string> {
  const stop = new Set(["a", "an", "the", "of", "and", "at", "in", "for", "to", "on"]);
  return new Set(
    s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !stop.has(w)),
  );
}

/**
 * Validate one assembled dossier for INTERNAL coherence against the pinned `genderPresentation` spine
 * (§S4a/S4b). HARD contradictions (`ok === false`, the caller rejects/repairs):
 *   (i)  a SELF-REFERENTIAL field carries a pronoun opposite the pinned gender (man + "her", woman +
 *        "his"), OR a single field mixes BOTH masculine and feminine self-references (the subject is
 *        called both he and she) — catches the Lily Evans object ('man' + "her shyness" + "his forearm");
 *   (ii) a biography states a life/career span ≥ the age, or a grandparent self-reference on a young
 *        houseguest (Donna: "spent thirty years / grandmother" at 22);
 *   (iii) the public vocation shares NO significant word with the cover-story vocation (concierge/bar).
 * SOFT flags (do not fail `ok`): name / ethnicity divergence is deliberate and never rejected here.
 * Pure. Repair (per §S4b) re-authors ONLY the returned `repairFields`, never the whole cast.
 */
export function validateDossierCoherence(d: DossierForCoherence): DossierCoherenceResult {
  const contradictions: CoherenceContradiction[] = [];
  const gender = d.genderPresentation;

  // (i) Pronoun coherence — SELF-REFERENTIAL fields only (a mark/appearance/demeanor pronoun is the
  // subject; a biography can legitimately reference third parties, so it is NOT hard-scanned here).
  const selfRefFields: Array<[string, string | undefined]> = [
    ["appearance", d.appearance],
    ["demeanor", d.demeanor],
    ["distinguishingMark", d.distinguishingMark ?? d.physicalCharacteristics?.distinguishingMark],
    ["physicalCharacteristics.facialFeatures", d.physicalCharacteristics?.facialFeatures],
    ["physicalCharacteristics.hair", d.physicalCharacteristics?.hair],
    ["physicalCharacteristics.heightBuild", d.physicalCharacteristics?.heightBuild],
  ];
  let anyMasc = false;
  let anyFem = false;
  const oppositeFields = new Set<string>();
  const bothInOne = new Set<string>();
  // A `nonbinary` pin has no OPPOSITE binary gender, so the man/woman branch never fires for it — but a lone
  // binary self-pronoun ("his left eyebrow") still ships the wrong pronoun on a nonbinary houseguest. Track
  // those fields to flag for a SOFT repair (neutralized to singular they/their by the scrub) below.
  const nonbinaryBinaryFields = new Set<string>();
  for (const [field, value] of selfRefFields) {
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const masc = MASC_PRONOUN_RE.test(value);
    const fem = FEM_PRONOUN_RE.test(value);
    if (masc) anyMasc = true;
    if (fem) anyFem = true;
    if (masc && fem) bothInOne.add(field);
    // Opposite-of-pin pronoun in a self-referential field ⇒ this field must be re-authored.
    if (gender === "man" && fem) oppositeFields.add(field);
    if (gender === "woman" && masc) oppositeFields.add(field);
    // Nonbinary pin: ANY binary self-pronoun (he/him/his OR she/her/hers) is a mismatch to neutralize.
    if (gender === "nonbinary" && (masc || fem)) nonbinaryBinaryFields.add(field);
  }
  for (const field of oppositeFields) {
    contradictions.push({ field, rule: `self-referential pronoun contradicts genderPresentation '${gender}'`, severity: "hard" });
  }
  // A single self-referential field that names the subject as BOTH he and she is internally broken
  // regardless of the pin (the mark says 'his', the appearance says 'her').
  for (const field of bothInOne) {
    if (oppositeFields.has(field)) continue;
    contradictions.push({ field, rule: "field mixes masculine and feminine self-references", severity: "hard" });
  }
  // Cross-field: BOTH genders self-referenced across the object with NO pin to arbitrate — still a
  // contradiction (the cast dossier calls one person he in one place and she in another). Only raise it
  // when the pin didn't already catch it (else it double-reports the same defect).
  if (anyMasc && anyFem && oppositeFields.size === 0 && bothInOne.size === 0) {
    // Attribute it to the field(s) carrying the MINORITY pronoun — but with no pin we can't tell which
    // is wrong, so re-author both the mark and the appearance (the self-referential prose).
    const carriers = selfRefFields.filter(
      ([, v]) => typeof v === "string" && (MASC_PRONOUN_RE.test(v) || FEM_PRONOUN_RE.test(v)),
    ).map(([f]) => f);
    for (const field of carriers) {
      contradictions.push({ field, rule: "cast dossier self-references both masculine and feminine", severity: "hard" });
    }
  }
  // Nonbinary binary-pronoun mismatches: SOFT (never fails `ok`, mirroring the name flag) but still flagged
  // for REPAIR — the scrub's nonbinary mapping rewrites he/she → singular they/their in place. Skip a field
  // already reported (a both-in-one or cross-field HARD contradiction) so it is not double-reported.
  for (const field of nonbinaryBinaryFields) {
    if (contradictions.some((c) => c.field === field)) continue;
    contradictions.push({ field, rule: "self-referential binary pronoun contradicts genderPresentation 'nonbinary'", severity: "soft" });
  }

  // (ii) Age vs biography year-spans + grandparent self-reference.
  const bioText = [d.biography, d.background].filter((s): s is string => typeof s === "string" && s.length > 0).join(" ");
  if (bioText && typeof d.age === "number" && Number.isFinite(d.age)) {
    for (const span of statedYearSpans(bioText)) {
      if (span >= d.age) {
        contradictions.push({ field: "biography", rule: `states a ${span}-year span at age ${d.age}`, severity: "hard" });
        break;
      }
    }
    if (d.age < GRANDPARENT_MIN_AGE && grandparentSelfReference(bioText)) {
      contradictions.push({ field: "biography", rule: `grandparent self-reference at age ${d.age}`, severity: "hard" });
    }
  }

  // (iii) Public vocation vs the cover-story vocation (systemic mismatch). Both non-empty AND sharing no
  // significant word ⇒ the persona claims a different job than the casting sheet (concierge vs bar).
  if (typeof d.vocation === "string" && d.vocation.trim() && typeof d.coverVocation === "string" && d.coverVocation.trim()) {
    const a = significantWords(d.vocation);
    const b = significantWords(d.coverVocation);
    const overlap = [...a].some((w) => b.has(w));
    if (a.size > 0 && b.size > 0 && !overlap) {
      contradictions.push({ field: "vocation", rule: "public vocation disagrees with the cover-story vocation", severity: "hard" });
    }
  }

  // (iv) F5 — NAME vs pinned gender. A SOFT flag only (never fails `ok`): the engine ALLOWS a name to
  // diverge from the gender (a deliberate diversity choice), and the #1140 re-pick already makes names
  // cohere by construction upstream — so a mismatch HERE means that re-pick degraded, worth surfacing to
  // the health rollup, not worth rejecting the dossier. Fires ONLY when the given name reads UNAMBIGUOUSLY
  // as the OPPOSITE BINARY gender ("James" pinned 'woman'); a unisex name and a `nonbinary` pin never
  // trip it, so nonbinary is never flattened and the assertion can't force a re-author.
  if ((gender === "man" || gender === "woman") && typeof d.name === "string" && d.name.trim()) {
    const given = d.name.trim().split(" ")[0]!;
    const opposite = gender === "man" ? "woman" : "man";
    if (nameGenderOf(given) === opposite) {
      contradictions.push({ field: "name", rule: `given name reads as '${opposite}' but genderPresentation is '${gender}'`, severity: "soft" });
    }
  }

  const hard = contradictions.filter((c) => c.severity === "hard");
  return {
    ok: hard.length === 0,
    // Repair every HARD-contradicting field PLUS a nonbinary pin's stray binary self-pronouns (a SOFT signal
    // that never fails `ok` but is still scrubbed to singular they/their).
    repairFields: [...new Set([...hard.map((c) => c.field), ...nonbinaryBinaryFields])],
    contradictions,
  };
}

/** Every gendered self-referential pronoun, so one pass can rewrite them to the pinned gender (F5). */
const SELF_PRONOUN_RE = /\b(he|him|his|himself|she|her|hers|herself)\b/gi;

/** The pronoun a stray token maps to, per pinned gender. A pin only rewrites the OPPOSITE gender's
 * pronouns (a `man` pin leaves masculine pronouns alone); a `nonbinary` pin neutralizes BOTH to
 * singular they/them. Possessive-dominant where a token is ambiguous ("her" → "his"/"their"), which is
 * the overwhelmingly common case in appearance/mark prose ("her hazel eyes", "his left eyebrow"). */
const PRONOUN_TARGET: Readonly<Record<"man" | "woman" | "nonbinary", Readonly<Record<string, string>>>> = {
  man: { she: "he", her: "his", hers: "his", herself: "himself" },
  woman: { he: "she", him: "her", his: "her", himself: "herself" },
  nonbinary: {
    he: "they", him: "them", his: "their", himself: "themself",
    she: "they", her: "their", hers: "theirs", herself: "themself",
  },
};

/**
 * F5 — rewrite a self-referential field's stray pronouns to the pinned gender, PRESERVING the surrounding
 * descriptive detail (so "his left eyebrow" on a woman-pinned houseguest becomes "her left eyebrow", not a
 * blanked field). Case of the first letter is preserved. A token already consistent with the pin is left
 * untouched. Pure; no allocation beyond the rewritten string.
 */
export function scrubSelfReferentialPronouns(text: string, gender: "man" | "woman" | "nonbinary"): string {
  const map = PRONOUN_TARGET[gender];
  return text.replace(SELF_PRONOUN_RE, (m) => {
    const repl = map[m.toLowerCase()];
    if (!repl) return m; // already consistent with the pin — leave it
    return m[0] === m[0]!.toUpperCase() ? repl[0]!.toUpperCase() + repl.slice(1) : repl;
  });
}

/**
 * Apply the coherence repair (§S4b): return a COPY of the dossier repaired against the pinned gender.
 * The portrait-facing DESCRIPTIVE prose (`appearance` and the distinguishing mark) is SCRUBBED — its stray
 * opposite-gender self-pronouns rewritten to the pin (F5) — so the descriptive detail survives coherent
 * into the portrait prompt instead of being blanked; every OTHER contradicting field is CLEARED
 * (`undefined`) for the caller to re-author. The pinned `genderPresentation` spine is NEVER touched (it is
 * authoritative; the prose is what must agree with it). Pure. A dossier with no hard contradiction is
 * returned structurally unchanged.
 */
export function repairDossierCoherence<T extends DossierForCoherence>(d: T): { repaired: T; repairedFields: string[] } {
  const { repairFields } = validateDossierCoherence(d);
  if (repairFields.length === 0) return { repaired: { ...d }, repairedFields: [] };
  const out: Record<string, unknown> = { ...(d as Record<string, unknown>) };
  const gender = d.genderPresentation;
  for (const field of repairFields) {
    // genderPresentation is the spine — never repaired. Nested facet fields (`a.b`) clear the leaf.
    if (field === "genderPresentation") continue;
    // F5 — SCRUB the portrait-facing prose to the pin instead of clearing it (requires a pin to scrub
    // toward; without one, fall through to the clear). `appearance` lives top-level; the mark is labelled
    // "distinguishingMark" by the validator but the value may sit top-level OR inside physicalCharacteristics.
    if (gender && field === "appearance" && typeof out.appearance === "string") {
      out.appearance = scrubSelfReferentialPronouns(out.appearance, gender);
      continue;
    }
    if (gender && field === "distinguishingMark") {
      if (typeof out.distinguishingMark === "string") {
        out.distinguishingMark = scrubSelfReferentialPronouns(out.distinguishingMark, gender);
      }
      const pc = out.physicalCharacteristics;
      if (pc && typeof pc === "object" && typeof (pc as Record<string, unknown>).distinguishingMark === "string") {
        out.physicalCharacteristics = {
          ...(pc as Record<string, unknown>),
          distinguishingMark: scrubSelfReferentialPronouns((pc as Record<string, unknown>).distinguishingMark as string, gender),
        };
      }
      continue;
    }
    // No pin to scrub toward — clear the mark at BOTH locations. The validator labels this field
    // "distinguishingMark" (flat) but the value may live top-level OR under physicalCharacteristics,
    // so the generic top-level clear below would leave the nested facet contradicting the name.
    if (field === "distinguishingMark") {
      out.distinguishingMark = undefined;
      const pc = out.physicalCharacteristics;
      if (pc && typeof pc === "object") {
        out.physicalCharacteristics = { ...(pc as Record<string, unknown>), distinguishingMark: undefined };
      }
      continue;
    }
    if (field.includes(".")) {
      const [root, leaf] = field.split(".") as [string, string];
      const nested = out[root];
      if (nested && typeof nested === "object") {
        out[root] = { ...(nested as Record<string, unknown>), [leaf]: undefined };
      }
    } else {
      out[field] = undefined;
    }
  }
  return { repaired: out as T, repairedFields: repairFields };
}
