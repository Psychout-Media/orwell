import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView } from "../../src/ports/GameSession";

/**
 * C8-04 (round-8 playtest) — the live ceremony state (HOH / nominees / veto holder) must ride in
 * the model's persistent GAME CONTEXT, not only on the lightweight gameStatus(). The narrator was
 * inventing ceremonies because the per-turn context carried week/phase/roster but NO HOH or
 * nominee line — while the nominations prompt told it the marks were "already in your GAME CONTEXT".
 * Roles only — no fixture names asserted.
 */
function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "throw" }); // throw → an NPC tends to take HOH
  else if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.options[0]) s.submitDecision({ kind: p.kind, vote: p.options[0].id, replacement: p.options[0].id } as never);
}

/** Advance until the week's nominations are on the board. */
function driveToNominations(s: GameSessionAdapter) {
  for (let i = 0; i < 400; i++) {
    const v = s.advanceGame();
    if (v.pending) resolve(s, v.pending);
    if (s.getGameState().ceremony.nominees.length >= 2) break;
  }
  return s.getGameState();
}

/** Advance until the veto field (the drawn six) is on the board. */
function driveToVetoField(s: GameSessionAdapter) {
  for (let i = 0; i < 400; i++) {
    const v = s.advanceGame();
    if (v.pending) resolve(s, v.pending);
    if (s.getGameState().ceremony.veto.players.length > 0) break;
  }
  return s.getGameState();
}

describe("C8-04 — the ceremony state is in the model's persistent context", () => {
  it("getGameState projects the live HOH, nominees, and veto (the gameStatus facts)", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", archetype: "social", seed: 81000 });
    const gs = driveToNominations(s);

    expect(gs.ceremony.hoh).not.toBeNull();          // an HOH is crowned
    expect(gs.ceremony.nominees.length).toBe(2);     // two on the block
    // The view's ceremony matches the lightweight status projection exactly (one source of truth).
    const st = s.gameStatus();
    expect(gs.ceremony.hoh!.id).toBe(st.hoh!.id);
    expect(gs.ceremony.nominees.map((n) => n.id).sort()).toEqual(st.nominees.map((n) => n.id).sort());
  });

  it("the moment prompt renders the engine's HOH and nominees so the model can't invent them", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", archetype: "social", seed: 81000 });
    const gs = driveToNominations(s);

    const prompt = s.getMomentPrompt({}).systemPrompt;
    expect(prompt).toContain("THIS WEEK'S CEREMONY");
    expect(prompt).toContain("ON THE BLOCK");
    expect(prompt).toContain(gs.ceremony.hoh!.name);                 // the real HOH, by name
    for (const nom of gs.ceremony.nominees) expect(prompt).toContain(nom.name); // both real nominees
  });

  it("the veto FIELD (the drawn six) rides in the view and the prompt (R9-AGENCY-1)", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", archetype: "social", seed: 81000 });
    const gs = driveToVetoField(s);

    // The drawn field is the engine truth (the same six gameStatus() exposes), one source.
    const field = gs.ceremony.veto.players;
    expect(field.length).toBeGreaterThan(0);
    expect(field.map((p) => p.id).sort()).toEqual(s.gameStatus().veto.players.map((p) => p.id).sort());

    // The prompt names the drawn field so the model never tells a drawn houseguest they aren't playing.
    const prompt = s.getMomentPrompt({}).systemPrompt;
    expect(prompt).toContain("Playing the veto:");
    for (const p of field) expect(prompt).toContain(p.name); // every drawn player, by name
  });

  it("ORW-923/925: everyone the chip draw did not pick is named as watching the veto, never a player (Fable week 1: 'all sixteen of you', non-players 'out early')", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", archetype: "social", seed: 81000 });
    const gs = driveToVetoField(s);
    const field = new Set(gs.ceremony.veto.players.map((p) => p.id));
    const prompt = s.getMomentPrompt({}).systemPrompt;
    const line = prompt.split("\n").find((l) => l.includes("Watching the veto")) ?? "";
    expect(line, "the sidelines are named").not.toBe("");
    const watching = gs.house.filter((h) => !field.has(h.id));
    expect(watching.length, "the field is the six, not the house").toBeGreaterThan(0);
    const named = line.slice(line.indexOf("): ") + 3).split(", ");
    expect(named.sort(), "exactly the houseguests outside the six").toEqual(watching.map((h) => h.name).sort());
    for (const p of gs.ceremony.veto.players) expect(named, "a drawn player is not on the sidelines").not.toContain(p.name);
  });

  it("renders WHERE YOU ARE from the engine whereabouts so the model never invents positions (L21/L24)", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", seed: 81000 });
    const wa = s.getGameState().whereabouts;
    expect(wa).not.toBeNull(); // presence is seeded at premiere — everyone is placed, no "arrivals"
    const prompt = s.getMomentPrompt({}).systemPrompt;
    expect(prompt).toContain("WHERE YOU ARE");
    expect(prompt).toContain(`the ${wa!.room.replace(/-/g, " ")}`); // the player's REAL room
    for (const c of wa!.present) expect(prompt).toContain(c.name); // everyone actually with them, by name
  });

  // ── L-LOC (location continuity) — the narrator's room occupancy must match the player-visible
  //    whereabouts projection (the SAME one the FE "The House" panel renders), current room AND every
  //    observable adjacent room. The live-playtest bug: the panel placed houseguests in a room the
  //    narrator described as empty (and bent it to the player's wish for "a room to themselves").
  //    Helper: slice out the "WHERE YOU ARE" block so the roster (which names the whole cast) can't
  //    falsely satisfy a per-room occupancy assertion.
  const whereBlock = (prompt: string): string => {
    const start = prompt.indexOf("- WHERE YOU ARE");
    expect(start).toBeGreaterThanOrEqual(0);
    // The block runs until the next top-level "- " context line after it.
    const rest = prompt.slice(start + 1);
    const end = rest.indexOf("\n- ");
    return end >= 0 ? prompt.slice(start, start + 1 + end) : prompt.slice(start);
  };

  it("the WHERE YOU ARE block names EXACTLY the occupants the whereabouts projection reports for the player's room and every observable adjacent room", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", seed: 81000 });
    const wa = s.getGameState().whereabouts!;
    expect(wa).not.toBeNull();
    const block = whereBlock(s.getMomentPrompt({}).systemPrompt);

    // Current room: everyone actually with the player appears.
    for (const c of wa.present) expect(block).toContain(c.name);
    // EVERY adjacent room is rendered (occupied AND empty), labelled by its room name, with its exact
    // occupancy — so a room the player "checks" has an authoritative answer and never gets improvised.
    for (const room of wa.nearby) {
      expect(block).toContain(room.room.replace(/-/g, " "));
      for (const p of room.present) expect(block).toContain(p.name);
    }
  });

  it("no NON-observable houseguest leaks into the WHERE YOU ARE block (Vault Wall — fog of war is real)", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", seed: 81000 });
    // 0111: close the premiere champagne circle — while gathered the whole house is co-present in the
    // living room (no fog of war to test); this test needs the normal partial-house whereabouts.
    s.advanceGame();
    const gs = s.getGameState();
    const wa = gs.whereabouts!;
    expect(wa).not.toBeNull();
    const block = whereBlock(s.getMomentPrompt({}).systemPrompt);

    // The names the player CAN legitimately see/hear: their own room + every adjacent room.
    const observable = new Set<string>([
      ...wa.present.map((p) => p.name),
      ...wa.nearby.flatMap((n) => n.present.map((p) => p.name)),
    ]);
    // Every OTHER active houseguest is somewhere non-adjacent — none of them may appear in the block.
    const elsewhere = gs.house
      .filter((h) => h.status === "active" && !observable.has(h.name))
      .map((h) => h.name);
    // There must be at least one houseguest the player cannot see (the house is bigger than one
    // room + its neighbours) — otherwise the sentinel proves nothing this seed.
    expect(elsewhere.length).toBeGreaterThan(0);
    for (const name of elsewhere) expect(block).not.toContain(name);
  });

  it("pre-game and pre-ceremony carry an empty ceremony (no invented marks)", () => {
    const s = new GameSessionAdapter();
    expect(s.getGameState().ceremony).toEqual({ hoh: null, nominees: [], veto: { holder: null, used: false, players: [] } });
    s.createCharacter({ playerName: "P", seed: 7 });
    // Right after creation (premiere), no HOH/nominees exist yet — the block stays empty, not invented.
    const gs = s.getGameState();
    expect(gs.ceremony.nominees).toEqual([]);
    expect(gs.ceremony.veto.players).toEqual([]);
    expect(s.getMomentPrompt({}).systemPrompt).not.toContain("THIS WEEK'S CEREMONY");
  });
});
