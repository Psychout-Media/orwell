import { describe, it, expect, vi } from "vitest";

// P0 flip: asserts the veto memory bias is 0 with the flag off (default). Those layers now default ON, so this file pins them OFF explicitly (hoisted: some adapter consts read env at import). Tests that need a layer ON turn it on through its setter.
vi.hoisted(() => { for (const k of ["ORWELL_ASSURANCES", "ORWELL_VOTE_COUNT", "ORWELL_VETO_MEMORY", "ORWELL_DEAL_NOMS", "ORWELL_CAMPAIGN_MEMORY", "ORWELL_APPROACH_MEMORY", "ORWELL_HC_MEMORY", "ORWELL_MEMORY_PROMISES", "ORWELL_FORGIVENESS", "ORWELL_LOBBYING", "ORWELL_DESIRE_CLOCK", "ORWELL_WANT_MOVEMENT", "ORWELL_MULTI_NIGHT_FATIGUE", "ORWELL_MORNING_APPROACH", "ORWELL_NPC_TELLS", "ORWELL_TELL_REACTIONS", "ORWELL_MOOD_VETO", "ORWELL_MOOD_APPROACH", "ORWELL_MOOD_DEAL", "ORWELL_MOOD_CAMPAIGN", "ORWELL_DRIFT_FIX", "ORWELL_NPC_MEMORY_SPEECH", "ORWELL_DRIVE_DECISIONS"]) process.env[k] = "0"; });
import { GameSessionRegistry } from "../../src/composition/registry";
import { RelationshipModel } from "../../src/engine/relationships";
import { PLAYER } from "../../src/domain/ids";

/**
 * B7 / #2017 M1 (approved tie-in #1) - the NPC veto decision reads MEMORY, not only trust + campaign bias: a remembered grudge toward a nominee lowers how worth saving they are, a remembered
 * favor raises it, a belief that they are targeting the holder lowers it, and an open deal the holder owes them raises it. Bounded; flag-off (ORWELL_VETO_MEMORY) byte-identical. Roles only.
 */
describe("chooseVetoSave with a memory bias (the engine hook)", () => {
  it("absent bias is unchanged; a large positive bias makes a below-threshold nominee worth saving; a large negative one makes a favoured nominee not worth saving", () => {
    const r = new RelationshipModel(0.5);
    const base = r.chooseVetoSave("npc:1", ["npc:2", "npc:3"]);
    expect(r.chooseVetoSave("npc:1", ["npc:2", "npc:3"], undefined)).toBe(base);
    expect(r.chooseVetoSave("npc:1", ["npc:2", "npc:3"], () => 5)).toBeDefined();
    expect(r.chooseVetoSave("npc:1", ["npc:2", "npc:3"], () => -5)).toBeUndefined();
  });
});

describe("the adapter's veto memory bias (ORWELL_VETO_MEMORY)", () => {
  function started() {
    const sb = new GameSessionRegistry().sandboxFor(`vetomem-${Math.random()}`);
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    sb.session.advanceGame(); sb.session.advanceGame();
    const [holder, nominee] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
    return { sb, holder: holder!, nominee: nominee! };
  }
  type G = { setVetoMemoryEnabled(on: boolean): void; vetoMemoryFor(nominee: string, holder: string): number; remember(h: string, s: string, k: string, sev: number): void };
  it("is 0 with the flag off (default)", () => {
    const { sb, holder, nominee } = started();
    const g = sb.session as unknown as G;
    g.remember(holder, nominee, "deal-broken", 0.9);
    expect(g.vetoMemoryFor(nominee, holder)).toBe(0);
  });
  it("a remembered grudge LOWERS the save-worthiness; a remembered favor RAISES it; both bounded", () => {
    const { sb, holder, nominee } = started();
    const g = sb.session as unknown as G; g.setVetoMemoryEnabled(true);
    const none = g.vetoMemoryFor(nominee, holder);
    g.remember(holder, nominee, "deal-broken", 0.9);
    const grudge = g.vetoMemoryFor(nominee, holder);
    expect(grudge).toBeLessThan(none);
    const s2 = started(); const g2 = s2.sb.session as unknown as G; g2.setVetoMemoryEnabled(true);
    g2.remember(s2.holder, s2.nominee, "veto-saved", 0.9);
    expect(g2.vetoMemoryFor(s2.nominee, s2.holder)).toBeGreaterThan(0);
    expect(Math.abs(grudge)).toBeLessThanOrEqual(1);
  });
  it("the player is never a holder (NPC decision only)", () => {
    const { sb, nominee } = started();
    const g = sb.session as unknown as G; g.setVetoMemoryEnabled(true);
    expect(g.vetoMemoryFor(nominee, PLAYER)).toBe(0);
  });
});
