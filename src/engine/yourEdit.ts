import type { EntityId } from "../domain/ids";
import { editWorthiness, type EditMoment, type EditMomentKind } from "./editWorthiness";

/**
 * 0200 / ORW-632 - "YOUR EDIT": after the crown, the season as TV would have cut it. PURE: no I/O, no rng, no state. Engine-only: the CALLER
 * (`GameSessionAdapter.seasonRetrospective`) runs it behind the finished gate, the same door as the 0048 retrospective, so nothing exists before the crown.
 *
 * It hands FACTS, never prose to recite: per week the top-scoring moments (`editWorthiness`, the SAME score the audience outside reads, ORW-624: imported, not
 * re-implemented), who the season cut as a hero and who as a villain (a closed-set measure, below), and how the player came across. The narrator voices the episode
 * titles and edit labels live from these facts; the `title` / `line` fields here are only the composed offline floor for a game with no model.
 *
 * THE MEASURE (per houseguest, the player included, in the same way for all):
 *   contribution(m) = editWorthiness(m) x sign(role, kind)   (sign table `YOUR_EDIT.actor` / `.subject`, in [-1, 1]; a kept promise adds `keptWorth`; a deal broken by
 *                      the houseguest counts as a betrayal moment against the other party)
 *   edit = net / (sum of |contribution| + prior)              (so it is bounded in (-1, 1), and a houseguest barely on screen stays near 0)
 *   hero    : edit >= heroAt, on screen (sum >= onScreenAt) and a CLEAN WORD (never broke a deal, never betrayed: a hero edit is not given for a broken word)
 *   villain : edit <= villainAt and on screen
 * The score itself never leaves this module: only the band word and the facts behind it are returned (no number to the player).
 */
export const YOUR_EDIT = {
  /** Moments kept per episode (the top by edit-worthiness). */
  episodeMoments: 3,
  heroAt: 0.3,
  villainAt: -0.3,
  /** Most heroes and villains named. */
  castCap: 3,
  /** The dampening term of the normalization: keeps a houseguest with one small moment from reading as +-1. */
  prior: 1,
  /** A houseguest below this much total on-screen worth is a background figure: no hero or villain edit. */
  onScreenAt: 0.8,
  /** A promise kept is worth this much sympathy to the one who kept it. */
  keptWorth: 0.25,
  /** A vote this close (twist) is "close". */
  closeAt: 0.5,
  /** Roles: how a moment reads for the one who did it ... */
  actor: { "comp-win": 1, "veto-save": 1, "veto-kept": 0, replacement: 0, nomination: 0, eviction: 0, blindside: -0.5, blowup: -1, betrayal: -1, "house-meeting": 0, showmance: 0.5, scheme: -0.5 } as Readonly<Record<EditMomentKind, number>>,
  /** ... and for the one it happened to. */
  subject: { "comp-win": 0, "veto-save": 0.5, "veto-kept": 0, replacement: 0.5, nomination: 0, eviction: 0, blindside: 1, blowup: 0.5, betrayal: 1, "house-meeting": 0, showmance: 0.5, scheme: 0 } as Readonly<Record<EditMomentKind, number>>,
} as const;

/** A scene as the log holds it (a structural subset of `GameEvent`). */
export interface EditEvent { type: string; initiator: EntityId; witnessSet: readonly EntityId[]; hidden: boolean; content: string; seenBy?: readonly string[] }
export interface EditDigest { week: number; hoh: EntityId | null; nominees: EntityId[]; vetoHolder: EntityId | null; vetoUsed: boolean; evictee: EntityId | null; /** ORW-691: who the HOH named in the saved nominee's place (absent when the veto was not used, and in a save from before this was kept). */ replacement?: EntityId }
/** ORW-691: a house meeting as the edit reads it (who called it, who was accused, how many were in the room). */
export interface EditMeeting { week: number; caller: EntityId; accused: EntityId; attendees: number }
export interface EditDeal { parties: readonly EntityId[]; status: string; brokenBy?: EntityId }

/** The moments one completed week's PUBLIC record makes (shared with the audience: the same kinds, the same twist from the vote's margin). */
export function weekMoments(d: EditDigest, ballots: readonly EntityId[], calledPawn: boolean): EditMoment[] {
  const out: EditMoment[] = [];
  if (d.hoh) out.push({ kind: "comp-win", actor: d.hoh, week: d.week, public: true });
  for (const n of d.nominees) out.push({ kind: "nomination", ...(d.hoh ? { actor: d.hoh } : {}), subject: n, week: d.week, public: true });
  if (d.vetoHolder) out.push({ kind: d.vetoUsed ? "veto-save" : "veto-kept", actor: d.vetoHolder, week: d.week, public: true });
  if (d.evictee !== null) {
    const margin = ballots.length ? Math.abs(ballots.filter((t) => t === d.evictee).length * 2 - ballots.length) / ballots.length : 1;
    out.push({ kind: calledPawn ? "blindside" : "eviction", ...(d.hoh ? { actor: d.hoh } : {}), subject: d.evictee, week: d.week, twist: 1 - margin, public: true });
  }
  return out;
}

/** The scene kinds the log's event types stand for. */
export const SCENE_KIND: Readonly<Partial<Record<string, EditMomentKind>>> = { conflict: "blowup", betrayal: "betrayal", showmance: "showmance" };

/** ORW-691: the scene kinds only the edit (never the audience) also reads: a strategy scene is a scheme. */
export const EDIT_SCENE_KIND: Readonly<Partial<Record<string, EditMomentKind>>> = { strategy: "scheme" };

/** One scene as a moment (null when it is not edit-worthy: a lone thought, or a kind the cut does not use). `moreKinds` adds the edit-only kinds (the audience never passes it). */
export function sceneMoment(e: EditEvent, week: number, moreKinds = false): EditMoment | null {
  const kind = SCENE_KIND[e.type] ?? (moreKinds ? EDIT_SCENE_KIND[e.type] : undefined);
  if (!kind || e.witnessSet.length < 2) return null;
  const other = e.witnessSet.find((w) => w !== e.initiator);
  return { kind, actor: e.initiator, ...(other ? { subject: other } : {}), week, crowd: e.witnessSet.length + (e.seenBy?.length ?? 0), public: !e.hidden };
}

export interface EditFact { kind: EditMomentKind; actor?: string; subject?: string }
export interface EditEpisode {
  week: number;
  /** The week's facts: who held the crown, who left, whether the count was close. */
  hoh?: string; evictee?: string; close?: boolean;
  /** The finale's episode only: the one the season crowned. */
  crown?: string;
  /** The top moments by edit-worthiness (the same score the audience reads). */
  moments: EditFact[];
  /** ORW-747 (0200 deferred: alliances in the edit): the alliances that formed or ended this week, hidden ones included (the post-crown unsealing). Facts only: the group's name, who, and how it ended. Absent when none. */
  alliances?: EditAllianceBeat[];
  /** The composed offline floor of the title (a live narrator replaces it from the facts). */
  title: string;
  /** ORW-807: the narrator's own title for this episode, written back after the crown (absent until written; the window shows it in place of the floor). */
  authoredTitle?: string;
}
export type EditBand = "hero" | "villain";
/** ORW-747: an alliance as the edit reads it (names only; the same rows the 0183 group-life retrospective reads). Weeks are absent when the season did not stamp them. */
export interface EditAlliance { name: string; members: readonly string[]; youWere: boolean; formedWeek?: number; endedWeek?: number; endedHow?: string }
export interface EditAllianceBeat { name: string; members: string[]; what: "formed" | "ended"; how?: string }
export interface YourAlliance { name: string; with: string[]; formedWeek?: number; endedWeek?: number; endedHow?: string }
export interface EditedHouseguest { name: string; edit: EditBand; because: EditFact[]; line: string }
export interface YourEditView {
  episodes: EditEpisode[];
  heroes: EditedHouseguest[];
  villains: EditedHouseguest[];
  /** How the player came across: the band word, and the player's own deeds behind it (counts of their own acts; never the measure). */
  you: {
    band: EditBand | "mixed" | "background";
    dealsKept: number; dealsBroken: number; dealsBrokenOnYou: number;
    blindsidesDealt: number; blindsidesReceived: number; betrayalsDealt: number; betrayalsReceived: number; compWins: number;
    jury?: { votesForYou: number; jurors: number };
    because: EditFact[];
    line: string;
    /** ORW-747: the alliances the player was in, as facts (the others' names, the weeks, how it ended). Absent when none. */
    alliances?: YourAlliance[];
  };
}

export interface YourEditInput {
  player: EntityId;
  cast: readonly EntityId[];
  nameOf: (id: EntityId) => string;
  digests: readonly EditDigest[];
  voteRecord: ReadonlyArray<{ week: number; evictee: EntityId; voteOf: Record<EntityId, EntityId> }>;
  /** The stated reasons that make an eviction a blindside (the HOH had publicly called the evictee a pawn). */
  calledPawn: (week: number, evictee: EntityId) => boolean;
  events: readonly EditEvent[];
  /** Week of each log position (insertion order, delimited by the eviction announcements), the same reconstruction the pull-quote reel uses. */
  eventWeeks: readonly number[];
  deals: readonly EditDeal[];
  /** ORW-691 (`ORWELL_EDIT_MOMENTS`): when set, the cut also reads replacements, house meetings and schemes (all three were weighted but never emitted). Absent = the old cut, byte-identical. */
  more?: { meetings: readonly EditMeeting[] };
  winner: EntityId | null;
  /** ORW-747: the season's alliances (absent = the edit without them, byte-identical). */
  alliances?: readonly EditAlliance[];
  jury?: { finalists: readonly EntityId[]; votes: ReadonlyArray<{ votedFor: EntityId }> };
}

/** The reconstructed week of every log position: each eviction announcement closes a week. */
export function weeksOfLog(events: ReadonlyArray<{ type: string; hidden: boolean; content: string }>, evictionCue: string, maxWeek: number): number[] {
  let week = 1;
  const out: number[] = [];
  for (const e of events) {
    out.push(Math.min(Math.max(1, maxWeek), week));
    if (e.type === "house-event" && !e.hidden && e.content.includes(evictionCue)) week += 1;
  }
  return out;
}

const rank = (a: { w: number; i: number }, b: { w: number; i: number }): number => b.w - a.w || a.i - b.i;

interface Tally { net: number; abs: number; kept: number; broke: number; betrayed: number; facts: Array<{ w: number; i: number; f: EditFact }> }

export function buildYourEdit(inp: YourEditInput): YourEditView {
  const name = inp.nameOf;
  const factOf = (m: EditMoment): EditFact => ({ kind: m.kind, ...(m.actor ? { actor: name(m.actor) } : {}), ...(m.subject ? { subject: name(m.subject) } : {}) });
  const weekOf = new Map<number, EditMoment[]>();
  const all: EditMoment[] = [];
  const add = (m: EditMoment): void => { all.push(m); (weekOf.get(m.week) ?? weekOf.set(m.week, []).get(m.week)!).push(m); };
  const maxWeek = inp.digests.reduce((a, d) => Math.max(a, d.week), 1);
  for (const d of inp.digests) {
    if (d.evictee === null) continue;
    const rec = inp.voteRecord.find((r) => r.week === d.week && r.evictee === d.evictee);
    for (const m of weekMoments(d, rec ? Object.values(rec.voteOf) : [], inp.calledPawn(d.week, d.evictee))) add(m);
    if (inp.more && d.replacement) add({ kind: "replacement", ...(d.hoh ? { actor: d.hoh } : {}), subject: d.replacement, week: d.week, public: true });
  }
  if (inp.more) for (const mt of inp.more.meetings) add({ kind: "house-meeting", actor: mt.caller, subject: mt.accused, week: Math.min(maxWeek, mt.week), crowd: mt.attendees, public: true });
  inp.events.forEach((e, i) => { const m = sceneMoment(e, Math.min(maxWeek, inp.eventWeeks[i] ?? maxWeek), !!inp.more); if (m) add(m); });

  const tallies = new Map<EntityId, Tally>();
  const tally = (id: EntityId): Tally => tallies.get(id) ?? tallies.set(id, { net: 0, abs: 0, kept: 0, broke: 0, betrayed: 0, facts: [] }).get(id)!;
  let order = 0;
  const credit = (id: EntityId, w: number, sign: number, f: EditFact): void => {
    const t = tally(id);
    t.net += w * sign; t.abs += Math.abs(w * sign);
    if (sign !== 0) t.facts.push({ w: Math.abs(w * sign), i: order++, f });
  };
  for (const m of all) {
    const w = editWorthiness(m), f = factOf(m);
    if (m.actor) { credit(m.actor, w, YOUR_EDIT.actor[m.kind], f); if (m.kind === "betrayal") tally(m.actor).betrayed += 1; }
    if (m.subject) credit(m.subject, w, YOUR_EDIT.subject[m.kind], f);
  }
  let dealsKept = 0, dealsBroken = 0, dealsBrokenOnYou = 0;
  for (const d of inp.deals) {
    if (d.status === "kept") {
      for (const p of d.parties) { credit(p, YOUR_EDIT.keptWorth, 1, { kind: "veto-save" }); tally(p).kept += 1; if (p === inp.player) dealsKept += 1; }
    } else if (d.status === "broken" && d.brokenBy) {
      const other = d.parties.find((p) => p !== d.brokenBy);
      const m: EditMoment = { kind: "betrayal", actor: d.brokenBy, ...(other ? { subject: other } : {}), week: maxWeek, public: false };
      const w = editWorthiness(m), f = factOf(m);
      credit(d.brokenBy, w, YOUR_EDIT.actor.betrayal, f); tally(d.brokenBy).broke += 1;
      if (other) credit(other, w, YOUR_EDIT.subject.betrayal, f);
      if (d.brokenBy === inp.player) dealsBroken += 1; else if (other === inp.player) dealsBrokenOnYou += 1;
    }
  }

  const bandOf = (id: EntityId): EditBand | "mixed" | "background" => {
    const t = tallies.get(id);
    if (!t || t.abs < YOUR_EDIT.onScreenAt) return "background";
    const edit = t.net / (t.abs + YOUR_EDIT.prior);
    if (edit <= YOUR_EDIT.villainAt) return "villain";
    if (edit >= YOUR_EDIT.heroAt) return t.broke === 0 && t.betrayed === 0 ? "hero" : "mixed";
    return "mixed";
  };
  const top = (id: EntityId, n: number): EditFact[] => (tallies.get(id)?.facts ?? []).slice().sort(rank).slice(0, n).map((x) => x.f);
  const everyone = [inp.player, ...inp.cast.filter((c) => c !== inp.player)];
  const scoreOf = (id: EntityId): number => { const t = tallies.get(id)!; return t.net / (t.abs + YOUR_EDIT.prior); };
  const pick = (band: EditBand): EditedHouseguest[] => everyone
    .filter((id) => bandOf(id) === band)
    .sort((a, b) => (band === "hero" ? scoreOf(b) - scoreOf(a) : scoreOf(a) - scoreOf(b)) || (a < b ? -1 : 1))
    .slice(0, YOUR_EDIT.castCap)
    .map((id) => ({ name: name(id), edit: band, because: top(id, 2), line: editLine(name(id), band, top(id, 2)) }));

  const episodes: EditEpisode[] = [];
  for (const d of inp.digests) {
    if (d.evictee === null) continue;
    const ms = (weekOf.get(d.week) ?? []).map((m, i) => ({ w: editWorthiness(m), i, m })).sort(rank).slice(0, YOUR_EDIT.episodeMoments);
    const close = (weekOf.get(d.week) ?? []).some((m) => (m.kind === "eviction" || m.kind === "blindside") && (m.twist ?? 0) >= YOUR_EDIT.closeAt);
    const moments = ms.map((x) => factOf(x.m));
    const alliances = allianceBeats(inp.alliances, d.week);
    episodes.push({ week: d.week, ...(d.hoh ? { hoh: name(d.hoh) } : {}), evictee: name(d.evictee), ...(close ? { close } : {}), moments, ...(alliances.length ? { alliances } : {}), title: episodeTitle(d.week, moments[0], close) });
  }
  if (inp.winner) {
    episodes.push({ week: maxWeek + 1, crown: name(inp.winner), moments: [], title: `The Crown: ${name(inp.winner)}` });
  }

  const youBand = bandOf(inp.player);
  const youTop = top(inp.player, 3);
  const count = (kind: EditMomentKind, as: "actor" | "subject"): number => all.filter((m) => m.kind === kind && m[as] === inp.player).length;
  const betrayalsDealt = count("betrayal", "actor") + dealsBroken;
  const me = name(inp.player);
  const yours: YourAlliance[] = (inp.alliances ?? []).filter((a) => a.youWere).map((a) => ({
    name: a.name, with: a.members.filter((m) => m !== me),
    ...(a.formedWeek !== undefined ? { formedWeek: a.formedWeek } : {}), ...(a.endedWeek !== undefined ? { endedWeek: a.endedWeek } : {}), ...(a.endedHow ? { endedHow: a.endedHow } : {}),
  }));
  const jury = inp.jury ? { votesForYou: inp.jury.votes.filter((v) => v.votedFor === inp.player).length, jurors: inp.jury.votes.length } : undefined;
  return {
    episodes,
    heroes: pick("hero"),
    villains: pick("villain"),
    you: {
      band: youBand, dealsKept, dealsBroken, dealsBrokenOnYou,
      blindsidesDealt: count("blindside", "actor"), blindsidesReceived: count("blindside", "subject"),
      betrayalsDealt, betrayalsReceived: count("betrayal", "subject") + dealsBrokenOnYou, compWins: count("comp-win", "actor"),
      ...(jury ? { jury } : {}),
      because: youTop,
      line: youLine(youBand, dealsBroken, betrayalsDealt),
      ...(yours.length ? { alliances: yours } : {}),
    },
  };
}

/** ORW-747: the alliances that formed or ended in one week, formed first, each group in name order (deterministic). */
function allianceBeats(all: readonly EditAlliance[] | undefined, week: number): EditAllianceBeat[] {
  if (!all?.length) return [];
  const byName = (a: EditAlliance, b: EditAlliance): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const formed = all.filter((a) => a.formedWeek === week).sort(byName).map((a): EditAllianceBeat => ({ name: a.name, members: [...a.members], what: "formed" }));
  const ended = all.filter((a) => a.endedWeek === week).sort(byName).map((a): EditAllianceBeat => ({ name: a.name, members: [...a.members], what: "ended", ...(a.endedHow ? { how: a.endedHow } : {}) }));
  return [...formed, ...ended];
}

/** The floor title: composed from the week, the top moment's kind and its names (the names carry the variety; the live narrator replaces the whole line). */
const KIND_NOUN: Readonly<Record<EditMomentKind, string>> = {
  "comp-win": "the Crown Changes Hands", "veto-save": "the Save", "veto-kept": "the Veto Stays Put", replacement: "the Replacement", nomination: "the Block", eviction: "the Walk Out",
  blindside: "the Blindside", blowup: "the Blow-Up", betrayal: "the Backstab", "house-meeting": "the House Meeting", showmance: "the Spark", scheme: "the Scheme",
};
export function episodeTitle(week: number, lead: EditFact | undefined, close: boolean): string {
  if (!lead) return `Week ${week}`;
  const noun = KIND_NOUN[lead.kind];
  const who = lead.subject ?? lead.actor;
  const core = lead.actor && lead.subject ? `${lead.actor} and ${noun}: ${lead.subject}` : who ? `${noun[0]!.toUpperCase()}${noun.slice(1)}: ${who}` : `${noun[0]!.toUpperCase()}${noun.slice(1)}`;
  return `Week ${week}, ${core}${close ? ", By a Hair" : ""}`;
}
function editLine(who: string, band: EditBand, because: readonly EditFact[]): string {
  const bits = because.map((f) => `${KIND_NOUN[f.kind]}${f.actor && f.actor !== who ? ` (${f.actor})` : f.subject && f.subject !== who ? ` (${f.subject})` : ""}`);
  return `${who}: cut as the ${band}${bits.length ? ", on the strength of " + bits.join(" and ") : ""}`;
}
function youLine(band: EditBand | "mixed" | "background", broke: number, betrayals: number): string {
  if (band === "hero") return "You came across as the hero: you kept your word and the cut gave you the credit";
  if (band === "villain") return `You came across as the villain${broke ? ": you broke your word" : betrayals ? ": you turned on people" : ""}, and the cut showed it`;
  if (band === "mixed") return `You came across as a mix${broke || betrayals ? ": the cut did not forget what you did to people" : ""}`;
  return "You came across as a background figure: the cut hardly followed you";
}
