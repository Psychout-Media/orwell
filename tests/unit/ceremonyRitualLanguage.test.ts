import { describe, it, expect } from "vitest";
import { MOMENT_PROMPTS } from "../../src/engine/momentPrompts";

/**
 * BB-nerd audit (2026-07-03, lanes bb-nerd.md/microcopy.md/endgame.md) — the ceremonies read
 * mechanically correct but lack the show's own ritual language: the nomination ceremony's
 * "I've nominated you, and you, for eviction… this is purely strategic," the veto ceremony's
 * "do you wish to use the Power of Veto?" / "this veto meeting is adjourned," the eviction
 * reveal's "by a vote of…"/goodbye countdown, and the finale's crowning cadence.
 *
 * This is PROMPT-TEXT ONLY (mandate/ADR 0003 — facts to voice, never a script to recite): the
 * fragments below instruct the model to hit the show's cadence using the GAME's own names/tallies,
 * never a hard-coded houseguest. Pinning the cue PHRASES here (not full sentences) so the prose can
 * still be edited/refined without becoming a brittle golden-string test. Roles only — no fixture
 * names, and no legacy Game Bible names appear anywhere below.
 */
describe("ceremony moment-prompt fragments carry the show's ritual-language cues (BB-nerd audit)", () => {
  it("nominations: cues the key ceremony + the canonical nomination phrasing + the strategic-not-personal beat", () => {
    const p = MOMENT_PROMPTS.nominations;
    expect(p).toMatch(/turns a key for each safe houseguest|the key turns/i);
    expect(p).toContain("I've nominated you, and you, for eviction");
    // ORW-314: the HOH's reason is the one the game states for THIS decider (their block says it aloud); the narrator never invents a "purely strategic, nothing personal" of its own.
    expect(p).toMatch(/reason the game gives this HOH to say aloud/i);
    expect(p).toMatch(/said aloud/);
    expect(p).toMatch(/no other reason of your own/i);
    expect(p).not.toMatch(/however brief|nothing personal|purely strategic|soften the/i);
    // Framing, not a script: the model is told to use its OWN words / the game's real names.
    expect(p).toMatch(/own words/i);
  });

  it("veto-draw: still cues the chip-draw ritual (ORW-281 slice 1 moved it here from veto-competition: the draw is its own ceremony beat)", () => {
    const p = MOMENT_PROMPTS["veto-draw"];
    expect(p).toMatch(/RITUAL BEAT/i);
    expect(p).toMatch(/Houseguest's Choice/);
  });

  it("veto-ceremony: cues the veto-meeting ritual grammar (the show's thinnest ceremony, BB-18)", () => {
    const p = MOMENT_PROMPTS["veto-ceremony"];
    expect(p).toMatch(/do you wish to use the Power of Veto\?/i);
    expect(p).toMatch(/I have decided to use the Power of Veto/i);
    expect(p).toMatch(/I have decided NOT to use the Power of Veto/i);
    expect(p).toMatch(/this veto meeting is adjourned/i);
    // The replacement is grounded in engine truth, never invented.
    expect(p).toMatch(/ONLY from the game's recorded pick|never invent or guess/i);
  });

  // Finding 5 (2026-07-11 prompt audit): the `eviction-result` beat carries NO tally, and the fragment
  // elsewhere bans inventing a running count — so the cadence must name the evictee PLAINLY and never
  // DEMAND a "by a vote of <count>" the model does not hold; a count rides ONLY when the read-out
  // ballots add up to it (consistent with the anti-fabrication rules later in the same fragment).
  it("eviction: cues the plain-name crowning cadence (no fabricated tally) + the goodbye countdown", () => {
    const p = MOMENT_PROMPTS.eviction;
    expect(p).toMatch(/WITHOUT inventing a vote count|deliver the eviction with NO number/i);
    expect(p).toMatch(/you are evicted from the Big Brother house/i);
    expect(p).toMatch(/seconds to say your goodbyes/i);
    // A numeric split may be voiced ONLY when the anonymized ballots add up to it, never invented.
    expect(p).toMatch(/ballots add up to EXACTLY that split/i);
  });

  it("jury-finale: cues the crowning cadence, grounded in the game's real tally", () => {
    const p = MOMENT_PROMPTS["jury-finale"];
    expect(p).toMatch(/by a vote of/i);
    expect(p).toMatch(/you are the winner of Big Brother/i);
    expect(p).toMatch(/never a number you have not tallied yourself/i);
  });

  it("no ceremony fragment hard-codes a specific houseguest name — only role/placeholder language", () => {
    const banned = [
      "Jada", "Marin", "Diego", "Salinas", "Shea", "O'Malley", "Klaus", "Maeve",
      "Lorenzo", "Mila", "Kowalski", "Gina", "Ricci", "Tanner", "Huff", "Regina", "Manning",
      "Caleb", "Myra", "Trujillo", "Irene", "Shaffer",
    ];
    for (const key of ["nominations", "veto-competition", "veto-ceremony", "eviction", "jury-finale"]) {
      const p = MOMENT_PROMPTS[key];
      for (const name of banned) {
        expect(p, `${key} must not hard-code the name "${name}"`).not.toContain(name);
      }
    }
  });
});
