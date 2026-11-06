import { describe, it, expect, vi } from "vitest";

// P0 flip: asserts season completion / player-eviction behaviour on the flag-off baseline. Those layers now default ON, so this file pins them OFF explicitly (hoisted: some adapter consts read env at import). Tests that need a layer ON turn it on through its setter.
vi.hoisted(() => { for (const k of ["ORWELL_ASSURANCES", "ORWELL_VOTE_COUNT", "ORWELL_VETO_MEMORY", "ORWELL_DEAL_NOMS", "ORWELL_CAMPAIGN_MEMORY", "ORWELL_APPROACH_MEMORY", "ORWELL_HC_MEMORY", "ORWELL_MEMORY_PROMISES", "ORWELL_FORGIVENESS", "ORWELL_LOBBYING", "ORWELL_DESIRE_CLOCK", "ORWELL_WANT_MOVEMENT", "ORWELL_MULTI_NIGHT_FATIGUE", "ORWELL_MORNING_APPROACH", "ORWELL_NPC_TELLS", "ORWELL_TELL_REACTIONS", "ORWELL_MOOD_VETO", "ORWELL_MOOD_APPROACH", "ORWELL_MOOD_DEAL", "ORWELL_MOOD_CAMPAIGN", "ORWELL_DRIFT_FIX", "ORWELL_NPC_MEMORY_SPEECH", "ORWELL_DRIVE_DECISIONS"]) process.env[k] = "0"; });
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * Feature 0046 — player eviction & the juror's seat. The game's most common ending, finally specced:
 * the projection marks the player out (active → jury / evicted), the season completes no matter when
 * they go, and a sequestered player-juror witnesses ONLY the public ceremony broadcasts (the juror
 * knowledge model, 0002-compatible) — never the off-screen scheming. HARD rule: roles only — no names.
 */

/** A simple, deterministic player policy: compete, take the first legal options, never use the veto. */
function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  const submit = (req: SubmitDecisionReq): void => void s.submitDecision(req);
  if (p.kind === "nominations") submit({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") submit({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") submit({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-intent") submit({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "finale-statement") submit({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") submit({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "juror-vote") submit({ kind: "juror-vote", vote: p.options[0]!.id });
  else submit({ kind: p.kind, vote: p.options[0]!.id });
}

let userSeq = 0;
function newGame(seed: number): ReturnType<GameSessionRegistry["sandboxFor"]> {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`u${userSeq++}`);
  sb.session.createCharacter({ playerName: "P", seed });
  return sb;
}

const playerIdx = (s: GameSessionAdapter): number => (s.snapshot().live?.evictionOrder ?? []).indexOf(PLAYER);

/** Advance until the player is evicted (returns the index) or the game finishes. */
function driveToPlayerEviction(s: GameSessionAdapter): { idx: number; finished: boolean } {
  for (let i = 0; i < 8000; i++) {
    const v = s.advanceGame();
    if (v.pending) resolve(s, v.pending);
    if (playerIdx(s) >= 0) return { idx: playerIdx(s), finished: v.finished };
    if (v.finished) return { idx: -1, finished: true };
  }
  throw new Error("game did not resolve");
}

/** Play a fresh game to its end; report the outcome. */
function playToEnd(seed: number): { finished: boolean; winner?: EntityId; idx: number; finalists: number } {
  const sb = newGame(seed);
  let v = sb.session.advanceGame();
  for (let i = 0; i < 8000 && !v.finished; i++) {
    if (v.pending) resolve(sb.session, v.pending);
    v = sb.session.advanceGame();
  }
  const snap = sb.session.snapshot().live!;
  return { finished: v.finished, winner: snap.winner, idx: snap.evictionOrder.indexOf(PLAYER), finalists: snap.active.length };
}

/** The first seed (≤ bound) whose game evicts the player into an index the predicate accepts. */
function seedEvicting(inRange: (idx: number) => boolean, bound = 40): ReturnType<typeof newGame> {
  for (let seed = 1; seed <= bound; seed++) {
    const sb = newGame(seed);
    if (inRange(driveToPlayerEviction(sb.session).idx)) return sb;
  }
  throw new Error("no seed evicted the player into range within the bound");
}

// The jury is the last 9 of the (cast − 2) evictions; with the standard 16-cast that is eviction index ≥ 5.
const PRE_JURY = (idx: number): boolean => idx >= 0 && idx < 5;
const JURY = (idx: number): boolean => idx >= 5;

describe("0046 — player eviction & the juror's seat", () => {
  it("marks the player EVICTED (pre-jury) and frames the closure moment", () => {
    const sb = seedEvicting(PRE_JURY);
    const view = sb.session.getGameState();
    expect(view.player?.status).toBe("evicted");
    expect(view.moment).toBe("evicted"); // the spectator/closure framing, not the ceremony phase they can't act in
    expect(playerIdx(sb.session)).toBeLessThan(5);
    // Play-through fix (2026-06-18): an evicted player in an ONGOING season was offered the Vault,
    // which the engine then refused (it unseals only post-winner). The prompt must seal it itself so
    // the model never makes the premature offer.
    expect(sb.session.getMomentPrompt({}).systemPrompt).toMatch(/hidden story stays SEALED until the season crowns/);
  });

  it("marks the player JURY when evicted into the last-9 jury and frames the jury seat", () => {
    const sb = seedEvicting(JURY);
    const view = sb.session.getGameState();
    expect(view.player?.status).toBe("jury");
    expect(view.moment).toBe("jury");
    expect(playerIdx(sb.session)).toBeGreaterThanOrEqual(5);
    expect(sb.session.getMomentPrompt({}).systemPrompt).toMatch(/hidden story stays SEALED until the finale crowns/);
  });

  it("a season completes to a Final 2 + a winner no matter when the player is evicted", () => {
    // Search the seed space for one PRE-JURY and one JURY player eviction (seeded outcomes
    // reshuffle as generation evolves — roles, not magic seeds, define the scenario).
    for (const inRange of [PRE_JURY, JURY]) {
      let found = false;
      for (let seed = 1; seed <= 40 && !found; seed++) {
        const r = playToEnd(seed);
        if (!r.finished || !inRange(r.idx)) continue;
        found = true;
        expect(r.finalists).toBe(2);                      // reached Final 2
        expect(r.winner).toBeDefined();                   // a winner was crowned (an NPC — the player is out)
        expect(r.winner).not.toBe(PLAYER);
      }
      expect(found, "a seed evicting the player into range exists").toBe(true);
    }
  });

  it("the player on the jury still casts their OWN finale vote (the rest are engine-decided)", () => {
    const sb = seedEvicting(JURY);
    let sawJurorVote = false;
    for (let i = 0; i < 8000; i++) {
      const v = sb.session.advanceGame();
      if (v.pending?.kind === "juror-vote") sawJurorVote = true;
      if (v.pending) resolve(sb.session, v.pending);
      if (v.finished) break;
    }
    expect(sawJurorVote).toBe(true);
    expect(sb.session.snapshot().live!.finished).toBe(true);
  });

  it("a sequestered player-juror witnesses ONLY the public ceremony broadcasts — never the off-screen game", () => {
    // The juror knowledge model (0002-compatible): once out, the player keeps receiving the PUBLIC
    // ceremony results (house-event broadcasts) but none of the private scheming / confessionals.
    const sb = seedEvicting((idx) => idx >= 5 && idx <= 10); // a mid-jury seed: several ceremonies still to spectate
    const witnessedAtEviction = sb.engine.events.query({ witnessedBy: PLAYER }).length;

    // Spectate several more beats from the jury box.
    for (let k = 0; k < 8; k++) {
      const v = sb.session.advanceGame();
      if (v.pending) resolve(sb.session, v.pending);
      if (v.finished) break;
    }

    const witnessed = sb.engine.events.query({ witnessedBy: PLAYER });
    const hidden = sb.engine.events.queryAll().filter((e) => e.hidden);

    // They are not cut off: the broadcasts keep coming (their witnessed set grew while spectating).
    expect(witnessed.length).toBeGreaterThan(witnessedAtEviction);
    // Every event the juror witnesses is a PUBLIC broadcast — no confessional / off-screen type leaks in.
    // (Only what arrived AFTER the eviction: before it the player was in the house, and a witnessed NPC deal offer — default
    // ON since the 2026-11 flip — is the player's own legitimate knowledge. After it, no one pulls an evicted juror aside.)
    const fromTheBox = witnessed.slice(witnessedAtEviction);
    expect(fromTheBox.every((e) => e.type === "house-event"), JSON.stringify(fromTheBox.filter((e) => e.type !== "house-event").map((e) => e.content))).toBe(true);
    expect(fromTheBox.every((e) => e.hidden === false)).toBe(true);
    // The house keeps a hidden life the juror cannot see — and none of it lists the player as a witness.
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every((e) => !e.witnessSet.includes(PLAYER))).toBe(true);
  });

  it("Vault Wall holds for the juror: a planted hidden scheme never reaches the player's witnessed events", () => {
    const sb = seedEvicting(JURY);
    const sentinel = "SENTINEL-0046-jury-secret-scheme";
    sb.engine.events.record({
      id: "hidden:0046", ts: 10_000_001, type: "conversation",
      initiator: sb.session.getGameState().house[0]!.id, witnessSet: [sb.session.getGameState().house[0]!.id],
      hidden: true, content: sentinel,
    });
    const witnessedContent = sb.engine.events.query({ witnessedBy: PLAYER }).map((e) => e.content).join("\n");
    expect(witnessedContent.includes(sentinel)).toBe(false);
  });
});
