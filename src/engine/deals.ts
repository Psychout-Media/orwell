import type { EntityId } from "../domain/ids";
import { PLAYER } from "../domain/ids";
import type { RandomnessSource } from "../ports/RandomnessSource";
import type { RelationshipModel } from "./relationships";
import { DEAL_IMPACTS, DEAL_DURATION, DEAL_STREAK, scaleImpact } from "./relationshipConstants";
import type { EdgeSignals } from "./relationshipConstants";
import {
  type BindingAction,
  type Deal,
  type DealKind,
  actionBreaks,
  actionHonors,
  conditionFor,
  horizonOf,
  isPositiveObligation,
  wrongedParty,
} from "../domain/deal";

export type { BindingAction, Deal, DealKind } from "../domain/deal";

/**
 * Feature 0039 — the deal ledger (engine layer), horizon-aware per audit E43.
 *
 * Tracks every open promise and RECONCILES it against the binding actions flowing through the live
 * loop (0034). When a bound party moves against their partner, the engine — not the storyteller —
 * marks the deal broken and makes it HURT: the betrayal-shock relationship fold (0026), a
 * jury-management demerit (0014, surfaced as `manner.betrayed`), and a witnessed reveal to the
 * wronged party when they see/learn it (0002).
 *
 * Honoring is no longer terminal (the pre-E43 bug: a week-2 final-two deal stopped binding at the
 * week-3 noms). Each honoring action applies a BOUNDED positive fold (`DEAL_IMPACTS.honored` —
 * kept promises build trust + the E54 evidence signal), and a deal RESOLVES `kept` only at its
 * horizon: `safety`/`vote` at that week's eviction (the vote endpoint or the week rollover);
 * `final-two`/`target-other` stay binding until broken or the season ends.
 *
 * Pure of I/O: side effects (relationship moves, jury demerits, reveal events) are delivered through
 * an injected `ReconcileSink`, so the ledger is unit-testable and the integration owns the wiring.
 */

/**
 * Feature 0109 — the bounded, engine-owned multiplier on a broken deal's betrayal-shock, derived from
 * its NEGOTIATED duration (the "when do you turn?" lever). Pure: no rng, no I/O, no Vault. The result
 * is a HIDDEN magnitude (mandate #2/#3) — it never crosses to the player or admin; only the deal's
 * `expiresWeek` TERM is player-knowledge. Three cases, in priority order:
 *   • `vague` ⇒ `DEAL_DURATION.vagueSoften` (< 1): an unspoken term softens the betrayal (ambiguity).
 *   • explicit `expiresWeek` + a known `currentWeek` ⇒ `min(maxScale, 1 + perWeekRemaining · weeksLeft)`
 *     where `weeksLeft = max(0, expiresWeek − currentWeek)` — more life left ⇒ a bigger shock, capped.
 *     (At/after the term, `weeksLeft` is 0 ⇒ scale 1; the break would normally be adjudicated fair-game
 *     by then, but the floor is exactly the pre-0109 magnitude.)
 *   • neither (no duration, or an explicit term with no `currentWeek` to measure against) ⇒ 1 — the
 *     identity floor, so a no-duration break folds BYTE-IDENTICALLY to 0039 (the calibration proof).
 */
export function breakSeverityScale(deal: Deal, currentWeek?: number): number {
  if (deal.vague) return DEAL_DURATION.vagueSoften;
  if (deal.expiresWeek !== undefined && currentWeek !== undefined) {
    const weeksLeft = Math.max(0, deal.expiresWeek - currentWeek);
    return Math.min(DEAL_DURATION.maxScale, 1 + DEAL_DURATION.perWeekRemaining * weeksLeft);
  }
  return 1;
}

/** What caused a deal to break: a binding action on the board, or (0142 idea 4) the promisor's own deliberate choice to walk it back. */
export type BreakCause = BindingAction["kind"] | "deliberate";

/** Where reconciliation routes its consequences. All optional so status logic is testable in isolation. */
export interface ReconcileSink {
  rel?: RelationshipModel;
  rng?: RandomnessSource;
  /**
   * The current week (feature 0109) — lets `applyBreak` scale the betrayal-shock by a deal's
   * REMAINING explicit term (`breakSeverityScale`). Absent ⇒ scale 1 for explicit deals (a `vague`
   * deal still softens without it), so omitting it is byte-identical to pre-0109.
   */
  currentWeek?: number;
  /** Record a jury-management demerit: `wronged` will weigh `breaker`'s betrayal in their later lean. */
  juryDemerit?: (wronged: EntityId, breaker: EntityId, deal: Deal) => void;
  /**
   * Record the witnessed reveal of a break into the wronged party's knowledge (returns its event id).
   * Receives the TRIGGERING action's `kind` (A7/E12) so the caller can seal ballot-tied attribution —
   * a break caused by a `vote-evict` must not name the breaker before the same terminal gate the
   * primary eviction reveal (E12) and the 0048 retrospective use, or it deanonymizes a sealed ballot.
   */
  reveal?: (wronged: EntityId, breaker: EntityId, deal: Deal, actionKind: BreakCause) => string | undefined;
  /**
   * #1963 — is this break SEALED (a break tied to a secret eviction ballot, E12/A7) AND observable through the wronged
   * party's behaviour? A sealed break must not be attributed to the breaker by ANY hidden fold the wronged party ACTS on
   * (an NPC's noms/votes/deals would otherwise name who voted against them). When the wronged party is the PLAYER nothing
   * acts on their hidden read (they form their own), so the engine keeps the full fold. Absent ⇒ never sealed ⇒ byte-identical.
   */
  sealed?: (wronged: EntityId, breaker: EntityId, actionKind: BreakCause) => boolean;
  /**
   * #1963 — the houseguests the wronged party can SUSPECT for a sealed break (everyone who voted to evict them), so
   * the betrayal fold is shared across all of them instead of landing wholly on the real breaker. The breaker is always
   * included. Absent / empty ⇒ only the breaker (the pre-fix behaviour).
   */
  suspects?: (wronged: EntityId, breaker: EntityId) => readonly EntityId[];
  /** Whether the wronged party witnesses/learns this break (default: true for a public ceremony break). */
  witnessed?: (wronged: EntityId, breaker: EntityId, deal: Deal, actionKind: BreakCause) => boolean;
  /**
   * 0121 — the deal-depth layer (`ORWELL_DEAL_DEPTH`). When true, keeping a deal compounds via the
   * LOYALTY STREAK (consecutive kept deals with the same partner scale the honored fold, bounded) and a
   * kept deal seeds a "reliable" reputation via `reputation`. OFF (the default / the calibration harness)
   * ⇒ the plain `DEAL_IMPACTS.honored` and no reputation ⇒ byte-identical.
   */
  dealDepth?: boolean;
  /** ORW-269 - a kept comp-throw whose promisor was seen fighting hard: the (small) suspicion fold, on the caller's own side stream. */
  suspicion?: (promisor: EntityId, promisee: EntityId, deal: Deal) => void;
  /** 0121 — seed a hidden "keeps their word" reputation for the honorer (diffuses via gossip). */
  reputation?: (honorer: EntityId, other: EntityId, deal: Deal) => void;
  /**
   * #1802 — deal witnesses feature flag. When true, the formation trust-fold scales with
   * audience size (capped by relationshipConstants) and breaches seed into witness knowledge.
   * OFF (the default) ⇒ byte-identical.
   */
  dealsWitnesses?: boolean;
  /**
   * #1802 — at breach, seed the breach fact into each formation-witness's knowledge via the
   * existing 0038 KnowledgeService/gossip diffusion pathway. Called after the reveal to the
   * wronged party.
   */
  revealToWitness?: (witness: EntityId, breaker: EntityId, deal: Deal) => void;
}

export interface Reconciliation {
  broken: Deal[];
  kept: Deal[];
}

/**
 * #1802 — compute the audience-scaled multiplier for the formation trust-fold.
 * At formation, the counterpart's trust fold scales with audience size inside
 * existing magnitude caps. Reuses DEAL_DURATION.maxScale as the upper bound.
 * @param audienceSize — number of co-present witnesses (non-party houseguests in the room)
 * @param constants — duration constants (provides perWitness + maxScale)
 */
export function formationAudienceScale(
  audienceSize: number,
  constants: { perWitness: number; maxScale: number },
): number {
  if (audienceSize <= 0) return 1;
  return Math.min(constants.maxScale, 1 + constants.perWitness * audienceSize);
}

/** 0142 (package): the extra betrayal-shock, as a share of the ordinary break, a broken package part costs the breaker with the party who relied on the bundle. */
export const PACKAGE_BREAK_SCALE = 0.5;

export class DealLedger {
  private deals: Deal[] = [];
  private seq = 0;
  /** 0121 — consecutive kept-deal count per `honorer->other` pair (the loyalty streak). In-memory: the
   *  reliability it builds is persisted in the relationship edges; only the streak multiplier resets on a
   *  restart, which merely starts the next streak fresh (no persisted detail is lost). */
  private streaks = new Map<string, number>();

  /** Make a new OPEN deal between two parties. `id`/`madeEventId` are assigned/threaded by the caller.
   *  `madeWeek` (E43) anchors the week-scoped horizon of `safety`/`vote` promises. `duration` (0109) is
   *  the optional NEGOTIATED term — exactly one of an explicit `expiresWeek` or the `vague` label; absent
   *  ⇒ the kind-implied horizon (byte-identical to pre-0109). */
  make(
    parties: [EntityId, EntityId],
    kind: DealKind,
    terms: string,
    madeEventId?: string,
    madeWeek?: number,
    duration?: { expiresWeek?: number; vague?: boolean },
    witnesses?: EntityId[],
    third?: EntityId,
  ): Deal {
    const deal: Deal = {
      id: `deal:${++this.seq}`,
      parties,
      kind,
      terms,
      condition: conditionFor(kind, parties, third),
      status: "open",
      ...(madeEventId ? { madeEventId } : {}),
      ...(madeWeek !== undefined ? { madeWeek } : {}),
      ...(duration?.expiresWeek !== undefined ? { expiresWeek: duration.expiresWeek } : {}),
      ...(duration?.vague ? { vague: true } : {}),
      ...(witnesses ? { formationWitnesses: witnesses } : {}),
    };
    this.deals.push(deal);
    return deal;
  }

  /** Every open commitment. */
  open(): Deal[] {
    return this.deals.filter((d) => d.status === "open");
  }

  /** All deals a given houseguest is party to (any status) — the player's own visibility scope. */
  forParty(id: EntityId): Deal[] {
    return this.deals.filter((d) => d.status !== "lapsed" && d.parties.includes(id));
  }

  /** Deals NOT involving the player (NPC↔NPC) — Vault-held, never an outward fact. */
  npcOnly(): Deal[] {
    return this.deals.filter((d) => d.status !== "lapsed" && !d.parties.includes(PLAYER));
  }

  get all(): readonly Deal[] {
    return this.deals;
  }

  /**
   * Reconcile a binding action against every OPEN deal it implicates (E43 horizon-aware):
   * violating → `broken` (+ consequences via the sink); honoring → a BOUNDED positive fold
   * (kept promises build trust — `DEAL_IMPACTS.honored`), and the deal resolves `kept` only at
   * its horizon endpoint (a week-scoped deal's eviction vote). A `final-two` keeps binding —
   * and keeps paying — until it is broken or the season ends. Engine-decided, never prose.
   */
  reconcile(action: BindingAction, sink: ReconcileSink = {}): Reconciliation {
    const broken: Deal[] = [];
    const kept: Deal[] = [];
    for (const deal of this.deals) {
      if (deal.status !== "open") continue;
      if (actionBreaks(deal, action)) {
        // Resolve the wronged party WHILE the deal is still open (wrongedParty re-checks
        // actionBreaks, which requires status === "open"), then mark it and apply the fallout.
        const wronged = wrongedParty(deal, action);
        deal.status = "broken";
        broken.push(deal);
        // A7/E12: a break TRIGGERED by the SEALED eviction ballot (and not the player's own vote)
        // must not surface via the deal's outward STATUS either — `dealView` reads this to hold the
        // projection at "open" until the retrospective unseals it (mirrors the reveal-event seal in
        // `applyBreak` below). A break from a PUBLIC action (nominate/replace) is never sealed.
        if (action.kind === "vote-evict" && action.actor !== PLAYER) deal.sealedBallot = true;
        if (wronged) this.applyBreak(deal, wronged, action.actor, action.kind, sink);
        // 0142 idea 3 (package): a break of EITHER part also costs the package's reliability - the wronged party's read of the breaker takes a further, smaller betrayal-grade hit (they staked two promises on
        // one word). Not for a sealed ballot (the extra hit would single the breaker out, #1963). The sibling part stays open and is adjudicated on its OWN condition.
        if (wronged && deal.packageId && !deal.sealedBallot && sink.rel && sink.rng && sink.dealDepth) {
          sink.rel.applyDirected(wronged, action.actor, "betrayal", sink.rng, breakSeverityScale(deal, sink.currentWeek) * PACKAGE_BREAK_SCALE);
        }
      } else if (actionHonors(deal, action)) {
        this.applyHonor(deal, action.actor, sink);
        if (deal.kind === "comp-throw" && action.kind === "compete" && action.effortHard === true) {
          const promisee = deal.parties.find((x) => x !== action.actor);
          if (promisee) sink.suspicion?.(action.actor, promisee, deal);
        }
        // The horizon (E43): a safety/vote promise runs through ITS week's eviction; the vote is
        // the endpoint where it resolves kept. Season-scoped kinds stay open (and stay binding).
        // 0121: an ACTIVE-obligation deal (comp-throw / veto-save) resolves the MOMENT the promised
        // act lands — the comp was thrown, the veto was used — not at a later eviction vote.
        const resolvesNow = isPositiveObligation(deal.kind)
          || (horizonOf(deal.kind) === "week" && action.kind === "vote-evict");
        if (resolvesNow) {
          deal.status = "kept";
          kept.push(deal);
        }
      }
    }
    return { broken, kept };
  }

  /**
   * Resolve deals whose binding term has passed un-broken — mark them `kept`. Two ways a term runs out:
   *   • E43 kind-horizon: a week-scoped (`safety`/`vote`) deal whose `madeWeek` is behind `currentWeek` —
   *     unless it carries an explicit negotiated term, which then governs instead (#1993).
   *   • 0109 NEGOTIATED term: ANY deal with an explicit `expiresWeek` once `currentWeek > expiresWeek`
   *     — a named term generalizes the kind-implied horizon, so an un-broken `final-two` with a term
   *     that has lapsed also resolves kept (turning after a mutually-known expiry is fair game, never
   *     a betrayal). A `vague` deal carries NO numeric expiry, so it never expires here.
   * Deals with neither an applicable `madeWeek` nor an `expiresWeek` (pre-E43/0109 saves) are left
   * alone — byte-identical to before. Returns the deals it resolved.
   */
  expireWeekScoped(currentWeek: number): Deal[] {
    const resolved: Deal[] = [];
    const untested: Deal[] = [];
    for (const deal of this.deals) {
      if (deal.status !== "open") continue;
      // 0109 / #1993: an explicit negotiated term OVERRIDES the kind-implied horizon (a `safety` deal promised
      // "for three weeks" must not lapse at the first eviction while its own view still shows the longer term).
      const kindHorizonPassed = deal.expiresWeek === undefined
        && horizonOf(deal.kind) === "week" && deal.madeWeek !== undefined && deal.madeWeek < currentWeek;
      const negotiatedTermPassed = deal.expiresWeek !== undefined && currentWeek > deal.expiresWeek;
      if (kindHorizonPassed || negotiatedTermPassed) {
        // 0142 (coordinator ruling on #2405): a `conditional` pact still OPEN when its term ends was never TESTED (a tested one resolves at the vote: kept if honored, broken if not), so nobody kept
        // anything. It is NOT marked `kept` (that status earns goodwill / "keeps their word" reads) and folds nothing either way: it LAPSES (status "lapsed", out of the live ledger, kept in the saved list - ORW-316; the formation event stays in the record).
        if (deal.kind === "conditional" || (deal.kind === "information" && !deal.delivered)) { untested.push(deal); continue; }
        deal.status = "kept";
        resolved.push(deal);
      }
    }
    // ORW-316: LAPSE, never delete. The old `this.deals.filter(...)` removed these entries, and the non-degradation checkpoint (`sessionCoreIsSuperset`: `deals` is append-only by id) then refused the
    // week-roll advance as a "degradation" on every attempt - the game froze at the end of the first eviction whenever an untested conditional / undelivered information deal was open (found live 2026-11-12).
    for (const d of untested) d.status = "lapsed";
    return resolved;
  }

  /**
   * 0142 idea 4 - a QUIET, DELIBERATE break: the promisor `breaker` chose to walk the deal back (`dealTemptation.ts`). Shares `applyBreak` with `reconcile`, so the fallout is the ordinary one
   * (betrayal-shock, loyalty-streak reset, jury demerit, the reveal and witness sinks). The deal's `sealedBallot` is set so `dealView` keeps showing it OPEN to the wronged party: the player learns
   * only through the existing witness pathways or the 0048 unseal. The caller supplies a `reveal` sink that keeps the event Vault-side. Returns the wronged party, or undefined when nothing was broken.
   */
  breakDeliberately(deal: Deal, breaker: EntityId, sink: ReconcileSink = {}): EntityId | undefined {
    if (deal.status !== "open" || !deal.condition.promisors.includes(breaker)) return undefined;
    const wronged = deal.parties.find((p) => p !== breaker);
    if (!wronged) return undefined;
    deal.status = "broken";
    deal.sealedBallot = true;
    this.applyBreak(deal, wronged, breaker, "deliberate", sink);
    return wronged;
  }

  /** The kept-promise fold (E43/E54): the protected party registers the demonstrated loyalty. 0121: with
   *  the deal-depth layer on, a LOYALTY STREAK (consecutive kept deals, same pair) compounds the fold
   *  (bounded), and the kept deal seeds a diffusing "reliable" reputation. Off ⇒ the plain honored fold.
   *  #1802: when dealsWitnesses is on, the honored fold scales with audience size (bounded by caps). */
  private applyHonor(deal: Deal, honorer: EntityId, sink: ReconcileSink): void {
    const other = deal.parties.find((p) => p !== honorer);
    if (!other) return;
    if (sink.rel && sink.rng) {
      let impact: Partial<EdgeSignals> = DEAL_IMPACTS.honored;
      // #1802: audience scale — applied BEFORE deal-depth compounding so the total stays bounded
      if (sink.dealsWitnesses && deal.formationWitnesses && deal.formationWitnesses.length > 0) {
        const audienceScale = formationAudienceScale(deal.formationWitnesses.length, DEAL_DURATION);
        impact = scaleImpact(DEAL_IMPACTS.honored, audienceScale);
      }
      if (sink.dealDepth) {
        const key = `${honorer}->${other}`;
        const streak = (this.streaks.get(key) ?? 0) + 1;
        this.streaks.set(key, streak);
        const mult = Math.min(DEAL_STREAK.maxMult, 1 + DEAL_STREAK.step * (streak - 1));
        impact = scaleImpact(DEAL_IMPACTS.honored, mult);
      }
      sink.rel.applyImpactDirected(other, honorer, impact, sink.rng);
    }
    // 0121: a kept deal seeds a hidden "keeps their word" reputation that diffuses NPC→NPC (gossip).
    if (sink.dealDepth) sink.reputation?.(honorer, other, deal);
  }

  /** The betrayal-shock fold + jury demerit + (if witnessed) the reveal event. */
  private applyBreak(
    deal: Deal,
    wronged: EntityId,
    breaker: EntityId,
    actionKind: BreakCause,
    sink: ReconcileSink,
  ): void {
    // 0026 + 0109: the wronged party's hidden read of the breaker takes the large, slow-decaying
    // betrayal hit — SCALED by how much negotiated life the deal had left (a near/at-end or vague break
    // hurts less; a freshly-renewed one more). No duration / no week ⇒ scale 1 ⇒ byte-identical to 0039.
    const sealed = sink.sealed?.(wronged, breaker, actionKind) ?? false;
    if (sink.rel && sink.rng) {
      const severity = breakSeverityScale(deal, sink.currentWeek);
      if (sealed) {
        // #1963: the ballot is SECRET, so the wronged party's hidden read must not single out the breaker. Share the
        // betrayal shock across everyone who could have cast it (the voters who sent them out); the real breaker is one
        // of them and carries only its share. Ordered for determinism.
        const pool = [...new Set([...(sink.suspects?.(wronged, breaker) ?? []), breaker])].sort();
        for (const suspect of pool) sink.rel.applyDirected(wronged, suspect, "betrayal", sink.rng, severity / pool.length);
      } else {
        sink.rel.applyDirected(wronged, breaker, "betrayal", sink.rng, severity);
      }
    }
    // 0121: a betrayal resets the breaker's loyalty streak with the wronged party (you broke faith).
    if (sink.dealDepth) this.streaks.delete(`${breaker}->${wronged}`);
    // 0014: a discrete jury-management demerit (weighs that juror's later lean against the breaker). NOT for a sealed
    // break (#1963): it names the breaker, so a juror's later lean would unseal the ballot; the evictee's blame for a
    // sealed ballot is the possibly-wrong deduction (0110), never the true voter.
    if (!sealed) sink.juryDemerit?.(wronged, breaker, deal);
    // 0002: the wronged party learns it as a witnessed event when they see/learn the break. `actionKind`
    // threads through so the sink can seal a `vote-evict`-triggered reveal (A7/E12) rather than name the
    // breaker while the ballot that produced it is still sealed.
    const witnessed = sink.witnessed ? sink.witnessed(wronged, breaker, deal, actionKind) : true;
    if (witnessed) {
      const evId = sink.reveal?.(wronged, breaker, deal, actionKind);
      if (evId) deal.resolvedEventId = evId;
    }
    // #1802: when the flag is on and the deal has formation witnesses, seed the breach fact into each
    // witness's knowledge via the existing diffusion pathway (no new fold mechanism). NOT for a SEALED break
    // (#1963/E12, BDD audit D1): the reveal names the breaker, so telling the formation witnesses who broke a deal
    // by a secret evict ballot would let them infer who cast that sealed vote — the same reason the jury demerit and
    // the wronged party's own reveal are suppressed above.
    if (!sealed && sink.dealsWitnesses && deal.formationWitnesses && deal.formationWitnesses.length > 0) {
      for (const witness of deal.formationWitnesses) {
        sink.revealToWitness?.(witness, breaker, deal);
      }
    }
  }

  /** Plain-data snapshot (persistence 0030 — survives a restart, lossless). */
  serialize(): Deal[] {
    return this.deals.map((d) => ({ ...d, parties: [...d.parties] as [EntityId, EntityId], condition: { ...d.condition, promisors: [...d.condition.promisors] } }));
  }

  /** Replace all deals from a snapshot — recall on return/restart. */
  load(deals: readonly Deal[]): void {
    this.deals = deals.map((d) => ({ ...d, parties: [...d.parties] as [EntityId, EntityId], condition: { ...d.condition, promisors: [...d.condition.promisors] } }));
    this.seq = this.deals.reduce((m, d) => Math.max(m, Number(d.id.split(":")[1]) || 0), 0);
  }
}

/**
 * 0109 / #1993 — validate and bound a narrator-PROPOSED negotiated term into the ledger's `duration`.
 * Pure, no rng. `weeks` counts the current week ("this week only" = 1), so `expiresWeek = madeWeek + weeks - 1`
 * (a deal binds through that week's close; `expireWeekScoped` resolves it kept once `currentWeek > expiresWeek`).
 * A non-integer / non-positive / non-finite `weeks` is ignored; a valid one is clamped to
 * `DEAL_DURATION.maxTermWeeks`; an explicit term wins over `vague`. Nothing usable ⇒ `undefined`, so the
 * deal is byte-identical to a pre-0109 one.
 */
export function boundDealTerm(
  term: { weeks?: unknown; vague?: unknown } | undefined,
  madeWeek: number,
): { expiresWeek?: number; vague?: boolean } | undefined {
  if (!term || typeof term !== "object") return undefined;
  const w = term.weeks;
  if (typeof w === "number" && Number.isFinite(w) && Number.isInteger(w) && w >= 1) {
    return { expiresWeek: madeWeek + Math.min(w, DEAL_DURATION.maxTermWeeks) - 1 };
  }
  return term.vague === true ? { vague: true } : undefined;
}
