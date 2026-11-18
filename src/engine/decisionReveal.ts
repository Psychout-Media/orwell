/**
 * ORW-656 companion - the retrospective's `decisionReveal`: the season's notable NPC decisions as FACTS, after the crown only, with what the decider SAID the reason was
 * beside what the REAL reason's kind was (the sanctioned unsealing: "they said X but the real driver was Y").
 * PURE: the CALLER (`GameSessionAdapter.seasonRetrospective`) runs it behind the finished gate, the same door as `yourEdit` and `groupLife`, so before the crown nothing exists.
 * Words only: names (never an id), a week, the closed kind of each reason (never a term, weight or number). A secret ballot is shown only when the post-season vote record
 * (the 0048 unsealing) already attributes that vote to that voter for that choice. `line` is only the composed offline floor; the narrator voices the facts live.
 */
import type { EntityId } from "../domain/ids";
import { truthfulKind, type DecisionKind, type StatedReasonKind } from "./agendaDecisions";
import type { StatedReasonRecord } from "./agendaDecisions";

export type RevealKind = "nominate" | "vote" | "veto" | "deal";
export interface DecisionRevealEntry {
  week: number;
  kind: RevealKind;
  decider: string;
  about: string;
  /** The closed kind of the reason the decider gave aloud, and of the reason that really drove it. */
  saidKind: StatedReasonKind;
  realKind: StatedReasonKind;
  /** The said reason was not the real one. */
  mismatch: boolean;
  line: string;
}
export interface DecisionRevealView { decisions: DecisionRevealEntry[] }

/** The most decisions one season shows. */
export const REVEAL_CAP = 12;

const REVEAL_OF: Readonly<Partial<Record<DecisionKind, RevealKind>>> = {
  nominate: "nominate", replacement: "nominate", vote: "vote", "final-hoh-evict": "vote", veto: "veto", "veto-hold": "veto",
  "deal-consent": "deal", "deal-break": "deal", "deal-renegotiate": "deal",
};
/** Which decisions weigh most when the cap bites among equals: the board first, then the vote, the veto, the deals. */
const WEIGHT: Readonly<Record<RevealKind, number>> = { nominate: 0, vote: 1, veto: 2, deal: 3 };
const ACT: Readonly<Record<RevealKind, string>> = { nominate: "put up", vote: "voted out", veto: "made the veto call on", deal: "weighed a deal with" };
const PHRASE: Readonly<Record<StatedReasonKind, string>> = {
  "biggest-threat": "reading them as the biggest threat", "came-after-me": "payback for coming after them", "loyal-to-my-side": "protecting their own side",
  "pawn-youll-be-fine": "calling them a pawn", "kept-my-word": "keeping their word", "didnt-trust-you": "never knowing where they stood",
  "had-it-planned": "a plan that was always there", "nothing-personal": "plain strategy", "house-wants-it": "going with what the house wanted", "keeping-the-noms": "keeping the nominations the same",
};

export function decisionRevealLine(e: Pick<DecisionRevealEntry, "week" | "kind" | "decider" | "about" | "saidKind" | "realKind" | "mismatch">): string {
  const head = `Week ${e.week}: ${e.decider} ${ACT[e.kind]} ${e.about}`;
  return e.mismatch ? `${head}. They said it was ${PHRASE[e.saidKind]}; the real driver was ${PHRASE[e.realKind]}.` : `${head}, and they said so: ${PHRASE[e.realKind]}.`;
}

export interface DecisionRevealInputs {
  records: readonly StatedReasonRecord[] | undefined;
  voteRecord: ReadonlyArray<{ week: number; voteOf: Readonly<Record<EntityId, EntityId>> }> | undefined;
  nameOf: (id: EntityId) => string;
}

/** Deterministic: the notable decisions (a said reason that was not the real one first, then by the decision's weight), cut to the cap, shown in week then decider order. Absent when none. */
export function buildDecisionReveal(inp: DecisionRevealInputs): DecisionRevealView | undefined {
  const rows: Array<DecisionRevealEntry & { _w: number }> = [];
  for (const r of inp.records ?? []) {
    const kind = REVEAL_OF[r.decision];
    if (!kind) continue;
    // A secret ballot is shown only where the retrospective already attributes it (the vote record names this voter's choice for that week).
    if (r.decision === "vote" && !r.public && !(inp.voteRecord ?? []).some((v) => v.week === r.week && v.voteOf[r.decider] === r.real.choice)) continue;
    const realKind = truthfulKind(r.real);
    const e = { week: r.week, kind, decider: inp.nameOf(r.decider), about: inp.nameOf(r.real.choice), saidKind: r.stated.kind, realKind, mismatch: r.stated.kind !== realKind };
    rows.push({ ...e, line: decisionRevealLine(e), _w: WEIGHT[kind] });
  }
  if (rows.length === 0) return undefined;
  const byWeek = (a: DecisionRevealEntry, b: DecisionRevealEntry) => a.week - b.week || a.decider.localeCompare(b.decider) || a.kind.localeCompare(b.kind) || a.about.localeCompare(b.about);
  const picked = [...rows].sort((a, b) => Number(b.mismatch) - Number(a.mismatch) || a._w - b._w || byWeek(a, b)).slice(0, REVEAL_CAP);
  picked.sort(byWeek);
  return { decisions: picked.map(({ _w, ...e }) => e) };
}
