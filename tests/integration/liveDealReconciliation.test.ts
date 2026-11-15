import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { AdvanceView } from "../../src/ports/GameSession";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { DealView } from "../../src/ports/GameSession";

/**
 * Audit T1 (the missing live gate for E42/E43) — deal reconciliation ON THE PRODUCTION PATH.
 * The 0039 BDD steps adjudicate a hand-built ledger; nothing proved `reconcileDeals`,
 * `bindingActionsFor`, the jury demerit, and the reveal event on the real registry/adapter
 * spine. These tests drive a REAL per-user sandbox (live relationships, live event store,
 * live loop) to an actual eviction and assert the full consequence chain.
 *
 * HARD rule: roles only — the player, the HOH, a voter, a nominee. No names.
 */

type Sandbox = ReturnType<GameSessionRegistry["sandboxFor"]>;

/** Resolve any player pending with a neutral policy (compete, first legal options, never veto). */
function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): AdvanceView {
  if (p.kind === "nominations") return s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  if (p.kind === "veto-decision") return s.submitDecision({ kind: "veto-decision", use: false });
  if (p.kind === "replacement") return s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  if (p.kind === "comp-intent") return s.submitDecision({ kind: "comp-intent", intent: "compete" });
  if (p.kind === "comp-round") return s.submitDecision({ kind: "comp-round", intent: "compete" }); // 0006 staged-rounds
  if (p.kind === "finale-statement") return s.submitDecision({ kind: "finale-statement", statement: "x" });
  if (p.kind === "finale-answer") return s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  if (p.kind === "juror-vote") return s.submitDecision({ kind: "juror-vote", vote: p.options[0]!.id });
  return s.submitDecision({ kind: p.kind, vote: p.options[0]!.id });
}

/** Advance (auto-resolving pendings) until `stop` matches a produced beat, or a bound is hit. */
function driveUntil(sb: Sandbox, stop: (adv: AdvanceView) => boolean, max = 600): AdvanceView | null {
  for (let i = 0; i < max; i++) {
    let adv = sb.session.advanceGame();
    if (stop(adv)) return adv;
    if (adv.pending) {
      adv = resolve(sb.session as GameSessionAdapter, adv.pending);
      if (stop(adv)) return adv;
    }
    if (adv.finished) return null;
  }
  return null;
}

/**
 * Start a seeded game where an NPC wins the opening HOH (so the HOH's nominations are
 * engine-driven), then make the PLAYER the house's runaway threat so the week plays DIRECT
 * at the player (0044's political temperature) and the player lands on the block.
 */
function gameWithPlayerOnTheBlock(): { sb: Sandbox; reg: GameSessionRegistry } {
  for (let seed = 5; seed <= 60; seed++) { // start re-selected 2026-11-12, ORW-19 comp-win threat 0.3 -> 0.45 (seeds 3-4 no longer land the broken-deal path); earlier: 2026-11-03 #1953 // start re-selected 2026-11-03, default flip (was 1); re-selected 2026-11-03, comp-win threat retune (#1953)
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("deal-user");
    sb.session.createCharacter({ playerName: "P", seed });
    sb.session.setNpcDealConsentEnabled(false); // these tests exercise deal MECHANICS, not NPC consent (dealConsent*.test.ts cover that)

    // Resolve the opening HOH comp — 0006 staged-rounds: drive the elimination ladder to the crown
    // (the player declares a per-round approach each round they are in).
    for (let g = 0; g < 200 && !sb.session.gameStatus().hoh; g++) {
      const adv = sb.session.advanceGame();
      if (adv.pending) resolve(sb.session as GameSessionAdapter, adv.pending);
      if (adv.finished) break;
    }
    const hoh = sb.session.gameStatus().hoh;
    if (!hoh || hoh.id === PLAYER) continue; // need an NPC HOH — try the next seed

    // The whole house reads the player as a runaway threat (hot week ⇒ every HOH plays direct).
    const core = sb.session.snapshot();
    for (const n of core.house!.npcs) {
      const e = sb.engine.relationships.edge(n.id, PLAYER);
      e.threat = 0.95; e.trust = 0.05; e.affinity = 0.1;
    }
    return { sb, reg };
  }
  throw new Error("no seed produced an NPC opening HOH within the bound");
}

describe("T1/E42 — NPC binding votes reconcile deals on the live spine", () => {
  it("an NPC with an open safety deal voting the player out ⇒ broken deal (SEALED, A7), betrayal manner, unattributed reveal, hidden fold", () => {
    const { sb } = gameWithPlayerOnTheBlock();
    const session = sb.session as GameSessionAdapter;

    // Reach the eviction with the player as a final nominee.
    const nominated = driveUntil(sb, (adv) =>
      sb.session.gameStatus().nominees.some((n) => n.id === PLAYER) && adv.status.phase === "eviction");
    expect(nominated, "the player reached the block").not.toBeNull();

    // A VOTER (not HOH, not a nominee) makes a safety deal with the player...
    const status = sb.session.gameStatus();
    const onBlock = new Set(status.nominees.map((n) => n.id));
    const voter = session.livingIds().find((id) => id !== PLAYER && id !== status.hoh!.id && !onBlock.has(id))!;
    const voterName = session.getGameState().house.find((h) => h.id === voter)!.name;
    const deal = session.makeDeal({ with: voter, kind: "safety", terms: "I keep you off my lips, you keep me off the block" }) as DealView | null;
    expect(deal!.status).toBe("open");

    const trustBefore = sb.engine.relationships.edge(PLAYER, voter).trust;
    const threatBefore = sb.engine.relationships.edge(PLAYER, voter).threat;

    // ...and then votes with the house to evict them (their 0.95 threat read beats the deal lean —
    // the engine, not prose, decides that this BREAKS the promise with full consequence).
    const evicted = driveUntil(sb, (adv) => adv.event?.beat === "eviction");
    expect(evicted, "the eviction resolved").not.toBeNull();
    const live = sb.session.snapshot().live!;
    expect(live.evictionOrder[0]).toBe(PLAYER); // the runaway threat went out the door

    // 1. The ledger marked the deal BROKEN internally — but the OUTWARD projection stays "open" (A7/
    // E12): this deal broke via the SEALED eviction ballot, and the raw status flip would itself be
    // the deanonymizing signal (the player already knows exactly who they struck this deal with).
    const view = session.getGameState().deals!.find((d) => d.id === deal!.id)!;
    expect(view.status).toBe("open");

    // 2. The jury demerit landed: the wronged player's manner toward the breaker reads betrayed
    // (the engine's hidden read is never softened by the seal — only what the player is TOLD is).
    expect(live.mannerByEvictee?.[PLAYER]?.[voter]?.betrayed).toBe(true);

    // 3. A7/E12: no player-visible event names the specific breaker — that would deanonymize their
    // sealed ballot before the 0048 retrospective. The player DOES learn the unattributed fact.
    const visibleBetrayals = sb.engine.events.query({ witnessedBy: PLAYER }).filter((e) => e.type === "betrayal");
    expect(visibleBetrayals.length, "an unattributed betrayal signal reached the player").toBeGreaterThan(0);
    for (const e of visibleBetrayals) expect(e.content).not.toContain(voterName);

    // ...while the FULL attribution is recorded Vault-side (hidden — no player witness) for later.
    const attributed = sb.engine.events.queryAll().find(
      (e) => e.type === "betrayal" && e.content.includes(voterName) && !e.witnessSet.includes(PLAYER),
    );
    expect(attributed, "the full attribution was recorded Vault-side").toBeTruthy();
    expect(attributed!.hidden).toBe(true);

    // 4. The hidden fold moved: the wronged party's computed edge took the betrayal-shock.
    expect(sb.engine.relationships.edge(PLAYER, voter).trust).toBeLessThan(trustBefore);
    expect(sb.engine.relationships.edge(PLAYER, voter).threat).toBeGreaterThan(threatBefore);

    // 5. No number crossed: the player-facing deal carries fact + status only.
    const blob = JSON.stringify(session.getGameState().deals);
    for (const banned of ["trust", "threat", "affinity", "reliability", "confidence"]) {
      expect(blob.includes(banned)).toBe(false);
    }
  });

  it("E43 — an NPC voter who SPARES their deal partner on the block resolves the deal KEPT and earns trust + reliability", () => {
    const { sb } = gameWithPlayerOnTheBlock();
    const session = sb.session as GameSessionAdapter;

    const nominated = driveUntil(sb, (adv) =>
      sb.session.gameStatus().nominees.some((n) => n.id === PLAYER) && adv.status.phase === "eviction");
    expect(nominated).not.toBeNull();

    const status = sb.session.gameStatus();
    const onBlock = new Set(status.nominees.map((n) => n.id));
    const otherNominee = status.nominees.find((n) => n.id !== PLAYER)!.id;
    const voter = session.livingIds().find((id) => id !== PLAYER && id !== status.hoh!.id && !onBlock.has(id))!;
    const deal = session.makeDeal({ with: voter, kind: "safety", terms: "vote to keep me" }) as DealView | null;

    // The honoring read: THIS voter sees the player as harmless and the other nominee as the threat.
    // EVERY voter reads it that way, so the PLAYER survives the block: an evicted player would (0110, vote deduction — now default ON)
    // deduce who moved against them and may wrongly blame the honest voter, a designed hidden-layer belief that rightly swamps the
    // kept-deal payout. This scenario is about the payout of a kept word, so the player must not be the evictee.
    for (const id of session.livingIds()) {
      if (id === PLAYER || id === status.hoh!.id || onBlock.has(id)) continue;
      const ev = sb.engine.relationships.edge(id, PLAYER);
      ev.threat = 0.01; ev.trust = 0.7; ev.affinity = 0.6;
      const eo = sb.engine.relationships.edge(id, otherNominee);
      eo.threat = 0.97; eo.trust = 0.02;
    }

    const trustBefore = sb.engine.relationships.edge(PLAYER, voter).trust;
    const reliabilityBefore = sb.engine.relationships.edge(PLAYER, voter).reliability;

    const evicted = driveUntil(sb, (adv) => adv.event?.beat === "eviction");
    expect(evicted).not.toBeNull();

    // The voter voted the OTHER way — the engine resolves the promise KEPT at its horizon...
    const view = session.getGameState().deals!.find((d) => d.id === deal!.id)!;
    expect(view.status).toBe("kept");
    // ...and the kept word PAYS (E43/E54): trust and demonstrated reliability both rise.
    expect(sb.engine.relationships.edge(PLAYER, voter).trust).toBeGreaterThan(trustBefore);
    expect(sb.engine.relationships.edge(PLAYER, voter).reliability).toBeGreaterThan(reliabilityBefore);
    // No betrayal fallout for the honoring voter.
    expect(sb.session.snapshot().live!.mannerByEvictee?.[PLAYER]?.[voter]?.betrayed).not.toBe(true);
  });

  it("E46 — a seeded season mints a Vault-held NPC↔NPC deal that never crosses an outward surface", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("npc-deal-user");
    sb.session.createCharacter({ playerName: "P", seed: 5 });
    sb.session.setNpcDealConsentEnabled(false); // these tests exercise deal MECHANICS, not NPC consent (dealConsent*.test.ts cover that)
    const session = sb.session as GameSessionAdapter;

    // Play forward until a nomination ceremony mints the pact (seeded, bounded probability per week).
    // 0006 staged-rounds adds many per-round beats per week, so raise the iteration bound to give the
    // bounded-probability per-week mint enough nomination ceremonies. Keep the two tightest SURVIVING
    // NPCs tight EACH turn (the live decay/folds + evictions otherwise erode the forced pair away before
    // a probabilistic mint week lands; the mint reads current trust over the still-active house).
    let npcDeal: { parties: { id: EntityId }[] } | undefined;
    driveUntil(sb, () => {
      const live = sb.session.snapshot().live;
      const npcs = (live?.active ?? []).filter((id) => id !== PLAYER);
      if (npcs.length >= 2) {
        const [a, b] = [npcs[0]!, npcs[1]!] as [EntityId, EntityId];
        sb.engine.relationships.edge(a, b).trust = 0.9;
        sb.engine.relationships.edge(b, a).trust = 0.9;
      }
      npcDeal = (sb.session.snapshot().deals ?? [])
        .map((d) => ({ parties: d.parties.map((id) => ({ id })) }))
        .find((d) => !d.parties.some((p) => p.id === PLAYER));
      return !!npcDeal;
    }, 2500);
    expect(npcDeal, "the off-screen society sealed at least one NPC↔NPC pact").toBeTruthy();

    // The pact's made-event is HIDDEN (no player witness ⇒ the Vault layer, 0002)...
    const made = sb.engine.events.queryAll().find((e) => e.type === "deal" && !e.witnessSet.includes(PLAYER));
    expect(made).toBeTruthy();
    expect(made!.hidden).toBe(true);

    // ...and nothing about it crosses an outward surface (the E46 sentinel): the player's own
    // deal list, the recap, and the public status never carry the hidden pact.
    const outward = [
      JSON.stringify(session.getGameState().deals ?? []),
      JSON.stringify(session.seasonRecap().deals),
      JSON.stringify(sb.session.gameStatus()),
    ].join("|");
    expect(outward.includes("quiet pact")).toBe(false);
    expect(session.getGameState().deals!.every((d) => d.parties.some((p) => p.id === PLAYER))).toBe(true);
  });
});
