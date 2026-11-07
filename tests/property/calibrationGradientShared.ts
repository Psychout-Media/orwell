import { endHeldNight } from "../support/heldNight";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";

/**
 * Calibration GRADIENT gate — shared spine (shard runner + aggregate).
 *
 * The gate plays {@link SEEDS} seeds, each as TWO full live seasons — a fully-PASSIVE policy and a
 * MINIMAL-ACTIVE one — over the SAME seed, and asserts a MONOTONIC band over the DISTRIBUTION:
 * active jury-reach ≥ passive AND active wins ≥ passive across the set, with a sanity floor. Each
 * seed's passive+active pair is independent and per-seed seeded, so the play can be SHARDED across
 * CI runners — each shard plays a contiguous seed slice and emits its per-seed measurements; an
 * aggregate step recombines ALL shards and runs the one band assertion.
 *
 * This module is the single source of truth for BOTH halves: the seed-playing driver
 * ({@link playSeed}/{@link playSeeds}) and the aggregate assertion ({@link assertGradient}) over the
 * full set — so a shard and the aggregate can never drift on methodology or numbers. The policy,
 * the SEED count, and the asserted band are UNCHANGED from the pre-shard single-file gate; only
 * WHERE the seeds are played moved. Roles only — no houseguest names.
 *
 * Methodology mirrors `juryReach` exactly — seeded multi-season runs through the SAME live runtime
 * `main.ts` composes (composeRuntime → registry → orchestrator commit spine, pure turn-driven). The
 * ONLY difference between the two arms is the player policy, run over the SAME seeds, so any gap is
 * a REAL, attributable effect of social play — never noise (seeded determinism: same seeds ⇒ same
 * outcomes). The player's seat is read from the PUBLIC 0046 seam (`GameStateView.player.status`).
 */

export const SEEDS = 6;        // modest (heavy lane): two full-season sweeps per seed (passive + active) = 12 seasons
export const SCENES_PER_ALLY = 3; // a few bonding/alliance scenes per ally each season — "a player who shows up"

interface NamedRef { id: string; name: string }
interface PendingView { kind: string; options: NamedRef[]; appeals?: string[] }
interface AdvanceResult { started: boolean; finished: boolean; pending: PendingView | null }
interface HouseCard { id: string; status: string }
interface StateView { player: { id?: string; status: "active" | "jury" | "evicted" } | null; house?: HouseCard[] }

export type Status = "active" | "jury" | "evicted";

/** The Vault-free MCP handle a channel resolver hands back — only `callTool` is used here. */
interface Mcp { callTool(name: string, args?: Record<string, unknown>): Promise<unknown> }
type Resolver = (channel: "player" | "admin", user: string) => Mcp;

/** One seed's public, Vault-free measurement — the unit a shard emits and the aggregate consumes. */
export interface GradientResult {
  seed: number;
  passive: { status: Status; won: boolean };
  active: { status: Status; won: boolean };
}

/** The PASSIVE policy (identical to juryReach): first legal option everywhere; compete; veto on self only. */
function passiveAnswer(p: PendingView): Record<string, unknown> {
  switch (p.kind) {
    case "nominations":
      return { kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] };
    case "veto-decision":
      return p.options.some((o) => o.id === PLAYER)
        ? { kind: "veto-decision", use: true, save: PLAYER }
        : { kind: "veto-decision", use: false };
    case "comp-intent":
      return { kind: "comp-intent", intent: "compete" };
    case "comp-round":
      return { kind: "comp-round", intent: "compete" }; // 0006 staged-rounds
    case "houseguests-choice":
      return { kind: "houseguests-choice", vote: p.options[0]!.id };
    case "replacement":
      return { kind: "replacement", replacement: p.options[0]!.id };
    case "eviction-vote":
      return { kind: "eviction-vote", vote: p.options[0]!.id };
    case "tie-break":
      return { kind: "tie-break", vote: p.options[0]!.id };
    case "final-eviction":
      return { kind: "final-eviction", vote: p.options[0]!.id };
    case "finale-statement":
      return { kind: "finale-statement", statement: "I played my own game." };
    case "finale-answer":
      return { kind: "finale-answer", appeal: p.appeals?.[0] ?? "own-game" };
    case "juror-vote":
      return { kind: "juror-vote", vote: p.options[0]!.id };
    case "goodbye-message":
      return { kind: "goodbye-message", vote: "respectful" };
    case "exit-interview": // 0130 — the player-evictee's posture rides `vote`, like a goodbye tone.
      return { kind: "exit-interview", vote: "gracious" };
    case "spectator-choice": // 0133
      return { kind: "spectator-choice", vote: "watch" };
    case "secret-veto": // 0025 reactive twists (default ON since 2026-11-03): the player holds the sealed one-time safety and is on the block — every arm HOLDS it (arms stay comparable)
      return { kind: "secret-veto", use: false };
    case "finale-interview":
      return { kind: "finale-interview", vote: "gracious" };
    case "juror-question":
      return { kind: "juror-question", statement: "What was your biggest move?" };
    default:
      throw new Error(`unhandled pending kind: ${p.kind}`);
  }
}

/**
 * The MINIMAL-ACTIVE decision policy — the passive answers PLUS basic self-preservation: never
 * nominate or vote out an ALLY (the two houseguests the player bonds with each season). The social
 * scenes that build those allies are recorded out-of-band in `recordEarlyScenes` below.
 */
function activeAnswer(p: PendingView, allies: ReadonlySet<string>): Record<string, unknown> {
  const notAlly = (o: NamedRef) => !allies.has(o.id) && o.id !== PLAYER;
  switch (p.kind) {
    case "nominations": {
      const targets = p.options.filter(notAlly).map((o) => o.id);
      const choice = targets.length >= 2 ? [targets[0]!, targets[1]!] : [p.options[0]!.id, p.options[1]!.id];
      return { kind: "nominations", choice };
    }
    case "eviction-vote": {
      const target = p.options.find(notAlly) ?? p.options[0]!;
      return { kind: "eviction-vote", vote: target.id };
    }
    case "tie-break": {
      const target = p.options.find(notAlly) ?? p.options[0]!;
      return { kind: "tie-break", vote: target.id };
    }
    case "final-eviction": {
      const target = p.options.find(notAlly) ?? p.options[0]!;
      return { kind: "final-eviction", vote: target.id };
    }
    case "replacement": {
      const target = p.options.find(notAlly) ?? p.options[0]!;
      return { kind: "replacement", replacement: target.id };
    }
    default:
      return passiveAnswer(p);
  }
}

/** Play one full passive season for a seed; return the player's final public seat + whether they won. */
async function playPassive(resolver: Resolver, seed: number): Promise<{ status: Status; won: boolean }> {
  const mcp = resolver("player", `grad-passive-${seed}`);
  // Pin the player archetype to the historical default ("floater"): #529 stopped fabricating a
  // default archetype (absence ⇒ neutral 0.5 stats), which would shift this seeded calibration band.
  // The calibration player is a synthetic fixture, so it states its archetype explicitly.
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  return runToEnd(mcp, (p) => passiveAnswer(p));
}

/** Play one full minimal-active season for a seed; the player bonds with two fixed allies and protects them. */
async function playActive(resolver: Resolver, seed: number): Promise<{ status: Status; won: boolean }> {
  const mcp = resolver("player", `grad-active-${seed}`);
  // Pin the player archetype to the historical default ("floater"): #529 stopped fabricating a
  // default archetype (absence ⇒ neutral 0.5 stats), which would shift this seeded calibration band.
  // The calibration player is a synthetic fixture, so it states its archetype explicitly.
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });

  const state0 = (await mcp.callTool("getGameState", {})) as StateView;
  const allyIds = (state0.house ?? [])
    .filter((h) => h.status === "active" && h.id !== PLAYER)
    .map((h) => h.id)
    .slice(0, 2);
  const allies = new Set(allyIds);

  await recordEarlyScenes(mcp, allyIds);
  return runToEnd(mcp, (p) => activeAnswer(p, allies));
}

/** Record a small, bounded set of player-witnessed bonding/alliance scenes (0023 hidden fold). */
async function recordEarlyScenes(mcp: Mcp, allyIds: string[]): Promise<void> {
  const kinds = ["bonding", "alliance", "strategy"] as const;
  for (const ally of allyIds) {
    for (let i = 0; i < SCENES_PER_ALLY; i++) {
      await mcp.callTool("recordInteraction", {
        initiator: PLAYER,
        witnessSet: [PLAYER, ally],
        content: "A quiet conversation building trust.",
        kind: kinds[i % kinds.length],
      });
    }
  }
}

/** Drive a season to completion with the given answer policy; returns the player's final seat + win. */
async function runToEnd(
  mcp: Mcp,
  answer: (p: PendingView) => Record<string, unknown>,
): Promise<{ status: Status; won: boolean }> {
  let finished = false;
  let winner: { id: string } | null = null;
  for (let i = 0; i < 5_000 && !finished; i++) {
    const adv = (await mcp.callTool("advanceGame", {})) as AdvanceResult & { winner?: { id: string } | null };
    finished = adv.finished;
    winner = adv.winner ?? winner;
    if ((adv as { held?: unknown }).held) await endHeldNight((n, a) => mcp.callTool(n, a), `gr${i}`, undefined, { direct: true }); // ORW-116: a held night is the player's - time passes, then they turn in
    if (adv.pending) {
      const sub = (await mcp.callTool("submitDecision", answer(adv.pending))) as AdvanceResult & { winner?: { id: string } | null };
      finished = sub.finished;
      winner = sub.winner ?? winner;
    }
  }
  if (!finished) throw new Error("season must finish");
  const state = (await mcp.callTool("getGameState", {})) as StateView;
  return { status: state.player!.status, won: winner?.id === PLAYER };
}

/**
 * Play one seed's passive+active pair through the production composition (`composeRuntime`, pure
 * turn-driven — the only mode; no wall-clock watcher) and return its public measurement. Per-seed seeded,
 * so this is order-independent and runnable in any shard. Each call composes its OWN runtime so
 * shards never share registry state.
 */
export async function playSeed(seed: number): Promise<GradientResult> {
  process.env.ORWELL_BEDTIME_GATE = "0"; // ORW-116: the sim player turns in directly when a night is held (the bedtime gate is a separate narrator-facing guard; the night HOLD stays fully on)
  const runtime = composeRuntime({
    clock: new FakeClock(),
        seed: 1,
  });
  const resolver = runtime.registry.resolver();
  const passive = await playPassive(resolver, seed);
  const active = await playActive(resolver, seed);
  return { seed, passive, active };
}

/** Play a contiguous, inclusive-exclusive seed slice `[from, to)` and return its measurements in order. */
export async function playSeeds(from: number, to: number): Promise<GradientResult[]> {
  const results: GradientResult[] = [];
  for (let seed = from; seed < to; seed++) results.push(await playSeed(seed));
  return results;
}

/** Compute the contiguous seed range `[from, to)` (1-based seeds 1..SEEDS) for shard `index` of `count`. */
export function shardRange(index: number, count: number): { from: number; to: number } {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count) {
    throw new Error(`invalid shard ${index}/${count}`);
  }
  const base = Math.floor(SEEDS / count);
  const extra = SEEDS % count;
  const start = index * base + Math.min(index, extra);
  const len = base + (index < extra ? 1 : 0);
  const from = 1 + start;
  return { from, to: from + len };
}

/**
 * THE aggregate assertion — the SAME monotonic band the pre-shard single-file gate ran, now
 * computed over the recombined full set. Takes the results for ALL of seeds 1..SEEDS (in any order);
 * throws (with role-only detail) if the gradient band is violated.
 *
 * `expect` is injected so this module stays test-runner-agnostic (no vitest import at module scope —
 * it is imported by the shard runner too, which already has its own `expect`).
 */
/** Two-proportion z-test stance (z = 1.28 ⇒ an 80% interval, matching the PO bands): is the ACTIVE rate lower than the PASSIVE rate by more than the sampling noise of their difference? */
export function activeWorseThanPassiveBeyondNoise(kPassive: number, kActive: number, n: number, z: number = 1.28): boolean {
  const pP = kPassive / n, pA = kActive / n;
  const se = Math.sqrt((pP * (1 - pP)) / n + (pA * (1 - pA)) / n);
  return pP - pA > z * se;
}

export function assertGradient(
  results: readonly GradientResult[],
  expect: (actual: unknown, message?: string) => {
    toBe(v: unknown): void;
    toBeGreaterThanOrEqual(v: number): void;
  },
): void {
  const bySeed = new Map<number, GradientResult>();
  for (const r of results) bySeed.set(r.seed, r);
  const missing: number[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) if (!bySeed.has(seed)) missing.push(seed);
  expect(missing.length, `aggregate must cover all ${SEEDS} seeds; missing: ${missing.join(", ")}`).toBe(0);
  expect(bySeed.size, `aggregate must hold exactly ${SEEDS} unique seed results, got ${bySeed.size}`).toBe(SEEDS);

  const ordered = Array.from(bySeed.values()).sort((a, b) => a.seed - b.seed);
  let passiveReach = 0, activeReach = 0;
  let passiveWins = 0, activeWins = 0;
  const passiveSeats: Status[] = [];
  const activeSeats: Status[] = [];
  for (const r of ordered) {
    passiveSeats.push(r.passive.status);
    activeSeats.push(r.active.status);
    if (r.passive.status !== "evicted") passiveReach++;
    if (r.active.status !== "evicted") activeReach++;
    if (r.passive.won) passiveWins++;
    if (r.active.won) activeWins++;
  }

  const detail =
    `passive reach=${passiveReach}/${SEEDS} (${passiveSeats.join(",")}) wins=${passiveWins} | ` +
    `active reach=${activeReach}/${SEEDS} (${activeSeats.join(",")}) wins=${activeWins}`;

  // THE GRADIENT: playing a basic social game is never a DISADVANTAGE. Active must reach the jury at
  // least as often as passive, and win at least as often — the monotonic property calibration must
  // always preserve.
  // NOISE-AWARE (the same stance as `poTargetBands.beatsBeyondNoise`, #2026): active play is a FAILURE only when it is WORSE than passive BEYOND sampling noise
  // (two-proportion SE × z=1.28, an 80% interval). A point check ("active reach ≥ passive") over 6 seeds is a coin flip — measured at 60 seeds on plain main, passive reached
  // the jury 46/60 and active 45/60 with 1 win each — so a one-seed miss is noise, while a REAL gap (e.g. passive 6/6 vs active 4/6) still trips it.
  expect(activeWorseThanPassiveBeyondNoise(passiveReach, activeReach, SEEDS), `active jury-reach must not be WORSE than passive beyond sampling noise — ${detail}`).toBe(false);
  expect(activeWorseThanPassiveBeyondNoise(passiveWins, activeWins, SEEDS), `active wins must not be WORSE than passive beyond sampling noise — ${detail}`).toBe(false);
  // Sanity floor (a meaningful run, not two degenerate all-evicted sweeps).
  expect(activeReach, `active play must reach the endgame in some season — ${detail}`).toBeGreaterThanOrEqual(1);
}
