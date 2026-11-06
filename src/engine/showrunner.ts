/**
 * Feature 0101 (#1401) — the AI SHOWRUNNER: the PURE "producer's notes" core. NO I/O, NO Vault handle,
 * NO rng. It is handed the ALREADY-READ, Vault-FREE signals for each SIMMERING hidden thread (tension /
 * staleness / current-board salience — the adapter fills these from the relationship model + the season
 * position) and returns a `ShowrunnerNote`: a shortlist of threads with a CLAMPED, boost-only `emphasis`
 * multiplier and a class/position-based `rationale`. Same signals ⇒ same note (a pure function of its
 * inputs; the thread id is the seed-stable tiebreaker) — determinism for free, so it can never perturb
 * the seeded competition/vote spine (§calibration).
 *
 * ADR 0005 — the note proposes SHAPE only. There is deliberately NO outcome field: an outcome directive
 * ("surface this", "evict", "protect the player", "winner") is INEXPRESSIBLE in this schema. The only
 * thing a note carries is a bounded `emphasis` multiplier over the EXISTING seeded 0060 surfacing
 * selection — the engine keeps every magnitude, eligibility rule, and hard cap. The Vault Wall is
 * preserved by construction: a signal is a NUMBER derived from the engine's own reads (never a premise),
 * and the `rationale` is a producer-language gloss keyed off the numeric signals (never a premise, never
 * a number) — so a note is safe to unseal in the 0048 retrospective as the season's production bible.
 */
import { SHOWRUNNER } from "./showrunnerConstants";
import { clamp01Raw as clamp01 } from "../domain/num";

const clampEmphasis = (x: number): number =>
  Math.max(SHOWRUNNER.minEmphasis, Math.min(SHOWRUNNER.maxEmphasis, x));

/**
 * The Vault-FREE signals for ONE simmering thread (the adapter fills these; all in [0,1], all derived
 * from the engine's own reads — never a premise/trigger, never a raw hidden number crosses into here).
 */
export interface ThreadSignal {
  /** The thread's stable id — the emphasis key and the seed-stable ranking tiebreaker. */
  threadId: string;
  /** Dramatic FRICTION with the player ∈ [0,1] — high threat / low affinity in either direction. */
  tension: number;
  /** STALENESS ∈ [0,1] — how long the thread has simmered without a beat (older ⇒ more "due"). */
  staleness: number;
  /** Current-board SALIENCE ∈ [0,1] — is the source nominated / cornered / holding power THIS beat. */
  salience: number;
}

/** One thread's producer-note emphasis: the CLAMPED, boost-only multiplier + a Vault-safe rationale. */
export interface ThreadEmphasis {
  threadId: string;
  /** A bounded multiplier in [minEmphasis, maxEmphasis] over the EXISTING 0060 surfacing roll. NEVER an
   *  outcome — the engine still rolls, and the hard 0060 caps still bind. */
  emphasis: number;
  /** Producer-language "why" — keyed off the numeric signals only (never a premise, never a number). */
  rationale: string;
}

/** A single producer's note (Vault-held). The SHAPE the showrunner proposes for the next tick. */
export interface ShowrunnerNote {
  /** Monotonic per-season sequence — the note's place in the production bible. */
  seq: number;
  /** The live (week, phase) the note was composed FOR — the beat it paces. */
  week: number;
  phase: string;
  /** The shortlist — top-K simmering threads to lean on, most-emphasized first. */
  emphases: ThreadEmphasis[];
}

/** The bounded blend of the three signals ∈ [0,1] — "how much should the season lean on this thread now". */
export function scoreThread(sig: ThreadSignal): number {
  const C = SHOWRUNNER;
  return clamp01(
    C.tensionWeight * clamp01(sig.tension)
    + C.stalenessWeight * clamp01(sig.staleness)
    + C.salienceWeight * clamp01(sig.salience),
  );
}

/** A producer-language rationale for the 0048 bible — keyed ONLY off the numeric signals (Vault-safe:
 *  no premise, no number ever appears here). Purely descriptive; it directs no outcome. */
function rationaleFor(sig: ThreadSignal): string {
  const parts: string[] = [];
  if (sig.tension >= 0.5) parts.push("high friction with the player");
  else if (sig.tension >= 0.25) parts.push("simmering friction");
  if (sig.staleness >= 0.6) parts.push("overdue for a beat");
  else if (sig.staleness >= 0.3) parts.push("been simmering a while");
  if (sig.salience >= 0.5) parts.push("central to the board this week");
  if (parts.length === 0) parts.push("keeping the pot stirred");
  return parts.join(", ");
}

/**
 * Compose the producer's note for a beat: score every simmering thread, take the top-K (seed-stable —
 * descending score, thread id as the tiebreaker), and assign each a CLAMPED, boost-only emphasis mapped
 * linearly from its score across [minEmphasis, maxEmphasis]. Pure + deterministic; no rng. An empty
 * signal set yields an empty note (the adapter simply records nothing to lean on this beat).
 */
export function composeShowrunnerNote(
  signals: readonly ThreadSignal[], week: number, phase: string, seq: number,
): ShowrunnerNote {
  const ranked = signals
    .map((s) => ({ s, score: scoreThread(s) }))
    .sort((a, b) => (b.score - a.score) || (a.s.threadId < b.s.threadId ? -1 : a.s.threadId > b.s.threadId ? 1 : 0));
  const emphases: ThreadEmphasis[] = ranked.slice(0, SHOWRUNNER.emphasisSlots).map(({ s, score }) => ({
    threadId: s.threadId,
    emphasis: clampEmphasis(SHOWRUNNER.minEmphasis + score * (SHOWRUNNER.maxEmphasis - SHOWRUNNER.minEmphasis)),
    rationale: rationaleFor(s),
  }));
  return { seq, week, phase, emphases };
}

/**
 * The emphasis multiplier the given thread carries in this note — the top-K shortlist's clamped value, or
 * the BASELINE `minEmphasis` (1.0 = no change) for any thread the note did not emphasize. So consuming a
 * note is boost-only and byte-identical to baseline for un-emphasized threads.
 */
export function emphasisForThread(note: ShowrunnerNote | undefined, threadId: string): number {
  if (!note) return SHOWRUNNER.minEmphasis;
  const found = note.emphases.find((e) => e.threadId === threadId);
  return found ? found.emphasis : SHOWRUNNER.minEmphasis;
}

/**
 * Feature 0101 (#1401) Phase-2 (#1455) — the OUTCOME-AFFECTING REWEIGHT ORDER. Given the scheduler's
 * threads in their stable DERIVE order (as a list of ids) and the current note, return a PERMUTATION OF
 * INDICES that moves the note's emphasized shortlist (the top `slots`, in NOTE order — most-emphasized
 * first) to the FRONT, leaving every other thread in its derive position (a STABLE partition). The caller
 * iterates the scheduler in this order, so an emphasized RIPE thread wins a SCARCE per-tick slot (activate
 * / surface) or the season surfacing cap ahead of a lower-priority one — the ONLY effect is WHICH open-set
 * storyline consumes a bounded slot. It re-orders NOTHING else (every cap still binds, every thread's roll
 * is its own id-keyed side rng invariant to order, every fold magnitude stays engine-owned + seeded, no
 * closed-set decision is touched — ADR 0005).
 *
 * PURE + deterministic (a stable sort keyed by note-rank then derive index). No note / empty emphases / an
 * all-baseline note (every emphasis at `minEmphasis`) / `slots <= 0` ⇒ the IDENTITY order (byte-identical to
 * no reweight), so an absent/off/un-emphasized note is a no-op by construction. Only GENUINELY-emphasized
 * threads (`emphasis > minEmphasis` — the SAME predicate `showrunnerEmphasizes` uses) enter the shortlist, so
 * a baseline (score-0, "no change") thread never jumps the queue on the mere tiebreaker. A thread not on the
 * (clamped-to-`slots`) shortlist keeps the baseline priority — the reweight is boost-only (it never DEMOTES a
 * thread below its own derive-order pacing, only promotes the shortlist above it), mirroring the Phase-1
 * `minEmphasis` floor.
 */
export function reweightThreadOrder(
  threadIds: readonly string[], note: ShowrunnerNote | undefined, slots: number = SHOWRUNNER.reweightSlots,
): number[] {
  const identity = threadIds.map((_, i) => i);
  if (!note || note.emphases.length === 0 || slots <= 0) return identity;
  // The shortlist that jumps the queue: the note's top-`slots` GENUINELY-emphasized emphases, in note order
  // (already score-ranked, most-emphasized first). A BASELINE entry (score 0 ⇒ `emphasis === minEmphasis`,
  // "no change") is NOT a real emphasis — it matches `showrunnerEmphasizes`'s `> minEmphasis` predicate
  // exactly — so it must never consume a scarce reweight slot or reorder the queue on the mere id tiebreaker.
  // Filter FIRST, then take the top-`slots` (the emphases sort score-desc, so any baseline entries sit last).
  const shortlist = note.emphases.filter((e) => e.emphasis > SHOWRUNNER.minEmphasis).slice(0, slots);
  if (shortlist.length === 0) return identity; // an all-baseline note emphasizes nothing ⇒ identity (no reweight)
  // `rank` maps a shortlisted thread id → its front-of-queue slot.
  const rank = new Map<string, number>();
  shortlist.forEach((e, i) => rank.set(e.threadId, i));
  // STABLE partition: shortlisted threads first (by their slot), then every other thread in DERIVE order
  // (the derive index is the tiebreaker for both partitions), so nothing but the promotion changes.
  return identity.sort((a, b) => {
    const ra = rank.get(threadIds[a]!) ?? Number.POSITIVE_INFINITY;
    const rb = rank.get(threadIds[b]!) ?? Number.POSITIVE_INFINITY;
    return (ra - rb) || (a - b);
  });
}

/**
 * Render one producer note for the 0048 retrospective ("the season's production bible"). VAULT-SAFE by
 * construction: it names each emphasized thread's SOURCE (a public name, resolved via the caller's
 * `sourceNameOf`) and its class/position `rationale`, and describes the emphasis QUALITATIVELY (never the
 * raw multiplier, never a premise, never a hidden number). Pure. The caller (`buildVaultUnseal`) gates
 * this behind the finished-season / debug-unseal wall — a note is never rendered on a live player/admin
 * surface.
 */
export function showrunnerNoteToProse(note: ShowrunnerNote, sourceNameOf: (threadId: string) => string): string {
  const beat = `Week ${note.week} (${note.phase})`;
  if (note.emphases.length === 0) return `${beat}: the producers let the house breathe this beat.`;
  const mid = (SHOWRUNNER.minEmphasis + SHOWRUNNER.maxEmphasis) / 2;
  const leans = note.emphases.map((e) => {
    const lean = e.emphasis >= mid ? "leaned hard on" : "kept an eye on";
    return `${lean} ${sourceNameOf(e.threadId)}'s thread (${e.rationale})`;
  });
  return `${beat}: the producers ${leans.join("; then ")}.`;
}
