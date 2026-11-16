import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../../features/support/answerPending";
import type { RelationshipModel } from "../../src/engine/relationships";
import type { GameHouse } from "../../src/engine/characterFactory";
import { PLAYER } from "../../src/domain/ids";

/**
 * A53 / ORW-24: an unprompted orientation disclosure (ORW-261) is an ENGINE decision delivered with no lever call, so it must leave the delivery marker (`surfacedToPlayer`: a counter and the teller's public id, never
 * content) that the front end's invented-confession guard (N-17) reads to treat the turn as engine-backed. Without it the guard could swap a true, engine-delivered confession for a deflection. Roles only.
 */
type Board = { interruption?: { npc: string; tells?: string }; daySchedule?: { due: boolean }; pending?: unknown; surfacedToPlayer?: { n: number; sourceId: string } };
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));

function parked(seed: number, user: string): { s: GameSessionAdapter; nBefore: number } | null {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(user).session as GameSessionAdapter;
  s.setOnConfide(() => true);
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
      const nBefore = (s.getGameState() as Board).surfacedToPlayer?.n ?? 0;
      s.noteMessage({ messageId: "first" });
      return { s, nBefore };
    }
  }
  return null;
}

describe("an engine-volunteered orientation leaves the delivery marker (N-17 tie)", () => {
  it("each volunteered disclosure moves the marker (a counter and the teller's public id) and records a closed-set event; no content in it", () => {
    let seen = 0;
    for (const seed of [3, 5, 8, 11, 13, 17, 19, 23]) {
      const p = parked(seed, `a53-${seed}`); if (!p) continue;
      const { s } = p;
      // ORW-507: the counter is cumulative (the drip path may already have raised it), so each telling is judged by the DELTA across the step that produced it: exactly +1.
      const told: Array<{ npc: string; sourceId: string | undefined }> = [];
      const markers: string[] = [];
      let prevN = p.nBefore;
      const check = (b: Board) => {
        const n = b.surfacedToPlayer?.n ?? 0;
        if (b.interruption?.tells && !told.some((t) => t.npc === b.interruption!.npc)) {
          expect(n - prevN, `seed ${seed}: telling #${told.length + 1} moved the marker by exactly one`).toBe(1);
          told.push({ npc: b.interruption.npc, sourceId: b.surfacedToPlayer?.sourceId });
          markers.push(JSON.stringify(b.surfacedToPlayer));
        }
        prevN = n;
      };
      check(s.getGameState() as Board);
      for (let i = 0; i < 120; i++) { s.advanceClockPerConversation(); const b = s.getGameState() as Board; check(b); if (b.daySchedule?.due) break; }
      for (const m of markers) expect(m).not.toContain("lesbian"); // the marker carries no content, at every telling
      if (told.length > 0) {
        const last = told[told.length - 1]!;
        expect(last.sourceId, "the marker carries the teller's id").toBeDefined();
        expect(s.npcVoice(last.sourceId!)!.houseguest.name, "and it is the houseguest who just spoke").toBe(last.npc);
        expect(s.disclosureThisBeat(last.sourceId!)).toMatchObject({ outcome: "slip", via: "orientation" });
        seen += told.length;
      }
    }
    expect(seen, "at least one seed volunteered one (rare, so several seeds are tried)").toBeGreaterThan(0);
  });
});
