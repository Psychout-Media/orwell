import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";
import { WALKABLE_ROOMS, type Room } from "../../src/domain/house";

/**
 * ORW-1174 (prod 11-28 06:17-06:46Z, as codes): a houseguest won the HOH and "requested the player's presence", but the engine held no such request, so the player's yes had nothing to accept. The HOH win now opens an engine
 * talk ask from the new HOH (in the HOH room); the player's yes goes through askToTalkAlone, which moves both. A houseguest standing in the player's room who invited the player along (`invited`) needs no consent roll.
 */
type Live = { playedGame?: boolean; talkAsk?: { npc: string; until: number; room?: string }; ceremony?: unknown; premiereEntrance: { stage: string } };
const liveOf = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
const step = (s: GameSessionAdapter) => { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); };
let n = 0;

function played(seed: number): GameSessionAdapter {
  const s = new GameSessionRegistry().sandboxFor(`orw1174-${n++}`).session as GameSessionAdapter;
  s.setPremiereEntrancesEnabled(true);
  s.setBedRushEnabled(false);
  s.createCharacter({ playerName: "P", seed });
  liveOf(s).playedGame = true;
  s.noteMessage({ messageId: "m1" });
  for (let i = 0; i < 80 && liveOf(s).premiereEntrance.stage !== "done"; i++) step(s);
  for (let i = 0; i < 60 && s.whereabouts()?.houseEvent; i++) step(s);
  return s;
}

/** A played game where a houseguest has just won the HOH: the beat goes through the engine's own commit funnel, as a crown does. */
function npcCrowned(seed: number): { s: GameSessionAdapter; hoh: string } {
  const s = played(seed);
  const hoh = (s as unknown as { livingIds(): string[] }).livingIds().find((i) => i !== "player")!;
  (s as unknown as { commit(ev: unknown): void }).commit({ beat: "hoh-competition", content: "A houseguest wins Head of Household", participants: [hoh] });
  (s as unknown as { ceremony: { hoh?: string } }).ceremony.hoh = hoh; // the crown the beat reports (the ceremony's own field; the real crown sets it before the beat commits)
  return { s, hoh };
}

describe("ORW-1174: the new HOH's request for the player is an engine fact", () => {
  it("a houseguest's HOH win opens a talk ask from them, in the HOH room, and the state says so", () => {
    const { s, hoh } = npcCrowned(3);
    expect(liveOf(s).talkAsk).toMatchObject({ npc: hoh, room: "hoh-room" });
    const ask = (s.getGameState() as { openTalkAsk?: { from: { id: string }; room?: string } | null }).openTalkAsk;
    expect(ask?.from.id).toBe(hoh);
    expect(ask?.room).toBe("hoh-room");
  });

  it("the player winning the HOH opens no ask", () => {
    const s = played(3);
    (s as unknown as { commit(ev: unknown): void }).commit({ beat: "hoh-competition", content: "The player wins Head of Household", participants: ["player"] });
    expect(liveOf(s).talkAsk).toBeUndefined();
  });

  it("the player's yes accepts the ask with no consent roll: both are in the HOH room, and the ask is spent", () => {
    const { s, hoh } = npcCrowned(3);
    (s as unknown as { talkAloneConsent: () => boolean }).talkAloneConsent = () => false; // their own ask is their consent
    const occ = s.occupancy() as unknown as Map<string, Room>;
    for (const [id, r] of [...occ]) if (r === "hoh-room" && id !== hoh) occ.set(id, "kitchen"); // the house's visit to the new HOH room has ended; the room is theirs
    const r = s.askToTalkAlone({ npcId: hoh as never });
    expect(r?.outcome).toBe("accepted");
    expect(r?.room).toBe("hoh-room");
    expect(s.whereabouts()!.room).toBe("hoh-room");
    expect(s.occupancy()!.get(hoh as never)).toBe("hoh-room");
    expect(liveOf(s).talkAsk).toBeUndefined();
  });
});

describe("ORW-1174: an invitation made in the player's own room is the houseguest's consent", () => {
  function together(): { s: GameSessionAdapter; val: string; here: Room; dest: Room } {
    for (let seed = 1; seed < 40; seed++) {
      const s = played(seed);
      const w = s.whereabouts();
      if (!w || w.houseEvent || (w.present?.length ?? 0) < 1) continue;
      const here = w.room as Room;
      const dest = (WALKABLE_ROOMS as readonly Room[]).filter((r) => r !== here && r !== "hoh-room" && !r.startsWith("bedroom")).at(-1)!;
      return { s, val: w.present![0]!.id, here, dest };
    }
    throw new Error("no seed put the player in company");
  }
  it("`invited` moves a houseguest who is here to the named room with no consent roll", () => {
    const { s, val, dest } = together();
    (s as unknown as { talkAloneConsent: () => boolean }).talkAloneConsent = () => false;
    expect(s.askToTalkAlone({ npcId: val as never, room: dest, private: false })?.outcome).toBe("declined"); // an ordinary ask still rolls
    const r = s.askToTalkAlone({ npcId: val as never, room: dest, private: false, invited: true });
    expect(r?.outcome).toBe("accepted");
    expect(s.occupancy()!.get(val as never)).toBe(dest);
  });
  it("`invited` is no consent for a houseguest who is NOT in the player's room", () => {
    const { s, val, here, dest } = together();
    (s as unknown as { talkAloneConsent: () => boolean }).talkAloneConsent = () => false;
    const away = (WALKABLE_ROOMS as readonly Room[]).find((r) => r !== here && r !== dest && r !== "hoh-room" && !r.startsWith("bedroom"))!;
    (s.occupancy()! as unknown as Map<string, Room>).set(val, away);
    expect(s.askToTalkAlone({ npcId: val as never, room: dest, private: false, invited: true })?.outcome).toBe("declined");
  });
});
