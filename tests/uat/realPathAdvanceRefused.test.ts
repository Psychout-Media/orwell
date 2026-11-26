import { describe, it, expect } from "vitest";
import { playSeason, StallWatch, STALL_REFUSED_ADVANCES, STALL_SAME_STAGE_MESSAGES } from "../support/whatFired/player";

/**
 * ORW-777: a season that never ends. The scripted talking player's season on one seed (the player in an alliance, two of its members turning on it through sealed ballots) used to be refused at every advance from about message 1100 on: the second
 * anonymous "someone turned on the alliance" line (an NPC's Vault-held copy) was a verbatim twin of the one the player could see, the integrity checkpoint's text sweep took the twin for a leak, and every later turn was refused forever.
 * REAL PATH: the season is played through the player channel (nothing hand-set); the engine must never refuse an advance, and the season must carry on past where it used to stop. HEAVY LANE (tests/uat/**, the `real-path` leg).
 */
describe("ORW-777 REAL PATH: no advance is refused for a text twin of a witnessed line", () => {
  it("the season on the seed that used to stick plays past the old stop with no refused advance", async () => {
    const r = await playSeason({ user: "wf-4", seed: 4, maxMessages: 1800 }) // ORW-995: 1400 messages when the cast was the old hometown deal; the census-frequency hometowns change the cast on this seed, so the same season needs more messages to pass week 7 (week 7 at 1400, week 9 at 1800; no refused advance, not stalled);
    expect(r.crashes.filter((c) => c.tool === "advanceGame"), "no advance was refused").toEqual([]);
    expect(r.faults.filter((f) => f.kind === "vault-leak"), "no leak fault").toEqual([]);
    expect(r.stopped).not.toBe("stalled");
    expect(r.week, "the game moved on past the old stop (week 7)").toBeGreaterThan(7);
  }, 900_000);

  it("a member's sealed-ballot turn on an alliance and a later public turn against the same target are not twins either (the other seed that used to stick)", async () => {
    const r = await playSeason({ user: "wf-8", seed: 8, maxMessages: 1400 });
    expect(r.crashes.filter((c) => c.tool === "advanceGame"), "no advance was refused").toEqual([]);
    expect(r.faults.filter((f) => f.kind === "vault-leak"), "no leak fault").toEqual([]);
    expect(r.week, "the game moved on past the old stop (week 4)").toBeGreaterThan(4);
  }, 900_000);
});

describe("ORW-777: the stall watchdog names the stuck stage", () => {
  const at = { week: 7, phase: "hoh-competition", day: 31, pending: null };
  it("fires on repeated refused advances even while the event count would keep moving, and names the stage", () => {
    const w = new StallWatch(); let said: string | null = null;
    for (let m = 0; m < STALL_REFUSED_ADVANCES + 2 && !said; m++) said = w.note(m, at, "refused");
    expect(said).toContain("week 7, phase hoh-competition, day 31");
    expect(said).toContain("refused");
  });
  it("fires when the stage never changes, and a change of day resets it", () => {
    const w = new StallWatch();
    expect(w.note(0, at, "ok")).toBeNull();
    expect(w.note(STALL_SAME_STAGE_MESSAGES, at, "ok")).toBeNull();
    expect(w.note(STALL_SAME_STAGE_MESSAGES + 1, at, "ok")).toContain("no change of stage");
    expect(w.note(STALL_SAME_STAGE_MESSAGES + 2, { ...at, day: 32 }, "ok")).toBeNull();
  });
  it("a refusal is forgiven by the next advance that goes through", () => {
    const w = new StallWatch();
    for (let m = 0; m < STALL_REFUSED_ADVANCES - 1; m++) expect(w.note(m, at, "refused")).toBeNull();
    expect(w.note(STALL_REFUSED_ADVANCES, at, "ok")).toBeNull();
    expect(w.note(STALL_REFUSED_ADVANCES + 1, at, "refused")).toBeNull();
  });
});
