import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { MOMENT_PROMPTS } from "../../src/engine/momentPrompts";
import type { AdvanceView } from "../../src/ports/GameSession";

/**
 * ENDGAME-4 (2026-07-03 final-pre-ship audit, endgame lane) — "No distinct WINNER moment — champion
 * and runner-up both get the generic 'post-season' reunion prompt." The season builds to winning Big
 * Brother, and the moment it happened the framing dropped straight to "host the reunion, offer the
 * recap" with zero distinction between winning and losing the finale.
 *
 * The fix is PRESENTATION ONLY: the `post-season` moment-prompt fragment (voiced on every post-finale
 * turn) now instructs the model to frame the crowning by the player's placement BEFORE hosting the
 * reunion — reading the fact the engine already injects verbatim (`playerSeason()` → "THE PLAYER'S OWN
 * SEASON: You WON the season." / "...RUNNER-UP..."). No engine state shape changed: `moment` stays
 * "post-season" (so every existing FE/engine consumer of that terminal signal is untouched), `finished`
 * and the winner are computed exactly as before — this file is the neutrality proof for that claim,
 * plus coverage that the crowning framing actually exists and is correctly ordered. Roles only.
 */
type Pending = NonNullable<AdvanceView["pending"]>;
function resolve(s: GameSessionAdapter, p: Pending): void {
  const o = (i = 0): string => p.options[i]?.id;
  switch (p.kind) {
    case "nominations": s.submitDecision({ kind: "nominations", choice: [o(0), o(1)] }); break;
    case "veto-decision": s.submitDecision({ kind: "veto-decision", use: false }); break;
    case "comp-intent": s.submitDecision({ kind: "comp-intent", intent: "compete" }); break;
    case "comp-round": s.submitDecision({ kind: "comp-round", intent: "compete" }); break;
    case "houseguests-choice": s.submitDecision({ kind: "houseguests-choice", choice: [o(0)] }); break;
    case "replacement": s.submitDecision({ kind: "replacement", replacement: o(0) }); break;
    case "eviction-vote": s.submitDecision({ kind: "eviction-vote", vote: o(0) }); break;
    case "goodbye-message": s.submitDecision({ kind: "goodbye-message", vote: o(0), statement: "x" }); break;
    case "finale-statement": s.submitDecision({ kind: "finale-statement", statement: "x" }); break;
    case "finale-answer": s.submitDecision({ kind: "finale-answer", appeal: p.appeals?.[0] ?? "own-game" }); break;
    case "juror-question": s.submitDecision({ kind: "juror-question", statement: "x" }); break;
    default: s.submitDecision({ kind: (p as any).kind, vote: o(0) }); break;
  }
}

function playToFinish(seed: number): GameSessionAdapter {
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "P", seed });
  for (let i = 0; i < 1500; i++) {
    const adv = s.advanceGame();
    if (adv.pending) resolve(s, adv.pending);
    if (adv.finished) break;
  }
  return s;
}

describe("ENDGAME-4 — the post-season crowning is framed by placement, before hosting the reunion", () => {
  it("the fragment gives distinct conditional framing for WON / RUNNER-UP / spectator, ordered after the hard rule and before hosting", () => {
    const frag = MOMENT_PROMPTS["post-season"]!;
    const hardRuleAt = frag.search(/HARD RULE/i);
    const crownAt = frag.search(/THE CROWNING MOMENT/i);
    const reunionAt = frag.search(/host the reunion/i);
    expect(hardRuleAt).toBeGreaterThanOrEqual(0);
    expect(crownAt).toBeGreaterThan(hardRuleAt); // the restart guard still leads
    expect(reunionAt).toBeGreaterThan(crownAt);  // the crowning framing precedes reunion-hosting
    // Distinct instructions per placement — reads the ALREADY-DECIDED fact, invents nothing.
    expect(frag).toMatch(/if it says they WON.*champion/i);
    expect(frag).toMatch(/RUNNER-UP/);
    expect(frag).toMatch(/watched the crowning from the outside/i);
    expect(frag).toMatch(/THE PLAYER'S OWN SEASON/);
  });

  it("NEUTRALITY: adding the framing changes NO computed value — moment stays post-season, finished/winner are exactly the engine's decision (a winning season)", () => {
    let checked = false;
    for (let seed = 1; seed <= 120 && !checked; seed++) { // bound widened 30 -> 120 on 2026-11-12 (ORW-19 comp-win threat 0.3 -> 0.45: the player wins less often; the loop still stops at the first won season)
      const s = playToFinish(seed);
      const gs = s.getGameState();
      if (!gs.finished) continue;
      const recap = s.seasonRecap();
      if (recap.winner?.id !== gs.player!.id) continue; // need a game the PLAYER won
      checked = true;
      // The state shape is UNCHANGED by this fix — every existing FE/engine consumer of the terminal
      // signal (moment === "post-season" OR finished === true) still sees exactly what it always did.
      expect(gs.moment).toBe("post-season");
      expect(gs.finished).toBe(true);
      expect(recap.winner?.id).toBe(gs.player!.id);
      // The prompt still carries the real facts (anti-confabulation, unaffected by this fix)…
      const prompt = s.getMomentPrompt({ moment: "post-season" }).systemPrompt;
      expect(prompt).toContain("You WON the season.");
      // …and the NEW champion framing rides alongside it, distinctly.
      expect(prompt).toMatch(/champion's moment/i);
      expect(prompt).toMatch(/You won Big Brother/);
    }
    expect(checked, "drove at least one season the player actually won").toBe(true);
  });

  it("NEUTRALITY: a season the player did NOT win still reports the true winner unchanged, with runner-up/spectator framing riding alongside", () => {
    let checked = false;
    for (let seed = 1; seed <= 30 && !checked; seed++) {
      const s = playToFinish(seed);
      const gs = s.getGameState();
      if (!gs.finished) continue;
      const recap = s.seasonRecap();
      if (recap.winner?.id === gs.player!.id) continue; // need a game the player did NOT win
      checked = true;
      expect(gs.moment).toBe("post-season"); // unchanged terminal signal
      expect(gs.finished).toBe(true);
      expect(recap.winner?.id).not.toBe(gs.player!.id); // the real winner is untouched by this fix
      const prompt = s.getMomentPrompt({ moment: "post-season" }).systemPrompt;
      // Whatever the player's real placement, the prompt states it verbatim (never invented)…
      expect(prompt).toContain("THE PLAYER'S OWN SEASON:");
      // …and the crowning framing offers the correct conditional branch for it.
      expect(prompt).toMatch(/RUNNER-UP/);
      expect(prompt).toMatch(/watched the crowning from the outside/i);
    }
    expect(checked, "drove at least one season the player did not win").toBe(true);
  });
});
