import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { renderGameContext, BASE_GAME_MASTER_PROMPT } from "../../src/engine/momentPrompts";

/**
 * B61 — cast voices: the narrator receives each ACTIVE houseguest's curated PUBLIC persona
 * facets (the voice anchor), and NOTHING hidden. Roles only — no fixture names.
 */
describe("cast voices (B61)", () => {
  const start = (seed = 11) => {
    const s = new GameSessionAdapter();
    return { s, view: s.createCharacter({ playerName: "The Player", seed }) };
  };

  it("house cards carry the curated public facets and NOTHING hidden", () => {
    const { view } = start();
    expect(view.house.length).toBeGreaterThan(0);
    for (const card of view.house) {
      expect(card.archetype).toBeTruthy();
      expect(card.strategyStyle).toBeTruthy();
      expect(card.background).toBeTruthy();
      expect(typeof card.age).toBe("number");
      // L29: the card's physical descriptor is the STRUCTURED facet (the single source of truth the
      // portrait + narration share); the redundant prose `appearance` no longer rides on a 0058 card.
      expect(card.physicalCharacteristics).toBeTruthy();
      expect(card.presentation).toBeTruthy();
      // the Vault stays out: no stats, soul, relationship, or hidden-element keys
      const keys = Object.keys(card);
      for (const forbidden of ["stats", "physical", "mental", "social", "soul",
        "emotionalState", "hiddenElements", "trust", "affinity", "threat"]) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });

  it("facets are seed-stable — the voice anchor cannot drift between reads", () => {
    const { s } = start(23);
    const sig = (h: { archetype?: string; background?: string; appearance?: string; physicalCharacteristics?: unknown }) =>
      `${h.archetype}|${h.background}|${JSON.stringify(h.physicalCharacteristics ?? h.appearance)}`;
    const a = s.getGameState().house.map(sig);
    const b = s.getGameState().house.map(sig);
    expect(a).toEqual(b);
  });

  it("the game context voices ACTIVE houseguests by their public vibe", () => {
    const { view } = start();
    const ctx = renderGameContext(view);
    const first = view.house[0]!;
    // F3 (#1016): the line no longer LEADS with the archetype — it leads with the observable facets and
    // demotes archetype/strategyStyle into a fenced private cue (asserted by the dedicated suite below).
    expect(ctx).toContain(`${first.name}`);
    expect(ctx).toContain(`plays ${first.strategyStyle}`);
    expect(ctx).toContain(first.background!);
    // never a stat or a number that reads as one beyond age. ORW-508: a real job may contain the word ("physical
    // therapist"), so the physical stat is matched as its label, like the other two stats
    expect(ctx).not.toMatch(/physical: |mental: |social: |trust|threat|hiddenElement/i);
    expect(ctx).not.toMatch(/\b(physical|mental|social)\s*[:=]?\s*\d/i);
  });

  it("an evicted houseguest's seat shows (and the departed lose the vibe line)", () => {
    const { s } = start(5);
    // drive evictions until someone is out (NPC beats auto-resolve; answer player pendings legally)
    for (let i = 0; i < 200; i++) {
      const v = s.advanceGame();
      if (v.pending) {
        const p = v.pending;
        const opt = (p.options ?? [])[0];
        if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options![0]!.id, p.options![1]!.id] });
        else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
        else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
        else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
        else if (p.kind === "finale-answer") s.submitDecision({ kind: "finale-answer", appeal: "own-game" });
        else if (opt) s.submitDecision({ kind: p.kind, vote: opt.id, replacement: opt.id } as never);
      }
      const out = s.getGameState().house.filter((h) => h.status !== "active");
      if (out.length > 0) {
        const ctx = renderGameContext(s.getGameState());
        for (const gone of out) expect(ctx).toContain(`${gone.name} (${gone.status})`);
        return;
      }
    }
    throw new Error("no eviction occurred within the drive budget");
  });

  it("NPC seats distinguish jury from pre-jury eviction (16-cast: first 5 out are pre-jury)", () => {
    const { s } = start(9);
    for (let i = 0; i < 600; i++) {
      const v = s.advanceGame();
      if (v.pending) {
        const p = v.pending;
        const opt = (p.options ?? [])[0];
        if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options![0]!.id, p.options![1]!.id] });
        else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
        else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
        else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
        else if (p.kind === "finale-answer") s.submitDecision({ kind: "finale-answer", appeal: "own-game" });
        else if (opt) s.submitDecision({ kind: p.kind, vote: opt.id, replacement: opt.id } as never);
      }
      const out = s.getGameState().house.filter((h) => h.status !== "active");
      if (out.length >= 7) {
        const seats = s.getGameState().house.filter((h) => h.status !== "active").map((h) => h.status);
        expect(seats.filter((x) => x === "evicted").length).toBeGreaterThan(0); // pre-jury exits
        expect(seats.filter((x) => x === "jury").length).toBeGreaterThan(0);    // jury seats marked
        return;
      }
      if (v.winner) break;
    }
    throw new Error("season did not reach 7 evictions within the drive budget");
  });

  it("the base prompt carries the voice-consistency directive", () => {
    expect(BASE_GAME_MASTER_PROMPT).toContain("THE HOUSE.");
    expect(BASE_GAME_MASTER_PROMPT).toContain("CONSISTENT");
    expect(BASE_GAME_MASTER_PROMPT).toContain("Never invent biography");
  });
});
