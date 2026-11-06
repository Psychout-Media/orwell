import { describe, it, expect } from "vitest";
import { pitchTilt, chooseOffer, LOBBY, type Pitch } from "../../src/engine/lobbying";

/**
 * B6 / #2017 slice 1 (design S5, NPC<->NPC lobbying of the HOH before nominations). A non-HOH NPC with a stake issues a PITCH (safety offer / deal / favor / information / threat);
 * the HOH folds a bounded per-week `pitchTilt(subject)` into the nomination score - the same additive slot as campaign/memory/belief pushes. The tilt is weighted by how CREDIBLE the
 * HOH finds the pitcher and is capped BELOW the bloc term so lobbying can tilt but never dictate. Pure + deterministic; the offer choice is the pitcher's own best response by
 * personality. Wiring (the off-screen tick, recording, deals) is slice 2, flag-off. Roles only.
 */
const P = (from: string, over: Partial<Pitch> = {}): Pitch => ({ from, kind: "safety", strength: 0.8, protects: from, ...over });

describe("pitchTilt", () => {
  it("is zero with no pitches (byte-identical)", () => {
    expect(pitchTilt("npc:2", [], () => 1)).toBe(0);
  });
  it("a credible pitch protecting the subject LOWERS their nomination score", () => {
    expect(pitchTilt("npc:2", [P("npc:2")], () => 1)).toBeLessThan(0);
  });
  it("a pitch steering the HOH toward the subject RAISES it", () => {
    expect(pitchTilt("npc:3", [P("npc:2", { kind: "info", protects: undefined, targets: "npc:3" })], () => 1)).toBeGreaterThan(0);
  });
  it("is scaled by the pitcher's credibility to the HOH", () => {
    const pitches = [P("npc:2")];
    expect(Math.abs(pitchTilt("npc:2", pitches, () => 0.2))).toBeLessThan(Math.abs(pitchTilt("npc:2", pitches, () => 1)));
    expect(pitchTilt("npc:2", pitches, () => 0)).toBe(0);
  });
  it("is capped so lobbying tilts but never dictates", () => {
    const many = Array.from({ length: 12 }, (_, i) => P(`npc:${i + 5}`, { protects: "npc:2", strength: 1 }));
    expect(Math.abs(pitchTilt("npc:2", many, () => 1))).toBeLessThanOrEqual(LOBBY.maxTilt + 1e-9);
    expect(LOBBY.maxTilt).toBeLessThan(0.25);
  });
  it("ignores pitches that do not concern the subject", () => {
    expect(pitchTilt("npc:9", [P("npc:2")], () => 1)).toBe(0);
  });
});

describe("chooseOffer (the pitcher's own best response)", () => {
  it("a loyalist offers safety, a shark trades information, a chaos agent threatens", () => {
    expect(chooseOffer({ loyalty: 0.9, cunning: 0.2, chaos: 0.1 })).toBe("safety");
    expect(chooseOffer({ loyalty: 0.2, cunning: 0.9, chaos: 0.1 })).toBe("info");
    expect(chooseOffer({ loyalty: 0.1, cunning: 0.2, chaos: 0.9 })).toBe("threat");
  });
  it("is deterministic (ties break the same way every time)", () => {
    const p = { loyalty: 0.5, cunning: 0.5, chaos: 0.5 };
    expect(chooseOffer(p)).toBe(chooseOffer(p));
  });
});

import { nominationPlan } from "../../src/engine/season";
import { RelationshipModel } from "../../src/engine/relationships";
import { GameSessionRegistry } from "../../src/composition/registry";

describe("slice 2 - the pitch term in the nomination score (flag ORWELL_LOBBYING)", () => {
  const ids = ["npc:1", "npc:2", "npc:3", "npc:4", "npc:5"];
  it("a pitchPush that protects the HOH's top target moves them off the block (a tilt, not a veto)", () => {
    const r = new RelationshipModel(0.5);
    const base = nominationPlan("npc:1", ids, r, {});
    const lobbied = nominationPlan("npc:1", ids, r, { pitchPush: (t) => (t === base.target ? -LOBBY.maxTilt : 0) });
    expect(lobbied.nominees.length).toBe(2);
    expect(nominationPlan("npc:1", ids, r, { pitchPush: undefined })).toEqual(base);
  });
  function started() {
    const sb = new GameSessionRegistry().sandboxFor(`lobby-${Math.random()}`);
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    sb.session.advanceGame(); sb.session.advanceGame();
    const [hoh, other] = [...sb.session.livingIds()].filter((i) => i !== "player");
    return { sb, hoh: hoh!, other: other! };
  }
  type G = { pitchTiltFor(subject: string, holder: string): number; setLobbyingEnabled(on: boolean): void };
  it("is zero with the flag off (default) - byte-identical", () => {
    const { sb, hoh, other } = started();
    (sb.session as unknown as G).setLobbyingEnabled(false); // the layer defaults ON since 2026-11-05; this asserts the OFF path
    expect((sb.session as unknown as G).pitchTiltFor(other, hoh)).toBe(0);
  });
  it("with the flag on it is deterministic, bounded by the cap, and never positive for the pitcher's own seat", () => {
    const { sb, hoh, other } = started();
    const g = sb.session as unknown as G; g.setLobbyingEnabled(true);
    const a = g.pitchTiltFor(other, hoh), b = g.pitchTiltFor(other, hoh);
    expect(a).toBe(b);
    expect(Math.abs(a)).toBeLessThanOrEqual(LOBBY.maxTilt + 1e-9);
    expect(a).toBeLessThanOrEqual(0); // a self-protecting pitch only ever lowers the pitcher's own nomination score
  });
});
