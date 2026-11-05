import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, npc } from "../../src/domain/ids";

/** AMEND 0139 — the booth-receipts ADAPTER seam, live: a hidden event is never cited, the divergent-
 *  commitment and dr-public-flip classes surface from the real adapter path, and only target ids/names
 *  leave the full ballot record. Roles only. */
const PARTNER_A = npc(2);
const PARTNER_B = npc(3);
const VOTER = npc(4);
function game(user: string) {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed: 7 });
  (sb.session as any).setBoothReceiptsEnabled(true);
  return sb.session as any;
}
const ev = (id: string, content: string, ts: number, hidden: boolean) =>
  ({ id, content, ts, hidden, type: "recordInteraction", initiator: PLAYER, witnessSet: [PLAYER] });
const dr = { id: "dr:1", factId: "dr:1", content: "I trust the partner completely", pathway: "diary-room", ts: 10 };

describe("0139 — playerReceipts through the adapter", () => {
  it("dr-public-flip cites a PUBLIC contradicting statement, never a hidden one", () => {
    const s = game("rc-hidden");
    s.playerKnowledgeReader = () => [dr];
    s.record = { events: () => [ev("pub:h", "I don't trust the partner at all", 20, true)] };
    expect(s.playerReceipts().filter((r: any) => r.kind === "dr-public-flip")).toEqual([]);
    s.record = { events: () => [ev("pub:v", "I don't trust the partner at all", 20, false)] };
    const flips = s.playerReceipts().filter((r: any) => r.kind === "dr-public-flip");
    expect(flips).toHaveLength(1);
    expect(flips[0].sourceEventIds).toEqual(["dr:1", "pub:v"]);
  });
  it("divergent-commitment surfaces from two open final-two deals", () => {
    const s = game("rc-div");
    s.record = { events: () => [ev("evt:1", "final two with A", 1, false), ev("evt:2", "final two with B", 2, false)] };
    s.deals = { forParty: () => [
      { id: "deal:1", kind: "final-two", parties: [PLAYER, PARTNER_A], terms: "final two", status: "open", madeEventId: "evt:1" },
      { id: "deal:2", kind: "final-two", parties: [PLAYER, PARTNER_B], terms: "final two", status: "open", madeEventId: "evt:2" },
    ] };
    const r = s.playerReceipts();
    expect(r.map((x: any) => x.kind)).toEqual(["divergent-commitment"]);
    expect(JSON.stringify(r)).not.toMatch(/npc:\d/);
  });
  it("only target ids leave the full ballot record (a non-target voter never appears)", () => {
    const s = game("rc-ballot");
    const nameA = s.nameOf(PARTNER_A), nameB = s.nameOf(PARTNER_B), voterName = s.nameOf(VOTER);
    s.record = { events: () => [
      ev("evt:5", `I want to target ${nameA} this week`, 5, false),
      { id: "season:9", content: `${nameB} leaves the house`, ts: 9, hidden: false, type: "house-event", initiator: PARTNER_B, witnessSet: [PLAYER] },
    ] };
    s.live.voteRecord = [{ evictee: PARTNER_B, voteOf: { [PLAYER]: PARTNER_B, [VOTER]: PARTNER_A } }];
    const r = s.playerReceipts();
    const mismatch = r.find((x: any) => x.kind === "target-vote-mismatch");
    expect(mismatch, "mismatch receipt expected").toBeDefined();
    const blob = JSON.stringify(r);
    expect(blob).not.toContain(VOTER);
    expect(blob).not.toContain(voterName);
  });
});
