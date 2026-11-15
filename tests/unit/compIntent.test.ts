import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { newLiveSeason, advance, applyDecision, type SeasonCtx } from "../../src/engine/liveSeason";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";

/**
 * Feature B46 / audit B5, EVOLVED to staged rounds (0006 staged-rounds evolution). The competition now
 * plays out in VISIBLE elimination rounds; the player declares compete / throw / play-safe FOR THAT ROUND
 * (seeing who is still in), committed BEFORE the round resolves and LOCKED after. The engine threads the
 * STRUCTURED per-round selection (never prose) into the resolution (the 0028 penalties). Adaptation is
 * forward-only — a past round's approach can never be re-labeled. HARD rule: roles only — no names.
 */

/**
 * Drive the live HOH staged comp to its crown with a FIXED player approach every round they are in
 * (deterministic per seed). Does the player win the opening HOH? The player is cast as a comp-beast so a
 * `compete` win is measurable (C6 made the NO-archetype default the MEDIAN floater — a deliberate underdog).
 */
function playerWinsOpeningHoh(seed: number, approach: "compete" | "throw" | "play-safe"): boolean {
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "P", archetype: "comp-beast", seed });
  for (let g = 0; g < 200; g++) {
    if (s.gameStatus().hoh) break;
    const adv = s.advanceGame();
    if (adv.pending?.kind === "comp-round") {
      s.submitDecision({ kind: "comp-round", intent: approach });
    } else if (adv.pending) {
      break; // the comp crowned an NPC and the loop moved on to a different decision
    }
  }
  return s.gameStatus().hoh?.id === PLAYER;
}

describe("0006 staged-rounds — a declared throw measurably lowers the player's win rate", () => {
  it("throwing the up-front approach in the opening HOH wins far less often than competing, across seeds", () => {
    let competeWins = 0, throwWins = 0;
    for (let seed = 1; seed <= 150; seed++) {
      if (playerWinsOpeningHoh(seed, "compete")) competeWins++;
      if (playerWinsOpeningHoh(seed, "throw")) throwWins++;
    }
    expect(competeWins).toBeGreaterThan(0);          // the player CAN win when they try
    expect(throwWins).toBeLessThan(competeWins);     // throwing measurably lowers the win rate (0028 penalty)
  });

  it("play-safe never beats compete: the approach levers are negative-only (A18), paired by seed", () => {
    let competeWins = 0, safeWins = 0, safeOnly = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const c = playerWinsOpeningHoh(seed, "compete");
      const sf = playerWinsOpeningHoh(seed, "play-safe");
      if (c) competeWins++;
      if (sf) safeWins++;
      if (sf && !c) safeOnly++;
    }
    expect(competeWins).toBeGreaterThan(0);
    expect(safeWins).toBeLessThanOrEqual(competeWins); // no approach but compete helps the player
    expect(safeOnly).toBeLessThanOrEqual(Math.ceil(0.05 * 150)); // a seed where play-safe wins and compete loses is rng-path noise at most, never a bonus
  });

  it("the comp-round decision offers compete / throw / play-safe (compete first = the default) + the still-in field", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", seed: 2 });
    s.advanceGame(); // 0111: close the premiere champagne circle
    let view = s.advanceGame(); // now the first HOH stages
    while (view.event?.beat === "day-break") view = s.advanceGame(); // P4b: with the clock live the premiere exit is the first-morning day-break; the HOH stages on the NEXT advance
    expect(view.pending?.kind).toBe("comp-round");
    expect(view.pending!.options.map((o) => o.id)).toEqual(["compete", "throw", "play-safe"]);
    // The staged prompt carries WHO IS STILL IN this round (the narrowed field) + the round number.
    expect(view.pending!.round).toBe(1);
    expect(view.pending!.stillIn!.length).toBeGreaterThan(1);
    expect(view.pending!.stillIn!.some((r) => r.id === PLAYER)).toBe(true);
  });

  // R4-02 parity: the pending presents comp-round as a generic options/pick decision, so a caller may
  // submit the approach as `choice` (like every other options/pick decision) — not only `intent`.
  it("accepts the approach submitted as `choice` (the generic options/pick shape)", () => {
    const viaChoice = new GameSessionAdapter();
    viaChoice.createCharacter({ playerName: "P", archetype: "comp-beast", seed: 1 });
    viaChoice.advanceGame();
    const a = viaChoice.submitDecision({ kind: "comp-round", choice: ["throw"] });

    const viaIntent = new GameSessionAdapter();
    viaIntent.createCharacter({ playerName: "P", archetype: "comp-beast", seed: 1 });
    viaIntent.advanceGame();
    const b = viaIntent.submitDecision({ kind: "comp-round", intent: "throw" });

    // `choice:["throw"]` and `intent:"throw"` resolve the round identically (same seed ⇒ same drop).
    expect(JSON.stringify(a.event)).toBe(JSON.stringify(b.event));
  });
});

describe("0006 staged-rounds — intent is asked ONCE up front; the field still narrows in presentation", () => {
  /** Play a comp-beast's opening HOH; count how many times the player was prompted + the max prompt round. */
  function promptStats(seed: number): { prompts: number; maxRound: number } {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", archetype: "comp-beast", seed });
    let prompts = 0;
    let maxRound = 0;
    for (let g = 0; g < 200; g++) {
      if (s.gameStatus().hoh) break;
      const adv = s.advanceGame();
      if (adv.pending?.kind === "comp-round") {
        prompts++;
        maxRound = Math.max(maxRound, adv.pending.round ?? 1);
        s.submitDecision({ kind: "comp-round", intent: "compete" });
      } else if (adv.pending) break;
    }
    return { prompts, maxRound };
  }

  it("prompts the player AT MOST once (up front), never re-asking as the field narrows (PO review 2026-06-28)", () => {
    let everPrompted = false;
    for (let seed = 1; seed <= 50; seed++) {
      const { prompts, maxRound } = promptStats(seed);
      expect(prompts, `seed ${seed}`).toBeLessThanOrEqual(1);   // asked once at most — never re-prompted
      if (prompts === 1) {
        everPrompted = true;
        expect(maxRound, `seed ${seed}`).toBe(1);                // and that one prompt is round 1 (up front)
      }
    }
    expect(everPrompted).toBe(true); // the single up-front prompt still fires (intent wasn't removed entirely)
  });
});

describe("0006 staged-rounds — the up-front approach is immutable once given (anti-sycophancy)", () => {
  it("after the single up-front approach resolves, no further comp-round is offered (one decision)", () => {
    const ctx: SeasonCtx = { player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel: new RelationshipModel(0.5) };
    const s = newLiveSeason([PLAYER, npc(1), npc(2), npc(3), npc(4)]);
    const rng = new SeededRandom(3);

    advance(s, ctx, rng); // pauses for the up-front approach (the player plays the opening HOH)
    expect(s.pending?.kind).toBe("comp-round");
    expect((s.pending as { round: number }).round).toBe(1);
    applyDecision(s, { kind: "comp-round", intent: "throw" }, ctx, rng); // the single roll resolves with it (locked)
    // The player is NEVER prompted for another comp-round — the elimination reveals play out untouched.
    for (let g = 0; g < 40 && !s.hoh; g++) {
      expect(s.pending?.kind, `step ${g}`).not.toBe("comp-round");
      advance(s, ctx, rng);
    }
  });

  it("a late comp-round through the live adapter is a no-op once the HOH is crowned (the crown stands)", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", seed: 2 });
    // Drive to the crown competing every round.
    for (let g = 0; g < 200; g++) {
      if (s.gameStatus().hoh) break;
      const adv = s.advanceGame();
      if (adv.pending?.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
      else if (adv.pending) break;
    }
    const crowned = s.gameStatus().hoh!.id;
    // No comp-round is pending now; submitting one again changes nothing (the round is over — immutability).
    const after = s.submitDecision({ kind: "comp-round", intent: "throw" });
    expect(after.status.hoh!.id).toBe(crowned);
  });
});
