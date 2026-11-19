import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { HOUSE_ROOMS, isPrivateRoom, type Room } from "../../src/domain/house";
import { talkAloneRoom } from "../../src/engine/talkAlone";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { AskToTalkAloneResult } from "../../src/ports/GameSession";

/**
 * ORW-727b. The player asks a houseguest for a private word, or to come over. Played games, real path, roles only.
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

describe("ORW-727b: asking for a private word", () => {
  it("an accepting houseguest and the player end up alone in a private room; the scene and a deal there are witnessed by exactly the two; the others saw them leave together", () => {
    const { sb, s, npc, others } = stage(11);
    expect(s.live.playedGame).toBe(true);
    const r = s.askToTalkAlone({ npcId: npc })!;
    expect(r.outcome).toBe("accepted");
    expect(s.presence.get(PLAYER)).toBe(r.room);
    expect(s.presence.get(npc)).toBe(r.room);
    expect(isPrivateRoom(r.room as Room)).toBe(true);
    expect(["diary-room", "landing", "hoh-room"]).not.toContain(r.room);
    expect(onlyTwoIn(s, r.room!, npc)).toBe(true);
    // the others, in the yard, watched the two go
    const left = sb.engine.events.queryAll().filter((e) => /left the .* together for the/.test(String(e.content)));
    expect(left.length).toBe(1);
    expect([...left[0]!.witnessSet].sort()).toEqual([PLAYER, npc, ...others].sort());
    expect(left[0]!.hidden).toBe(false);
    // a scene recorded the way the narrator records it, and a deal, inside
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc, ...others], content: "a quiet word about the week" });
    const scene = sb.engine.events.queryAll().filter((e) => e.content === "a quiet word about the week");
    expect([...scene[0]!.witnessSet].sort()).toEqual([PLAYER, npc].sort());
    sb.session.makeDeal({ with: npc, kind: "safety", terms: "we keep each other safe" });
    const deal = sb.engine.events.queryAll().filter((e) => e.type === "deal" && e.witnessSet.includes(npc));
    expect(deal.length).toBeGreaterThan(0);
    for (const d of deal) expect([...d.witnessSet].sort()).toEqual([PLAYER, npc].sort());
  });

  it("the room the player names is used when it is private and empty; a public room, the diary room and the landing fall back to the nearest private room", () => {
    const named = stage(11); expect(named.s.askToTalkAlone({ npcId: named.npc, room: "lounge" })!.room).toBe("lounge");
    for (const asked of ["kitchen", "backyard", "diary room", "landing", "the landing upstairs"]) {
      const { s, npc } = stage(11);
      const r = s.askToTalkAlone({ npcId: npc, room: asked })!;
      expect(r.outcome).toBe("accepted");
      expect(r.room).toBe("storage-room"); // nearest private room to the backyard by the floor plan
    }
    const hoh = stage(11); expect(hoh.s.askToTalkAlone({ npcId: hoh.npc, room: "hoh room" })!.room).not.toBe("hoh-room"); // neither of the two is the HOH
  });

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

  it("when someone is already in the chosen private room the next one is used; when all are taken nothing moves and the result is typed", () => {
    const a = stage(11); const taker = a.others[0]!; a.s.presence.set(taker, "storage-room");
    const r = a.s.askToTalkAlone({ npcId: a.npc, room: "storage room" })!;
    expect(r.outcome).toBe("accepted"); expect(r.room).not.toBe("storage-room"); expect(onlyTwoIn(a.s, r.room!, a.npc)).toBe(true);
    const b = stage(11); const rooms = ["storage-room", "lounge", "bathroom"]; b.others.slice(0, 3).forEach((id, i) => b.s.presence.set(id, rooms[i]!));
    const before = JSON.stringify([...b.s.presence]);
    expect(b.s.askToTalkAlone({ npcId: b.npc })).toMatchObject({ outcome: "occupied" });
    expect(JSON.stringify([...b.s.presence])).toBe(before);
    expect(b.s.live.talkHold).toBeUndefined();
  });

  it("a houseguest with a low bond declines: nobody moves, no hold, the answer is typed and the same hour gives the same answer (no re-ask loop)", () => {
    const { sb, s, npc } = stage(11, "low");
    const before = JSON.stringify([...s.presence]);
    const r = s.askToTalkAlone({ npcId: npc })!;
    expect(r.outcome).toBe("declined");
    expect(Object.keys(r).sort()).toEqual(["beatSeq", "outcome"]); // no room, no reason, no number
    expect(JSON.stringify([...s.presence])).toBe(before);
    expect(s.live.talkHold).toBeUndefined();
    expect(s.askToTalkAlone({ npcId: npc })!.outcome).toBe("declined");
    expect(sb.engine.events.queryAll().filter((e) => /together for the/.test(String(e.content)))).toEqual([]);
  });

  it("the answer depends on the person and the bond: the same ask is yes for a liked player and no for a distrusted one", () => {
    const yes = new Set<string>(), no = new Set<string>();
    for (let seed = 3; seed < 9; seed++) { yes.add(stage(seed, "high").s.askToTalkAlone({ npcId: stage(seed, "high").npc })?.outcome ?? ""); }
    for (let seed = 3; seed < 9; seed++) { const w = stage(seed, "low"); no.add(w.s.askToTalkAlone({ npcId: w.npc })?.outcome ?? ""); }
    expect([...yes]).toEqual(["accepted"]); expect([...no]).toEqual(["declined"]);
  });

  it("'come here': the houseguest comes to the player's room and the player does not move; the hold is bounded and then lets go", () => {
    const { s, npc, others } = stage(11);
    s.presence.set(PLAYER, "kitchen"); s.presence.set(npc, "backyard");
    const r = s.askToTalkAlone({ npcId: npc, private: false })!;
    expect(r.outcome).toBe("accepted"); expect(r.room).toBe("kitchen");
    expect(s.presence.get(PLAYER)).toBe("kitchen"); expect(s.presence.get(npc)).toBe("kitchen");
    expect(s.live.talkHold).toMatchObject({ npc, room: "kitchen", private: false });
    const rng = new SeededRandom(5);
    for (let i = 0; i < 12; i++) { s.presenceTick(rng); expect(s.presence.get(npc)).toBe("kitchen"); } // held while it lasts
    expect(others.length).toBeGreaterThan(0);
    s.live.nightDepth = (s.live.nightDepth ?? 8) + 3; // the window (a bounded number of in-game hours) lapses
    s.presenceTick(rng);
    expect(s.live.talkHold).toBeUndefined();
    let moved = false; for (let i = 0; i < 80 && !moved; i++) { s.presenceTick(rng); moved = s.presence.get(npc) !== "kitchen"; }
    expect(moved).toBe(true); // released: they are free to wander again
  });

  it("'come find me' to a named room sends the houseguest there while the player stays put", () => {
    const { s, npc } = stage(11);
    const r = s.askToTalkAlone({ npcId: npc, room: "kitchen", private: false })!;
    expect(r.room).toBe("kitchen"); expect(s.presence.get(npc)).toBe("kitchen"); expect(s.presence.get(PLAYER)).toBe("backyard");
  });

  it("in a private room nobody else comes in while the hold lasts, over many movement ticks and seeds; the held houseguest does not leave", () => {
    for (const seed of [3, 11, 5]) {
      const { s, npc } = stage(seed);
      const r = s.askToTalkAlone({ npcId: npc })!;
      const rng = new SeededRandom(seed);
      for (let i = 0; i < 40; i++) {
        s.presenceTick(rng);
        expect(onlyTwoIn(s, r.room!, npc)).toBe(true);
        expect(s.recordHouseguestMove(npc, "kitchen").status).toBe("illegal"); // a narrated move cannot take them out of it
        const other = s.livingIds().find((x) => x !== PLAYER && x !== npc)!;
        expect(s.recordHouseguestMove(other, r.room!).status).toBe("illegal"); // nor put anyone in it
        expect(s.desireApproach(s.livingIds().filter((x) => x !== PLAYER))).toBeNull(); // nobody steps in on a private word
      }
    }
  });

  it("a hold ends when the player leaves the private room", () => {
    const { s, npc } = stage(11);
    s.askToTalkAlone({ npcId: npc });
    s.presence.set(PLAYER, "living-room");
    s.presenceTick(new SeededRandom(2));
    expect(s.live.talkHold).toBeUndefined();
  });

  it("the lever is at-most-once per idempotency key", () => {
    const { s, npc } = stage(11);
    const a = s.askToTalkAlone({ npcId: npc, idempotencyKey: "k1" })!;
    s.presence.set(PLAYER, "kitchen"); s.presence.set(npc, "kitchen");
    const b = s.askToTalkAlone({ npcId: npc, idempotencyKey: "k1" })!;
    expect(b).toEqual(a); expect(s.presence.get(PLAYER)).toBe("kitchen");
  });

  it("an unknown or absent houseguest is null; the player cannot ask themselves", () => {
    const { s } = stage(11);
    expect(s.askToTalkAlone({ npcId: "npc:nobody" as EntityId })).toBeNull();
    expect(s.askToTalkAlone({ npcId: PLAYER })).toBeNull();
  });
});

describe("ORW-727b: a houseguest asks the player for a private word (parity)", () => {
  it("their own ask stands as an open, non-blocking offer; the player's yes through the same lever is accepted even from a houseguest who would have said no; it then clears", () => {
    const { sb, s, npc } = stage(11, "low");
    s.live.talkAsk = { npc, until: (s.live.dayNumber ?? 1) * 24 + 40 };
    const view = sb.session.getGameState() as unknown as { openTalkAsk?: { from: { id: string } } };
    expect(view.openTalkAsk?.from.id).toBe(npc);
    expect(JSON.stringify(view.openTalkAsk)).not.toMatch(/trust|affinity|threat/);
    const r = s.askToTalkAlone({ npcId: npc })!;
    expect(r.outcome).toBe("accepted"); expect(onlyTwoIn(s, r.room!, npc)).toBe(true);
    expect(s.live.talkAsk).toBeUndefined();
    expect((sb.session.getGameState() as unknown as { openTalkAsk?: unknown }).openTalkAsk).toBeUndefined();
  });
  it("a lapsed ask no longer shows or forces a yes", () => {
    const { sb, s, npc } = stage(11, "low");
    s.live.talkAsk = { npc, until: 0 };
    expect((sb.session.getGameState() as unknown as { openTalkAsk?: unknown }).openTalkAsk).toBeUndefined();
    expect(s.askToTalkAlone({ npcId: npc })!.outcome).toBe("declined");
  });
});

describe("ORW-727b: saves", () => {
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
