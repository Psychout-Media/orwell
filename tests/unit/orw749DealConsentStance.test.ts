import { describe, it, expect } from "vitest";
import { playDealsGame } from "../support/npcDealsDriver";
import { renderGameContext } from "../../src/engine/momentPrompts";
import type { GameStateView, PresentKnowledgeView } from "../../src/ports/GameSession";

/**
 * ORW-749: the narrator is told each present houseguest's engine-decided consent BEFORE it speaks, so a deal the engine refuses is never voiced as accepted. Roles only.
 * Real path: a seeded played game, the per-turn knowledge block the narrator reads, then the real `makeDeal` against that stance, then the prompt render.
 */
type Stance = "will-accept" | "will-decline" | "undecided";
type Sess = {
  live?: { week: number; playedGame?: boolean; active: string[] };
  dealConsentStanceFor(id: string): Stance | undefined;
  presentKnowledgeForPrompt(): PresentKnowledgeView[];
  makeDeal(req: { with: string; kind: string; terms: string }): { refused?: true } | null;
};

describe("ORW-749 the narrator's consent read is the engine's decision", () => {
  it("the stance in the narrator's block matches what makeDeal then does, so a refusal is never voiced as accepted", async () => {
    let accepts = 0, declines = 0, wrong = 0, blocksWithStance = 0, blockMismatch = 0;
    for (const seed of [3, 4]) {
      const g = await playDealsGame(seed, 400, { until: (x) => (x.session as unknown as Sess).live?.playedGame === true && x.week() >= 2 });
      const s = g.session as unknown as Sess;
      if (s.live?.playedGame !== true) continue;
      const pk = s.presentKnowledgeForPrompt();
      for (const e of pk) {
        const stance = s.dealConsentStanceFor(e.id);
        if (e.dealConsent) { blocksWithStance++; if (e.dealConsent !== stance) blockMismatch++; }
      }
      for (const id of s.live.active) {
        const stance = s.dealConsentStanceFor(id);
        if (!stance || stance === "undecided") continue;
        const out = s.makeDeal({ with: id, kind: "safety", terms: "keep me safe" });
        const refused = !!out && "refused" in out;
        if (stance === "will-accept") { accepts++; if (refused) wrong++; }
        else { declines++; if (!refused) wrong++; }
      }
    }
    expect(wrong).toBe(0);
    expect(blockMismatch).toBe(0);
    expect(accepts + declines).toBeGreaterThan(0);
    expect(blocksWithStance + accepts + declines).toBeGreaterThan(0);
  }, 180000);
});

describe("ORW-749 the narrator is handed the consent and the rule", () => {
  const mk = (stance: Stance | undefined): GameStateView => ({ started: true, player: { id: "p", name: "Role P", status: "active" }, house: [], week: 3, phase: "eviction", presentKnowledge: [{ id: "a", name: "Role A", knows: [], suspects: [], ...(stance ? { dealConsent: stance } : {}) }] } as unknown as GameStateView);
  it("renders the line and the rule that a will-decline is never voiced as a deal made", () => {
    const out = renderGameContext(mk("will-decline"));
    expect(out).toContain("dealConsent (what they do with a deal the player pitches now): will-decline");
    expect(out).toContain("Never voice a deal as made, shaken on or agreed against a will-decline");
  });
  it("renders nothing of it when nothing is decided", () => {
    expect(renderGameContext(mk(undefined))).not.toContain("dealConsent");
  });
});
