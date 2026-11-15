import { describe, it, expect } from "vitest";
import { goalPull, explainDecision, truthfulKind, voiceableReason, type RealReason } from "../../src/engine/agendaDecisions";
import type { Agenda, AgendaBoard, AgendaCharacter, Goal } from "../../src/engine/agenda";
import { REASONS } from "../../src/engine/agendaConstants";
import type { Archetype, StrategyStyle } from "../../src/engine/characterFactory";

/** ORW-253 slice 2 core: goals pull decisions at full strength; the engine picks the stated reason (truth, half-truth or cover). Roles only. */
const HOLDER = "npc:1", TARGET = "npc:2", FRIEND = "npc:3", MATE = "npc:4", BYSTANDER = "npc:5";
const board = (over: Partial<AgendaBoard> = {}): AgendaBoard =>
  ({ day: 4, week: 2, inHouse: [HOLDER, TARGET, FRIEND, MATE, BYSTANDER], evicted: [], juryStarted: false, finalFive: false, nominees: [], weekClosed: false, ...over });
const goal = (kind: Goal["kind"], target: string | undefined, commitment: number, over: Partial<Goal> = {}): Goal => ({
  id: `${HOLDER}:${kind}:${target ?? "-"}`, owner: HOLDER, horizon: "week", kind, ...(target ? { target } : {}), why: [{ kind: "character", weight: 1 }],
  test: { kind: "survives-week" }, commitment, status: "active", formedDay: 1, formedWeek: 1, ...over,
});
const agenda = (...goals: Goal[]): Agenda => ({ owner: HOLDER, goals, history: [], formedForWeek: 2 });
const char = (archetype: Archetype, strategyStyle: StrategyStyle = "social"): AgendaCharacter => ({ archetype, strategyStyle, secretKinds: [] });

describe("goals pull decisions at full strength (Ryne: as much as the threat read)", () => {
  it("a fully committed 'get them out' adds as much as a maximal threat read, and names the goal", () => {
    const p = goalPull(agenda(goal("get-them-out", TARGET, 1)), TARGET, board());
    expect(p.value).toBeCloseTo(1.0, 5);
    expect(p.goalKind).toBe("get-them-out");
    expect(REASONS.goalWeight).toBe(1.0);
  });

  it("revenge pushes against; protecting pulls the other way; recruiting shields at half", () => {
    expect(goalPull(agenda(goal("revenge", TARGET, 0.8, { horizon: "season" })), TARGET, board()).value).toBeCloseTo(0.8, 5);
    expect(goalPull(agenda(goal("keep-them-safe", FRIEND, 0.9)), FRIEND, board()).value).toBeCloseTo(-0.9, 5);
    expect(goalPull(agenda(goal("pull-them-in", FRIEND, 0.6)), FRIEND, board()).value).toBeCloseTo(-0.3, 5);
  });

  it("a last-alliance-standing aim shields alliance mates and nobody else", () => {
    const a = agenda(goal("last-alliance-standing", undefined, 0.8, { horizon: "season" }));
    expect(goalPull(a, MATE, board(), [MATE]).value).toBeCloseTo(-0.4, 5);
    expect(goalPull(a, BYSTANDER, board(), [MATE]).value).toBe(0);
  });

  it("a long con keeps the mark close before the jury, and cuts them once the jury starts", () => {
    const con = goal("long-con", TARGET, 0.7, { horizon: "season", test: { kind: "cut-later", who: TARGET, stage: "jury" } });
    expect(goalPull(agenda(con), TARGET, board()).value).toBeLessThan(0);
    expect(goalPull(agenda(con), TARGET, board({ juryStarted: true })).value).toBeCloseTo(0.7, 5);
  });

  it("no agenda, a settled goal, or the holder themself pulls nothing", () => {
    expect(goalPull(undefined, TARGET, board()).value).toBe(0);
    expect(goalPull(agenda(goal("get-them-out", TARGET, 1, { status: "achieved" })), TARGET, board()).value).toBe(0);
    expect(goalPull(agenda(goal("get-them-out", HOLDER, 1)), HOLDER, board()).value).toBe(0);
  });

  it("several goals add up, and the hardest-pulling one is named", () => {
    const p = goalPull(agenda(goal("get-them-out", TARGET, 0.4), goal("revenge", TARGET, 0.9, { horizon: "season" })), TARGET, board());
    expect(p.value).toBeCloseTo(1.3, 5);
    expect(p.goalKind).toBe("revenge");
  });
});

describe("the real reason and the stated reason", () => {
  const real = (over: Partial<RealReason>): RealReason => ({ decision: "nominate", decider: HOLDER, choice: TARGET, terms: [{ name: "threat", value: 0.7 }], ...over });

  it("the honest version follows the goal or the strongest term", () => {
    expect(truthfulKind(real({ goalKind: "revenge" }))).toBe("came-after-me");
    expect(truthfulKind(real({ goalKind: "long-con" }))).toBe("had-it-planned");
    expect(truthfulKind(real({ goalKind: "keep-them-safe" }))).toBe("loyal-to-my-side");
    expect(truthfulKind(real({ tactic: "pawn" }))).toBe("pawn-youll-be-fine");
    expect(truthfulKind(real({ terms: [{ name: "threat", value: 0.2 }, { name: "memory", value: 0.5 }] }))).toBe("came-after-me");
    expect(truthfulKind(real({ terms: [{ name: "deal", value: 0.6 }] }))).toBe("kept-my-word");
    expect(truthfulKind(real({ terms: [{ name: "belief", value: 0.6 }] }))).toBe("didnt-trust-you");
    expect(truthfulKind(real({ terms: [{ name: "pitch", value: 0.6 }] }))).toBe("house-wants-it");
    expect(truthfulKind(real({ terms: [] }))).toBe("biggest-threat");
  });

  it("a backdoor HOH always tells the nominees they are pawns, and the engine knows it is a cover", () => {
    expect(explainDecision(real({ tactic: "backdoor" }), char("loyalist", "loyal"), 1, 4)).toEqual({ kind: "pawn-youll-be-fine", about: TARGET, candor: "cover" });
  });

  it("honest characters tell the truth more often than schemers, and secrets are admitted least", () => {
    const truthShare = (c: AgendaCharacter, r: RealReason): number => {
      let t = 0;
      for (let s = 0; s < 400; s++) if (explainDecision(r, c, s, 4).candor === "truth") t++;
      return t / 400;
    };
    const plain = real({});
    const revenge = real({ goalKind: "revenge" });
    expect(truthShare(char("hothead", "emotional"), plain)).toBeGreaterThan(truthShare(char("villain", "strategic"), plain) + 0.4);
    expect(truthShare(char("peacemaker"), revenge)).toBeLessThan(truthShare(char("peacemaker"), plain) - 0.15);
  });

  it("a lie is always a plausible reason, never the honest one, and the engine marks it", () => {
    for (let s = 0; s < 200; s++) {
      const st = explainDecision(real({ goalKind: "revenge" }), char("villain", "strategic"), s, 4);
      if (st.candor === "truth") expect(st.kind).toBe("came-after-me");
      else expect(st.kind).not.toBe("came-after-me");
      if (st.candor === "cover") expect(["nothing-personal", "house-wants-it"]).toContain(st.kind);
      if (st.candor === "part-truth") expect(st.kind).toBe("biggest-threat");
    }
  });

  it("is deterministic per decision, and only the kind and subject may reach the narrator", () => {
    const r = real({ goalKind: "revenge" });
    expect(explainDecision(r, char("analyst"), 9, 4)).toEqual(explainDecision(r, char("analyst"), 9, 4));
    const voiced = voiceableReason(explainDecision(r, char("analyst"), 9, 4));
    expect(Object.keys(voiced).sort()).toEqual(["about", "kind"]);
  });
});
