import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";
import { buildSystemPrompt } from "../../src/engine/momentPrompts";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { deduceEvictionVoters } from "../../src/engine/voteDeduction";
import type { RandomnessSource } from "../../src/ports/RandomnessSource";

/**
 * ORW-507 (ORW-507): review findings on the vote questions (#2614) and the voice `knows` / jury prompt scope (#2617, #2625). Roles only.
 */

describe("#2614 the deduction confidence reads the margin from base scores sorted descending", () => {
  it("a jitter swap at the cut line does not turn the margin negative (it would clamp to 0 and never read as answered)", () => {
    const [A, B, C] = ["npc:1", "npc:2", "npc:3"] as EntityId[];
    const edges: Record<string, { trust: number; threat: number }> = {
      [A]: { threat: 0.5, trust: 0.5 }, // base 1.0
      [B]: { threat: 0.4, trust: 0.5 }, // base 0.9
      [C]: { threat: 0.05, trust: 0.95 }, // base 0.1
    };
    const rel = { edge: (_f: EntityId, to: EntityId) => edges[to]! };
    const draws = [0, 1, 0.5]; // A jittered down, B jittered up: the ranked order is B, A, C
    let i = 0;
    const rng = { next: () => draws[i++]! } as unknown as RandomnessSource;
    const d = deduceEvictionVoters("npc:9" as EntityId, [A, B, C], 1, rel, rng);
    expect(d.believed).toEqual([B]);
    expect(d.confidence).toBeCloseTo(0.25, 5); // (1.0 - 0.9) / 0.4, not clamp(-0.25)
  });
});

type S = {
  livingIds(): EntityId[];
  npcVoice(id: EntityId): { knows: string[] } | null;
  setDisclosureEngineEnabled(on: boolean): void;
  live: { playedGame?: boolean };
};
function played() {
  const sb = new GameSessionRegistry().sandboxFor(`o507-${Math.random()}`);
  sb.session.createCharacter({ playerName: "P", seed: 11 });
  const s = sb.session as unknown as S;
  s.live.playedGame = true;
  const [holder, other] = s.livingIds().filter((i) => i !== PLAYER) as [EntityId, EntityId];
  return { sb, s, holder, other };
}

describe("#2625 the voice `knows` cap counts distinct facts", () => {
  it("70 retellings of one rumour do not push the older distinct facts out of a 20-item window", () => {
    const { sb, s, holder, other } = played();
    s.setDisclosureEngineEnabled(false);
    const k = sb.engine.knowledge as unknown as { seedBelief(e: EntityId, f: { content: string; factId: string; subject?: EntityId }, p: string): unknown };
    for (let i = 0; i < 5; i++) k.seedBelief(holder, { content: `DISTINCT-older-fact-${i}`, factId: `f-old-${i}`, subject: other }, "witnessed");
    for (let i = 0; i < 70; i++) k.seedBelief(holder, { content: "REPEATED-rumour", factId: `f-rep-${i}`, subject: other }, "witnessed");
    const knows = s.npcVoice(holder)!.knows.join("|");
    for (let i = 0; i < 5; i++) expect(knows).toContain(`DISTINCT-older-fact-${i}`);
  });
});

describe("#2617 the disclosure lineage match never hands over a claim the player did not learn", () => {
  it("a retold copy that kept the factId but changed the claim is replaced by the player's own wording", () => {
    const { sb, s, holder, other } = played();
    const k = sb.engine.knowledge as unknown as { seedBelief(e: EntityId, f: { content: string; factId: string; subject?: EntityId }, p: string): unknown };
    k.seedBelief(holder, { content: "ESCALATED-claim-the-player-never-heard", factId: "f-x", subject: other }, "told-by:npc:9");
    k.seedBelief(PLAYER, { content: "MILD-claim-the-player-heard", factId: "f-x", subject: other }, "told-by:" + holder);
    const knows = s.npcVoice(holder)!.knows.join("|");
    expect(knows).not.toContain("ESCALATED-claim-the-player-never-heard");
    expect(knows).toContain("MILD-claim-the-player-heard");
  });
});

describe("#2617 the 'voice only what they know' rule is not applied in the jury house", () => {
  it("the moment prompt for a seated juror-player omits the disclosure instruction", () => {
    const resolve = (p: NonNullable<AdvanceView["pending"]>): SubmitDecisionReq => {
      if (p.kind === "nominations") return { kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] };
      if (p.kind === "veto-decision") return { kind: "veto-decision", use: false };
      if (p.kind === "replacement") return { kind: "replacement", replacement: p.options[0]!.id };
      if (p.kind === "comp-intent") return { kind: "comp-intent", intent: "compete" };
      if (p.kind === "comp-round") return { kind: "comp-round", intent: "compete" };
      if (p.kind === "finale-statement") return { kind: "finale-statement", statement: "x" };
      if (p.kind === "finale-answer") return { kind: "finale-answer", appeal: p.appeals![0]! };
      if (p.kind === "juror-vote") return { kind: "juror-vote", vote: p.options[0]!.id };
      if (p.kind === "exit-interview") return { kind: "exit-interview", vote: p.stances![0]! };
      if (p.kind === "spectator-choice") return { kind: "spectator-choice", vote: "watch" };
      if (p.kind === "finale-interview") return { kind: "finale-interview", vote: "gracious" };
      return { kind: p.kind, vote: p.options[0]!.id } as never;
    };
    for (let seed = 1; seed <= 120; seed++) {
      const sb = new GameSessionRegistry().sandboxFor(`o507j-${seed}`);
      sb.session.createCharacter({ playerName: "P", seed });
      for (let i = 0; i < 8000; i++) {
        const v = sb.session.advanceGame();
        const st = sb.session.getGameState();
        if (st.player?.status === "jury" && (st.juryHouse?.jurors.length ?? 0) >= 2 && !v.pending) {
          (sb.session as unknown as S).live.playedGame = true;
          const p = sb.session.getMomentPrompt({}).systemPrompt;
          expect(p).not.toContain("only what the engine has put on the table");
          return;
        }
        if (v.pending) sb.session.submitDecision(resolve(v.pending));
        if (v.finished) break;
      }
    }
    throw new Error("no seed seated the player on the jury");
  });
});


/** True when `name` is on the call stack. ORW-985: reads the frames' function names instead of building `new Error().stack` (source-mapped on every call: most of the test's time). Same frame limit. */
function calledFrom(name: string): boolean {
  const prepare = Error.prepareStackTrace;
  Error.prepareStackTrace = (_err, frames) => frames.some((f) => f.getFunctionName()?.includes(name) === true);
  try {
    const probe: { stack?: unknown } = {};
    Error.captureStackTrace(probe);
    return probe.stack === true; // the trace is built on first read, so read it while the hook is in place
  } finally {
    Error.prepareStackTrace = prepare;
  }
}

describe("#2614 the vote questions follow the FINAL eviction block, one per holder per week", () => {
  it("a replacement nominee who survives with votes against them is left with a question; refs are unique", () => {
    type L = { playedGame?: boolean; voteRecord?: unknown[]; voteQuestions?: Array<{ holder: string; ref: string; week: number }>; eviction?: { nominees: string[]; evictee?: string; voteOf: Record<string, string> } };
    let replaced = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const sb = new GameSessionRegistry().sandboxFor(`o507v-${seed}`);
      sb.session.createCharacter({ playerName: "P", seed });
      const live = (sb.session as unknown as { live: L }).live;
      // played-game-only fold: report it on only while an eviction is being committed, so the headless driver can still advance freely
      Object.defineProperty(live, "playedGame", { configurable: true, get: () => calledFrom("commitStagedEviction") });
      let seen = 0;
      for (let i = 0; i < 4000 && seen < 2; i++) {
        const v = sb.session.advanceGame();
        const n = live.voteRecord?.length ?? 0;
        if (n > seen) {
          seen = n;
          const e = live.eviction!;
          const week = live.voteQuestions?.length ? Math.max(...live.voteQuestions.map((q) => q.week)) : 0;
          for (const nom of e.nominees) {
            const against = Object.values(e.voteOf).filter((t) => t === nom).length;
            if (nom === e.evictee || nom === PLAYER || against === 0) continue;
            replaced++;
            expect(live.voteQuestions!.some((q) => q.holder === nom && q.week === week), `a surviving nominee with ${against} votes against them holds a question`).toBe(true);
          }
          const refs = (live.voteQuestions ?? []).map((q) => q.ref);
          expect(new Set(refs).size).toBe(refs.length);
        }
        if (v.pending) sb.session.submitDecision(answer(v.pending));
        if (v.finished) break;
      }
    }
    expect(replaced).toBeGreaterThan(0);
  });
});
function answer(p: NonNullable<AdvanceView["pending"]>): SubmitDecisionReq {
  if (p.kind === "nominations") return { kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] };
  if (p.kind === "veto-decision") return { kind: "veto-decision", use: false };
  if (p.kind === "replacement") return { kind: "replacement", replacement: p.options[0]!.id };
  if (p.kind === "comp-intent") return { kind: "comp-intent", intent: "compete" };
  if (p.kind === "comp-round") return { kind: "comp-round", intent: "compete" };
  return { kind: p.kind, vote: p.options?.[0]?.id } as never;
}

describe("ORW-514 the narrator prompt: the disclosure line is on outside the jury house, off inside it", () => {
  it("the same view builds a prompt with the line when the lever is on and without it when the jury-house gate turns it off", () => {
    const v = new GameSessionAdapter().createCharacter({ playerName: "P", seed: 11 });
    const LINE = "only what the engine has put on the table";
    expect(buildSystemPrompt("jury", v, undefined, undefined, undefined, undefined, { disclosureEngine: true })).toContain(LINE);
    expect(buildSystemPrompt("jury", v, undefined, undefined, undefined, undefined, { disclosureEngine: false })).not.toContain(LINE);
    expect(buildSystemPrompt("jury", v)).not.toContain(LINE);
  });
});
