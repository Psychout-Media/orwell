import type { GameSessionRegistry, UserSandbox } from "./registry";
import type { Clock } from "../ports/Clock";
import type { SessionSnapshot } from "../engine/sessionSnapshot";
import { toGameState, sessionCoreCounts, sessionCoreCountsNonDecreasing, sessionCoreIsSuperset } from "../engine/sessionSnapshot";
import { counts, isSuperset, countsNonDecreasing } from "../domain/saveState";
import { richOffscreenStretch } from "../engine/offscreen";
import { scaleImpactByValence, natureFoldImpact } from "../engine/relationshipConstants";
import { rollOverhears } from "../engine/presence";
import { spreadForScenes } from "../engine/copresenceSpread";
import { diffuseGossip, makeSocialGraph, rumorFrom, gossipEdgeAffinity, GOSSIP } from "../engine/gossip";
import { confessionalFor, recordConfessional, selectRecentForConfessional } from "../engine/confessionals";
import { nextHouseEvent, dayOfWeek } from "../engine/houseEvents";
import { SOCIETY_TICK_HOURS } from "../engine/sleepConstants";
import { SeededRandom } from "../adapters/random/SeededRandom";
import { hashSeed } from "../engine/characterFactory";
import { milestoneDue } from "../engine/daySchedule";
import { liveHouseEvent, isCompOrCeremonyKind } from "../engine/houseEvent";
import { PLAYER } from "../domain/ids";
import type { EntityId } from "../domain/ids";
import type { VoiceProfile } from "../domain/voiceProfile";
import { TurnRefusedError, PersistFailureError } from "../domain/errors";

/**
 * Per-sandbox game orchestrator (feature 0031). The SINGLE path that moves a game:
 *
 *   advance() → off-screen NPC tick → (player-turn) a meaningful scheduled day →
 *              consequence fold → integrity checkpoint (fail-closed) → persist.
 *
 * Pure-logic and seed-deterministic: identical seed + identical trigger sequence
 * ⇒ identical state. The house lives ONLY on the player's play-clock (real-time purge
 * 2026-07-10, PO ruling): every committed player turn fires ONE bounded off-screen
 * tick — there is NO wall-clock watcher and NO real-world clock, so nothing advances a
 * game while the player is away. The checkpoint is fail-closed: an advance that would
 * drop persisted detail or leak hidden state is refused, the prior save is left intact,
 * and a fault is recorded — never a degraded/leaky commit (mandate #4).
 */
/**
 * ORW-232 slice 3 / ORW-256 (Ryne 2026-11-10): while a staged competition is running everyone is out in it, so a commit inside it earns no private off-screen scenes. Applies only to a game a
 * person is PLAYING on the live clock (`messageMode`): a headless calibration / UAT driver never announces messages and keeps its long-standing tick cadence byte-for-byte (suppressing ticks
 * would shift the shared per-user rng stream and re-roll whole seeded seasons - measured: it moved the jury-reach reweight band's seed 10). Pure.
 */
export function competitionSuppressesPrivateScenes(clockLive: boolean, messageMode: boolean, baselineInCompetition: boolean, candidateInCompetition: boolean): boolean {
  return clockLive && messageMode && (baselineInCompetition || candidateInCompetition);
}

/**
 * ORW-256 (Ryne 2026-11-10): the background world runs in proportion to ELAPSED game time, but only the kind of life the hours allow. Pure.
 *  - sleep (`slept`: the commit rolled the day over): nobody schemes (no scenes, deals, alliances, gossip) - only INNER processing, one mood-settling step per SOCIETY_TICK_HOURS slept (cap SETTLE_CAP).
 *  - waking beat: the base tick already stands for the first SOCIETY_TICK_HOURS; each further whole SOCIETY_TICK_HOURS earns one more tick (cap EXTRA_TICK_CAP), as chat already does.
 *  - competition hours never reach here (the commit is suppressed above: everything in a comp is public, its effects ride the crown's own fold).
 *  - `playing` false (a headless calibration/UAT driver: clock off or no announced messages) => nothing, so the seeded per-user rng stream is byte-identical.
 */
export const EXTRA_TICK_CAP = 3;
export const SETTLE_CAP = 4;
export function elapsedWorldPlan(playing: boolean, slept: boolean, elapsedHours: number): { extraTicks: number; settleSteps: number } {
  if (!playing || !(elapsedHours > 0)) return { extraTicks: 0, settleSteps: 0 };
  const units = Math.floor(elapsedHours / SOCIETY_TICK_HOURS);
  if (slept) return { extraTicks: 0, settleSteps: Math.min(SETTLE_CAP, units) };
  return { extraTicks: Math.min(EXTRA_TICK_CAP, Math.max(0, units - 1)), settleSteps: 0 };
}

export type Trigger = "player-turn" | "offscreen-tick" | "audit";

export interface Fault {
  when: number;
  /** `persist-failure` is its OWN class (audit E7): a disk failure is never misread as degradation. */
  kind: "degradation" | "no-daily-event" | "vault-leak" | "persist-failure";
}

/** Vault-free health metadata for God Mode (0016) — never game content, never Vault. */
export interface HealthRecord {
  user: string;
  started: boolean;
  week: number;
  phase: string;
  lastAdvanceAt: number | null;
  lastTrigger: Trigger | null;
  eventCount: number;
  lastIntegrity: "ok" | "fault";
  faults: Fault[];
  /**
   * The circuit breaker (B58/audit E6): true after `BREAKER_THRESHOLD` consecutive STATE-INTEGRITY
   * faults (degradation / vault-leak / no-daily-event) — the turn-driven off-screen tick SKIPS this
   * sandbox (no identical blind retries) until a successful player-turn commit closes the circuit
   * again. `persist-failure` NEVER opens it (#1106 follow-through of audit E7): a disk blip is
   * environmental, not corruption — the breaker is God Mode's "state integrity broke repeatedly"
   * alarm, and E7's whole point was that an I/O failure must never be misread as degradation. A
   * persist-failure is still fail-closed (rolled back, typed, recorded in `faults`) — it just
   * neither advances nor resets the corruption streak.
   */
  circuitOpen: boolean;
}

export interface AdvanceResult {
  events: number;
  integrity: "ok" | "fault";
  faults: Fault[];
}

export interface OrchestratorConfig {
  seed?: number;
  /** Off-screen scenes per tick (B59 — finally a REAL knob; previously hard-coded in the apply step). */
  offscreenInteractions?: number;
  /** Test seam: override the state-mutating step (off-screen + day). Default = the real one. */
  apply?: (sandbox: UserSandbox, trigger: Trigger, rng: SeededRandom, clockNow: number, interactions?: number) => number;
  /**
   * Pure turn-driven mode — the ONLY way the house lives (real-time purge 2026-07-10): there is no
   * wall-clock watcher, so every committed player turn fires ONE bounded off-screen tick so the
   * house lives on the player's play-clock alone (B41/audit D4/M6). Default false (off ⇒ the house
   * never advances on its own — used by the seeded calibration spine).
   */
  turnDriven?: boolean;
  /**
   * Auxiliary-commit tick debounce (audit E57/R5): a beat commit (the live loop moved) always earns
   * its tick, but auxiliary tool calls inside the SAME player turn (recordInteraction + diaryRoom +
   * a read…) must not each fire one — one bounded tick per player TURN, not per tool call. An aux
   * commit ticks only when this many play-clock steps have passed since the user's last turn tick.
   * (Under the always-on logical clock the runtime sets `auxTicksNever` instead — see below.)
   */
  auxTickDebounceMs?: number;
  /**
   * 0108/M0-9 — deterministic tick pacing for the golden record/replay seam. Under the always-on
   * logical clock (real-time purge 2026-07-10) every commit advances "time" by a full step, so the
   * play-clock aux debounce above NEVER absorbs (60s > 10s on every aux commit) and the house would
   * tick once per TOOL CALL instead of once per turn. Worse than the E57 regression it resurrects:
   * per-turn commit counts vary with the model's live round pacing (a stream-timing continuation is
   * ±1 round record-vs-replay), so tick counts — and everything presence-sampled at turn boundaries
   * (seating, dwell, the 0076 movement cue) — fork the replay keys. With this flag an aux commit
   * NEVER ticks: the off-screen tick fires only on progressed (beat) commits, which replay
   * identically. Set by `composeRuntime` for the production runtime (the only clock is now logical).
   */
  auxTicksNever?: boolean;
}

export class Orchestrator {
  /** Consecutive STATE-INTEGRITY faults that OPEN the circuit (off-screen ticks skip the sandbox).
   *  B58/E6; #1106: `persist-failure` is excluded — see `isStateFault`. The threshold is CONFIRMED
   *  safe for a contested beat (#1106 ask (a)): the circuit only ever gates off-screen enrichment
   *  ticks — `commitPlayerTurn` NEVER skips on an open circuit, so a contested eviction can always
   *  commit the moment a clean turn lands (tests/unit/contestedEvictionIntegrity.test.ts). */
  private static readonly BREAKER_THRESHOLD = 3;
  /** Stored-fault cap per sandbox — health keeps the most recent, never an unbounded log. */
  private static readonly MAX_STORED_FAULTS = 20;
  /** Default aux-commit tick debounce (E57/R5): tool calls inside one turn land within seconds. */
  private static readonly AUX_TICK_DEBOUNCE_MS = 10_000;
  /** R3 — re-run a FULL (untrusted-prefix) event-content re-scan at least this often, per user, as cheap
   *  belt-and-suspenders; between full checks the immutable append-only event prefix is trusted (O(Δ)).
   *  Not a standalone integrity guarantee — see `trustEventPrefixFor` for what every commit still proves. */
  private static readonly R3_FULL_CHECK_EVERY = 32;

  private readonly seed: number;
  private readonly offscreenInteractions: number;
  private readonly applyFn: NonNullable<OrchestratorConfig["apply"]>;
  private readonly turnDriven: boolean;
  private readonly auxTickDebounceMs: number;
  private readonly auxTicksNever: boolean;
  private readonly rngs = new Map<string, SeededRandom>();
  private readonly health = new Map<string, HealthRecord>();
  private readonly lastActivity = new Map<string, number>();
  /** Consecutive integrity faults per user (any success resets it). B58/E6. */
  private readonly consecutiveFaults = new Map<string, number>();
  /** The last GOOD persisted state per user — the baseline a player-turn commit checks against (B41). */
  private readonly baselines = new Map<string, SessionSnapshot>();
  /** Wall time of the user's last turn-driven off-screen tick (the E57 debounce anchor). */
  private readonly lastTurnTickAt = new Map<string, number>();
  /** 0117 — the in-game clock-HOUR at which the house last lived for this user. The social-play society
   *  tick is debounced on ELAPSED in-game hours (SOCIETY_TICK_HOURS) so the house schemes "with the
   *  clock", not once per tool call. Set on every fired tick (beat and social alike); cleared on reset. */
  private readonly lastSocietyTickHour = new Map<string, number>();
  /** ORW-256 - the ABSOLUTE in-game hour (day*24 + clock hour; never wraps at midnight) of the user's last society tick, so a beat/sleep commit knows how much game time it covered. */
  private readonly lastSocietyTickAbs = new Map<string, number>();
  /** R3 — commits since this user's last FULL (untrusted-prefix) non-degradation verification. */
  private readonly commitsSinceFullCheck = new Map<string, number>();
  private seq = 0;

  constructor(
    private readonly registry: GameSessionRegistry,
    private readonly clock: Clock,
    cfg: OrchestratorConfig = {},
  ) {
    this.seed = cfg.seed ?? 1;
    this.offscreenInteractions = cfg.offscreenInteractions ?? 3; // matches the long-standing live cadence
    this.applyFn = cfg.apply ?? defaultApply;
    this.turnDriven = cfg.turnDriven ?? false;
    this.auxTickDebounceMs = cfg.auxTickDebounceMs ?? Orchestrator.AUX_TICK_DEBOUNCE_MS;
    this.auxTicksNever = cfg.auxTicksNever ?? false;
  }

  /**
   * Drop every per-user trace of a DEAD season (audit E1/D1/R1) — baselines, faults, health, rng
   * stream, idle/tick clocks. Wired as the registry's `onReset` hook, so the ONE sanctioned restart
   * door (`registry.resetUser` — reached by the admin reset AND by a confirmed player-channel
   * `createCharacter` restart) invalidates the old season's non-degradation baseline. Without this,
   * season 2's first commit reads as a count regression against the finished season ⇒ a degradation
   * fault on every turn, nothing persists, and the dead season resurrects on engine restart.
   */
  forgetUser(user: string): void {
    this.baselines.delete(user);
    this.health.delete(user);
    this.rngs.delete(user);
    this.lastActivity.delete(user);
    this.consecutiveFaults.delete(user);
    this.lastTurnTickAt.delete(user);
    this.lastSocietyTickHour.delete(user);
  }

  /**
   * Seed the non-degradation baseline from the user's CURRENT (just-resumed) state (audit E6).
   * Called by the runtime's boot preload: without it, the first commit after an engine restart was
   * checkpoint-blind — the guard had a hole exactly at resume-from-disk, where the historical
   * memory-thinning bug lived.
   *
   * R3 (incremental-snapshot cache): a re-baseline runs precisely BECAUSE the live session state was
   * just set/replaced from OUTSIDE the `commit` seam — a resume-from-disk, or a `session.restore` that
   * swaps a field (e.g. the 0062 world snapshot) WITHOUT appending an event. Such a mutation bumps
   * neither the registry's snapshot rev nor the event count, so a cached export can be STALE relative to
   * the live truth. The baseline must be the current state, never a point-in-time capture from before the
   * external mutation — so invalidate the cache first and read fresh (the same `invalidateSnapshot`
   * discipline `advance` uses after its off-screen `applyFn`). Without this the checkpoint compares a
   * stale baseline to the freshly-mutated candidate and wrongly refuses the next turn as degradation.
   */
  seedBaseline(user: string): void {
    this.registry.invalidateSnapshot(user);
    this.baselines.set(user, this.registry.snapshot(user));
  }

  /** Per-user deterministic RNG stream (seed + user), created once and advanced across ticks. */
  private rngFor(user: string): SeededRandom {
    let r = this.rngs.get(user);
    if (!r) {
      r = new SeededRandom(hashSeed(`${this.seed}:${user}`));
      this.rngs.set(user, r);
    }
    return r;
  }

  /** Mark a player-driven moment of activity (records the play-clock stamp of the last turn). Still
   *  used by presence (0049) to tell milling/activity apart from idleness — not a watcher gate. */
  touch(user: string): void {
    this.lastActivity.set(user, this.clock.now());
  }

  /**
   * Play-clock stamp of the user's last player activity. A user who has NEVER taken a turn returns
   * `+Infinity` (B41/audit D4). Presence (0049) reads this to distinguish an active player from an
   * idle one; it is NOT a wall-clock gate (there is no watcher — the house lives per committed turn).
   * (The old `−Infinity` made every never-touched user permanently "idle" ⇒ the off-screen flood.)
   */
  idleSince(user: string): number {
    return this.lastActivity.has(user) ? this.lastActivity.get(user)! : Infinity;
  }

  /** Is the user's circuit open (B58/E6)? Off-screen ticks skip; a good player turn closes it. */
  private circuitOpen(user: string): boolean {
    return (this.consecutiveFaults.get(user) ?? 0) >= Orchestrator.BREAKER_THRESHOLD;
  }

  /**
   * Is this fault kind a STATE-INTEGRITY fault (#1106 / audit E7)? Degradation, vault-leak and
   * no-daily-event are deterministic functions of game state — a blind retry reproduces them, which
   * is exactly what the circuit exists to stop. `persist-failure` is ENVIRONMENTAL (a disk blip):
   * the state itself passed the checkpoint, so it must neither advance nor reset the corruption
   * streak — E7 split the fault class so an I/O failure is never misread as degradation, and the
   * breaker (God Mode's corruption alarm) honors the same split.
   */
  private static isStateFault(kind: Fault["kind"]): boolean {
    return kind !== "persist-failure";
  }

  /** Advance the consecutive-STATE-fault streak for a fault batch (persist-failures don't move it). */
  private countFaults(user: string, faults: Fault[]): void {
    if (faults.some((f) => Orchestrator.isStateFault(f.kind))) {
      this.consecutiveFaults.set(user, (this.consecutiveFaults.get(user) ?? 0) + 1);
    }
  }

  /** How many LIVING NPCs the off-screen society can draw on (B52: evictees stop living).
   *  No started game ⇒ ZERO (audit E2): the pre-game interview has no house to scheme in — an
   *  off-screen tick before move-in would fabricate hidden history with houseguests that don't
   *  exist yet (and non-degradation would forbid ever deleting it). */
  private offscreenPoolSize(user: string): number {
    const core = this.registry.sandboxFor(user).session.snapshot();
    if (!core.started || !core.house) return 0;
    const evicted = new Set(core.live?.evictionOrder ?? []);
    return core.house.npcs.filter((n) => !evicted.has(n.id)).length;
  }

  /** Surface a fault where an operator can see it (B58/E6) — stderr, with user + kinds. */
  private logFaults(user: string, trigger: Trigger, faults: Fault[]): void {
    console.error(
      `[orwell] integrity fault user=${user} trigger=${trigger} kinds=${faults.map((f) => f.kind).join(",")}` +
      (this.circuitOpen(user) ? " circuit=OPEN" : ""),
    );
  }

  /** The one advance spine. `audit` verifies only (no progression).
   *  `supplementary` (A9): a turn-driven off-screen tick that rides ON TOP of a player turn the
   *  live loop already moved — it is pure society enrichment, so a tick that legitimately has
   *  nothing to add is a clean no-op, not a `no-daily-event` fault (the daily-event invariant is
   *  the live loop's own beats, not this supplementary tick). Non-degradation and the Vault Wall are
   *  still enforced. A direct off-screen tick (no flag) keeps the daily-event check. */
  advance(user: string, trigger: Trigger, opts: { baseline?: SessionSnapshot; supplementary?: boolean; rng?: SeededRandom } = {}): AdvanceResult {
    // The circuit breaker (B58/E6): after repeated identical faults, off-screen ticks SKIP this
    // sandbox instead of blindly retrying — the flag shows in health; a good player turn resets it.
    if (trigger === "offscreen-tick" && this.circuitOpen(user)) {
      return { events: 0, integrity: "fault", faults: this.health.get(user)?.faults.slice(-1) ?? [] };
    }
    // Deep endgame (0044 follow-through of the B52 rule): with fewer than two LIVING NPCs there is
    // no off-screen society left to run — e.g. the player standing in the Final 2, or no started
    // game at all (E2: the pool is zero pre-game). That tick is a clean no-op, NOT an integrity
    // fault: the daily-event invariant belongs to the live loop's own beats (the finale is full of
    // them), and flagging the empty house would log a false fault on every finale turn of a
    // healthy, player-won game.
    if (trigger === "offscreen-tick" && this.offscreenPoolSize(user) < 2) {
      return { events: 0, integrity: "ok", faults: [] };
    }
    const sandbox = this.registry.sandboxFor(user);
    // R3: a caller that JUST exported this exact state (the turn-driven tick runs right after its
    // commit stored the candidate) hands the snapshot over instead of paying a second O(events)
    // serialization — the per-mutation cost was ~4 full exports, quadratic over a season.
    const baseline = opts.baseline ?? this.registry.snapshot(user);

    let produced = 0;
    if (trigger !== "audit") {
      produced = this.applyFn(sandbox, trigger, opts.rng ?? this.rngFor(user), this.clock.now(), this.offscreenInteractions);
      // R3 — `applyFn` mutated the sandbox OUTSIDE the `commit` seam (it never fires `onPersist`), so the
      // registry's snapshot cache must be invalidated before we read the candidate, or it would hand back
      // the pre-tick capture. (An `audit` produces nothing, so its candidate IS the current cache.)
      this.registry.invalidateSnapshot(user);
    }

    const candidate = this.registry.snapshot(user);
    // R3: audits always full-verify (rare, and never count toward the fast-path window).
    const trustEventPrefix = trigger !== "audit" && this.trustEventPrefixFor(user);
    const faults = this.checkpoint(baseline, candidate, sandbox, trigger,
      { ...(opts.supplementary ? { requireDailyEvent: false } : {}), trustEventPrefix });
    const when = this.clock.now();

    if (faults.length === 0) {
      if (trigger !== "audit") {
        try {
          this.registry.saveUser(user, candidate);
        } catch {
          // #1106/E7 — the TICK's durable save failed (disk). Before this guard the raw error (path
          // and all) escaped PAST the caller's already-committed player turn: the whole request
          // failed unclassified AFTER the turn durably saved (inviting an FE retry/double-apply),
          // memory silently held tick state the disk didn't, and health recorded nothing. Fail the
          // TICK closed instead: roll the enrichment back to the baseline (memory matches the last
          // durable save again), record its persist-failure fault (E7's own class — it never opens
          // the state circuit), and return a fault result — the committed player turn STANDS (the
          // supplementary tick is enrichment, not the turn).
          const f: Fault[] = [{ when, kind: "persist-failure" }];
          this.registry.restore(user, baseline);
          this.countFaults(user, f);
          this.logFaults(user, trigger, f);
          const failPrior = this.health.get(user);
          this.recordHealth(user, this.registry.sandboxFor(user), trigger, when, "fault",
            [...(failPrior?.faults ?? []), ...f].slice(-Orchestrator.MAX_STORED_FAULTS));
          return { events: 0, integrity: "fault", faults: f };
        }
        this.baselines.set(user, candidate);
      }
      // Only a clean STATE-CHANGING advance closes the circuit (#1380 review): an `audit` is a
      // read-only verification — after a fault's rollback it compares the healthy baseline to
      // itself, so letting it reset the streak would silently re-enable off-screen ticks without
      // any successful commit having happened. A clean player-turn (also via `commitPlayerTurn`)
      // or a clean DIRECT off-screen tick (which ran the full checkpoint AND persisted) is real
      // evidence of health — and a tick can only run while the circuit is still CLOSED (open ⇒
      // skipped above), so once OPEN the only closer is a successful player-turn commit, exactly
      // what the `HealthRecord.circuitOpen` contract promises.
      if (trigger !== "audit") this.consecutiveFaults.set(user, 0);
      if (trigger === "player-turn") this.touch(user);
      this.recordHealth(user, this.registry.sandboxFor(user), trigger, when, "ok");
      return { events: produced, integrity: "ok", faults: [] };
    }

    // Fail-closed: roll the in-memory sandbox back to the baseline (clean rebuild,
    // no aborted events left behind) and DO NOT persist. The prior save is intact.
    if (trigger !== "audit") this.registry.restore(user, baseline);
    this.countFaults(user, faults); // state faults only — a persist blip never opens the circuit
    this.logFaults(user, trigger, faults);
    const prior = this.health.get(user);
    const allFaults = [...(prior?.faults ?? []), ...faults].slice(-Orchestrator.MAX_STORED_FAULTS);
    this.recordHealth(user, this.registry.sandboxFor(user), trigger, when, "fault", allFaults);
    return { events: 0, integrity: "fault", faults };
  }

  /**
   * The player-turn commit (B41/audit E3) — the orchestrator becomes the real spine. The registry
   * routes its save-on-mutation `onPersist` here, so EVERY player mutation now runs the fail-closed
   * integrity checkpoint instead of persisting blindly: a leaky/degrading commit is rolled back and
   * NOT saved (mandate #4). It also `touch`es the user (recording play-clock activity for presence)
   * and, in pure turn-driven mode, fires ONE bounded off-screen tick so the house lives turn-to-turn
   * on the player's play-clock alone (real-time purge 2026-07-10 — there is no wall-clock watcher).
   *
   * A refused commit FAILS THE REQUEST (audit E3/D1): the rollback throws a typed error the HTTP
   * boundary maps to 4xx/5xx — never a 200 whose view narrates a beat that officially never
   * happened ("narrated but never recorded" at the engine seam).
   */
  commitPlayerTurn(user: string): void {
    const sandbox = this.registry.sandboxFor(user);
    const candidate = this.registry.snapshot(user);
    const when = this.clock.now();
    const baseline = this.baselines.get(user);

    // The first commit (e.g. createCharacter) has no prior good state — accept it and establish the
    // baseline; there is nothing to degrade away from. (A season RESTART through the one sanctioned
    // door lands here too: `forgetUser` cleared the dead season's baseline, so week 1 of season 2
    // is a first commit again, not a count regression against a finished season — E1/R1.)
    const faults = baseline
      ? this.checkpoint(baseline, candidate, sandbox, "player-turn",
          { requireDailyEvent: false, trustEventPrefix: this.trustEventPrefixFor(user) })
      : [];

    if (faults.length === 0) {
      try {
        this.registry.saveUser(user, candidate); // R3: reuse the exported snapshot — no re-serialize
      } catch {
        // E7: the SAVE itself failed (disk). Its own fault class — never fail-open (the turn must
        // not proceed unsaved), never misclassified as the caller's fault, no path in the message.
        this.recordFault(user, "player-turn", when, [{ when, kind: "persist-failure" }], baseline);
        throw new PersistFailureError();
      }
      this.consecutiveFaults.set(user, 0); // a good player turn closes the circuit (B58/E6)
      this.baselines.set(user, candidate);
      this.touch(user);
      this.maybeTurnDrivenTick(user, baseline, candidate); // may record an offscreen-tick health entry…
      this.recordHealth(user, this.registry.sandboxFor(user), "player-turn", when, "ok"); // …player-turn has the last word
      return;
    }
    // Fail-closed: roll the in-memory sandbox back to the last good state, DO NOT persist, and
    // surface the refusal as an ERROR to the caller (E3) — state unchanged, request failed.
    this.recordFault(user, "player-turn", when, faults, baseline);
    throw new TurnRefusedError(faults.map((f) => f.kind));
  }

  /** Roll back (when a good baseline exists), count the fault, log it, and record health. */
  private recordFault(
    user: string,
    trigger: Trigger,
    when: number,
    faults: Fault[],
    baseline: SessionSnapshot | undefined,
  ): void {
    if (baseline) this.registry.restore(user, baseline);
    this.countFaults(user, faults); // state faults only (#1106/E7) — a disk blip never opens the circuit
    this.logFaults(user, trigger, faults);
    const prior = this.health.get(user);
    this.recordHealth(user, this.registry.sandboxFor(user), trigger, when, "fault",
      [...(prior?.faults ?? []), ...faults].slice(-Orchestrator.MAX_STORED_FAULTS));
  }

  /**
   * In pure turn-driven mode, advance one bounded off-screen tick so the house lives between turns
   * (B41) — debounced to the TURN boundary (audit E57/R5): a beat commit (the live loop genuinely
   * moved — an advance, a resolved decision) always earns its tick, but the auxiliary tool calls of
   * the same player turn (recordInteraction + diaryRoom + …) share one. Without the debounce a
   * 4-tool-call turn ran 4 ticks — force-marching the house and flooding the record. Never fires
   * pre-game (audit E2): the casting interview has no house to scheme in.
   */
  private maybeTurnDrivenTick(user: string, baseline: SessionSnapshot | undefined, candidate: SessionSnapshot): void {
    if (!this.turnDriven) return;
    if (!candidate.started) return; // E2: no off-screen life before move-in
    // 0111: a PURE champagne-circle close (`champagneCircle` gathered→done, the model's first advanceGame
    // that ends the opening toast) resolves NO beat — it only un-pins the player into free-roam premiere.
    // It must earn NO off-screen society tick in ANY config: an extra premiere-night tick would perturb
    // the seeded society and break calibration byte-identity (the tie/UAT gates). Fully skip it here (the
    // real HOH-staging advance, which also clears the flag but ADDS a comp pending, is NOT a pure close and
    // still earns its tick).
    if (this.isPureChampagneClose(baseline, candidate)) return;
    // A9 (ORWELL_PREMIERE_ENTRANCES): the staged entrances + toast are premiere scenes - the house schemes only once the toast is done. A commit that is mid-entrances/toast (or the
    // one that closes the toast) earns NO off-screen tick. Flag off => the live state has no `premiereEntrance` => this never fires (byte-identical).
    const peStage = (x: SessionSnapshot | undefined): string | undefined => (x?.live as { premiereEntrance?: { stage?: string } } | undefined)?.premiereEntrance?.stage;
    if ((peStage(candidate) !== undefined && peStage(candidate) !== "done") || (peStage(baseline) !== undefined && peStage(baseline) !== "done")) return;
    // ORW-232 slice 3 / ORW-256 (Ryne 2026-11-10: "If everyone is outside in a comp, everything that happens is very public ... houseguests can't leave and make alliances or something like that"):
    // while a house event (comp or ceremony) is in session everyone is gathered in it, so a commit inside it (a round, a chat message, the crown) earns NO private off-screen scenes. Public reactions ride the
    // crown's own fold. Only a live-clock game has a competition "running" in game time; the seeded calibration spine (clock off) never reaches this, so it is byte-identical.
    // ORW-281 slice 3 (Ryne: comps and ceremonies are built the same way): ANY comp-or-ceremony house event in session (comp, veto draw, nominations, veto ceremony, eviction), via the single
    // pure derivation the adapter's houseEventInSession also uses.
    const compRunning = (x: SessionSnapshot | undefined): boolean => isCompOrCeremonyKind(liveHouseEvent(x?.live as never, { includeDraw: milestoneDue(x?.live as never) })?.kind) // the draw counts only once its morning slot is due, not for the whole idle stretch before it;
    // Only for a game a person is PLAYING: `messageModeNow()` is true once the front end announces the player's messages (noteMessage), which a headless calibration/UAT driver never does, so the
    // seeded jury-reach / UAT sims keep their long-standing tick cadence byte-for-byte (suppressing ticks shifts the shared per-user rng stream and re-rolls whole seasons).
    const sess = this.registry.sandboxFor(user).session;
    if (competitionSuppressesPrivateScenes(sess.perConversationClockLive(), sess.messageModeNow(), compRunning(baseline), compRunning(candidate))) return;
    // Did the live loop move? Beat commits change the loop state; aux commits (an interaction, a
    // DR entry, a deal) never touch it. The loop state is small — this is NOT an events re-export.
    const session = this.registry.sandboxFor(user).session;
    // Once the FE announces player messages (`noteMessage`), the announcement itself steps the in-game clock INSIDE the tool - so a clock-only change must not make this commit look like a
    // beat commit (which would earn an un-debounced society tick every message). Strip ONLY the clock fields from the comparison in that mode.
    const clockFree = (l: SessionSnapshot["live"] | undefined): string => {
      if (!l || !session.messageModeNow()) return JSON.stringify(l ?? null);
      const { nightDepth: _n, timeOfDay: _t, ...rest } = l as unknown as Record<string, unknown>;
      void _n; void _t;
      return JSON.stringify(rest);
    };
    const progressed = !baseline || !baseline.started
      || baseline.week !== candidate.week
      || baseline.phase !== candidate.phase
      || clockFree(baseline.live) !== clockFree(candidate.live);

    if (!progressed) {
      // A social (aux) turn — the live loop didn't move. Whether the house lives now turns on the clock.
      // 0117 (in-game-time pivot): when in-game time is genuinely FLOWING (master + per-conversation clock
      // on, day started), the house must keep scheming AS TIME PASSES during the player's social play —
      // not stay frozen until the next ceremony. When it is NOT flowing (the seeded calibration spine with
      // time-of-day off; golden replay with the per-conversation clock off) social turns stay inert and
      // byte-identical — exactly the old M0-9 behaviour.
      const clockLive = session.perConversationClockLive();
      if (this.auxTicksNever && !clockLive) return; // M0-9: seeded spine / golden replay — inert & byte-identical
      if (clockLive) {
        // In-game time flows on this social turn (pacing-only: it clamps at late-night and never wraps the
        // night without the player's own turnIn — ADR 0003 / the lull rule — so it can't rush an engaged
        // scene). Then let the house scheme, but debounced ON ELAPSED IN-GAME HOURS (SOCIETY_TICK_HOURS),
        // NOT once per tool call: the society lives "with the clock", roughly every couple of social turns.
        session.billClockForCommit();
        const hour = session.inGameHour();
        const lastHour = this.lastSocietyTickHour.get(user);
        if (hour !== undefined && lastHour !== undefined && hour - lastHour < SOCIETY_TICK_HOURS) return; // not enough time yet
        if (hour !== undefined) this.lastSocietyTickHour.set(user, hour);
        this.noteTickAbs(user, session);
        this.lastTurnTickAt.set(user, this.clock.now());
        this.advance(user, "offscreen-tick", { baseline: candidate, supplementary: true });
        return;
      }
      // Legacy play-clock debounce path (auxTicksNever off — the non-logical-clock test/BDD configs): one
      // bounded tick per player TURN, tool calls within a turn share it (audit E57/R5).
      const now = this.clock.now();
      const last = this.lastTurnTickAt.get(user);
      if (last !== undefined && now - last < this.auxTickDebounceMs) return; // E57/R5
      this.lastTurnTickAt.set(user, now);
      session.billClockForCommit();
      this.advance(user, "offscreen-tick", { baseline: candidate, supplementary: true });
      return;
    }

    // A beat commit — the live loop genuinely moved (an advance, a resolved decision). It ALWAYS earns its
    // tick. The per-beat clock already jumped inside advanceGame; press the per-conversation clock a small
    // step too (unchanged from before), and anchor the social-play pacing to the beat's new in-game hour so
    // the between-ceremony ticks (0117) measure from here.
    this.lastTurnTickAt.set(user, this.clock.now());
    // Then press the per-conversation clock one message-step as before (billed once per announced player message once the FE announces them - `billClockForCommit`).
    session.billClockForCommit();
    const beatHour = session.inGameHour();
    if (beatHour !== undefined) this.lastSocietyTickHour.set(user, beatHour);
    // ORW-256: how much game time did this beat cover, and was it a night? (read BEFORE re-anchoring.) Only a game a person is PLAYING gets it.
    const absNow = session.inGameAbsHour();
    const lastAbs = this.lastSocietyTickAbs.get(user);
    const slept = ((candidate.live as { dayNumber?: number } | undefined)?.dayNumber ?? 1) > ((baseline?.live as { dayNumber?: number } | undefined)?.dayNumber ?? 1);
    const plan = elapsedWorldPlan(session.perConversationClockLive() && session.messageModeNow(), slept,
      absNow !== undefined && lastAbs !== undefined ? absNow - lastAbs : 0);
    this.noteTickAbs(user, session);
    if (plan.settleSteps > 0) session.settleOvernight(plan.settleSteps); // inner processing while the house sleeps: deterministic, draws no rng
    // R3: the commit just exported this. A9: a supplementary tick — an empty society this tick is
    // a clean no-op, not a daily-event fault (the live loop owns that invariant via its beats).
    this.advance(user, "offscreen-tick", { baseline: candidate, supplementary: true });
    // ORW-256: the waking hours this beat covered beyond the first tick. Each extra tick draws from its OWN seeded side stream (user, absolute hour, index) - never the shared per-user stream the
    // competition/vote spine reads - so the seeded season is untouched and a retried commit rolls the same dice.
    for (let i = 0; i < plan.extraTicks; i++) {
      this.advance(user, "offscreen-tick", { supplementary: true, rng: new SeededRandom(hashSeed(`${this.seed}:${user}:elapsed-tick:${absNow ?? 0}:${i}`)) });
    }
    // "Hang out until X": the house lived through those hours too - one extra society tick per SOCIETY_TICK_HOURS spent (cap 3), consumed once.
    const hungHours = session.consumeHangOutHours();
    for (let i = 0, n = Math.min(3, Math.floor(hungHours / SOCIETY_TICK_HOURS)); i < n; i++) {
      this.advance(user, "offscreen-tick", { supplementary: true });
    }
  }

  private noteTickAbs(user: string, session: { inGameAbsHour(): number | undefined }): void {
    const a = session.inGameAbsHour();
    if (a !== undefined) this.lastSocietyTickAbs.set(user, a);
  }

  /**
   * 0111 — is this commit a PURE champagne-circle close? True iff the ONLY live-loop change is the
   * premiere's `champagneCircle` transitioning gathered→done (the model's first advanceGame that ends the
   * opening toast, un-pinning the player) — no week/phase change and every other live field byte-identical.
   * Such a commit resolves no beat, so it must earn no off-screen society tick (calibration byte-identity).
   * A real HOH-staging advance clears the flag AND adds a comp pending, so it fails this check and ticks.
   */
  private isPureChampagneClose(baseline: SessionSnapshot | undefined, candidate: SessionSnapshot): boolean {
    if (!baseline || !baseline.started || !candidate.started) return false;
    if (baseline.week !== candidate.week || baseline.phase !== candidate.phase) return false;
    const b = baseline.live, c = candidate.live;
    if (!b || !c) return false;
    if (b.champagneCircle !== "gathered" || c.champagneCircle !== "done") return false;
    // Every other live field must be byte-identical (compare with the flag normalized out of both).
    return JSON.stringify({ ...b, champagneCircle: undefined }) === JSON.stringify({ ...c, champagneCircle: undefined });
  }

  /**
   * R3 — whether THIS commit may trust the append-only event prefix (the O(Δ) fast path). The real
   * per-commit guarantees do NOT depend on this: a net drop of any persisted item is always caught by
   * countsNonDecreasing, the prefix boundary is always spot-checked, and every non-event dimension is
   * always fully verified. The fast path only relaxes the full EVENT-content re-scan, which the
   * append-only contract (events.record only ever APPENDS — never mutates/removes a past event) makes
   * redundant. We still force a FULL event re-scan on a user's FIRST commit and at least every
   * `R3_FULL_CHECK_EVERY` commits as cheap belt-and-suspenders. Advances the per-user counter.
   */
  private trustEventPrefixFor(user: string): boolean {
    const n = this.commitsSinceFullCheck.get(user) ?? 0;
    if (n === 0 || n >= Orchestrator.R3_FULL_CHECK_EVERY) {
      this.commitsSinceFullCheck.set(user, 1); // full check now; this commit opens the next window
      return false;
    }
    this.commitsSinceFullCheck.set(user, n + 1);
    return true;
  }

  /** Verify a candidate advance against the baseline — fail-closed (0031 §4.3). */
  checkpoint(
    baseline: SessionSnapshot,
    candidate: SessionSnapshot,
    sandbox: UserSandbox,
    trigger: Trigger = "player-turn",
    opts: { requireDailyEvent?: boolean; trustEventPrefix?: boolean } = {},
  ): Fault[] {
    const faults: Fault[] = [];
    const when = this.clock.now();
    const gsBase = toGameState(baseline);
    const gsCand = toGameState(candidate);

    // Non-degradation (0007): nothing previously persisted may be dropped. R3 — the append-only event
    // PREFIX may be trusted on the fast path (the orchestrator runs a FULL re-verification periodically);
    // every other dimension is fully verified, and a net DROP is always caught by countsNonDecreasing.
    // PERSIST-8: the 0007 GameState projection predates features 0058–0107, so it never covered the
    // newer SessionCore dimensions (deals, deepProfiles, confideState, secrets-as-power, nomination
    // history, texture overrides, …) — a regression there was invisible to this gate. `sessionCore*`
    // (src/engine/sessionSnapshot.ts) is the engine-layer companion check, same discipline, always
    // fully verified (these maps are small — no fast-path relaxation needed).
    if (!isSuperset(gsCand, gsBase, { trustEventPrefix: opts.trustEventPrefix === true })
        || !countsNonDecreasing(counts(gsCand), counts(gsBase))
        || !sessionCoreIsSuperset(candidate, baseline)
        || !sessionCoreCountsNonDecreasing(sessionCoreCounts(candidate), sessionCoreCounts(baseline))) {
      faults.push({ when, kind: "degradation" });
    }
    // Daily-event (0008): a progression advance must produce ≥1 new event. A player-turn COMMIT
    // (B41) opts out — not every player tool call adds a beat (a deal, a surfacing, a DR entry).
    const requireDailyEvent = opts.requireDailyEvent ?? trigger !== "audit";
    if (requireDailyEvent && counts(gsCand).events <= counts(gsBase).events) {
      faults.push({ when, kind: "no-daily-event" });
    }
    // Vault Wall (0001): no hidden event's content may appear in the player projection — UNLESS the
    // player legitimately holds it through a real pathway (B27b: gossip/overhears/tellings surface
    // sanctioned, traceable beliefs; flagging those would refuse every legal propagation). The 0001
    // sentinel canary remains the precise guard for content with NO pathway to the player.
    // Hidden contents are APPEND-ONLY (a hidden event is never mutated/removed — the same contract
    // `trustEventPrefix` rests on) and a vault-leak fault is TERMINAL (it rolls back, never commits) —
    // so a committed baseline holds ZERO unsanctioned hidden content in its view. On the fast path the
    // baseline's hidden PREFIX was therefore already verified leak-free; we re-scan only the hidden
    // contents NEW since the baseline against the full current view (O(Δ) rather than O(hidden×view),
    // the per-season quadratic this guard's `includes` scan was — CPU-profiled as ~88% of checkpoint
    // time). The full set is re-scanned on the first commit and at least every R3_FULL_CHECK_EVERY
    // commits (the SAME periodic belt-and-suspenders window `isSuperset`'s prefix trust uses), so the
    // rare case of an OLD hidden content newly surfacing verbatim in a re-rendered view is bounded
    // identically to the superset guard the owner sanctioned. The 0001 sentinel canary + the structural
    // Vault Wall remain the precise guards; this is the orchestrator's defense-in-depth.
    const allHidden = candidate.events.filter((e) => e.hidden).map((e) => e.content);
    const baselineHiddenCount = opts.trustEventPrefix === true
      ? baseline.events.reduce((n, e) => n + (e.hidden ? 1 : 0), 0)
      : 0;
    const hidden = baselineHiddenCount > 0 ? allHidden.slice(baselineHiddenCount) : allHidden;
    if (hidden.length > 0) {
      const view = playerSweep(sandbox);
      const playerFacts = (candidate.knowledge?.knowledge?.[PLAYER] ?? [])
        .filter((f) => /^(told-by:|overheard:|gossip|surfaced)/.test(f.pathway))
        .map((f) => f.content);
      const sanctioned = (c: string): boolean => playerFacts.some((f) => f.includes(c));
      if (hidden.some((c) => c && view.includes(c) && !sanctioned(c))) faults.push({ when, kind: "vault-leak" });
    }
    return faults;
  }

  private recordHealth(
    user: string,
    sandbox: UserSandbox,
    trigger: Trigger,
    when: number,
    integrity: "ok" | "fault",
    /**
     * #1106 forensics — when omitted (the clean-commit paths), the RECENT-FAULT RING is RETAINED, not
     * wiped: `lastIntegrity`/`circuitOpen` already say the sandbox recovered, and keeping the capped
     * ring (MAX_STORED_FAULTS) is what lets God Mode reconstruct a burst like #1106's six-fault storm
     * AFTER the next clean turn closes the circuit — previously that evidence survived only in stderr.
     * Fault paths pass the merged ring explicitly; `forgetUser` (the season door) still clears it.
     */
    faults?: Fault[],
  ): void {
    const core = sandbox.session.snapshot();
    this.health.set(user, {
      user,
      started: core.started,
      week: core.week,
      phase: core.phase,
      lastAdvanceAt: when,
      lastTrigger: trigger,
      eventCount: sandbox.engine.events.count(),
      lastIntegrity: integrity,
      faults: faults ?? this.health.get(user)?.faults ?? [],
      circuitOpen: this.circuitOpen(user),
    });
  }

  /** Vault-free health metadata for God Mode (0016). Per-user, or all sandboxes. */
  sandboxHealth(user?: string): HealthRecord | HealthRecord[] {
    if (user !== undefined) {
      return this.health.get(user) ?? this.freshHealth(user);
    }
    return this.registry.usernames().map((u) => this.health.get(u) ?? this.freshHealth(u));
  }

  private freshHealth(user: string): HealthRecord {
    const core = this.registry.sandboxFor(user).session.snapshot();
    return {
      user,
      started: core.started,
      week: core.week,
      phase: core.phase,
      lastAdvanceAt: null,
      lastTrigger: null,
      eventCount: this.registry.sandboxFor(user).engine.events.count(),
      lastIntegrity: "ok",
      faults: [],
      circuitOpen: false,
    };
  }
}

/** The default state-mutating step: a varied off-screen society + (player-turn) a witnessed day.
 *  Exported for the calibration-NEUTRALITY gates (the `richOffscreenStretch`/`scheduleStoryThreads`
 *  pattern): a test drives this directly with a RECORDING rng to prove the seeded draw stream the
 *  competition/vote/jury spine shares is byte-identical with a default-off feature flag on or off. */
export function defaultApply(sandbox: UserSandbox, trigger: Trigger, rng: SeededRandom, clockNow: number, interactions = 3): number {
  const core = sandbox.session.snapshot();
  // B52/audit D5: evicted houseguests stop living — they leave the off-screen society the moment
  // they go (no more scheming/confessing weeks after eviction). Only the LIVING NPCs of the REAL
  // house, ever: the old no-house synthetic pool (audit E2) fabricated hidden scenes + Vault
  // confessionals for houseguests that didn't exist yet — pre-game intake commits recorded
  // scheming dated before move-in, later humanized into the real cast's names. With no live house
  // there is NO ONE to scheme (the tick is gated upstream; this is the belt to that suspender).
  const evicted = new Set(core.live?.evictionOrder ?? []);
  const ids = (core.house?.npcs ?? []).filter((n) => !evicted.has(n.id)).map((n) => n.id);
  const before = sandbox.engine.events.count();

  // House presence (0049): the tick re-seats the house FIRST (seeded, affinity-clustered, adjacent
  // moves only), so this stretch's scenes happen somewhere and overhears have ground truth.
  sandbox.session.presenceTick(rng);
  // L21/L24: the off-screen society pairs CO-PRESENT NPCs, so its occupancy is calibration-load-bearing.
  // It reads the CALIBRATION-NEUTRAL base occupancy (invariant to the movement-personality constants) so
  // the seeded competition/vote outcomes stay byte-identical whether or not the weighting is enabled
  // (proven by tests/property/movementStreamIsolation). The player-facing WEIGHTED positions drive only
  // `whereabouts`/witnessing — which the player observes — never the hidden society's pairing.
  const occupancy = sandbox.session.societyOccupancy();

  // Off-screen society (0038): the house lives in MORE than one way — varied typed scenes the
  // player never witnesses (hidden; 0003), each folded with its REAL interaction nature (0023). A
  // houseguest's hidden element (B50) rarely slips into a scene's hidden content (rare-reveal loop).
  // 0091: a `trigger` element is EXCLUDED from this rare-reveal flavor pool — a trigger is pure sealed
  // state that manifests ONLY as its public ERUPTION (the `runTriggerEruptions` house event), never as
  // ordinary off-screen flavor that could later gossip-paraphrase toward the player ("X has a buried
  // temper"). The eruption is the one channel; the sealed wording itself stays fully inert. (This reads a
  // per-NPC SIDE rng only — the seeded calibration spine is untouched.)
  const hiddenOf = new Map((core.house?.npcs ?? [])
    .map((n) => [n.id, n.character.hiddenElements.filter((e) => e.kind !== "trigger")] as const));
  // ADR 0006: at night the house thins — houseguests past their character-driven bedtime have turned in
  // and leave the off-screen society (the night owls scheme on without them; a turned-in player misses
  // it). IDENTITY when the clock is off ⇒ the hidden society + the seeded calibration spine are byte-identical.
  const awakeIds = sandbox.session.awakeAmong(ids);
  // #840 — the live off-screen society must gate a SHOWMANCE the SAME way the seeded layer (0059/0063)
  // does: only between an orientation-plausible pair, and ≤1 active showmance partner per houseguest.
  // The session assembles both predicates from its Vault-sealed identities + seeded showmances (engine-
  // only — neither is projected); an ineligible draw is demoted to `bonding` inside the stretch.
  const showmanceGate = sandbox.session.offscreenShowmanceGate();
  const scenes = awakeIds.length >= 2
    ? richOffscreenStretch({
        events: sandbox.engine.events, rng, npcs: awakeIds, interactions,
        hiddenElementsOf: (id) => hiddenOf.get(id) ?? [],
        // E45 — motivated, co-present society: partners by tie strength, scenes need co-presence.
        edgeOf: (a, b) => sandbox.engine.relationships.edge(a, b),
        // #840 — orientation + one-partner showmance discipline (mirrors the seeded layer).
        showmancePlausible: showmanceGate.plausible,
        hasActiveShowmance: showmanceGate.hasActiveShowmance,
        // PV1 (#1029): the player may be NAMED as a SUBJECT of off-screen NPC cognition (never a
        // witness/partner — they are not in `npcs`). Reaches the player only via gossip/pathway.
        playerSubject: PLAYER,
        // 0087: when the trajectory layer is ON, the directed arc's hidden momentum TILTS this scene's
        // nature weights toward continuing the arc (a curdling pair clashes more). Passed ONLY when enabled
        // so the off-screen call is byte-identical to the pre-feature stretch when off; the tilt adds NO
        // rng (it re-weights the SAME single nature draw), so the seeded competition/vote spine stays in
        // phase even with it on.
        ...(sandbox.session.trajectoriesEnabledNow()
          ? { trajectoryOf: (a: EntityId, b: EntityId) => sandbox.session.trajectoryOf(a, b) }
          : {}),
        // 0120: sharper/more-strategic houseguests initiate off-screen scheming a touch more often.
        // Passed ONLY when enabled so the off-screen call is byte-identical to the uniform draw when off;
        // it swaps the single `rng.pick` for a single-draw `weightedPick`, so the seeded spine stays in phase.
        ...(sandbox.session.strategicCadenceEnabledNow()
          ? { initiatorDriveOf: (id: EntityId) => sandbox.session.initiatorDrive(id) }
          : {}),
        // Wave-2: off-screen scheming names a real third-party target (grounded in the initiator's threat
        // read). Passed ONLY when enabled so the off-screen call is byte-identical when off; the clause rides
        // a per-scene SIDE rng, so even ON the seeded competition/vote spine stays in phase.
        ...(sandbox.session.schemeTargetsEnabledNow() ? { nameSchemeTargets: true } : {}),
        ...(occupancy ? { occupancy } : {}),
      })
    : []; // too few living NPCs to pair (deep endgame) — no off-screen society
  // 0087: the directed pairs that folded a scene THIS tick keep their freshly-built momentum; every other
  // tracked arc decays toward steady afterwards (the neglect cadence). Empty + unused when the layer is off.
  const touchedTrajectories = new Set<string>();
  for (const s of scenes) {
    // 0066 Phase-2: a tired INITIATOR sways the partner LESS (reduced effectiveness, never a personality
    // change). Scale is 1 when the clock is off ⇒ the fold is byte-identical to the calibration spine for
    // a GAME nature; the scaled path fires only on the live clock-ON game.
    //
    // 0078 Phase 2 — the scene's NATURE sets its fold (`natureFoldImpact`): a GAME scene folds its full
    // strategic IMPACT (trust/threat/alignment → the vote math), BYTE-IDENTICAL to before; a FRIENDLY
    // scene (bonding/showmance — ordinary downtime warmth) folds AFFINITY ONLY, no strategic weight, no
    // vote-affecting change. Always `applyImpactDirected` now, which takes the SAME four jitter draws as
    // the old `applyDirected`, so the stream stays in phase — only friendly magnitudes shift (re-calibrated).
    // #1419 — ASYMMETRIC social fatigue: a tired initiator is worse at CHARM (warm < 1 dampens the
    // warming fold) but their barbs cut DEEPER (sore ≥ 1 amplifies the souring fold). `{1,1}` (rested /
    // flag-off / clock-off) ⇒ byte-identical to the calibration spine. GAME natures fold their full
    // valence-scaled strategic impact; FRIENDLY natures fold affinity only (unchanged nature split).
    const sway = sandbox.session.socialFoldValence(s.initiator);
    const foldImpact = natureFoldImpact(s.type);
    const scaled = sway.warm === 1 && sway.sore === 1
      ? foldImpact
      : scaleImpactByValence(foldImpact, sway.warm, sway.sore);
    sandbox.engine.relationships.applyImpactDirected(s.partner, s.initiator, scaled, rng);
    // NOTE (audit 2026-06-18): whole-house transitivity for OFF-SCREEN NPC↔NPC scenes (co-present
    // bystanders reading a scene by structural balance) was prototyped here but destabilized the
    // tuned jury-reach calibration gate (a passive player's finale wins crept past the cap) — the
    // per-tick ripple compounds over a full season. The PLAYER-witnessed transitivity ships
    // (recordInteraction bystander fold); the off-screen whole-house ripple needs its own
    // calibration pass against tests/property/juryReach.property.test.ts before it returns.
    // 0041 (the linchpin pays off): the scene also deepens the initiator's soul — their arc accrues
    // and their mood drifts by the scene's nature, so the house's souls evolve BETWEEN turns (0038).
    sandbox.session.recordOffscreenScene(s.initiator, s.partner, s.type); // E50 — both roles evolve
    // 0087: fold the scene into the directed `initiator→partner` arc's hidden MOMENTUM (after the
    // relationship fold). Engine-side + pure (no rng): a no-op when the trajectory layer is off ⇒ the
    // calibration spine is untouched; when on, it updates the momentum that biases the NEXT tick's natures.
    sandbox.session.recordTrajectoryFold(s.initiator, s.partner, s.type);
    touchedTrajectories.add(`${s.initiator}->${s.partner}`);
    // 0049: the scene happens WHERE its initiator is; anyone one room over — INCLUDING the player —
    // may catch a piece of it. A successful roll is a real, traceable `overheard:` pathway (0002),
    // partial and lower-confidence: eavesdropping is information-gathering, never narrative vibes.
    const room = occupancy?.get(s.initiator);
    if (occupancy && room) {
      rollOverhears({
        eventId: s.event.id, room, content: s.event.content, participants: s.event.witnessSet,
        occupancy, knowledge: sandbox.engine.knowledge, rng,
      });
    }
  }
  // 0070 — register this tick's scene ids with the session so `getOffscreenSceneSkeletons` returns
  // the CURRENT batch (transient; refreshed every tick; the event store is the durable source).
  sandbox.session.notifyOffscreenTick(scenes.map((s) => s.event.id));

  // 0087: decay every directed arc NOT fed this tick toward steady (the neglect cadence, mirroring 0026's
  // edge decay) — an unfed arc reverts to flat. Pure + no rng; a no-op when the trajectory layer is off.
  sandbox.session.decayUntouchedTrajectories(touchedTrajectories);

  // 0085 B2 — advance the live campaign layer one tick (form/advance/re-plan + diffuse knownTo). SELF-
  // GATED: a no-op (and zero draws) unless campaigns are enabled (ORWELL_CAMPAIGNS=1), so the calibration
  // harness — which never enables them — is byte-identical. Uses its own dedicated rng, never this tick's.
  sandbox.session.campaignTick();

  // B29 - observers react to a visible tell (comfort / exploit / avoid). SELF-GATED: a no-op (zero draws) unless ORWELL_TELL_REACTIONS and ORWELL_NPC_TELLS are on.
  sandbox.session.tellReactionsTick();

  // 0100 — advance the sequestered JURY HOUSE one bounded stretch: the last-nine evictees keep living
  // (hidden juror↔juror scenes) and a grievance one juror carried out DIFFUSES to others, hardening the
  // room's read of the responsible houseguest before the finale. SELF-GATED: a no-op (ZERO draws, no
  // grudge) unless the layer is enabled (ORWELL_JURY_HOUSE=1) AND a jury already exists, so the
  // calibration harness — which never enables it — is byte-identical. Uses its OWN dedicated, isolated rng
  // (never this tick's shared stream), and records ONLY hidden events (witness set = jurors, EXCLUDES the
  // player). The main-house exclusion of evicted houseguests above is UNCHANGED — this is a strictly
  // ADDITIVE second society whose only downstream effect is the (hidden) jury lean, read at the finale.
  sandbox.session.juryHouseTick(sandbox.engine.events, sandbox.engine.knowledge);

  // 0101 — NPC MYTH-MAKING: at most once per off-screen tick, mint a LEGEND about a rare, notable player
  // act (a comp win, a veto save, a bold ceremony move) and let it diffuse NPC-to-NPC exactly like the
  // ordinary rumor below — the player's own reputation becoming house folklore. SELF-GATED: a no-op (ZERO
  // draws, no legend) unless the layer is enabled (ORWELL_MYTH_MAKING=1), so the calibration harness —
  // which never enables it — is byte-identical. Uses its OWN dedicated, isolated rng and folds NO
  // relationship edge (never the player's own, never any NPC's read of the player) — only the hidden
  // knowledge layer changes, so the seeded competition/vote spine is untouched even while ON.
  sandbox.session.legendTick(sandbox.engine.events, sandbox.engine.knowledge);

  // 0099 (hidden half) — the off-screen NPC↔NPC SECRET BARTER: once per bounded off-screen tick, an NPC
  // holding a learned secret about a houseguest SPENDS it with the co-house recipient who values it most,
  // so information becomes liquid in the hidden layer (secrets visibly move; a bond firms for no public
  // reason). It REUSES the existing 0099 trade/value core (`npcBarterStep`), transferring the belief
  // through the SAME NPC→NPC diffusion pathway the live gossip below uses (`transmitGossip`, witness set =
  // {giver, recipient}, EXCLUDES the player). SELF-GATED: a no-op (ZERO draws, no counter advance) unless
  // the layer is enabled (ORWELL_SECRET_BARTER=1) AND some holder holds a tradeable secret, so the
  // calibration harness — which never enables it, and whose off-screen society mints only subject-LESS
  // gossip/overhear beliefs — is byte-identical. Uses its OWN dedicated, isolated rng and folds NO
  // relationship edge (only the hidden knowledge layer changes), so the seeded competition/vote/jury
  // spine is untouched even while ON. The player learns a bartered secret only if a later pathway
  // (overhear/gossip below, 0002/0094) terminates at them — never as a Vault read.
  sandbox.session.secretBarterTick(sandbox.engine.events, sandbox.engine.knowledge);

  // B27b — live gossip: occasionally one of the night's scenes becomes a RUMOR that diffuses along
  // the affinity graph (who actually talks to whom), with low per-edge transmission, decaying
  // confidence, and per-telling drift. The PLAYER is a node like anyone: a chain that terminates at
  // them lands the belief — a vague paraphrase with source+confidence, never the verbatim hidden
  // scene and never a number. Every retelling is a recorded, traceable event (0002).
  // B10 / B11 slice 3 (ORWELL_GOSSIP_COPRESENCE, default OFF): information moves ONLY inside a scene, by the holder's seeded share / slip / hold choice, ONE hop - this REPLACES the automatic graph rumor below
  // while on (so the OFF path, which never reaches this branch, is byte-identical). Dedicated rng per (holder, listener, tick); hidden layer only; the player is never a node (off-screen scenes exclude them).
  if (core.house && scenes.length > 0 && sandbox.session.copresenceEnabledNow()) {
    const npcsById = new Map(core.house.npcs.map((n) => [n.id, n] as const));
    const relm = sandbox.engine.relationships;
    const beliefObs = sandbox.session.beliefReceiptObserver();
    spreadForScenes(
      scenes.filter((s) => s.initiator !== core.house!.player.id && s.partner !== core.house!.player.id).map((s) => [s.initiator, s.partner] as const),
      {
        knowledge: sandbox.engine.knowledge,
        told: sandbox.session.copresenceToldLedger(),
        rngFor: (h, l) => new SeededRandom(hashSeed(`${core.seed ?? ""}:copresence:${h}:${l}:${clockNow}:${before}`)),
        trust: (a, b) => relm.edge(a, b).trust,
        affinity: (a, b) => relm.edge(a, b).affinity,
        threat: (a, b) => relm.edge(a, b).threat,
        style: (id) => npcsById.get(id)?.character.strategyStyle,
        volatility: (id) => npcsById.get(id)?.soul.volatility ?? 0.3,
        audienceOf: () => 0,
        // B48 (ORWELL_CREDIBILITY, default ON): a lie's arriving confidence scales with how far the LISTENER believes the holder (their own caught-lie evidence + repeats to their ear). Absent => the B34 stand-in.
        ...(sandbox.session.credibilityEnabledNow() ? { credibilityOf: (h: EntityId, l: EntityId, n: number) => sandbox.session.credibilityOf(l, h, n) } : {}),
        // B24/B36: the co-presence receipt writes the SAME `heard-rumor` claim the graph path does (gated by ORWELL_NPC_BELIEFS inside the observer; undefined when off => byte-identical).
        ...(beliefObs ? { onTold: (r: { listener: EntityId; subject: EntityId; confidence: number }) => beliefObs({ listener: r.listener, subject: r.subject, type: "gossip", confidence: r.confidence, delta: {} }) } : {}),
      },
    );
  } else if (core.house && scenes.length > 0 && rng.next() < GOSSIP.riseProb) {
    const scene = scenes[rng.int(scenes.length)]!;
    // The graph is the AWAKE house (ADR 0006), exactly like the off-screen society above: a
    // houseguest who has gone to bed neither retells nor receives a rumor at night (a pre-existing
    // gap — the graph used to be all living NPCs, so a telling could reach a sleeper). When the
    // clock is off (the default + the seeded calibration spine) `awakeAmong` is the whole roster, so
    // this is byte-identical there. The PLAYER is a node like anyone — but only while THEY are up.
    const everyone: EntityId[] = sandbox.session.awakeAmong([core.house.player.id, ...ids]);
    const edges: Array<readonly [EntityId, EntityId]> = [];
    for (let i = 0; i < everyone.length; i++) {
      for (let j = i + 1; j < everyone.length; j++) {
        // #565: symmetric edge selection (max of both directed reads) — a rumor travels along a bond
        // whenever EITHER party is warm enough to carry it. The directed-only test structurally
        // excluded the player (always `everyone[0]`, so only player→NPC was ever read) from the graph.
        if (gossipEdgeAffinity(sandbox.engine.relationships, everyone[i]!, everyone[j]!) > GOSSIP.affinityEdge) {
          edges.push([everyone[i]!, everyone[j]!] as const);
        }
      }
    }
    if (edges.length > 0) {
      // Issue #1397 — when voice-mediated drift is enabled, hand `diffuseGossip` a resolver for each
      // RETELLER's PUBLIC voice (0084 `character.voice`) so the reteller's own personality colors HOW the
      // rumor warps as it passes through them. Absent (the default + the seeded calibration spine) ⇒ no
      // `voiceOf` ⇒ byte-identical agnostic drift. PUBLIC dials only — never soul/Vault. The player is not
      // in `npcs`, so a player retelling resolves `undefined` → the agnostic path (their voice is human).
      const npcs = core.house.npcs;
      const voiceOf = sandbox.session.gossipDriftEnabledNow()
        ? (id: EntityId): VoiceProfile | undefined => npcs.find((n) => n.id === id)?.character.voice
        : undefined;
      const beliefObserver = sandbox.session.beliefReceiptObserver();
      diffuseGossip({
        knowledge: sandbox.engine.knowledge,
        graph: makeSocialGraph(edges),
        rng,
        origin: scene.initiator,
        fact: { content: rumorFrom(scene.initiator, scene.partner, scene.type) },
        rounds: GOSSIP.rounds,
        transmitProb: GOSSIP.transmitProb,
        decay: GOSSIP.decay,
        // E44 — hearing a rumor moves the listener's read of its subjects (never the player's edges).
        rel: sandbox.engine.relationships,
        subjects: [scene.initiator, scene.partner],
        sceneType: scene.type,
        ...(voiceOf ? { voiceOf } : {}),
        // #2017 S0b-2: absent unless ORWELL_NPC_BELIEFS is on (then a READ-ONLY observer that records each receipt as a belief claim).
        ...(beliefObserver ? { onReceipt: beliefObserver } : {}),
      });
    }
  }

  // NPC interiority (0040): an involved houseguest privately confesses their REAL read — Vault-only
  // (witnessed by them alone), grounded in their actual relationship signals, never invented. It
  // reaches no one (player or admin); the player feels it only later through that NPC's behavior.
  if (scenes.length > 0) {
    const confessor = scenes[rng.int(scenes.length)]!.initiator;
    // 0089 — the off-screen confessional REACTS to the confessor's OWN witnessed events too (the scenes
    // they were just part of are already recorded this tick). `selectRecentForConfessional` bounds to
    // `witnessedBy: confessor` and returns only Vault-safe class-keyed gists — never another houseguest's
    // hidden read (mandate #2/#3). The tiebreak rng is DEDICATED (derived off confessor + clock + log
    // size), never the shared society/vote stream `rng`, so the seeded calibration spine is untouched
    // (the selection draws no rng at all unless two of the confessor's events fully tie).
    const recentRng = new SeededRandom(hashSeed(`${core.seed ?? ""}:confessional-recent:${confessor}:${clockNow}:${before}`));
    const recentEvents = selectRecentForConfessional(sandbox.engine.events.queryAll(), confessor, clockNow, { rng: recentRng });
    // BB-2/SG-8 — without these three, EVERY confessional all season rendered the identical first
    // template (`pick()` falls back to `lines[0]` with no rng) and named the player with the bare
    // `player` id (no resolver), killing the 0048 retrospective payoff (41/41 identical lines). A
    // DEDICATED seeded rng (never the shared society/vote stream `rng` — the same isolation the
    // `recentRng` above already uses) drives 0090's phrasing variety; the confessor's own PUBLIC
    // 0084 voice colors which pool it draws from (never a fact, only texture); `nameOf` bakes the
    // confessor's actual read/display name for their target/ally — including the player's real name
    // in place of the literal "player" token.
    const phrasingRng = new SeededRandom(hashSeed(`${core.seed ?? ""}:confessional-phrasing:${confessor}:${clockNow}:${before}`));
    const houseguests = core.house?.npcs ?? [];
    const voice = houseguests.find((n) => n.id === confessor)?.character.voice;
    const nameOf = (id: EntityId): string =>
      core.house && id === core.house.player.id ? core.house.player.name : (houseguests.find((n) => n.id === id)?.name ?? id);
    recordConfessional(
      sandbox.engine.events,
      confessionalFor(confessor, ids, sandbox.engine.relationships, {
        player: PLAYER,
        recentEvents,
        rng: phrasingRng,
        voice,
        nameOf,
      }),
      rng,
      clockNow,
    );
  }

  // 0091 — TRIGGER ERUPTIONS: AFTER the society/confessional folds, a plausibly-strained, co-present
  // houseguest whose volatile sealed trigger meets a fresh SPARK this tick (a conflict/betrayal scene that
  // just named them) can DETONATE into a Vault-safe PUBLIC house event the player witnesses. STRICTLY
  // OPT-OUT (default-ON `ORWELL_TRIGGERS`; `=0` disables): when off — the state the seeded juryReach/
  // gradient/UAT sims run in — the call is skipped entirely (no precipitant map built, no draw, no event,
  // no fold), so this tick is byte-identical to the pre-feature build and the seeded competition/vote spine
  // is untouched. When on, the fire check runs on a DEDICATED rng INSIDE the session (never this shared
  // stream above) — the load-bearing calibration-neutrality guarantee. The precipitant is THIS tick's fresh
  // sparks: a conflict/betrayal scene anchors the eruption to a live moment (the no-cold-open guarantee).
  if (sandbox.session.triggersEnabledNow()) {
    const precipitants = new Map<EntityId, number>();
    for (const s of scenes) {
      const spark = s.type === "betrayal" ? 1 : s.type === "conflict" ? 0.8 : 0;
      if (spark === 0) continue;
      precipitants.set(s.initiator, Math.max(precipitants.get(s.initiator) ?? 0, spark));
      precipitants.set(s.partner, Math.max(precipitants.get(s.partner) ?? 0, spark));
    }
    sandbox.session.runTriggerEruptions(sandbox.engine.events, precipitants);
  }

  // A meaningful, player-witnessed day event (daily-event invariant, 0008; E58 ambient variety).
  // BUGFIX: this used to gate on `trigger === "player-turn"`, a value `advance()` never actually
  // passes to `applyFn`/`defaultApply` in real play — `commitPlayerTurn` never calls `advance()`
  // directly, and the turn-driven tick it DOES fire always carries `"offscreen-tick"` (the R5/E57
  // debounce refactor renamed the calling convention without updating this gate). The result: the
  // entire ambient house-event pool was dead code for every real game, satisfying the daily-event
  // invariant with ceremony beats alone and none of this module's "the house lives between
  // ceremonies" texture. Gate on "any real tick, not an audit dry run" instead — `defaultApply` is
  // only ever invoked with `trigger !== "audit"` in the first place (see `advance()` above), so this
  // now fires for both the real production trigger and the legacy test-driven "player-turn" calls.
  //
  // CALIBRATION-NEUTRALITY: the ambient pick draws on a DEDICATED, isolated rng keyed off the game
  // seed + moment (the same pattern as the confessional phrasing/recent rngs above), NEVER the shared
  // `rng` stream this function threads through the seeded society / gossip / story-thread spine. Pure
  // texture — it records one player-witnessed house-event but consumes ZERO draws from the shared
  // stream, so the downstream `scheduleStoryThreads(rng)` (and every seeded competition/vote/jury roll)
  // stays byte-identical whether or not this block fires. Firing it on the real tick is what finally
  // lets the pool reach a live player; the dedicated rng is what keeps that texture-only.
  //
  // ONCE-PER-DAY cadence (audit COMP-7): the turn-driven tick fires on every progressed beat AND, once
  // per turn, on the debounced aux commits (a recorded scene, a deal). Recording a fresh ambient day
  // headline on each would FLOOD the record ("several a week" was already too many) and mislabel a
  // mid-day side-conversation as a new day event. So we dedupe on the in-game DAY: the ambient headline
  // is stamped `Week W[, day D]:` by `nextHouseEvent`, and we record at most one per distinct stamp —
  // it fires when the player first arrives at a new (week, day) and then stays quiet until the day turns
  // over, no matter how many aux ticks the turn produces. (Ceremony house-events carry no such stamp, so
  // this never suppresses a real HOH/nomination/eviction beat.)
  if (trigger !== "audit" && ids.length > 0) {
    const day = dayOfWeek(core.phase);
    const stamp = day === null ? `Week ${core.week}` : `Week ${core.week}, day ${day}`;
    // BOUNDED SCAN (F-EN-2): "has today's ambient headline already been recorded?" — `.some()` over the
    // house-events. We walk the append-only log from the TAIL and short-circuit on the first match instead
    // of `query({type})` materializing a full O(events) filtered array of every house-event each tick. The
    // current-day stamp (if present) sits in the recent tail, so the common ALREADY-recorded case hits
    // immediately. Byte-identical to `query({type:"house-event"}).some(startsWith(stamp+":"))` (same
    // predicate; iteration order is irrelevant to a boolean), with no per-tick filtered-array allocation.
    const events = sandbox.engine.events.queryAll();
    let alreadyToday = false;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "house-event" && e.content.startsWith(`${stamp}:`)) { alreadyToday = true; break; }
    }
    if (!alreadyToday) {
      const ambientRng = new SeededRandom(
        hashSeed(`${core.seed ?? ""}:house-event:${core.week}:${core.phase}:${before}`),
      );
      sandbox.engine.events.record({
        id: `orch:day:${clockNow}:${before}`,
        ts: clockNow,
        type: "house-event",
        initiator: ids[0]!,
        // BE-DEEP2-3/COMP-6: the pool's content reads whole-house ("A house meeting...", "the house
        // calls to order"), so the witness set must be the true co-present house, not just one
        // hardcoded NPC — otherwise every other houseguest is permanently unable to recall/confessional
        // an event their own flavor text says they were in. `awakeIds` (computed above, ADR 0006) is
        // IDENTITY to `ids` when the sleep clock is off (the default + the calibration spine's state),
        // so this is byte-identical there and only narrows on the opt-in live-time path.
        witnessSet: [PLAYER, ...awakeIds],
        hidden: false,
        content: nextHouseEvent(sandbox.engine.events, ambientRng, { week: core.week, phase: core.phase }), // E58: varied + day-indexed, never a verbatim repeat
      });
    }
  }
  // 0059/L40 — advance the seeded showmances on the affinity the scenes just moved. A showmance that
  // crosses into `visible` becomes a PUBLIC house fact; the adapter's onShowmanceSurfaced hook (wired
  // in the registry) records the player-witnessed beat. Pre-visible showmances stay Vault-sealed.
  sandbox.session.advanceShowmances();
  // 0092 — the SECRET-PACING DRIP runs BEFORE 0060's surface-to-player decision: it PACES which sealed
  // secret edges toward THIS player and how fast (a per-week budget, relationship-weighted), routing a
  // ripe top candidate into 0060's EXISTING anchored surface path (the confidant slip / gossip chain) —
  // it adds no new pathway. STRICTLY OPT-IN (default-OFF `ORWELL_SECRET_PACING`): when off — the default,
  // and the state the seeded juryReach/gradient/UAT sims run in — it returns immediately and draws
  // nothing, so 0060's own flat path is the only one that runs and this tick is byte-identical to the
  // pre-feature build. When on, every roll is on a DEDICATED rng INSIDE the session (never this shared
  // stream), and the only thing it changes is which already-Wall-safe surface 0060 picks + whether the
  // weekly budget allows it ⇒ the seeded comp/vote/jury spine is untouched (the load-bearing guarantee).
  sandbox.session.pacingDrip();
  // 0101/#1401 — the AI SHOWRUNNER composes its Vault-held "producer note" for THIS beat BEFORE the
  // scheduler runs, so the scheduler can consult it. It scores the simmering hidden threads (tension /
  // staleness / board salience) on a PURE pass (no rng) and stores a note proposing which threads to
  // EMPHASIZE — a clamped, boost-only re-weight of 0060's OPEN-SET surfacing selection, never an outcome
  // (ADR 0005). SELF-GATED (default-ON `ORWELL_SHOWRUNNER`; `=0` disables): off ⇒ no note composed ⇒ the scheduler below
  // is byte-identical, and the note-composition pass draws ZERO from this shared `rng` either way, so the
  // seeded competition/vote/jury spine is untouched ON or OFF (the load-bearing calibration guarantee).
  sandbox.session.showrunnerTick();
  // 0060 — the story-thread scheduler rides THIS bounded tick (after society/gossip/confessional, so it
  // reads the freshly-moved house). It walks each seeded thread's lifecycle — dormant→active (reusing
  // the 0023 fold), active→surfaced (reusing 0038 gossip / 0002 pathways, capped per §5), and →resolved
  // / →expired (recorded, never deleted). It AUTHORS nothing; it only decides WHEN each transition
  // fires, on a seeded SIDE rng so the main beat stream stays byte-stable (0007). Engine-only: nothing
  // crosses but a class-keyed paraphrase belief (never the premise, never a number — §7).
  sandbox.session.scheduleStoryThreads(rng);
  // 0077 NPC-side increment — the house WHISPERS about closed-door pairings: a conspicuous NPC pair
  // holed up in a private room is noticed by a plausibly-positioned third houseguest, and a Vault-free
  // POSITION suspicion (who/where, never the sealed content) diffuses NPC-to-NPC and can reach the
  // player. Runs LAST and on a DEDICATED rng inside the session (never the shared stream above) with NO
  // relationship fold ⇒ calibration byte-identical (the seeded society/vote spine is untouched; the
  // gossip/surfacing events it records are a type `nextHouseEvent`/confessionals never scan).
  sandbox.session.whisperPairings(sandbox.engine.knowledge);
  // 0059 §5 — the organic pre-game-TIE surfacing scheduler (the DEFERRED follow-on). Runs LAST, like the
  // whisper above, and is STRICTLY OPT-IN (default-OFF `ORWELL_SEEDED_TIE_SURFACING`): when off — the
  // default, and the state the seeded juryReach/gradient/UAT sims run in — it returns immediately and
  // touches nothing (no draw, no event, no fold), so this tick is byte-identical to the pre-feature build.
  // When on, it surfaces a warmed seeded tie through a DEDICATED rng (never this shared stream) + 0002
  // pathways and folds the discovery via 0023 — texture, never the calibration spine.
  sandbox.session.advanceSeededTies(sandbox.engine.knowledge);
  // Feature 0095 — the pre-show-TIE REVEAL pathway (the OVERHEAR route; a SEPARATE, distinct pathway from
  // 0059 §5 above, with its own flag/gate/rng — turning one on does not turn on the other). Runs LAST,
  // like the whisper/§5 above, and is STRICTLY OPT-IN (default-OFF `ORWELL_TIE_REVEAL`): when off — the
  // default, and the state the seeded juryReach/gradient/UAT sims run in — it returns immediately and
  // touches nothing, so this tick is byte-identical to the pre-feature build. When on, a conspicuous
  // sealed tie can come OUT for real (the actual pre-show connection, not §5's vague "seem close"),
  // diffusing as a genuine confidence-scaled betrayal-grade belief on its OWN dedicated rng stream.
  sandbox.session.advanceTieReveal(sandbox.engine.knowledge);
  // Every recorded scene (+ the player-turn day) counts toward the advance.
  return sandbox.engine.events.count() - before;
}

function playerSweep(sandbox: UserSandbox): string {
  // Every player-facing rendering that could carry event/knowledge content, built from a SINGLE
  // visible projection (byte-identical to the four independent renderings, one O(events) scan not
  // four). The exact surface set + string forms are unchanged, so the vault-leak guarantee holds.
  return sandbox.player.vaultLeakSweep();
}
