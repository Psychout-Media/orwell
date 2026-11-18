import type { Soul } from "./characterFactory";
import type { TellKind, TellBand } from "./tellTypes";
import { composedEmotion } from "./emotionalArc";
import { clamp01 } from "../domain/num";
import { moodBandOf, type MoodBand } from "./moodBand";

/**
 * B12 / B8 slice 1 (design `npc-strategy-design.md` 15.2, E0) - OBSERVABLE TELLS. A pure, deterministic read of a houseguest's soul into a small CLOSED set of tells that the room can see:
 * `withdrawn tearful snapping brittle-calm giddy warm-open guarded restless`. Each carries an intensity band (faint / clear / strong) and a channel (body / voice / behaviour). A tell is derived
 * from the independent affect axes (`confidence`, `distress`), the temperament drift and the volatility, with HYSTERESIS against the previous tells so the same houseguest stays brittle tomorrow
 * (a tell only changes when the arc crosses a band edge by a margin). No numbers ever leave this module (kind/band/channel are words), no rng, no I/O, no Vault. Wiring (persistence, the narrator,
 * the FE chip, observer reaction) is later slices behind flags; with the layer absent this changes nothing. The top `MAX_TELLS` (ASSUMED 2, pending Ryne) by intensity are returned.
 */
export type { TellKind, TellBand }; // defined in tellTypes.ts (a leaf module) so characterFactory can name them without importing this file - that import closed a cycle
export type TellChannel = "body" | "voice" | "behaviour";
export interface Tell { kind: TellKind; band: TellBand; channel: TellChannel }

export const TELLS = {
  maxTells: 2,
  /** Intensity (0..1) at which a tell becomes visible at all / clear / strong. */
  show: 0.3, clear: 0.5, strong: 0.7,
  /** A previously-shown tell stays visible/at its band until intensity falls this far below the edge. */
  hysteresis: 0.06,
  /** Axis thresholds. */
  high: 0.62, low: 0.38,
} as const;

/** The narrated read's axis scale: the axes live in [floor, 1] (SOUL_DEPTH.axisBaseline is 0.5); `mid` splits low from high, `span` is how far above it a tell reaches full strength. */
const FELT = { floor: 0.5, mid: 0.2, span: 0.4 } as const;

const CHANNEL: Readonly<Record<TellKind, TellChannel>> = {
  withdrawn: "behaviour", tearful: "body", snapping: "voice", "brittle-calm": "voice",
  giddy: "behaviour", "warm-open": "body", guarded: "behaviour", restless: "body",
};


function bandOf(intensity: number, prev: TellBand | undefined): TellBand | undefined {
  const h = TELLS.hysteresis;
  const edge = (e: number, was: boolean): number => (was ? e - h : e);
  const rank = prev === "strong" ? 3 : prev === "clear" ? 2 : prev === "faint" ? 1 : 0;
  if (intensity >= edge(TELLS.strong, rank >= 3)) return "strong";
  if (intensity >= edge(TELLS.clear, rank >= 2)) return "clear";
  if (intensity >= edge(TELLS.show, rank >= 1)) return "faint";
  return undefined;
}

/** Raw intensity per tell kind, from the axes. Absent axes fall back to the single `emotionalState` scalar (confidence = state, distress = 1 - state). */
function intensities(soul: Soul, felt = false): Record<TellKind, number> {
  const conf = clamp01(soul.confidence ?? soul.emotionalState);
  const dist = clamp01(soul.distress ?? 1 - soul.emotionalState);
  const drift = soul.temperamentDrift ?? 0;
  const vol = clamp01(soul.volatility);
  const composed = composedEmotion(soul);
  const up = (x: number, edge: number, span: number): number => clamp01((x - edge) / span);
  const down = (x: number, edge: number, span: number): number => clamp01((edge - x) / span);
  // ORW-576: the axes START at their floor and only rise, so the old edges (centred on a mid-range value) left every "low" tier (withdrawn, tearful, giddy, warm-open) unreachable. `felt` rescales to the
  // axis's REAL range [floor, 1]: "low" = near the floor, "high" = clearly lifted, disjoint at one edge. Off (the persisted decision path) keeps the old edges byte-for-byte.
  const fl = (x: number): number => clamp01((x - FELT.floor) / (1 - FELT.floor));
  const distHigh = felt ? up(fl(dist), FELT.mid, FELT.span) : up(dist, TELLS.high - 0.12, 0.4);
  const confLow = felt ? down(fl(conf), FELT.mid, FELT.mid) : down(conf, TELLS.low + 0.12, 0.4);
  const confHigh = felt ? up(fl(conf), FELT.mid, FELT.span) : up(conf, TELLS.high - 0.12, 0.4);
  const distLow = felt ? down(fl(dist), FELT.mid, FELT.mid) : down(dist, TELLS.low + 0.12, 0.4);
  const clash = clamp01(drift / 0.6);
  const bond = clamp01(-drift / 0.6);
  return {
    withdrawn: distHigh * confLow,
    tearful: distHigh * confLow * (1 - clash) * (0.5 + 0.5 * vol),
    snapping: distHigh * confHigh,
    "brittle-calm": distHigh * confHigh * (1 - vol) * 0.9,
    giddy: confHigh * distLow * (0.5 + 0.5 * vol),
    "warm-open": confHigh * distLow * (1 - 0.5 * vol) * (0.6 + 0.4 * bond),
    guarded: clash * (0.5 + 0.5 * down(composed, 0.55, 0.4)),
    restless: vol > 0.6 ? clamp01((vol - 0.6) / 0.4) * Math.max(distHigh, confHigh) : 0,
  };
}

/**
 * The houseguest's current observable tells, strongest first, at most `maxTells`. `previous` (the tells returned last time) supplies the hysteresis so a tell persists across scenes and days and
 * only moves when the arc crosses a band edge by `TELLS.hysteresis`. A calm soul (no axis past its threshold) returns [].
 */
export function tellsOf(soul: Soul, previous: readonly Tell[] = []): Tell[] {
  const prevBand = new Map(previous.map((t) => [t.kind, t.band] as const));
  const raw = intensities(soul);
  const out: Array<Tell & { i: number }> = [];
  for (const kind of Object.keys(raw) as TellKind[]) {
    const i = raw[kind];
    const band = bandOf(i, prevBand.get(kind));
    if (band) out.push({ kind, band, channel: CHANNEL[kind], i });
  }
  out.sort((a, b) => b.i - a.i || (a.kind < b.kind ? -1 : 1));
  return out.slice(0, TELLS.maxTells).map(({ kind, band, channel }) => ({ kind, band, channel }));
}

/**
 * B28 (#2017 15.2 E0b) - PERSISTED tells. A small additive record per houseguest `{ kind, since, band }` kept on the soul so the same houseguest is still brittle tomorrow: the hysteresis in `tellsOf` needs
 * the PREVIOUS tells, which used to be thrown away between reads. `since` is the in-game week the kind first appeared and stays put while the kind persists (a band change keeps `since`). Words and
 * weeks only - never a number or a cause. Pure: `refreshTells` returns the next record and how many NEW kinds began (the monotonic onset count the session persists).
 */
export interface PersistedTell { kind: TellKind; since: number; band: TellBand }

/** The channel a tell kind is voiced through (body / voice / behaviour): a fixed mapping, not stored. */
export const tellChannel = (kind: TellKind): TellChannel => CHANNEL[kind];

export function refreshTells(soul: Soul, now: number): { tells: PersistedTell[]; onsets: number } {
  const prev = soul.tells ?? [];
  const next = tellsOf(soul, prev.map((t) => ({ kind: t.kind, band: t.band, channel: CHANNEL[t.kind] })));
  const sinceOf = new Map(prev.map((t) => [t.kind, t.since] as const));
  let onsets = 0;
  const tells = next.map((t) => {
    if (!sinceOf.has(t.kind)) onsets++;
    return { kind: t.kind, since: sinceOf.get(t.kind) ?? now, band: t.band };
  });
  return { tells, onsets };
}

/** A coarse closed-set faithfulness check (design 15.5): the narrated kind must not be the OPPOSITE of an engine tell. */
export const OPPOSITE: Readonly<Record<TellKind, readonly TellKind[]>> = {
  withdrawn: ["giddy", "warm-open", "snapping"], tearful: ["giddy", "warm-open"], snapping: ["withdrawn", "warm-open"],
  "brittle-calm": ["giddy", "restless"], giddy: ["withdrawn", "tearful", "guarded"], "warm-open": ["guarded", "snapping", "withdrawn"],
  guarded: ["warm-open", "giddy"], restless: ["brittle-calm"],
};


/** Which tell kinds lean negative / positive; the rest (guarded, restless) lean neither. Closed engine sets, never player text. */
const NEGATIVE_KINDS: ReadonlySet<TellKind> = new Set<TellKind>(["withdrawn", "tearful", "snapping", "brittle-calm"]);
const POSITIVE_KINDS: ReadonlySet<TellKind> = new Set<TellKind>(["giddy", "warm-open"]);

/** May this tell stand beside a mood in this band? A low mood never carries a positive tell; a high mood never carries a negative one. The middle allows both. */
export function tellAgreesWithBand(kind: TellKind, band: MoodBand): boolean {
  return !(band === "low" && POSITIVE_KINDS.has(kind)) && !(band === "high" && NEGATIVE_KINDS.has(kind));
}

/**
 * ORW-576 - the NARRATED tells (a played game's narrator + roster chip). Same kinds, same hysteresis, but (1) the axis edges are rescaled to the axes' real range so every tier is reachable and (2) the
 * mood word's own band (`moodBandOf`, the ONE bucketing shared with `moodWord`) vetoes a tell that would contradict it. The persisted tells that feed decisions stay on `tellsOf` and are untouched.
 */
export function narratedTellsOf(soul: Soul, previous: readonly Tell[] = []): Tell[] {
  if (soul.distress === undefined || soul.confidence === undefined) return tellsOf(soul, previous).filter((t) => tellAgreesWithBand(t.kind, moodBandOf(soul.emotionalState, soul.emotionalHistory)));
  const band = moodBandOf(soul.emotionalState, soul.emotionalHistory);
  const prevBand = new Map(previous.map((t) => [t.kind, t.band] as const));
  const raw = intensities(soul, true);
  const out: Array<Tell & { i: number }> = [];
  for (const kind of Object.keys(raw) as TellKind[]) {
    if (!tellAgreesWithBand(kind, band)) continue;
    const i = raw[kind];
    const b = bandOf(i, prevBand.get(kind));
    if (b) out.push({ kind, band: b, channel: CHANNEL[kind], i });
  }
  out.sort((a, b) => b.i - a.i || (a.kind < b.kind ? -1 : 1));
  return out.slice(0, TELLS.maxTells).map(({ kind, band: bd, channel }) => ({ kind, band: bd, channel }));
}
