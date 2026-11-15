import { describe, it } from "vitest";
import { assertVaultWallAnnouncements } from "../support/vaultSentinelAnnouncementsHarness";

describe("Vault Wall — property over seeds & BeatAnnouncement announcements (4/5, 1 run)", () => {
  it("no Vault sentinel or hidden content ever reaches any BeatAnnouncement chyron", () => {
    assertVaultWallAnnouncements(1);
  }, 900_000);
});
