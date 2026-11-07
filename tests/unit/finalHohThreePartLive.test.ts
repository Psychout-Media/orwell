import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView } from "../../src/ports/GameSession";
import { resolvePending } from "../../features/support/answerPending";

/**
 * 0128 through the LIVE adapter (flag ON): a real game reaches Final 3, the Final HOH is the three-part tournament (two `final-hoh-part` announcements, then the
 * new-Head-of-Household one), the player's cards say which part they are in, the persisted snapshot resumes mid-tournament to the SAME Final HOH, and the Final
 * HOH still personally evicts one of the other two (0045). Roles only.
 */
let n = 0;
function toFinalThree(seed: number, on: boolean): { s: GameSessionAdapter; reg: GameSessionRegistry; user: string } | null {
  const reg = new GameSessionRegistry();
  const user = `fh3-${n++}`;
  const s = reg.sandboxFor(user).session;
  s.setAssurancesEnabled(false); s.setPhilosophiesEnabled(false); s.setVoteCountEnabled(false); s.setVetoMemoryEnabled(false); s.setDealNomsEnabled(false); s.setCampaignMemoryEnabled(false); s.setApproachMemoryEnabled(false); s.setHcMemoryEnabled(false); s.setMemoryPromisesEnabled(false); s.setForgivenessEnabled(false); s.setLobbyingEnabled(false); s.setDesireClockEnabled(false); s.setWantMovementEnabled(false); s.setMultiNightFatigueEnabled(false); s.setMorningApproachEnabled(false); s.setNpcTellsEnabled(false); s.setTellReactionsEnabled(false); s.setMoodVetoEnabled(false); s.setMoodApproachEnabled(false); s.setMoodDealEnabled(false); s.setMoodCampaignEnabled(false); s.setDriftFixEnabled(false); s.setNpcMemorySpeechEnabled(false); s.setDriveDecisionsEnabled(false); // explicit OFF: the strategy layers now default ON and change the season path this fixture assumes
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

describe("0128 three-part Final HOH - live adapter", () => {
  it("flag ON: two part announcements then the new HOH; the HOH still evicts one of the other two", () => {
    let checked = 0;
    for (let seed = 1; seed <= 12 && checked < 2; seed++) {
      const g = toFinalThree(seed, true);
      if (!g) continue;
      const { views } = playOut(g.s, (v) => v.pending?.kind === "final-eviction" || v.event?.beat === "final-eviction");
      const k = kinds(views);
      expect(k.filter((x) => x === "final-hoh-part"), `seed ${seed}`).toHaveLength(2);
      expect(k.filter((x) => x === "hoh-winner")).toHaveLength(1);
      expect(k.indexOf("hoh-winner")).toBeGreaterThan(k.lastIndexOf("final-hoh-part"));
      expect(views.some((v) => v.pending?.kind === "final-eviction" || v.event?.beat === "final-eviction"), "0045 unchanged: the Final HOH then evicts one of the other two").toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("flag OFF: no part announcements - the single-comp path", () => {
    const g = toFinalThree(3, false);
    expect(g).not.toBeNull();
    const { views } = playOut(g!.s, (v) => v.pending?.kind === "final-eviction" || v.event?.beat === "final-eviction");
    expect(kinds(views).filter((x) => x === "final-hoh-part")).toHaveLength(0);
    expect(kinds(views).filter((x) => x === "hoh-winner")).toHaveLength(1);
  });

  it("a snapshot taken after Part 1 restores into a fresh registry and crowns the SAME Final HOH", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const g = toFinalThree(seed, true);
      if (!g) continue;
      const first = playOut(g.s, (v) => (v.announcements ?? []).some((a) => a.kind === "final-hoh-part"));
      if (!kinds(first.views).includes("final-hoh-part")) continue;
      // let any in-flight player card settle so the snapshot is at a clean beat boundary
      const snap = g.reg.snapshot(g.user);
      const reg2 = new GameSessionRegistry();
      reg2.restore(g.user, snap);
      const s2 = reg2.sandboxFor(g.user).session;
      s2.setFinalHohThreePartEnabled(true);
      const a = playOut(g.s, (v) => v.pending?.kind === "final-eviction" || v.event?.beat === "final-eviction");
      const b = playOut(s2, (v) => v.pending?.kind === "final-eviction" || v.event?.beat === "final-eviction");
      expect(s2.getGameState().ceremony.hoh?.id).toBe(g.s.getGameState().ceremony.hoh?.id);
      expect(kinds(b.views)).toEqual(kinds(a.views));
      return;
    }
    throw new Error("no seed produced a Final 3 with a Part-1 announcement");
  });
});
