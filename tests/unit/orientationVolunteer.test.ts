import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../../features/support/answerPending";
import type { RelationshipModel } from "../../src/engine/relationships";
import type { GameHouse } from "../../src/engine/characterFactory";
import { PLAYER } from "../../src/domain/ids";

/** ORW-261 slice 2 / spec 0141: an NPC who steps in by the desire clock may, unprompted, volunteer a private orientation. Played games only, rare, once each, recorded as a told-by fact. Roles only. */
type S = GameSessionAdapter;
type Board = { interruption?: { npc: string; desire: string; tells?: string }; daySchedule?: { due: boolean }; pending?: unknown };

function parked(seed: number, user: string, played: boolean): { s: S; told: string[] } | null {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(user).session as S;
  const told: string[] = [];
  s.setOnConfide((_n, content) => { told.push(content); return true; });
  s.createCharacter({ playerName: "P", seed });
  s.setPerConversationClockEnabled(true); s.setHangOutEnabled(true); s.setDesireClockEnabled(true);
  for (let i = 0; i < 600; i++) {
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    const st = s.getGameState() as Board;
    if (st.daySchedule && st.daySchedule.due === false && !st.pending && (s.snapshot() as unknown as { live: { hoh?: string } }).live.hoh !== undefined) {
      const house = (s as unknown as { house: GameHouse }).house;
      const priv: Record<string, string> = {};
      for (const n of house.npcs) priv[n.id] = "lesbian";
      (s as unknown as { privateOrientations: Record<string, string> }).privateOrientations = priv;
      const rel = (s as unknown as { rel: RelationshipModel }).rel;
      for (const n of house.npcs) for (const [a, b] of [[n.id, PLAYER], [PLAYER, n.id]] as const) { const e = rel.edge(a, b); e.trust = 0.95; e.affinity = 0.95; e.threat = 0.05; }
      if (played) s.noteMessage({ messageId: "first" });
      return { s, told };
    }
  }
  return null;
}
const heard = (told: string[]) => told.filter((t) => t.includes("they are lesbian"));
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));

function run(seed: number, played: boolean): { tells: string[]; told: string[]; npcs: string[] } | null {
  const p = parked(seed, `ov-${played}-${seed}`, played); if (!p) return null;
  const tells: string[] = []; const npcs: string[] = [];
  const b0 = p.s.getGameState() as Board; // the announced message itself ticks the clock, so an approach can already be standing
  if (b0.interruption?.tells) { tells.push(b0.interruption.tells); npcs.push(b0.interruption.npc); }
  for (let i = 0; i < 120; i++) {
    p.s.advanceClockPerConversation();
    const b = p.s.getGameState() as Board;
    if (b.interruption?.tells) { tells.push(b.interruption.tells); npcs.push(b.interruption.npc); }
    if (b.daySchedule?.due) break;
  }
  return { tells, told: p.told, npcs };
}

describe("ORW-261 slice 2: unprompted private orientation", () => {
  it("in a played game, on some seeds an approaching houseguest volunteers it: surfaced on the interruption and recorded as ONE told-by fact each, never repeated", () => {
    let seen = 0;
    for (const seed of [3, 5, 8, 11, 13, 17, 19, 23]) {
      const r = run(seed, true); if (!r) continue;
      expect(heard(r.told).length, `seed ${seed} tells=${r.tells.length} told=${r.told.length}`).toBe(r.tells.length);
      expect(new Set(r.npcs).size, "no houseguest tells twice").toBe(r.npcs.length);
      for (const t of r.tells) expect(t).toMatch(/in their own words/);
      seen += r.tells.length;
    }
    expect(seen, "at least one seed produced an unprompted tell").toBeGreaterThan(0);
  });
  it("the same seed reproduces the same unprompted tells", () => {
    for (const seed of [3, 5, 8]) {
      const a = run(seed, true), b = run(seed, true);
      if (a && b) expect(a.npcs).toEqual(b.npcs);
    }
  });
  it("headless (nobody playing) never volunteers, so calibration sims are unchanged", () => {
    for (const seed of [3, 5, 8, 11, 13]) {
      const r = run(seed, false); if (!r) continue;
      expect(r.tells).toEqual([]); expect(heard(r.told)).toEqual([]);
    }
  });
  it("an approach that does not choose to tell carries no mention of orientation", () => {
    for (const seed of [3, 5, 8, 11, 13]) {
      const p = parked(seed, `ovq-${seed}`, true); if (!p) continue;
      for (let i = 0; i < 120; i++) {
        p.s.advanceClockPerConversation();
        const b = p.s.getGameState() as Board;
        if (b.interruption && !b.interruption.tells) expect(JSON.stringify(b.interruption)).not.toMatch(/lesbian|orientation/i);
        if (b.daySchedule?.due) break;
      }
    }
  });
});
