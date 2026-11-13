import { Given, When, Then, After } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import {
  seedAgenda, recheckAgenda, stubbornnessOf, mullAgenda, isAgendaSuperset, evaluateTest, type Agenda, type AgendaBoard, type AgendaView, type AgendaCharacter, type Goal,
} from "../../src/engine/agenda";
import type { Archetype, StrategyStyle } from "../../src/engine/characterFactory";
import { PLAYER } from "../../src/domain/ids";
import { goalPull } from "../../src/engine/agendaDecisions";
import { nominationPlan } from "../../src/engine/season";
import { RelationshipModel } from "../../src/engine/relationships";
import { STATED_REASON_GLOSS } from "../../src/engine/momentPrompts";
import { playSeason, startPlayedSeason } from "../../tests/support/agendaSeasonDriver";

/**
 * FEATURE 0145 / ORW-312 - NPC agendas on the live season. Each scenario drives a REAL played season (the real cast, the real views the engine builds from each holder's own edges, memories,
 * soul and alliances) and then applies the pressure the scenario names to a real houseguest's view. Roles only: holder, rival, ally, other, HOH, nominee.
 */
interface Ctx {
  s: GameSessionAdapter; ids: string[]; seed: number;
  view: AgendaView; agenda: Agenda; before?: Agenda; other?: { view: AgendaView; agenda: Agenda; after?: Agenda };
  after?: Agenda; board: AgendaBoard; extra: Record<string, unknown>;
}
const SEED = 5;
const ctxOf = (w: unknown): Ctx => (w as { ag: Ctx }).ag;
const priv = (s: GameSessionAdapter) => s as unknown as { agendaView(id: string): AgendaView; agendaBoard(): AgendaBoard };
const live = (s: GameSessionAdapter): { agendas?: Record<string, Agenda> } => s.snapshot().live as unknown as { agendas?: Record<string, Agenda> };
const active = (a: Agenda, kind: string, target?: string): Goal | undefined => a.goals.find((g) => g.kind === kind && (target === undefined || g.target === target));
const resolved = (a: Agenda, kind: string, target?: string): Goal | undefined => a.history.find((g) => g.kind === kind && (target === undefined || g.target === target));

/** A real houseguest's REAL view, with the pressure the scenario names laid over it (their own reads cleared so only the named pressure counts). */
function viewFor(c: Ctx, idx: number, archetype: Archetype, style: StrategyStyle, over: Partial<AgendaView> = {}, character: Partial<AgendaCharacter> = {}): AgendaView {
  const real = priv(c.s).agendaView(c.ids[idx]!);
  return { ...real, threats: [], affinity: [], grudges: [], emotional: 0.5, allianceMates: [], secretExposed: false, openQuestions: [], answered: [], powerWins: 0,
    character: { archetype, strategyStyle: style, secretKinds: [], ...character }, ...over };
}
const boardOf = (c: Ctx, over: Partial<AgendaBoard> = {}): AgendaBoard => ({ ...c.board, ...over });
const without = (c: Ctx, id: string): string[] => c.board.inHouse.filter((p) => p !== id);

Given("a season has started with a full cast", function () {
  const s = startPlayedSeason(SEED);
  const board = priv(s).agendaBoard();
  const ids = Object.keys(live(s).agendas ?? {});
  const holder = ids[0]!;
  const c = { s, ids, seed: SEED, board: { ...board, day: 2, week: 1 }, extra: {} } as unknown as Ctx;
  c.view = viewFor(c, 0, "villain", "aggressive");
  c.agenda = live(s).agendas![holder]!;
  (this as unknown as { ag: Ctx }).ag = c;
});
After(function () { GameSessionAdapter.setTimeOfDayEnabled(false); });

// --- season aims --------------------------------------------------------------------------------------------------------
Then("every houseguest other than the player holds one main season aim", function () {
  const c = ctxOf(this); const ag = live(c.s).agendas!;
  assert.equal(Object.keys(ag).length, 15);
  assert.equal(ag[PLAYER], undefined, "the player never gets an agenda");
  const main = ["win-by-comps", "win-by-being-liked", "run-the-house", "reach-jury", "last-alliance-standing", "prove-not-a-floater"];
  for (const a of Object.values(ag)) assert.equal(a.goals.filter((g) => g.horizon === "season" && main.includes(g.kind)).length, 1, a.owner);
});
Then("a competitor's aim is to win competitions and a schemer's aim is to run the house", function () {
  const c = ctxOf(this);
  const aim = (k: Archetype, style: StrategyStyle, i: number): string => seedAgenda(viewFor(c, i, k, style), c.board, c.seed).goals.find((g) => g.horizon === "season")!.kind;
  assert.equal(aim("comp-beast", "competitive" as StrategyStyle, 1), "win-by-comps");
  assert.equal(aim("mastermind", "strategic" as StrategyStyle, 2), "run-the-house");
});
Then("every goal names the real reason it exists", function () {
  for (const a of Object.values(live(ctxOf(this).s).agendas!)) for (const g of [...a.goals, ...a.history]) assert.ok(g.why.length > 0, `${a.owner} ${g.kind}`);
});
Then("the cast holds at least four different season aims", function () {
  const aims = new Set(Object.values(live(ctxOf(this).s).agendas!).flatMap((a) => a.goals.filter((g) => g.horizon === "season").map((g) => g.kind)));
  assert.ok(aims.size >= 4, [...aims].join());
});

// --- secrets ------------------------------------------------------------------------------------------------------------
Given("a houseguest carries a secret or a hidden tie from before the show", function () {
  const c = ctxOf(this);
  c.view = viewFor(c, 0, "analyst", "strategic", {}, { secretKinds: ["secret-motive"] });
  c.extra.noSecretView = viewFor(c, 1, "analyst", "strategic", {}, { secretKinds: [] });
});
Then("keeping that secret is one of their season goals", function () {
  const c = ctxOf(this);
  assert.ok(active(seedAgenda(c.view, c.board, c.seed), "keep-my-secret"));
  const tie = viewFor(c, 0, "analyst", "strategic", {}, { preShowTie: { with: c.ids[2]!, hidden: true, friendly: true } });
  assert.ok(active(seedAgenda(tie, c.board, c.seed), "keep-my-secret"), "a hidden pre-show tie counts too");
});
Then("a houseguest with no secret holds no such goal", function () {
  const c = ctxOf(this);
  assert.equal(active(seedAgenda(c.extra.noSecretView as AgendaView, c.board, c.seed), "keep-my-secret"), undefined);
});

// --- week goals ---------------------------------------------------------------------------------------------------------
Given("a houseguest sees another houseguest as a big threat", function () {
  const c = ctxOf(this);
  c.view = viewFor(c, 0, "villain", "aggressive", { threats: [{ toward: c.ids[1]!, threat: 0.8 }] });
  c.agenda = seedAgenda(c.view, c.board, c.seed);
});
Then("one of their goals this week is to get that houseguest out", function () { assert.ok(active(ctxOf(this).agenda, "get-them-out", ctxOf(this).ids[1])); });
Then("the goal's reason points at that threat read", function () {
  const c = ctxOf(this);
  assert.ok(active(c.agenda, "get-them-out", c.ids[1])!.why.some((w) => w.kind === "threat-read" && w.about === c.ids[1]));
});
Then("the goal counts as done only when that houseguest is evicted", function () {
  const c = ctxOf(this); const g = active(c.agenda, "get-them-out", c.ids[1])!;
  assert.deepEqual(g.test, { kind: "evicted", who: c.ids[1] });
  assert.equal(evaluateTest(g.test, c.view.owner, c.view, c.board), "open");
  assert.equal(evaluateTest(g.test, c.view.owner, c.view, boardOf(c, { evicted: [c.ids[1]!], inHouse: without(c, c.ids[1]!) })), "achieved");
});
Given("the houseguest a holder fears most is the HOH", function () {
  const c = ctxOf(this);
  c.view = viewFor(c, 0, "villain", "aggressive", { threats: [{ toward: c.ids[1]!, threat: 0.9 }] });
  c.board = boardOf(c, { hoh: c.ids[1]! });
  c.agenda = seedAgenda(c.view, c.board, c.seed);
});
Then("the holder does not aim to evict the HOH this week", function () { assert.equal(active(ctxOf(this).agenda, "get-them-out", ctxOf(this).ids[1]), undefined); });
When("a houseguest is nominated", function () {
  const c = ctxOf(this);
  c.view = viewFor(c, 0, "floater", "social", { threats: [{ toward: c.ids[1]!, threat: 0.7 }] });
  const calm = seedAgenda(c.view, c.board, c.seed);
  c.after = recheckAgenda(calm, c.view, boardOf(c, { nominees: [c.ids[0]!, c.ids[2]!], hoh: c.ids[3]! }), "nominated", c.seed);
});
Then("staying safe becomes their strongest goal this week, tied to the nomination", function () {
  const top = [...ctxOf(this).after!.goals.filter((g) => g.horizon === "week")].sort((a, b) => b.commitment - a.commitment)[0]!;
  assert.equal(top.kind, "stay-safe");
  assert.ok(top.why.some((w) => w.kind === "board" && w.ref === "nominated"));
});

// --- goals outlive moods ------------------------------------------------------------------------------------------------
Given("a houseguest is after a target", function () {
  const c = ctxOf(this);
  c.view = viewFor(c, 0, "hothead", "emotional", { threats: [{ toward: c.ids[1]!, threat: 0.75 }] });
  c.agenda = seedAgenda(c.view, c.board, c.seed);
  assert.ok(active(c.agenda, "get-them-out", c.ids[1]));
});
When("their mood swings but nothing else changes", function () {
  const c = ctxOf(this); c.after = recheckAgenda(c.agenda, { ...c.view, emotional: 0.15 }, boardOf(c, { day: 3 }), "comp-result", c.seed);
});
Then("they are still after the same target", function () {
  const c = ctxOf(this); assert.equal(active(c.after!, "get-them-out", c.ids[1])?.id, active(c.agenda, "get-them-out", c.ids[1])!.id);
});
Given("two houseguests are each after three targets", function () {
  const c = ctxOf(this);
  const mk = (i: number, k: Archetype, style: StrategyStyle) => {
    const v0 = viewFor(c, i, k, style, { threats: [{ toward: c.ids[5]!, threat: 0.62 }, { toward: c.ids[6]!, threat: 0.6 }, { toward: c.ids[7]!, threat: 0.58 }] });
    return { view: v0, agenda: seedAgenda(v0, c.board, c.seed) };
  };
  // The person, not only the type: of the first few real houseguests, the most and the least stubborn (by their own archetype/style/offset) are the two we compare.
  const stub = (i: number, k: Archetype, st: StrategyStyle): number => stubbornnessOf({ archetype: k, strategyStyle: st, secretKinds: [] }, c.ids[i]!, c.seed);
  const order = [0, 1, 2, 3, 4].sort((a, b) => stub(a, "loyalist", "loyal") - stub(b, "loyalist", "loyal"));
  c.extra.stubborn = mk(order[4]!, "loyalist", "loyal"); c.extra.flexible = mk(order[0]!, "wildcard", "social");
});
When("a slightly bigger threat appears", function () {
  const c = ctxOf(this);
  for (const key of ["stubborn", "flexible"]) {
    const p = c.extra[key] as { view: AgendaView; agenda: Agenda; after?: Agenda };
    p.after = recheckAgenda(p.agenda, { ...p.view, threats: [...p.view.threats, { toward: c.ids[8]!, threat: 0.7 }] }, boardOf(c, { day: 3 }), "comp-result", c.seed);
  }
});
Then("the stubborn one keeps their targets and the flexible one switches, and the dropped goal is kept as replaced", function () {
  const c = ctxOf(this);
  const st = c.extra.stubborn as { after: Agenda }, fl = c.extra.flexible as { after: Agenda };
  assert.equal(active(st.after, "get-them-out", c.ids[8]), undefined);
  assert.ok(active(fl.after, "get-them-out", c.ids[8]));
  assert.equal(resolved(fl.after, "get-them-out")?.status, "replaced");
});

// --- resolution ---------------------------------------------------------------------------------------------------------
When("that target is evicted", function () {
  const c = ctxOf(this);
  c.after = recheckAgenda(c.agenda, c.view, boardOf(c, { day: 5, evicted: [c.ids[1]!], inHouse: without(c, c.ids[1]!), weekClosed: true }), "eviction", c.seed);
});
Then("the goal is marked achieved and kept in the houseguest's history", function () {
  const c = ctxOf(this); assert.equal(resolved(c.after!, "get-them-out", c.ids[1])?.status, "achieved"); assert.ok(isAgendaSuperset(c.agenda, c.after!));
});
Given("a houseguest was after a target who survived the week", function () {
  const c = ctxOf(this);
  c.view = viewFor(c, 0, "hothead", "emotional", { threats: [{ toward: c.ids[1]!, threat: 0.7 }] });
  c.agenda = seedAgenda(c.view, c.board, c.seed);
});
When("the week closes", function () {
  const c = ctxOf(this);
  c.after = recheckAgenda(c.agenda, c.view, boardOf(c, { day: 5, evicted: [c.ids[4]!], inHouse: without(c, c.ids[4]!), weekClosed: true }), "week-closed", c.seed);
});
Then("that goal is marked failed", function () {
  const c = ctxOf(this);
  if (c.extra.secretCase) assert.equal(resolved(c.after!, "keep-my-secret")?.status, "failed");
  else assert.equal(resolved(c.after!, "get-them-out", c.ids[1])?.status, "failed");
});
Then("next week they are after the same target, a little harder, with the carry-over as a reason", function () {
  const c = ctxOf(this); const again = active(c.after!, "get-them-out", c.ids[1])!;
  assert.equal(again.formedWeek, 2);
  assert.ok(again.why.some((w) => w.kind === "carry-over" && w.about === c.ids[1]));
  assert.ok(again.commitment > resolved(c.after!, "get-them-out", c.ids[1])!.commitment - 1e-9);
});
When("a houseguest is badly betrayed by another", function () {
  const c = ctxOf(this);
  c.view = viewFor(c, 0, "hothead", "emotional");
  const a = seedAgenda(c.view, c.board, c.seed);
  c.after = recheckAgenda(a, { ...c.view, grudges: [{ toward: c.ids[1]!, salience: 0.8, ref: "deal-broken" }] }, boardOf(c, { day: 4 }), "betrayed", c.seed);
});
Then("getting revenge on the betrayer becomes a season-long goal, tied to the memory of the betrayal", function () {
  const c = ctxOf(this); const g = active(c.after!, "revenge", c.ids[1])!;
  assert.equal(g.horizon, "season");
  assert.ok(g.why.some((w) => w.kind === "memory" && w.about === c.ids[1] && w.ref === "deal-broken"));
});
Given("a houseguest is keeping a secret", function () {
  const c = ctxOf(this); c.extra.secretCase = true;
  c.view = viewFor(c, 0, "analyst", "strategic", {}, { secretKinds: ["secret-motive"] });
  c.agenda = seedAgenda(c.view, c.board, c.seed);
  assert.ok(active(c.agenda, "keep-my-secret"));
});
When("the secret is exposed", function () {
  const c = ctxOf(this); c.after = recheckAgenda(c.agenda, { ...c.view, secretExposed: true }, boardOf(c, { day: 6 }), "secret-exposed", c.seed);
});
When("a houseguest is evicted", function () {
  const c = ctxOf(this);
  c.view = viewFor(c, 0, "villain", "aggressive", { threats: [{ toward: c.ids[1]!, threat: 0.8 }] });
  c.agenda = seedAgenda(c.view, c.board, c.seed);
  c.after = recheckAgenda(c.agenda, c.view, boardOf(c, { day: 5, evicted: [c.view.owner], inHouse: without(c, c.view.owner), weekClosed: true }), "eviction", c.seed);
});
Then("they hold no active goals and every goal they held is in their history", function () {
  const c = ctxOf(this); assert.deepEqual(c.after!.goals, []); assert.equal(c.after!.history.length, c.agenda.goals.length);
});

// --- nothing is lost: a real season, saved and reloaded -----------------------------------------------------------------
When("a season is played week after week and saved and reloaded", function () {
  const c = ctxOf(this);
  const early = playSeason(c.seed, { stopAtWeek: 1 }); const late = playSeason(c.seed, { stopAtWeek: 3 });
  c.extra.early = live(early.s).agendas; c.extra.late = live(late.s).agendas;
  const restored = startPlayedSeason(c.seed + 1);
  restored.restore(JSON.parse(JSON.stringify(late.s.snapshot())));
  c.extra.restored = live(restored).agendas;
});
Then("every houseguest's goal history only grows and reloads identical", function () {
  const c = ctxOf(this); const early = c.extra.early as Record<string, Agenda>, late = c.extra.late as Record<string, Agenda>;
  assert.equal(Object.keys(late).length, 15);
  for (const [id, a] of Object.entries(early)) assert.ok(isAgendaSuperset(a, late[id]!), `${id} history thinned`);
  assert.ok(Object.values(late).reduce((t, a) => t + a.history.length, 0) > Object.values(early).reduce((t, a) => t + a.history.length, 0));
  assert.deepEqual(c.extra.restored, late);
});

// --- the nightly mull ---------------------------------------------------------------------------------------------------
When("a houseguest sleeps without having made progress on a goal", function () {
  const c = ctxOf(this);
  const fade = (k: Archetype, style: StrategyStyle, i: number): { before: number; after: number; agenda: Agenda; view: AgendaView } => {
    const v = viewFor(c, i, k, style, { affinity: [{ toward: c.ids[5]!, affinity: 0.65 }] });
    const a = seedAgenda(v, c.board, c.seed); const g0 = active(a, "pull-them-in", c.ids[5])!;
    const m = mullAgenda(a, v, boardOf(c, { day: 3 }), c.seed); const g1 = active(m, "pull-them-in", c.ids[5]) ?? resolved(m, "pull-them-in", c.ids[5])!;
    return { before: g0.commitment, after: g1.commitment, agenda: a, view: v };
  };
  c.extra.flex = fade("floater", "social", 0); c.extra.firm = fade("loyalist", "loyal", 1);
  // The same night through the REAL wiring: a played season's sleep step mulls every agenda, so unprogressed goals really are given up (and kept as dropped) along the way.
  c.extra.realGaveUp = Object.values(live(playSeason(c.seed, { stopAtWeek: 2 }).s).agendas!).reduce((t, ag) => t + ag.history.filter((h) => h.status === "dropped").length, 0);
});
Then("their commitment to it fades, more for a flexible houseguest than a stubborn one", function () {
  const c = ctxOf(this); const f = c.extra.flex as { before: number; after: number }, s = c.extra.firm as { before: number; after: number };
  assert.ok(f.before - f.after > s.before - s.after && f.before - f.after > 0);
  assert.ok((c.extra.realGaveUp as number) > 0, "the real sleep step must mull the live agendas");
});
Then("a goal they give up on is kept in their history as dropped", function () {
  const c = ctxOf(this); const f = c.extra.flex as { agenda: Agenda; view: AgendaView };
  let a = f.agenda;
  for (let d = 3; d < 30; d++) a = mullAgenda(a, f.view, boardOf(c, { day: d }), c.seed);
  assert.ok(a.history.some((g) => g.status === "dropped"));
});
Then("keeping a secret is never given up", function () {
  const c = ctxOf(this); const v = viewFor(c, 0, "floater", "social", {}, { secretKinds: ["divergent-persona"] });
  let a = seedAgenda(v, c.board, c.seed);
  for (let d = 3; d < 30; d++) a = mullAgenda(a, v, boardOf(c, { day: d }), c.seed);
  assert.ok(active(a, "keep-my-secret"));
});

// --- long cons ----------------------------------------------------------------------------------------------------------
Then("only masterminds, villains, analysts or strategic players ever start a long con, and not every one of them does", function () {
  const c = ctxOf(this); let with_ = 0, eligible = 0;
  const con = (k: Archetype, style: StrategyStyle, i: number, seed: number) => seedAgenda(viewFor(c, i, k, style, { threats: [{ toward: c.ids[1]!, threat: 0.6 }], affinity: [{ toward: c.ids[1]!, affinity: 0.7 }] }), c.board, seed);
  for (let i = 0; i < 40; i++) {
    for (const [k, st] of [["mastermind", "under-the-radar"], ["villain", "aggressive"], ["social-butterfly", "strategic"]] as const) { eligible++; if (active(con(k, st, 2 + (i % 10), c.seed + i), "long-con")) with_++; }
    for (const [k, st] of [["loyalist", "loyal"], ["floater", "social"], ["hothead", "emotional"]] as const) assert.equal(active(con(k, st, 2 + (i % 10), c.seed + i), "long-con"), undefined, `${k} never`);
  }
  assert.ok(with_ > 0 && with_ < eligible, `${with_}/${eligible}`);
});
Then("a long con succeeds only if the mark leaves after the jury starts", function () {
  const c = ctxOf(this); const t = { kind: "cut-later" as const, who: c.ids[1]!, stage: "jury" as const };
  assert.equal(evaluateTest(t, c.view.owner, c.view, boardOf(c, { evicted: [c.ids[1]!] })), "failed");
  assert.equal(evaluateTest(t, c.view.owner, c.view, boardOf(c, { evicted: [c.ids[1]!], juryStarted: true })), "achieved");
});

// --- secret and deterministic -------------------------------------------------------------------------------------------
Then("the same season gives the same agendas", function () {
  const c = ctxOf(this); const again = startPlayedSeason(c.seed);
  assert.deepEqual(live(again).agendas, live(c.s).agendas);
});
Then("no agenda reaches the player, the narrator or the admin view", function () {
  const c = ctxOf(this); const s = c.s;
  const token = "SENTINEL-AGENDA-BDD-312";
  const core = s.snapshot(); const lv = core.live as unknown as { agendas: Record<string, Agenda> };
  const id = c.ids[0]!;
  lv.agendas[id]!.history.push({ id: "planted", owner: id, horizon: "week", kind: "get-them-out", why: [{ kind: "memory", ref: token, weight: 1 }], test: { kind: "survives-week" }, commitment: 1, status: "failed", formedDay: 1, formedWeek: 1, endNote: token });
  s.restore(core);
  assert.ok(JSON.stringify(s.snapshot()).includes(token));
  const surfaces = [s.gameStatus(), s.getGameState(), s.getMomentPrompt("nominations" as never)];
  const text = JSON.stringify(surfaces);
  assert.ok(!text.includes(token) && !/endNote|"agendas"/.test(text));
});

// --- ORW-314: goals drive decisions; the narrator voices the stated reason ----------------------------------------------------
/** A small house where the HOH reads one candidate (`top`) as the clear threat and the goal's subject (`mark`) as a low read. */
function nominate(c: Ctx, goalKind: Goal["kind"], commitment: number, juryStarted: boolean, markRead: number): { target: string; nominees: string[] } {
  const hoh = c.ids[0]!, ids = c.ids.slice(0, 7), top = ids[1]!, mark = ids[2]!;
  const rel = new RelationshipModel(0.5);
  for (const a of ids) for (const b of ids) if (a !== b) { const e = rel.edge(a, b); e.trust = 0.5; e.affinity = 0.5; e.threat = 0.2; }
  rel.edge(hoh, top).threat = 0.9; rel.edge(hoh, mark).threat = markRead;
  const goal: Goal = { id: "g", owner: hoh, horizon: "season", kind: goalKind, target: mark, why: [{ kind: "character", weight: 1 }],
    test: goalKind === "long-con" ? { kind: "cut-later", who: mark, stage: "jury" } : { kind: "evicted", who: mark }, commitment, status: "active", formedDay: 1, formedWeek: 1 };
  const agenda: Agenda = { owner: hoh, goals: [goal], history: [], formedForWeek: 1 };
  const board: AgendaBoard = { ...c.board, juryStarted };
  const plan = nominationPlan(hoh, ids, rel, { agendaPush: (t) => goalPull(agenda, t, board, []).value });
  return { target: plan.target, nominees: [...plan.nominees] };
}
Then("an HOH holding a revenge goal on a houseguest who is not their top threat nominates that houseguest, and does not once the goal is zeroed", function () {
  const c = ctxOf(this); const mark = c.ids[2]!, top = c.ids[1]!;
  assert.equal(nominate(c, "revenge", 1, false, 0.1).target, mark);
  assert.equal(nominate(c, "revenge", 0, false, 0.1).target, top);
});
Then("a long-con holder leaves the mark off the block before the jury and nominates them once the jury has started", function () {
  const c = ctxOf(this); const mark = c.ids[2]!;
  assert.ok(!nominate(c, "long-con", 1, false, 0.55).nominees.includes(mark));
  assert.equal(nominate(c, "long-con", 1, true, 0.55).target, mark);
});
Then("the nominations prompt carries the decider's stated reason and never the goal, the terms or the candor", function () {
  const c = ctxOf(this); const s = c.s;
  const core = s.snapshot(); const lv = core.live as unknown as { hoh?: string; nominees?: string[]; week: number; dayNumber?: number; statedReasons?: unknown[] };
  const decider = c.ids[0]!, mark = c.ids[1]!, pawn = c.ids[2]!;
  lv.hoh = decider; lv.nominees = [mark, pawn];
  (lv.statedReasons ??= []).push({ week: lv.week, day: lv.dayNumber ?? lv.week, decider, decision: "nominate", public: true,
    real: { decision: "nominate", decider, choice: mark, goalKind: "revenge", goalId: "SENTINEL-BDD-314-GOAL", terms: [{ name: "SENTINEL-BDD-314-TERM", value: 1 }] }, stated: { kind: "had-it-planned", about: mark, candor: "cover" } });
  s.restore(core);
  (s as unknown as { ceremonyBeat: string }).ceremonyBeat = "nominations";
  const text = JSON.stringify([s.getMomentPrompt({ moment: "nominations" } as never), s.npcVoice(decider)]);
  assert.ok(text.includes(STATED_REASON_GLOSS["had-it-planned"]!));
  assert.ok(!/SENTINEL-BDD-314|revenge|candor|"cover"/.test(text));
});
