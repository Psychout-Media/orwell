import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { HOUSE_ROOMS, isPrivateRoom, type Room } from "../../src/domain/house";
import { talkAloneRoom, decideTalkAlone } from "../../src/engine/talkAlone";
import { DEAL_CONSENT } from "../../src/engine/dealConsentConstants";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { AskToTalkAloneResult } from "../../src/ports/GameSession";

/**
 * ORW-727b. The player asks a houseguest for a private word, or to come over. UNIT checks: the pure room picker, and an old save (hand-made: the hold field removed) still loading.
 * ORW-812: everything a played game can reach is in tests/uat/realPathTalkAlone.test.ts. Roles only.
 */
type Seam = {
  livingIds(): EntityId[]; noteMessage(a: object): unknown; createCharacter(a: object): unknown;
  askToTalkAlone(r: { npcId: EntityId; room?: string; private?: boolean; idempotencyKey?: string }): AskToTalkAloneResult | null;
  presenceTick(rng?: unknown): void;
  presence: Map<EntityId, string>;
  rel: { edge(a: EntityId, b: EntityId): { affinity: number; trust: number; threat: number } };
  live: { week: number; playedGame?: boolean; dayNumber?: number; nightDepth?: number; talkHold?: { npc: string; room: string; until: number; private: boolean }; talkAsk?: { npc: string; until: number } };
  snapshot(): unknown; restore(s: unknown): void;
  recordHouseguestMove(id: EntityId, room: string): { status: string };
  desireApproach(ids: EntityId[]): unknown;
};
let n = 0;
function stage(seed: number, liking: "high" | "low" = "high") {
  const sb = new GameSessionRegistry().sandboxFor(`orw727b-${n++}`);
  const s = sb.session as unknown as Seam;
  s.createCharacter({ playerName: "The Player", seed });
  s.noteMessage({ messageId: "m1" });
  Object.assign(s.live, { champagneCircle: "done", pending: undefined, ceremony: undefined, dayNumber: 2, nightDepth: 12 }); // past the premiere, a free afternoon
  (s as unknown as { phase: string }).phase = "social";
  const ids = s.livingIds().filter((i) => i !== PLAYER);
  const npc = ids[0]!;
  for (const id of [...s.presence.keys()]) s.presence.set(id, "backyard"); // everyone in the public yard with the player
  s.presence.set(PLAYER, "backyard");
  for (const id of ids) { const e = s.rel.edge(id, PLAYER); if (liking === "high") { e.trust = 0.9; e.affinity = 0.9; e.threat = 0.1; } else { e.trust = 0.02; e.affinity = 0.02; e.threat = 0.95; } }
  return { sb, s, npc, others: ids.slice(1) };
}
const onlyTwoIn = (s: Seam, room: string, npc: EntityId) => [...s.presence].filter(([, r]) => r === room).map(([id]) => id).sort().join() === [PLAYER, npc].sort().join();

describe("ORW-727b: the room picker (unit, pure)", () => {
  it("every room the lever can pick is private, empty, and never the diary room or the landing, from any starting room", () => {
    for (const from of HOUSE_ROOMS) {
      const r = talkAloneRoom({ from, named: null, hohInvolved: false, occupiedByOthers: () => false });
      expect(r).not.toBeNull();
      expect(isPrivateRoom(r!)).toBe(true);
      expect(["diary-room", "landing", "hoh-room"]).not.toContain(r);
      expect(r!.startsWith("bedroom")).toBe(false);
    }
    expect(talkAloneRoom({ from: "landing", named: "hoh-room", hohInvolved: true, occupiedByOthers: () => false })).toBe("hoh-room");
    expect(talkAloneRoom({ from: "kitchen", named: null, hohInvolved: false, occupiedByOthers: (r) => r === "storage-room" })).toBe("bathroom"); // the next private room
    expect(talkAloneRoom({ from: "kitchen", named: null, hohInvolved: false, occupiedByOthers: () => true })).toBeNull();
  });

});

describe("ORW-727b: saves (unit: the house is staged by hand and the old save is hand-made)", () => {
  it("a save with a hold restores it; an old save without one loads", () => {
    const { s, npc } = stage(11);
    s.askToTalkAlone({ npcId: npc });
    const snap = JSON.parse(JSON.stringify(s.snapshot()));
    expect(snap.live.talkHold.npc).toBe(npc);
    const a = new GameSessionRegistry().sandboxFor("orw727b-restore-a").session as unknown as Seam; a.restore(snap);
    expect(a.live.talkHold?.npc).toBe(npc);
    const old = JSON.parse(JSON.stringify(snap)); delete old.live.talkHold; delete old.live.talkAsk;
    const b = new GameSessionRegistry().sandboxFor("orw727b-restore-b").session as unknown as Seam; b.restore(old);
    expect(b.live.talkHold).toBeUndefined();
  });
});

/**
 * ORW-853 found that in played seasons every "no" came from a SLEEPING houseguest (askToTalkAlone declines a sleeper whatever the bond), so the played test's
 * "yes comes from a stronger bond than no" compared bonds against sleep. The bond's part is proven here, on the pure rule an awake houseguest answers by.
 */
describe("ORW-727b: an awake houseguest's answer is their read of the player (unit, pure)", () => {
  const read = (trust: number, affinity: number, threat: number) => ({ trust, affinity, threat, grudge: 0, favor: 0, targetsMe: 0 });
  const J = DEAL_CONSENT.jitter;
  it("a warmer read never turns a yes into a no, at the same jitter", () => {
    const steps = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
    for (const threat of [0, 0.3, 0.6, 0.9]) for (const jitter of [-J, 0, J]) {
      let saidYes = false;
      for (const b of steps) {
        const yes = decideTalkAlone(read(b, b, threat), jitter);
        expect(!saidYes || yes, `threat ${threat}, jitter ${jitter}: warmer at ${b} turned a yes into a no`).toBe(true);
        saidYes ||= yes;
      }
    }
  });
  it("more threat never turns a no into a yes, at the same bond and jitter", () => {
    for (const b of [0.2, 0.5, 0.8]) for (const jitter of [-J, 0, J]) {
      let saidNo = false;
      for (const threat of [0, 0.25, 0.5, 0.75, 1]) {
        const yes = decideTalkAlone(read(b, b, threat), jitter);
        expect(!saidNo || !yes, `bond ${b}, jitter ${jitter}: more threat at ${threat} turned a no into a yes`).toBe(true);
        saidNo ||= !yes;
      }
    }
  });
  it("a warm read says yes even at the worst jitter; a cold, fearful one says no even at the best", () => {
    expect(decideTalkAlone(read(0.9, 0.9, 0.1), -J)).toBe(true);
    expect(decideTalkAlone(read(0.02, 0.02, 0.95), J)).toBe(false);
  });
});
