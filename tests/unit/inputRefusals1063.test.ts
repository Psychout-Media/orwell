import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineRefusal } from "../../src/domain/errors";
import { resolvePending } from "../../features/support/answerPending";
import { priv, setup, at } from "../support/napWorld";

/** ORW-1063 / ORW-1067: an invalid decision, a silent default or a clamp is REFUSED or REPORTED, counted, and never cached as a success. Roles only. */
type S = GameSessionAdapter;
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function atPending(seed: number, kinds?: string[]): { s: S; kind: string } {
  const s = new GameSessionRegistry().sandboxFor(`r1063-${seed}`).session as S;
  s.createCharacter({ playerName: "P", seed });
  for (let i = 0; i < 400; i++) {
    const v = s.advanceGame();
    if (v.pending && (!kinds || kinds.includes(v.pending.kind))) return { s, kind: v.pending.kind };
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
  }
  throw new Error("no pending reached");
}
const refusal = (f: () => unknown): string => { try { f(); } catch (e) { expect(e).toBeInstanceOf(EngineRefusal); return (e as Error).message; } throw new Error("expected a refusal"); };

describe("ORW-1063 - submitDecision refuses what it cannot record", () => {
  it("a mismatched kind is refused with the open kind named, changes nothing and is counted", () => {
    const { s, kind } = atPending(3);
    const wrong = kind === "eviction-vote" ? "replacement" : "eviction-vote";
    const before = JSON.stringify(s.snapshot());
    const msg = refusal(() => s.submitDecision({ kind: wrong, vote: "npc:1" } as never));
    expect(msg).toContain("kind-mismatch");
    expect(msg).toContain(kind);
    expect(JSON.stringify(s.snapshot())).toBe(before);
    expect(s.inputRefusalCounts()["decision-kind-mismatch"]).toBe(1);
  });
  it("a refusal is not cached under the idempotency key: the right decision with the same key still resolves", () => {
    const { s, kind } = atPending(3, ["veto-decision", "nominations"]);
    const wrong = kind === "veto-decision" ? "eviction-vote" : "veto-decision";
    const seq = s.getGameState().beatSeq;
    refusal(() => s.submitDecision({ kind: wrong, vote: "npc:1", use: false, idempotencyKey: "k1" } as never));
    const p = s.getGameState().pending!;
    const req = kind === "veto-decision" ? { kind, use: false, idempotencyKey: "k1" } : { kind, choice: [p.options[0]!.id, p.options[1]!.id], idempotencyKey: "k1" };
    const v = s.submitDecision(req as never);
    expect(v.beatSeq).toBeGreaterThan(seq);
  });
  it("a deal offer answered with a garbled vote and a meeting answer with a garbled stance are refused", () => {
    const { s } = atPending(3);
    expect(refusal(() => s.submitDecision({ kind: "deal-offer", vote: "maybe" } as never))).toContain("bad-answer");
    expect(refusal(() => s.submitDecision({ kind: "meeting-answer", vote: "shrug" } as never))).toContain("bad-answer");
    expect(s.inputRefusalCounts()["decision-bad-answer"]).toBe(2);
  });
  it("a self-evict that is unconfirmed, or confirmed with nothing raised, is refused and the player stays in", () => {
    const { s } = atPending(3);
    const before = JSON.stringify(s.snapshot());
    expect(refusal(() => s.submitDecision({ kind: "self-evict" } as never))).toContain("unconfirmed");
    expect(refusal(() => s.submitDecision({ kind: "self-evict", confirmed: true } as never))).toContain("no-pending");
    expect(JSON.stringify(s.snapshot())).toBe(before);
  });
  it("with no matching open decision at all, the answer is refused as no-pending", () => {
    const { s } = atPending(3);
    for (let i = 0; i < 400 && s.getGameState().pending; i++) { const p = s.getGameState().pending!; resolvePending(p, (req) => void s.submitDecision(req)); }
    if (s.getGameState().pending) return;
    expect(refusal(() => s.submitDecision({ kind: "eviction-vote", vote: "npc:1" } as never))).toContain("no-pending");
  });
});

describe("ORW-1067 - strict booleans, reported clamps, named candidates", () => {
  it("veto-decision: a missing use and the string false are refused, a boolean is accepted", () => {
    const { s } = atPending(3);
    const conv = (r: unknown): unknown => (s as unknown as { toDecisionInput(r: unknown): unknown }).toDecisionInput(r);
    expect(() => conv({ kind: "veto-decision" })).toThrow(EngineRefusal);
    expect(() => conv({ kind: "veto-decision", use: "false" })).toThrow(EngineRefusal);
    expect(() => conv({ kind: "veto-decision", use: 0 })).toThrow(EngineRefusal);
    expect(conv({ kind: "veto-decision", use: false })).toMatchObject({ use: false });
    expect(conv({ kind: "veto-decision", use: true })).toMatchObject({ use: true });
    expect(s.inputRefusalCounts()["veto-use-not-boolean"]).toBe(3);
  });
  it("nap: an out-of-range length is reported with the value applied; a legal one is not flagged", () => {
    const { s } = setup(); at(s, 8);
    const r = s.nap({ hours: 10 });
    expect(r).toMatchObject({ ok: true, clamped: true, hoursApplied: 3, hoursAsked: 10 });
    at(s, 8);
    const ok = s.nap({ hours: 2 });
    expect(ok.clamped).toBeUndefined();
    at(s, 8);
    expect(s.nap({}).clamped).toBeUndefined();
    expect(s.inputRefusalCounts()["nap-clamped"]).toBe(1);
  });
  it("hangOut: a maxBeats over the cap is reported with the value applied", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor("r1063-ho").session as S;
    s.createCharacter({ playerName: "P", seed: 3 });
    s.setPerConversationClockEnabled(true); s.setHangOutEnabled(true);
    let ready = false;
    for (let i = 0; i < 600 && !ready; i++) {
      const v = s.advanceGame();
      if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
      const st = s.getGameState() as { daySchedule?: { due: boolean }; pending?: unknown };
      ready = !!st.daySchedule && st.daySchedule.due === false && !st.pending && ((s.snapshot() as unknown as { live: { dayNumber?: number } }).live.dayNumber ?? 1) >= 2;
    }
    expect(ready).toBe(true);
    const r = s.hangOut({ maxBeats: 50 });
    expect(r).toMatchObject({ ok: true, clamped: true, maxBeatsAsked: 50, maxBeatsApplied: 8 });
    expect(s.inputRefusalCounts()["hangout-clamped"]).toBe(1);
  });
  it("npcVoice: an ambiguous first name returns its candidates through the tool; an unknown name says so; a surname and an upper-case id resolve", () => {
    const { s } = setup();
    const npcs = (priv(s) as unknown as { house: { npcs: { id: string; name: string }[] } }).house.npcs;
    npcs[0]!.name = "Sam Alpha"; npcs[1]!.name = "Sam Bravo"; npcs[2]!.name = "Chris Unique";
    expect(s.npcVoice(npcs[0]!.id as never)).not.toBeNull();
    expect(s.npcVoice("Sam" as never)).toBeNull();
    const l = s.voiceLookup("Sam");
    expect(l).toMatchObject({ status: "ambiguous" });
    expect((l as { candidates: { name: string }[] }).candidates.map((c) => c.name).sort()).toEqual(["Sam Alpha", "Sam Bravo"]);
    expect(s.voiceLookup("zzz")).toEqual({ status: "unknown" });
    expect(s.voiceLookup("Unique")).toMatchObject({ status: "found", id: npcs[2]!.id });
    expect(s.voiceLookup(npcs[2]!.id.toUpperCase())).toMatchObject({ status: "found", id: npcs[2]!.id });
    expect(s.inputRefusalCounts()["npc-voice-ambiguous"]).toBeGreaterThanOrEqual(1);
  });
});
