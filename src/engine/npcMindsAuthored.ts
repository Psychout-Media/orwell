/**
 * ORW-319 (ORW-253 slice 5, spec docs/features/0146-npc-minds-model-words.md, lanes 1 and 2; Ryne approved the NPC minds design
 * 2026-11-12): the engine's validation of what the utility model WRITES at cast time.
 *
 *  - Lane 1, per houseguest: habits (2-3 from the closed `Habit` set) and a season-aim HINT (a closed `SeasonGoalKind`) with a short why,
 *    read by the model from the houseguest's PUBLIC profile (backstory, vocation, identity). The engine adjudicates: habits replace the
 *    engine-drawn ones; the aim hint only ADDS a bounded bonus to that aim's lean (it shapes, never forces).
 *  - Lane 2, once per season: house culture from the cast's PUBLIC facets: up to 3 nicknamed spots (a walkable room), up to 3 rituals
 *    (a time of day + a house-life action + a name), a running joke.
 *
 * Every string is untrusted model text: control characters flattened, length capped, and a value that names an engine id (`npc:N`) or
 * carries a number-like secret marker is dropped. Pure. Closed sets only cross into the engine's decisions (ADR 0005 / 0022).
 */
import type { EntityId } from "../domain/ids";
import { WALKABLE_ROOMS, type Room } from "../domain/house";
import type { TimeOfDay } from "./timeOfDay";
import { HABITS, ACTIONS, type ActionKind, type Habit } from "./houseLife";
import type { SeasonGoalKind } from "./agendaConstants";

export const AUTHORED = {
  /** The bonus a model aim hint adds to that season aim's lean (spec 0146: shapes, never forces). */
  aimHintBonus: 0.4,
  /** A ritual's pull on its action at its time of day for anyone free (spec 0146; read by the hourly life wiring). */
  ritualPull: 0.3,
  maxWhy: 80, maxName: 40, maxJoke: 80, maxSpots: 3, maxRituals: 3, minHabits: 2, maxHabits: 3,
} as const;

const AIMS: readonly SeasonGoalKind[] = ["win-by-comps", "win-by-being-liked", "run-the-house", "reach-jury", "last-alliance-standing", "prove-not-a-floater"];
const TIMES: readonly TimeOfDay[] = ["morning", "afternoon", "evening", "night", "late-night"];

export interface AuthoredTraits { habits: Habit[]; aimHint?: SeasonGoalKind; aimWhy?: string }
export interface HouseCulture {
  spots: Array<{ room: Room; nickname: string }>;
  rituals: Array<{ timeOfDay: TimeOfDay; action: ActionKind; name: string }>;
  runningJoke?: string;
}

/** Flatten control characters, collapse whitespace, cap length; empty, id-bearing or digit-heavy text is refused (undefined). */
export function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const flat = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!flat || /npc:\d+/i.test(flat) || (flat.match(/\d/g)?.length ?? 0) > 4) return undefined;
  return flat.length > max ? flat.slice(0, max).trimEnd() : flat;
}

/** Lane 1: validate one houseguest's authored traits. Undefined when the habits are not 2-3 distinct known habits. */
export function validateTraits(raw: unknown): AuthoredTraits | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const habits = Array.isArray(r["habits"]) ? [...new Set(r["habits"].filter((h): h is Habit => typeof h === "string" && (HABITS as string[]).includes(h)))] : [];
  if (habits.length < AUTHORED.minHabits) return undefined;
  const aim = typeof r["aimHint"] === "string" && (AIMS as string[]).includes(r["aimHint"]) ? (r["aimHint"] as SeasonGoalKind) : undefined;
  const why = aim ? cleanText(r["aimWhy"], AUTHORED.maxWhy) : undefined;
  return { habits: habits.slice(0, AUTHORED.maxHabits), ...(aim ? { aimHint: aim } : {}), ...(why ? { aimWhy: why } : {}) };
}

/** Lane 2: validate the house culture. Undefined when nothing usable survives. */
export function validateCulture(raw: unknown): HouseCulture | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const spots: HouseCulture["spots"] = [];
  for (const s of Array.isArray(r["spots"]) ? r["spots"] : []) {
    const o = (s ?? {}) as Record<string, unknown>;
    const nickname = cleanText(o["nickname"], AUTHORED.maxName);
    if (typeof o["room"] === "string" && (WALKABLE_ROOMS as readonly string[]).includes(o["room"]) && nickname && !spots.some((x) => x.room === o["room"])) {
      spots.push({ room: o["room"] as Room, nickname });
    }
    if (spots.length >= AUTHORED.maxSpots) break;
  }
  const rituals: HouseCulture["rituals"] = [];
  for (const s of Array.isArray(r["rituals"]) ? r["rituals"] : []) {
    const o = (s ?? {}) as Record<string, unknown>;
    const name = cleanText(o["name"], AUTHORED.maxName);
    const a = o["action"];
    const ok = typeof a === "string" && a in ACTIONS && ACTIONS[a as ActionKind].family === "house-life" && !ACTIONS[a as ActionKind].publicOnly;
    if (typeof o["timeOfDay"] === "string" && (TIMES as string[]).includes(o["timeOfDay"]) && ok && name) {
      rituals.push({ timeOfDay: o["timeOfDay"] as TimeOfDay, action: a as ActionKind, name });
    }
    if (rituals.length >= AUTHORED.maxRituals) break;
  }
  const runningJoke = cleanText(r["runningJoke"], AUTHORED.maxJoke);
  if (spots.length === 0 && rituals.length === 0 && !runningJoke) return undefined;
  return { spots, rituals, ...(runningJoke ? { runningJoke } : {}) };
}

/** The persisted record on the live season (write-once per houseguest and once for the culture: frozen like the zeitgeist). */
export interface NpcMindsAuthored {
  traits?: Record<EntityId, AuthoredTraits>;
  culture?: HouseCulture;
  /** ORW-320: nightly reflections written AFTER the crown (first person, <= 60 words), write-once per houseguest-night. Vault-class: read only by the post-season retrospective. */
  reflections?: Record<EntityId, Array<{ night: number; text: string }>>;
}

/** ORW-320: validate one reflection's text: a clean sentence run, <= 60 words, no engine id, no number-heavy text. Undefined when unusable. */
export function validateReflection(raw: unknown): string | undefined {
  const t = cleanText(raw, 480);
  if (!t) return undefined;
  return t.split(/\s+/).length > 60 ? undefined : t;
}
