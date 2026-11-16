/**
 * Lane G1 — engine health metrics for the HTTP transport's `/health` surface.
 *
 * A small, process-local record of how the tool dispatch path is doing: uptime,
 * call/failure counters, and a CAPPED ring of recent tool failures. It exists so
 * the admin "Health & Logs" card (front-end) can show *visible* failure data
 * instead of the operator spelunking journald.
 *
 * VAULT RULE (hard): an entry carries the tool NAME (a static-allowlist member),
 * a sanitized error CLASS (the constructor name — never the message), and timing.
 * Never args, never payloads, never messages, never user ids. The ring is shared
 * across users by construction *because* it can hold nothing user-specific.
 */

export interface ToolFailureEntry {
  /** Epoch ms when the failure was recorded. */
  ts: number;
  /** The tool NAME only — a member of the static channel allowlist, never args. */
  tool: string;
  /** The error's constructor name (e.g. "EngineRefusal") — never the message. */
  errorClass: string;
  /** Wall-clock duration of the failed dispatch, in ms. */
  durationMs: number;
}

/** Ring capacity — generous enough to debug a bad afternoon, bounded forever. */
export const FAILURE_RING_CAPACITY = 50;

/** The sanitized class of a thrown value: constructor name for Errors, never a message. */
export function errorClassOf(e: unknown): string {
  if (e instanceof Error) return e.constructor.name || "Error";
  return "NonError";
}

export class HealthMetrics {
  private readonly startedAt: number;
  private readonly failures: ToolFailureEntry[] = [];
  private total = 0;
  private failed = 0;
  private readonly refusals = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = this.now();
  }

  /** A tool call that completed (per-call duration is tracked on the dispatch path). */
  recordSuccess(_tool: string, _durationMs: number): void {
    this.total += 1;
  }

  /** A tool call that failed — name + sanitized class + timing ONLY (the Vault rule). */
  recordFailure(tool: string, errorClass: string, durationMs: number): void {
    this.total += 1;
    this.failed += 1;
    this.failures.push({
      ts: this.now(),
      tool: String(tool),
      errorClass: String(errorClass),
      durationMs: Math.max(0, Math.round(durationMs)),
    });
    // Capped ring: drop the oldest beyond capacity — the record never grows unbounded.
    if (this.failures.length > FAILURE_RING_CAPACITY) {
      this.failures.splice(0, this.failures.length - FAILURE_RING_CAPACITY);
    }
  }

  /** A call the engine ANSWERED but refused as a no-op (e.g. `noteMessage:no-game`): a counted label only - never args, never a user. Bounded: at most 32 distinct labels. */
  recordRefusal(label: string): void {
    const k = String(label).slice(0, 64);
    if (!this.refusals.has(k) && this.refusals.size >= 32) return;
    this.refusals.set(k, (this.refusals.get(k) ?? 0) + 1);
  }

  /** The `/health` projection: uptime + counters + the recent-failure ring (oldest first). */
  snapshot(): {
    uptimeSeconds: number;
    toolCalls: { total: number; failed: number };
    recentFailures: ToolFailureEntry[];
    refusals: Record<string, number>;
  } {
    return {
      uptimeSeconds: Math.max(0, Math.floor((this.now() - this.startedAt) / 1000)),
      toolCalls: { total: this.total, failed: this.failed },
      recentFailures: this.failures.map((f) => ({ ...f })),
      refusals: Object.fromEntries(this.refusals),
    };
  }
}
