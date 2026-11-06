import { describe, it, expect } from "vitest";
import { BASE_GAME_MASTER_PROMPT, MOMENT_PROMPTS, buildSystemPrompt } from "../../src/engine/momentPrompts";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * #1391 — the narrator-prompt token BUDGET regression gate.
 *
 * The 2026-07-11 narrator system-prompt audit (finding 12, P2) measured the fixed prompt at ≈17–20k
 * tokens/turn and found that per-rule compliance DECAYS with rulebook size — every added rule dilutes
 * the 60+ MUST/NEVER rules, worst on Flash-tier models. This gate FREEZES the post-dedup size so a
 * future edit can't SILENTLY re-bloat the fixed prompt: a new rule must either fit the (small)
 * headroom or force a CONSCIOUS re-baseline of the budget here, with a note on what earned the growth.
 *
 * This is a SIZE gate only — it does NOT pin rule CONTENT (that is owned by leverManifest.test.ts,
 * momentOrchestration.test.ts, momentFramingFixes.test.ts, …, which assert every load-bearing phrase
 * is present). The two gates are complementary: content says "the rule must exist"; this says "the
 * rulebook must stay tight".
 *
 * Budgets are in CHARACTERS. Tokens ≈ chars/4 (the ratio the audit itself used: BASE 43,406 chars ≈
 * 10.9k tok), so each char budget carries an approximate token budget in its comment. Every budget
 * sits only SLIGHTLY above the current measured size (~2% headroom) — tight enough that real bloat
 * trips it, loose enough that a trivial reword does not.
 *
 * TO RE-BASELINE (when a genuinely-needed addition lands): run
 *   npx vitest run tests/unit/promptBudget.test.ts
 * read the actual vs. expected in the failure, and bump the specific budget below — in the SAME PR,
 * with a one-line note on what the new tokens buy. Never widen a budget to sneak past this gate.
 *
 * Roles only; a FIXED seed keeps the assembled sizes deterministic (the cast facets are seed-derived).
 */

// The pre-game (casting) view — no cast yet, so it is seed-independent and fully deterministic.
const PRE_GAME_VIEW = new GameSessionAdapter().getGameState();

// A live, fully-cast view — the full 16-houseguest roster (the dominant term in every in-game prompt)
// is generated from this fixed seed, so the assembled sizes below are deterministic.
const LIVE_VIEW = (() => {
  const g = new GameSessionAdapter();
  g.createCharacter({ playerName: "The Player", seed: 7 });
  return g.getGameState();
})();

describe("#1391 — narrator-prompt token budget (anti-re-bloat gate)", () => {
  // ── The FIXED instruction budget: BASE is injected on EVERY turn, so it is the single biggest
  //    fixed cost and the truest target of finding 12. Measured post-dedup: 44,321 chars (~11.1k tok).
  // 2026-07-16 re-baseline: the owner-mandated prompt-discipline batch (QUESTION DISCIPLINE — the
  // headline "hold for a direct player-facing question" hard stop — + its PACING cross-reference, the
  // NO OUTSIDE CONTACT world-texture line, and the SPEAKER TAGS MAY→ALWAYS upgrade) grew BASE to
  // 46,056 chars. Consciously bumped, not widened to sneak past — this is exactly the class of addition
  // the gate exists to make visible.
  it("BASE_GAME_MASTER_PROMPT stays under its fixed-instruction budget", () => {
    const BUDGET = 47_000; // ~11.75k tok — ≈2.0% over the 46,056-char post-2026-07-16 size
    expect(BASE_GAME_MASTER_PROMPT.length).toBeLessThanOrEqual(BUDGET);
  });

  // ── Per-moment FRAGMENT budgets (the two large ones). A fragment is fixed instruction text for its
  //    beat; the casting + premiere fragments are by far the biggest and the likeliest to creep.
  it("the casting-interview fragment stays under its budget", () => {
    const BUDGET = 9_600; // ~2.4k tok — over the 9,236-char size
    expect(MOMENT_PROMPTS["character-creation"]!.length).toBeLessThanOrEqual(BUDGET);
  });

  it("the premiere fragment stays under its budget", () => {
    const BUDGET = 7_000; // ~1.75k tok — over the 6,795-char size
    expect(MOMENT_PROMPTS["premiere"]!.length).toBeLessThanOrEqual(BUDGET);
  });

  // ── The ASSEMBLED prompt for the three moments the issue names (character-creation, premiere,
  //    in-game). This is BASE + the moment fragment + the Vault-free GAME CONTEXT — the actual system
  //    message the front-end injects (minus the optional per-turn add-ons: producerVoice / storyFacts
  //    / worldContext / surfacedFacts, which vary by turn). The roster DATA dominates the in-game
  //    sizes, so a bump here can also mean a legitimately richer cast — re-baseline consciously.
  it("the assembled character-creation prompt stays under its budget", () => {
    // 2026-07-16 re-baseline (same BASE growth as above): now 55,990 chars (pre-game, no cast).
    const BUDGET = 57_100; // ~14.3k tok — ≈2.0% over the 55,990-char post-2026-07-16 size
    expect(buildSystemPrompt("character-creation", PRE_GAME_VIEW).length).toBeLessThanOrEqual(BUDGET);
  });

  it("the assembled premiere prompt stays under its budget", () => {
    // 2026-07-20 re-baseline (feature 0111 — THE CHAMPAGNE CIRCLE): the premiere now GATHERS the whole
    // house for the opening toast, so the assembled premiere prompt carries the gathered-circle context
    // block (whereabouts pins the house; the two-step close→HOH framing) — 72,853 chars. Consciously
    // bumped, not widened to sneak past: the new tokens buy the pin + close-edge framing that stops the
    // toast firing off-screen (the reported bug).
    const BUDGET = 76_400; // ~19.1k tok — ≈2.1% over the 74,840-char post-ORW-194 size (re-baselined: the toast now lists each of the 15 houseguests' public job + hometown and asks for a woven-in first impression - Ryne's request, 2026-11-06)
    expect(buildSystemPrompt("premiere", LIVE_VIEW).length).toBeLessThanOrEqual(BUDGET);
  });

  it("the assembled in-game (social) prompt stays under its budget", () => {
    // 2026-07-16 re-baseline (same BASE growth as above): now 66,605 chars (full 16-cast roster).
    const BUDGET = 70_400; // ~17.6k tok — ≈2.1% over the 68,976-char post-ORW-194 size (same re-baseline: the premiere cards in the live view carry the public job + hometown)
    expect(buildSystemPrompt("social", LIVE_VIEW).length).toBeLessThanOrEqual(BUDGET);
  });

  // ── A floor guard: catch an ACCIDENTAL mass deletion of BASE (a botched dedup that silently drops
  //    load-bearing rules) — the content pins would catch a NAMED rule, but a big unnamed cut would
  //    slip past them while this trips. Keep it well below the current size.
  it("BASE_GAME_MASTER_PROMPT has not collapsed (guards a botched over-trim)", () => {
    const FLOOR = 40_000; // ~10k tok — a real over-deletion drops below this
    expect(BASE_GAME_MASTER_PROMPT.length).toBeGreaterThanOrEqual(FLOOR);
  });
});
