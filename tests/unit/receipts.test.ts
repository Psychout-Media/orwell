import { describe, it, expect } from "vitest";
import { computePlayerReceipts, type ReceiptsInput, type Receipt } from "../../src/engine/receipts";
import { PLAYER, npc } from "../../src/domain/ids";

/**
 * #1800 — The Booth Has Receipts: pure deterministic contradiction extraction from the player's own record.
 * Boundary tests using plain fixtures (no Vault, no engine handle).
 */

const PLAYER_ID = PLAYER;
const PARTNER_A = npc(1);
const PARTNER_B = npc(2);
const PARTNER_C = npc(3);

function emptyInput(): ReceiptsInput {
  return {
    player: PLAYER_ID,
    deals: [],
    events: [],
    diaryRoomStatements: [],
    publicStatements: [],
  };
}

describe("#1800 — computePlayerReceipts (pure deterministic)", () => {
  it("returns [] for empty input", () => {
    const result = computePlayerReceipts(emptyInput());
    expect(result).toEqual([]);
  });

  it("returns [] for input with no contradictions", () => {
    const input: ReceiptsInput = {
      ...emptyInput(),
      deals: [
        { id: "deal:1", kind: "vote", parties: [PLAYER_ID, PARTNER_A], terms: "vote together", status: "open", madeEventId: "evt:1" },
      ],
      events: [
        { id: "evt:1", kind: "recordInteraction", content: "made a vote deal with PartnerA", initiator: PLAYER_ID },
      ],
    };
    const result = computePlayerReceipts(input);
    expect(result).toEqual([]);
  });

  it("detects divergent-commitment: multiple open final-two deals", () => {
    const input: ReceiptsInput = {
      ...emptyInput(),
      deals: [
        { id: "deal:1", kind: "final-two", parties: [PLAYER_ID, PARTNER_A], terms: "final two with PartnerA", status: "open", madeEventId: "evt:1" },
        { id: "deal:2", kind: "final-two", parties: [PLAYER_ID, PARTNER_B], terms: "final two with PartnerB", status: "open", madeEventId: "evt:2" },
      ],
      events: [
        { id: "evt:1", kind: "recordInteraction", content: "made final two with PartnerA", initiator: PLAYER_ID },
        { id: "evt:2", kind: "recordInteraction", content: "made final two with PartnerB", initiator: PLAYER_ID },
      ],
    };
    const result = computePlayerReceipts(input);
    expect(result.length).toBe(1);
    expect(result[0]!.kind).toBe("divergent-commitment");
    expect(result[0]!.sourceEventIds).toContain("evt:1");
    expect(result[0]!.sourceEventIds).toContain("evt:2");
  });

  it("detects divergent-commitment: one open final-two is not divergent", () => {
    const input: ReceiptsInput = {
      ...emptyInput(),
      deals: [
        { id: "deal:1", kind: "final-two", parties: [PLAYER_ID, PARTNER_A], terms: "final two with PartnerA", status: "open", madeEventId: "evt:1" },
      ],
    };
    const result = computePlayerReceipts(input);
    expect(result.filter((r) => r.kind === "divergent-commitment")).toHaveLength(0);
  });

  it("detects target-vote-mismatch from the player's real ballot", () => {
    const input: ReceiptsInput = {
      ...emptyInput(),
      votes: [{
        voteEventId: "season:9",
        votedFor: { id: PARTNER_B, name: "NomineeB" },
        nominees: [{ id: PARTNER_A, name: "NomineeA" }, { id: PARTNER_B, name: "NomineeB" }],
        statements: [{ id: "evt:5", content: "Honestly I want to target NomineeA this week." }],
      }],
    };
    const result = computePlayerReceipts(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("target-vote-mismatch");
    expect(result[0]!.summary).toContain("NomineeA");
    expect(result[0]!.summary).toContain("NomineeB");
    expect(result[0]!.summary).not.toMatch(/npc:/);
    expect(result[0]!.sourceEventIds).toEqual(["evt:5", "season:9"]);
  });

  it("no target-vote-mismatch when the player voted the way they said, or only mentioned a name", () => {
    const base = {
      voteEventId: "season:9",
      votedFor: { id: PARTNER_A, name: "NomineeA" },
      nominees: [{ id: PARTNER_A, name: "NomineeA" }, { id: PARTNER_B, name: "NomineeB" }],
    };
    expect(computePlayerReceipts({ ...emptyInput(), votes: [{ ...base, statements: [{ id: "e1", content: "Time to target NomineeA." }] }] })).toHaveLength(0);
    expect(computePlayerReceipts({ ...emptyInput(), votes: [{ ...base, statements: [{ id: "e2", content: "NomineeB made breakfast today." }] }] })).toHaveLength(0);
  });

  it("divergent-commitment summary names people, never raw ids", () => {
    const result = computePlayerReceipts({
      ...emptyInput(),
      names: { [PARTNER_A]: "PartnerA", [PARTNER_B]: "PartnerB" },
      deals: [
        { id: "deal:1", kind: "final-two", parties: [PLAYER_ID, PARTNER_A], terms: "f2", status: "open", madeEventId: "evt:1" },
        { id: "deal:2", kind: "final-two", parties: [PLAYER_ID, PARTNER_B], terms: "f2", status: "open", madeEventId: "evt:2" },
      ],
    });
    expect(result[0]!.summary).toContain("PartnerA");
    expect(result[0]!.summary).not.toMatch(/npc:/);
  });

  it("detects dr-public-flip", () => {
    const input: ReceiptsInput = {
      ...emptyInput(),
      diaryRoomStatements: [
        { id: "dr:1", content: "I trust PartnerA completely", ts: 10, subject: PARTNER_A },
      ],
      publicStatements: [
        { id: "pub:1", content: "I don't trust PartnerA at all", ts: 20 },
      ],
    };
    const result = computePlayerReceipts(input);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const flip = result.find((r) => r.kind === "dr-public-flip");
    expect(flip).toBeDefined();
    expect(flip!.sourceEventIds).toContain("dr:1");
    expect(flip!.sourceEventIds).toContain("pub:1");
  });

  it("does not create dr-public-flip when statements agree", () => {
    const input: ReceiptsInput = {
      ...emptyInput(),
      diaryRoomStatements: [
        { id: "dr:1", content: "I trust PartnerA completely", ts: 10, subject: PARTNER_A },
      ],
      publicStatements: [
        { id: "pub:1", content: "I trust PartnerA completely in this game", ts: 20 },
      ],
    };
    const result = computePlayerReceipts(input);
    const flips = result.filter((r) => r.kind === "dr-public-flip");
    expect(flips).toHaveLength(0);
  });

  it("is deterministic: same input yields same output", () => {
    const input: ReceiptsInput = {
      ...emptyInput(),
      deals: [
        { id: "deal:1", kind: "final-two", parties: [PLAYER_ID, PARTNER_A], terms: "final two", status: "open", madeEventId: "evt:1" },
        { id: "deal:2", kind: "final-two", parties: [PLAYER_ID, PARTNER_B], terms: "final two", status: "open", madeEventId: "evt:2" },
      ],
    };
    const r1 = computePlayerReceipts(input);
    const r2 = computePlayerReceipts(input);
    expect(r1).toEqual(r2);
  });

  it("includes sourceEventIds on every receipt", () => {
    const input: ReceiptsInput = {
      ...emptyInput(),
      deals: [
        { id: "deal:1", kind: "final-two", parties: [PLAYER_ID, PARTNER_A], terms: "final two with PartnerA", status: "open", madeEventId: "evt:1" },
        { id: "deal:2", kind: "final-two", parties: [PLAYER_ID, PARTNER_B], terms: "final two with PartnerB", status: "open", madeEventId: "evt:2" },
      ],
    };
    const result = computePlayerReceipts(input);
    for (const r of result) {
      expect(r.sourceEventIds.length).toBeGreaterThan(0);
    }
  });

  it("structural proof: called with plain fixtures, no VaultStore/engineRoot in scope", () => {
    // This test proves the function can be called with plain data objects
    // — NO VaultStore, SoulProvider, RelationshipModel, or engineRoot handle —
    // because the module has zero imports of those types.
    const input: ReceiptsInput = {
      player: "player" as any,
      deals: [{ id: "d:1", kind: "final-two", parties: ["player" as any, "npc:1" as any], terms: "f2", status: "open" }],
      events: [],
      diaryRoomStatements: [],
      publicStatements: [],
    };
    const result = computePlayerReceipts(input);
    expect(Array.isArray(result)).toBe(true);
  });
});
