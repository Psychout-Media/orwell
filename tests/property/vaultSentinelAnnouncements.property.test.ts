import { describe, it, expect } from "vitest";
import { assertVaultWallAnnouncements, leaksBeatSeq } from "../support/vaultSentinelAnnouncementsHarness";

describe("leaksBeatSeq (the check itself)", () => {
  it("a public remaining-count that coincides with the counter is not a leak; a spilled counter is", () => {
    expect(leaksBeatSeq("A, B and C are out of the competition; 7 remain.", 7)).toBe(false);
    expect(leaksBeatSeq("A wins Part 2 of the final Head of Household competition.", 2)).toBe(false);
    expect(leaksBeatSeq("A wins the HOH (beat 7).", 7)).toBe(true);
    expect(leaksBeatSeq("A wins the HOH #7", 7)).toBe(true);
    expect(leaksBeatSeq("A, B are out of the competition; 7 remain. seq 7", 7)).toBe(true);
    expect(leaksBeatSeq("A wins the HOH.", 7)).toBe(false);
    expect(leaksBeatSeq("A wins 17 rounds", 7)).toBe(false); // 17 is not 7
  });
});

describe("Vault Wall — property over seeds & BeatAnnouncement announcements (1/5, 1 run)", () => {
  it("no Vault sentinel or hidden content ever reaches any BeatAnnouncement chyron", () => {
    assertVaultWallAnnouncements(1);
  }, 900_000);
});
