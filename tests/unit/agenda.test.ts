import { describe, it, expect, vi } from "vitest";
import {
  seedAgenda, recheckAgenda, mullAgenda, isAgendaSuperset, evaluateTest, canRunLongCon, stubbornnessOf, seasonLeanOf, tieAvoids,
  type Agenda, type AgendaBoard, type AgendaView, type AgendaCharacter, type Goal,
} from "../../src/engine/agenda";
import { AGENDA } from "../../src/engine/agendaConstants";
import type { Archetype, StrategyStyle } from "../../src/engine/characterFactory";

/**
 * ORW-253 slice 1 (theme 1, NPC minds; Ryne approved 2026-11-12): the pure NPC agenda. Roles only (holder, target, ally, HOH, nominee).
 * Each case maps to a scenario in docs/features/0145-npc-agendas.feature.
 */
const HOLDER = "npc:1", RIVAL = "npc:2", ALLY = "npc:3", OTHER = "npc:4", FIFTH = "npc:5";
const HOUSE = [HOLDER, RIVAL, ALLY, OTHER, FIFTH, "npc:6", "npc:7", "player"];
const SEED = 4242;

function char(archetype: Archetype, extra: Partial<AgendaCharacter> = {}, style: StrategyStyle = "social"): AgendaCharacter {
  return { archetype, strategyStyle: style, secretKinds: [], ...extra };
}
function view(character: AgendaCharacter, over: Partial<AgendaView> = {}): AgendaView {
  return {
    owner: HOLDER, character, threats: [], affinity: [], grudges: [], emotional: 0.5, allianceMates: [], secretExposed: false,
    openQuestions: [], answered: [], powerWins: 0, ...over,
  };
}
function board(over: Partial<AgendaBoard> = {}): AgendaBoard {
  return { day: 2, week: 1, inHouse: HOUSE, evicted: [], juryStarted: false, finalFive: false, nominees: [], weekClosed: false, ...over };
}
const active = (a: Agenda, kind: string, target?: string): Goal | undefined =>
  a.goals.find((g) => g.kind === kind && (target === undefined || g.target === target));
const resolved = (a: Agenda, kind: string, target?: string): Goal | undefined =>
  a.history.find((g) => g.kind === kind && (target === undefined || g.target === target));

describe("season goals come from the character", () => {
  it("every houseguest starts with one main season aim, and the archetype decides which", () => {
    expect(active(seedAgenda(view(char("comp-beast")), board(), SEED), "win-by-comps")).toBeDefined();
    expect(active(seedAgenda(view(char("mastermind")), board(), SEED), "run-the-house")).toBeDefined();
    expect(active(seedAgenda(view(char("floater")), board(), SEED), "reach-jury")).toBeDefined();
    const a = seedAgenda(view(char("loyalist")), board(), SEED);
    expect(a.goals.filter((g) => g.horizon === "season").length).toBeGreaterThanOrEqual(1);
    expect(a.goals.every((g) => g.why.length > 0), "every goal carries a reason").toBe(true);
  });

  it("a cast of different characters wants different things (at least four distinct season aims)", () => {
    const archetypes: Archetype[] = ["comp-beast", "mastermind", "social-butterfly", "floater", "villain", "underdog", "flirt", "loyalist", "wildcard", "analyst", "hothead", "peacemaker"];
    const aims = new Set(archetypes.map((k, i) => seedAgenda(view(char(k), { owner: `npc:${i + 1}` }), board(), SEED).goals.find((g) => g.horizon === "season")!.kind));
    expect(aims.size).toBeGreaterThanOrEqual(4);
  });

  it("a houseguest with a secret makes keeping it a real goal; one without a secret does not", () => {
    expect(active(seedAgenda(view(char("analyst", { secretKinds: ["secret-motive"] })), board(), SEED), "keep-my-secret")).toBeDefined();
    expect(active(seedAgenda(view(char("analyst", { preShowTie: { with: ALLY, hidden: true, friendly: true } })), board(), SEED), "keep-my-secret")).toBeDefined();
    expect(active(seedAgenda(view(char("analyst")), board(), SEED), "keep-my-secret")).toBeUndefined();
  });

  it("a friend from before the show is someone to protect", () => {
    const a = seedAgenda(view(char("peacemaker", { preShowTie: { with: ALLY, hidden: false, friendly: true } })), board(), SEED);
    const g = active(a, "protect-my-person", ALLY)!;
    expect(g.why[0]).toMatchObject({ kind: "pre-show-tie", about: ALLY });
  });
});

describe("the person, not only the type", () => {
  it("houseguests of the same archetype want different things when their style and philosophy differ", () => {
    const share = (c: AgendaCharacter): number => Array.from({ length: 40 }, (_, i) =>
      seedAgenda(view(c, { owner: `npc:p${i}` }), board(), SEED).goals.find((g) => g.horizon === "season")!.kind).filter((k) => k === "last-alliance-standing").length / 40;
    const loyal = share(char("social-butterfly", { philosophy: "loyal-soldier" }, "loyal"));
    const plain = share(char("social-butterfly", { philosophy: "social-climber" }, "social"));
    expect(loyal - plain, `loyal ${loyal} vs plain ${plain}`).toBeGreaterThan(0.3);
    expect(seasonLeanOf(char("floater", { philosophy: "loyal-soldier" }, "loyal"))["last-alliance-standing"]).toBeCloseTo(0.65, 5);
  });

  it("stubbornness belongs to the person: style, how easily they are swayed, and a personal offset all count", () => {
    const k = char("analyst", {}, "strategic");
    expect(stubbornnessOf({ ...k, strategyStyle: "loyal" }, HOLDER, SEED)).toBeGreaterThan(stubbornnessOf(k, HOLDER, SEED));
    expect(stubbornnessOf({ ...k, susceptibility: 0.9 }, HOLDER, SEED)).toBeLessThan(stubbornnessOf({ ...k, susceptibility: 0.1 }, HOLDER, SEED));
    const people = new Set(Array.from({ length: 12 }, (_, i) => stubbornnessOf(k, `npc:${i}`, SEED).toFixed(3)));
    expect(people.size, "no two people of one type need hold on the same").toBeGreaterThan(6);
  });
});

describe("week goals come from the holder's own reads, with a reason and a success test", () => {
  it("a strong threat read becomes 'get them out', tied to that read, tested by their eviction", () => {
    const a = seedAgenda(view(char("villain"), { threats: [{ toward: RIVAL, threat: 0.8 }] }), board(), SEED);
    const g = active(a, "get-them-out", RIVAL)!;
    expect(g.why).toContainEqual({ kind: "threat-read", about: RIVAL, weight: 0.8 });
    expect(g.test).toEqual({ kind: "evicted", who: RIVAL });
  });

  it("the HOH is never a 'get them out' target that week (they cannot be evicted)", () => {
    const a = seedAgenda(view(char("villain"), { threats: [{ toward: RIVAL, threat: 0.9 }] }), board({ hoh: RIVAL }), SEED);
    expect(active(a, "get-them-out", RIVAL)).toBeUndefined();
  });

  it("being nominated puts 'stay safe' first, tied to the nomination", () => {
    const calm = seedAgenda(view(char("floater"), { threats: [{ toward: RIVAL, threat: 0.7 }] }), board(), SEED);
    const onBlock = recheckAgenda(calm, view(char("floater"), { threats: [{ toward: RIVAL, threat: 0.7 }] }), board({ nominees: [HOLDER, OTHER], hoh: FIFTH }), "nominated", SEED);
    const top = [...onBlock.goals.filter((g) => g.horizon === "week")].sort((a, b) => b.commitment - a.commitment)[0]!;
    expect(top.kind).toBe("stay-safe");
    expect(top.why).toContainEqual(expect.objectContaining({ kind: "board", ref: "nominated" }));
  });

  it("an ally on the block becomes 'keep them safe'", () => {
    const v = view(char("loyalist"), { affinity: [{ toward: ALLY, affinity: 0.8 }], allianceMates: [ALLY] });
    const a = recheckAgenda(seedAgenda(v, board(), SEED), v, board({ nominees: [ALLY, OTHER], hoh: FIFTH }), "nominated", SEED);
    expect(active(a, "keep-them-safe", ALLY)?.test).toEqual({ kind: "still-in", who: ALLY });
  });
});

describe("goals outlive moods", () => {
  it("a mood swing alone does not change who the holder is after", () => {
    const v = view(char("hothead"), { threats: [{ toward: RIVAL, threat: 0.75 }] });
    const a = seedAgenda(v, board(), SEED);
    const before = active(a, "get-them-out", RIVAL)!;
    const shaken = recheckAgenda(a, { ...v, emotional: 0.15 }, board({ day: 3 }), "comp-result", SEED);
    expect(active(shaken, "get-them-out", RIVAL)?.id).toBe(before.id);
  });

  it("a slightly bigger new threat does not replace a held target for a stubborn holder, but does for a flexible one", () => {
    const run = (k: Archetype) => {
      // A holder gets ONE get-them-out week goal (ORW-350), so a new, bigger threat must REPLACE the held target (RIVAL), never add a second.
      const v0 = view(char(k), { threats: [{ toward: RIVAL, threat: 0.62 }, { toward: OTHER, threat: 0.6 }, { toward: FIFTH, threat: 0.58 }], emotional: 0.5 });
      const a = seedAgenda(v0, board(), SEED);
      const v1 = { ...v0, threats: [...v0.threats, { toward: "npc:6", threat: 0.7 }] };
      return recheckAgenda(a, v1, board({ day: 3 }), "comp-result", SEED);
    };
    expect(active(run("loyalist"), "get-them-out", "npc:6"), "a loyalist holds on").toBeUndefined();
    expect(active(run("wildcard"), "get-them-out", "npc:6"), "a wildcard switches").toBeDefined();
    expect(resolved(run("wildcard"), "get-them-out")?.status).toBe("replaced");
  });
});

describe("a week is not all scheming (ORW-350)", () => {
  it("a holder with several threat reads keeps ONE get-them-out week goal, and the other slots go to other things", () => {
    const v = view(char("villain"), { threats: [{ toward: RIVAL, threat: 0.8 }, { toward: OTHER, threat: 0.75 }, { toward: FIFTH, threat: 0.7 }], affinity: [{ toward: ALLY, affinity: 0.8 }], emotional: 0.5 });
    const a = seedAgenda(v, board(), SEED);
    const week = a.goals.filter((g) => g.horizon === "week");
    expect(week.filter((g) => g.kind === "get-them-out"), "one get-them-out").toHaveLength(1);
    expect(week[0]!.kind === "get-them-out" || week.some((g) => g.kind === "get-them-out")).toBe(true);
    expect(week.length, "the other slots are used by other kinds").toBeGreaterThan(1);
    expect(week.find((g) => g.kind === "get-them-out")?.target, "the strongest threat is the one kept").toBe(RIVAL);
  });
});

describe("goals resolve by their tests, and nothing is ever lost", () => {
  it("'get them out' is achieved when the target is evicted, and kept in history", () => {
    const v = view(char("villain"), { threats: [{ toward: RIVAL, threat: 0.8 }] });
    const a = seedAgenda(v, board(), SEED);
    const after = recheckAgenda(a, v, board({ day: 5, evicted: [RIVAL], inHouse: HOUSE.filter((p) => p !== RIVAL), weekClosed: true }), "eviction", SEED);
    expect(resolved(after, "get-them-out", RIVAL)?.status).toBe("achieved");
    expect(isAgendaSuperset(a, after)).toBe(true);
  });

  it("at week close an unmet week goal fails, next week's goals form, and the failed target carries over with a bonus", () => {
    const v = view(char("hothead"), { threats: [{ toward: RIVAL, threat: 0.7 }] });
    const a = seedAgenda(v, board(), SEED);
    const closed = recheckAgenda(a, v, board({ day: 5, evicted: [OTHER], inHouse: HOUSE.filter((p) => p !== OTHER), weekClosed: true }), "week-closed", SEED);
    expect(resolved(closed, "get-them-out", RIVAL)?.status).toBe("failed");
    const again = active(closed, "get-them-out", RIVAL)!;
    expect(again.formedWeek).toBe(2);
    expect(again.why).toContainEqual(expect.objectContaining({ kind: "carry-over", about: RIVAL }));
    expect(again.commitment).toBeCloseTo(0.7 + AGENDA.carryOverBonus, 5);
  });

  it("a deep betrayal becomes a season-long revenge goal", () => {
    const v = view(char("hothead"));
    const a = seedAgenda(v, board(), SEED);
    const hurt = recheckAgenda(a, { ...v, grudges: [{ toward: RIVAL, salience: 0.8, ref: "deal-broken" }] }, board({ day: 4 }), "betrayed", SEED);
    const g = active(hurt, "revenge", RIVAL)!;
    expect(g.horizon).toBe("season");
    expect(g.why).toContainEqual({ kind: "memory", about: RIVAL, ref: "deal-broken", weight: 0.8 });
  });

  it("an exposed secret fails the keep-my-secret goal", () => {
    const v = view(char("analyst", { secretKinds: ["secret-motive"] }));
    const a = seedAgenda(v, board(), SEED);
    const exposed = recheckAgenda(a, { ...v, secretExposed: true }, board({ day: 6 }), "secret-exposed", SEED);
    expect(resolved(exposed, "keep-my-secret")?.status).toBe("failed");
  });

  it("when the holder is evicted every open goal ends with them (kept for the retrospective)", () => {
    const v = view(char("villain"), { threats: [{ toward: RIVAL, threat: 0.8 }] });
    const a = seedAgenda(v, board(), SEED);
    const out = recheckAgenda(a, v, board({ day: 5, evicted: [HOLDER], inHouse: HOUSE.filter((p) => p !== HOLDER), weekClosed: true }), "eviction", SEED);
    expect(out.goals).toEqual([]);
    expect(out.history.length).toBe(a.goals.length);
  });

  it("a saved agenda reloads byte-identical, and a long run of rechecks only ever grows the history", () => {
    let v = view(char("mastermind"), { threats: [{ toward: RIVAL, threat: 0.7 }], affinity: [{ toward: ALLY, affinity: 0.75 }] });
    let a = seedAgenda(v, board(), SEED);
    let inHouse = [...HOUSE];
    const evicted: string[] = [];
    for (let week = 1; week <= 4; week++) {
      const gone = inHouse.find((p) => p !== HOLDER && p !== "player" && p !== ALLY)!;
      for (const step of [{ trigger: "nominated" as const, b: board({ week, day: week * 5 - 3, inHouse, evicted, nominees: [gone, OTHER] }) },
        { trigger: "week-closed" as const, b: board({ week, day: week * 5, inHouse: inHouse.filter((p) => p !== gone), evicted: [...evicted, gone], weekClosed: true }) }]) {
        const next = recheckAgenda(a, v, step.b, step.trigger, SEED);
        expect(isAgendaSuperset(a, next)).toBe(true);
        expect(JSON.parse(JSON.stringify(next))).toEqual(next);
        a = mullAgenda(next, v, step.b, SEED);
      }
      evicted.push(gone);
      inHouse = inHouse.filter((p) => p !== gone);
      v = { ...v, threats: v.threats.filter((t) => inHouse.includes(t.toward)) };
    }
    expect(a.history.length).toBeGreaterThan(4);
  });
});

describe("the nightly mull: inner processing only", () => {
  it("a goal with no progress fades, faster for a flexible holder; a gave-up goal is kept as dropped", () => {
    const fade = (k: Archetype): number => {
      const v = view(char(k), { affinity: [{ toward: ALLY, affinity: 0.65 }] });
      const a = seedAgenda(v, board(), SEED);
      const before = active(a, "pull-them-in", ALLY)!.commitment;
      const after = mullAgenda(a, v, board({ day: 3 }), SEED);
      const g = active(after, "pull-them-in", ALLY) ?? resolved(after, "pull-them-in", ALLY)!;
      return before - g.commitment;
    };
    expect(fade("floater")).toBeGreaterThan(fade("loyalist"));
  });

  it("progress keeps a goal alive; keeping a secret is never given up", () => {
    const v = view(char("floater", { secretKinds: ["divergent-persona"] }));
    let a = seedAgenda(v, board(), SEED);
    for (let d = 3; d < 15; d++) a = mullAgenda(a, v, board({ day: d }), SEED);
    expect(active(a, "keep-my-secret")).toBeDefined();
  });
});

describe("long cons are for strategic types only (Ryne 2026-11-12)", () => {
  const conView = (k: Archetype, style: StrategyStyle, owner: string): AgendaView =>
    view(char(k, {}, style), { owner, threats: [{ toward: RIVAL, threat: 0.6 }], affinity: [{ toward: RIVAL, affinity: 0.7 }] });

  it("only masterminds, villains, analysts or strategic players ever start one, and not all of them", () => {
    let eligibleWith = 0, eligible = 0;
    for (let i = 0; i < 40; i++) {
      for (const [k, style] of [["mastermind", "under-the-radar"], ["villain", "aggressive"], ["social-butterfly", "strategic"]] as const) {
        eligible++;
        if (active(seedAgenda(conView(k, style, `npc:c${i}`), board(), SEED + i), "long-con", RIVAL)) eligibleWith++;
      }
      for (const [k, style] of [["loyalist", "loyal"], ["floater", "social"], ["hothead", "emotional"]] as const) {
        expect(active(seedAgenda(conView(k, style, `npc:n${i}`), board(), SEED + i), "long-con"), `${k} never runs a long con`).toBeUndefined();
      }
    }
    expect(eligibleWith).toBeGreaterThan(0);
    expect(eligibleWith).toBeLessThan(eligible);
    expect(canRunLongCon(char("social-butterfly", {}, "strategic"))).toBe(true);
  });

  it("a long con works only if the mark leaves after the jury starts; cutting them early fails it", () => {
    const test = { kind: "cut-later" as const, who: RIVAL, stage: "jury" as const };
    const v = view(char("mastermind"));
    expect(evaluateTest(test, HOLDER, v, board({ evicted: [RIVAL] }))).toBe("failed");
    expect(evaluateTest(test, HOLDER, v, board({ evicted: [RIVAL], juryStarted: true }))).toBe("achieved");
    expect(evaluateTest(test, HOLDER, v, board({ juryStarted: true }))).toBe("open");
  });
});

describe("determinism and walls", () => {
  it("same inputs give the same agenda, and no shared random stream is touched", () => {
    const spy = vi.spyOn(Math, "random");
    const v = view(char("wildcard"), { threats: [{ toward: RIVAL, threat: 0.7 }], affinity: [{ toward: ALLY, affinity: 0.7 }] });
    expect(seedAgenda(v, board(), SEED)).toEqual(seedAgenda(v, board(), SEED));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("every success test, both ways (the engine, not the narrator, decides whether a goal worked)", () => {
  const v = view(char("analyst"), { allianceMates: [ALLY], answered: ["q1"], powerWins: 0 });
  const cases: Array<[string, Parameters<typeof evaluateTest>[0], Partial<AgendaBoard>, Partial<AgendaView>, string]> = [
    ["evicted: open", { kind: "evicted", who: RIVAL }, {}, {}, "open"],
    ["evicted: target wins", { kind: "evicted", who: RIVAL }, { winner: RIVAL }, {}, "failed"],
    ["evicted: target in final two", { kind: "evicted", who: RIVAL }, { finalTwo: [RIVAL, ALLY] }, {}, "failed"],
    ["survives-week: open", { kind: "survives-week" }, {}, {}, "open"],
    ["survives-week: achieved", { kind: "survives-week" }, { weekClosed: true }, {}, "achieved"],
    ["survives-week: failed", { kind: "survives-week" }, { evicted: [HOLDER] }, {}, "failed"],
    ["allied-with: achieved", { kind: "allied-with", who: ALLY }, {}, {}, "achieved"],
    ["allied-with: they left", { kind: "allied-with", who: RIVAL }, { evicted: [RIVAL] }, {}, "failed"],
    ["allied-with: open", { kind: "allied-with", who: RIVAL }, {}, {}, "open"],
    ["still-in: failed", { kind: "still-in", who: ALLY }, { evicted: [ALLY] }, {}, "failed"],
    ["still-in: achieved", { kind: "still-in", who: ALLY }, { weekClosed: true }, {}, "achieved"],
    ["still-in: open", { kind: "still-in", who: ALLY }, {}, {}, "open"],
    ["holds-power: HOH", { kind: "holds-power" }, { hoh: HOLDER }, {}, "achieved"],
    ["holds-power: veto", { kind: "holds-power" }, { vetoHolder: HOLDER }, {}, "achieved"],
    ["holds-power: week over", { kind: "holds-power" }, { weekClosed: true }, {}, "failed"],
    ["holds-power: open", { kind: "holds-power" }, {}, {}, "open"],
    ["question: answered", { kind: "question-answered", ref: "q1" }, {}, {}, "achieved"],
    ["question: open", { kind: "question-answered", ref: "q2" }, {}, {}, "open"],
    ["question: holder out", { kind: "question-answered", ref: "q2" }, { evicted: [HOLDER] }, {}, "failed"],
    ["jury: achieved", { kind: "reaches-jury" }, { juryStarted: true }, {}, "achieved"],
    ["jury: failed", { kind: "reaches-jury" }, { evicted: [HOLDER] }, {}, "failed"],
    ["jury: open", { kind: "reaches-jury" }, {}, {}, "open"],
    ["alliance F2: achieved", { kind: "final-two-alliance" }, { finalTwo: [HOLDER, ALLY] }, {}, "achieved"],
    ["alliance F2: failed", { kind: "final-two-alliance" }, { finalTwo: [HOLDER, RIVAL] }, {}, "failed"],
    ["alliance F2: holder out", { kind: "final-two-alliance" }, { evicted: [HOLDER] }, {}, "failed"],
    ["alliance F2: open", { kind: "final-two-alliance" }, {}, {}, "open"],
    ["person F2: achieved", { kind: "reaches-final-two", who: ALLY }, { finalTwo: [ALLY, RIVAL] }, {}, "achieved"],
    ["person F2: not in it", { kind: "reaches-final-two", who: ALLY }, { finalTwo: [OTHER, RIVAL] }, {}, "failed"],
    ["person F2: evicted", { kind: "reaches-final-two", who: ALLY }, { evicted: [ALLY] }, {}, "failed"],
    ["person F2: open", { kind: "reaches-final-two", who: ALLY }, {}, {}, "open"],
    ["wins: achieved", { kind: "wins" }, { winner: HOLDER }, {}, "achieved"],
    ["wins: someone else", { kind: "wins" }, { winner: RIVAL }, {}, "failed"],
    ["wins: open", { kind: "wins" }, {}, {}, "open"],
    ["power once: achieved", { kind: "wins-power-once" }, {}, { powerWins: 1 }, "achieved"],
    ["power once: failed", { kind: "wins-power-once" }, { evicted: [HOLDER] }, {}, "failed"],
    ["power once: open", { kind: "wins-power-once" }, {}, {}, "open"],
    ["secret: kept to the end", { kind: "secret-kept" }, { winner: RIVAL }, {}, "achieved"],
    ["secret: open", { kind: "secret-kept" }, {}, {}, "open"],
    ["long con: holder out first", { kind: "cut-later", who: RIVAL, stage: "final-five" }, { evicted: [HOLDER] }, {}, "failed"],
    ["long con: final five reached", { kind: "cut-later", who: RIVAL, stage: "final-five" }, { evicted: [RIVAL], finalFive: true }, {}, "achieved"],
  ];
  it.each(cases)("%s", (_name, test, b, vo, want) => {
    expect(evaluateTest(test, HOLDER, { ...v, ...vo }, board(b))).toBe(want);
  });
});

describe("ORW-329: pre-show ties behave by their nature (Ryne 2026-11-03: family protects, rivals target, exes are awkward, old friends are loyal until pressured)", () => {
  const tie = (nature: string, friendly: boolean) => ({ preShowTie: { with: RIVAL, hidden: false, friendly, nature } });
  it("a rival is a season-long target from day one", () => {
    const g = active(seedAgenda(view(char("analyst", tie("rival", false))), board(), SEED), "get-them-out", RIVAL)!;
    expect(g.horizon).toBe("season");
    expect(g.why[0]).toMatchObject({ kind: "pre-show-tie", ref: "rival" });
  });
  it("an ex is neither protected nor targeted, and is avoided in free time", () => {
    const a = seedAgenda(view(char("analyst", tie("ex", false))), board(), SEED);
    expect(active(a, "protect-my-person")).toBeUndefined();
    expect(a.goals.some((g) => g.target === RIVAL && g.horizon === "season")).toBe(false);
    expect(tieAvoids(char("analyst", tie("ex", false)))).toEqual([RIVAL]);
    expect(tieAvoids(char("analyst", tie("family", true)))).toEqual([]);
  });
  it("family is protected hard and never given up, even by a flexible houseguest with no progress", () => {
    const v = view(char("floater", tie("family", true)));
    let a = seedAgenda(v, board(), SEED);
    expect(active(a, "protect-my-person", RIVAL)!.commitment).toBeGreaterThanOrEqual(0.9);
    for (let d = 3; d < 15; d++) a = mullAgenda(a, v, board({ day: d }), SEED);
    expect(active(a, "protect-my-person", RIVAL)).toBeDefined();
  });
  it("an old friend is protected until they become a real threat; then the protection gives way", () => {
    const v = view(char("analyst", tie("old-friend", true)));
    const a = seedAgenda(v, board(), SEED);
    expect(active(a, "protect-my-person", RIVAL)).toBeDefined();
    const pressured = recheckAgenda(a, { ...v, threats: [{ toward: RIVAL, threat: 0.95 }] }, board({ day: 4 }), "comp-result", SEED);
    expect(active(pressured, "protect-my-person", RIVAL)).toBeUndefined();
    expect(resolved(pressured, "protect-my-person", RIVAL)).toMatchObject({ status: "replaced", endNote: "pressured: the friend became a threat" });
    const fam = seedAgenda(view(char("analyst", tie("family", true))), board(), SEED);
    expect(active(recheckAgenda(fam, { ...view(char("analyst", tie("family", true))), threats: [{ toward: RIVAL, threat: 0.95 }] }, board({ day: 4 }), "comp-result", SEED), "protect-my-person", RIVAL)).toBeDefined();
  });
});

describe("ORW-329: the rival pull reaches decisions", () => {
  it("a rival's season target pulls nominations and votes toward them at full strength; a family tie shields them", async () => {
    const { goalPull } = await import("../../src/engine/agendaDecisions");
    const rival = seedAgenda(view(char("analyst", { preShowTie: { with: RIVAL, hidden: false, friendly: false, nature: "rival" } })), board(), SEED);
    expect(goalPull(rival, RIVAL, board()).value).toBeGreaterThan(0.5);
    const fam = seedAgenda(view(char("analyst", { preShowTie: { with: RIVAL, hidden: false, friendly: true, nature: "family" } })), board(), SEED);
    expect(goalPull(fam, RIVAL, board()).value).toBeLessThan(-0.5);
  });
});
