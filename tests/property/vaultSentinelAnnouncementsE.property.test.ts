import { describe, it } from "vitest";
import { assertVaultWallAnnouncements } from "../support/vaultSentinelAnnouncementsHarness";

describe("Vault Wall — property over seeds & BeatAnnouncement announcements (5/5, 20 runs)", () => {
  it("no Vault sentinel or hidden content ever reaches any BeatAnnouncement chyron", () => {
    assertVaultWallAnnouncements(20);
  }, 900_000);
});
