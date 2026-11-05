import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView } from "../../src/ports/GameSession";
import { resolvePending } from "../../features/support/answerPending";

/**
 * (header kept for the shared harness) 0128 through the LIVE adapter (flag ON): a real game reaches Final 3, the Final HOH is the three-part tournament (two `final-hoh-part` announcements, then the
 * new-Head-of-Household one), the player's cards say which part they are in, the persisted snapshot resumes mid-tournament to the SAME Final HOH, and the Final
 * HOH still personally evicts one of the other two (0045). Roles only.
 */
let n = 0;
function toFinalThree(seed: number, on: boolean): { s: GameSessionAdapter; reg: GameSessionRegistry; user: string } | null {
  const reg = new GameSessionRegistry();
  const user = `fh3-${n++}`;
  const s = reg.sandboxFor(user).session;
  s.createCharacter({ playerName: "P", seed });
  s.setFinalHohThreePartEnabled(on);
  for (let i = 0; i < 6000; i++) {
    const st = s.getGameState();
    const activeCount = st.house.filter((h) => h.status === "active").length + (st.player?.status === "active" ? 1 : 0);
    if (st.phase === "hoh-competition" && activeCount === 3) return { s, reg, user };
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    if (v.finished) return null;
  }
  return null;
}
function playOut(s: GameSessionAdapter, until: (v: AdvanceView) => boolean): { views: AdvanceView[]; cards: string[] } {
  const views: AdvanceView[] = [], cards: string[] = [];
  for (let i = 0; i < 400; i++) {
    const v = s.advanceGame();
    views.push(v);
    if (until(v)) break;
    if (v.pending) {
      if (v.pending.kind === "comp-round" && v.pending.finalHohPart) cards.push(`${v.pending.finalHohPart}`);
      const sub = (req: Parameters<GameSessionAdapter["submitDecision"]>[0]): void => void s.submitDecision(req);
      resolvePending(v.pending, sub);
    }
    if (v.finished) break;
  }
  return { views, cards };
}
const kinds = (views: AdvanceView[]) => views.flatMap((v) => (v.announcements ?? []).map((a) => a.kind));
const resumeTotal = (s: GameSessionAdapter): number => Object.values((s as unknown as { snapshot(): { live?: { resume?: Record<string, number> } } }).snapshot().live?.resume ?? {}).reduce((a, b) => a + b, 0);

/** S16 / AMEND 0125-0128 item 1 - PO ruling (Ryne 2026-11-05): winning parts of the three-part Final HOH count toward the jury's respect for the competition record. Each part win credits the
 *  winner's resume exactly ONCE, and the crown (Part 3) is not credited twice. Roles only. */
describe("0128 resume credit - each Final HOH part win counts once (PO ruling)", () => {
  it("flag ON: the tournament adds exactly three resume credits (Part 1, Part 2, Part 3 = the crown) - no double credit", () => {
    let checked = 0;
    for (let seed = 1; seed <= 12 && checked < 2; seed++) {
      const g = toFinalThree(seed, true);
      if (!g) continue;
      const before = resumeTotal(g.s);
      const { views } = playOut(g.s, (v) => (v.announcements ?? []).some((a) => a.kind === "hoh-winner"));
      const k = kinds(views);
      expect(k.filter((x) => x === "final-hoh-part"), `seed ${seed}`).toHaveLength(2);
      expect(k.filter((x) => x === "hoh-winner")).toHaveLength(1);
      expect(resumeTotal(g.s) - before, `seed ${seed}: parts 1+2 and the crown`).toBe(3);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("flag OFF (single comp): exactly one resume credit for the Final HOH - the baseline the ON path adds two parts to", () => {
    const g = toFinalThree(3, false);
    expect(g).not.toBeNull();
    const before = resumeTotal(g!.s);
    playOut(g!.s, (v) => (v.announcements ?? []).some((a) => a.kind === "hoh-winner"));
    expect(resumeTotal(g!.s) - before).toBe(1);
  });
});
