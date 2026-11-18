import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { buildDealPlanRetro, type PromiseRecordLine } from "../../src/engine/dealPlans";
import { openLedgerCommitmentKind } from "../../src/engine/openLedger";
import { uncoveredPlayerAssurances } from "../../src/engine/promiseTerms";
import type { RetrospectiveView } from "../../src/ports/GameSession";

/**
 * ORW-602 (Fable T3-7) - the player's ONE promise record in the post-crown retrospective. Each promise once (a ledger line mirroring a deal is dropped; a deal only the houseguest promised in is not the player's),
 * the promise words by meaning (a typed term counts whatever its kind; "pledge", "oath", "agreement", "commitment" count), the engine's own kept/broken marked as engine-judged, and the player's casual assurances listed.
 * Roles only.
 */
const nameOf = (id: string): string => id.toUpperCase();
const line = (o: Partial<PromiseRecordLine>): PromiseRecordLine => ({ speaker: "player", addressedTo: ["h"], kind: "promise", text: "words", status: "open", ...o });

describe("ORW-602 (A) - the pure record", () => {
  it("lists a deal once: the ledger line that mirrors it is dropped, and a deal only the houseguest promised in is not the player's", () => {
    const deals = [
      { id: "deal:1", parties: ["h", "player"], kind: "safety" as const, terms: "t1", status: "kept", madeWeek: 1, condition: { promisors: ["player"] } },
      { id: "deal:2", parties: ["h", "player"], kind: "vote" as const, terms: "t2", status: "broken", madeWeek: 2, condition: { promisors: ["h"] } },
    ];
    const ledger = [line({ kind: "deal", dealId: "deal:1", status: "kept" }), line({ kind: "deal", dealId: "deal:2", status: "broken" })];
    const r = buildDealPlanRetro(undefined, deals, ledger, "player", nameOf)!;
    expect(r.yourPromises.map((p) => [p.source, p.kind, p.status, p.judgedBy])).toEqual([["deal", "safety", "kept", "engine"]]);
  });
  it("counts a typed term whatever its kind, marks its verdict engine-judged, and keeps who it concerned", () => {
    const typed = line({ kind: "statement", status: "broken", term: { by: "player", to: "h", what: "no-nominate", subject: "x", week: 3 }, day: 12 });
    const r = buildDealPlanRetro(undefined, [], [typed], "player", nameOf)!;
    expect(r.yourPromises).toEqual([{ to: [{ id: "h", name: "H" }], source: "said", kind: "statement", text: "words", status: "broken", judgedBy: "engine", week: 3, day: 12, what: "no-nominate", about: { id: "x", name: "X" } }]);
  });
  it("an open-text term and a free-text promise are the narrator's reading, and the commitment words are matched by whole word", () => {
    const rows = ["pledge", "oath", "agreement", "commitment", "chat", "warning about X"].map((kind) => line({ kind, status: "kept" }));
    const r = buildDealPlanRetro(undefined, [], [...rows, line({ kind: "promise", term: { by: "player", to: "h", what: "share-info" } })], "player", nameOf, [], openLedgerCommitmentKind)!;
    expect(r.yourPromises.map((p) => p.kind)).toEqual(["pledge", "oath", "agreement", "commitment", "promise"]);
    expect(r.yourPromises.every((p) => p.judgedBy === "narrator")).toBe(true);
  });
  it("a houseguest's own promise and a promise about a third person's business are not the player's; withdrawn, lapsed and open settle as they are", () => {
    const ledger = [
      line({ speaker: "h", addressedTo: ["player"] }),
      line({ about: "x", text: "claim" }),
      line({ status: "withdrawn", term: { by: "player", to: "h", what: "no-evict-vote" } }),
      line({ status: "lapsed", text: "b", term: { by: "player", to: "h", what: "use-veto-on" } }),
      line({ status: "open", text: "c", term: { by: "player", to: "h", what: "final-two" } }),
    ];
    const r = buildDealPlanRetro(undefined, [], ledger, "player", nameOf)!;
    expect(r.yourPromises.map((p) => p.status)).toEqual(["withdrawn", "lapsed", "open"]);
  });
  it("lists the player's casual assurances, but not the one a typed promise already wrote (one resolver, one record)", () => {
    const asr = [
      { from: "player", to: "h", kind: "loyal", week: 2, source: "player", status: "broken" },
      { from: "player", to: "h", kind: "safe", week: 2, source: "player", status: "kept" },
      { from: "h", to: "player", kind: "safe", week: 2, source: "npc", status: "kept" },
    ];
    const ledger = [{ term: { by: "player", to: "h", what: "no-nominate" as const, week: 2 } }];
    const rows = uncoveredPlayerAssurances(asr, ledger, "player");
    expect(rows.map((a) => a.kind)).toEqual(["safe"]);
    const r = buildDealPlanRetro(undefined, [], [], "player", nameOf, rows.map((a) => ({ to: a.to as never, kind: a.kind, week: a.week, status: a.status })))!;
    expect(r.yourPromises).toEqual([{ to: [{ id: "h", name: "H" }], source: "assured", kind: "safe", text: "", status: "kept", week: 2, judgedBy: "engine" }]);
  });
});

describe("ORW-602 (A2) - secretPlans is untouched by the promise-record edit", () => {
  it("secretPlans is byte-identical to what the pre-edit function produced for the same fixture (a ledger: plan key never shows as a deal's plan)", () => {
    const deals = [
      { id: "deal:1", parties: ["h", "g"], kind: "safety" as const, terms: "t1", status: "open", madeWeek: 1, condition: { promisors: ["h", "g"] } },
      { id: "deal:2", parties: ["h", "player"], kind: "vote" as const, terms: "t2", status: "kept", madeWeek: 2, condition: { promisors: ["player"] } },
    ];
    const plan = { kind: "keep" as const, madeWeek: 1 } as never;
    const flip = { kind: "flip" as const, madeWeek: 2, outcome: "carried-out" as const } as never;
    const store = { "deal:1": { h: plan, g: flip }, "deal:2": { h: plan } } as never;
    const withLedgerKey = { ...(store as object), "ledger:entry-1": { h: flip } } as never;
    const expected = [
      { holder: { id: "h", name: "H" }, with: { id: "g", name: "G" }, dealKind: "safety", madeWeek: 1, plan: "keep", outcome: "pending" },
      { holder: { id: "g", name: "G" }, with: { id: "h", name: "H" }, dealKind: "safety", madeWeek: 2, plan: "flip", outcome: "carried-out" },
      { holder: { id: "h", name: "H" }, with: { id: "player", name: "PLAYER" }, dealKind: "vote", madeWeek: 1, plan: "keep", outcome: "pending" },
    ];
    expect(buildDealPlanRetro(store, deals, [], "player", nameOf)!.secretPlans).toEqual(expected);
    expect(buildDealPlanRetro(withLedgerKey, deals, [], "player", nameOf)!.secretPlans).toEqual(expected);
  });
});

describe("ORW-602 (B) - through the MCP boundary, post-crown only", () => {
  it("nothing before the crown; after it the player's promises and assurances ride dealPlans.yourPromises with no id leak or number", async () => {
    const sb = new GameSessionRegistry().sandboxFor(`prr-${Math.random()}`);
    const s = sb.session as unknown as {
      createCharacter(r: unknown): unknown; advanceGame(): unknown; live: { playedGame?: boolean; finished?: boolean };
      setAdvanceGateEnabled(on: boolean): void; setAssurancesEnabled(on: boolean): void; setPromiseTermsEnabled(on: boolean): void;
      noteMessage(m: unknown): void; movePlayer(room: string): { present: Array<{ id: string }> } | undefined;
      recordPromiseTerm(r: unknown): { accepted: boolean; reason?: string };
    };
    s.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    s.advanceGame(); s.advanceGame();
    s.live.playedGame = true;
    s.setAdvanceGateEnabled(false); s.setAssurancesEnabled(true); s.setPromiseTermsEnabled(true);
    s.noteMessage({ messageId: "m1" });
    const present = s.movePlayer("living-room")!.present.map((p) => p.id).filter((i) => i !== PLAYER);
    const to = present[0]!;
    expect(s.recordPromiseTerm({ by: PLAYER, to, what: "no-nominate" }).accepted).toBe(true);

    expect(await sb.mcp.player.callTool("seasonRetrospective", {})).toBeNull(); // the crown gate: no finished season, nothing
    s.live.finished = true;
    const retro = (await sb.mcp.player.callTool("seasonRetrospective", {})) as RetrospectiveView;
    const mine = retro.dealPlans!.yourPromises;
    expect(mine.length).toBe(1); // the typed promise and the assurance it wrote are ONE record
    expect(mine[0]).toMatchObject({ source: "said", status: "open", judgedBy: "engine", what: "no-nominate" });
    expect(mine[0]!.to.map((r) => r.id)).toEqual([to]);
    expect(JSON.stringify(mine)).not.toMatch(/trust|threat|affinity|sincerity/i);
  });
});
