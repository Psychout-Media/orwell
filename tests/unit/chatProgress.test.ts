import { describe, it, expect } from "vitest";
import { CHAT_SIDE_LIVE_KEYS, loopFingerprint } from "../../src/composition/chatProgress";

/** ORW-323: chat-side bookkeeping must not read as the live loop moving (that earned an un-debounced off-screen tick on ~35 of ~36 chat commits a game day). */
const base = { phase: "hoh-comp", week: 2, pending: null, nightDepth: 6, timeOfDay: "afternoon", desireApproachedAt: { "npc:3": 40 }, interruption: undefined as unknown };

describe("ORW-323 - loopFingerprint", () => {
  it("in message mode the clock and the A8 desire-clock bookkeeping do not change the fingerprint", () => {
    const after = { ...base, nightDepth: 7, timeOfDay: "evening", desireApproachedAt: { "npc:3": 40, "npc:9": 41 }, interruption: { npc: "npc:9", desire: "talk", atHour: 41 } };
    expect(loopFingerprint(after, true)).toBe(loopFingerprint(base, true));
  });

  it("a real loop change still moves it (a new pending, a phase, a competition)", () => {
    expect(loopFingerprint({ ...base, pending: { kind: "comp-round" } }, true)).not.toBe(loopFingerprint(base, true));
    expect(loopFingerprint({ ...base, phase: "nominations" }, true)).not.toBe(loopFingerprint(base, true));
    expect(loopFingerprint({ ...base, competition: { round: 2 } }, true)).not.toBe(loopFingerprint(base, true));
  });

  it("outside message mode nothing is stripped (the seeded calibration spine compares the whole live state, byte-identical to before)", () => {
    expect(loopFingerprint({ ...base, nightDepth: 7 }, false)).not.toBe(loopFingerprint(base, false));
    expect(loopFingerprint({ ...base, interruption: { npc: "npc:9" } }, false)).not.toBe(loopFingerprint(base, false));
    expect(loopFingerprint(base, false)).toBe(JSON.stringify(base));
    expect(loopFingerprint(undefined, true)).toBe("null");
  });

  it("the stripped keys are exactly the four chat-side ones (a new key is a deliberate edit, with its own reason)", () => {
    expect([...CHAT_SIDE_LIVE_KEYS]).toEqual(["nightDepth", "timeOfDay", "interruption", "desireApproachedAt"]);
  });
});
