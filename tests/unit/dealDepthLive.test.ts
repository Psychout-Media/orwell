import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, DealView, GameSession } from "../../src/ports/GameSession";

/**
 * Feature 0121 (Part 2) — the ACTIVE-obligation kinds fire LIVE. Drives a real season through the engine
 * (no LLM) and proves a `comp-throw` promise auto-resolves at the HOH crown: broken iff the promisor WON
 * (took the power they swore to give up), kept otherwise. Roles only. Gated on the deal-depth layer.
 */

afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function resolveExcept(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
}

describe("0121 — comp-throw resolves live at the HOH crown (broken iff the promisor wins)", () => {
  it("a player who promised to throw the HOH is judged by whether they took the power", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("dd-live");
    sb.session.createCharacter({ playerName: "The Player", seed: 9 });
    sb.session.setNpcDealConsentEnabled(false); // these tests exercise deal MECHANICS, not NPC consent (dealConsent*.test.ts cover that)
    sb.session.setDealDepthEnabled(true);

    // Advance until the first HOH competition is the live pending decision (the player can deal now).
    let madeId: string | undefined;
    for (let i = 0; i < 40; i++) {
      const snap = sb.session.snapshot();
      // Once the season is live and the HOH comp is pending, strike a comp-throw with a houseguest.
      if (madeId === undefined && snap.live && snap.live.hoh === undefined) {
        const npcId = sb.session.livingIds().find((id) => id !== PLAYER);
        if (npcId) {
          const deal = sb.session.makeDeal({ with: npcId, kind: "comp-throw", terms: "I'll throw the HOH for you" }) as DealView | null;
          if (deal) madeId = deal.id;
        }
      }
      if (sb.session.snapshot().live?.hoh !== undefined) break; // the comp has crowned
      const v = sb.session.advanceGame();
      if (v.pending) resolveExcept(sb.session, v.pending);
      if (v.finished) break;
    }

    expect(madeId, "a comp-throw deal was struck before the HOH crowned").toBeDefined();
    const winner = sb.session.snapshot().live!.hoh;
    expect(winner, "the HOH comp crowned a winner").toBeDefined();

    // The deal must have RESOLVED at the crown (never left dangling), and its verdict must match the
    // observable outcome: broken iff the player (the promisor) took the HOH they swore to throw.
    const deal = sb.session.getGameState().deals?.find((d) => d.id === madeId);
    expect(deal, "the comp-throw deal is on the player's board").toBeDefined();
    if (winner === PLAYER) expect(deal!.status).toBe("broken"); // took the power => betrayed the throw
    else expect(deal!.status).toBe("kept"); // didn't win => let it go, promise honored
  });

  it("with the deal-depth layer OFF, a comp-throw can't even be made (byte-identical)", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("dd-off-live");
    sb.session.createCharacter({ playerName: "The Player", seed: 9 });
    sb.session.setNpcDealConsentEnabled(false); // these tests exercise deal MECHANICS, not NPC consent (dealConsent*.test.ts cover that)
    sb.session.setDealDepthEnabled(false);
    for (let i = 0; i < 20 && sb.session.snapshot().live?.hoh === undefined; i++) {
      const v = sb.session.advanceGame();
      if (v.pending) resolveExcept(sb.session, v.pending);
      if (v.finished) break;
    }
    const npcId = sb.session.livingIds().find((id) => id !== PLAYER)!;
    expect(sb.session.makeDeal({ with: npcId, kind: "comp-throw", terms: "throw" })).toBeNull();
  });
});
