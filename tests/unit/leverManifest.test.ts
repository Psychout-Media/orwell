import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_GAME_MASTER_PROMPT, buildSystemPrompt } from "../../src/engine/momentPrompts";
import { PLAYER_AGENT_LEVERS } from "../../src/surfaces/tools/registry";
import type { GameStateView } from "../../src/ports/GameSession";

// Feature 0018 / B21 — the base prompt's lever manifest must name EVERY game-driving player lever,
// enforced so the prompt and the tool registry can never silently drift apart.
describe("lever manifest ↔ registry (0018 drift guard)", () => {
  it("names every game-driving player lever (none missing from the manifest)", () => {
    const missing = PLAYER_AGENT_LEVERS.filter((name) => !BASE_GAME_MASTER_PROMPT.includes(name));
    expect(missing, `levers absent from the base prompt manifest: ${missing.join(", ")}`).toEqual([]);
  });

  it("includes the live-loop and social levers added since the original four", () => {
    for (const lever of ["advanceGame", "submitDecision", "socialInitiatives", "diaryRoom"]) {
      expect(PLAYER_AGENT_LEVERS).toContain(lever);
      expect(BASE_GAME_MASTER_PROMPT).toContain(lever);
    }
  });

  it("makes makeDeal as non-optional as recordInteraction (play-through: deals struck but never tracked)", () => {
    // Live S3: the model struck an explicit handshake deal ("you've got a deal") and called only
    // whereabouts — no makeDeal — so the promise never entered the ledger (deals: []), the panel
    // stayed empty, and nothing could pay off or break. The lever must push makeDeal as hard as
    // recordInteraction: a deal only narrated binds no one.
    expect(BASE_GAME_MASTER_PROMPT).toContain("NOT optional either");
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/MOMENT the player and a houseguest AGREE to terms/);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/binds no one and never comes due/);
  });

  it("states the game decides outcomes and the model only voices them", () => {
    // The machinery is never named to the model (owner ruling 2026-06-18): the prompt says the
    // GAME decides, never "the engine" — and the only literal "engine" left is the prohibition list.
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/game itself decides/i);
    expect(BASE_GAME_MASTER_PROMPT.toLowerCase()).toContain("never invent");
    // the forbidden-words rule is the ONLY place "engine" may still appear (as a banned token).
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/never write the words "engine"/i);
  });

  it("a competition moment directs resolving through the game, no inventing/scores", () => {
    const view = { started: true, week: 1, phase: "hoh-competition", moment: "hoh-competition",
      player: { id: "p", name: "P", archetype: "a", strategyStyle: "s" }, house: [] } as unknown as GameStateView;
    const prompt = buildSystemPrompt("hoh-competition", view).toLowerCase();
    expect(prompt).toContain("runcompetition");
    expect(prompt).toMatch(/no scores|never (choose|reveal)|only the/);
  });

  // P1 (audit 2026-06-10 / B61's missing "finality language"): the v1 §3.9 failure was the
  // narrator voicing unresolved outcomes as settled ("X is going home"). The line must exist.
  it("P1: forbids voicing unresolved outcomes as settled results", () => {
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/FINALITY\./);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/resolved AND revealed/i);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/never announce an unrevealed outcome as settled/i);
  });

  // P4: levers are silent production machinery — the model must never ask permission to pull
  // one, and ask_user is carved AWAY from the game's pending BINDING decisions (the player's own
  // decision card is the single authority there — PROMPT-9/PROMPT2-1: the old wording told the
  // model to use ask_user for pendings in one place while forbidding it in another).
  it("P4: declares levers silent and carves ask_user away from pending binding decisions", () => {
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/SILENT production\s*machinery/i);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/never ask the player's permission/i);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/ask_user is NEVER for the game's pending\s*BINDING decision options/i);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/decision card already presents those/i);
  });

  // LLM-discipline cluster (audit 2026-06-18 hand-off): the model raced past decision cards, invented
  // player knowledge with no pathway, drifted whereabouts, and miscounted the cast. Pinned out.
  it("decision cards are hard stops, incl. the goodbye-message gate (#3)", () => {
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/DECISION CARDS ARE HARD STOPS/);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/GOODBYE-MESSAGE card/i);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/never narrate past it/i);
  });

  it("whereabouts must be read before any room scene, every phase (#4)", () => {
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/Call it BEFORE you/);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/every phase, not just the premiere/i);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/never put one person in two places/i);
  });

  it("the whereabouts shape (present vs nearby) is mapped so rooms are not scrambled (#4)", () => {
    // Play-through bug (2026-06-18, S2 premiere): the model called whereabouts, then narrated a
    // `present` houseguest into a side room, pulled a `nearby` one into the player's room, and
    // invented a third into a room they were not in. The lever must bind the JSON shape, not just
    // forbid "guessing".
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/`present` are the people IN/);
    // 0077 Phase 2 — `nearby` is now SIGHTLINE-scoped (a room the player can SEE INTO), and closed
    // rooms are opaque (their occupants never appear), the stronger privacy contract.
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/is a NAMED room the player can SEE INTO/);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/are OPAQUE: their occupants do NOT appear/);
    // 0077 Phase 2 — the `tracked` layer (earned closed-door knowledge, voiced as a stale-able belief)
    // and the conspicuousness read are part of the contract; anyone in NONE of the lists is off-scene.
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/`tracked` list is exactly that/);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/is elsewhere and NOT visible/i);
    // Finding 9 (2026-07-11 prompt audit): narrated movement is now PERMITTED (a `present`/`nearby`
    // person MAY move between rooms when the narration says so — the barrier + ADR 0009 belts allow it);
    // the anti-scramble contract is enforced by forbidding only the IMPOSSIBLE — a SILENT teleport.
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/never SILENTLY teleport/i);
  });

  it("player knowledge must come through a recorded pathway (#5)", () => {
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/GROUNDED KNOWLEDGE/);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/only KNOWS what a/i);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/surfaceInformationTo/);
  });

  it("the game context surfaces the exact remaining count so the model never does arithmetic (#6)", () => {
    const view = { started: true, week: 1, phase: "social", moment: "social",
      player: { id: "player", name: "P", archetype: "a", strategyStyle: "s", status: "active" },
      house: [
        { id: "npc:1", name: "A", status: "active", archetype: "x", strategyStyle: "y" },
        { id: "npc:2", name: "B", status: "evicted" },
      ] } as unknown as GameStateView;
    const prompt = buildSystemPrompt("social", view);
    expect(prompt).toMatch(/Houseguests remaining: 2 of 3/); // player + 1 active NPC of 3 total
    expect(prompt).toMatch(/do your own arithmetic/i);
  });

  // Eviction fidelity (audit 2026-06-18): a play-through caught the model inventing a flattering
  // vote tally ("nine to one, your name only came up once") that did NOT match the engine's actual
  // staged ballots, and naming a real-world host ("Julie Chen"). Both are pinned out.
  it("the eviction moment drives the staged secret-ballot reveal and forbids an invented tally", () => {
    const view = { started: true, week: 1, phase: "eviction", moment: "eviction", eviction: { votesRevealed: 0 }, // ORW-249: the reveal script rides once the engine has staged the eviction (commit before voice)
      player: { id: "p", name: "P", archetype: "a", strategyStyle: "s" }, house: [] } as unknown as GameStateView;
    const prompt = buildSystemPrompt("eviction", view);
    expect(prompt).toMatch(/secret ballot/i);
    expect(prompt).toMatch(/staged/i);
    expect(prompt).toMatch(/never invent the tally/i);
    expect(prompt).toMatch(/never WHO cast it/i); // anonymity preserved
  });

  it("the base prompt forbids naming a real-world host or person (no Julie Chen)", () => {
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/never name a real-world host/i);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/Julie Chen/); // the exact failure, pinned as the example
  });

  // Cross-week confabulation (audit 2026-06-18): the model jumped from a goodbye straight to "RILEY
  // CORTEZ — you are the new Head of Household" with the engine still at week-1 eviction — inventing
  // the PLAYER winning a comp the game never ran (the worst break). A sharp transition rule is pinned.
  it("forbids narrating a new week's HOH before advancing into it", () => {
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/A NEW WEEK DOES NOT EXIST until you advanceGame into it/);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/you are the new HOH/);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/it may well be someone else/i);
  });

  // Anti-leak (audit 2026-06-18, owner rulings): the model is steeped in "the engine" all day and
  // echoes it to the player ("the engine has everything…"), and it recites archetype labels as a
  // cast scouting report ("X is the mastermind"). Both are scrubbed at the source.
  it("never names 'the engine' as prose, and forbids announcing archetype/strategy labels", () => {
    // The ONLY surviving "engine" is the banned-words rule itself (in quotes); no "the engine" prose.
    expect(/\bthe engine\b/i.test(BASE_GAME_MASTER_PROMPT)).toBe(false);
    // Archetype/strategy are a PRIVATE voice cue — never announced to the player.
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/houseguest's archetype, strategy, or threat level/i);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/discover/i);
  });

  // P6: runCompetition PREVIEWS the loop's already-decided winner; only advanceGame commits.
  // The old wording ("resolve a competition") let the model announce a never-committed winner.
  it("P6: the runCompetition bullet states preview semantics, with advanceGame the sole resolver", () => {
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/runCompetition — PREVIEW/);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/already decided/i);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/commits only when advanceGame resolves/i);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/never choose the winner yourself/i);
  });

  // P10: the submitDecision bullet must not enumerate a stale SUBSET of decision kinds (it
  // once named 4 of 11). The pending decision names its own kind; the manifest stays generic.
  // Drift-pinned against the real enum: the kind union on PendingDecisionView in the port.
  it("P10: the submitDecision bullet enumerates either no decision kinds or all of them", () => {
    const port = readFileSync(join(process.cwd(), "src/ports/GameSession.ts"), "utf-8");
    const m = port.match(/PendingDecisionView \{\s*\n\s*kind:([^;]+);/);
    expect(m, "PendingDecisionView kind union not found — update the P10 drift pin").toBeTruthy();
    const kinds = [...m![1]!.matchAll(/"([a-z-]+)"/g)].map((k) => k[1]!);
    expect(kinds.length).toBeGreaterThanOrEqual(8); // sanity: the real union, not a fragment

    const start = BASE_GAME_MASTER_PROMPT.indexOf("• submitDecision");
    const end = BASE_GAME_MASTER_PROMPT.indexOf("•", start + 1);
    const bullet = BASE_GAME_MASTER_PROMPT.slice(start, end === -1 ? undefined : end).toLowerCase();
    const named = kinds.filter((k) => bullet.includes(k.replace(/-/g, " ")) || bullet.includes(k));
    expect(
      named.length === 0 || named.length === kinds.length,
      `submitDecision names a stale subset of decision kinds: ${named.join(", ")} (of ${kinds.length})`,
    ).toBe(true);
    // …and it must still say the pending decision carries its kind + legal options.
    expect(bullet).toMatch(/kind/);
    expect(bullet).toMatch(/legal options/);
  });

  // P11: the prompt hands the model facts to voice, never example lines to recite (ADR 0003).
  it("P11: the cut example lines stay cut", () => {
    expect(BASE_GAME_MASTER_PROMPT).not.toContain("saw the trailer");
  });
});
