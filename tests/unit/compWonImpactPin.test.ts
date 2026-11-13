import { describe, it, expect } from "vitest";
import { CEREMONY_IMPACTS } from "../../src/engine/relationshipConstants";

/**
 * A18 - value pin. A competition win moves ONLY the danger read, by exactly +0.45 (retuned 0.3 -> 0.45 on 2026-11-12, ORW-19, to bring a solid player's
 * reach to Final 2 back inside the PO band; earlier 0.2 -> 0.3 was #1996). A silent retune used to be caught only by the NIGHTLY PO gate (not a required check); this makes it a required-check failure.
 * If you retune on purpose, re-run `npm run test:calib:po` and update BOTH this number and the comment on COMP_WON_IMPACT.
 */
describe("comp-won ceremony impact is pinned", () => {
  it("is exactly threat +0.45 and nothing else (no affinity / trust souring from a clean win)", () => {
    expect(CEREMONY_IMPACTS["comp-won"]).toEqual({ threat: 0.45 });
  });
});
