import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { buildSandbox } from "../support/sandbox";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { RelationshipModel } from "../../src/engine/relationships";
import { DealLedger } from "../../src/engine/deals";
import { StaleBeatError } from "../../src/domain/errors";
import type { ConfideResult, DealView, ExposeResult, TradeResult } from "../../src/ports/GameSession";

/**
 * A10 / #591 / R1c — the at-most-once `idempotencyKey`, EXTENDED from `recordInteraction` to the sibling
 * FOLD-BEARING PLAYER LEVERS `makeDeal` / `confide` / `exposeSecret` / `tradeSecret`. Each of these RECORDS
 * or creates state AND folds a hidden relationship-layer impact, so it shares `recordInteraction`'s exact
 * double-apply latent: under sustained two-window concurrency two turns can drain the SAME deferred fold
 * and re-drive it, each carrying a valid, freshly-reconciled CAS token — so `expectedBeatSeq` alone cannot
 * stop the SECOND fold. A stable caller-minted `idempotencyKey` does: a repeat key returns the prior result
 * WITHOUT re-folding, checked BEFORE the CAS guard so it is a no-op SUCCESS even against a moved board.
 *
 * This dispatches every verb THROUGH `McpServer.callTool` (the CLAUDE.md-mandated boundary test — a missing
 * dispatch/arg-guard #4 would be DEAD at runtime yet pass the static gates). Roles only — no names.
 */

/** Wire a player-channel server with the seams the composition root wires (by hand here). */
function playerServer(seed: number): { server: McpServer; session: GameSessionAdapter; sb: ReturnType<typeof buildSandbox> } {
  const sb = buildSandbox(seed);
  const session = new GameSessionAdapter();
  // Mirror registry.ts: the confidence pathway (0075), the player-knowledge reader (0093/0099) + the
  // surface-to-houseguest pathway, so a disclosure/expose/trade actually records as knowledge.
  session.setOnConfide((npcId, content, confidence) => {
    const factId = `confide:${npcId}:${sb.engine.events.count()}`;
    sb.engine.knowledge.seedBelief(npcId, { content, originalContent: content, factId, confidence: 0.9, hops: 0, distortion: 0, source: npcId }, "origin");
    return sb.engine.knowledge.surfaceInformationTo(PLAYER, { content, subject: npcId, confidence }, `told-by:${npcId}`) !== null;
  });
  session.setPlayerKnowledgeReader(() =>
    sb.engine.knowledge.knownTo(PLAYER).map((f) => ({ id: f.id, content: f.content, subject: f.subject, factId: f.factId })),
  );
  session.setOnSurfaceToHouseguest((npcId, content, subject, pathway, confidence) => {
    const factId = `secret-power:${npcId}:${sb.engine.events.count()}`;
    sb.engine.knowledge.seedBelief(npcId, { content, originalContent: content, factId, confidence: 0.9, hops: 0, distortion: 0, source: PLAYER }, "origin");
    return sb.engine.knowledge.surfaceInformationTo(npcId, { content, subject, confidence }, pathway) !== null;
  });
  const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
  const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
  return { server, session, sb };
}

/** Test-only rel reader (the hidden layer a fold moves — never a player-facing projection). */
function rel(session: GameSessionAdapter): RelationshipModel {
  return (session as unknown as { rel: RelationshipModel }).rel;
}
function edge(session: GameSessionAdapter, a: EntityId, b: EntityId): { trust: number; affinity: number; threat: number } {
  return { ...rel(session).edge(a, b) };
}
/** Test-only open-deal count (the DealLedger is engine-private, Vault-sealed). */
function openDeals(session: GameSessionAdapter): number {
  return (session as unknown as { deals: DealLedger }).deals.open().length;
}

/**
 * Drive a strong MUTUAL bond + banked goodwill so a confidence discloses (engine-internal). The npc→player
 * edge (the disclosure GATE) is cranked to the ceiling; the player→npc edge — the one the vulnerability
 * bond bump actually MOVES (`foldHiddenImpact(..., toward:[PLAYER])` ⇒ `applyDirected(PLAYER, npc)`) — is
 * left with HEADROOM so a single fold is measurable (a saturated edge would clamp and mask the double-apply).
 */
function earnFullConfidence(session: GameSessionAdapter, npcId: EntityId): void {
  (session as unknown as { presence: Map<string, string> }).presence = new Map([[PLAYER, "kitchen"], [npcId, "kitchen"]]); // S13: confide needs co-presence
  const r = rel(session);
  const gate = r.edge(npcId, PLAYER); gate.trust = 0.95; gate.affinity = 0.95; gate.threat = 0.05;
  const moved = r.edge(PLAYER, npcId); moved.trust = 0.55; moved.affinity = 0.55; moved.threat = 0.2;
  for (let i = 0; i < 3; i++) session.makeDeal({ with: npcId, kind: "final-two", terms: "ride or die" });
}

/** Set a houseguest up as a manipulator (high threat, no warmth) so `confide` fabricates a LIE (mirror
 *  confideBoundary.setupLiar; seed 1 fires the lie roll). */
function setupLiar(session: GameSessionAdapter, npcId: EntityId): void {
  (session as unknown as { presence: Map<string, string> }).presence = new Map([[PLAYER, "kitchen"], [npcId, "kitchen"]]); // S13: confide needs co-presence
  const house = (session as unknown as { house: { npcs: Array<{ id: EntityId; character: { archetype: string } }> } }).house;
  house.npcs.find((n) => n.id === npcId)!.character.archetype = "mastermind";
  const r = rel(session);
  for (const [a, b] of [[npcId, PLAYER], [PLAYER, npcId]] as const) {
    const e = r.edge(a, b); e.trust = 0; e.affinity = 0; e.threat = 0.95;
  }
}
/** Test-only read of the engine-private lie counter (the Vault-sealed lie ledger). */
function lieCount(session: GameSessionAdapter): number {
  return (session as unknown as { lieCount: number }).lieCount;
}

/** Plant a learned secret about a subject into the player's knowledge; return the factId. */
function learnSecretAbout(session: GameSessionAdapter, sb: ReturnType<typeof buildSandbox>, subject: EntityId): string {
  const factId = `learned:${subject}`;
  sb.engine.knowledge.seedBelief(subject, { content: "a learned secret about them", originalContent: "a learned secret about them", factId, confidence: 0.9, hops: 0, distortion: 0, source: subject }, "origin");
  sb.engine.knowledge.surfaceInformationTo(PLAYER, { content: "a learned secret about them", subject, confidence: 0.85 }, `told-by:${subject}`);
  const fact = sb.engine.knowledge.knownTo(PLAYER).find((f) => f.subject === subject)!;
  return fact.factId ?? fact.id;
}

describe("A10/#591 — makeDeal is at-most-once per idempotencyKey", () => {
  it("a REPEAT key returns the prior deal and creates it exactly ONCE (no duplicate, no double-fold)", async () => {
    const { server, session } = playerServer(1);
    session.createCharacter({ playerName: "The Player", seed: 1 });
    const target = session.livingIds().find((id) => id !== PLAYER)!;

    const first = (await server.callTool("makeDeal", { with: target, kind: "safety", terms: "keep me safe", idempotencyKey: "D1" })) as DealView;
    expect(first?.id).toBeTruthy();
    const dealsAfterOne = openDeals(session);

    const second = (await server.callTool("makeDeal", { with: target, kind: "safety", terms: "keep me safe", idempotencyKey: "D1" })) as DealView;
    expect(second.id).toBe(first.id);                 // the SAME deal, not a second one
    expect(openDeals(session)).toBe(dealsAfterOne); // no duplicate deal created
  });

  it("WITHOUT a key the same second call DOES create a second deal — proving the key is what prevents it", async () => {
    const { server, session } = playerServer(2);
    session.createCharacter({ playerName: "The Player", seed: 2 });
    const target = session.livingIds().find((id) => id !== PLAYER)!;
    await server.callTool("makeDeal", { with: target, kind: "safety", terms: "keep me safe" });
    const afterOne = openDeals(session);
    await server.callTool("makeDeal", { with: target, kind: "safety", terms: "keep me safe" });
    expect(openDeals(session)).toBe(afterOne + 1); // the legacy double-apply (a duplicate deal)
  });
});

describe("A10/#591 — confide is at-most-once per idempotencyKey", () => {
  it("a REPEAT key returns the prior disclosure and folds the bond bump exactly ONCE", async () => {
    const { server, session } = playerServer(14);
    session.createCharacter({ playerName: "The Player", seed: 14 });
    const npcId = session.livingIds().find((id) => id !== PLAYER)!;
    earnFullConfidence(session, npcId);
    const before = edge(session, PLAYER, npcId);

    const first = (await server.callTool("confide", { npcId, idempotencyKey: "C1" })) as ConfideResult;
    expect(first.disclosed).toBe(true);
    const afterOne = edge(session, PLAYER, npcId);
    expect(afterOne).not.toEqual(before);             // the vulnerability bond bump folded once

    const second = (await server.callTool("confide", { npcId, idempotencyKey: "C1" })) as ConfideResult;
    expect(second).toEqual(first);                    // the SAME disclosure replayed
    expect(edge(session, PLAYER, npcId)).toEqual(afterOne); // the hidden layer did NOT move a second time
  });

  it("WITHOUT a key the second confide re-folds — proving the key is what prevents it", async () => {
    const { server, session } = playerServer(14);
    session.createCharacter({ playerName: "The Player", seed: 14 });
    const npcId = session.livingIds().find((id) => id !== PLAYER)!;
    earnFullConfidence(session, npcId);
    await server.callTool("confide", { npcId });
    const afterOne = edge(session, PLAYER, npcId);
    await server.callTool("confide", { npcId });      // no key — folds again
    expect(edge(session, PLAYER, npcId)).not.toEqual(afterOne);
  });

  it("the repeat short-circuits BEFORE the CAS guard — a stale re-drive returns cleanly, never a 409", async () => {
    const { server, session } = playerServer(14);
    session.createCharacter({ playerName: "The Player", seed: 14 });
    const npcId = session.livingIds().find((id) => id !== PLAYER)!;
    earnFullConfidence(session, npcId);
    const beat = session.gameStatus().beatSeq ?? 0;
    const first = (await server.callTool("confide", { npcId, expectedBeatSeq: beat, idempotencyKey: "C2" })) as ConfideResult;
    const afterOne = edge(session, PLAYER, npcId);

    // The board has since moved; the FE's re-queued drain re-attaches its ORIGINAL (now stale) token.
    await server.callTool("advanceGame", {});
    let out!: ConfideResult;
    await expect((async () => { out = (await server.callTool("confide", { npcId, expectedBeatSeq: beat, idempotencyKey: "C2" })) as ConfideResult; })()).resolves.not.toThrow();
    expect(out).toEqual(first);
    expect(edge(session, PLAYER, npcId)).toEqual(afterOne); // no second fold despite the stale token
  });

  it("a FIRST call with a fresh key against a stale board still 409s (the CAS guard is intact)", async () => {
    const { server, session } = playerServer(14);
    session.createCharacter({ playerName: "The Player", seed: 14 });
    const npcId = session.livingIds().find((id) => id !== PLAYER)!;
    earnFullConfidence(session, npcId);
    // A brand-new key the ledger has never seen must NOT bypass the CAS guard.
    await expect(server.callTool("confide", { npcId, expectedBeatSeq: 999, idempotencyKey: "neverSeen" })).rejects.toThrow(StaleBeatError);
  });
});

describe("A10/#591 — exposeSecret is at-most-once per idempotencyKey", () => {
  it("a REPEAT key exposes exactly ONCE — the subject's house-wide standing hit folds once", async () => {
    const { server, session, sb } = playerServer(1);
    session.createCharacter({ playerName: "The Player", seed: 1 });
    const subject = session.livingIds().find((id) => id !== PLAYER)!;
    const other = session.livingIds().find((id) => id !== PLAYER && id !== subject)!;
    const factId = learnSecretAbout(session, sb, subject);
    const before = edge(session, other, subject);

    const first = (await server.callTool("exposeSecret", { factId, idempotencyKey: "E1" })) as ExposeResult;
    expect(first.exposed).toBe(true);
    const afterOne = edge(session, other, subject);
    expect(afterOne).not.toEqual(before);             // the standing hit folded once onto a bystander

    const second = (await server.callTool("exposeSecret", { factId, idempotencyKey: "E1" })) as ExposeResult;
    expect(second).toEqual(first);                    // the SAME expose replayed (not "already-spent")
    expect(edge(session, other, subject)).toEqual(afterOne); // no second fold
  });
});

describe("A10/#591 — the shared ledger is NAMESPACED by lever (no cross-lever key collision)", () => {
  it("the SAME idempotencyKey on two DIFFERENT levers ⇒ BOTH mutate (the second is not skipped / not the first's result)", async () => {
    const { server, session } = playerServer(14);
    session.createCharacter({ playerName: "The Player", seed: 14 });
    const npcId = session.livingIds().find((id) => id !== PLAYER)!;
    earnFullConfidence(session, npcId);
    const dealsBefore = openDeals(session);
    const bondBefore = edge(session, PLAYER, npcId);

    // Lever 1: makeDeal with the shared key — creates a deal, caches under `makeDeal:SHARED`.
    const deal = (await server.callTool("makeDeal", { with: npcId, kind: "safety", terms: "keep me safe", idempotencyKey: "SHARED" })) as DealView;
    expect(deal?.id).toBeTruthy();
    expect(openDeals(session)).toBe(dealsBefore + 1);

    // Lever 2: confide with the SAME key — MUST run its own mutation, not return the deal from the collision.
    const confided = (await server.callTool("confide", { npcId, idempotencyKey: "SHARED" })) as ConfideResult;
    expect(confided).toHaveProperty("disclosed"); // a ConfideResult, NOT the DealView that shared the key
    expect((confided as unknown as DealView).id).toBeUndefined();
    expect(confided.disclosed).toBe(true);
    expect(edge(session, PLAYER, npcId)).not.toEqual(bondBefore); // the confide fold actually landed (not skipped)
  });

  it("a same-lever repeat under a key another lever also used still de-dupes (at-most-once preserved)", async () => {
    const { server, session } = playerServer(14);
    session.createCharacter({ playerName: "The Player", seed: 14 });
    const npcId = session.livingIds().find((id) => id !== PLAYER)!;
    earnFullConfidence(session, npcId);

    await server.callTool("makeDeal", { with: npcId, kind: "safety", terms: "keep me safe", idempotencyKey: "K" });
    const first = (await server.callTool("confide", { npcId, idempotencyKey: "K" })) as ConfideResult;
    const afterConfide = edge(session, PLAYER, npcId);
    const second = (await server.callTool("confide", { npcId, idempotencyKey: "K" })) as ConfideResult; // repeat confide+K
    expect(second).toEqual(first);                             // de-duped
    expect(edge(session, PLAYER, npcId)).toEqual(afterConfide); // folded exactly once
  });
});

describe("A10/#591 — tradeSecret is at-most-once per idempotencyKey", () => {
  it("a REPEAT key trades exactly ONCE — the recipient's read of the player folds once", async () => {
    const { server, session, sb } = playerServer(2);
    session.createCharacter({ playerName: "The Player", seed: 2 });
    const subject = session.livingIds().find((id) => id !== PLAYER)!;
    const recipient = session.livingIds().find((id) => id !== PLAYER && id !== subject)!;
    const factId = learnSecretAbout(session, sb, subject);
    const before = edge(session, recipient, PLAYER);

    const first = (await server.callTool("tradeSecret", { factId, toNpcId: recipient, askKind: "vote", idempotencyKey: "T1" })) as TradeResult;
    const afterOne = edge(session, recipient, PLAYER);
    expect(afterOne).not.toEqual(before);             // the trade (accepted or declined) folded once

    const second = (await server.callTool("tradeSecret", { factId, toNpcId: recipient, askKind: "vote", idempotencyKey: "T1" })) as TradeResult;
    expect(second).toEqual(first);                    // the SAME trade replayed
    expect(edge(session, recipient, PLAYER)).toEqual(afterOne); // no second fold
  });
});

describe("A10/#591 — the REAL relationship fold (not just record-creation) is at-most-once", () => {
  it("makeDeal WITH leverage folds the squeeze on the partner exactly ONCE per key", async () => {
    const { server, session, sb } = playerServer(1);
    session.createCharacter({ playerName: "The Player", seed: 1 });
    const partner = session.livingIds().find((id) => id !== PLAYER)!;
    const factId = learnSecretAbout(session, sb, partner); // leverage is about the deal PARTNER
    const before = edge(session, partner, PLAYER);         // the leverage fold moves the partner's read of the player

    const first = (await server.callTool("makeDeal", { with: partner, kind: "safety", terms: "keep me safe", leverage: { factId }, idempotencyKey: "L1" })) as DealView;
    expect(first?.id).toBeTruthy();
    const afterOne = edge(session, partner, PLAYER);
    expect(afterOne).not.toEqual(before);                  // the leverage squeeze actually folded (a REAL fold, not just the deal row)
    const dealsAfterOne = openDeals(session);

    const second = (await server.callTool("makeDeal", { with: partner, kind: "safety", terms: "keep me safe", leverage: { factId }, idempotencyKey: "L1" })) as DealView;
    expect(second.id).toBe(first.id);
    expect(edge(session, partner, PLAYER)).toEqual(afterOne); // the squeeze did NOT fold a second time
    expect(openDeals(session)).toBe(dealsAfterOne);          // and no duplicate deal
  });

  it("a forced-LIE confide increments the lie ledger + folds exactly ONCE per key (the lie path, not just the bond bump)", async () => {
    const { server, session } = playerServer(1);
    session.createCharacter({ playerName: "The Player", seed: 1 });
    const npcId = session.livingIds().find((id) => id !== PLAYER)!;
    setupLiar(session, npcId);
    const liesBefore = lieCount(session);

    const first = (await server.callTool("confide", { npcId, idempotencyKey: "LIE1" })) as ConfideResult;
    expect(first.disclosed).toBe(true);
    expect(first.truthful).toBe(false);                    // the engine planted a LIE (the forced path)
    expect(lieCount(session)).toBe(liesBefore + 1);        // the lie ledger moved once

    const second = (await server.callTool("confide", { npcId, idempotencyKey: "LIE1" })) as ConfideResult;
    expect(second).toEqual(first);                          // replayed
    expect(lieCount(session)).toBe(liesBefore + 1);        // NOT incremented a second time (no double lie-count)
  });
});

describe("A10/#591 — an EMPTY idempotencyKey is rejected (it identifies no operation)", () => {
  it("the MCP arg-guard refuses an empty key with a field error (never a false de-dup token)", async () => {
    const { server, session } = playerServer(1);
    session.createCharacter({ playerName: "The Player", seed: 1 });
    const npcId = session.livingIds().find((id) => id !== PLAYER)!;
    await expect(server.callTool("makeDeal", { with: npcId, kind: "safety", terms: "x", idempotencyKey: "" })).rejects.toThrow(/idempotencyKey/);
    await expect(server.callTool("confide", { npcId, idempotencyKey: "" })).rejects.toThrow(/idempotencyKey/);
  });

  it("at the port, an empty key OPTS OUT (folds every call — never collapses distinct calls into one)", async () => {
    // Belt-and-suspenders below the boundary: a direct port call with "" must fold each time, not de-dup.
    const { session } = playerServer(2);
    session.createCharacter({ playerName: "The Player", seed: 2 });
    const target = session.livingIds().find((id) => id !== PLAYER)!;
    const before = openDeals(session);
    session.makeDeal({ with: target, kind: "safety", terms: "a", idempotencyKey: "" });
    session.makeDeal({ with: target, kind: "safety", terms: "b", idempotencyKey: "" });
    expect(openDeals(session)).toBe(before + 2); // two distinct deals — the empty key never de-duped them
  });
});
