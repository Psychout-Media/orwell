import { describe, it, expect, beforeAll } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { RetrospectiveView } from "../../src/ports/GameSession";
import { answerPending } from "../../features/support/answerPending";

/**
 * ORW-747 - the retrospective leftovers: the territory crowd words (0176 part 2), the coming-clean record (0203) and the alliances in the edit (0200), each present after
 * the crown and absent before it. The season is PLAYED through the session's own levers only (a message per turn, advanceGame, the pending answers, hangOut while the
 * schedule holds, turnIn at night) with the real orchestrator committing each turn, so the house lives and the state is reached the real way: nothing hidden is written by hand.
 * HEAVY LANE (tests/uat/realPath*, the `real-path` leg): one full played season, about 1-3 minutes depending on load. The pure builders are tested in tests/unit/retroLeftovers747.test.ts.
 * Roles only.
 */
const SEED = 11;

interface Played { s: GameSessionAdapter; midSeason: { retro: RetrospectiveView | null; surfaces: string }; retro: RetrospectiveView }

function playSeason(seed: number): Played {
  const reg = new GameSessionRegistry();
  const s = reg.sandboxFor("orw747").session;
  s.createCharacter({ playerName: "The Player", seed });
  const orch = new Orchestrator(reg, new FakeClock(), { seed, turnDriven: true, auxTicksNever: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  let msg = 0, playing = false;
  let midSeason: Played["midSeason"] | undefined;
  for (let i = 0; i < 20_000; i++) {
    if (playing) s.noteMessage({ messageId: `turn-${msg++}` }); // a person is playing: one message per turn
    const v = s.advanceGame();
    if (!playing && v.started && v.status?.phase !== "premiere") { s.noteMessage({ messageId: `turn-${msg++}` }); playing = true; }
    if (v.finished) return { s, midSeason: midSeason!, retro: s.seasonRetrospective()! };
    if (!midSeason && (v.status?.week ?? 1) >= 3) {
      const mp = s.getMomentPrompt({});
      midSeason = { retro: s.seasonRetrospective(), surfaces: JSON.stringify([s.getGameState(), mp]) };
    }
    if (v.pending) { const req = answerPending(v.pending); if (req) s.submitDecision(req); continue; }
    if (v.held) {
      if (v.held.reason === "schedule") { const h = s.hangOut(); if (!h.ok) s.turnIn(); } else s.turnIn();
    }
  }
  throw new Error("the played season did not reach the crown");
}

describe("ORW-747 REAL PATH: the retrospective leftovers in a played season", () => {
  let p: Played;
  beforeAll(() => { p = playSeason(SEED); }, 600_000);

  it("before the crown: no retrospective at all, and no live surface carries the new fields", () => {
    expect(p.midSeason).toBeDefined();
    expect(p.midSeason.retro).toBeNull();
    for (const k of ["crowds", "comingClean", "confessedTo", "loopedIn", "territory"]) expect(p.midSeason.surfaces.includes(k), `a live surface carries ${k}`).toBe(false);
  });

  it("after the crown: where the house gathered, as crowd words only (0176)", () => {
    const crowds = p.retro.territory?.crowds ?? [];
    expect(crowds.length).toBeGreaterThan(0);
    for (const c of crowds) { expect(c).toMatch(/^the [a-z-]+ /); expect(c).not.toMatch(/\d/); }
    expect(new Set(crowds).size).toBe(crowds.length);
  });

  it("after the crown: who came clean, every version of the lie and who was told the truth or looped in (0203)", () => {
    const cc = p.retro.comingClean!;
    expect(cc.stories.length).toBeGreaterThan(0);
    for (const st of cc.stories) {
      expect(st.versions.length).toBeGreaterThan(0);
      expect(st.versions.some((v) => v.confessedTo.length + v.loopedIn.length > 0), "each story holds a coming-clean act").toBe(true);
      expect(st.versions.some((v) => !v.true)).toBe(true);
      for (const v of st.versions) expect(v.said.length).toBeGreaterThan(0);
    }
    const json = JSON.stringify(cc);
    expect(json).not.toMatch(/npc:\d|claim:\d|\d\.\d/);
  });

  it("after the crown: the edit carries the alliances that formed and ended in each episode's week (0200)", () => {
    const eps = p.retro.yourEdit!.episodes;
    const beats = eps.flatMap((e) => e.alliances ?? []);
    expect(beats.some((b) => b.what === "formed")).toBe(true);
    for (const b of beats) { expect(b.name.length).toBeGreaterThan(0); expect(b.members.length).toBeGreaterThan(1); }
    expect(JSON.stringify(eps)).not.toMatch(/npc:\d/);
  });

  it("America's Favorite (0190, ORW-624, already built) rides the same post-crown door", () => {
    expect(p.retro.americasFavorite?.name).toBeTruthy();
    expect(p.midSeason.surfaces.includes("americasFavorite")).toBe(false);
  });

  it("reading the retrospective is stable (a pure read)", () => {
    expect(JSON.stringify(p.s.seasonRetrospective())).toBe(JSON.stringify(p.retro));
  });
});
