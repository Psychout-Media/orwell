import type {
  GameStateRepository, AdminVisibleState, OverrideChange, SandboxOp,
} from "../../ports/GameStateRepository";
import type { FinaleFastForwardView, BehavioralFlags } from "../../ports/GameSession";

/** Which admin knobs the live engine honored (Vault-free names only). */
export interface LiveKnobResult { applied: string[]; notApplied: string[] }

/**
 * Administrator / God Mode (0016). Inspects, overrides non-Vault mechanics,
 * configures tunables, and manages the sandbox lifecycle. It is walled from the
 * Vault even for the admin — every method returns NON-VAULT state, there is no
 * "reveal the Vault" capability, and there is no dependency on `VaultStore`
 * (proven structurally by dependency-cruiser and by the sentinel canary, 0001).
 */
export class AdminPort {
  constructor(private readonly state: GameStateRepository) {}

  /**
   * The REAL sandbox-reset delegate (B58/audit E5): the composition layer wires this to
   * `registry.resetUser`, so the admin's `manageSandbox("reset")` actually re-onboards the game
   * instead of mutating a stub nothing reads. Vault-free: the delegate is a void closure.
   */
  private onReset?: () => void;

  setResetDelegate(fn: () => void): void {
    this.onReset = fn;
  }

  /**
   * Vault-free sandbox health (B58/audit E5+E6): the composition layer wires this to the
   * orchestrator's `sandboxHealth` so God Mode can SEE integrity faults and the circuit state.
   * Returns null when no orchestrator is composed (standalone sandboxes).
   */
  private healthProvider?: () => unknown;

  setHealthProvider(fn: () => unknown): void {
    this.healthProvider = fn;
  }

  /** Vault-free health metadata (week/phase/integrity/faults) — never game content. */
  health(): unknown {
    return this.healthProvider?.() ?? null;
  }

  /**
   * The fast-forward-to-finale lever (L38): the composition layer wires this to the live session's
   * `advanceToFinale`, which DRIVES the deterministic engine to a crowned winner (auto-resolving the
   * player's pendings with legal defaults). It is VAULT-FREE BY CONSTRUCTION — the delegate returns
   * only PUBLIC ceremony facts (winner NAME, weeks, the player's placement), reads no Vault, and does
   * NOT touch the `seasonRetrospective` gate (that still opens ONLY post-finale, through its own code
   * path). Returns a not-started summary when no orchestrator/session is composed.
   */
  private fastForwardProvider?: () => FinaleFastForwardView;

  setFastForwardProvider(fn: () => FinaleFastForwardView): void {
    this.fastForwardProvider = fn;
  }

  /**
   * God-Mode "fast-forward to finale (debug)" (L38): finish the season legitimately so the
   * post-season Vault retrospective (0048) unseals. It REVEALS nothing — only the Vault-free
   * public summary crosses (winner NAME, weeks played, the player's final placement).
   */
  advanceToFinale(): FinaleFastForwardView {
    return this.fastForwardProvider?.() ?? {
      finished: false, winnerName: null, weeks: 0, playerPlacement: "unknown", started: false,
    };
  }

  /** Inspect non-Vault state (week, phase, public roster, config). */
  inspect(): AdminVisibleState {
    return this.state.getAdminVisibleState();
  }

  /**
   * 0016 — the knobs the LIVE engine honors. `configure` / `overrideMechanic` used to write ONLY the admin's own
   * projection (`state.config`), which the live game never reads, so the admin saw "applied" for a no-op. The composition
   * layer wires this per-sandbox, Vault-free delegate to the session (reserve-twist COUNT, tie/showmance budgets);
   * every response now carries `knobsApplied` / `knobsNotApplied` so the truth is visible. A knob the engine owns or
   * doesn't expose (phase, week, temperature...) is still recorded in the projection but reported as NOT applied.
   */
  private liveKnobsDelegate?: (knobs: Record<string, unknown>) => LiveKnobResult;

  setLiveKnobsDelegate(fn: (knobs: Record<string, unknown>) => LiveKnobResult): void {
    this.liveKnobsDelegate = fn;
  }

  /** Re-seed the inspectable config projection WITHOUT touching the live game (a rebuilt sandbox keeps what the admin submitted, even unsupported/invalid knobs). */
  restoreConfigProjection(knobs: Record<string, unknown>): void {
    this.state.configure(knobs);
  }

  private withKnobs(view: AdminVisibleState, knobs: Record<string, unknown>): AdminVisibleState {
    const r = this.liveKnobsDelegate?.(knobs) ?? { applied: [], notApplied: Object.keys(knobs) };
    return { ...view, knobsApplied: r.applied, knobsNotApplied: r.notApplied };
  }

  /** Override a non-Vault mechanic; returns the updated non-Vault state. */
  overrideMechanic(change: OverrideChange): AdminVisibleState {
    const view = this.state.applyOverride(change);
    return this.withKnobs(view, change?.mechanic ? { [change.mechanic]: change.value } : {});
  }

  /** Set non-Vault tunables (temperature/relationship config, reserve-twist COUNT — not content). */
  configure(knobs: Record<string, unknown>): AdminVisibleState {
    const view = this.state.configure(knobs);
    return this.withKnobs(view, knobs ?? {});
  }

  /**
   * ADR 0006 — flip the in-game clock + sleep economy at runtime (the FE settings switch). The composition
   * layer wires the delegate to the engine's process-global override (a Vault-free void closure — exactly
   * like the reset/health/fast-forward delegates above), so this OUTWARD surface never imports the engine
   * adapter (the dependency-cruiser boundary holds).
   */
  private timeOfDayDelegate?: (enabled: boolean) => void;

  setTimeOfDayDelegate(fn: (enabled: boolean) => void): void {
    this.timeOfDayDelegate = fn;
  }

  setTimeOfDay(enabled: boolean): AdminVisibleState {
    this.timeOfDayDelegate?.(enabled);
    return this.state.getAdminVisibleState();
  }

  /**
   * B2 (2026-07-05 activation lane) — the God-Mode dial for the "living house" behavioral-fidelity
   * layers (0085 campaigns / 0087 trajectories / 0091 triggers / 0092 secret pacing / 0100 jury house /
   * 0059 §5 seeded-tie surfacing) that ship OPT-IN behind their own `ORWELL_*` deploy env flag. Same
   * delegate shape as `setTimeOfDayDelegate` above (a Vault-free void closure the composition layer
   * wires per sandbox) — this OUTWARD surface never imports the engine adapter. Each field is optional;
   * an absent field leaves that layer's current setting untouched.
   */
  private behavioralFlagsDelegate?: (flags: BehavioralFlags) => void;

  setBehavioralFlagsDelegate(fn: (flags: BehavioralFlags) => void): void {
    this.behavioralFlagsDelegate = fn;
  }

  /** Flip one or more behavioral-fidelity layers at runtime (the FE settings switch → no restart). */
  setBehavioralFlags(flags: BehavioralFlags): AdminVisibleState {
    this.behavioralFlagsDelegate?.(flags);
    return this.state.getAdminVisibleState();
  }

  /**
   * The read-side companion (DEPLOY-12): the CURRENT resolved on/off state of every B2 flag, so an
   * operator/FE dial can render truthfully instead of only being able to write blind. Returns the code
   * defaults (all ON — the 2026-11 default flip) when no sandbox/session is composed (never throws; never a Vault handle).
   */
  private behavioralFlagsProvider?: () => Required<BehavioralFlags>;

  setBehavioralFlagsProvider(fn: () => Required<BehavioralFlags>): void {
    this.behavioralFlagsProvider = fn;
  }

  behavioralFlags(): Required<BehavioralFlags> {
    // No sandbox composed yet: the CODE DEFAULTS (the 2026-11 default flip — these layers run ON unless an env override says
    // otherwise; a composed sandbox's provider reports the env-resolved truth). This outward surface reads no process state.
    return this.behavioralFlagsProvider?.() ?? {
      campaigns: true, trajectories: true, triggers: true, secretPacing: true,
      juryHouse: true, seededTieSurfacing: true, mythMaking: true, showrunner: true,
    };
  }

  /** Manage this sandbox only (create | reset | save | load). A reset re-onboards the REAL game. */
  manageSandbox(op?: SandboxOp): AdminVisibleState {
    const out = this.state.manageSandbox(op);
    if (op === "reset") this.onReset?.(); // B58/E5: the reset reaches the registry, not just the stub
    return out;
  }
}
