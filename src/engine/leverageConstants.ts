/**
 * Features 0093 + 0099 — secrets as power (leverage / expose / trade + deception). The SINGLE tunable
 * module (sibling to `confidenceConstants.ts` `CONFIDENCE`, `relationshipConstants.ts`, `gossip.ts`'s
 * `GOSSIP`, `threadConstants.ts` `THREAD`). Every magnitude the leverage/expose/trade decision core
 * reads lives HERE — no magic number at a call site (the B59 grep gate covers this file like its siblings).
 *
 * All terms are BOUNDED and FELT-BUT-RECOVERABLE (owner ruling 2026-06-27 / PO-DECISIONS-LOG): a held
 * secret is *pressure / incentive*, never a deterministic "I win" button. The engine owns every
 * magnitude (anti-sycophancy #3, ADR 0005 — the model proposes only WHICH secret / target / prose); no
 * number ever crosses to the player OR admin. With no lever invoked, every fold is byte-identical (the
 * calibration spine is untouched — `tests/unit/secretPowerNeutral.test.ts` is the gate).
 */
import type { HiddenElementKind } from "./characterFactory";
import type { EdgeSignals } from "./relationshipConstants";

/**
 * The PUBLIC severity weight of a secret by its `kind` ∈ [0,1] — sibling to 0075's `teaseGloss`: it
 * reads ONLY the public class of the hidden element, NEVER its text (no Vault content informs the
 * weight). A `divergent-persona` (the mask slipping) or a `secret-motive` (a hidden agenda) lands
 * harder than a `pre-game-tie` or a `concealed-aptitude`. A `trigger` is never a usable secret (it
 * erupts, it is never learned/confided — `headlineSecretOf` excludes it), so it carries no weight.
 */
export const LEVERAGE = {
  /** Severity by public kind (never the sealed text). The floor every lever's strength scales from. */
  severityByKind: {
    "secret-motive": 0.85,
    "divergent-persona": 0.8,
    "pre-game-tie": 0.6,
    "concealed-aptitude": 0.5,
  } as Record<Exclude<HiddenElementKind, "trigger">, number>,
  /** Severity for a learned fact whose kind the lever can't resolve (a surfaced rumor with no class). */
  defaultSeverity: 0.55,

  // ── leverageStrength ∈ [0,1] — pressure on the SUBJECT (0093) ─────────────────────────────────────
  // Derived from already-read signals: the secret's severity, the subject's vulnerability (how rattled /
  // how much they'd lose), and the subject's read of the player (a houseguest who distrusts the player
  // resists pressure — high threat, low warmth ⇒ they call the bluff). NEVER deterministic.
  /** Weight on the secret's public severity. */
  severityWeight: 0.5,
  /** Weight on the subject's vulnerability (1 − soul emotionalState: a rattled houseguest folds easier). */
  vulnerabilityWeight: 0.3,
  /** Weight on the subject's RECEPTIVENESS to pressure (their warmth toward the player minus their wariness). */
  receptivenessWeight: 0.2,
  /** A bounded per-moment jitter band (±) so a near-tie wobbles but a clear read does not flip (temperature). */
  jitter: 0.15,

  // ── the leverage → deal factor: how much a strength colors makeDeal formation likelihood ─────────
  // The CAP is the ceiling the owner ruled "real but recoverable": leverage is a NUDGE, not a guaranteed
  // yes. A houseguest reading the player as a high threat with low warmth can refuse outright (below).
  /** Max additive boost to the deal-acceptance read a full-strength leverage can apply (bounded). */
  dealFactorCap: 0.45,
  /** Below this acceptance read AFTER leverage, a wary houseguest refuses the deal and resents the squeeze. */
  refusalFloor: 0.3,
  /** The bounded read of "will this houseguest take the deal" from their warmth toward the player (pre-leverage). */
  baseAcceptanceFromWarmth: 0.6,

  // ── the squeeze backlash (0093) — pressing a secret on someone is itself read as ruthless ─────────
  // When leverage is PRESSED but refused (a wary subject), the subject's hidden read of the player sours
  // a bounded amount — never a betrayal-grade shock for a mere squeeze. Reuses 0026 `IMPACT.conflict`'s
  // shape via a named, scaled impact (no inline numbers).
  squeezeBacklash: { trust: -0.08, affinity: -0.06, threat: +0.1 } as Partial<EdgeSignals>,

  // ── exposeOutcome (0093) — outing a learned secret to the house ──────────────────────────────────
  // A REAL but RECOVERABLE hit (owner R1). The SUBJECT takes a bounded standing drop (the house reads
  // them as more of a liability — threat ▲ via the house's reads, warmth ▼), and the EXPOSER takes a
  // betrayal-grade hit FROM the subject (outing a secret is a deep betrayal) plus a smaller, signed
  // backlash from the rest of the house (outing is read as ruthless). Magnitudes are seeded within bands.
  /** The bounded fold applied to EACH other houseguest's read of the exposed subject (the standing hit). */
  exposeSubjectHit: { affinity: -0.1, trust: -0.08, threat: +0.12 } as Partial<EdgeSignals>,
  /** Seeded scale band the subject-hit varies within [min,max] (felt, never fixed; recoverable). */
  exposeSubjectHitBand: { min: 0.6, max: 1.0 },
  /** Severity shades the subject-hit: the scaling spans [severityShadeFloor, 1] × the band scale (a sharper
   *  secret cuts deeper; a dull one still lands at the floor). 0.5 ⇒ a dull secret hits at half a sharp one. */
  severityShadeFloor: 0.5,
  /** The exposer takes a betrayal-grade hit FROM the subject (the deepest wound — `IMPACT.betrayal`-shaped). */
  exposerBacklashFromSubject: { trust: -0.3, affinity: -0.26, threat: +0.3 } as Partial<EdgeSignals>,
  /** A smaller signed recoil from the rest of the house toward the exposer (ruthlessness read). */
  exposerBacklashFromHouse: { affinity: -0.06, threat: +0.08 } as Partial<EdgeSignals>,
  /** Whether an expose lays a jury-management mark on the subject's eventual jurors (a real but bounded demerit). */
  exposeLaysJuryMark: true,
  /** HARD per-season cap on exposes (rare, like 0075's `maxLiesPerSeason` — a season of outings is noise). */
  maxExposesPerSeason: 3,

  // ── deception (owner direction 2026-06-27) — any use may be truthful or a BLUFF ──────────────────
  // A bluff INVENTS a claim and reads NOTHING from the Vault; the engine NEVER tells the player whether
  // a bluff happened to match a real truth. It folds on BELIEF, weighted by the target's trust in the
  // player × plausibility (0094). A later contradicting pathway catches the bluffer out (the passive
  // lie-catch, pulled in from 0075) at the SAME cost any caught liar pays (ORW-616: `payForCaughtLie`).
  /** A bluff is believed when (trustInSource × plausibility) clears this floor (else it bounces — no effect). */
  bluffBeliefFloor: 0.35,
  /** Plausibility weight on the target's own threat read of the named subject (a claim about a rival they fear lands). */
  bluffPlausibilityWeight: 0.6,
  /** HARD per-season cap on the PLAYER's bluffs (open build-tuning, owner: capped like confide-lies). */
  maxPlayerBluffsPerSeason: 3,
} as const;

/**
 * Feature 0099 — secrets as a tradeable currency. The SECRET_TRADE sibling of LEVERAGE: a held secret
 * handed to a THIRD-PARTY recipient (not the subject) as consideration. Its value is the RECIPIENT's —
 * what THEY would do with it (a rival's secret is worth a lot to that rival's enemy; near-zero to that
 * rival's ally). Every magnitude bounded, seeded, engine-owned (ADR 0005). One ownership check, one
 * `usedAs` marker, shared with LEVERAGE (the owner ruled ONE build, not two systems).
 */
export const SECRET_TRADE = {
  // ── tradeValue ∈ [0,1] — value TO the recipient (0099) ───────────────────────────────────────────
  // From already-read signals: the secret's public severity, how much the RECIPIENT wants leverage on /
  // is threatened by the secret's subject (the recipient's OWN directed edge toward the subject), and
  // the recipient's read of the player (a recipient who distrusts the player discounts the offer). A
  // secret about someone the recipient doesn't care about has near-zero value.
  /** Weight on the secret's public severity. */
  severityWeight: 0.35,
  /** Weight on the recipient WANTING leverage on the subject (their threat-toward-subject minus their warmth). */
  recipientInterestWeight: 0.45,
  /** Weight on the recipient's TRUST in the player (a distrusted source's offer is discounted). */
  sourceTrustWeight: 0.2,
  /** A bounded per-moment jitter band (±). */
  jitter: 0.15,

  /** Max additive boost to the recipient's deal-acceptance read a full-value trade can apply (bounded). */
  dealFactorCap: 0.4,
  /** Below this acceptance read AFTER the trade, the recipient refuses (the secret is worthless to them, or they distrust the source). */
  refusalFloor: 0.3,
  /** A read this far ABOVE the refusal floor closes for sure; between floor and floor+margin it wobbles (a seeded close). */
  closeMargin: 0.1,
  /** The recipient WARMS to / owes the giver when they take a valued trade (a bounded positive fold — `DEAL_IMPACTS.honored`-grade). */
  recipientFold: { trust: +0.06, affinity: +0.05, alignment: +0.04 } as Partial<EdgeSignals>,
  /** Peddling a secret a recipient does NOT want reads as untrustworthy — a bounded sour on their read of the trader. */
  traderBacklash: { trust: -0.06, affinity: -0.05, threat: +0.06 } as Partial<EdgeSignals>,
  /** HARD per-season cap on the player's trades (a sibling of the expose cap). */
  maxTradesPerSeason: 5,

  // ── the off-screen NPC↔NPC barter (0099 hidden half) — a DRIVER of the existing 0038/0094 diffusion ─
  // An NPC holding a juicy fact SPENDS it with an ally to firm a bond / buy a vote. Behind the off-screen
  // flag; rides the dedicated side-rng so it is calibration byte-identical when off.
  /** Per-tick probability a willing holder barters a held fact (rate-limited — secrets move, but not constantly). */
  barterRate: 0.25,
  /** The minimum tradeValue (to the candidate recipient) for a holder to bother bartering a fact. */
  barterValueFloor: 0.5,
  /** The hidden bond fold the recipient registers toward the giver when they take a bartered secret. */
  barterBondFold: { trust: +0.05, affinity: +0.05, alignment: +0.05 } as Partial<EdgeSignals>,
} as const;
