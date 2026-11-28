import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";
import { roomDisplayName, type Room } from "../../src/domain/house";

/**
 * ORW-1138 (prod 11-28, as codes): a request to pick a bed in a bedroom moved the player alone out of the group and wrote no bed owner, because the bed-rush pre-move ran even when the act-first round had
 * switched the engine's bed parse off. And a move never said who the player was with: they came along (a group walk) or stayed, and the narrator was left to guess. Roles only.
 */
type Live = { playedGame?: boolean; beds?: { owner: Record<string, string> }; premiereEntrance?: { stage: string } };
const liveOf = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
const step = (s: GameSessionAdapter) => { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); };
let n = 0;

function rushOn(seed: number): GameSessionAdapter {
  const s = new GameSessionRegistry().sandboxFor(`orw1138-${n++}`).session as GameSessionAdapter;
  s.setPremiereEntrancesEnabled(true);
  s.setBedRushEnabled(true);
  s.createCharacter({ playerName: "P", seed });
  s.noteMessage({ messageId: "m1" });
  for (let i = 0; i < 60 && liveOf(s).premiereEntrance!.stage !== "done"; i++) step(s);
  return s;
}

/** A free-roaming game where the player stands in a room with at least two houseguests, and a room to go to. */
function withCompany(): { s: GameSessionAdapter; here: string; peers: string[]; dest: Room } {
  for (let seed = 1; seed < 40; seed++) {
    const s = new GameSessionRegistry().sandboxFor(`orw1138c-${n++}`).session as GameSessionAdapter;
    s.setPremiereEntrancesEnabled(true);
    s.setBedRushEnabled(false);
    s.createCharacter({ playerName: "P", seed });
    liveOf(s).playedGame = true;
    s.noteMessage({ messageId: "m1" });
    for (let i = 0; i < 80 && liveOf(s).premiereEntrance!.stage !== "done"; i++) step(s);
    for (let i = 0; i < 60 && s.whereabouts()?.houseEvent; i++) step(s);
    const w = s.whereabouts();
    if (w && !w.houseEvent && (w.present?.length ?? 0) >= 2) {
      const dest = (["kitchen", "backyard", "dining-room"] as Room[]).find((r) => r !== w.room)!;
      return { s, here: w.room, peers: w.present!.map((p) => p.name), dest };
    }
  }
  throw new Error("no seed put the player in company");
}

describe("ORW-1138: a bed request the act-first round owns never walks the player alone into the bedroom", () => {
  it("with the bed parse switched off, naming a bedroom moves nobody and writes no half-state", () => {
    const s = rushOn(7);
    const before = s.whereabouts()!.room;
    const bedroom: Room = before === "bedroom-c" ? "bedroom-b" : "bedroom-c";
    const r = s.resolvePlayerMove({ text: `I was trying to pick a bed in ${roomDisplayName(bedroom)}.`, skip: ["move", "bed"] });
    expect(r.playerMove).toBeNull();
    expect(s.whereabouts()!.room).toBe(before);
    expect(liveOf(s).beds?.owner["player"]).toBeUndefined();
  });
  it("positive control: the same words with the parse on claim a bed and move the player there together", () => {
    const s = rushOn(7);
    const bedroom: Room = s.whereabouts()!.room === "bedroom-c" ? "bedroom-b" : "bedroom-c";
    const r = s.resolvePlayerMove({ text: `I was trying to pick a bed in ${roomDisplayName(bedroom)}.` });
    expect(liveOf(s).beds?.owner["player"], "a bed owner is written").toBeDefined();
    expect(r.playerMove).toMatchObject({ to: bedroom });
  });
});

describe("ORW-1138: the people the player is with come along or are named as having stayed", () => {
  it("a plain move names everyone who stayed behind, and they are still in the room", () => {
    const { s, here, peers, dest } = withCompany();
    const r = s.resolvePlayerMove({ text: `I head to the ${roomDisplayName(dest)}.` });
    const pm = r.playerMove as { to?: string; stayed?: string[]; came?: string[] };
    expect(pm?.to).toBe(dest);
    expect(new Set(pm.stayed)).toEqual(new Set(peers));
    expect(pm.came).toBeUndefined();
    expect(s.whereabouts()!.room).toBe(dest);
    const stillThere = (s.whereabouts()!.nearby ?? []).concat([]).flatMap((nb) => (nb.room === here ? (nb.present ?? []).map((p) => p.name) : []));
    for (const nm of stillThere) expect(peers).toContain(nm);
  });
  it("a group walk (we) takes them along: they are in the new room with him and the move names them", () => {
    const { s, peers, dest } = withCompany();
    const r = s.resolvePlayerMove({ text: `Let's all go to the ${roomDisplayName(dest)}.` });
    const pm = r.playerMove as { to?: string; stayed?: string[]; came?: string[] };
    expect(pm?.to).toBe(dest);
    expect(new Set(pm.came)).toEqual(new Set(peers));
    expect(pm.stayed).toBeUndefined();
    const present = (s.whereabouts()!.present ?? []).map((p) => p.name);
    for (const nm of peers) expect(present).toContain(nm);
  });
});
