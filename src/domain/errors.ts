/**
 * Typed error taxonomy for the engine's outward seams (audit E3/E7).
 *
 * The HTTP boundary used to classify "deliberate refusal" as `constructor === Error`, which made a
 * disk failure (Node fs errors are plain `Error`s) read as the CALLER's fault — a 400 that leaked
 * the data-dir path — and let a faulted integrity commit return 200 with a view of rolled-back
 * state. These classes give each failure mode its own identity:
 *
 * - `EngineRefusal` — a DELIBERATE engine refusal (illegal input, unavailable tool): the caller's
 *   fault, HTTP 400. Plain `Error` throws from older validation sites still classify the same way
 *   (back-compat); new refusal sites should prefer this class.
 * - `TurnRefusedError` — the fail-closed integrity checkpoint (0031) refused the commit and rolled
 *   the sandbox back. State is unchanged and NOTHING was persisted; the request itself FAILS
 *   (HTTP 409) — never 200-then-rollback (audit E3/D1). Carries only fault KINDS, never content.
 * - `StaleBeatError` — the compare-and-swap stale-write guard (0065 Part A): a mutating call carried
 *   an `expectedBeatSeq` that no longer matches the committed `beatSeq`, so the board moved under it
 *   (the 0064 queued-turn case). The write is REFUSED with NO state change — HTTP 409 with a stable
 *   `code: "stale-beat"`, the CURRENT `beatSeq`, and the Vault-free current board, so the caller can
 *   re-ground immediately. Distinct from `TurnRefusedError` (an integrity failure of an applied
 *   candidate); this refuses BEFORE the mutation, so nothing was ever applied to roll back.
 * - `PersistFailureError` — the durable save itself failed (disk full, I/O). Its own fault class,
 *   never misread as "degradation" and never fail-open (audit E7): the turn is rolled back, the
 *   message is sanitized (no paths), HTTP 500.
 *
 * Pure domain module: no I/O, importable by every layer (the outward HTTP transport included).
 */

/** A deliberate engine refusal — the caller's fault (HTTP 400). */
export class EngineRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineRefusal";
  }
}

/** The integrity checkpoint refused the commit; the sandbox was rolled back (HTTP 409). */
export class TurnRefusedError extends Error {
  /** ORW-321: names of the failing invariants (field / count names only, never content) - the operator sees WHICH invariant broke, not just "degradation". */
  constructor(public readonly kinds: readonly string[], public readonly invariants: readonly string[] = []) {
    super(`turn refused — integrity checkpoint failed (${kinds.join(", ")}); state unchanged`);
    this.name = "TurnRefusedError";
  }
}

/** The durable save failed; the turn was rolled back, nothing persisted (HTTP 500, sanitized). */
export class PersistFailureError extends Error {
  constructor() {
    super("the turn could not be saved and was rolled back — nothing was lost; try again");
    this.name = "PersistFailureError";
  }
}

/**
 * A mutating call's `expectedBeatSeq` no longer matches the committed `beatSeq` — the board moved
 * under it (0065 Part A). The write is refused BEFORE any mutation (state unchanged, nothing to roll
 * back). The HTTP edge maps it to 409 with the stable `code: "stale-beat"`, the CURRENT `beatSeq`,
 * and the Vault-free current `board` so the caller can re-ground and retry against the moved board.
 * Vault-free by construction: a beat counter carries no Vault content, and `board` is the same
 * ceremony-level public status `gameStatus` exposes.
 */
export class StaleBeatError extends Error {
  /** A stable machine code the FE keys on (never the human message). */
  public readonly code = "stale-beat" as const;
  constructor(
    /** The current committed beat counter (what the caller should re-ground to). */
    public readonly beatSeq: number,
    /** The Vault-free current board (ceremony-level public status) for an immediate re-ground. */
    public readonly board: unknown,
  ) {
    super(`stale write refused — expected beatSeq is behind the current board (now ${beatSeq}); re-ground and retry`);
    this.name = "StaleBeatError";
  }
}
