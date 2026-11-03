import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, npc } from "../../src/domain/ids";

/**
 * The "WHAT YOU'VE LEARNED" section — the PLAYER's own surfaced-facts block (a distinct `\n\n` section
 * in the composed prompt). Scoping to it separates the player's-knowledge guarantee from the ADR 0019
 * Layer 2 per-PRESENT-NPC knowledge block (each present houseguest's OWN knows/suspects, under THEIR
 * label), which is a legitimately different section of the same prompt.
 */
const playerLearnedBlock = (systemPrompt: string): string =>
  systemPrompt.split("\n\n").find((s) => s.startsWith("WHAT YOU'VE LEARNED")) ?? "";

/**
 * SOC-1/4 — surfaced-fact DELIVERY to the per-turn narrator.
 *
 * The engine already anchors facts that reach the player through a real in-game pathway (an NPC
 * confiding, a rumor that diffused all the way to them, an overheard fragment) into the player's
 * `KnowledgeService`. Before this fix those facts were COMPUTED but never handed to the narrator on
 * an ordinary turn's moment prompt — so the model had nothing to voice and would fill the gap by
 * hallucinating. These tests prove the delivery seam: a freshly-surfaced, PATHWAY-anchored fact
 * appears in the per-turn narrator payload, while genuinely hidden / no-pathway (Vault) content
 * never does. Roles only, no fixture names.
 */

const liveGame = (seed: number, user: string) => {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "Player", seed });
  return sb;
};

/** Surface a fact to the player through the SAME anchored `told-by` pathway `registry.setOnConfide`
 *  uses: an NPC first holds the belief (origin), then it surfaces to the player as their knowledge. */
const surfaceToPlayer = (
  sb: ReturnType<GameSessionRegistry["sandboxFor"]>,
  teller: string,
  content: string,
): void => {
  sb.engine.knowledge.seedBelief(
    teller,
    { content, originalContent: content, factId: `t:${content}`, confidence: 0.9, hops: 0, distortion: 0, source: teller },
    "origin",
  );
  const fact = sb.engine.knowledge.surfaceInformationTo(PLAYER, { content, subject: teller }, `told-by:${teller}`);
  expect(fact).not.toBeNull(); // the pathway is anchored — this really became the player's knowledge
};

describe("SOC-1/4 — the player's pathway-surfaced facts reach the per-turn narrator prompt", () => {
  it("a fact an NPC confided reaches the player's ordinary (non-lifecycle) moment prompt", () => {
    const sb = liveGame(5, "soc-deliver");
    const teller = npc(2);
    const FACT = "I am secretly gunning for the HOH next week";
    surfaceToPlayer(sb, teller, FACT);

    // An ORDINARY per-turn moment (NOT re-entry / post-season — those already carried THE RECORD).
    const { systemPrompt } = sb.session.getMomentPrompt({ moment: "social" });
    expect(systemPrompt).toContain("WHAT YOU'VE LEARNED");
    expect(systemPrompt).toContain(FACT);
  });

  it("before any surfacing the block is absent — the prompt stays tight (byte-identical addition)", () => {
    const sb = liveGame(6, "soc-empty");
    const { systemPrompt } = sb.session.getMomentPrompt({ moment: "social" });
    expect(systemPrompt).not.toContain("WHAT YOU'VE LEARNED");
  });

  it("a belief an NPC holds with NO pathway to the player never enters the PLAYER's learned block (and pure Vault content never appears at all)", () => {
    const sb = liveGame(7, "soc-vault");
    // A belief npc(3) holds alone — the player was never told and never overheard it, so no pathway
    // ever anchored it to the PLAYER's knowledge. (ADR 0019 Layer 2: npc(3)'s OWN knowledge may ride
    // the prompt under npc(3)'s labelled block when they're in the scene — that is the point; it lets
    // the model voice them truthfully, exactly as `npcVoice` already does. What must NEVER happen is it
    // being framed as the PLAYER's knowledge.)
    const NPC_BELIEF = "SENTINEL-npc-only-scheme";
    sb.engine.knowledge.seedBelief(
      npc(3),
      { content: NPC_BELIEF, originalContent: NPC_BELIEF, factId: "sealed:1", confidence: 0.9, hops: 0, distortion: 0, source: npc(3) },
      "origin",
    );
    // A hidden off-screen EVENT the player never witnessed AND a Vault confessional — the genuine Vault
    // content class, held in NO houseguest's legitimate knowledge layer. Neither may ever reach the prompt.
    const VAULT_ONLY = "SENTINEL-vault-confessional-content";
    sb.engine.events.record({
      id: "soc:hidden", ts: 9_100_000, type: "conversation",
      initiator: npc(3), witnessSet: [npc(3), npc(4)], hidden: true, content: VAULT_ONLY,
    });
    sb.engine.vault.writeHidden({ id: "soc:vault", kind: "confessional", subject: npc(3), content: VAULT_ONLY });

    const { systemPrompt } = sb.session.getMomentPrompt({ moment: "social" });
    // (1) npc(3)'s belief never became the PLAYER's knowledge → it stays out of the player's own block.
    expect(playerLearnedBlock(systemPrompt)).not.toContain(NPC_BELIEF);
    // (2) genuine Vault content (the hidden event / the confessional) never reaches the prompt at all.
    expect(systemPrompt).not.toContain(VAULT_ONLY);
  });

  it("the player's Diary-Room knowledge (no NPC pathway) is NOT rendered as 'the house told you'", () => {
    const sb = liveGame(8, "soc-dr");
    const DR = "PRIVATE-diary-room-target-note";
    // Diary Room is the player's OWN knowledge but with NO in-game pathway to any NPC — it must not
    // appear in the "reached you through a real pathway" block (it would misframe the OOC channel).
    sb.engine.knowledge.recordDiaryRoom(DR);

    const { systemPrompt } = sb.session.getMomentPrompt({ moment: "social" });
    // The surfaced-facts block, if present at all, must not carry the DR note.
    const idx = systemPrompt.indexOf("WHAT YOU'VE LEARNED");
    if (idx >= 0) expect(systemPrompt.slice(idx)).not.toContain(DR);
  });

  it("only the most recent few facts ride along — the block stays bounded", () => {
    const sb = liveGame(9, "soc-bound");
    const teller = npc(1);
    for (let i = 0; i < 9; i++) surfaceToPlayer(sb, teller, `surfaced fact number ${i}`);
    const { systemPrompt } = sb.session.getMomentPrompt({ moment: "social" });
    // The oldest surfacings drop out of the bounded PLAYER block; the freshest are present. (Scoped to
    // the player's own block: the teller npc(1) legitimately holds every fact too, so under ADR 0019
    // Layer 2 an older one may ride npc(1)'s present-NPC block — that is npc(1)'s knowledge, not the
    // player's, and it is the player's block whose recency window this test pins.)
    const learned = playerLearnedBlock(systemPrompt);
    expect(learned).toContain("surfaced fact number 8");
    expect(learned).not.toContain("surfaced fact number 0");
  });
});

/**
 * #1789 — telephone-game provenance texture on surfaced gossip (hops>=2), flag-gated
 * behind ORWELL_GOSSIP_DRIFT. When drift is ON, a fact with hops>=2 carries a provenance word
 * (second-hand/third-hand/everyone's saying) and a conditional deadpan guidance line appears.
 * When drift is OFF, the output is byte-identical to before this feature (no word, no guidance).
 */
describe("#1789 — telephone-game provenance word on surfaced gossip (hops>=2)", () => {
  const seedPlayerKnowledgeFact = (
    sb: ReturnType<GameSessionRegistry["sandboxFor"]>,
    content: string,
    hops: number,
  ): void => {
    // Seed a fact DIRECTLY on the PLAYER (bypassing the NPC↔player pathway) so it appears
    // in playerKnowledgeReader with known hops, for testing the render path.
    sb.engine.knowledge.seedBelief(
      PLAYER,
      { content, originalContent: content, factId: `t:${content}`, confidence: 0.9, hops, distortion: 0, source: npc(1) },
      `told-by:${npc(1)}`,
    );
  };

  it("drift ON — provenance word appears for hops>=2 facts, no raw hops number leaks", () => {
    const sb = liveGame(10, "drift-on");
    seedPlayerKnowledgeFact(sb, "Ada is angling for the veto", 3);
    sb.session.setGossipDriftEnabled(true);

    const { systemPrompt } = sb.session.getMomentPrompt({ moment: "social" });
    const learned = playerLearnedBlock(systemPrompt);
    expect(learned).toContain("(third-hand)");
    expect(learned).toContain("Ada is angling for the veto");
    expect(learned).not.toMatch(/\bhops[=:]?\s*\d/);
    expect(learned).not.toMatch(/\(\s*\d\)/);  // no raw digit in parens
    // Guidance line present
    expect(learned).toContain("multiple mouths");
  });

  it("drift OFF — no provenance word, no guidance line, byte-identical to baseline", () => {
    const sb = liveGame(11, "drift-off");
    seedPlayerKnowledgeFact(sb, "Bo is targeting the alliance", 3);
    sb.session.setGossipDriftEnabled(false); // explicit OFF (default flip 2026-11-03)

    const { systemPrompt } = sb.session.getMomentPrompt({ moment: "social" });
    const learned = playerLearnedBlock(systemPrompt);
    expect(learned).not.toContain("(third-hand)");
    expect(learned).not.toContain("(second-hand)");
    expect(learned).not.toContain("multiple mouths");
    // The fact content renders cleanly with NO prefix
    expect(learned).toContain("  - Bo is targeting the alliance");
    expect(learned).not.toMatch(/\s\(\w+-hand\)\s/);
  });

  it("hops=1 with drift ON — no provenance word (edge: below threshold)", () => {
    const sb = liveGame(12, "drift-hop1");
    seedPlayerKnowledgeFact(sb, "Claire is working the room", 1);
    sb.session.setGossipDriftEnabled(true);

    const { systemPrompt } = sb.session.getMomentPrompt({ moment: "social" });
    const learned = playerLearnedBlock(systemPrompt);
    // No provenance word for hops < 2
    expect(learned).not.toContain("(second-hand)");
    expect(learned).not.toContain("(third-hand)");
    expect(learned).not.toContain("everyone's saying");
    expect(learned).toContain("  - Claire is working the room");
  });

  it("guidance line only appears when at least one fact has hops>=2", () => {
    const sb = liveGame(13, "guidance-gated");
    seedPlayerKnowledgeFact(sb, "Dana made a secret deal", 1);
    sb.session.setGossipDriftEnabled(true);

    const { systemPrompt } = sb.session.getMomentPrompt({ moment: "social" });
    const learned = playerLearnedBlock(systemPrompt);
    // Only a single fact with hops=1 — no guidance line should appear
    expect(learned).not.toContain("multiple mouths");
    expect(learned).not.toContain("passed through");
  });
});
