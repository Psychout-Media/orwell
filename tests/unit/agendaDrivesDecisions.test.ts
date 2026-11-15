import { describe, it, expect } from "vitest";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { RelationshipModel } from "../../src/engine/relationships";
import { generateHouse } from "../../src/engine/characterFactory";
import { newLiveSeason, advance, applyDecision, autoDecision, type SeasonCtx, type LiveSeasonState } from "../../src/engine/liveSeason";
import { goalPull, explainDecision, type GoalPull } from "../../src/engine/agendaDecisions";
import type { Agenda, AgendaBoard, Goal } from "../../src/engine/agenda";
import { nominationPlan } from "../../src/engine/season";
import { voteChoice } from "../../src/engine/liveSeason";
import { PLAYER } from "../../src/domain/ids";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { BASE_GAME_MASTER_PROMPT, MOMENT_PROMPTS, STATED_REASON_GLOSS } from "../../src/engine/momentPrompts";

/**
 * ORW-314 (ORW-253 slice 2 wiring): goals move nominations, the replacement, the veto, the vote and the Final HOH's eviction at full strength; the reason each NPC gives aloud
 * is stored (real + stated + candor are hidden engine metadata) and only the stated reason's KIND + SUBJECT reaches the narrator, through the decider's own block. Roles only.
 */
const mkGoal = (owner: string, kind: Goal["kind"], target: string, commitment: number, over: Partial<Goal> = {}): Goal => ({
  id: `${owner}:${kind}:${target}`, owner, horizon: "season", kind, target, why: [{ kind: "character", weight: 1 }], test: { kind: "evicted", who: target }, commitment, status: "active", formedDay: 1, formedWeek: 1, ...over,
});
const agendaOf = (owner: string, ...goals: Goal[]): Agenda => ({ owner, goals, history: [], formedForWeek: 1 });
const boardOf = (s: LiveSeasonState, juryStarted: boolean): AgendaBoard => ({ day: s.dayNumber ?? s.week, week: s.week, inHouse: [...s.active], evicted: [...s.evictionOrder], juryStarted, finalFive: false, nominees: [], weekClosed: false });

interface Run { s: LiveSeasonState; hoh: string; target?: string; nominees?: string[] }
/** Play a headless season to the first NPC-HOH nominations, with `agendas` supplied as the ctx hook (the same one the adapter supplies for a played game). `shape` fixes the HOH's threat reads first. */
function toNominations(seed: number, opts: { agendaFor?: (hoh: string, cands: string[]) => Agenda | undefined; jury?: boolean; shape?: (hoh: string, cands: string[], rel: RelationshipModel) => void } = {}): Run {
  const { npcs } = generateHouse(new SeededRandom(seed));
  const ids = [PLAYER, ...npcs.map((n) => n.id)];
  const rng = new SeededRandom(seed);
  const rel = new RelationshipModel(0.5);
  for (const a of ids) for (const b of ids) if (a !== b) { const e = rel.edge(a, b); e.trust = rng.next(); e.affinity = rng.next(); e.threat = rng.next(); e.confidence = 0.5; }
  const s = newLiveSeason(ids);
  const agendas: Record<string, Agenda> = {};
  const ctx: SeasonCtx = {
    player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel,
    ...(opts.agendaFor ? {
      agendaPullFor: (t: string, d: string): GoalPull => goalPull(agendas[d], t, boardOf(s, opts.jury === true), []),
      statedReasonFor: (real, day) => explainDecision(real, { archetype: "schemer" as never, strategyStyle: "strategic" as never, secretKinds: [] }, 7, day),
    } : {}),
  };
  for (let g = 0; g < 10_000 && !s.finished; g++) {
    if (!s.pending && s.beat === "nominations" && s.hoh && s.hoh !== PLAYER && !s.nominees) {
      const cands = s.active.filter((h) => h !== s.hoh);
      opts.shape?.(s.hoh, cands, rel);
      const a = opts.agendaFor?.(s.hoh, cands);
      if (a) agendas[s.hoh] = a;
      advance(s, ctx, rng);
      return { s, hoh: s.hoh, target: s.nominationTarget, nominees: s.nominees ? [...s.nominees] : undefined };
    }
    s.pending ? applyDecision(s, autoDecision(s, ctx, rng), ctx, rng) : advance(s, ctx, rng);
  }
  throw new Error("no NPC nominations");
}
/** The HOH reads: one clear top threat, the goal's subject a middling read, everyone else low. */
const shapeReads = (top: number, mark: number) => (hoh: string, cands: string[], rel: RelationshipModel): void => {
  cands.forEach((c, i) => { const e = rel.edge(hoh, c); e.threat = i === 0 ? top : i === 1 ? mark : 0.2; e.trust = 0.5; e.affinity = 0.5; });
};

describe("(a) a revenge goal moves the nomination off the top threat read", () => {
  for (const seed of [3, 5, 8]) {
    it(`seed ${seed}: the HOH nominates the revenge subject, who is NOT their top threat; with the goal zeroed they do not (mutation)`, () => {
      const probe = { top: "", mark: "" };
      const shape = (hoh: string, cands: string[], rel: RelationshipModel): void => { shapeReads(0.9, 0.1)(hoh, cands, rel); probe.top = cands[0]!; probe.mark = cands[1]!; };
      const base = toNominations(seed, { shape });
      expect(base.target).toBe(probe.top); // no goal: the threat read decides
      const withGoal = toNominations(seed, { shape, agendaFor: (hoh, c) => agendaOf(hoh, mkGoal(hoh, "revenge", c[1]!, 1)) });
      expect(withGoal.target).toBe(probe.mark);
      expect(withGoal.nominees).toContain(probe.mark);
      const zeroed = toNominations(seed, { shape, agendaFor: (hoh, c) => agendaOf(hoh, mkGoal(hoh, "revenge", c[1]!, 0)) }); // MUTATION: the goal's pull zeroed
      expect(zeroed.target).toBe(probe.top);
      expect(zeroed.target).not.toBe(probe.mark);
      // the stored reason: the real reason names the goal, the stated reason is a closed-set kind about the target
      const rec = withGoal.s.statedReasons!.find((r) => r.decision === "nominate" && r.decider === withGoal.hoh)!;
      expect(rec.real.goalKind).toBe("revenge");
      expect(rec.real.choice).toBe(probe.mark);
      expect(rec.stated.about).toBe(probe.mark);
      expect(Object.keys(STATED_REASON_GLOSS)).toContain(rec.stated.kind);
      expect(["truth", "part-truth", "cover"]).toContain(rec.stated.candor);
    });
  }

  it("no agenda hook (a headless sim that is not a played game): nothing recorded, the season byte-identical to one with a zero-pull hook", () => {
    const a = toNominations(4, {});
    const b = toNominations(4, { agendaFor: () => undefined });
    expect(a.s.statedReasons).toBeUndefined();
    expect(JSON.stringify({ ...a.s, decisionWhy: undefined })).toBe(JSON.stringify({ ...b.s, decisionWhy: undefined, statedReasons: undefined }));
  });
});

describe("(b) a long con keeps the mark off the block before the jury and nominates them after it starts", () => {
  const shape = shapeReads(0.7, 0.8); // the mark is the TOP threat read (gets nominated by the read alone)
  const con = (hoh: string, c: string[]): Agenda => agendaOf(hoh, mkGoal(hoh, "long-con", c[1]!, 1, { test: { kind: "cut-later", who: c[1]!, stage: "jury" } }));
  for (const seed of [3, 5]) {
    it(`seed ${seed}`, () => {
      const probe = { mark: "" };
      const sh = (hoh: string, cands: string[], rel: RelationshipModel): void => { shape(hoh, cands, rel); probe.mark = cands[1]!; };
      const base = toNominations(seed, { shape: sh });
      expect(base.target).toBe(probe.mark); // the read alone targets the mark
      const before = toNominations(seed, { shape: sh, agendaFor: con, jury: false });
      expect(before.nominees).not.toContain(probe.mark); // kept off the block before jury
      const after = toNominations(seed, { shape: sh, agendaFor: con, jury: true });
      expect(after.target).toBe(probe.mark); // cut once the jury starts
      expect(after.nominees).toContain(probe.mark);
    });
  }
});

/** A whole headless season with `pull` as the agenda hook: returns the live state and every beat. */
function wholeSeason(seed: number, pull: (s: LiveSeasonState, rel: RelationshipModel, t: string, d: string) => number): LiveSeasonState {
  const { npcs } = generateHouse(new SeededRandom(seed));
  const ids = [PLAYER, ...npcs.map((n) => n.id)];
  const rng = new SeededRandom(seed);
  const rel = new RelationshipModel(0.5);
  for (const a of ids) for (const b of ids) if (a !== b) { const e = rel.edge(a, b); e.trust = rng.next(); e.affinity = rng.next(); e.threat = rng.next(); e.confidence = 0.5; }
  const s = newLiveSeason(ids);
  const ctx: SeasonCtx = {
    player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel,
    agendaPullFor: (t, d) => ({ value: d === PLAYER ? 0 : pull(s, rel, t, d) }),
    statedReasonFor: (real, day) => explainDecision(real, { archetype: "schemer" as never, strategyStyle: "strategic" as never, secretKinds: [] }, 7, day),
  };
  for (let g = 0; g < 10_000 && !s.finished; g++) s.pending ? applyDecision(s, autoDecision(s, ctx, rng), ctx, rng) : advance(s, ctx, rng);
  return s;
}

describe("the veto, the vote and the Final HOH's eviction read the goal at full strength too", () => {
  it("the NPC veto holder: a get-them-out pull on a nominee withholds the save, a keep-them-safe pull saves (mutation: pull zeroed = baseline)", () => {
    const used = (v: number): number => [1, 2, 3, 4, 5, 6].reduce((n, seed) => {
      const s = wholeSeason(seed, (st, _r, t) => (st.beat === "veto-ceremony" && st.nominees?.includes(t) ? v : 0));
      return n + (s.statedReasons ?? []).filter((r) => r.decision === "veto").length;
    }, 0);
    const out = used(1), base = used(0), safe = used(-1);
    expect(out).toBe(0);
    expect(safe).toBeGreaterThan(base);
  });

  it("the NPC eviction vote: a pull on a nominee decides the ballot against a clear threat-read gap (mutation: pull zeroed)", () => {
    const rel = new RelationshipModel(0.5);
    for (const a of ["v", "a", "b"]) for (const b of ["v", "a", "b"]) if (a !== b) { const e = rel.edge(a, b); e.trust = 0.5; e.affinity = 0.5; e.threat = 0.3; }
    rel.edge("v", "b").threat = 0.8; // the voter reads b as the threat
    const mk = (pull: number): SeasonCtx => ({ player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel, agendaPullFor: (t) => ({ value: t === "a" ? pull : 0 }) });
    expect(voteChoice("v", ["a", "b"], mk(0))).toBe("b");
    expect(voteChoice("v", ["a", "b"], mk(1))).toBe("a");
    expect(voteChoice("v", ["a", "b"], mk(-1))).toBe("b");
  });

  it("the NPC Final HOH: the goal picks which rival goes, and the choice is recorded with the stated reason", () => {
    let checked = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const pick = (want: "lower" | "none") => wholeSeason(seed, (st, r, t, d) => {
        if (want === "none" || st.beat !== "final-eviction" || d !== st.hoh) return 0;
        const rivals = st.active.filter((h) => h !== st.hoh);
        const lower = [...rivals].sort((x, y) => r.edge(d, x).threat - r.edge(d, y).threat)[0]!;
        return t === lower ? 1 : 0;
      });
      const g = pick("lower");
      const rec = (g.statedReasons ?? []).find((r) => r.decision === "final-hoh-evict");
      if (!rec) continue; // the player held the Final HOH this seed
      checked++;
      expect(g.finalTwo).not.toContain(rec.real.choice);
      expect(["truth", "part-truth", "cover"]).toContain(rec.stated.candor);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("every NPC public act is stored with a stated reason (nominate, veto, replacement, Final HOH); a secret ballot's is stored but not public", () => {
    const recs = [1, 2, 3, 4, 5, 6].flatMap((seed) => wholeSeason(seed, () => 0).statedReasons ?? []);
    const kinds = new Set(recs.map((r) => r.decision));
    for (const k of ["nominate", "veto", "replacement", "vote", "final-hoh-evict"] as const) expect(kinds.has(k), k).toBe(true);
    expect(recs.some((r) => r.decision === "vote" && r.public === false)).toBe(true);
    expect(recs.filter((r) => r.decision !== "vote").every((r) => r.public === true)).toBe(true);
    for (const r of recs) expect(Object.keys(STATED_REASON_GLOSS)).toContain(r.stated.kind);
  });
});

describe("the pull is not clamped below the threat read", () => {
  it("a pull of 1.0 outweighs a threat read of 0.95 (nominationPlan, agendaPush)", () => {
    const rel = new RelationshipModel(0.5);
    const hoh = "npc:1", ids = [hoh, "npc:2", "npc:3", "npc:4", "npc:5", "npc:6"];
    for (const a of ids) for (const b of ids) if (a !== b) { const e = rel.edge(a, b); e.trust = 0.5; e.affinity = 0.5; e.threat = 0.2; }
    rel.edge(hoh, "npc:2").threat = 0.95;
    expect(nominationPlan(hoh, ids, rel, {}).target).toBe("npc:2");
    expect(nominationPlan(hoh, ids, rel, { agendaPush: (t) => (t === "npc:3" ? 1 : 0) }).target).toBe("npc:3");
    expect(nominationPlan(hoh, ids, rel, { agendaPush: (t) => (t === "npc:3" ? 0.7 : 0) }).target).toBe("npc:2"); // a weaker pull does not (so the term is a real score term, not an override)
  });
});

describe("(c) the narrator gets the stated reason's kind and subject, never the candor, the goal or the terms", () => {
  const SENT_GOAL = "SENTINEL-314-GOALID", SENT_TERM = "SENTINEL-314-TERM";
  function played(): { s: GameSessionAdapter; hoh: string; mark: string; other: string; name: (id: string) => string } {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor(`r314-${Math.random()}`).session as GameSessionAdapter;
    s.createCharacter({ playerName: "P", seed: 7 });
    s.noteMessage({ messageId: "m-314" });
    const core = s.snapshot();
    const live = core.live!;
    const npcs = core.house!.npcs;
    const hoh = npcs[0]!.id, mark = npcs[1]!.id, other = npcs[2]!.id;
    live.hoh = hoh; live.nominees = [mark, other];
    (live.statedReasons ??= []).push({
      week: live.week, day: live.dayNumber ?? live.week, decider: hoh, decision: "nominate", public: true,
      real: { decision: "nominate", decider: hoh, choice: mark, goalKind: "revenge", goalId: SENT_GOAL, terms: [{ name: SENT_TERM as never, value: 0.9 }], tactic: "direct" },
      stated: { kind: "came-after-me", about: mark, candor: "cover" },
    });
    s.restore(core);
    (s as unknown as { ceremonyBeat: string }).ceremonyBeat = "nominations";
    return { s, hoh, mark, other, name: (id) => npcs.find((n) => n.id === id)!.name };
  }

  it("the decider's block and the nominations prompt carry the stated kind and subject only", () => {
    const { s, hoh, mark, name } = played();
    const voice = s.npcVoice(hoh)!;
    expect(voice.statedReasons).toEqual([{ decision: "nominate", kind: "came-after-me", about: { id: mark, name: name(mark) } }]);
    const prompt = s.getMomentPrompt({ moment: "nominations" } as never);
    const text = JSON.stringify([prompt, voice]);
    expect(prompt.systemPrompt).toContain(STATED_REASON_GLOSS["came-after-me"]!);
    expect(prompt.systemPrompt).toContain(name(mark));
    for (const secret of [SENT_GOAL, SENT_TERM, "revenge", "candor", "part-truth", "\"cover\""]) expect(text, secret).not.toContain(secret);
    for (const surface of [s.gameStatus(), s.getGameState()]) expect(JSON.stringify(surface)).not.toMatch(/SENTINEL-314|statedReasons|candor/);
    expect(JSON.stringify(s.snapshot())).toContain(SENT_GOAL); // it IS in the engine's own state
  });

  it("a secret ballot's reason is stored but never voiced, and an act not yet on the board is not voiced early", () => {
    const { s, hoh, mark, other } = played();
    const core = s.snapshot();
    const live = core.live!;
    live.statedReasons!.push({ week: live.week, day: 1, decider: hoh, decision: "vote", public: false, real: { decision: "vote", decider: hoh, choice: other, terms: [] }, stated: { kind: "biggest-threat", about: other, candor: "truth" } });
    live.nominees = [other, mark]; live.hoh = hoh;
    s.restore(core);
    expect(s.npcVoice(hoh)!.statedReasons!.map((r) => r.decision)).toEqual(["nominate"]);
    const core2 = s.snapshot(); core2.live!.nominees = undefined; s.restore(core2);
    expect(s.npcVoice(hoh)!.statedReasons).toBeUndefined();
  });

  it("(d) the old 'invent the HOH's reason' line is gone; the nominations fragment says to voice the stated reason; the BASE budget and the no-'the engine' rule hold", () => {
    const n = MOMENT_PROMPTS.nominations;
    expect(n).not.toMatch(/however brief|purely strategic, nothing personal|soften the/i);
    expect(n).toMatch(/said aloud/);
    expect(n).toMatch(/no other reason of your own/i);
    expect(BASE_GAME_MASTER_PROMPT.length).toBeLessThanOrEqual(47_000);
    for (const text of [BASE_GAME_MASTER_PROMPT, n, ...Object.values(STATED_REASON_GLOSS)]) expect(text).not.toMatch(/the engine/i);
  });
});
