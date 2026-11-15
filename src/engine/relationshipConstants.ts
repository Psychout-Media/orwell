import { clamp01 } from "../domain/num";
/**
 * Relationship math — the SINGLE tunable constants module (feature 0026).
 *
 * 0017 fixed *what* a relationship edge is (directed, graded, asymmetric signals,
 * organic labels). This fixes *how the numbers move*: per-interaction impacts,
 * betrayal-shock, decay/mean-reversion, confidence growth, and the disposition ×
 * temperature modulation that makes each game's feel emergent. **Every number the
 * update rule uses lives here** — retune the feel (or wire a future God-Mode knob,
 * 0016) without touching the logic. The shape is fixed; the numbers are config.
 *
 * Default feel: **realistic & competitive (sticky)** — a blindside lands hard and
 * lingers; trust accrues slowly. A *clash* (paranoid/villain) holder trends
 * stickier still; a *bond* (loyalist/social) holder forgives faster. The player
 * never sees any of these numbers (0020).
 */

/** Directed, graded, asymmetric relationship signals (0017 + audit E54). */
export interface EdgeSignals {
  trust: number;
  affinity: number;
  threat: number;
  alignment: number;
  confidence: number;
  /**
   * ADR 0002's EVIDENCE signal (audit E54): demonstrated loyalty — fed only by *binding acts*
   * (honored deals, protective votes, a veto save), torn down by betrayal. Unlike `trust`
   * (sentiment), reliability moves un-jittered and never decays on neglect: proof stands until
   * contradicted. Consumed by `bondStrength` (Houseguest's Choice, alliances, NPC motivation).
   */
  reliability: number;
}

export type InteractionType =
  | "alliance"
  | "gossip"
  | "conflict"
  | "bonding"
  | "strategy"
  | "showmance"
  | "betrayal";

/** How a holder frames relationships — drives sticky↔forgiving dynamics + on-the-spot labels. */
export type RelationshipDisposition = "clash" | "bond" | "neutral";

export interface DispositionProfile {
  /** Scales ADVERSE moves (trust/affinity down, threat up) — clash lands them harder. */
  adverseScale: number;
  /** Scales BONDING moves (trust/affinity/alignment up) — bond builds them faster. */
  bondScale: number;
  /** Scales mean-reversion in decay — clash barely fades (sticky), bond fades fast (forgiving). */
  decayScale: number;
}

export interface RelationshipConstants {
  baseline: EdgeSignals;
  IMPACT: Record<InteractionType, Partial<EdgeSignals>>;
  /** The large single-step adverse move of a witnessed betrayal (the sticky core). */
  BETRAYAL_SHOCK: Partial<EdgeSignals>;
  /** Slow ordinary drift toward baseline when an edge is untended. */
  DECAY_RATE: number;
  /** <1 ⇒ wariness (threat) reverts slower than warmth — a blindside outlasts a cold shoulder (§6). */
  THREAT_DECAY_FACTOR: number;
  /** Each interaction firms the read by this much. */
  CONFIDENCE_STEP: number;
  /** Bounded per-moment variance band (jitter ∈ [1−J/2, 1+J/2]); the temperature seam (0006). */
  TEMPERATURE_JITTER: number;
  /** How hard `reliability` (evidence, E54) weighs into `bondStrength` beside trust+affinity sentiment. */
  RELIABILITY_WEIGHT: number;
  dispositionFactors: Record<RelationshipDisposition, DispositionProfile>;
  thresholds: {
    alliance: number; ally: number; enemy: number; knowledge: number;
    /** An NPC veto holder saves a nominee they trust above this (B59 — one number, three call sites). */
    vetoSave: number;
  };
  /**
   * Move-in first impressions (B55/audit C5+C6): day-one reads start NEAR BASELINE (not uniform
   * noise), the threat read leans on the PUBLIC archetype's competitive menace, and confidence
   * starts BELOW `thresholds.knowledge` — a move-in read is a HUNCH, never day-one knowledge.
   */
  MOVE_IN: { confidence: number; spread: number; threatWeight: number };
  /**
   * The BYSTANDER observation fold (audit 2026-06-18, owner ruling). A houseguest who merely
   * WITNESSED a scene they were not part of must move by THEIR OWN beliefs — never the partner's
   * full bond, and never a uniform group step. Their edge toward the actor shifts a small amount,
   * SIGNED by structural balance (how they feel about who the actor engaged) and shaded by their
   * existing suspicion of the actor. A neutral bystander barely moves; one who dislikes the partner
   * cools/worries; one who already distrusts the actor reads warmth as scheming (threat ▲). A
   * witnessed BETRAYAL is the "universally human" exception — it chills the room more directly.
   */
  OBSERVATION: {
    /** Overall fraction of a direct fold a bystander can feel (keeps observation small). */
    scale: number;
    /** Reference magnitudes the structural-balance tilt scales (affinity/trust/threat). */
    refAffinity: number; refTrust: number; refThreat: number;
    /** How hard an already-wary bystander reads a warm scene as a developing threat. */
    suspicionWeight: number;
    /** Interaction kinds that move bystanders directly (a witnessed shock) — the human exception. */
    universal: InteractionType[];
  };
  /**
   * Phase 3 of "the player can play offense" (audit finding SG-2, the closed-set relationship
   * layer). Every `kind` fold above moves ONLY a partner's opinion OF the initiator — the
   * initiator's OWN edge toward the people they just engaged never budges. That is the right
   * shape for the off-screen society (a bystander's belief moving is enough), but on the PLAYER
   * channel it left `player→NPC` frozen at its move-in scatter forever, under every mutual-bond
   * gate (`formAlliance`/`joinAlliance` 0107, blocs 0043). ADR 0002 holds the engine computes BOTH
   * directions from history (never a number the player sees), so a PLAYER-initiated
   * `recordInteraction` also reciprocates this FRACTION of the same engine-owned `kind` impact
   * onto `player→partner`. Kept < 1 so the player's own read firms up more slowly than a
   * houseguest's memorable read of the player (0 would be the pre-Phase-3 freeze).
   */
  RECIPROCAL_SHARE: number;
}

// Betrayal-shock: a LARGE single step — the competitive, realistic core, and the single biggest
// lever on "feel." Named so it is the one knob to turn (referenced by IMPACT.betrayal below).
// Proven disloyalty also tears down the EVIDENCE signal (E54) — harder than sentiment falls.
const BETRAYAL_SHOCK: Partial<EdgeSignals> = { trust: -0.32, affinity: -0.28, threat: +0.32, reliability: -0.3 };

export const RELATIONSHIP_CONSTANTS: RelationshipConstants = {
  baseline: { trust: 0.25, affinity: 0.25, threat: 0.1, alignment: 0.2, confidence: 0, reliability: 0.3 },
  IMPACT: {
    bonding: { affinity: +0.15, trust: +0.1 },
    strategy: { trust: +0.12, affinity: +0.06, alignment: +0.12 },
    alliance: { trust: +0.16, affinity: +0.14, alignment: +0.15 },
    showmance: { affinity: +0.2, trust: +0.12 },
    gossip: { trust: +0.05, alignment: +0.04 },
    conflict: { affinity: -0.16, trust: -0.13, threat: +0.16 },
    betrayal: BETRAYAL_SHOCK,
  },
  BETRAYAL_SHOCK,
  DECAY_RATE: 0.05, // slow — grudges and bonds persist when untended (sticky default)
  THREAT_DECAY_FACTOR: 0.6, // threat lingers longer than warmth
  CONFIDENCE_STEP: 0.05,
  TEMPERATURE_JITTER: 0.4, // jitter ∈ [0.8, 1.2]
  RELIABILITY_WEIGHT: 0.25, // evidence (E54) shades — never replaces — the sentiment bond read
  dispositionFactors: {
    clash: { adverseScale: 1.5, bondScale: 0.85, decayScale: 0.5 }, // paranoid / villain — sticky
    bond: { adverseScale: 0.7, bondScale: 1.2, decayScale: 1.7 }, // loyalist / social — forgiving
    neutral: { adverseScale: 1.0, bondScale: 1.0, decayScale: 1.0 },
  },
  thresholds: { alliance: 0.5, ally: 0.35, enemy: 0.3, knowledge: 0.3, vetoSave: 0.6 },
  MOVE_IN: { confidence: 0.15, spread: 0.15, threatWeight: 0.35 },
  // Bystanders feel ~half a reference move at most, signed by their own beliefs — so a witnessed
  // bond never bonds the room, and the spread across witnesses is wide (some up, some down, most ~0).
  OBSERVATION: {
    scale: 0.5,
    refAffinity: 0.12, refTrust: 0.06, refThreat: 0.1,
    suspicionWeight: 0.6,
    universal: ["betrayal"],
  },
  RECIPROCAL_SHARE: 0.5,
};

// PERSIST-2/BE-101: `Math.min`/`Math.max` pass NaN straight through (`Math.min(1, NaN)` is `NaN`, and
// `NaN < 0` / `NaN > 1` are both false) — a NaN produced upstream (a divide-by-zero, an undefined
// signal) would otherwise clamp to NaN and get written into the PERMANENT relationship/soul layer,
// corrupting non-degradation (I5) forever. Guard NaN → 0 (a neutral-safe default); every finite input
// (in range or out) clamps EXACTLY as before — only the NaN path changes.
export { clamp01 }; // B47: the one implementation (NaN-guarded, above) now lives in src/domain/num.ts; re-exported so every existing import keeps working

/** Scale every component of a named impact (manner-scaled folds E48, confidence-scaled gossip E44). */
export function scaleImpact(impact: Partial<EdgeSignals>, factor: number): Partial<EdgeSignals> {
  const out: Partial<EdgeSignals> = {};
  for (const [k, v] of Object.entries(impact)) out[k as keyof EdgeSignals] = (v as number) * factor;
  return out;
}

/**
 * #1419 — scale a fold ASYMMETRICALLY by each component's VALENCE. A WARMING component (trust/affinity/
 * alignment UP, or threat DOWN) is scaled by `warmScale`; a SOURING component (the opposite sign) by
 * `soreScale`. Used by the social-fatigue model so a tired houseguest is worse at charm (`warmScale` < 1)
 * while their barbs cut deeper (`soreScale` ≥ 1) — "harder to scheme when you aren't sleeping." With
 * `warmScale === soreScale === 1` it is byte-identical to the unscaled fold (the flag-off / rested path).
 */
export function scaleImpactByValence(
  impact: Partial<EdgeSignals>, warmScale: number, soreScale: number,
): Partial<EdgeSignals> {
  const out: Partial<EdgeSignals> = {};
  for (const [k, v] of Object.entries(impact)) {
    const val = v as number;
    // Warming = the houseguest feels BETTER about the initiator: trust/affinity/alignment rise, or threat
    // falls. Threat is the one inverted axis (a positive threat delta is a SOURING move).
    const warming = k === "threat" ? val < 0 : val > 0;
    out[k as keyof EdgeSignals] = val * (warming ? warmScale : soreScale);
  }
  return out;
}

/**
 * The FRIENDLY natures (feature 0078 Phase 2) — downtime social warmth, NOT game talk: a pair just
 * hanging out or growing close. A house isn't always plotting, so these are the DEFAULT texture of
 * ordinary life. Everything else (alliance / strategy / conflict / betrayal / gossip) is a GAME nature.
 */
export const FRIENDLY_NATURES: ReadonlySet<InteractionType> = new Set<InteractionType>(["bonding", "showmance"]);

/**
 * The relationship fold an off-screen scene of the given nature takes (feature 0078 Phase 2 — "co-presence
 * is not game talk; motivation sets the nature"). A GAME nature folds its full strategic `IMPACT`
 * (trust / threat / alignment that feed the vote math) — BYTE-IDENTICAL to the pre-0078 society, so the
 * calibration spine is untouched there. A FRIENDLY nature warms the bond — AFFINITY ONLY — and folds NO
 * strategic weight (owner ruling: friendly conversation builds the relationship without scheming, no
 * vote-affecting change). Pure, draws no rng; the caller's fold takes the same four jitter draws either
 * way (`applyOneDirection`), so swapping a game fold for the friendly one is draw-count-stable — only the
 * friendly magnitudes shift, which the 0078 Phase-2 calibration pass re-verifies.
 */
export function natureFoldImpact(type: InteractionType): Partial<EdgeSignals> {
  const base = RELATIONSHIP_CONSTANTS.IMPACT[type];
  // A game scene folds the strategic weights, unchanged (same object ref ⇒ byte-identical). A friendly
  // scene warms the bond ONLY — its affinity projection. (A friendly nature without an affinity impact
  // would yield `{ affinity: undefined }`, which `applyOneDirection` reads as `?? 0` — i.e. no move —
  // exactly as an empty fold; both friendly natures carry affinity today, so no empty-fold case arises.)
  return FRIENDLY_NATURES.has(type) ? { affinity: base.affinity } : base;
}

/**
 * The hidden relationship consequence of each ceremony act (feature B38 / audit C1, reworked by
 * audit E47/E48). The weekly loop's most consequential moves — nominations, veto saves,
 * replacements, evictions, comp wins — must move trust/affinity/threat, not just be read. Each act
 * maps to a NAMED impact whose magnitudes live HERE (shared with `IMPACT` where the act genuinely
 * is that interaction); the fold still runs through the proven update rule (disposition scaling,
 * decay, confidence, temperature jitter). Applied engine-side in the commit path; the player never
 * sees a number (0001).
 *
 *   nominated   nominee → HOH        adverse (threat▲ trust▼)      — "you put me up"
 *   veto-saved  saved   → holder     a real bond + EVIDENCE (E54)  — "you saved me"
 *   replaced    replacement → HOH    betrayal-shock if trusted     — "you used the veto to get ME"
 *   evicted     evictee → HOH+voters betrayal-shock × MANNER (E48) — "you sent me out"
 *   comp-won    everyone → winner    threat▲ ONLY (E47)            — "they're dangerous now"
 *
 * E47: a comp win is a THREAT read, not a grievance — the house does not stop *liking* its own
 * winner; allies stay warm while everyone recalibrates the danger.
 */
export type CeremonyAct = "nominated" | "veto-saved" | "replaced" | "evicted" | "comp-won" | "self-evicted";

/**
 * A comp win moves only the danger read (E47) — no affinity/trust souring from a clean victory.
 * RETUNED 0.2 -> 0.3 (2026-11-03, PO tuning order step 3 "comp wins raise threat more"; #1953): on the default profile a SOLID
 * player reached Final 2 in 29% of 300 seasons (target 12-20%). At 0.3 the same arm reaches it ~20% (20.7% on seeds 1-300, 20.0% on
 * independent seeds 301-600) with passive (~11% F2 / ~3% win) and reckless (~3% F2 / ~1% win) unmoved. The knee is at 0.3: solid reach
 * is flat for 0.3-0.4 while win-given-F2 keeps falling, so 0.3 is the gentlest value that lands reach in band. The constant is a pure threat-only impact (no rng of its own); the shared ceremony fold still applies its seeded temperature jitter to it.
 * RETUNED 0.3 -> 0.45 (2026-11-13, ORW-19; the bands in tests/calibration/poTargetBands.ts unchanged). The real PO gate on main after #2574 (the sleep curve), seeds 1-300, reach F2 / win:
 * threat 0.3 -> passive 9.3% / 4.7%, SOLID 31.3% / 14.7% (outside 12-20%, so the gate FAILED), reckless 5.7% / 3.7%;
 * threat 0.45 -> passive 6.3% / 2.0%, solid 20.0% / 9.3%, reckless 5.7% / 3.3% (every band holds, the aggregate gate passes).
 * Why 0.45 and not 0.5 / 0.6: the passive "earned wins" jury guard (a crowned passive player needs >= 2 public comp wins, a 20-seed check any trajectory shift can trip) tripped at 0.5 and 0.6
 * (seeds 15 / 10 landed on 1 comp win) while 0.35, 0.4, 0.45, 0.55, 0.65 and 0.7 held it. Before #2574 the same lever measured, on 900 solid seeds, 0.3 -> ~22.6% / ~11.1% and 0.45 -> 20.7% / 9.9%.
 */
const COMP_WON_IMPACT: Partial<EdgeSignals> = { threat: +0.45 };

/** A veto save is alliance-grade warmth PLUS demonstrated protection — the E54 evidence signal. */
const VETO_SAVED_IMPACT: Partial<EdgeSignals> = { trust: +0.16, affinity: +0.14, alignment: +0.15, reliability: +0.15 };

/**
 * How the PRESENT HOUSE reads a houseguest who VOLUNTARILY walks out (0061): a rival removed
 * themselves, so the danger read drops (threat▼) and warmth/reliability dip a little — they quit on
 * the house, which a competitor weighs (a quitter is not someone you'd have leaned on). A modest,
 * signed move, never a betrayal-grade shock. The leaver's own edges don't matter — they're gone.
 */
const SELF_EVICTED_IMPACT: Partial<EdgeSignals> = { threat: -0.12, affinity: -0.06, reliability: -0.1 };

export const CEREMONY_IMPACTS: Record<CeremonyAct, Partial<EdgeSignals>> = {
  nominated: { affinity: -0.16, trust: -0.13, threat: +0.16 }, // = IMPACT.conflict
  "veto-saved": VETO_SAVED_IMPACT,
  replaced: BETRAYAL_SHOCK,
  evicted: BETRAYAL_SHOCK, // base magnitude; the live fold scales it by the recorded MANNER (E48)
  "comp-won": COMP_WON_IMPACT,
  "self-evicted": SELF_EVICTED_IMPACT, // 0061: the present house's read of a voluntary walk-out
};

/**
 * How the eviction fold scales by the evictee's RECORDED manner (audit E48): a betrayal lands the
 * full shock; a blindside most of it; a "respected" eviction — a clean, expected move from a known
 * rival — leaves a fraction of the resentment, not a feud. `disrespected` (a cold goodbye) sits
 * between. Engine-only; agrees with the jury manner read the finale already weighs (0037).
 */
export const EVICTION_MANNER_SCALE = {
  betrayed: 1.0,
  blindsided: 0.8,
  disrespected: 0.6,
  respected: 0.25,
} as const;

/**
 * The generative-consequence path (ADR 0005 — "split authority by openness"). The LLM may PROPOSE a
 * per-edge consequence SHAPE — which directed signal moves, in which direction — but NEVER the amount.
 * These are the engine's OWN base magnitudes (one knob per signal-direction); the caller's `emphasis`
 * only picks a BOUNDED, CLAMPED multiplier (`CONSEQUENCE_EMPHASIS` below) of one of them. So widening
 * what the LLM may propose (open-set interpretation) never widens what it may magnitude (closed-set,
 * engine-owned — anti-sycophancy #3): a proposal can never pump an edge to flatter the player.
 *
 * Each direction names a member of the closed `EdgeSignals` space and its sign. `warmer`/`cooler`
 * move the affinity bond (with a small trust co-move, the shape `IMPACT.bonding`/`conflict` use);
 * the rest move one signal. Magnitudes sit in the same band as `IMPACT` (≈ a `notable` social beat),
 * so the generative path and the 7-way floor land in the same range — no back-door amplification.
 * `reliability` is intentionally NOT addressable here: it is evidence (E54), not a proposable vibe.
 */
export type ConsequenceDirection =
  | "warmer" | "cooler"
  | "more-trust" | "less-trust"
  | "more-threatened" | "less-threatened"
  | "more-aligned" | "less-aligned";

export const CONSEQUENCE_DIRECTION_IMPACTS: Record<ConsequenceDirection, Partial<EdgeSignals>> = {
  warmer: { affinity: +0.15, trust: +0.06 },
  cooler: { affinity: -0.15, trust: -0.06 },
  "more-trust": { trust: +0.12 },
  "less-trust": { trust: -0.12 },
  "more-threatened": { threat: +0.16 },
  "less-threatened": { threat: -0.12 },
  "more-aligned": { alignment: +0.14 },
  "less-aligned": { alignment: -0.14 },
};

/**
 * Emphasis → a BOUNDED, CLAMPED multiplier on the engine's OWN base (above). RELATIVE weight only:
 * the caller says "this mattered more/less," the engine decides how much that is. The band is tight
 * (≤ `strong`) so emphasis can never inflate a fold past the betrayal-shock range — the closed set
 * keeps authority over the amount (ADR 0005 / mandate #3).
 */
export const CONSEQUENCE_EMPHASIS: Record<"slight" | "notable" | "strong", number> = {
  slight: 0.6,
  notable: 1.0,
  strong: 1.4,
};

/**
 * THIRD-PARTY pitch constants (Phase 1 of "the player can play offense" — layered on ADR 0005). A
 * `holder`'s hidden opinion of an `about` third party can be moved by a scene the player pitches
 * them — the classic "I told Lorenzo that Maeve is the real threat." The engine still owns the
 * amount (anti-sycophancy #3): the trust gate mirrors the PROVEN shape `campaignTilt` already uses
 * (`src/engine/campaigns.ts`) — a `trustFloor` so even a lightly-trusted pitch lands a LITTLE, scaled
 * up toward 1 as `holder` trusts the initiator more — and the pitch can BACKFIRE (I2/anti-sycophancy:
 * a social move must be able to fail, never auto-succeed) when `holder` doesn't trust the initiator
 * AND already has a STRONGER bond with the very person being pitched against: the pitch reads as
 * transparent manipulation and lands a small, bounded hit on holder→initiator instead of moving
 * holder→about at all.
 */
export const THIRD_PARTY_CONSEQUENCE = {
  /** Mirrors `CAMPAIGN.trustFloor` (0085) — even a barely-trusted pitch lands a little. */
  trustFloor: 0.4,
  backfire: {
    /** Below this trust in the initiator, a pitch is AT RISK of reading as manipulative. */
    trustCeiling: 0.35,
    /** Chance (per roll, only drawn when the risk gate above is open) the pitch actually backfires. */
    chance: 0.35,
    /** The bounded fold on holder→initiator when a pitch backfires — "that felt like being worked." */
    impact: { trust: -0.08, affinity: -0.05, threat: +0.06 } as Partial<EdgeSignals>,
  },
} as const;

/**
 * Deal consequences (0039 + audit E43/E54): HONORING a promise is a real, bounded positive fold —
 * the protected party registers the kept word (trust/alignment up, plus the evidence signal).
 * Applied once per honoring binding action by `DealLedger.reconcile`; breaking already lands
 * `BETRAYAL_SHOCK` above. Magnitudes live here only (the B59 grep gate).
 */
export const DEAL_IMPACTS = {
  honored: { trust: +0.06, affinity: +0.03, alignment: +0.04, reliability: +0.1 } as Partial<EdgeSignals>,
} as const;

/**
 * ORW-269 (Ryne 2026-11-11) - visible comp EFFORT. The result still dominates a comp-throw deal (win = broken, lose = kept); on top, a promisor who was SEEN fighting hard on most rounds they were in draws
 * a SUSPICION fold even though they lost - deliberately a fraction of `BETRAYAL_SHOCK`. Effort is a presentation-side observable (what a witness could see per round), drawn on its OWN seeded side stream,
 * played games only; it never changes who wins. All magnitudes here (the B59 grep gate).
 */
export const COMP_EFFORT = {
  /** Share of a competitor's rounds seen at all-out effort at/above which they "visibly fought hard". */
  hardShare: 0.5,
  /** Base chance an NPC is seen all-out in a round; steady/light split the rest. */
  baseHardChance: 0.35,
  steadyChance: 0.4,
  /** A promisor who swore to throw fights hard more readily the weaker their bond to the promisee (chance = floor + span * (1 - bond)). */
  promisorHardFloor: 0.2,
  promisorHardSpan: 0.6,
  /** The suspicion fold on promisee->promisor: a small fraction of BETRAYAL_SHOCK (trust -0.32, reliability -0.3). */
  suspicion: { trust: -0.06, reliability: -0.05 } as Partial<EdgeSignals>,
} as const;

/**
 * 0121 — the LOYALTY-STREAK reward (deal-depth layer, `ORWELL_DEAL_DEPTH`). Consecutive kept deals with the
 * SAME partner compound the honored fold: a "we've never broken faith" bond builds faster the longer you
 * both hold the line. The multiplier is BOUNDED (never a runaway) and the WHOLE reward is off unless the
 * deal-depth flag is on (off ⇒ the plain `DEAL_IMPACTS.honored`, byte-identical). A break resets the streak.
 */
export const DEAL_STREAK = {
  step: 0.25,    // each consecutive kept deal adds this much to the honored-fold multiplier
  maxMult: 2.0,  // capped — the reward compounds but never dominates
} as const;

/**
 * Deal-DURATION betrayal scaling (feature 0109 — the single tunable home for "when do you turn?").
 * A break's seeded betrayal-shock (BETRAYAL_SHOCK, applied by `DealLedger.applyBreak`) is multiplied
 * by a bounded scale derived from how much NEGOTIATED life the deal had left — NEVER inlined at the
 * call site (the B59 grep gate). Closed-set, engine-owned (mandate #3 / ADR 0005): the model proposes
 * the open-set "how long" prose; these numbers are the engine's alone, so a proposal can never pump
 * the size of a betrayal. The Vault Wall holds: the scale is a hidden magnitude, never crossed to the
 * player or admin (the `expiresWeek` the player negotiated is a TERM, not this derived factor).
 *
 *   • `perWeekRemaining` — each whole week of remaining explicit term ADDS this much to the scale,
 *     so stabbing a freshly-renewed (many-weeks-left) ally hurts more than one about to lapse.
 *   • `maxScale` — the cap: remaining-life can amplify the shock at most this far (a bound, never a
 *     runaway). 1 + perWeekRemaining·weeksLeft, clamped to this.
 *   • `vagueSoften` — a `vague` (unspoken-term) deal's break folds a SOFTER shock by this factor
 *     (< 1): built-in ambiguity discounts the betrayal — no clean named term was violated.
 *
 * Identity floor: a no-duration / no-label break scales by 1.0 (`breakSeverityScale` returns 1),
 * so the pre-0109 fold is byte-identical (the calibration-neutrality proof).
 */
export const DEAL_DURATION = {
  perWeekRemaining: 0.2,
  maxScale: 1.6,
  vagueSoften: 0.6,
  /** #1802 — per-witness additive scale for the formation trust-fold: each co-present witness
   *  adds this much to the multiplier (1 + perWitness * audienceSize), capped at maxScale. */
  perWitness: 0.08,
  /** 0109 / #1993 — the longest negotiated term (in weeks) the engine accepts from a proposed `term.weeks`;
   *  a longer proposal is clamped to this (a bound, so a narrator can never mint an unbounded horizon). */
  maxTermWeeks: 12,
} as const;

/**
 * 0121 R1 — the explicit "keeps their word" deal-willingness lean (deal-depth layer, `ORWELL_DEAL_DEPTH`).
 * A kept deal diffuses a hidden `reliable:<honorer>` belief NPC→NPC (0038 gossip); a houseguest who HOLDS it
 * reads the honorer as a more-appealing partner. `dealLean` is the bounded, positive nudge added to the NPC
 * deal-formation WILLINGNESS read (`GameSessionAdapter.mintNpcDeal`) when a candidate credits the other as
 * reliable — a HIDDEN magnitude (mandate #2/#3): the player never sees a number, only that reliable players
 * get offered deals. This is the deal consequence (distinct from the affinity-only social whisper in
 * `GOSSIP_HEARD.reliable`, so the two never double-count). The KIND of pact stays keyed to the BARE mutual
 * trust — reputation buys the OPPORTUNITY, not a bigger promise. Off unless the deal-depth flag is on ⇒ no
 * lean ⇒ byte-identical.
 */
export const DEAL_REPUTATION = {
  dealLean: 0.12,
} as const;

/**
 * Feature 0088 — a derived carriage word from the live NPC→player edge.
 * A sibling of `relationshipLabel`, oriented at the player and delta-aware
 * (drift = warming / cooling / steady since a per-week anchor). Pure read,
 * no rng, never a stored label. Vault-safe: a word only, never a number.
 */
export const CURRENT_READ = {
  /** Bond thresholds for carriage words (bond = (trust + affinity) / 2). */
  toward: {
    warm: 0.6,      // ≥ warm  → "warm and open"
    friendly: 0.45, // ≥ friendly → "friendly"
    neutral: 0.3,   // ≥ neutral → "neutral"
    guarded: 0.15,  // ≥ guarded → "guarded"
    // else → "wary"
  } as const,
  /** How big a bond move counts as warming/cooling vs. steady. */
  driftEpsilon: 0.08,
  words: {
    warm: "warm and open",
    friendly: "friendly",
    neutral: "neutral",
    guarded: "guarded",
    wary: "wary",
  } as const,
} as const;
