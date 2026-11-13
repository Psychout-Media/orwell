/**
 * ORW-320 (ORW-253 slice 7, spec 0146 "the house you never saw"; Ryne 2026-11-12: "who are these people really that I didn't see? ... I want that
 * limited perspective to be broken in the season retrospective"). VAULT-CLASS (listed in the dependency-cruiser engine denylist): it reads every
 * houseguest's agenda and the stored real-vs-stated reasons.
 *
 * Its ONLY caller is `GameSessionAdapter.seasonRetrospective()`, behind the `live.finished` gate, so it is the post-season retrospective's door and
 * nothing else (the debug `producerVault` dump keeps its own raw agenda rows). Pure and deterministic: no I/O, no rng. It never changes what was
 * recorded; it renders what is already there, per houseguest, as plain sentences: names and days only, no weights, no raw ids (the caller's
 * `scrub` resolves ids in free text). An early evictee's story is complete: their agenda history and every decision they made are kept.
 */
import type { EntityId } from "../domain/ids";
import type { Agenda, Cause, Goal, SuccessTest } from "./agenda";
import type { StatedReasonRecord } from "./agendaDecisions";
import { STATED_REASON_GLOSS } from "./momentPrompts";
import type { HouseStory, HouseStoryDecision, HouseStoryGoal } from "../ports/GameSession";

const label = (s: string): string => s.replace(/-/g, " ");

const AIM_WORDS: Readonly<Record<string, string>> = {
  "win-by-comps": "win by winning competitions", "win-by-being-liked": "win by being liked", "run-the-house": "run the house",
  "reach-jury": "make it to the jury", "last-alliance-standing": "see their alliance last", "prove-not-a-floater": "prove they were not a floater",
  "protect-my-person": "protect one person all the way", revenge: "get revenge", "keep-my-secret": "keep a secret hidden", "long-con": "run a long con",
  "get-them-out": "get someone out", "stay-safe": "stay safe", "pull-them-in": "pull someone in", "keep-them-safe": "keep someone safe",
  "win-power": "win power", "find-out": "find something out",
};

function goalSentence(g: Goal, nameOf: (id: EntityId) => string): string {
  const who = g.target ? nameOf(g.target) : "";
  switch (g.kind) {
    case "get-them-out": return `get ${who} out`;
    case "pull-them-in": return `pull ${who} in`;
    case "keep-them-safe": return `keep ${who} safe`;
    case "protect-my-person": return `protect ${who} all the way`;
    case "revenge": return `get revenge on ${who}`;
    case "long-con": return `keep ${who} close, then cut them after the jury starts`;
    default: return AIM_WORDS[g.kind] ?? label(g.kind);
  }
}

function causeLine(c: Cause, nameOf: (id: EntityId) => string, scrub: (s: string) => string): string {
  const who = c.about ? nameOf(c.about) : "";
  switch (c.kind) {
    case "threat-read": return `they read ${who} as a threat`;
    case "bond": return `a real bond with ${who}`;
    case "memory": return `a grudge they remembered against ${who}${c.ref ? ` (${scrub(c.ref)})` : ""}`;
    case "character": return `who they are${c.ref ? ` (${label(c.ref)})` : ""}`;
    case "board": return "where the game stood";
    case "secret": return "a secret they were protecting";
    case "pre-show-tie": return `a tie from before the show${who ? ` with ${who}` : ""}`;
    case "carry-over": return `it carried over from last week${who ? ` (${who})` : ""}`;
    case "question": return "a question they needed answered";
  }
}

function endedLine(g: Goal, scrub: (s: string) => string): string {
  const day = g.resolvedDay !== undefined ? ` on day ${g.resolvedDay}` : "";
  const note = g.endNote ? ` (${scrub(g.endNote)})` : "";
  switch (g.status) {
    case "achieved": return `it worked${day}${note}`;
    case "failed": return `it failed${day}${note}`;
    case "dropped": return `they gave up${day}${note}`;
    case "replaced": return `it was replaced${day}${note}`;
    case "ended": return `it ended${day}${note}`;
    default: return "still alive when the season ended";
  }
}

function testWords(t: SuccessTest, nameOf: (id: EntityId) => string): string {
  switch (t.kind) {
    case "evicted": return `${nameOf(t.who)} out of the house`;
    case "reaches-final-two": return `${nameOf(t.who)} in the final two`;
    case "cut-later": return `${nameOf(t.who)} cut after the ${t.stage === "jury" ? "jury starts" : "final five"}`;
    default: return "";
  }
}

const ACT: Readonly<Record<string, string>> = { nominate: "nominated", replacement: "named as the replacement nominee", veto: "used the veto to save", vote: "voted to evict", "final-hoh-evict": "as final HOH, evicted" };
const TERM_WORDS: Readonly<Record<string, string>> = {
  threat: "they saw them as a threat", goal: "it served a goal they held", memory: "an old grievance", bond: "a bond", alliance: "alliance loyalty", deal: "a deal they had made",
  campaign: "they had been lobbied", mood: "their mood", belief: "what they believed about them", pitch: "a pitch they had heard", style: "their own game style",
};

function realLine(r: StatedReasonRecord, nameOf: (id: EntityId) => string, goalById: Map<string, Goal>): string {
  const parts: string[] = [];
  const goal = r.real.goalId ? goalById.get(r.real.goalId) : undefined;
  if (goal) parts.push(`their goal to ${goalSentence(goal, nameOf)}`);
  else if (r.real.goalKind) parts.push(`their goal to ${AIM_WORDS[r.real.goalKind] ?? label(r.real.goalKind)}`);
  const top = [...r.real.terms].filter((t) => t.name !== "goal").sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.name.localeCompare(b.name)).slice(0, 2);
  for (const t of top) parts.push(TERM_WORDS[t.name] ?? label(t.name));
  const tactic = r.real.tactic === "backdoor" ? "a backdoor: the real target was someone else" : r.real.tactic === "pawn" ? "a pawn nomination" : "";
  if (tactic) parts.unshift(tactic);
  return parts.length ? parts.join("; ") : "pure game read";
}

export interface HouseStoryInputs {
  agendas: Readonly<Record<EntityId, Agenda>> | undefined;
  statedReasons: readonly StatedReasonRecord[] | undefined;
  /** The ids that played, in id order. */
  owners: readonly EntityId[];
  /** Week each houseguest was sent out (absent = never evicted: finalist or winner). */
  leftWeek: ReadonlyMap<EntityId, number>;
  /** The model-read casting aim hint + why (public-profile based), when written. */
  authored: Readonly<Record<EntityId, { aimHint?: string; aimWhy?: string }>> | undefined;
  /** Reflections written after the crown (write-once). */
  reflections: Readonly<Record<EntityId, ReadonlyArray<{ night: number; text: string }>>> | undefined;
  nameOf: (id: EntityId) => string;
  scrub: (s: string) => string;
}

/** One story per houseguest who held an agenda or made a recorded decision, in id order. */
export function buildHouseStories(inp: HouseStoryInputs): HouseStory[] {
  const { nameOf, scrub } = inp;
  const out: HouseStory[] = [];
  for (const owner of inp.owners) {
    const agenda = inp.agendas?.[owner];
    const decided = (inp.statedReasons ?? []).filter((r) => r.decider === owner);
    if (!agenda && decided.length === 0) continue;
    const all: Goal[] = agenda ? [...agenda.history, ...agenda.goals].sort((a, b) => a.formedDay - b.formedDay || (a.horizon === b.horizon ? 0 : a.horizon === "season" ? -1 : 1)) : [];
    const goalById = new Map(all.map((g) => [g.id, g]));
    const goals: HouseStoryGoal[] = all.map((g) => ({
      horizon: g.horizon, aim: scrub(goalSentence(g, nameOf)), from: `day ${g.formedDay}, week ${g.formedWeek}`,
      why: g.why.map((c) => scrub(causeLine(c, nameOf, scrub))), ended: endedLine(g, scrub),
    }));
    const decisions: HouseStoryDecision[] = decided.map((r) => {
      const said = STATED_REASON_GLOSS[r.stated.kind] ?? "it is purely strategic";
      const lie = r.stated.candor === "cover";
      return {
        week: r.week, day: r.day, act: `${ACT[r.decision] ?? r.decision} ${nameOf(r.real.choice)}`,
        real: scrub(realLine(r, nameOf, goalById)), said: `"${said}"`, aired: r.public,
        honesty: lie ? "lie" : r.stated.candor === "part-truth" ? "part-truth" : "truth",
      };
    });
    const season = all.filter((g) => g.horizon === "season" && g.kind !== "long-con");
    const first = season[0];
    const authored = inp.authored?.[owner];
    const seasonAim = first || authored?.aimHint
      ? {
          aim: first ? scrub(goalSentence(first, nameOf)) : (AIM_WORDS[authored!.aimHint!] ?? label(authored!.aimHint!)),
          why: [
            ...(first ? first.why.map((c) => scrub(causeLine(c, nameOf, scrub))) : []),
            ...(authored?.aimWhy ? [`the casting read: ${scrub(authored.aimWhy)}`] : []),
          ],
        }
      : undefined;
    const con = all.find((g) => g.kind === "long-con");
    const longCon = con && con.target
      ? { mark: nameOf(con.target), from: `day ${con.formedDay}, week ${con.formedWeek}`, plan: scrub(`${testWords(con.test, nameOf)}`), ended: endedLine(con, scrub), why: con.why.map((c) => scrub(causeLine(c, nameOf, scrub))) }
      : undefined;
    // The nights this houseguest's story moved: a goal formed or ended, or a decision made.
    const days = new Set<number>();
    for (const g of all) { days.add(g.formedDay); if (g.resolvedDay !== undefined) days.add(g.resolvedDay); }
    for (const r of decided) days.add(r.day);
    const reflectionNights = [...days].sort((a, b) => a - b);
    const reflections = [...(inp.reflections?.[owner] ?? [])].sort((a, b) => a.night - b.night).map((r) => ({ night: r.night, text: scrub(r.text) }));
    const left = inp.leftWeek.get(owner);
    out.push({
      houseguest: { id: owner, name: nameOf(owner) }, ...(left !== undefined ? { leftWeek: left } : {}),
      ...(seasonAim ? { seasonAim } : {}), goals, decisions, ...(longCon ? { longCon } : {}), reflectionNights, reflections,
    });
  }
  return out;
}
