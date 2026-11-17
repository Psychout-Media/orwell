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

  it("ORW-578: the honest reason is what PUSHED the choice (the largest positive term), never the largest by size regardless of sign", () => {
    // a nomination where a protective deal pulled hard AGAINST it, and the threat read pushed it: the reason is the threat, not "I kept my word"
    expect(truthfulKind(real({ terms: [{ name: "deal", value: -0.9 }, { name: "threat", value: 0.3 }] }))).toBe("biggest-threat");
    expect(truthfulKind(real({ terms: [{ name: "bond", value: -0.8 }, { name: "memory", value: 0.2 }] }))).toBe("came-after-me");
  });
  it("ORW-578: a save is never voiced as a threat read: a pull-them-in goal or a bond is loyalty, a promise is a kept word", () => {
    expect(truthfulKind(real({ decision: "veto", goalKind: "pull-them-in", terms: [{ name: "threat", value: 0.9 }] }))).toBe("loyal-to-my-side");
    expect(truthfulKind(real({ decision: "veto", terms: [{ name: "threat", value: -0.6 }, { name: "bond", value: 0.4 }] }))).toBe("loyal-to-my-side");
    expect(truthfulKind(real({ decision: "veto", terms: [{ name: "deal", value: 0.5 }] }))).toBe("kept-my-word");
    expect(truthfulKind(real({ decision: "veto", terms: [{ name: "threat", value: 0.9 }] }))).toBe("nothing-personal");
    expect(truthfulKind(real({ decision: "veto", terms: [] }))).toBe("nothing-personal");
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

describe("ORW-578: every public decision moment tells the narrator to give only the engine's stated reason, or none", () => {
  it("nominations, the veto ceremony and the final eviction each carry the stay-silent rule", async () => {
    const { MOMENT_PROMPTS } = await import("../../src/engine/momentPrompts");
    for (const m of ["nominations", "veto-ceremony", "final-eviction"]) {
      const text = MOMENT_PROMPTS[m] ?? "";
      expect(text, m).toMatch(/said aloud/);
      expect(text, m).toMatch(/no other reason of your own/);
    }
  });
});

describe("ORW-578 part 2: the second nominee gets a stated reason too", () => {
  it("the seat's tactic: backdoor, pawn (the biggest floater, or the floater pull outweighs the rest), or direct (a duo partner, the next read)", async () => {
    const { seatTacticOf } = await import("../../src/engine/liveSeason");
    expect(seatTacticOf("backdoor-ranks-2-3", [])).toBe("backdoor");
    expect(seatTacticOf("pawn-is-biggest-floater", [["threat", 0.9]])).toBe("pawn");
    expect(seatTacticOf(undefined, [["threat", 0.1], ["pawn-seat-floater", 0.4]])).toBe("pawn");
    expect(seatTacticOf(undefined, [["threat", 0.6], ["pawn-seat-floater", 0.2]])).toBe("direct");
    expect(seatTacticOf(undefined, [["threat", 0.1], ["pawn-seat-floater", 0.4], ["duo-partner", 0.3]])).toBe("direct");
  });
  it("a non-backdoor seat is no longer skipped: the stated-reason recorder takes every nomination seat", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../../src/engine/liveSeason.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/w\.kind === "nomination-seat" && w\.rule !== "backdoor-ranks-2-3"\) return/);
  });
});

describe("ORW-578 part 2b: a veto holder who does not use it gives a reason too", () => {
  it("the honest reason is keeping the nominations, said about the HOH; it is recorded once, for NPC holders in a played game", async () => {
    const { noteVetoHoldReason } = await import("../../src/engine/liveSeason");
    expect(truthfulKind({ decision: "veto-hold", decider: "holder", choice: "hoh", terms: [] })).toBe("keeping-the-noms");
    const s = { week: 2, dayNumber: 4, hoh: "hoh", active: ["hoh", "holder", "a", "b"], statedReasons: [] as unknown[] } as never as Parameters<typeof noteVetoHoldReason>[0];
    const ctx = { player: "player", agendaPullFor: () => ({ value: 0 }), statedReasonFor: (r: RealReason) => ({ kind: truthfulKind(r), about: r.choice, candor: "truth" as const }) } as never as Parameters<typeof noteVetoHoldReason>[1];
    noteVetoHoldReason(s, ctx, "holder");
    noteVetoHoldReason(s, ctx, "holder");
    const log = (s as unknown as { statedReasons: Array<{ decision: string; public: boolean; stated: { kind: string; about: string } }> }).statedReasons;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ decision: "veto-hold", public: true, stated: { kind: "keeping-the-noms", about: "hoh" } });
    // the player's own choice never gets a stated reason, and an HOH holding their own veto has no one to defer to
    noteVetoHoldReason(s, ctx, "player");
    expect(log).toHaveLength(1);
  });
  it("the narrator is handed what it means, never a canned line of its own", async () => {
    const { STATED_REASON_GLOSS } = await import("../../src/engine/momentPrompts");
    expect(STATED_REASON_GLOSS["keeping-the-noms"]).toBeTruthy();
  });
});

describe("ORW-578: the retrospective's real-reason line follows the same sign rule", () => {
  it("a term that pulled against the choice is never named as the real reason", async () => {
    const { realLine } = await import("../../src/engine/houseStory");
    const rec = { week: 1, day: 2, decider: "h", decision: "nominate", public: true, real: { decision: "nominate", decider: "h", choice: "t", terms: [{ name: "deal", value: -0.9 }, { name: "threat", value: 0.3 }] }, stated: { kind: "biggest-threat", about: "t", candor: "truth" } };
    const line = realLine(rec as never, (id) => id, new Map());
    expect(line).toContain("they saw them as a threat");
    expect(line).not.toContain("a deal they had made");
  });
});

describe("ORW-578 part 3: Houseguest's Choice and a thrown competition carry a reason", () => {
  it("an NPC's Houseguest's Choice pick is a choice FOR someone: a bond or a memory is loyalty, their own strategy is a plan, never a threat read", () => {
    const hc = (terms: Array<{ name: string; value: number }>) => truthfulKind({ decision: "hc-pick", decider: "holder", choice: "pick", terms: terms as RealReason["terms"] });
    expect(hc([{ name: "bond", value: 0.7 }, { name: "goal", value: 0.1 }])).toBe("loyal-to-my-side");
    expect(hc([{ name: "bond", value: 0.1 }, { name: "goal", value: 0.6 }])).toBe("had-it-planned");
    expect(hc([{ name: "bond", value: -0.2 }])).toBe("nothing-personal");
  });
  it("the pick's reason is recorded once, public, about the houseguest picked; never for the player's own pick", async () => {
    const { noteHcPickReason } = await import("../../src/engine/liveSeason");
    const s = { week: 3, dayNumber: 9, active: ["holder", "pick", "a"], statedReasons: [] as unknown[] } as never as Parameters<typeof noteHcPickReason>[0];
    const ctx = {
      player: "player", agendaPullFor: () => ({ value: 0 }), rel: { bondStrength: () => 0.8 }, hcStrategyFor: () => 0.1,
      statedReasonFor: (r: RealReason) => ({ kind: truthfulKind(r), about: r.choice, candor: "truth" as const }),
    } as never as Parameters<typeof noteHcPickReason>[1];
    noteHcPickReason(s, ctx, "holder", "pick");
    noteHcPickReason(s, ctx, "holder", "pick");
    noteHcPickReason(s, ctx, "player", "pick");
    const log = (s as unknown as { statedReasons: Array<{ decision: string; public: boolean; stated: { kind: string; about: string } }> }).statedReasons;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ decision: "hc-pick", public: true, stated: { kind: "loyal-to-my-side", about: "pick" } });
  });
  it("a thrown competition's honest reason is loyalty to the ally it was thrown for", () => {
    expect(truthfulKind({ decision: "comp-throw", decider: "thrower", choice: "ally", terms: [{ name: "bond", value: 0.9 }] })).toBe("loyal-to-my-side");
  });
  it("a thrown competition is never admitted aloud: its reason is a record for the retrospective only, never in a player or admin view", async () => {
    const { GameSessionRegistry } = await import("../../src/composition/registry");
    const { PLAYER } = await import("../../src/domain/ids");
    const sb = new GameSessionRegistry().sandboxFor("orw578-throw");
    sb.session.createCharacter({ playerName: "The Player", seed: 5 });
    const seam = sb.session as unknown as { live: { playedGame?: boolean; statedReasons?: Array<{ decision: string; public: boolean; real: { choice: string } }> }; noteCompThrowReason(id: string, others: readonly string[]): void; statedReasonsFor(id: string): unknown[] };
    seam.live.playedGame = true;
    const [thrower, ally, other] = sb.session.livingIds().filter((id) => id !== PLAYER);
    seam.noteCompThrowReason(thrower!, [ally!, other!]);
    seam.noteCompThrowReason(thrower!, [ally!, other!]);
    const rows = (seam.live.statedReasons ?? []).filter((r) => r.decision === "comp-throw");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.public).toBe(false);
    expect(seam.statedReasonsFor(thrower!)).toEqual([]);
    const out = JSON.stringify([await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("getMomentPrompt", {}), await sb.mcp.admin.callTool("inspectNonVaultState", {})]);
    expect(out).not.toMatch(/comp-throw|threw the competition/);
  });
});
