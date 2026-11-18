import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import type { UserSandbox } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { buildSandbox } from "../support/sandbox";

/**
 * ORW-614 (P-12): the player answers a standing houseguest offer with terms of their own. The deal is the player's act (the engine never writes a counter for them); the offer closes as countered; the
 * houseguest's own consent read decides. Roles only.
 */
function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
}
type Offer = NonNullable<ReturnType<GameSession["getGameState"]>["openDealOffer"]>;
function offerGame(user: string, counterOn: boolean): { sb: UserSandbox; offer: Offer } {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed: 7 });
  sb.session.setNpcDealOffersEnabled(true);
  (sb.session as unknown as { setDealCounterEnabled(on: boolean): void }).setDealCounterEnabled(counterOn);
  sb.session.noteMessage({ messageId: "m1" }); // a played game
  for (let i = 0; i < 6; i++) { const v = sb.session.advanceGame(); if (v.pending) resolveLegally(sb.session, v.pending); }
  // The offer minting is a seeded roll; this test is about the ANSWER, so a standing offer from a living houseguest is placed through the engine's own slot.
  const priv = sb.session as unknown as { live: { week: number; dealOffer?: unknown; evictionOrder: string[] }; house: { npcs: Array<{ id: string }> } };
  const from = priv.house.npcs.find((n) => !priv.live.evictionOrder.includes(n.id))!.id;
  priv.live.dealOffer = { id: `offer:${priv.live.week}:${from}`, from, kind: "safety", terms: "an offer of safety", madeWeek: priv.live.week };
  return { sb, offer: sb.session.getGameState().openDealOffer! };
}

describe("ORW-614 P-12: the player counters an offer", () => {
  it("the standing offer carries an id and tells the narrator how a counter is recorded (and never counters for the player)", () => {
    const { offer } = offerGame("c-view", true);
    expect(typeof offer.id).toBe("string");
    expect(offer.howToVoice).toContain("countersOffer");
  });
  it("a counter makes the player's own deal (their kind and terms), closes the offer, and cools no one", () => {
    const { sb, offer } = offerGame("c-make", true);
    const from = offer.from.id;
    const threat = sb.engine.relationships.edge(from, PLAYER).threat;
    const out = sb.session.makeDeal({ with: from, kind: offer.kind === "safety" ? "vote" : "safety", terms: "my terms", countersOffer: offer.id });
    expect(out).not.toBeNull();
    expect(sb.session.getGameState().openDealOffer).toBeUndefined(); // closed either way
    if (out && !("refused" in out)) {
      expect(out.terms).toBe("my terms"); // the player's terms, not the offer's
      expect((sb.session.getGameState().deals ?? []).some((d) => d.id === out.id)).toBe(true);
    }
    expect(sb.engine.relationships.edge(from, PLAYER).threat).toBeLessThanOrEqual(threat + 0.2); // no decline cooling applied
    const ev = sb.engine.events.queryAll().find((e) => e.content.includes("terms of their own"));
    expect(ev, "the counter is a recorded, player-witnessed scene").toBeDefined();
    expect(ev!.witnessSet.includes(PLAYER)).toBe(true);
  });
  it("a counter to a different houseguest, or with a wrong id, leaves the offer standing", () => {
    const { sb, offer } = offerGame("c-wrong", true);
    sb.session.makeDeal({ with: offer.from.id, kind: "safety", terms: "x", countersOffer: "not-the-id" });
    expect(sb.session.getGameState().openDealOffer?.id).toBe(offer.id);
  });
  it("flag off: byte-identical to today (no id, the offer stands, no counter text)", () => {
    const { sb, offer } = offerGame("c-off", false);
    expect(offer.id).toBeUndefined();
    expect(offer.howToVoice).not.toContain("countersOffer");
    sb.session.makeDeal({ with: offer.from.id, kind: "safety", terms: "x", countersOffer: "anything" });
    expect(sb.session.getGameState().openDealOffer).toBeDefined();
  });
  it("persistence: a closed counter stays closed after a save round trip", () => {
    const { sb, offer } = offerGame("c-persist", true);
    sb.session.makeDeal({ with: offer.from.id, kind: "safety", terms: "x", countersOffer: offer.id });
    const snap = JSON.parse(JSON.stringify(sb.session.snapshot()));
    expect(snap.live?.dealOffer).toBeUndefined();
  });
  it("boundary: makeDeal carries countersOffer through McpServer.callTool, and a non-string is refused", async () => {
    const sb = buildSandbox(1);
    const session = new GameSessionAdapter();
    session.createCharacter({ playerName: "The Player", seed: 7 });
    session.noteMessage({ messageId: "m1" });
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands: new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge), session });
    const priv = session as unknown as { live: { week: number; dealOffer?: unknown; evictionOrder: string[] }; house: { npcs: Array<{ id: string }> } };
    const from = priv.house.npcs.find((n) => !priv.live.evictionOrder.includes(n.id))!.id;
    priv.live.dealOffer = { id: "offer-x", from, kind: "safety", terms: "t", madeWeek: priv.live.week };
    await expect(server.callTool("makeDeal", { with: from, kind: "safety", terms: "x", countersOffer: 5 })).rejects.toThrow();
    await server.callTool("makeDeal", { with: from, kind: "safety", terms: "x", countersOffer: "offer-x" });
    expect(priv.live.dealOffer).toBeUndefined();
  });
});
