import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { deriveNotoriety, type OpenSetSeasonOutcome } from "../../src/engine/notoriety";

/** AMEND 0136 — the RETURNING CAST line: present for a returning player in the early window, never for
 *  a fresh player, and gone once the early-social window has passed. Roles only. */
const LINE = "- RETURNING CAST: the house has heard things";
const TREACHEROUS: OpenSetSeasonOutcome = {
  placement: 2, castSize: 16, playerCompWins: 3,
  playerEvictionRoles: [{ blindsided: true, betrayed: true }, { blindsided: true }, { betrayed: true }],
  reachedJury: true, reachedFinalTwo: true, juryVoteShare: 0.3,
};
function start(user: string, returning: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(user);
  if (returning) sb.session.setNotoriety(deriveNotoriety(TREACHEROUS));
  sb.session.createCharacter({ playerName: "The Player", seed: 7 });
  return sb;
}
const prompt = (sb: ReturnType<typeof start>) => sb.session.getMomentPrompt({ moment: "social" }).systemPrompt;

describe("0136 — RETURNING CAST prompt line", () => {
  it("is present for a returning player at the premiere", () => {
    const sb = start("rc-ret", true);
    expect((sb.session.getGameState() as any).notorietyLegend?.length).toBeGreaterThan(0);
    expect(prompt(sb)).toContain(LINE);
  });
  it("is absent for a fresh player", () => {
    const sb = start("rc-fresh", false);
    expect((sb.session.getGameState() as any).notorietyLegend).toBeUndefined();
    expect(prompt(sb)).not.toContain("RETURNING CAST");
  });
  it("is absent once the early-social window has passed (week 2+)", () => {
    const sb = start("rc-late", true);
    for (let i = 0; i < 200 && ((sb.session.getGameState() as any).week ?? 1) < 2; i++) {
      const adv = sb.session.advanceGame();
      const p: any = adv.pending;
      if (!p) continue;
      if (p.kind === "nominations") sb.session.submitDecision({ kind: "nominations", choice: [p.options[0].id, p.options[1].id] });
      else if (p.kind === "veto-decision") sb.session.submitDecision({ kind: "veto-decision", use: false });
      else if (p.kind === "replacement") sb.session.submitDecision({ kind: "replacement", replacement: p.options[0].id });
      else sb.session.submitDecision({ kind: p.kind, vote: p.options[0]?.id } as never);
    }
    expect(((sb.session.getGameState() as any).week ?? 1)).toBeGreaterThanOrEqual(2);
    expect(prompt(sb)).not.toContain("RETURNING CAST");
  });
});
