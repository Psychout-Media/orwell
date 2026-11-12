import type { EntityId } from "./ids";

/**
 * Feature 0039 — Promise & deal tracking (pure domain model).
 *
 * A deal is a first-class commitment between two houseguests with a CONDITION that a later
 * binding action (a nomination, replacement, veto, or eviction vote) can break. The ENGINE —
 * never the narrator — decides kept/broken by evaluating the action against the condition
 * (anti-sycophancy, priority #3). This module is pure data + predicates: no I/O, no relationship
 * math, no Vault — it only answers "does this action honor / break this deal?".
 */

/**
 * The concrete _Big Brother_ deal kinds (no general contract DSL — model only what the game has).
 * The first four are DEFENSIVE (negative-obligation) promises — "don't move against me". The last two
 * (0121) are ACTIVE (positive-obligation) promises — "do this FOR me" — where a break is a FAILURE TO ACT.
 */
export type DealKind = "safety" | "vote" | "final-two" | "target-other" | "comp-throw" | "veto-save" | "protect-third" | "conditional" | "information";

/** 0121 — the ACTIVE-obligation kinds: a break is a failure to act (throw the comp / use the veto to save). */
const POSITIVE_KINDS: ReadonlySet<DealKind> = new Set<DealKind>(["comp-throw", "veto-save"]);
export function isPositiveObligation(kind: DealKind): boolean { return POSITIVE_KINDS.has(kind); }

/**
 * 0121 R1 — the diffusing "keeps their word" REPUTATION belief's lineage id. A kept deal seeds a hidden
 * `reliable:<honorer>` belief about the honorer that spreads NPC→NPC through the 0038 gossip layer (the
 * positive mirror of the betrayal rumor). The `factId` is preserved verbatim across every retelling hop
 * (unlike a belief's drifting `subject`), so ANY holder's belief resolves back to WHICH houseguest is
 * credited as reliable — one home for the format the seed side (the registry reputation sink) and the read
 * side (the NPC deal-willingness lean in `mintNpcDeal`) both depend on. Pure data, no state.
 */
export const RELIABLE_FACT_PREFIX = "reliable:";
export function reliableFactId(honorer: EntityId): string { return `${RELIABLE_FACT_PREFIX}${honorer}`; }
export function reliableHonorerFrom(factId: string): EntityId | undefined {
  return factId.startsWith(RELIABLE_FACT_PREFIX) ? (factId.slice(RELIABLE_FACT_PREFIX.length) as EntityId) : undefined;
}

/** "lapsed" (ORW-316): an UNTESTED conditional / undelivered information pact whose term ran out. It is a terminal, neutral state (not kept, not broken, no fold) and is no longer part of the
 *  live ledger (`forParty` / `npcOnly` / `open` skip it) - but the entry stays in the saved list, because the non-degradation checkpoint treats `deals` as append-only by id. */
export type DealStatus = "open" | "kept" | "broken" | "lapsed";

/**
 * What a binding action would have to do to break the deal. `protect` is the party who must not be
 * targeted by an adverse action; `promisors` are the parties bound by it (one-way for `target-other`,
 * both ways for the mutual kinds). Engine-decidable: a break is `actor ∈ promisors ∧ protect ∈ targets`.
 */
export interface DealCondition {
  protect: EntityId;
  promisors: readonly EntityId[];
}

export interface Deal {
  id: string;
  parties: [EntityId, EntityId];
  kind: DealKind;
  /** Vault-free, human-readable description of the promise (safe to show a party). */
  terms: string;
  condition: DealCondition;
  status: DealStatus;
  /** The event that recorded the deal being made (player-witnessed → knowledge; NPC↔NPC → Vault). */
  madeEventId?: string;
  /** The event that recorded it being kept/broken (set on reconciliation). */
  resolvedEventId?: string;
  /**
   * The week the promise was made (audit E43): `safety`/`vote` deals bind through THAT week's
   * eviction and then resolve; `final-two`/`target-other` bind until broken or the season ends.
   * Optional for pre-E43 saves (those never expire by week).
   */
  madeWeek?: number;
  /**
   * Feature 0109 — a NEGOTIATED term, in EXACTLY one of two forms (data only; the engine reads it).
   * `expiresWeek` is the explicit week the parties named out loud (made week 3, "two weeks" →
   * `expiresWeek: 5`) — it generalizes the kind-implied horizon, is the player's OWN knowledge (a
   * term they negotiated), and an action breaking the deal at/after it is NOT a betrayal. Absent ⇒
   * the kind-implied horizon (back-compat — pre-0109 saves load unchanged).
   */
  expiresWeek?: number;
  /**
   * Feature 0109 — the duration was left unspoken: the deal is simply LABELED `vague` (no numeric
   * expiry, no per-party belief object — owner ruling "just labeled as vague is enough"). A broken
   * `vague` deal folds a SOFTER betrayal-shock (built-in ambiguity). Absent ⇒ not vague.
   */
  vague?: boolean;
  /**
   * Feature A7/E12 — set true when the action that broke this deal was a SEALED eviction ballot
   * (`vote-evict`) cast by someone other than the player: the deal's own outward STATUS would
   * otherwise deanonymize that vote (the player already knows their deal partner's identity, so
   * "this deal just went from open → broken" IS the ballot). The projection (`dealView`) reads this
   * to hold the outward status at "open" until the season's 0048 retrospective unseals it — the same
   * terminal gate the primary eviction reveal already uses. Never set for a break the player caused
   * themselves (their own vote is never sealed from them) or one triggered by a public action
   * (a nomination/replacement — never secret). Absent ⇒ unsealed, byte-identical to pre-A7.
   */
  sealedBallot?: boolean;
  /**
   * Feature #1802 — the audience present at deal formation, recorded from presence ground truth
   * at the moment makeDeal commits. Empty/absent when flag OFF ⇒ byte-identical. At breach,
   * the EXISTING applyBreak seeds the breach fact into each witness's knowledge via the standard
   * 0038 diffusion pathway (no new fold mechanism).
   */
  formationWitnesses?: EntityId[];
  /**
   * 0142 idea 3 (information): how many facts the promisor has actually passed to the player under this deal (the engine counts them in `deliverInformationDeals`). 0 / absent ⇒ never delivered,
   * so an expiring information deal is dropped neutrally; > 0 ⇒ it resolves kept at its horizon. Absent on every other kind.
   */
  delivered?: number;
  /**
   * 0142 idea 3 (package): the id shared by the two ordinary deals a package made. Each part is adjudicated on its OWN condition; a break of either also costs the package's reliability
   * (see `DealLedger.reconcile`). Absent on a stand-alone deal.
   */
  packageId?: string;
}

/** The binding horizon of a deal kind (audit E43): one HOH reign, or the whole season. The active
 *  kinds (0121) resolve within their week — at that week's comp / veto ceremony. */
export function horizonOf(kind: DealKind): "week" | "season" {
  return kind === "safety" || kind === "vote" || kind === "comp-throw" || kind === "veto-save" || kind === "conditional" || kind === "information" ? "week" : "season";
}

/** A binding action through the live decision seam (0034/0005) the engine reconciles deals against. */
export interface BindingAction {
  actor: EntityId;
  kind: "nominate" | "replace" | "veto-use" | "vote-evict" | "compete";
  /** Who the action moves AGAINST (nominees, replacement, eviction target) — NOT a veto save. */
  targets: readonly EntityId[];
  /**
   * Who the actor COULD legally have moved against (audit E43): when present, an action only
   * HONORS a deal if the protected partner was a real alternative the actor pointedly spared —
   * a vote between two strangers proves nothing about a promise to a third party.
   */
  alternatives?: readonly EntityId[];
  /**
   * 0121 — the actor's OWN outcome in a `compete` action (comp-throw adjudication): `threw` keeps a
   * throw-promise; `competed`/`won` breaks it (they tried when they swore to tank). Absent on non-compete.
   */
  outcome?: "threw" | "competed" | "won";
  /** ORW-269 - the actor was SEEN fighting hard on most rounds of this comp (played games only). A kept throw-promise with this set still resolves kept (the result dominates) but draws suspicion. */
  effortHard?: boolean;
  /** 0121 — a `veto-use` action's SAVED set (who the veto pulled off the block) — veto-save adjudication. */
  saved?: readonly EntityId[];
  /**
   * 0121 — the nominees on the block at a `veto-use` — a veto-save obligation only TRIGGERS when the
   * protected party is actually up (no duty to save someone who isn't nominated). Absent ⇒ no trigger.
   */
  nominees?: readonly EntityId[];
}

/** Adverse actions move against their target; using the veto SAVES, so it is never a betrayal. */
const ADVERSE = new Set(["nominate", "replace", "vote-evict"]);

/**
 * Build the condition for a freshly-made deal. `safety` / `vote` / `final-two` bind BOTH parties not
 * to move against the other; `target-other` binds only the promisor (`parties[0]`) to spare `parties[1]`.
 */
export function conditionFor(kind: DealKind, parties: [EntityId, EntityId], third?: EntityId): DealCondition {
  const [a, b] = parties;
  // 0142 idea 3: `protect-third` - the promisor (`a`) swears not to move against a THIRD houseguest (`third`); `b` is who asked. Same one-way break rule as target-other, protecting `third`.
  if (kind === "protect-third" && third !== undefined) return { protect: third, promisors: [a] };
  // One-way bindings: `target-other` + the 0121 active kinds bind only the promisor (`a`) toward `b`.
  if (kind === "target-other" || kind === "comp-throw" || kind === "veto-save" || kind === "information") return { protect: b, promisors: [a] };
  // safety / vote / final-two are mutual: neither party may move against the other.
  return { protect: b, promisors: [a, b] };
}

/**
 * 0121 — evaluate an ACTIVE-obligation deal (comp-throw / veto-save) against an action: `broken` (the
 * promisor failed to act), `kept` (they came through), or `null` (this action doesn't trigger the duty).
 * Pure — decided from the structured action, never prose.
 */
function positiveVerdict(deal: Deal, action: BindingAction): "kept" | "broken" | null {
  if (!deal.condition.promisors.includes(action.actor)) return null;
  if (deal.kind === "comp-throw") {
    if (action.kind !== "compete") return null; // the duty resolves at the promisor's OWN comp turn
    return action.outcome === "threw" ? "kept" : "broken"; // competed / won ⇒ they didn't tank as sworn
  }
  if (deal.kind === "veto-save") {
    if (action.kind !== "veto-use") return null;
    if (!(action.nominees ?? []).includes(deal.condition.protect)) return null; // no duty unless they're on the block
    return (action.saved ?? []).includes(deal.condition.protect) ? "kept" : "broken";
  }
  return null;
}

/**
 * The crux: did this binding action BREAK the deal? True iff a bound promisor moved adversely against
 * the protected party. Decided purely from the action + the condition — never from chat prose.
 */
export function actionBreaks(deal: Deal, action: BindingAction): boolean {
  if (deal.status !== "open") return false;
  if (isPositiveObligation(deal.kind)) return positiveVerdict(deal, action) === "broken";
  if (deal.kind === "information") return false; // 0142: an information promise has no adverse act to break - it is kept by telling
  if (!ADVERSE.has(action.kind)) return false;
  // 0142 idea 3: a `conditional` deal ("if you are on the block I vote to keep you, and the same for me") only comes due at the VOTE - nominating the partner is not a break, the promise binds only if they end up on the block.
  if (deal.kind === "conditional" && action.kind !== "vote-evict") return false;
  const c = deal.condition;
  if (!c.promisors.includes(action.actor)) return false;
  // The protected party was targeted — OR, for a mutual deal, either party was targeted by the other.
  if (action.targets.includes(c.protect) && action.actor !== c.protect) return true;
  if (c.promisors.length > 1) {
    // Mutual: the actor (a promisor) moving against the OTHER party also breaks it.
    return action.targets.some((t) => deal.parties.includes(t) && t !== action.actor);
  }
  return false;
}

/** The party wronged by a break (the one moved against); undefined when the action doesn't break it. */
export function wrongedParty(deal: Deal, action: BindingAction): EntityId | undefined {
  if (!actionBreaks(deal, action)) return undefined;
  // For an active-obligation break the wronged party is the one who was promised the act (protect).
  if (isPositiveObligation(deal.kind)) return deal.condition.protect;
  return deal.parties.find((p) => p !== action.actor);
}

/**
 * Did a party HONOR the deal — i.e., take an adverse binding action where they COULD have moved
 * against their partner but pointedly did not? That is the signal that a promise was actively kept
 * (not merely untouched). When the action carries `alternatives` (audit E43), the partner must have
 * been a real option: sparing someone you couldn't have hit demonstrates nothing.
 */
export function actionHonors(deal: Deal, action: BindingAction): boolean {
  if (deal.status !== "open") return false;
  if (isPositiveObligation(deal.kind)) return positiveVerdict(deal, action) === "kept";
  if (deal.kind === "information") return false;
  if (!ADVERSE.has(action.kind)) return false;
  if (deal.kind === "conditional" && action.kind !== "vote-evict") return false; // 0142: only the vote can honor a conditional promise
  if (!deal.condition.promisors.includes(action.actor)) return false;
  const other = deal.parties.find((p) => p !== action.actor);
  if (!other || action.targets.length === 0 || action.targets.includes(other)) return false;
  return action.alternatives ? action.alternatives.includes(other) : true;
}
