import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { buildSandbox } from "../support/sandbox";
import { PLAYER } from "../../src/domain/ids";
import { boundDealTerm } from "../../src/engine/deals";
import type { BindingAction } from "../../src/engine/deals";
import { DEAL_DURATION } from "../../src/engine/relationshipConstants";
import { resolvePending } from "../../features/support/answerPending";
import type { DealView } from "../../src/ports/GameSession";

/**
 * 0109 / #1993 — the deal-duration PRODUCER. The narrator proposes `term` on `makeDeal`; the ENGINE
 * validates + bounds it, the ledger records it, and break-severity / expiry then act on it in LIVE play.
 * Roles only. The scale math itself is covered by dealDuration.test.ts; this proves it is REACHABLE.
 */

function game(seed = 7) {
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "The Player", seed });
  s.setNpcDealConsentEnabled(false); // these tests exercise deal MECHANICS, not NPC consent (dealConsent*.test.ts cover that)
  const npc = s.getGameState().house[0]!.id;
  return { s, npc };
}
const week = (s: GameSessionAdapter) => s.snapshot().live!.week;
/** The break trigger: the player (promisor) nominates the protected partner — the real adjudication path. */
function breakIt(s: GameSessionAdapter, partner: string): void {
  (s as unknown as { reconcileDeals(a: BindingAction): void }).reconcileDeals({
    actor: PLAYER, kind: "nominate", targets: [partner],
  });
}
const threat = (s: GameSessionAdapter, npc: string) =>
  (s as unknown as { rel: { edge(a: string, b: string): { threat: number } } }).rel.edge(npc, PLAYER).threat;

describe("boundDealTerm — the engine's validation + bound (pure)", () => {
  it("counts the current week: weeks N ⇒ expiresWeek = madeWeek + N - 1", () => {
    expect(boundDealTerm({ weeks: 1 }, 3)).toEqual({ expiresWeek: 3 });
    expect(boundDealTerm({ weeks: 2 }, 3)).toEqual({ expiresWeek: 4 });
  });
  it("clamps an over-long proposal to the cap", () => {
    expect(boundDealTerm({ weeks: 999 }, 1)).toEqual({ expiresWeek: DEAL_DURATION.maxTermWeeks });
  });
  it("ignores junk (non-integer, non-positive, non-finite, wrong type) and falls to the default", () => {
    for (const weeks of [0, -2, 1.5, NaN, Infinity, "3", null, {}]) {
      expect(boundDealTerm({ weeks }, 2)).toBeUndefined();
    }
    expect(boundDealTerm(undefined, 2)).toBeUndefined();
    expect(boundDealTerm({}, 2)).toBeUndefined();
    expect(boundDealTerm({ vague: false }, 2)).toBeUndefined();
  });
  it("an explicit term wins over vague; vague alone is the vague label", () => {
    expect(boundDealTerm({ weeks: 2, vague: true }, 1)).toEqual({ expiresWeek: 2 });
    expect(boundDealTerm({ vague: true }, 1)).toEqual({ vague: true });
  });
});

describe("0109 — makeDeal carries a negotiated term in live play", () => {
  it("records the bounded term and shows it (and nothing derived) on the player's deal", () => {
    const { s, npc } = game();
    const w = week(s);
    const v = s.makeDeal({ with: npc, kind: "final-two", terms: "two weeks", term: { weeks: 2 } }) as DealView;
    expect(v.term).toEqual({ expiresWeek: w + 1 });
    const blob = JSON.stringify(s.getGameState().deals);
    for (const banned of ["severity", "scale", "vagueSoften", "perWeekRemaining", "maxScale", "trust", "threat"]) {
      expect(blob.includes(banned)).toBe(false);
    }
  });
  it("no term / junk term ⇒ no term key at all (the default is unchanged)", () => {
    const { s, npc } = game();
    const a = s.makeDeal({ with: npc, kind: "safety", terms: "plain" }) as DealView;
    const b = s.makeDeal({ with: npc, kind: "vote", terms: "junk", term: { weeks: -3 } }) as DealView;
    expect("term" in a).toBe(false);
    expect("term" in b).toBe(false);
  });
  it("the term and the vague label survive a snapshot → restore", () => {
    const { s, npc } = game();
    const w = week(s);
    s.makeDeal({ with: npc, kind: "final-two", terms: "t", term: { weeks: 3 } });
    s.makeDeal({ with: npc, kind: "safety", terms: "v", term: { vague: true } });
    const r = new GameSessionAdapter();
    r.restore(s.snapshot());
    const deals = r.getGameState().deals ?? [];
    expect(deals.map((d) => d.term)).toEqual([{ expiresWeek: w + 2 }, { vague: true }]);
  });
  it("breaking early hurts more the more term was left (live break path)", () => {
    const long = game(); const short = game();
    long.s.makeDeal({ with: long.npc, kind: "final-two", terms: "long", term: { weeks: 8 } });
    short.s.makeDeal({ with: short.npc, kind: "final-two", terms: "short", term: { weeks: 1 } });
    const l0 = threat(long.s, long.npc), s0 = threat(short.s, short.npc);
    breakIt(long.s, long.npc); breakIt(short.s, short.npc);
    expect(threat(long.s, long.npc) - l0).toBeGreaterThan(threat(short.s, short.npc) - s0);
    expect(long.s.getGameState().deals![0]!.status).toBe("broken");
  });
  it("a vague deal's break is softer than a no-term break, yet still a betrayal", () => {
    const vague = game(); const plain = game();
    vague.s.makeDeal({ with: vague.npc, kind: "final-two", terms: "v", term: { vague: true } });
    plain.s.makeDeal({ with: plain.npc, kind: "final-two", terms: "p" });
    const v0 = threat(vague.s, vague.npc), p0 = threat(plain.s, plain.npc);
    breakIt(vague.s, vague.npc); breakIt(plain.s, plain.npc);
    const vRise = threat(vague.s, vague.npc) - v0, pRise = threat(plain.s, plain.npc) - p0;
    expect(vRise).toBeGreaterThan(0);
    expect(vRise).toBeLessThan(pRise);
  });
  it("a negotiated term that passes un-broken resolves KEPT as the weeks roll; a termless season deal stays open", () => {
    const { s, npc } = game();
    const w = week(s);
    const termed = s.makeDeal({ with: npc, kind: "final-two", terms: "one week", term: { weeks: 1 } }) as DealView;
    const open = s.makeDeal({ with: npc, kind: "final-two", terms: "forever" }) as DealView;
    for (let i = 0; i < 400 && week(s) <= w; i++) {
      const v = s.advanceGame();
      if (v.pending) resolvePending(v.pending, (req) => s.submitDecision(req));
      if (v.finished) break;
    }
    expect(week(s)).toBeGreaterThan(w);
    const by = (id: string) => s.getGameState().deals!.find((d) => d.id === id)!;
    expect(by(termed.id).status).toBe("kept");
    expect(by(open.id).status).toBe("open");
  });
});

describe("0109 — the makeDeal MCP boundary accepts / refuses `term`", () => {
  function server() {
    const sb = buildSandbox(7);
    const session = new GameSessionAdapter();
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const srv = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
    session.createCharacter({ playerName: "The Player", seed: 7 });
    session.setNpcDealConsentEnabled(false); // these tests exercise deal MECHANICS, not NPC consent (dealConsent*.test.ts cover that)
    return { srv, session, npc: session.getGameState().house[0]!.id };
  }
  it("dispatches a well-formed term through callTool and the deal carries it", async () => {
    const { srv, session, npc } = server();
    await srv.callTool("makeDeal", { with: npc, kind: "final-two", terms: "t", term: { weeks: 2 } });
    expect(session.getGameState().deals![0]!.term).toEqual({ expiresWeek: session.snapshot().live!.week + 1 });
  });
  it("refuses a non-object term at the boundary (no deal is made)", async () => {
    const { srv, session, npc } = server();
    await expect(srv.callTool("makeDeal", { with: npc, kind: "safety", terms: "t", term: "two weeks" })).rejects.toThrow();
    expect(session.getGameState().deals ?? []).toHaveLength(0);
  });
});

describe("0109 — an explicit term governs a week-scoped kind (#1993 review)", () => {
  it("a `safety` deal promised for 3 weeks does not lapse at the first eviction", () => {
    const { s, npc } = game();
    const w = week(s);
    const d = s.makeDeal({ with: npc, kind: "safety", terms: "three weeks", term: { weeks: 3 } }) as DealView;
    const plain = s.makeDeal({ with: npc, kind: "safety", terms: "this week" }) as DealView;
    for (let i = 0; i < 400 && week(s) <= w; i++) {
      const v = s.advanceGame();
      if (v.pending) resolvePending(v.pending, (req) => s.submitDecision(req));
      if (v.finished) break;
    }
    const by = (id: string) => s.getGameState().deals!.find((x) => x.id === id)!;
    expect(by(plain.id).status).toBe("kept"); // kind horizon unchanged
    expect(by(d.id).status).toBe("open");     // its own longer term governs
  });
});
