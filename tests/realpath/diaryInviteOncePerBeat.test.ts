import { describe, it, expect } from "vitest";
import { playedGame } from "../support/playedGame";

/**
 * ORW-914 (Fable's week-1 playtest: the Diary Room summoned the player at turns 104, 108, 111, 112, 114, 115, 118, 161, 162, 177: about ten times a week, some straight after a visit). The producer's invitation was
 * part of EVERY moment prompt for as long as a dramatic beat (the nominations week, the veto ceremony, the eviction) lasted, which is many turns: the narrator was told to invite on each. REAL PATH: a season is played
 * through the player's levers to the first prompt that carries the invitation; the player then speaks several more turns inside the same beat (nothing advances it) and the prompt of each is read: the
 * invitation is not offered again; it is offered again at the next dramatic beat. Roles only. HEAVY LANE (tests/realpath).
 */
describe("the Diary Room invitation is offered once per dramatic beat", () => {
  it("not again on the turns that follow inside the same beat; again at the next dramatic beat", () => {
    const g = playedGame({ seed: 3, user: "wf-3" });
    const invited = (): boolean => !!g.s.getGameState().diaryRoomInvite;
    g.playUntil(() => invited(), 6000, "a dramatic beat with the invitation");
    expect(invited(), "the rest of that turn still reads it").toBe(true);
    const beat = g.s.getGameState().moment;
    let again = 0, inside = 0;
    for (let i = 0; i < 6; i++) {
      g.s.noteMessage({ messageId: `inside-${i}` });
      if (g.s.getGameState().moment !== beat) break; // the beat moved on: not this claim
      inside++;
      if (invited()) again++;
    }
    expect(inside, "turns were spoken inside the same beat").toBeGreaterThan(0);
    expect(again, "the invitation is not offered again inside the same beat").toBe(0);
    let nextBeat = false;
    for (let i = 0; i < 6000 && !nextBeat; i++) { g.turn(); nextBeat = invited(); }
    expect(nextBeat, "a later dramatic beat invites again").toBe(true);
  }, 900_000);
});
