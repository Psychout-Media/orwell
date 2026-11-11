import { endHeldNightSync } from "../support/heldNight";
import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { liveHouseEvent, isCompOrCeremonyKind } from "../../src/engine/houseEvent";
import { Orchestrator, competitionSuppressesPrivateScenes } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import { SOCIETY_TICK_HOURS } from "../../src/engine/sleepConstants";

/**
 * Feature 0117 (Phase 1 of the in-game-time pivot) — the house lives IN IN-GAME TIME. When the in-game
 * clock is running, the off-screen society must keep scheming AS TIME PASSES during the player's
 * between-ceremony social play (not only in a burst when a ceremony beat resolves). When the clock is
 * OFF (the seeded calibration spine; golden replay with the per-conversation clock off), a social turn
 * changes nothing — no time advances, the house stays quiet, byte-identical to before.
 *
 * These tests run the PRODUCTION-shaped orchestrator config: turnDriven + auxTicksNever (the always-on
 * logical-clock / golden-replay pacing), which is exactly the config where a social turn used to return
 * early and freeze the house. Roles only — no cast names. In-game time only; never a real-world clock.
 */

afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

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

/** Production-shaped: turn-driven + auxTicksNever (the logical-clock/golden config). */
function harness(opts: { clockOn: boolean; seed: number; user: string }) {
  GameSessionAdapter.setTimeOfDayEnabled(opts.clockOn);
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(opts.user);
  sb.session.createCharacter({ playerName: "The Player", seed: opts.seed });
  sb.session.setPerConversationClockEnabled(true);
  const orch = new Orchestrator(reg, new FakeClock(), { seed: opts.seed, turnDriven: true, auxTicksNever: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  reg.setOnReset((u) => orch.forgetUser(u));
  return { reg, sb, orch };
}

/** Advance ceremony beats until a live house exists (an HOH is crowned — the clock has started). */
function toLiveHouse(sb: ReturnType<GameSessionRegistry["sandboxFor"]>): void {
  for (let i = 0; i < 120; i++) {
    if (sb.session.snapshot().live?.hoh !== undefined) return;
    const a = sb.session.advanceGame();
    if (a.pending) resolveLegally(sb.session, a.pending);
    if (a.finished) return;
  }
}

/** The hidden off-screen SOCIETY scenes: pairwise NPC↔NPC events the player never witnessed. */
function offscreenScenes(sb: ReturnType<GameSessionRegistry["sandboxFor"]>): string[] {
  return sb.engine.events
    .queryAll()
    .filter((e) => e.hidden && e.witnessSet.length === 2 && !e.witnessSet.includes(PLAYER))
    .map((e) => e.id);
}

function aliveNpc(sb: ReturnType<GameSessionRegistry["sandboxFor"]>, i = 0): string {
  return sb.session.livingIds().filter((id) => id !== PLAYER)[i]!;
}

/** One SOCIAL (aux) turn: a witnessed player↔houseguest scene. Does NOT progress the live loop. */
function socialTurn(sb: ReturnType<GameSessionRegistry["sandboxFor"]>, content: string): void {
  sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, aliveNpc(sb)], content });
}

describe("0117 — the house schemes during social play when the in-game clock is running", () => {
  it("a run of social turns advances in-game time AND lets the off-screen house scheme between ceremonies", () => {
    const { sb } = harness({ clockOn: true, seed: 7, user: "u-live" });
    toLiveHouse(sb);
    // The clock started when the first ceremony crowned an HOH.
    const hour0 = sb.session.inGameHour();
    expect(hour0).toBeDefined();
    expect(sb.session.perConversationClockLive()).toBe(true);

    const before = new Set(offscreenScenes(sb));
    // NOTHING BUT social turns from here — so any new off-screen scenes are the between-ceremony house.
    for (let t = 0; t < 12; t++) socialTurn(sb, `linger ${t}`);

    // In-game time flowed during the player's social play...
    expect(sb.session.inGameHour()!).toBeGreaterThan(hour0!);
    // ...and the hidden house schemed while the player socialised (the un-silencing).
    const after = offscreenScenes(sb).filter((id) => !before.has(id));
    expect(after.length).toBeGreaterThan(0);
    // None of that scheming was witnessed by the player (it stays off-screen).
    for (const id of after) {
      const ev = sb.engine.events.queryAll().find((e) => e.id === id)!;
      expect(ev.witnessSet.includes(PLAYER)).toBe(false);
    }
  });

  it("the scheming is paced by ELAPSED IN-GAME TIME, not once per social turn/tool call", () => {
    // With the per-conversation floor (~0.5h) below SOCIETY_TICK_HOURS, the house must NOT live on every
    // single social turn — only once enough in-game time has passed. So over N turns, fewer than N of them
    // fire a fresh society tick.
    let proved = false;
    for (const seed of [3, 5, 8, 11, 13]) {
      const { sb } = harness({ clockOn: true, seed, user: `u-pace-${seed}` });
      toLiveHouse(sb);
      if (!sb.session.perConversationClockLive()) continue;
      const N = 12;
      let seen = new Set(offscreenScenes(sb));
      let tickTurns = 0;
      for (let t = 0; t < N; t++) {
        socialTurn(sb, `pace ${t}`);
        const now = offscreenScenes(sb);
        if (now.some((id) => !seen.has(id))) tickTurns++;
        seen = new Set(now);
      }
      // Some turns schemed (un-silenced) but NOT every turn (paced by the clock, not per tool call).
      if (tickTurns > 0 && tickTurns < N) {
        // Sanity on the cadence: with a ~0.5h step and a 1.5h gate, roughly a third of turns tick.
        expect(tickTurns).toBeLessThanOrEqual(Math.ceil(N * (0.5 / SOCIETY_TICK_HOURS)) + 2);
        proved = true;
        break;
      }
    }
    expect(proved, "social scheming is time-paced (some turns tick, not all)").toBe(true);
  });
});

describe("0117 — with the in-game clock OFF, social play changes nothing (byte-identical guardrail)", () => {
  it("social turns advance no time and add no off-screen scene (the seeded-spine / golden-replay path)", () => {
    const { sb } = harness({ clockOn: false, seed: 7, user: "u-off" });
    toLiveHouse(sb);
    // Clock off ⇒ no in-game time, and a social turn is inert (the old M0-9 early return still holds).
    expect(sb.session.inGameHour()).toBeUndefined();
    expect(sb.session.perConversationClockLive()).toBe(false);

    const before = new Set(offscreenScenes(sb));
    for (let t = 0; t < 12; t++) socialTurn(sb, `idle ${t}`);

    expect(sb.session.inGameHour()).toBeUndefined(); // still no clock
    const added = offscreenScenes(sb).filter((id) => !before.has(id));
    expect(added.length).toBe(0); // the house stayed quiet — no extra tick fired on the social turns
  });
});

describe("0117 — the pacing reads are Vault-free", () => {
  it("inGameHour / perConversationClockLive carry only the clock, never planted Vault content", () => {
    const { sb } = harness({ clockOn: true, seed: 7, user: "u-vault" });
    toLiveHouse(sb);
    const SENT = "VAULT_117_SENTINEL";
    sb.engine.vault.writeHidden({ id: "v117", kind: "hidden-attribute", content: `hidden ${SENT}` });

    const hour = sb.session.inGameHour();
    expect(typeof hour).toBe("number");
    expect(JSON.stringify(hour)).not.toContain(SENT);
    expect(JSON.stringify(sb.session.perConversationClockLive())).not.toContain(SENT);
  });
});

describe("ORW-232 slice 3 / ORW-256 — nobody schemes in private while a competition is running (Ryne 2026-11-10)", () => {
  it("the decision: a person playing on the live clock gets no private scenes inside a competition; everything else keeps its cadence", () => {
    // clockLive, messageMode, baselineInComp, candidateInComp
    expect(competitionSuppressesPrivateScenes(true, true, true, true), "a round commit").toBe(true);
    expect(competitionSuppressesPrivateScenes(true, true, false, true), "the commit that starts it").toBe(true);
    expect(competitionSuppressesPrivateScenes(true, true, true, false), "the crown").toBe(true);
    expect(competitionSuppressesPrivateScenes(true, true, false, false), "outside a competition the house schemes").toBe(false);
    expect(competitionSuppressesPrivateScenes(true, false, true, true), "a headless driver (no announced messages) keeps its tick cadence: the seeded sims are untouched").toBe(false);
    expect(competitionSuppressesPrivateScenes(false, true, true, true), "clock off (the seeded spine): never").toBe(false);
  });
  it("a headless driver's competition still ticks as it always did (the seeded jury-reach / UAT cadence is unchanged)", () => {
    const { sb } = harness({ clockOn: true, seed: 7, user: "u-comp" });
    toLiveHouse(sb);
    let during = 0, ran = 0;
    for (let i = 0; i < 400 && ran < 3; i++) {
      const inComp = !!(sb.session.snapshot().live as { competition?: unknown } | undefined)?.competition;
      const before = new Set(offscreenScenes(sb));
      const a = sb.session.advanceGame();
      if (a.pending) resolveLegally(sb.session, a.pending);
      const after = !!(sb.session.snapshot().live as { competition?: unknown } | undefined)?.competition;
      if (inComp && after) during += offscreenScenes(sb).filter((id) => !before.has(id)).length;
      if (inComp && !after) ran++;
      if (a.finished) break;
    }
    expect(during, "scenes still happen inside a competition for a headless driver").toBeGreaterThan(0);
  });
});

describe("ORW-281 slice 3 — the private-scene suppression keys on ANY house event in session, from one derivation", () => {
  const base = { active: ["a", "b", "c", "d"], outgoingHoh: "a" };
  const k = (live: object, o?: { includeDraw?: boolean }) => liveHouseEvent({ ...base, ...live } as never, o)?.kind;
  it("comps, nominations, the veto ceremony and eviction count; idle and the premiere toast do not", () => {
    expect(k({ competition: { comp: "hoh-competition", field: ["b"] } })).toBe("hoh-competition");
    expect(k({ pending: { kind: "nominations" } })).toBe("nominations");
    expect(k({ pending: { kind: "veto-decision" } })).toBe("veto-ceremony");
    expect(k({ pending: { kind: "replacement" } })).toBe("veto-ceremony");
    expect(k({ pending: { kind: "eviction-vote" } })).toBe("eviction");
    expect(k({ pending: { kind: "comp-intent", comp: "veto-competition" } })).toBe("veto-competition");
    expect(k({})).toBeUndefined();
    expect(isCompOrCeremonyKind(k({ champagneCircle: "gathered" }))).toBe(false);
    expect(isCompOrCeremonyKind(k({ pending: { kind: "nominations" } }))).toBe(true);
  });
  it("the veto draw (veto-competition beat, no vetoField) counts only when asked, and not once the field is drawn without a pending", () => {
    expect(k({ beat: "veto-competition" })).toBeUndefined();
    expect(k({ beat: "veto-competition" }, { includeDraw: true })).toBe("veto-draw"); // ORW-281 slice 1: the draw reports as its own ceremony kind
    expect(k({ beat: "veto-competition", vetoField: ["a"] }, { includeDraw: true })).toBeUndefined();
  });
});
