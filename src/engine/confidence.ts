/**
 * Feature 0075 — trust-gated confidences (a houseguest opens up to you). The PURE decision core: given
 * already-read, Vault-hidden signals (relationship edges + the goodwill ledger + the sealed secret), it
 * decides WHETHER a houseguest confides, WHICH tier (how much), and whether it is TRUE or a LIE — and
 * produces the text the model is handed to voice. No I/O, no Vault handle: the caller (the adapter) reads
 * the sealed state and records the disclosure via `surfaceInformationTo` (0002). Seeded + deterministic.
 *
 * The Vault Wall is preserved structurally (not by wording): the ENGINE decides + records every
 * disclosure (the model never selects/invents a secret); a `tease`/`partial` tier never returns the full
 * premise; and a LIE is engine-authored from the PUBLIC archetype, so no real secret of anyone crosses.
 */
import type { RandomnessSource } from "../ports/RandomnessSource";
import type { HiddenElement } from "./characterFactory";
import { CONFIDENCE, type DisclosureTier } from "./confidenceConstants";

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** The already-read signals the decision is computed from (the adapter fills these; all Vault-hidden). */
export interface ConfidenceSignals {
  /** npc → player edge (the holder's read of the player). */
  npcTrust: number;
  npcAffinity: number;
  npcThreat: number;
  /** player → npc edge (the engine's computed read; a confidence wants the warmth to run both ways). */
  playerTrust: number;
  playerAffinity: number;
  /** Banked goodwill / owed favor ∈ [0,1] — kept deals, saves, votes, comfort (the reliability ledger). */
  goodwill: number;
  /** The holder's PUBLIC archetype — drives the strategic-lie path (never their hidden state). */
  archetype: string;
}

/**
 * The Vault-hidden motive to disclose ∈ [0,1] — genuine closeness (mutual bond) + banked goodwill. Read
 * ONLY off existing signals; NEVER shown to the player. It decides only whether/how much, never an outcome.
 */
export function disclosureMotive(s: ConfidenceSignals): number {
  const mutualWarmth = (s.npcTrust + s.npcAffinity + s.playerTrust + s.playerAffinity) / 4;
  return clamp01(CONFIDENCE.warmthWeight * mutualWarmth + CONFIDENCE.goodwillWeight * s.goodwill);
}

/**
 * The STRATEGIC motive ∈ [0,1] — the lie path: a houseguest who reads the player as useful-but-threatening
 * (high threat, low warmth) and whose PUBLIC archetype is manipulative may *perform* intimacy. 0 for anyone
 * else, so a warm or non-manipulative houseguest never fabricates.
 */
export function strategicMotive(s: ConfidenceSignals): number {
  if (!CONFIDENCE.manipulativeArchetypes.includes(s.archetype)) return 0;
  const warmth = (s.npcTrust + s.npcAffinity) / 2;
  return clamp01(s.npcThreat * (1 - warmth));
}

/** The tier a motive unlocks (graduated; below `tease` ⇒ no confidence available this scene). */
export function disclosureTier(motive: number): DisclosureTier {
  if (motive >= CONFIDENCE.bands.full) return "full";
  if (motive >= CONFIDENCE.bands.partial) return "partial";
  if (motive >= CONFIDENCE.bands.tease) return "tease";
  return "none";
}

export interface ConfidenceDecision {
  disclosed: boolean;
  tier: DisclosureTier;
  /** false ⇒ a fabricated confidence (a lie). The player surface shows NO truth marker (the human judges). */
  truthful: boolean;
}

/**
 * Decide a confidence from the signals. A lie fires only when the STRATEGIC motive both dominates the
 * genuine one and clears the floor, the season lie budget remains, the tier is substantive (a `tease` lie
 * is pointless), and a seeded roll confirms it. Otherwise a real (graduated) confidence fires when the
 * genuine motive clears `tease`. Below `tease` ⇒ no disclosure (the model plays the deflection).
 */
export function decideConfidence(
  s: ConfidenceSignals,
  rng: RandomnessSource,
  opts: { liesRemaining: number; /** B49: scale on the base lie chance (absent => 1, the old roll). */ lieProbScale?: number },
): ConfidenceDecision {
  const genuine = disclosureMotive(s);
  const strategic = strategicMotive(s);
  const wantsLie = strategic > genuine && strategic >= CONFIDENCE.lieMotiveFloor && opts.liesRemaining > 0;
  const motive = wantsLie ? strategic : genuine;
  const tier = disclosureTier(motive);
  if (tier === "none") return { disclosed: false, tier, truthful: true };
  if (wantsLie && tier !== "tease" && rng.next() < CONFIDENCE.lieProb * (opts.lieProbScale ?? 1)) {
    return { disclosed: true, tier, truthful: false };
  }
  return { disclosed: true, tier, truthful: true };
}

/** A deterministic "blur" of a real secret for the `partial` tier — drops the sharpest specifics (numbers,
 *  anything after a colon/dash/parenthetical) and keeps the first clause, so even `partial` never hands the
 *  model the full earned text. Pure + stable. */
function blur(detail: string): string {
  const firstClause = detail.split(/[.!?:—(]/)[0]!.trim();
  const redacted = firstClause.replace(/\b\d[\d,]*\b/g, "some").replace(/\s+/g, " ").trim();
  // A terse single-clause secret (e.g. a generated one-line motive) has no sharp specifics for the
  // redaction above to drop — it would then be a NO-OP and `partial` would hand over the whole premise.
  // Fall back to keeping only the leading half of the gist, so the partial tier is always STRICTLY less
  // than the full secret while staying grounded in its opening — the partial tier must withhold for every
  // secret shape, not only structured ones.
  const normalized = detail.replace(/\s+/g, " ").trim();
  if (redacted === normalized) {
    const words = redacted.split(" ");
    if (words.length > 3) return words.slice(0, Math.ceil(words.length / 2)).join(" ");
  }
  return redacted;
}

/**
 * The text the model is handed to VOICE a TRUE confidence at the given tier:
 *   • `tease`   → a class gloss (no real detail crosses);
 *   • `partial` → a specifics-blurred gist of the real secret;
 *   • `full`    → the secret verbatim (only this tier crosses the whole thing — it was earned).
 * `none` never reaches here (the caller short-circuits on `disclosed: false`).
 */
/** The hidden-element kinds a confidence can be ABOUT (0091 — a `trigger` erupts, it is never confided). */
type ConfidableKind = keyof typeof CONFIDENCE.teaseGloss;
const isConfidableKind = (k: HiddenElement["kind"]): k is ConfidableKind => k !== "trigger";

export function discloseTrue(secret: HiddenElement, tier: DisclosureTier): string {
  switch (tier) {
    case "full": return secret.detail;
    case "partial": return blur(secret.detail);
    // 0091 — a trigger is never confided (`headlineSecretOf` excludes it), so this is always a confidable
    // kind in practice; the guard keeps the index total and never leaks a sealed trigger gloss.
    case "tease": return isConfidableKind(secret.kind) ? CONFIDENCE.teaseGloss[secret.kind] : "";
    default: return "";
  }
}

/**
 * Fabricate a FALSE admission — engine-authored from a PUBLIC kind-shaped pool, NEVER a real secret of any
 * houseguest (a lie is not a leak). Seeded pick. `prefer` biases the fabricated kind toward the holder's
 * own secret kind so the lie is plausibly "about" the same thing, but the TEXT is always generic/false.
 */
export function fabricate(rng: RandomnessSource, prefer?: HiddenElement["kind"]): string {
  const kinds = Object.keys(CONFIDENCE.fabrications) as ConfidableKind[];
  const wanted = prefer && isConfidableKind(prefer) ? prefer : undefined; // 0091 — never a trigger
  const kind = wanted ?? kinds[rng.int(kinds.length)]!;
  const pool = CONFIDENCE.fabrications[kind];
  return pool[rng.int(pool.length)]!;
}
