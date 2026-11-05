import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { BindingAction } from "../../src/domain/deal";
import type { DealView } from "../../src/ports/GameSession";

/**
 * Ship-blocker A7 — eviction votes are SECRET BALLOTS (E12): the staged reveal only ever carries
 * anonymized ballots ("a vote to evict …"); per-voter attribution unseals ONLY in the 0048
 * post-season retrospective. `reconcileDeals` and `reconcileAllianceBetrayals` (GameSessionAdapter)
 * separately minted a player-witnessed event NAMING the breaker whenever the triggering binding
 * action was a `vote-evict` — deanonymizing that houseguest's ballot the moment the deal/alliance
 * broke, well before the retrospective. This file proves the seal: the fact that a deal/alliance
 * broke reaches the player (a Vault-safe, unattributed signal), but the specific voter's identity —
 * tied to the sealed ballot — stays Vault-held until the season finishes and the SAME terminal gate
 * the primary eviction reveal already uses lifts it.
 *
 * HARD rule: roles only — the player, an NPC voter, a deal partner. No names.
 */

interface Pokeable {
  live: { finished?: boolean } | undefined;
  reconcileDeals(action: BindingAction): void;
  reconcileAllianceBetrayals(action: BindingAction): void;
}
const poke = (s: GameSessionAdapter): Pokeable => s as unknown as Pokeable;

function newGame(user: string, seed: number) {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const session = sb.session as GameSessionAdapter;
  const npc = session.getGameState().house[0]!.id;
  const npcName = session.getGameState().house[0]!.name;
  return { reg, sb, session, npc, npcName };
}

describe("A7 — the sealed eviction ballot must not deanonymize through a deal-break reveal", () => {
  it("an NPC's SEALED vote breaking a deal never names them to the player pre-retrospective", () => {
    const { sb, session, npc, npcName } = newGame("a7-deal-user", 3);

    const deal = session.makeDeal({ with: npc, kind: "safety", terms: "keep me off the block" }) as DealView | null;
    expect(deal!.status).toBe("open");

    // The NPC's SECRET eviction vote breaks the deal — a binding vote-evict action against the player,
    // exactly the shape the live eviction loop mints per voter (`bindingActionsFor`, "eviction" case).
    const action: BindingAction = { actor: npc, kind: "vote-evict", targets: [PLAYER], alternatives: [PLAYER, "npc:other"] };
    poke(session).reconcileDeals(action);

    // 1. The deal is genuinely broken (engine truth, never softened).
    const view = session.getGameState().deals!.find((d) => d.id === deal!.id)!;
    // The OUTWARD status stays "open" while the ballot is sealed — the raw break would itself be the
    // deanonymizing signal (the player already knows exactly who their deal partner is).
    expect(view.status).toBe("open");

    // 2. NO event visible to the player about the BREAK names the specific breaker (the "deal made"
    // event legitimately names the partner — the player always knows who they struck a deal with;
    // it is only the sealed-ballot BREAK that must withhold attribution).
    const visibleToPlayer = sb.engine.events.query({ witnessedBy: PLAYER });
    const visibleBetrayals = visibleToPlayer.filter((e) => e.type === "betrayal");
    expect(visibleBetrayals.length).toBeGreaterThan(0);
    for (const e of visibleBetrayals) {
      expect(e.content).not.toContain(npcName);
    }
    // 3. But the FACT a deal broke DOES reach the player — a Vault-safe, unattributed signal.
    const sealedSignal = visibleBetrayals[0];
    expect(sealedSignal, "an unattributed betrayal signal reached the player").toBeTruthy();
    expect(sealedSignal!.witnessSet).toEqual([PLAYER]); // no breaker id riding along in the witness set either

    // 4. The full attribution IS recorded — Vault-side (hidden, no player witness) — for the retrospective.
    const attributed = sb.engine.events.queryAll().find(
      (e) => e.type === "betrayal" && e.content.includes(npcName) && e.content.includes("broke"),
    );
    expect(attributed, "the full attribution was recorded Vault-side").toBeTruthy();
    expect(attributed!.hidden).toBe(true);
    expect(attributed!.witnessSet).not.toContain(PLAYER);

    // 5. The hidden relationship fold + jury demerit still landed immediately (never softened by the seal).
    expect(sb.session.snapshot().live!.mannerByEvictee?.[PLAYER]?.[npc]?.betrayed).toBe(true);

    // 6. No number ever crossed on the (sealed) deal projection.
    const blob = JSON.stringify(session.getGameState().deals);
    for (const banned of ["trust", "threat", "affinity", "reliability", "confidence"]) {
      expect(blob.includes(banned)).toBe(false);
    }
  });

  it("the retrospective (0048) STILL unseals the full attribution once the season finishes", () => {
    const { sb, session, npc, npcName } = newGame("a7-deal-retro-user", 3);
    const deal = session.makeDeal({ with: npc, kind: "safety", terms: "keep me off the block" }) as DealView | null;
    const action: BindingAction = { actor: npc, kind: "vote-evict", targets: [PLAYER], alternatives: [PLAYER, "npc:other"] };
    poke(session).reconcileDeals(action);

    // Pre-finish: the Wall holds — sealed on the deal projection, no attributed content anywhere outward.
    expect(session.seasonRetrospective()).toBeNull();
    const dealViewBefore = session.getGameState().deals!.find((d) => d.id === deal!.id)!;
    expect(dealViewBefore.status).toBe("open");

    // Legitimately finish the season (the deterministic admin fast-forward — never touches the
    // retrospective's own gate; it only drives the loop to its real terminal state).
    const ff = session.advanceToFinale();
    expect(ff.finished).toBe(true);

    // Post-finish: the SAME terminal gate the primary eviction reveal uses now unseals the attribution.
    const retro = session.seasonRetrospective();
    expect(retro).not.toBeNull();
    const story = JSON.stringify(retro!.hiddenStory);
    expect(story).toContain(npcName);
    expect(story).toContain("broke a safety deal");

    // And the deal's own outward status un-seals too — it now reads the engine truth.
    const dealViewAfter = session.getGameState().deals!.find((d) => d.id === deal!.id)!;
    expect(dealViewAfter.status).toBe("broken");
  });

  it("a break the player caused THEMSELVES is never sealed from them (their own vote is their own knowledge)", () => {
    const { session, npc, npcName } = newGame("a7-deal-self-user", 3);
    session.makeDeal({ with: npc, kind: "safety", terms: "keep you off the block" });
    // The PLAYER'S OWN vote-evict breaks the deal — nothing to seal, they already know how they voted.
    poke(session).reconcileDeals({ actor: PLAYER, kind: "vote-evict", targets: [npc], alternatives: [npc, "npc:other"] });
    const view = session.getGameState().deals![0]!;
    expect(view.status).toBe("broken"); // never sealed — it's the player's own action
  });

  it("a break triggered by a PUBLIC action (a nomination) is never sealed — nominations are never secret", () => {
    const { session, npc } = newGame("a7-deal-public-user", 3);
    const deal = session.makeDeal({ with: npc, kind: "safety", terms: "keep me off the block" }) as DealView | null;
    poke(session).reconcileDeals({ actor: npc, kind: "nominate", targets: [PLAYER, "npc:other"] });
    const view = session.getGameState().deals!.find((d) => d.id === deal!.id)!;
    expect(view.status).toBe("broken"); // public ceremony action ⇒ reveals normally, no seal
  });
});

describe("A7 — the same seal applies to a named-alliance betrayal (0107 Phase B)", () => {
  interface AlliancePokeable {
    alliances: { add(name: string, founder: EntityId, members: EntityId[], week: number): { id: string } };
  }
  const pokeAlliances = (s: GameSessionAdapter): AlliancePokeable => s as unknown as AlliancePokeable;

  it("an NPC's SEALED vote betraying a shared alliance never names them pre-retrospective", () => {
    const { sb, session, npc, npcName } = newGame("a7-alliance-user", 5);
    pokeAlliances(session).alliances.add("The Brigade", npc, [npc, PLAYER], 1);

    const action: BindingAction = { actor: npc, kind: "vote-evict", targets: [PLAYER] };
    poke(session).reconcileAllianceBetrayals(action);

    const visibleToPlayer = sb.engine.events.query({ witnessedBy: PLAYER });
    for (const e of visibleToPlayer) expect(e.content).not.toContain(npcName);
    expect(visibleToPlayer.some((e) => e.type === "betrayal")).toBe(true); // the unattributed signal lands

    const attributed = sb.engine.events.queryAll().find(
      (e) => e.type === "betrayal" && e.content.includes(npcName) && e.content.includes("turned on the alliance"),
    );
    expect(attributed, "the full attribution was recorded Vault-side").toBeTruthy();
    expect(attributed!.hidden).toBe(true);
  });

  it("a nomination-triggered alliance betrayal (public) still names the betrayer normally", () => {
    const { sb, session, npc, npcName } = newGame("a7-alliance-public-user", 5);
    pokeAlliances(session).alliances.add("The Brigade", npc, [npc, PLAYER], 1);
    poke(session).reconcileAllianceBetrayals({ actor: npc, kind: "nominate", targets: [PLAYER] });
    const visibleToPlayer = sb.engine.events.query({ witnessedBy: PLAYER });
    expect(visibleToPlayer.some((e) => e.content.includes(npcName) && e.content.includes("turned on the alliance"))).toBe(true);
  });
});
