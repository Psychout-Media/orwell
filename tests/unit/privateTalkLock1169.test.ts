import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";
import { roomDisplayName, WALKABLE_ROOMS, type Room } from "../../src/domain/house";

/**
 * ORW-1169 (prod 11-28 05:31-05:46Z, as codes): the player took one houseguest aside and talked; an invite to come along moved the player alone, the belt moved the partner mid-talk, and other houseguests walked into the talk.
 * A one-to-one talk is a lock: both are busy until it ends; an invite moves the partner along (they may decline, and the move says so); the lock shows in the whereabouts. Roles only.
 */
type Live = { playedGame?: boolean; talkHold?: { npc: string; room: string; private: boolean } };
const liveOf = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
const step = (s: GameSessionAdapter) => { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); };
let n = 0;

/** A played game where the player stands in `here` alone with ONE houseguest `val`, every other houseguest elsewhere, and `dest` is a different room. */
function oneToOne(): { s: GameSessionAdapter; here: Room; val: string; valName: string; others: string[]; dest: Room } {
  for (let seed = 1; seed < 40; seed++) {
    const s = new GameSessionRegistry().sandboxFor(`orw1169-${n++}`).session as GameSessionAdapter;
    s.setPremiereEntrancesEnabled(true);
    s.setBedRushEnabled(false);
    s.createCharacter({ playerName: "P", seed });
    liveOf(s).playedGame = true;
    s.noteMessage({ messageId: "m1" });
    for (let i = 0; i < 80 && (s as unknown as { live: { premiereEntrance: { stage: string } } }).live.premiereEntrance.stage !== "done"; i++) step(s);
    for (let i = 0; i < 60 && s.whereabouts()?.houseEvent; i++) step(s);
    const w = s.whereabouts();
    if (!w || w.houseEvent || (w.present?.length ?? 0) < 1) continue;
    const occ = s.occupancy()!;
    const here = w.room as Room;
    const val = w.present![0]!.id;
    const away = (WALKABLE_ROOMS as readonly Room[]).filter((r) => r !== here && r !== "hoh-room" && !r.startsWith("bedroom"));
    const others: string[] = [];
    for (const id of [...occ.keys()]) {
      if (id === "player" || id === val) continue;
      if (occ.get(id) === here) occ.set(id, away[others.length % away.length]!);
      others.push(id);
    }
    return { s, here, val, valName: w.present![0]!.name, others, dest: away[away.length - 1]! };
  }
  throw new Error("no seed put the player in company");
}

describe("ORW-1169: a one-to-one talk is a lock", () => {
  it("a recorded scene with one partner alone in the room locks them and the whereabouts say so", () => {
    const { s, val } = oneToOne();
    s.noteConversationPartners([val as never]);
    expect(liveOf(s).talkHold).toMatchObject({ npc: val, private: true });
    expect(s.whereabouts()!.privateTalk?.with.id).toBe(val);
  });
  it("the belt cannot walk the partner out mid-talk, and no other houseguest can be walked in", () => {
    const { s, val, others, here, dest } = oneToOne();
    s.noteConversationPartners([val as never]);
    expect(s.recordHouseguestMove(val as never, dest).status).toBe("illegal");
    expect(s.recordHouseguestMove(others[0] as never, here).status).toBe("illegal");
    expect(s.occupancy()!.get(val as never)).toBe(here);
  });
  it("the movement tick keeps the partner in the room and everyone else out of it", () => {
    const { s, val, here } = oneToOne();
    s.noteConversationPartners([val as never]);
    for (let i = 0; i < 25; i++) s.presenceTick();
    const occ = s.occupancy()!;
    expect(occ.get(val as never)).toBe(here);
    expect([...occ].filter(([id, r]) => r === here && id !== "player" && id !== val)).toEqual([]);
  });
  it("two houseguests in the room is no private talk: nothing is locked", () => {
    const { s, val, others, here } = oneToOne();
    s.occupancy()!.set(others[0] as never, here);
    s.noteConversationPartners([val as never]);
    expect(liveOf(s).talkHold).toBeUndefined();
    expect(s.whereabouts()!.privateTalk).toBeUndefined();
  });
});

describe("ORW-1169: a named invite takes the invited along, who may decline", () => {
  it("'want to come?' with a destination moves the partner with the player, and the talk goes with them", () => {
    const { s, val, valName, dest, here } = oneToOne();
    s.noteConversationPartners([val as never]);
    (s as unknown as { talkAloneConsent: () => boolean }).talkAloneConsent = () => true;
    const r = s.resolvePlayerMove({ text: `I go to the ${roomDisplayName(dest)}, want to come?` });
    const pm = r.playerMove as { to?: string; came?: string[]; declined?: string[] };
    expect(pm?.to).toBe(dest);
    expect(pm.came).toEqual([valName]);
    expect(s.occupancy()!.get(val as never)).toBe(dest);
    expect(s.whereabouts()!.privateTalk?.with.id).toBe(val);
    expect(s.recordHouseguestMove(val as never, here).status).toBe("illegal"); // our conversation is not done: the belt cannot take her back
  });
  it("a partner who declines stays, and the move says who declined", () => {
    const { s, val, valName, dest, here } = oneToOne();
    s.noteConversationPartners([val as never]);
    (s as unknown as { talkAloneConsent: () => boolean }).talkAloneConsent = () => false;
    const r = s.resolvePlayerMove({ text: `I go to the ${roomDisplayName(dest)}, want to come?` });
    const pm = r.playerMove as { to?: string; came?: string[]; declined?: string[] };
    expect(pm?.to).toBe(dest);
    expect(pm.declined).toEqual([valName]);
    expect(pm.came).toBeUndefined();
    expect(s.occupancy()!.get(val as never)).toBe(here);
    expect(s.whereabouts()!.privateTalk).toBeUndefined();
  });
  it("a plain move with no invite leaves the partner behind and the lock ends", () => {
    const { s, val, valName, dest } = oneToOne();
    s.noteConversationPartners([val as never]);
    const r = s.resolvePlayerMove({ text: `I head to the ${roomDisplayName(dest)}.` });
    const pm = r.playerMove as { stayed?: string[]; came?: string[] };
    expect(pm.stayed).toEqual([valName]);
    expect(s.whereabouts()!.privateTalk).toBeUndefined();
  });
});
