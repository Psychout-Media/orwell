import { clamp01Raw as clamp01 } from "../domain/num";
import type { Room } from "../domain/house";
import type { TimeOfDay } from "./timeOfDay";

/**
 * ORW-651 (Ryne approved 2026-11-17) - THE HABITS SYSTEM: each houseguest has habits and routines (mornings and beyond) from their backstory, shaping where they are
 * and what they do. FOUNDATION ONLY (pure, no I/O, no rng: callers pass keyed rolls; no Vault). Spec 0209; the build goes to A or B.
 *
 * Today (houseLife.ts `HABITS`) a houseguest draws 2-3 of 11 fixed habit names: a closed menu feeding a hashed pick, which the no-short-lists rule (Ryne 11-17)
 * rules out for new work. A ROUTINE here is COMPOSED instead: a time of day x a room x an action (from the ~40-action house-life library), with a strength and an
 * optional regular companion. The cast-authoring model writes each houseguest's routines FROM THEIR BACKSTORY (a write-back, validated here by `validRoutine`); the
 * engine floor composes them from the character when no model is wired (`composeFloorRoutine`, every dimension its own keyed roll). The routine's words (what the
 * narrator calls it) come from the authored backstory, never from a list.
 *
 * What it does: a routine pulls its holder to its room at its time and into its action (`followsRoutine`), more weakly under stress. Others LEARN it by seeing it
 * on separate days (`knowsRoutine`), so the player (and NPCs) can find someone where their routine puts them. The player in both directions: the player's own
 * routine is never assigned; NPCs learn it from where the player is actually seen, the same way.
 */
export const ROUTINES = {
  /** Routines per houseguest (authored or floor). */
  perPerson: { min: 2, max: 4 },
  /** The chance, at full strength and an easy mind, that a houseguest is in their routine at its time (otherwise their agenda or the moment decides). */
  followAtFull: 0.7,
  /** Stress (low mood, on the block) scales the pull down to this share: routines slip when the game bites. */
  stressedShare: 0.45,
  /** An onlooker knows a routine after seeing it on this many separate days. */
  learnAfterDays: 3,
  /** The morning (8am, the whole house's wake-up per Ryne 11-06): a morning routine at or above this strength means up and about before the call. */
  earlyRiserStrength: 0.6,
  /** ORW-981: how much more a houseguest who knows where the player usually is at this time of day leans toward them (a multiplier of one plus this on the pull). */
  playerHauntGain: 0.5,
} as const;

/** Who usually shares the routine: nobody, one regular (a named houseguest the build resolves), or whoever is around. */
export type RoutineCompany = "alone" | "a-regular" | "whoever";

/** One routine. `action` is a house-life library key (houseLife.ts `ActionKind`), kept a string here so the module stays below houseLife in the import graph. */
export interface Routine {
  slot: TimeOfDay;
  place: Room;
  action: string;
  company: RoutineCompany;
  strength: number;
  /** Where it came from: written by the model from the backstory, or the engine's floor. */
  source: "authored" | "floor";
  /** The authored words for it (the model's, from the backstory; absent on the floor, where the narrator words it from the action and place). Engine-held, voiced by the narrator. */
  gist?: string;
}

/** Does the routine pull its holder now? One keyed roll against the strength, scaled down under stress. */
export function followsRoutine(r: Routine, now: TimeOfDay, stressed: boolean, roll: number): boolean {
  if (r.slot !== now) return false;
  const p = ROUTINES.followAtFull * clamp01(r.strength) * (stressed ? ROUTINES.stressedShare : 1);
  return clamp01(roll) < p;
}

/** Up before the 8am call? A strong morning routine. */
export const upBeforeTheCall = (rs: readonly Routine[]): boolean => rs.some((r) => r.slot === "morning" && r.strength >= ROUTINES.earlyRiserStrength);

/** An onlooker knows someone's routine once they have seen it on enough separate days (`days` = the distinct in-game days they saw it). */
export const knowsRoutine = (daysSeen: number): boolean => daysSeen >= ROUTINES.learnAfterDays;

/** Validate one authored routine against the house (rooms, times, the action library). Returns a clean routine, or undefined (dropped, never repaired into a different one). */
export function validRoutine(raw: unknown, rooms: ReadonlySet<string>, slots: ReadonlySet<string>, actions: ReadonlySet<string>): Routine | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const { slot, place, action, company, strength, gist } = r;
  if (typeof slot !== "string" || !slots.has(slot)) return undefined;
  if (typeof place !== "string" || !rooms.has(place)) return undefined;
  if (typeof action !== "string" || !actions.has(action)) return undefined;
  const co: RoutineCompany = company === "a-regular" || company === "whoever" ? company : "alone";
  const s = typeof strength === "number" && Number.isFinite(strength) ? clamp01(strength) : 0.5;
  const words = typeof gist === "string" && gist.trim() ? gist.trim().slice(0, 160) : undefined;
  return { slot: slot as TimeOfDay, place: place as Room, action, company: co, strength: s, source: "authored", ...(words ? { gist: words } : {}) };
}

/** Pick one element by a roll in [0,1). */
const at = <T>(xs: readonly T[], roll: number): T => xs[Math.min(xs.length - 1, Math.floor(clamp01(roll) * xs.length))]!;

/**
 * The engine floor: compose one routine from the character's leaning candidates, each dimension its own keyed roll. The caller passes the candidates the character
 * leans to (from archetype, style and temperament: e.g. a comp beast's actions lean physical), never a fixed habit menu; with times x rooms x ~40 actions the
 * space is hundreds of routines, not a short list.
 */
export function composeFloorRoutine(c: { slots: readonly TimeOfDay[]; rooms: readonly Room[]; actions: readonly string[] }, rolls: { slot: number; place: number; action: number; company: number; strength: number }): Routine {
  const company: RoutineCompany = rolls.company < 0.5 ? "alone" : rolls.company < 0.75 ? "a-regular" : "whoever";
  return { slot: at(c.slots, rolls.slot), place: at(c.rooms, rolls.place), action: at(c.actions, rolls.action), company, strength: 0.35 + 0.55 * clamp01(rolls.strength), source: "floor" };
}
