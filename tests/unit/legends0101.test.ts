import { flagDefaultOn } from "../../src/domain/flagDefaults";
import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { notablePlayerActs } from "../../src/engine/legends";
import { LEGEND, GOSSIP, legendFrom, legendSeedProbability } from "../../src/engine/gossip";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { GameEvent } from "../../src/domain/event";

/**
 * Feature 0101 — NPC myth-making: the pure notable-act selector (`legends.ts`), the legend gloss
 * (`gossip.ts`'s `LEGEND`/`legendFrom`), and the adapter `legendTick` + orchestrator wiring +
 * calibration-neutrality gate (the `juryHouseAdapter`/`campaignExecution0085` sibling discipline).
 * Roles only: the-player / a-houseguest / far-houseguest. SELF-GATED: OFF ⇒ zero draws, no legend,
 * byte-identical.
 */

const PLAYER_NAME = "The Player";

function houseEvent(overrides: Partial<GameEvent> & Pick<GameEvent, "id" | "content">): GameEvent {
  return {
    ts: 0,
    type: "house-event",
    initiator: PLAYER,
    witnessSet: [PLAYER],
    hidden: false,
    ...overrides,
  };
}

describe("0101 — notablePlayerActs (pure selector)", () => {
  it("classifies the small curated set of high-salience beats", () => {
    const events: GameEvent[] = [
      houseEvent({ id: "season:1", ts: 1, content: `${PLAYER_NAME} wins Head of Household` }),
      houseEvent({ id: "season:2", ts: 2, content: `${PLAYER_NAME} wins the final Head of Household` }),
      houseEvent({ id: "season:3", ts: 3, content: `${PLAYER_NAME} wins the Power of Veto` }),
      houseEvent({ id: "season:4", ts: 4, content: `${PLAYER_NAME} uses the veto on npc:2; npc:3 names npc:4 as the replacement` }),
      houseEvent({ id: "season:5", ts: 5, content: `${PLAYER_NAME} nominates npc:2 and npc:3` }),
      houseEvent({ id: "season:6", ts: 6, content: `${PLAYER_NAME} wins the season over npc:2` }),
    ];
    const acts = notablePlayerActs(events, PLAYER_NAME, 0);
    expect(acts.map((a) => a.actClass)).toEqual(["hoh-win", "hoh-win", "veto-win", "veto-save", "nominations", "finale-win"]);
    expect(acts.every((a) => typeof a.eventId === "string" && typeof a.ts === "number")).toBe(true);
  });

  it("does not classify a self-save, someone else's beat, a non-house-event, or an ordinary line", () => {
    const events: GameEvent[] = [
      houseEvent({ id: "season:1", ts: 1, content: `${PLAYER_NAME} uses the veto on themselves; npc:2 names npc:3 as the replacement` }),
      houseEvent({ id: "season:2", ts: 2, content: "npc:2 wins Head of Household" }), // someone else's HOH
      houseEvent({ id: "season:3", ts: 3, content: `${PLAYER_NAME} does not use the veto` }),
      houseEvent({ id: "other:1", ts: 4, content: `${PLAYER_NAME} wins Head of Household`, type: "house-event" }), // wrong id prefix
      houseEvent({ id: "season:5", ts: 5, content: `${PLAYER_NAME} wins Head of Household`, type: "conversation" }), // wrong type
      houseEvent({ id: "season:6", ts: 6, content: "the house shares a quiet evening" }),
    ];
    expect(notablePlayerActs(events, PLAYER_NAME, 0)).toEqual([]);
  });

  it("respects the sinceTick watermark (a consumed act is never re-selected)", () => {
    const events: GameEvent[] = [
      houseEvent({ id: "season:1", ts: 5, content: `${PLAYER_NAME} wins the Power of Veto` }),
      houseEvent({ id: "season:2", ts: 9, content: `${PLAYER_NAME} nominates npc:2 and npc:3` }),
    ];
    expect(notablePlayerActs(events, PLAYER_NAME, 5).map((a) => a.eventId)).toEqual(["season:2"]);
    expect(notablePlayerActs(events, PLAYER_NAME, 9)).toEqual([]);
  });

  it("returns nothing without a player name (defensive — never matches an empty prefix)", () => {
    const events: GameEvent[] = [houseEvent({ id: "season:1", ts: 1, content: "wins the Power of Veto" })];
    expect(notablePlayerActs(events, "", 0)).toEqual([]);
  });
});

describe("0101 — legendFrom (the vague public gloss)", () => {
  it("maps every notable-act class to a non-empty, non-verbatim gloss", () => {
    for (const cls of ["hoh-win", "veto-win", "veto-save", "nominations", "finale-win"] as const) {
      const gloss = legendFrom(cls);
      expect(typeof gloss).toBe("string");
      expect(gloss.length).toBeGreaterThan(0);
      // Never the raw act-class token itself (a real paraphrase, not a passthrough).
      expect(gloss).not.toBe(cls);
    }
  });
});

/** Seed a fresh started game and record ONE notable player act (a veto win) into the public ledger,
 *  exactly the shape `registry.ts`'s `setOnEvent` wiring already produces. */
function gameWithNotableAct(user: string, seed: number): ReturnType<GameSessionRegistry["sandboxFor"]> {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: PLAYER_NAME, seed });
  sb.engine.events.record(houseEvent({
    id: `season:${sb.engine.events.count()}`, ts: sb.engine.events.count(),
    content: `${PLAYER_NAME} wins the Power of Veto`,
  }));
  return sb;
}

const NPC_IDS: EntityId[] = Array.from({ length: 15 }, (_, i) => npc(i + 1));

describe("0101 — legendTick when EXPLICITLY OFF (byte-identical: zero draws, no legend)", () => {
  it("a fresh session starts at the code default", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("legends-dflt");
    sb.session.createCharacter({ playerName: "The Player", seed: 11 });
    expect(sb.session.mythMakingEnabledNow()).toBe(flagDefaultOn("ORWELL_MYTH_MAKING", process.env));
  });

  it("a disabled myth-making layer is a no-op even with a ripe notable act on the ledger", () => {
    const sb = gameWithNotableAct("myth-off", 21);
    sb.session.setMythMakingEnabled(false); // explicit OFF (default flip 2026-11-03)
    const beforeCount = sb.engine.events.count();
    const beforeKnowledge = NPC_IDS.map((id) => sb.engine.knowledge.knownTo(id).length);
    sb.session.legendTick(sb.engine.events, sb.engine.knowledge);
    expect(sb.engine.events.count(), "no legend events recorded when off").toBe(beforeCount);
    expect(NPC_IDS.map((id) => sb.engine.knowledge.knownTo(id).length)).toEqual(beforeKnowledge);
    expect(sb.session.snapshot().legendTickCount, "the dedicated stream never advanced").toBeUndefined();
    expect(sb.session.snapshot().legendCount).toBeUndefined();
  });
});

describe("0101 — when enabled, a notable act eventually mints a spreading legend (engine-owned)", () => {
  it("seeds a legend belief, diffuses it, and folds NO relationship edge", () => {
    const sb = gameWithNotableAct("myth-on", 22);
    sb.session.setMythMakingEnabled(true);

    // Snapshot every directed edge among the player + NPCs BEFORE, to prove myth-making moves none of
    // them (mandate #3 — a legend never folds the player's own edges, nor any NPC's read of the player).
    const everyone: EntityId[] = [PLAYER, ...NPC_IDS];
    const edgeBefore = new Map<string, string>();
    for (const a of everyone) for (const b of everyone) {
      if (a === b) continue;
      edgeBefore.set(`${a}->${b}`, JSON.stringify(sb.engine.relationships.edge(a, b)));
    }

    let minted = false;
    for (let i = 0; i < 60 && !minted; i++) {
      sb.session.legendTick(sb.engine.events, sb.engine.knowledge);
      minted = NPC_IDS.some((id) => sb.engine.knowledge.knownTo(id).some((f) => f.content?.includes("running this house")
        || f.content?.includes("won that veto out of nowhere")));
    }
    expect(minted, "a legend eventually seeds within a generous tick budget (seedProb 0.35)").toBe(true);
    expect(sb.session.snapshot().legendCount).toBeGreaterThan(0);

    for (const a of everyone) for (const b of everyone) {
      if (a === b) continue;
      expect(JSON.stringify(sb.engine.relationships.edge(a, b)), `edge ${a}->${b} must be untouched by myth-making`)
        .toBe(edgeBefore.get(`${a}->${b}`));
    }
  });

  it("never seeds a second legend from the SAME notable act (the watermark) and respects the season cap", () => {
    const sb = gameWithNotableAct("myth-cap", 23);
    sb.session.setMythMakingEnabled(true);
    for (let i = 0; i < 400; i++) sb.session.legendTick(sb.engine.events, sb.engine.knowledge);
    // Only ONE notable act ever existed on the ledger, so at most one legend can come from it.
    expect(sb.session.snapshot().legendCount ?? 0).toBeLessThanOrEqual(1);
  });

  it("ORW-283: there is no hard per-season count - each legend minted only makes the next one costlier", () => {
    expect((LEGEND as Record<string, unknown>)["maxPerSeason"], "the per-season cap is gone").toBeUndefined();
    expect(legendSeedProbability(0)).toBe(LEGEND.seedProb);
    let prev = legendSeedProbability(0);
    for (let n = 1; n <= 40; n++) {
      const p = legendSeedProbability(n);
      expect(p, `cost rises with every legend (n=${n})`).toBeLessThan(prev);
      expect(p, "never a hard zero").toBeGreaterThan(0);
      prev = p;
    }
    // a house that already minted far more than the old cap of 4 can still mint (the tick no longer returns early)
    const sb = gameWithNotableAct("myth-no-cap", 27);
    sb.session.setMythMakingEnabled(true);
    (sb.session as unknown as { legendCount: number }).legendCount = 9;
    for (let i = 0; i < 4000; i++) sb.session.legendTick(sb.engine.events, sb.engine.knowledge);
    expect(sb.session.snapshot().legendCount ?? 0, "the tenth legend can still be minted").toBeGreaterThan(9);
  });

  it("ORW-283: the tick's OWN diffusion lands in the player's knowledge as a belief with a source and confidence, and the narrator is handed it", () => {
    // A legend is ONE diffusion per mint and reaches the player only rarely (0101: "rarely, as a belief"), so search seeds for a real reach.
    let found: { heard: { content?: string; pathway: string; confidence?: number }; prompt: string } | undefined;
    for (let seed = 1; seed <= 80 && !found; seed++) {
      const sb = gameWithNotableAct(`myth-reach-${seed}`, seed);
      sb.session.setMythMakingEnabled(true);
      // a warm house, so the gossip graph has edges through the player (a legend only travels along affinity edges)
      const everyone: EntityId[] = [PLAYER, ...NPC_IDS];
      for (const a of everyone) for (const b of everyone) {
        if (a !== b) sb.engine.relationships.edge(a, b).affinity = Math.min(1, GOSSIP.affinityEdge + 0.4);
      }
      for (let i = 0; i < 300; i++) sb.session.legendTick(sb.engine.events, sb.engine.knowledge);
      const heard = sb.engine.knowledge.knownTo(PLAYER).find((f) => /running this house|won that veto|not afraid|not as harmless|whole game/.test(f.content ?? ""));
      if (heard) found = { heard, prompt: String((sb.session.getMomentPrompt({ moment: "social" }) as { systemPrompt?: string }).systemPrompt ?? "") };
    }
    expect(found, "within 80 seeds the engine's own diffusion carries a legend to the player (no hand-built last hop)").toBeDefined();
    expect(found!.heard.pathway, "with a real in-game pathway (a source), never a bare fact").toMatch(/^told-by:|^overheard/);
    expect(typeof found!.heard.confidence === "number" && found!.heard.confidence! < 1, "held as a belief with confidence below certainty").toBe(true);
    // the narrator's hands: the moment prompt carries what the player has heard, so the model can voice "people are saying ..."
    expect(found!.prompt, "the surfaced legend text is in the prompt the narrator receives").toContain(found!.heard.content!.replace(/\s*\(.*$/, "").slice(0, 20));
  });

  it("mints no legend before any notable act exists", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("myth-none");
    sb.session.createCharacter({ playerName: PLAYER_NAME, seed: 24 });
    sb.session.setMythMakingEnabled(true);
    for (let i = 0; i < 30; i++) sb.session.legendTick(sb.engine.events, sb.engine.knowledge);
    expect(sb.session.snapshot().legendCount ?? 0).toBe(0);
  });
});

describe("0101 — Vault Wall: no admin surface exposes the diffusing legend", () => {
  it("the admin-visible state never carries the legend content, its factId, or any knowledge belief", () => {
    const sb = gameWithNotableAct("myth-admin", 25);
    sb.session.setMythMakingEnabled(true);
    for (let i = 0; i < 60; i++) sb.session.legendTick(sb.engine.events, sb.engine.knowledge);
    const adminJson = JSON.stringify(sb.admin.inspect());
    expect(adminJson).not.toMatch(/running this house|won that veto out of nowhere/);
    expect(adminJson).not.toMatch(/factId/);
  });
});
