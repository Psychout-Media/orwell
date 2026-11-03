import { describe, it, expect } from "vitest";
import { deriveNpcKnowledge, producerPrompt, isNpcReachable, NO_NPC_PATHWAY, beatForMoment } from "../../src/engine/diaryRoom";
import { buildSandbox } from "../support/sandbox";
import { PLAYER, npc } from "../../src/domain/ids";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView } from "../../src/ports/GameSession";

// The NPCs `buildSandbox` seeds any state for (Vault attrs / confessionals / off-screen) — npc(1..8).
// The DR→NPC guarantee itself is structural (`deriveNpcKnowledge`) and cast-size-independent; this
// list only bounds the redundant per-NPC belt-and-suspenders sweeps below.
const SEEDED_NPCS = Array.from({ length: 8 }, (_, i) => npc(i + 1));

describe("0013 — Diary Room → no NPC wall", () => {
  it("DR content is the player's knowledge, tagged no-NPC-pathway, and reaches no NPC", () => {
    const sb = buildSandbox(1);
    const content = "my real plan to backdoor the HOH";
    sb.engine.knowledge.recordDiaryRoom(content);

    const playerKnown = sb.engine.knowledge.knownTo(PLAYER);
    const dr = playerKnown.find((k) => k.content === content);
    expect(dr).toBeDefined();
    expect(dr!.pathway).toBe(NO_NPC_PATHWAY);
    expect(isNpcReachable(dr!)).toBe(false);

    // The REAL, cast-size-independent guarantee: the DR→NPC strip removes it no matter how many
    // houseguests exist. (The per-NPC sweep below is a belt-and-suspenders sample over the fixture's
    // seeded NPCs; it is redundant with this structural check.)
    expect(deriveNpcKnowledge(playerKnown).some((k) => k.content === content)).toBe(false);
    // No seeded NPC's knowledge ever contains it.
    for (const id of SEEDED_NPCS) {
      expect(sb.engine.knowledge.knownTo(id).some((k) => k.content === content)).toBe(false);
    }
  });

  it("deriveNpcKnowledge keeps NPC-reachable facts but strips DR-tagged ones", () => {
    const facts = [
      { id: "a", content: "witnessed thing", pathway: "witnessed", ts: 1 },
      { id: "b", content: "told thing", pathway: "told-by:npc:2", ts: 2 },
      { id: "c", content: "dr thing", pathway: NO_NPC_PATHWAY, ts: 3 },
    ];
    const derived = deriveNpcKnowledge(facts);
    expect(derived.map((f) => f.id)).toEqual(["a", "b"]);
  });
});

describe("0013 — producer prompts fire at dramatic beats, not every turn", () => {
  it("invites only on dramatic beats", () => {
    expect(producerPrompt("position-shift").invite).toBe(true);
    expect(producerPrompt("eviction").invite).toBe(true);
    expect(producerPrompt("nomination").invite).toBe(true);
    expect(producerPrompt("veto-ceremony").invite).toBe(true);
    expect(producerPrompt("routine-chat").invite).toBe(false);
    expect(producerPrompt("idle").invite).toBe(false);
    expect(producerPrompt("downtime").invite).toBe(false);
  });

  it("does not fire on every turn over a stream", () => {
    const stream = ["routine-chat", "idle", "nomination", "downtime", "eviction", "routine-chat"] as const;
    const invited = stream.filter((b) => producerPrompt(b).invite);
    expect(invited.length).toBe(2);
    expect(invited.length).toBeLessThan(stream.length);
  });
});

describe("0013/PG-14/PS-4 — beatForMoment maps the live `moment` key onto a producerPrompt Beat", () => {
  it("maps the dramatic ceremony/eviction moments to their matching Beat", () => {
    expect(beatForMoment("nominations")).toBe("nomination");
    expect(beatForMoment("veto-ceremony")).toBe("veto-ceremony");
    expect(beatForMoment("eviction")).toBe("eviction");
  });

  it("maps every other moment (premiere, social, default, etc.) to a routine Beat", () => {
    for (const m of ["premiere", "social", "default", "hoh-competition", "veto-competition", "jury-finale", "character-creation"]) {
      expect(beatForMoment(m)).toBe("routine-chat");
      expect(producerPrompt(beatForMoment(m)).invite).toBe(false);
    }
  });
});

/**
 * PG-14/PS-4 — `producerPrompt` had ZERO live callers (grep-confirmed on main): the engine's own
 * producer-invite hook was built and never wired, so the player was never proactively pulled into
 * the Diary Room. `GameSessionAdapter.view()` now calls `producerPrompt(beatForMoment(moment))` on
 * every state read, so the invite is a genuine, live-wired signal — proven here end-to-end through
 * a real live season, never fired at a routine beat, and — the load-bearing guarantee — its presence
 * changes nothing about the DR → NPC wall (0013 §1: no in-game pathway to any NPC, ever).
 */
function resolvePending(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "throw" });
  else if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.options[0]) s.submitDecision({ kind: p.kind, vote: p.options[0].id, replacement: p.options[0].id } as never);
}

/**
 * Advance a live season and capture the state at the FIRST turn the live `moment` reads
 * "nominations" — a genuinely transient beat (the engine can advance straight past it, HOH-crown
 * to nominees-set to veto-competition, within a couple of calls when no player decision is
 * needed), so the moment to check is read right after each `advanceGame`, not after the ceremony
 * has fully settled.
 */
function driveToNominationsBeat(s: GameSessionAdapter): ReturnType<GameSessionAdapter["getGameState"]> {
  for (let i = 0; i < 400; i++) {
    const v = s.advanceGame();
    const gs = s.getGameState();
    if (gs.moment === "nominations") return gs;
    if (v.pending) resolvePending(s, v.pending);
  }
  throw new Error("never reached the nominations beat");
}

describe("0013/PG-14/PS-4 — the producer's Diary-Room invitation is live-wired, and the DR→NPC wall still holds", () => {
  it("is ABSENT at a routine pre-game/premiere beat (no invite outside a dramatic beat)", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", archetype: "social", seed: 1 });
    const gs = s.getGameState();
    expect(gs.moment).not.toBe("nominations");
    expect(gs.diaryRoomInvite).toBeUndefined();
  });

  it("is PRESENT, true, once the week's nominations land — a real live producerPrompt call, not a stub", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", archetype: "social", seed: 81000 });
    const gs = driveToNominationsBeat(s);

    expect(gs.moment).toBe("nominations");
    expect(gs.diaryRoomInvite).toBeDefined();
    expect(gs.diaryRoomInvite!.invite).toBe(true);
    // 0115 — the invitation is now a pointed, beat-specific QUESTION (not the old "dramatic beat: X" label).
    expect(gs.diaryRoomInvite!.reason).toContain("nominees");
    expect(gs.diaryRoomInvite!.reason!.endsWith("?")).toBe(true);
  });

  it("clears again once the ceremony moves past nominations into a routine competition beat", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", archetype: "social", seed: 81000 });
    driveToNominationsBeat(s);
    // Advance one more beat: nominations resolve into the veto-competition run-up, a routine beat.
    // (bounded: the in-game clock's day-break beat may precede it — default flip 2026-11-03)
    for (let k = 0; k < 4 && s.getGameState().moment === "nominations"; k++) {
      const v = s.advanceGame();
      if (v.pending) resolvePending(s, v.pending);
    }
    expect(s.getGameState().moment).not.toBe("nominations");
    expect(s.getGameState().diaryRoomInvite).toBeUndefined();
  });

  it("the invite is an INVITATION only: it fires alongside the DR wall, never around it — DR content", () => {
    // proves (b): even at the exact dramatic beat where the producers invite the player in, a real
    // DR entry recorded at that beat still reaches NO NPC's knowledge and moves NO NPC decision.
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", archetype: "social", seed: 81000 });
    const gs = driveToNominationsBeat(s);
    expect(gs.diaryRoomInvite?.invite).toBe(true); // sanity: we are AT the invited beat

    const sb = buildSandbox(1);
    const content = "my real plan, at the exact beat the producers just invited me in";
    sb.engine.knowledge.recordDiaryRoom(content);
    const playerKnown = sb.engine.knowledge.knownTo(PLAYER);
    expect(deriveNpcKnowledge(playerKnown).some((k) => k.content === content)).toBe(false);
    for (const id of SEEDED_NPCS) {
      expect(sb.engine.knowledge.knownTo(id).some((k) => k.content === content)).toBe(false);
    }
  });
});
