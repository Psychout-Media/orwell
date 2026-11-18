/**
 * PROMISE TERMS (ORW-586, feature 0187). A promise that BINDS: the open ledger (`openLedger.ts`) keeps what people said as free
 * text; an entry may also carry ONE closed, typed `term` saying what was promised in terms the board can test. The engine then
 * judges kept or broken from public board facts, with no model in the loop (anti-sycophancy: the engine decides, the model may
 * only withdraw). A promise with no term, or the open-text `share-info` term, is never judged: it stays free text (ADR 0005).
 * Pure and deterministic: no I/O, no randomness, no Vault handle, no relationship number.
 */
import type { DealKind } from "../domain/deal";
import type { EntityId } from "../domain/ids";
import { isBetrayal, ledgerPlanKey, type PlanStore, type StoredPlan } from "./dealPlans";

/** What was promised, as a closed engine set (engine keys, never shown to a player as text). `share-info` is open text and is never judged. */
export const PROMISE_WHATS = ["no-nominate", "no-evict-vote", "use-veto-on", "not-use-veto-on", "final-two", "share-info"] as const;
export type PromiseWhat = (typeof PROMISE_WHATS)[number];
/** `week`: tested on the board events of the week it was made. `season`: tested on every later board event, so it can only ever be BROKEN (it is never "kept" before the season ends; it lapses like any open entry). */
export type PromiseWindow = "week" | "season";

export interface PromiseTerm {
  /** The promiser. */
  readonly by: string;
  /** The houseguest the promise was made TO (the wronged party when it is broken). */
  readonly to: string;
  readonly what: PromiseWhat;
  /** Who it concerns when that is not `to` ("I will not nominate Y", said to X). Absent: `to`. */
  readonly subject?: string;
  readonly window?: PromiseWindow;
  /** The week it was made, stamped by the engine. */
  readonly week?: number;
}

/** A public board fact the engine can test a term against. Every one is already shown to the player; none reads a ballot except the sealed flag, which only anonymises. */
export type PromiseBoardFact =
  | { readonly kind: "nominated"; readonly week: number; readonly by: string; readonly nominee: string }
  | { readonly kind: "nominations-final"; readonly week: number; readonly by: string; readonly nominees: readonly string[] }
  | { readonly kind: "eviction-vote"; readonly week: number; readonly by: string; readonly votedOut?: string; readonly spared?: string; readonly sealed: boolean; readonly sealedAmong?: readonly string[] }
  | { readonly kind: "veto-used"; readonly week: number; readonly by: string; readonly on?: string }
  | { readonly kind: "final-two"; readonly week: number; readonly finalists: readonly string[] };

export type PromiseVerdict = "kept" | "broken";

export const isPromiseWhat = (v: unknown): v is PromiseWhat => typeof v === "string" && (PROMISE_WHATS as readonly string[]).includes(v);

/** Is this a well-formed term (the shape a restore or a recorder accepts)? */
export function isPromiseTerm(v: unknown): v is PromiseTerm {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const t = v as Record<string, unknown>;
  const allowed = ["by", "to", "what", "subject", "window", "week"];
  if (Object.keys(t).some((k) => !allowed.includes(k))) return false;
  if (typeof t.by !== "string" || !t.by || typeof t.to !== "string" || !t.to || t.by === t.to) return false;
  if (!isPromiseWhat(t.what)) return false;
  if (t.subject !== undefined && (typeof t.subject !== "string" || !t.subject)) return false;
  if (t.window !== undefined && t.window !== "week" && t.window !== "season") return false;
  if (t.week !== undefined && !(typeof t.week === "number" && Number.isInteger(t.week) && t.week >= 0)) return false;
  return true;
}

/** Who a promise is about: its subject, else the one it was made to. */
export const termSubject = (t: PromiseTerm): string => t.subject ?? t.to;

/**
 * The legacy assurance kind a term maps onto, so the casual-assurance ledger stays the ONE resolver of its fold: "I will not nominate you" is `loyal`,
 * "I will not vote you out" is `vote`. Only when the promise concerns the one it was made to (a promise about a third person has no assurance row).
 */
export function termAssuranceKind(t: PromiseTerm): "loyal" | "vote" | undefined {
  if (termSubject(t) !== t.to) return undefined;
  if (t.what === "no-nominate") return "loyal";
  if (t.what === "no-evict-vote") return "vote";
  return undefined;
}

/** The stable id of the lied-to-me claim a broken termed promise writes for the wronged houseguest: one claim per (wronged, promiser, entry), so a repeat fold is a no-op. */
export const brokenPromiseClaimId = (wronged: string, promiser: string, entryId: string): string => `${wronged}|lied-to-me|${promiser}|promise:${entryId}`;

/** The engine's own note on a closed entry: names nobody, states the public board fact it was judged on. */
export const promiseNote = (verdict: PromiseVerdict, fact: PromiseBoardFact): string => `engine judged ${verdict} at the ${fact.kind.replace(/-/g, " ")}`;

/**
 * Judge `term` against ONE board fact. Deterministic and pure. `undefined` = this fact says nothing about the term (another actor, another week, nothing tested yet).
 * `share-info` is open text and is never judged. A `season` window is only ever broken, never kept.
 */
export function judgePromise(term: PromiseTerm, fact: PromiseBoardFact): PromiseVerdict | undefined {
  if (term.what === "share-info") return undefined;
  if (term.what === "final-two") {
    // The one season-long term: tested only by the final-two fact itself (the end of the season), whatever its window or week.
    if (fact.kind !== "final-two" || !fact.finalists.includes(term.by)) return undefined;
    return fact.finalists.includes(termSubject(term)) ? "kept" : "broken";
  }
  const window = term.window ?? "week";
  if (window === "week" && term.week !== undefined && fact.week !== term.week) return undefined;
  const subject = termSubject(term);
  const out = (v: PromiseVerdict): PromiseVerdict | undefined => (v === "kept" && window === "season" ? undefined : v);
  switch (term.what) {
    case "no-nominate":
      if (fact.kind === "nominated" && fact.by === term.by) return fact.nominee === subject ? "broken" : undefined;
      if (fact.kind === "nominations-final" && fact.by === term.by) return out(fact.nominees.includes(subject) ? "broken" : "kept");
      return undefined;
    case "no-evict-vote":
      if (fact.kind !== "eviction-vote" || fact.by !== term.by) return undefined;
      if (fact.votedOut === subject) return "broken";
      if (fact.spared === subject) return out("kept");
      return undefined;
    case "use-veto-on":
      if (fact.kind !== "veto-used" || fact.by !== term.by) return undefined;
      return fact.on === subject ? out("kept") : "broken";
    case "not-use-veto-on":
      if (fact.kind !== "veto-used" || fact.by !== term.by) return undefined;
      return fact.on === subject ? "broken" : out("kept");
  }
}

/** The ids a term names are the player or a known houseguest. */
export function termIdsKnown(t: PromiseTerm, known: (id: string) => boolean): boolean {
  return known(t.by) && known(t.to) && (t.subject === undefined || known(t.subject));
}

/**
 * Slice 4 (NPC binding reads). How hard a KEPT veto promise leans the promiser's own save read: toward saving the one they promised to use the veto on (+), away from saving the one they promised
 * NOT to use it on (-). Sized to the identity range of the summed save bias (the same scale as the other named bias terms), so a kept promise tips a save that would otherwise fall under the bar
 * without overriding the holder's own seat on the block. The keep-or-break call is the casual-assurance one (`decideKeep`); this is only the lean when it keeps.
 */
export const PROMISE_VETO_LEAN = 0.8;

/**
 * Slice 5 (the plan seam for improvised NPC promises). Which deal kind's plan shapes an NPC's termed promise is decided as (`decidePlan`): the promise is planned the way the deal of that shape is. A "will not nominate" or a
 * veto promise is a "keep your hands off them at the moment it matters" (the target-other shapes: break at the nominations or hold it a week); "will not vote out" is the vote deal (a flip at the vote); "final two" is the final-two
 * deal. `share-info` is open text and never judged, so it gets no plan. Engine keys only.
 */
export function termPlanDealKind(what: PromiseWhat): DealKind | undefined {
  switch (what) {
    case "no-nominate": case "use-veto-on": case "not-use-veto-on": return "target-other";
    case "no-evict-vote": return "vote";
    case "final-two": return "final-two";
    case "share-info": return undefined;
  }
}

/** One secret plan for an improvised promise, as the post-crown retrospective lists it (the `DealPlanRetro.secretPlans` row shape). */
export interface LedgerPlanRetroRow { holder: EntityId; with: EntityId; dealKind: DealKind; madeWeek: number; plan: StoredPlan["kind"]; outcome: NonNullable<StoredPlan["outcome"]> | "pending" }

/**
 * The retrospective rows for every termed ledger promise that holds a plan (read-only; the crown gate is the caller's). The outcome is read from how the engine settled the entry, as a deal's plan is: an honest plan is
 * "kept-anyway" when kept and "overtaken" when broken; a betrayal is "carried-out" when broken and "kept-anyway" when kept; a withdrawn or lapsed one is "overtaken"; still open is "pending".
 */
export function ledgerPlanRetroRows(plans: PlanStore | undefined, ledger: ReadonlyArray<{ id: string; status: string; term?: PromiseTerm }>): LedgerPlanRetroRow[] {
  const out: LedgerPlanRetroRow[] = [];
  if (!plans) return out;
  for (const e of ledger) {
    const t = e.term;
    const kind = t ? termPlanDealKind(t.what) : undefined;
    const p = t ? plans[ledgerPlanKey(e.id)]?.[t.by] : undefined;
    if (!t || !kind || !p) continue;
    const outcome: LedgerPlanRetroRow["outcome"] = p.outcome ?? (e.status === "kept" ? "kept-anyway" : e.status === "broken" ? (isBetrayal(p.kind) ? "carried-out" : "overtaken") : e.status === "open" ? "pending" : "overtaken");
    out.push({ holder: t.by as EntityId, with: t.to as EntityId, dealKind: kind, madeWeek: p.madeWeek, plan: p.kind, outcome });
  }
  return out;
}

/**
 * ORW-602: the player's casual assurances (the engine-judged kept/broken ledger) that the retrospective should list on their own. A termed ledger promise of the "loyal"/"vote" shape already wrote its matching assurance row
 * (ONE resolver), so that row is dropped here: the promise is one record, not two. Pure; read-only.
 */
export function uncoveredPlayerAssurances<A extends { from: string; to: string; kind: string; week: number; source: string }>(
  assurances: ReadonlyArray<A> | undefined,
  ledger: ReadonlyArray<{ term?: PromiseTerm }>,
  player: string,
): A[] {
  const covered = new Set<string>();
  for (const e of ledger) {
    const k = e.term ? termAssuranceKind(e.term) : undefined;
    if (e.term && k) covered.add(`${e.term.by}|${e.term.to}|${k}|${e.term.week ?? ""}`);
  }
  return (assurances ?? []).filter((a) => a.source === "player" && a.from === player && !covered.has(`${a.from}|${a.to}|${a.kind}|${a.week}`) && !covered.has(`${a.from}|${a.to}|${a.kind}|`));
}
