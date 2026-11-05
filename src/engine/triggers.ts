/**
 * TRIGGER SECRETS & HOUSE-EVENT ERUPTIONS (feature 0091) — the pure engine layer.
 *
 * A houseguest's volatile, sealed `trigger` hidden element (a buried temper, a grudge they smile
 * through, a desperate streak) stays inert until accumulated STRESS meets a fresh SPARK and a
 * temperature roll — then it FIRES, emitting an emergent, Vault-safe PUBLIC house event the player
 * witnesses (a screaming match, a showmance detonating, a mask slipping). The hidden attribute stays
 * sealed; only the eruption is seen (the inverse companion to 0075's confidences — there a sealed
 * attribute becomes player knowledge by being TOLD; here a different sealed attribute produces a
 * WITNESSED public consequence while the attribute itself stays fully hidden).
 *
 * THIS MODULE IS PURE + ENGINE-ONLY (Vault-sealed). It is HANDED the already-read soul signals + scene
 * signals; it holds NO Vault handle, does NO I/O, and (except `eruptionEvent`, which consults the
 * EventStore read-only for anti-repeat) reads only its arguments. The eruption-pool LINE it returns is
 * a GENERIC, name-free, sealed-wording-free public scene type — the model dresses it in its own voice
 * from the public board (mandate #3: the model never selects a trigger, never reads the sealed
 * attribute, never invents one). No outward surface may import this (dependency-cruiser).
 *
 * Calibration (the load-bearing guarantee, mandate's determinism callout): `shouldFire` draws exactly
 * ONE rng value, on the DEDICATED session side-rng the orchestrator hands it — NEVER the shared tick
 * stream that resolves the seeded society/vote/comp spine. With `ORWELL_TRIGGERS` off (the default) the
 * orchestrator never calls in here at all ⇒ zero draws ⇒ the calibration harness is byte-identical.
 */
import type { EventStore } from "../ports/EventStore";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { clamp01Raw as clamp01 } from "../domain/num";
import {
  TRIGGER,
  type TriggerConstants,
  type EruptionKind,
} from "./triggerConstants";

/**
 * The live STRAIN on a houseguest ∈ [0,1] — where the season has them (sealed, live soul, 0041). High
 * distress (`emotionalState` well below the calm baseline of 0.5) and/or high live `volatility` is a
 * wound-tight houseguest. This is the charge the player CAN observe accumulating — through behavior, a
 * rattled tone (0084), a "wound tight" rumor (0086). Recent blows (a blindside, a betrayal, comp losses,
 * time on the block) are exactly what `evolveEmotion` already pushed into the soul. Pure: a deterministic
 * read of the (already-read) soul scalars, no rng.
 */
export function strain(
  soul: { emotionalState: number; volatility: number; emotionalBaseline?: number },
  c: TriggerConstants = TRIGGER,
): number {
  const baseline = soul.emotionalBaseline ?? 0.5;
  // distress = how far BELOW the calm baseline the soul has been pushed, scaled to [0,1].
  const distress = soul.emotionalState < baseline ? (baseline - soul.emotionalState) / baseline : 0;
  return clamp01(distress * c.distressWeight + clamp01(soul.volatility) * c.volatilityStrainWeight);
}

/**
 * The PRESSURE on a trigger ∈ [0,1] (engine-owned, the spec's `volatility × strain × precipitant`).
 * `volatility` is who they are (the sealed, static charge minted on the trigger element); `strainNow`
 * is where the season has them (the live read above); `precipitant` is what just happened THIS tick — a
 * real spark ∈ [0,1] (a fresh conflict, a betrayal landing, a showmance partner pulling away, a
 * nomination). With NO spark (`precipitant <= 0`) pressure is 0 — the no-cold-open guarantee, a trigger
 * never fires out of a quiet stretch. Below the strain floor pressure is also 0 — a near-baseline soul
 * never detonates the same trigger. Pure, no rng.
 */
export function pressure(
  volatility: number,
  strainNow: number,
  precipitant: number,
  c: TriggerConstants = TRIGGER,
): number {
  if (precipitant <= 0) return 0; // no spark ⇒ no detonation (the no-cold-open guarantee)
  if (strainNow < c.strainFloor) return 0; // too calm to blow, however volatile the secret
  return clamp01(volatility) * clamp01(strainNow) * clamp01(precipitant);
}

/** A minimal view of a trigger hidden element the fire check needs (the sealed `detail` stays out of here). */
export interface TriggerLike {
  /** How easily it goes off ∈ [0,1] — the sealed, static charge minted on the element. */
  volatility: number;
  /** The PUBLIC eruption scene type it maps to (never the sealed cause). */
  kind: EruptionKind;
}

/**
 * The fire DECISION (engine-owned, seeded). Eruptions are RARE even at high pressure: the check is
 * `rng.next() < pressure × fireRate`, with `fireRate` bounded low (a treat, not a flood; sibling to
 * `hiddenSurfacingRate`). Temperature (the seeded roll) governs the SURPRISE — the player can't predict
 * the exact moment — without ever overriding a hard rule. Draws EXACTLY ONE rng value (always, even when
 * pressure is 0, so the caller's stream position is deterministic) on the DEDICATED side-rng the
 * orchestrator hands it. Same seed + same (strain, precipitant) ⇒ same decision (criterion: determinism).
 */
export function shouldFire(
  trigger: TriggerLike,
  strainNow: number,
  precipitant: number,
  rng: RandomnessSource,
  c: TriggerConstants = TRIGGER,
): boolean {
  const p = pressure(trigger.volatility, strainNow, precipitant, c);
  const roll = rng.next(); // ALWAYS one draw — keeps the dedicated stream's position deterministic
  return roll < p * c.fireRate;
}

/**
 * The eruption pool, keyed to the trigger's PUBLIC eruption `kind`. Each line is a complete, voiceable
 * public happening — generic, name-free, and carrying NO sealed trigger wording (mandate #2): the player
 * sees THAT a blow-up happened (and can infer who, from observable behavior + the narration), never that
 * it was caused by a buried temper. Same shape as `HOUSE_EVENT_POOL` (the narrator attaches the people in
 * its own voice from the public board). Two+ lines per kind so the anti-repeat selector has a choice.
 */
export const ERUPTION_POOLS: Record<EruptionKind, readonly string[]> = {
  "blow-up": [
    "A simmering grudge finally boils over into a shouting match that empties the room.",
    "A long-swallowed resentment erupts into a screaming match at the kitchen counter.",
    "A quiet feud detonates into a confrontation the whole house stops to watch.",
  ],
  "showmance-detonation": [
    "A showmance detonates in front of the whole house, and the fallout splits the room.",
    "A couple's private tension explodes into a public breakup at the dinner table.",
    "A showmance implodes mid-conversation, and everyone pretends not to listen.",
  ],
  "mask-slips": [
    "A houseguest who has played it cool all season finally lets the mask slip — and everyone notices.",
    "A carefully kept composure cracks, and the room sees a side no one expected.",
    "A houseguest's easy smile drops for a moment, and the whole house clocks it.",
  ],
  meltdown: [
    "The pressure of the week breaks one houseguest into a public meltdown over something small.",
    "A houseguest comes apart over a trivial slight, and the room goes quiet around them.",
    "The week's strain finally cracks someone open in the middle of the kitchen.",
  ],
};

export interface EruptionEventOpts {
  week: number;
  phase: string;
}

/** The canonical weekly cadence day index (matches `houseEvents.dayOfWeek`) — duplicated to keep this
 *  module dependency-free; an eruption is day-indexed like every house event. */
function dayOfWeek(phase: string): number | null {
  const p = phase.toLowerCase();
  if (p.includes("hoh")) return 1;
  if (p.includes("nomination")) return 2;
  if (p.includes("veto") && p.includes("cerem")) return 4;
  if (p.includes("veto")) return 3;
  if (p.includes("evict")) return 5;
  if (p.includes("final") || p.includes("jury")) return 5;
  return null;
}

/**
 * The PUBLIC, player-witnessed eruption event line for a fired trigger (engine-authored). Seeded (the
 * rng decides which pool line), grounded (week + day index prefix the content, like every house event),
 * and never a verbatim repeat of the previous `house-event` — the store is queried for the last recorded
 * one and the pick excludes its line (the `nextHouseEvent` anti-repeat pattern, so two consecutive house
 * events can never share content). Returns ONLY a generic pool line: no name, no sealed wording, no number
 * (the connection trigger → event stays Vault-side). Draws exactly one rng value (the pool pick), on the
 * caller's DEDICATED side-rng.
 */
export function eruptionEvent(
  kind: EruptionKind,
  events: EventStore,
  rng: RandomnessSource,
  opts: EruptionEventOpts,
): string {
  const prior = events.query({ type: "house-event" });
  const lastContent = prior.length > 0 ? prior[prior.length - 1]!.content : null;
  const full = ERUPTION_POOLS[kind];
  // Exclude the immediately-preceding house-event's line; if that would empty the (small) pool, fall
  // back to the full pool so a line is always produced (never throws).
  const filtered = full.filter((line) => lastContent === null || !lastContent.includes(line));
  const pool = filtered.length > 0 ? filtered : full;
  const line = pool[Math.floor(rng.next() * pool.length)]!;
  const day = dayOfWeek(opts.phase);
  const stamp = day === null ? `Week ${opts.week}` : `Week ${opts.week}, day ${day}`;
  return `${stamp}: ${line}`;
}
