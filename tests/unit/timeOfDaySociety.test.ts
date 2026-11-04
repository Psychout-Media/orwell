import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import { PLAYER } from "../../src/domain/ids";
import { linger } from "../support/linger";

/**
 * ADR 0006 — the SOCIAL half of the sleep economy: the awake set wired into the living house. As the
 * night thins, houseguests reach their character-driven bedtimes and drop out — the house empties for
 * the player (whereabouts), the approaches quiet down, and the off-screen society pairs only those
 * still up (the night owls scheme on; an early-to-bed houseguest misses it). OPT-IN: off ⇒ everyone
 * awake ⇒ byte-identical (the seeded juryReach/UAT calibration spine is unmoved). Roles only.
 */

afterEach(() => { delete process.env.ORWELL_TIME_OF_DAY; });

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: p.options[0]!.id });
  else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "juror-vote") s.submitDecision({ kind: "juror-vote", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id });
}

/** Advance (clock on) until the phase reaches `target`; resolve pendings legally. Returns whether reached. */
function advanceToPhase(s: GameSessionAdapter, target: string, cap = 40): boolean {
  for (let i = 0; i < cap; i++) {
    if (s.gameStatus().timeOfDay === target) return true;
    if (s.gameStatus().timeOfDay) { linger(s); if (s.gameStatus().timeOfDay === target) return true; }
    const a = s.advanceGame();
    if (a.pending) resolveLegally(s, a.pending);
    if (a.finished) break;
  }
  return s.gameStatus().timeOfDay === target;
}

/**
 * Advance (clock on) into the night until the house has actually THINNED — the 24-hour model thins as NPCs
 * reach their character bedtimes (the earliest larks ~21:00, deepening into the late-night trough). Returns
 * whether at least one NPC has gone to bed (a strict subset of the roster is awake). Resolves pendings.
 */
function advanceUntilThinned(s: GameSessionAdapter, cap = 80): boolean { // P4b: the day-1 first-morning day-break shifts the clock one beat later, so allow a few more steps
  for (let i = 0; i < cap; i++) {
    if (s.gameStatus().timeOfDay) {
      const ids = s.livingIds().filter((id) => id !== PLAYER);
      if (s.awakeAmong(ids).length < ids.length) return true; // someone has turned in
      linger(s);
      if (s.awakeAmong(ids).length < ids.length) return true;
    }
    const a = s.advanceGame();
    if (a.pending) resolveLegally(s, a.pending);
    if (a.finished) break;
  }
  const ids = s.livingIds().filter((id) => id !== PLAYER);
  return s.awakeAmong(ids).length < ids.length;
}

function npcsOf(s: GameSessionAdapter): string[] {
  return s.livingIds().filter((id) => id !== PLAYER);
}

function started(seed: number): GameSessionAdapter {
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "The Player", seed });
  return s;
}

describe("ADR 0006 — off by default: the awake set is the identity (calibration-safe)", () => {
  it("awakeAmong returns the full set unchanged and the society occupancy keeps everyone", () => {
    const s = started(7); // ORWELL_TIME_OF_DAY unset
    for (let i = 0; i < 5; i++) { const a = s.advanceGame(); if (a.pending) resolveLegally(s, a.pending); }
    const ids = npcsOf(s);
    expect(s.awakeAmong(ids)).toEqual(ids); // identity, stable order — no calibration perturbation
    const occ = s.societyOccupancy();
    for (const id of ids) expect(occ?.has(id)).toBe(true); // nobody dropped from the society occupancy
  });
});

describe("ADR 0006 — the house thins at night (the social bound, 24-hour model)", () => {
  it("by late hours the awake set is a STRICT subset of the roster (the house has thinned)", () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    let sawThinning = false;
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = started(seed);
      if (!advanceUntilThinned(s)) continue;
      const ids = npcsOf(s);
      const awakeNow = new Set(s.awakeAmong(ids));
      expect(awakeNow.size).toBeLessThan(ids.length); // a strict subset — at least one has turned in
      sawThinning = true;
      break;
    }
    expect(sawThinning, "the house thinned at night for at least one cast").toBe(true);
  });

  it("whereabouts, approaches and the society occupancy only ever show houseguests who are awake", () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    const s = started(3);
    advanceUntilThinned(s);
    // P4b: presence refreshes at a COMMITTED beat; the helper can return the instant the clock passes bedtime (after a linger), so seat one beat before reading it (the day-1
    // first-morning day-break shifted where in the cadence that moment lands).
    const settle = s.advanceGame();
    if (settle.pending) resolveLegally(s, settle.pending);
    const awake = new Set(s.awakeAmong(npcsOf(s)));
    const w = s.whereabouts();
    const around = [...(w?.present ?? []), ...(w?.nearby ?? []).flatMap((n) => n.present)];
    for (const p of around) expect(awake.has(p.id)).toBe(true); // no asleep NPC is "around" the player
    for (const a of s.socialInitiatives()) expect(awake.has(a.houseguest.id)).toBe(true); // none approach asleep
    const occ = s.societyOccupancy();
    for (const [id] of occ ?? new Map<string, string>()) if (id !== PLAYER) expect(awake.has(id)).toBe(true);
  });
});

describe("ADR 0006 — the off-screen society pairs only the awake (the night owls scheme on)", () => {
  it("no hidden off-screen scene at night involves a houseguest who has gone to bed", () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    let proved = false;
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const reg = new GameSessionRegistry();
      const user = `society-${seed}`;
      const orch = new Orchestrator(reg, { now: () => seed }, { seed });
      const sb = reg.sandboxFor(user);
      sb.session.createCharacter({ playerName: "The Player", seed });
      if (!advanceUntilThinned(sb.session)) continue;
      const npcs = npcsOf(sb.session);
      const awake = new Set(sb.session.awakeAmong(npcs));
      if (awake.size >= npcs.length) continue; // need at least one asleep for the check to bite
      const beforeIds = new Set(sb.engine.events.queryAll().map((e) => e.id));
      for (let t = 0; t < 8; t++) orch.advance(user, "offscreen-tick");
      // The off-screen SOCIETY scenes are hidden pairwise events (witnessSet excludes the player).
      // Every hidden pair at night — society scenes AND rumor retellings (#1913) — is among the awake.
      const scenes = sb.engine.events.queryAll().filter((e) => !beforeIds.has(e.id) && e.hidden && e.witnessSet.length === 2);
      for (const e of scenes) {
        for (const id of e.witnessSet) {
          if (id !== PLAYER) expect(awake.has(id), "an asleep houseguest schemed off-screen at night").toBe(true);
        }
      }
      if (scenes.length > 0) { proved = true; break; }
    }
    expect(proved, "a late-night society ran among the awake, excluding the asleep").toBe(true);
  });
});

describe("0066 Phase-2 — a CHARACTER conflict drains a houseguest to bed earlier (conflict → earlier bedtime)", () => {
  it("hammering an awake NPC with conflicts pulls THEM out of the night awake set; an un-conflicted one stays", () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const s = started(seed);
      s.setSocialFatigueEnabled(true); // Extension 2 owns the conflict→earlier-bedtime drain (opt-in)
      if (!advanceToPhase(s, "night")) continue;
      const ids = npcsOf(s);
      const awake = s.awakeAmong(ids);
      if (awake.length < 3) continue; // need a victim + a conflict-partner + an un-conflicted control
      const victim = awake[0]!, partner = awake[1]!, control = awake[2]!;
      for (let i = 0; i < 6; i++) s.recordOffscreenScene(victim, partner, "conflict"); // a rough night
      const after = s.awakeAmong(ids);
      expect(after).not.toContain(victim);  // drained to bed early by the fights
      expect(after).toContain(control);     // an uninvolved houseguest keeps their normal bedtime
      return; // one good seed proves it
    }
    throw new Error("no seed reached `night` with ≥3 awake — test setup");
  });

  it("clock OFF: recording conflicts never changes the (identity) awake set", () => {
    const s = started(7); // ORWELL_TIME_OF_DAY unset
    for (let i = 0; i < 5; i++) { const a = s.advanceGame(); if (a.pending) resolveLegally(s, a.pending); }
    const ids = npcsOf(s);
    for (let i = 0; i < 6; i++) s.recordOffscreenScene(ids[0]!, ids[1]!, "conflict");
    expect(s.awakeAmong(ids)).toEqual(ids); // identity — the drain is dormant off the clock
  });
});
