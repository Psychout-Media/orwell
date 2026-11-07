import { describe, it, expect, vi, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";
import { npcExitStance, EXIT_STANCES, isInertBeat } from "../../src/engine/liveSeason";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * Feature 0130 — exit interviews. After every staged eviction (0047) the evictee is interviewed by the
 * producers: they see + react to their goodbye messages and tell their side. NPC → a grounded stance
 * (derived from the recorded eviction manner); player → their own pending decision. Recorded for the
 * 0048 retrospective. Expressive/retrospective ONLY — the seeded spine is byte-identical. It draws no
 * rng and mutates no seeded state; nothing hidden crosses the wall. HARD rule: roles only — no names.
 */

/** Answer any pending legally (compete, first legal option, never veto) — INCLUDING the exit interview. */
function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  const submit = (req: SubmitDecisionReq): void => void s.submitDecision(req);
  if (p.kind === "nominations") submit({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") submit({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") submit({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-intent") submit({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "comp-round") submit({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "finale-statement") submit({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") submit({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "juror-vote") submit({ kind: "juror-vote", vote: p.options[0]!.id });
  else if (p.kind === "exit-interview") submit({ kind: "exit-interview", vote: p.stances![0]! });
  else submit({ kind: p.kind, vote: p.options[0]!.id });
}

let userSeq = 0;
function newGame(seed: number): ReturnType<GameSessionRegistry["sandboxFor"]> {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`ei${userSeq++}`);
  sb.session.createCharacter({ playerName: "P", seed });
  return sb;
}

function playToEnd(s: GameSessionAdapter): void {
  for (let i = 0; i < 8000; i++) {
    const v = s.advanceGame();
    if (v.pending) resolve(s, v.pending);
    if (v.finished) return;
  }
  throw new Error("game did not resolve");
}

describe("0130 — an NPC exit stance is derived from the manner (grounded, not invented)", () => {
  const state = (rows: Record<EntityId, { betrayed?: boolean; blindsided?: boolean; respected?: boolean; disrespected?: boolean }>): LiveSeasonState =>
    ({ mannerByEvictee: { [npc(1)]: rows } }) as unknown as LiveSeasonState;

  it("a betrayed (or disrespected) evictee leaves BITTER", () => {
    expect(npcExitStance(npc(1), state({ [npc(2)]: { betrayed: true } }))).toBe("bitter");
    expect(npcExitStance(npc(1), state({ [npc(2)]: { disrespected: true } }))).toBe("bitter");
  });
  it("a blindsided evictee leaves DEFIANT", () => {
    expect(npcExitStance(npc(1), state({ [npc(2)]: { blindsided: true } }))).toBe("defiant");
  });
  it("a cleanly-evicted (respected) evictee leaves GRACIOUS — and blindsided differs from respected", () => {
    const blindsided = npcExitStance(npc(1), state({ [npc(2)]: { blindsided: true } }));
    const respected = npcExitStance(npc(1), state({ [npc(2)]: { respected: true } }));
    expect(respected).toBe("gracious");
    expect(blindsided).not.toBe(respected); // the DoD: a blindsided evictee reacts differently
  });
});

describe("0130 — the exit interview is an INERT beat (no clock advance)", () => {
  it("is inert, so the ADR-0006 clock never ticks on it (no eviction-night fatigue/rest shift)", () => {
    // The presentation-only producer sit-down must not advance the in-game clock when time-of-day is
    // on — an extra tick would move fatigue/rest into later competitions. It sits beside the staged
    // reveal beats in INERT_BEATS; the crown/ceremony beats stay substantive.
    expect(isInertBeat("exit-interview")).toBe(true);
    expect(isInertBeat("comp-elimination")).toBe(true);
    expect(isInertBeat("eviction")).toBe(false);
  });
});

describe("0130 — fires every staged eviction + resurfaces in the retrospective", () => {
  it("every staged eviction is interviewed, and the retrospective replays them first-person", () => {
    const sb = newGame(108);
    playToEnd(sb.session);
    const retro = sb.session.seasonRetrospective();
    expect(retro).toBeTruthy();
    const interviews = retro!.exitInterviews ?? [];
    const ballots = retro!.evictionVotes ?? [];
    // One interview per staged eviction (both are pushed in the same commit) — none skipped.
    expect(interviews.length).toBeGreaterThan(0);
    expect(interviews.length).toBe(ballots.length);
    for (const x of interviews) {
      expect(x.evictee.name).toBeTruthy();          // humanized, first-person account
      expect(EXIT_STANCES).toContain(x.stance);     // a legal grounded stance
      expect(x.week).toBeGreaterThan(0);
      // When the evictee authored their own words (the player's account), they round-trip non-empty.
      // NPC accounts ARE the narrated beat content (canaried in the Vault test), not a stored reel field.
      if (x.message !== undefined) expect(x.message.length).toBeGreaterThan(0);
    }
  });
});

describe("0130 — the player's exit interview is their own pending decision", () => {
  it("when the player is evicted the loop pauses for an exit-interview decision, recorded on submit", () => {
    // Find a seed that evicts the player through the STAGED path (an exit-interview pending appears).
    let seen = false;
    for (let seed = 1; seed <= 60 && !seen; seed++) {
      const sb = newGame(seed);
      const s = sb.session;
      for (let i = 0; i < 8000; i++) {
        const v = s.advanceGame();
        if (v.pending?.kind === "exit-interview") {
          const p = v.pending;
          expect(p.evictee?.id).toBe(PLAYER);                 // the player IS the evictee being interviewed
          expect(p.stances && p.stances.length).toBeGreaterThan(0);
          // Not yet recorded — no beat fired before the player answered.
          const before = s.snapshot().live?.exitInterviews ?? [];
          expect(before.some((x) => x.evictee === PLAYER)).toBe(false);
          s.submitDecision({ kind: "exit-interview", vote: "defiant", statement: "I'm not done." } as SubmitDecisionReq);
          const after = s.snapshot().live?.exitInterviews ?? [];
          const mine = after.find((x) => x.evictee === PLAYER);
          expect(mine?.stance).toBe("defiant");               // the player's OWN chosen posture, not engine-authored
          expect(mine?.message).toBe("I'm not done.");
          seen = true;
          break;
        }
        if (v.pending) resolve(s, v.pending);
        if (v.finished) break;
      }
    }
    expect(seen, "no seed ≤ 60 evicted the player through the staged path").toBe(true);
  });

  it("rejects an illegal exit stance", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const sb = newGame(seed);
      const s = sb.session;
      let hit = false;
      for (let i = 0; i < 8000; i++) {
        const v = s.advanceGame();
        if (v.pending?.kind === "exit-interview") {
          const pendingBefore = JSON.stringify(s.snapshot().live?.pending ?? null);
          const interviewsBefore = JSON.stringify(s.snapshot().live?.exitInterviews ?? []);
          expect(() => s.submitDecision({ kind: "exit-interview", vote: "smug" } as SubmitDecisionReq)).toThrow();
          // A refused submit is a strict no-op: the pending still stands and nothing was recorded.
          expect(JSON.stringify(s.snapshot().live?.pending ?? null)).toBe(pendingBefore);
          expect(JSON.stringify(s.snapshot().live?.exitInterviews ?? [])).toBe(interviewsBefore);
          hit = true;
          break;
        }
        if (v.pending) resolve(s, v.pending);
        if (v.finished) break;
      }
      if (hit) return;
    }
    throw new Error("no seed ≤ 60 reached a player exit interview");
  });
});

describe("0130 — Vault-safe + deterministic + calibration-neutral", () => {
  it("no stat/score/sentinel rides the exit-interview stage or the retrospective reel", () => {
    const sb = newGame(42);
    const s = sb.session;
    const blobs: string[] = [];
    for (let i = 0; i < 8000; i++) {
      const v = s.advanceGame();
      if (v.eviction?.stage === "exit-interview") blobs.push(JSON.stringify(v.eviction));
      // The producer narration rides the emitted beat's own content — canary it too (not just the view).
      if (v.event && /exit-interview/.test(JSON.stringify(v.event))) blobs.push(JSON.stringify(v.event));
      if (v.pending) resolve(s, v.pending);
      if (v.finished) break;
    }
    blobs.push(JSON.stringify(s.seasonRetrospective()?.exitInterviews ?? []));
    // Mandate #2: the admin/God-Mode debug unseal (producerVaultDump) is the ONE admin-facing
    // projection of the exit interviews — prove IT stays Vault-free too (the same scrubbed reel).
    blobs.push(JSON.stringify(s.producerVaultDump()?.exitInterviews ?? []));
    const all = blobs.join("|");
    // No hidden number crosses (a public NamedRef {id,name} is fine — the id is not Vault state).
    expect(/"(physical|mental|social|trust|affinity|threat)"\s*:\s*[\d.]/.test(all)).toBe(false);
    expect(/"(scores|lean|grudge|voteOf|secret|hidden)"/i.test(all)).toBe(false);
  });

  it("is seed-deterministic — the same seed reproduces the same exit interviews", () => {
    const a = newGame(19); playToEnd(a.session);
    const b = newGame(19); playToEnd(b.session);
    expect(JSON.stringify(a.session.seasonRetrospective()?.exitInterviews))
      .toBe(JSON.stringify(b.session.seasonRetrospective()?.exitInterviews));
  });

  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  // The anchor below is the legacy (all-flags-off) trajectory, so it is replayed under ORWELL_FLAGS_OFF=1
  // (default flip 2026-11-03). The flipped flags are read as module consts, hence the fresh module graph.
  it("byte-identical spine: the eviction order matches the pre-0130 baseline (the beat is inert)", async () => {
    vi.stubEnv("ORWELL_FLAGS_OFF", "1");
    vi.resetModules();
    const { GameSessionRegistry: FlagsOffRegistry } = await import("../../src/composition/registry");
    // Captured from main BEFORE 0130 (the complete seeded trajectory anchor); re-anchored 2026-11-02 when
    // the 0044 §9 difficulty rulings (floaters as pawns, the HOH-referendum vote, per-houseguest nomination
    // styles) reshaped the seeded trajectory; re-anchored again 2026-11-03 (seeds 7 and 108) when #1948 made the
    // replacement branch on the stored HOH target. Re-captured 2026-11-03 (seeds 7, 42 and 108, under the ORWELL_FLAGS_OFF profile this test replays) for the comp-win threat retune (#1953); seed 42 re-anchored again 2026-11-03 for #1971 (the new-target replacement branch ranks without floater/duo). The exit-interview beat must stay inert against this anchor.
    const BASELINE: Record<number, string[]> = {
      7: ["npc:7","npc:13","npc:15","npc:3","npc:8","npc:11","npc:5","npc:4","npc:12","npc:9","npc:2","player","npc:6","npc:14"], // re-anchored 2026-11-06 for ORW-132 (pre-show ties are now rare, so the seed-7 cast seeds differently even with every flag off); seeds 42 and 108 are unchanged
      42: ["npc:4","npc:13","npc:1","npc:3","npc:12","npc:8","npc:2","npc:7","player","npc:14","npc:9","npc:6","npc:5","npc:15"],
      108: ["npc:5","npc:7","npc:3","npc:8","npc:1","npc:12","npc:9","npc:6","npc:13","npc:4","player","npc:15","npc:11","npc:2"],
    };
    for (const [seed, expected] of Object.entries(BASELINE)) {
      const sb = new FlagsOffRegistry().sandboxFor(`ei-off${userSeq++}`);
      sb.session.createCharacter({ playerName: "P", seed: Number(seed) });
      playToEnd(sb.session as unknown as GameSessionAdapter);
      const order = (sb.session.snapshot().live?.evictionOrder ?? []).slice(0, expected.length);
      expect(order, `seed ${seed} eviction order drifted — the exit interview perturbed the seeded spine`).toEqual(expected);
    }
  });
});
