import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { AdvanceView } from "../../src/ports/GameSession";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { buildDecisionReveal, REVEAL_CAP } from "../../src/engine/decisionReveal";
import type { StatedReasonRecord, DecisionKind, StatedReasonKind } from "../../src/engine/agendaDecisions";

/** ORW-656 companion: the retrospective's `decisionReveal` (said vs real reason kinds). Roles only. */
const nameOf = (id: string): string => `Name-${id.replace(/\D/g, "")}`;
const rec = (o: { week: number; decider: string; choice: string; decision?: DecisionKind; said?: StatedReasonKind; goal?: boolean; pub?: boolean }): StatedReasonRecord => ({
  week: o.week, day: o.week * 5, decider: o.decider, decision: o.decision ?? "nominate", public: o.pub ?? true,
  real: { decision: o.decision ?? "nominate", decider: o.decider, choice: o.choice, ...(o.goal ? { goalKind: "get-them-out" as const, goalId: "g" } : {}), terms: o.goal ? [] : [{ name: "bond", value: 0.7 }] },
  stated: { kind: o.said ?? "biggest-threat", about: o.choice, candor: "cover" },
});

describe("decisionReveal (pure)", () => {
  it("shows both kinds and both names for a said-vs-real mismatch; no ids or numbers", () => {
    const v = buildDecisionReveal({ records: [rec({ week: 2, decider: "npc:1", choice: "npc:2", said: "nothing-personal" })], voteRecord: [], nameOf })!;
    const d = v.decisions[0]!;
    expect(d.mismatch).toBe(true);
    expect(d.saidKind).toBe("nothing-personal");
    expect(d.realKind).toBe("loyal-to-my-side");
    expect(d.line).toContain("Name-1");
    expect(d.line).toContain("Name-2");
    expect(JSON.stringify(v)).not.toMatch(/npc:|\d\.\d|0\.7/);
  });
  it("absent when empty; deterministic under input order; bounded; the mismatches are kept first", () => {
    expect(buildDecisionReveal({ records: [], voteRecord: [], nameOf })).toBeUndefined();
    const rows = Array.from({ length: 40 }, (_, i) => rec({ week: 1 + (i % 9), decider: `npc:${i + 1}`, choice: "npc:99", said: i % 4 === 0 ? "loyal-to-my-side" : "nothing-personal" }));
    const a = buildDecisionReveal({ records: rows, voteRecord: [], nameOf })!;
    expect(JSON.stringify(buildDecisionReveal({ records: [...rows].reverse(), voteRecord: [], nameOf }))).toBe(JSON.stringify(a));
    expect(a.decisions.length).toBe(REVEAL_CAP);
    expect(a.decisions.every((d) => d.mismatch)).toBe(true); // 30 mismatches fill the cap
    for (let i = 1; i < a.decisions.length; i++) expect(a.decisions[i - 1]!.week).toBeLessThanOrEqual(a.decisions[i]!.week);
  });
  it("a secret ballot is shown only where the vote record already attributes it", () => {
    const secret = rec({ week: 3, decider: "npc:1", choice: "npc:2", decision: "vote", pub: false });
    const shown = buildDecisionReveal({ records: [secret], voteRecord: [{ week: 3, voteOf: { "npc:1": "npc:2" } }], nameOf });
    const hidden = buildDecisionReveal({ records: [secret], voteRecord: [{ week: 3, voteOf: { "npc:1": "npc:9" } }], nameOf });
    expect(shown?.decisions).toHaveLength(1);
    expect(hidden).toBeUndefined();
  });
});

function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.options[0]) s.submitDecision({ kind: p.kind, vote: p.options[0].id, replacement: p.options[0].id } as never);
}
type Priv = { live: { playedGame?: boolean; statedReasons?: StatedReasonRecord[] }; house: { npcs: Array<{ id: string }> } };
describe("decisionReveal in a season", () => {
  it("nothing before the crown and in no live read; after it the mismatch appears; a headless season carries none", () => {
    const sb = new GameSessionRegistry().sandboxFor("dr-1");
    sb.session.createCharacter({ playerName: "The Player", seed: 5 });
    const s = sb.session as GameSessionAdapter, p = sb.session as unknown as Priv;
    const [a, b] = p.house.npcs.map((n) => n.id);
    p.live.statedReasons = [rec({ week: 1, decider: a!, choice: b!, said: "nothing-personal" })];
    expect(s.seasonRetrospective(), "before the crown: nothing at all").toBeNull();
    const seen: unknown[] = [];
    for (let i = 0; i < 4000; i++) { const v = s.advanceGame(); seen.push(v); if (v.pending) resolve(s, v.pending); if (v.finished) break; }
    expect(JSON.stringify(seen)).not.toContain("decisionReveal");
    expect(JSON.stringify(seen)).not.toContain("the real driver");
    expect(s.seasonRetrospective()!.decisionReveal, "headless: no unsealing").toBeUndefined();
    p.live.playedGame = true;
    const r = s.seasonRetrospective()!;
    const d = r.decisionReveal!.decisions.find((x) => x.saidKind === "nothing-personal")!;
    expect(d.mismatch).toBe(true);
    expect(d.realKind).toBe("loyal-to-my-side");
    expect(JSON.stringify(r.decisionReveal)).not.toMatch(/npc:\d|\d\.\d/);
    expect(JSON.stringify(s.seasonRetrospective())).toBe(JSON.stringify(r));
  }, 180_000);
});
