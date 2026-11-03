import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { VOL_OF, dispositionOf } from "../../src/engine/characterFactory";
import { settleScaleOf } from "../../src/engine/emotionalArc";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import type { UserSandbox } from "../../src/composition/registry";

/**
 * Feature 0124 — deeper character evolution, live through the adapter. Proves part C (disposition-tuned
 * reactivity replaces the flat random draw), the Vault Wall (no affect/drift/reactivity number reaches the
 * player), flag-off byte-identity (legacy random draw stands), and determinism. Roles only — no names.
 */

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
}

function newGame(user: string, seed: number, soulDepth: boolean): UserSandbox {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.setSoulDepthEnabled(soulDepth); // (explicit both ways, default flip 2026-11-03) BEFORE createCharacter ⇒ the part-C post-pass fires
  sb.session.createCharacter({ playerName: "P", seed });
  return sb;
}

function drive(sb: UserSandbox, steps: number): void {
  for (let i = 0; i < steps; i++) {
    const v = sb.session.advanceGame();
    if (v.pending) resolveLegally(sb.session, v.pending);
    if (v.finished) return;
  }
}

describe("0124 (C) — NPC reactivity is disposition-derived, not a flat random draw", () => {
  it("with soul-depth on, every houseguest's starting volatility + settle match their disposition", () => {
    const sb = newGame("evo-c-on", 5, true);
    const house = sb.session.snapshot().house!;
    for (const hg of house.npcs) {
      const disp = dispositionOf(hg.character.archetype);
      expect(hg.soul.volatility).toBe(VOL_OF[disp]);       // temperamental (clash) ⇒ 0.7, even-keeled (bond) ⇒ 0.3
      expect(hg.soul.settleScale).toBe(settleScaleOf(disp));
    }
  });

  it("with soul-depth off, volatility is the legacy random draw and settleScale is absent (byte-identical)", () => {
    const sb = newGame("evo-c-off", 5, false);
    const house = sb.session.snapshot().house!;
    // The random draw does NOT line up with the disposition table for every NPC, and no settleScale is set.
    const anyOffTable = house.npcs.some((hg) => hg.soul.volatility !== VOL_OF[dispositionOf(hg.character.archetype)]);
    expect(anyOffTable, "the legacy random draw is in play, not the disposition table").toBe(true);
    expect(house.npcs.every((hg) => hg.soul.settleScale === undefined)).toBe(true);
  });

  it("is seed-deterministic — the same seed reproduces the same reactivity", () => {
    const a = newGame("evo-det", 9, true).session.snapshot().house!;
    const b = newGame("evo-det", 9, true).session.snapshot().house!;
    expect(a.npcs.map((n) => n.soul.volatility)).toEqual(b.npcs.map((n) => n.soul.volatility));
  });
});

describe("0124 — the deeper evolution is Vault-free", () => {
  it("no affect axis, temperament, or reactivity number reaches the player OR admin surface", () => {
    const sb = newGame("evo-wall", 7, true);
    drive(sb, 60); // let souls evolve (distress/confidence/drift populate via the live folds)
    const house = sb.session.snapshot().house!;
    const evolved = house.npcs.filter((n) => n.soul.distress !== undefined);
    expect(evolved.length, "there IS hidden evolved axis state to leak").toBeGreaterThan(0);

    // The mandate (CLAUDE.md) requires proving BOTH the player AND admin/God-Mode paths expose no Vault
    // data — the admin is walled from the soul too. Sweep both surfaces.
    sb.syncAdmin();
    const surface = [
      JSON.stringify(sb.session.getGameState()),
      JSON.stringify(sb.session.gameStatus()),
      JSON.stringify(sb.session.getMomentPrompt({})),
      JSON.stringify(sb.player.getVisibleState()),
      JSON.stringify(sb.admin.inspect()),
    ].join("\n---\n");
    // The real leak shape is a SERIALIZED soul object — the JSON key `"distress":` — not the bare English
    // word "confidence" (which legitimately appears in narration prose). Check for the key form.
    for (const field of ["distress", "confidence", "temperamentDrift", "settleScale", "volatility", "emotionalState"]) {
      expect(surface.includes(`"${field}":`), `the hidden soul field ${field} leaked onto a player/admin surface`).toBe(false);
    }
    void PLAYER;
  });
});
