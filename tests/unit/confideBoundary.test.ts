import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER_TOOLS } from "../../src/surfaces/tools/registry";
import { buildSandbox } from "../support/sandbox";
import { PLAYER } from "../../src/domain/ids";
import { RelationshipModel } from "../../src/engine/relationships";
import { CONFIDENCE } from "../../src/engine/confidenceConstants";
import type { GameHouse, HiddenElement } from "../../src/engine/characterFactory";
import type { ConfideResult } from "../../src/ports/GameSession";

/**
 * Feature 0075 — trust-gated confidences. The BOUNDARY + VAULT-WALL gate (the CLAUDE.md-mandated
 * write-back boundary test, dispatching the tool through `McpServer.callTool`, PLUS the load-bearing
 * Vault test from spec §Testability). Roles only — no names from any corpus. The engine decides every
 * disclosure; the model only voices what it is HANDED — so an UNdisclosed secret can never appear.
 *
 * A test plays the "Vault auditor": it reaches the SEALED state (`house.npcs[*].character.hiddenElements`)
 * ONLY to prove that text never crosses a player-facing projection before `confide` records it.
 */

// Mirror the composition root's confidence pathway (registry.ts `setOnConfide`) so a disclosure actually
// records as the player's knowledge — the boundary test constructs the server by hand, not via the root.
function wireConfide(session: GameSessionAdapter, sb: ReturnType<typeof buildSandbox>): void {
  session.setOnConfide((npcId, content, confidence) => {
    const factId = `confide:${npcId}:${sb.engine.events.count()}`;
    sb.engine.knowledge.seedBelief(
      npcId,
      { content, originalContent: content, factId, confidence: 0.9, hops: 0, distortion: 0, source: npcId },
      "origin",
    );
    const fact = sb.engine.knowledge.surfaceInformationTo(
      PLAYER, { content, subject: npcId, confidence }, `told-by:${npcId}`,
    );
    return fact !== null;
  });
}

function startedServer(seed: number): {
  server: McpServer; session: GameSessionAdapter; sb: ReturnType<typeof buildSandbox>;
} {
  const sb = buildSandbox(seed);
  const session = new GameSessionAdapter();
  const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
  const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
  wireConfide(session, sb);
  session.createCharacter({ playerName: "The Player", seed });
  return { server, session, sb };
}

/** Reach the SEALED house (test-only Vault auditing) — the first NPC and their headline secret. */
function firstNpcSecret(session: GameSessionAdapter): { id: string; secret: HiddenElement } {
  const house = (session as unknown as { house: GameHouse }).house;
  const npc = house.npcs.find((n) => (n.character.hiddenElements ?? []).length > 0)!;
  return { id: npc.id, secret: npc.character.hiddenElements![0]! };
}

/** Drive a strong MUTUAL bond + banked goodwill so a `full` confidence is unlocked (engine-internal). */
function earnFullConfidence(session: GameSessionAdapter, npcId: string): void {
  // AMEND 0075 item 4: confide() is engine-refused outside a scene - put the ally in the player's room.
  const presence = (session as unknown as { presence?: Map<string, string> }).presence;
  if (presence) { presence.set(PLAYER, "kitchen"); presence.set(npcId, "kitchen"); }
  const rel = (session as unknown as { rel: RelationshipModel }).rel;
  for (const [a, b] of [[npcId, PLAYER], [PLAYER, npcId]] as const) {
    const e = rel.edge(a, b);
    e.trust = 0.95; e.affinity = 0.95; e.threat = 0.05;
  }
  // Goodwill from the 0039 deal ledger (open pacts) — warmth alone never clears the gate by design.
  for (let i = 0; i < 3; i++) session.makeDeal({ with: npcId, kind: "final-two", terms: "ride or die" });
}

/** Set a houseguest up as a manipulator the player reads as a high threat with no warmth — the strategic
 *  (lie) pull, not genuine closeness. Seeded so the lie roll actually fires (verified by the seed scan). */
function setupLiar(session: GameSessionAdapter, npcId: string): void {
  const presence = (session as unknown as { presence?: Map<string, string> }).presence; // AMEND 0075 item 4: in a scene with the player
  if (presence) { presence.set(PLAYER, "kitchen"); presence.set(npcId, "kitchen"); }
  const house = (session as unknown as { house: GameHouse }).house;
  house.npcs.find((n) => n.id === npcId)!.character.archetype = "mastermind";
  const rel = (session as unknown as { rel: RelationshipModel }).rel;
  for (const [a, b] of [[npcId, PLAYER], [PLAYER, npcId]] as const) {
    const e = rel.edge(a, b);
    e.trust = 0; e.affinity = 0; e.threat = 0.95;
  }
}

describe("0075 confide — the MCP boundary is OPEN (the four-place wiring is live)", () => {
  it("confide is on the player channel", () => {
    expect(PLAYER_TOOLS.map((t) => t.name)).toContain("confide");
  });

  it("dispatches confide — it is not rejected as 'not available'", async () => {
    const { server, session } = startedServer(11);
    const { id } = firstNpcSecret(session);
    const res = (await server.callTool("confide", { npcId: id })) as ConfideResult;
    // Baseline bond ⇒ no reason to open up yet — but it DISPATCHED (a valid result, not a boundary refusal).
    expect(res).toMatchObject({ disclosed: false, tier: "none", truthful: true });
  });

  it("refuses a missing npcId with a typed field name (the arg-guard)", async () => {
    const { server } = startedServer(12);
    await expect(server.callTool("confide", {})).rejects.toThrow(/npcId/);
  });
});

describe("0075 confide — the Vault Wall holds structurally (the load-bearing test)", () => {
  it("an UNdisclosed secret never appears on npcVoice (no premise, before any confide)", () => {
    const { session } = startedServer(13);
    const { id, secret } = firstNpcSecret(session);
    const voice = JSON.stringify(session.npcVoice(id));
    expect(voice).not.toContain(secret.detail); // the sealed premise never crosses
    expect(voice).not.toMatch(/0\.\d/); // never a relationship number
  });

  it("the FULL secret crosses ONLY after confide records it as the player's knowledge", () => {
    const { session, sb } = startedServer(14);
    const { id, secret } = firstNpcSecret(session);
    earnFullConfidence(session, id);

    // BEFORE: the player does not know the secret, and npcVoice still never leaks it.
    expect(sb.engine.knowledge.knownTo(PLAYER).some((f) => f.content.includes(secret.detail))).toBe(false);
    expect(JSON.stringify(session.npcVoice(id))).not.toContain(secret.detail);

    const res = session.confide(id)!;
    expect(res.disclosed).toBe(true);
    expect(res.tier).toBe("full");
    expect(res.truthful).toBe(true);
    expect(res.content).toBe(secret.detail); // only the full tier crosses the whole thing — it was earned

    // AFTER: it is now the player's KNOWLEDGE (Journal-visible), recorded via the in-game pathway.
    expect(sb.engine.knowledge.knownTo(PLAYER).some((f) => f.content.includes(secret.detail))).toBe(true);
  });

  it("mayConfide is a Vault-safe HINT (reason + warmth word only — never the secret, never a number)", () => {
    const { session } = startedServer(15);
    const { id, secret } = firstNpcSecret(session);
    // No bond yet ⇒ no hint (the common case).
    expect(session.npcVoice(id)!.mayConfide).toBeUndefined();

    earnFullConfidence(session, id);
    const hint = session.npcVoice(id)!.mayConfide!;
    expect(hint.ready).toBe(true);
    expect(hint.warmth).toBe("high");
    expect(typeof hint.reason).toBe("string");
    expect(hint.reason).not.toContain(secret.detail); // the reason never carries the premise
    expect(JSON.stringify(hint)).not.toMatch(/0\.\d/); // never a number
  });

  it("is deterministic and MONOTONIC — same setup ⇒ same tier; a true secret never re-tells lower", () => {
    const a = startedServer(16); const b = startedServer(16);
    const sa = firstNpcSecret(a.session); const sb2 = firstNpcSecret(b.session);
    earnFullConfidence(a.session, sa.id); earnFullConfidence(b.session, sb2.id);
    const ra = a.session.confide(sa.id)!; const rb = b.session.confide(sb2.id)!;
    expect(ra).toEqual(rb); // seeded ⇒ identical decision
    // Re-confiding returns the SAME (already-told) tier, never a thinner one (non-degradation).
    const again = a.session.confide(sa.id)!;
    expect(again.tier).toBe(ra.tier);
    expect(again.content).toBe(ra.content);
  });
});

describe("0075 confide — the PASSIVE LIE-CATCH (spec open-Q #4)", () => {
  it("a schemer plants a lie: a fabricated admission, no real secret of anyone, recorded untrue", () => {
    const { session, sb } = startedServer(1);
    const { id, secret } = firstNpcSecret(session);
    setupLiar(session, id);

    const lie = session.confide(id)!;
    expect(lie.disclosed).toBe(true);
    expect(lie.truthful).toBe(false); // the engine's hidden record: this is a lie
    expect(lie.content).not.toBe(secret.detail); // a lie is NOT a leak — never a real secret
    // the player believes the claim (it is recorded as their knowledge) with NO truth/lie marker on it.
    const known = sb.engine.knowledge.knownTo(PLAYER).find((f) => f.content === lie.content)!;
    expect(known).toBeDefined();
    expect(JSON.stringify(known)).not.toMatch(/truthful|"lie"/);
    // the hidden layer knows it is false.
    expect((session as unknown as { confideState: Record<string, { truthful: boolean }> }).confideState[id]!.truthful).toBe(false);
  });

  it("a later true pathway catches the lie: the belief flips to the truth + a betrayal-grade blow", () => {
    const { session, sb } = startedServer(1);
    const { id, secret } = firstNpcSecret(session);
    const rel = (session as unknown as { rel: RelationshipModel }).rel;

    // 1) the schemer plants a lie — the player believes a fabrication, not the real secret.
    setupLiar(session, id);
    const lie = session.confide(id)!;
    expect(lie.truthful).toBe(false);
    expect(sb.engine.knowledge.knownTo(PLAYER).some((f) => f.content.includes(secret.detail))).toBe(false);

    // 2) the bond is genuinely earned and a TRUE pathway later delivers the real thing.
    earnFullConfidence(session, id);
    const before = { ...rel.edge(PLAYER, id) };
    const truth = session.confide(id)!;
    expect(truth.truthful).toBe(true);
    expect(truth.content).toBe(secret.detail);

    // the belief flips: the real secret is now the player's recorded knowledge.
    expect(sb.engine.knowledge.knownTo(PLAYER).some((f) => f.content.includes(secret.detail))).toBe(true);
    // a betrayal-grade blow lands on the player's read of the liar (trust down hard, threat up).
    const after = rel.edge(PLAYER, id);
    expect(after.trust).toBeLessThan(before.trust - 0.15);
    expect(after.threat).toBeGreaterThan(before.threat);
  });

  it("lies are capped per season (a house of liars is noise, not drama)", () => {
    const { session } = startedServer(1);
    // The old design cap is the premise here: ORWELL_NO_HARD_CAPS (default ON since 2026-11-05) replaces it with an escalating cost, so pin it OFF explicitly.
    (session as unknown as { setNoHardCapsEnabled(on: boolean): void }).setNoHardCapsEnabled(false);
    const house = (session as unknown as { house: GameHouse }).house;
    for (const npc of house.npcs) {
      if (!(npc.character.hiddenElements ?? []).length) continue;
      setupLiar(session, npc.id);
      session.confide(npc.id);
    }
    const lieCount = (session as unknown as { lieCount: number }).lieCount;
    expect(lieCount).toBeLessThanOrEqual(CONFIDENCE.maxLiesPerSeason);
  });
});
