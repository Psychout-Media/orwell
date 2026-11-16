import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { houseMeetingLine } from "../../src/engine/momentPrompts";

/** 0156 slice 7b: the player calls a house meeting in their own words, and the narrator hears it as the speakers' words, one turn, never its truth. Roles only. */
function season() {
  const s = new GameSessionRegistry().sandboxFor(`meetp-${Math.random()}`).session as GameSessionAdapter;
  s.setNpcBeliefsEnabled(true);
  s.createCharacter({ playerName: "The Player", seed: 7 });
  (s as unknown as { live: { playedGame?: boolean } }).live.playedGame = true;
  const names = s.getGameState().house.filter((h) => h.id !== PLAYER).map((h) => h.name.split(/\s+/)[0]!);
  return { s, a: names[0]!, b: names[1]! };
}
const meetingLine = (s: GameSessionAdapter) => s.getMomentPrompt({}).systemPrompt.split("\n").find((l) => l.includes("HOUSE MEETING"));

describe("the player's house-meeting call and the narrator seam (0156 slice 7b)", () => {
  it("a named accusation held in the player's own words reaches the narrator as one HOUSE MEETING line", () => {
    const { s, a, b } = season();
    expect(meetingLine(s)).toBeUndefined();
    s.resolvePlayerMove({ text: `I call a house meeting. ${a} is going after ${b}.` });
    const line = meetingLine(s)!;
    expect(line).toContain(a);
    expect(line).toContain(b);
    expect(line).toMatch(/going after/);
    expect(line).toMatch(/speakers' own words/);
  });

  it("nothing is held for unrelated words, a negation, a bare call, or a claim without a call", () => {
    const { s, a, b } = season();
    for (const text of ["I go to the kitchen.", "I won't call a house meeting.", "I call a house meeting.", `${a} is going after ${b}.`]) {
      s.resolvePlayerMove({ text });
      expect(s.houseMeetingThePlayerHeard(), text).toBeUndefined();
      expect(meetingLine(s), text).toBeUndefined();
    }
  });

  it("is one turn: a retry of the same turn still carries it, the next message does not", () => {
    const { s, a, b } = season();
    s.noteMessage({ messageId: "m1" });
    s.resolvePlayerMove({ text: `I call a house meeting: ${a} is going after ${b}.` });
    expect(meetingLine(s)).toBeDefined();
    expect(meetingLine(s), "a retry of the same turn").toBeDefined();
    s.noteMessage({ messageId: "m2" });
    expect(meetingLine(s), "the next turn").toBeUndefined();
  });

  it("a meeting held while the player sleeps never reaches the narrator, awake or after", () => {
    const { s, a, b } = season();
    const [x, y] = s.livingIds().filter((id) => id !== PLAYER);
    s.resumeNapTicks();
    s.holdHouseMeeting({ caller: y!, accused: x!, claim: { kind: "lying-about", subject: x! } });
    expect(meetingLine(s)).toBeUndefined();
    s.endNapTicks();
    expect(meetingLine(s)).toBeUndefined();
    void a; void b;
  });

  it("Vault sentinels: the rendered line and the heard view carry only the listed keys and no engine-only token", () => {
    const { s, a, b } = season();
    s.resolvePlayerMove({ text: `I call a house meeting. ${a} is going after ${b}.` });
    const heard = s.houseMeetingThePlayerHeard()!;
    expect(Object.keys(heard).sort()).toEqual(["accused", "answer", "caller", "claim"].concat("redirectTo" in heard ? ["redirectTo"] : []).sort());
    expect(Object.keys(heard.claim).sort()).toEqual(["kind", "object", "subject"].filter((k) => k in heard.claim).sort());
    const data = meetingLine(s)!.split("Voice the accusation")[0]!;
    expect(data).not.toMatch(/isTrue|intent|claim:|meeting:|npc:|trust|belie|\btrue\b|\bfalse\b/i);
    expect(JSON.stringify(heard)).not.toMatch(/isTrue|intent|"id"|outcome|belief|trust/i);
  });

  it("renders every claim kind as words with no ids", () => {
    for (const kind of ["targets-you", "voted-to-evict-you", "final-two-with", "going-after", "talking-about", "lying-about"]) {
      for (const answer of ["deny", "admit", "redirect"]) {
        const t = houseMeetingLine({ caller: "Ann", accused: "Bo", claim: { kind, subject: "Bo", object: "Cy" }, answer, ...(answer === "redirect" ? { redirectTo: "Ann" } : {}) });
        expect(t).toMatch(/Ann called the house together/);
        expect(t).not.toMatch(/undefined|claim:|meeting:|npc:/);
      }
    }
  });
});
