/**
 * ORW-253 slice 3 core - HOUR-BY-HOUR HOUSE LIFE (theme 1, NPC minds; design approved by Ryne 2026-11-12, vault "NPC Minds Design
 * Theme 1", section 2). Replaces "pick a pair, pick 1 of 7 stock scene types" (offscreen.ts) with: every AWAKE houseguest takes ONE
 * action each game hour, chosen from their agenda's next step, their mood, their habits and who is around; people in the same room are
 * merged into scenes. Ryne 2026-11-11: "The fact there are only 7 types seems wild to me."
 *
 * An action is built from PARTS, so the combinations run to thousands:
 *  - what they do (an action from a library of ~40 in seven families: information, alliances, safety, attack, house life, romance, alone);
 *  - who it is with (one, a few, a group, or nobody);
 *  - where (any walkable room - they go there on purpose to do it);
 *  - how (warm, cold, nervous, angry, playful - from mood);
 *  - honest or false (for things said: the engine records when a houseguest says what it knows is untrue; themes 2 and 4 build on it).
 *
 * Rules kept: asleep = no action at all (the caller passes only the awake set; ORW-256); during a competition only PUBLIC reactions
 * (ORW-232/256); the player is never moved or acted for (the caller excludes them as an actor; an NPC may still choose to go to the
 * player - "they come to you because of their goals"). Pure and deterministic: a local hash, no shared rng. Engine-only (Vault class):
 * plans name goals and truthfulness. The overseer half wires it in place of the 7-type tick, records each scene as a hidden event
 * (witness set = the participants; the player only when present, which makes it a witnessed, non-secret scene), and folds it through the
 * existing interaction types.
 */
import type { EntityId } from "../domain/ids";
import type { Room } from "../domain/house";
import type { InteractionType } from "./relationshipConstants";
import type { TimeOfDay } from "./timeOfDay";
import type { Agenda, AgendaCharacter, Goal, GoalKind } from "./agenda";
import { agendaRoll } from "./agenda";
import { HOUSE_LIFE, type Habit } from "./houseLifeConstants";

// --- The action library --------------------------------------------------------------------------------------------------------------

export type ActionFamily = "information" | "alliances" | "safety" | "attack" | "house-life" | "romance" | "alone";
export type ActionKind =
  // information
  | "fish" | "test-a-rumor" | "plant" | "confirm" | "leak" | "keep-quiet"
  // alliances
  | "pitch" | "recruit" | "check-in" | "count-votes" | "split-roles" | "lobby-for"
  // safety
  | "beg" | "bargain" | "call-in-favor" | "make-a-promise" | "lie-low"
  // attack
  | "drive-a-wedge" | "frame" | "flip-a-vote" | "campaign-against" | "confront"
  // house life
  | "gossip" | "cook" | "work-out" | "do-chores" | "nap" | "prank" | "comfort" | "chore-fight" | "homesick-talk" | "bed-talk" | "game-of-cards" | "sunbathe" | "tell-stories"
  // romance
  | "flirt" | "cuddle"
  // alone
  | "mull" | "vent-in-diary-room" | "study-for-comps" | "pray" | "talk-to-cameras"
  // public reactions (the only kinds allowed during a competition)
  | "cheer" | "taunt" | "sulk";

export type Manner = "warm" | "cold" | "nervous" | "angry" | "playful";

interface ActionSpec {
  family: ActionFamily;
  /** How many others it needs (0 = alone). */
  partners: { min: number; max: number };
  /** The interaction type it folds through (the relationship model's existing bounded folds); undefined = no edge fold (solo). */
  fold?: InteractionType;
  /** True for things SAID that can be false (a plant, a promise, a pitch...). */
  speech: boolean;
  /** Allowed while a competition is running (public reactions only). */
  publicOnly?: boolean;
  /** Where it naturally happens, if it has a usual place. */
  place?: Room;
}

export const ACTIONS: Readonly<Record<ActionKind, ActionSpec>> = {
  fish: { family: "information", partners: { min: 1, max: 1 }, fold: "gossip", speech: true },
  "test-a-rumor": { family: "information", partners: { min: 1, max: 1 }, fold: "gossip", speech: true },
  plant: { family: "information", partners: { min: 1, max: 2 }, fold: "gossip", speech: true },
  confirm: { family: "information", partners: { min: 1, max: 1 }, fold: "strategy", speech: true },
  leak: { family: "information", partners: { min: 1, max: 1 }, fold: "gossip", speech: true },
  "keep-quiet": { family: "information", partners: { min: 0, max: 0 }, speech: false },
  pitch: { family: "alliances", partners: { min: 1, max: 1 }, fold: "alliance", speech: true },
  recruit: { family: "alliances", partners: { min: 1, max: 2 }, fold: "alliance", speech: true },
  "check-in": { family: "alliances", partners: { min: 1, max: 1 }, fold: "strategy", speech: true },
  "count-votes": { family: "alliances", partners: { min: 1, max: 3 }, fold: "strategy", speech: true, place: "storage-room" },
  "split-roles": { family: "alliances", partners: { min: 1, max: 3 }, fold: "strategy", speech: true },
  "lobby-for": { family: "alliances", partners: { min: 1, max: 1 }, fold: "strategy", speech: true },
  beg: { family: "safety", partners: { min: 1, max: 1 }, fold: "strategy", speech: true },
  bargain: { family: "safety", partners: { min: 1, max: 1 }, fold: "strategy", speech: true },
  "call-in-favor": { family: "safety", partners: { min: 1, max: 1 }, fold: "strategy", speech: true },
  "make-a-promise": { family: "safety", partners: { min: 1, max: 1 }, fold: "alliance", speech: true },
  "lie-low": { family: "safety", partners: { min: 0, max: 0 }, speech: false },
  "drive-a-wedge": { family: "attack", partners: { min: 1, max: 1 }, fold: "gossip", speech: true },
  frame: { family: "attack", partners: { min: 1, max: 2 }, fold: "gossip", speech: true },
  "flip-a-vote": { family: "attack", partners: { min: 1, max: 1 }, fold: "strategy", speech: true },
  "campaign-against": { family: "attack", partners: { min: 1, max: 2 }, fold: "strategy", speech: true },
  confront: { family: "attack", partners: { min: 1, max: 1 }, fold: "conflict", speech: true },
  gossip: { family: "house-life", partners: { min: 1, max: 2 }, fold: "gossip", speech: true },
  cook: { family: "house-life", partners: { min: 0, max: 3 }, fold: "bonding", speech: false, place: "kitchen" },
  "work-out": { family: "house-life", partners: { min: 0, max: 2 }, fold: "bonding", speech: false, place: "backyard" },
  "do-chores": { family: "house-life", partners: { min: 0, max: 2 }, fold: "bonding", speech: false, place: "kitchen" },
  nap: { family: "house-life", partners: { min: 0, max: 0 }, speech: false },
  prank: { family: "house-life", partners: { min: 1, max: 2 }, fold: "bonding", speech: false },
  comfort: { family: "house-life", partners: { min: 1, max: 1 }, fold: "bonding", speech: true },
  "chore-fight": { family: "house-life", partners: { min: 1, max: 1 }, fold: "conflict", speech: true, place: "kitchen" },
  "homesick-talk": { family: "house-life", partners: { min: 1, max: 2 }, fold: "bonding", speech: true },
  "bed-talk": { family: "house-life", partners: { min: 1, max: 2 }, fold: "bonding", speech: true },
  "game-of-cards": { family: "house-life", partners: { min: 1, max: 3 }, fold: "bonding", speech: false, place: "dining-room" },
  sunbathe: { family: "house-life", partners: { min: 0, max: 2 }, fold: "bonding", speech: false, place: "backyard" },
  "tell-stories": { family: "house-life", partners: { min: 1, max: 4 }, fold: "bonding", speech: true, place: "living-room" },
  flirt: { family: "romance", partners: { min: 1, max: 1 }, fold: "showmance", speech: true },
  cuddle: { family: "romance", partners: { min: 1, max: 1 }, fold: "showmance", speech: false },
  mull: { family: "alone", partners: { min: 0, max: 0 }, speech: false },
  "vent-in-diary-room": { family: "alone", partners: { min: 0, max: 0 }, speech: true, place: "diary-room" },
  "study-for-comps": { family: "alone", partners: { min: 0, max: 0 }, speech: false },
  pray: { family: "alone", partners: { min: 0, max: 0 }, speech: false },
  "talk-to-cameras": { family: "alone", partners: { min: 0, max: 0 }, speech: true },
  cheer: { family: "house-life", partners: { min: 1, max: 1 }, fold: "bonding", speech: true, publicOnly: true },
  taunt: { family: "attack", partners: { min: 1, max: 1 }, fold: "conflict", speech: true, publicOnly: true },
  sulk: { family: "alone", partners: { min: 0, max: 0 }, speech: false, publicOnly: true },
};

// --- Habits ---------------------------------------------------------------------------------------------------------------------------

export type { Habit };
const HABIT_ACTION: Readonly<Record<Habit, { action: ActionKind; when: readonly TimeOfDay[] }>> = {
  "early-riser": { action: "do-chores", when: ["morning"] },
  "night-owl": { action: "bed-talk", when: ["night", "late-night"] },
  "gym-rat": { action: "work-out", when: ["morning", "afternoon"] },
  "house-cook": { action: "cook", when: ["morning", "evening"] },
  "neat-freak": { action: "do-chores", when: ["afternoon", "evening"] },
  napper: { action: "nap", when: ["afternoon"] },
  devout: { action: "pray", when: ["morning", "night"] },
  "camera-talker": { action: "talk-to-cameras", when: ["afternoon", "night"] },
  storyteller: { action: "tell-stories", when: ["evening", "night"] },
  "card-shark": { action: "game-of-cards", when: ["evening"] },
  "sun-seeker": { action: "sunbathe", when: ["afternoon"] },
};
export const HABITS = Object.keys(HABIT_ACTION) as Habit[];

/**
 * A houseguest's habits (two or three). Seeded from the character: their archetype and style lean the draw (a comp beast is likelier a
 * gym rat), and a personal hash picks the rest. Slice 5 lets the model write habits from the backstory instead; these are the engine's.
 */
export function habitsFor(c: AgendaCharacter, owner: EntityId, seed: number): Habit[] {
  const lean = HOUSE_LIFE.habitLean[c.archetype] ?? [];
  const scored = HABITS.map((h) => ({ h, w: (lean.includes(h) ? HOUSE_LIFE.habitLeanBonus : 0) + agendaRoll(seed, owner, `habit:${h}`) }))
    .sort((a, b) => b.w - a.w || a.h.localeCompare(b.h));
  const count = 2 + (agendaRoll(seed, owner, "habit-count") < 0.5 ? 1 : 0);
  return scored.slice(0, count).map((x) => x.h);
}

// --- Choosing an action ---------------------------------------------------------------------------------------------------------------

/** Everything the holder can see this hour, from their own view. */
export interface HourView {
  owner: EntityId;
  character: AgendaCharacter;
  agenda: Agenda | undefined;
  habits: readonly Habit[];
  /** Soul emotional state 0..1 (0.5 calm). */
  emotional: number;
  /** Where they are now. */
  room: Room;
  /** Awake houseguests and where they are (the holder's eyes: the presence model). Includes the player if awake. */
  whereabouts: ReadonlyMap<EntityId, Room>;
  /** The holder's affinity and threat reads (0..1). */
  affinity: ReadonlyMap<EntityId, number>;
  threat: ReadonlyMap<EntityId, number>;
  /** Alliance mates now. */
  mates: readonly EntityId[];
  /** This week's HOH and nominees (public board). */
  hoh?: EntityId;
  nominees: readonly EntityId[];
  /** A showmance partner, if any (the relationship model's emergent label, read by the caller). */
  showmance?: EntityId;
  timeOfDay: TimeOfDay;
  day: number;
  hour: number;
  /** True while a competition is running: public reactions only. */
  inCompetition: boolean;
  /** ORW-329: people they avoid in free time (an ex from before the show). A goal step may still seek them out. */
  avoid?: readonly EntityId[];
  /** The candor of the holder's speech (from REASONS candor tables, passed by the caller), 0..1. */
  candor: number;
  /** ORW-337: this season's authored house rituals (spec 0146 lane 2); absent when the model wrote none (or the write-back has not landed). */
  rituals?: ReadonlyArray<{ timeOfDay: TimeOfDay; action: ActionKind; name: string }>;
}

export interface PlannedAction {
  actor: EntityId;
  kind: ActionKind;
  with: EntityId[];
  place: Room;
  manner: Manner;
  /** For speech: false when the holder says something it knows is untrue (Vault-class). Always true for non-speech. */
  truthful: boolean;
  /** The goal this serves (Vault-class), if any. */
  goalId?: string;
  goalKind?: GoalKind;
  /** Who the action is ABOUT when that is not a partner (the target being campaigned against, the person being framed). */
  about?: EntityId;
  /** ORW-337: the name of the house ritual this action is (a PUBLIC name: the scene records it so the narrator may use it once the player has seen one). */
  ritual?: string;
  /** ORW-324: the interaction type this action folds through (defaults to the action's own; pitching someone not yet an ally is strategy talk, not an alliance). */
  fold?: InteractionType;
}

/** ORW-324: how quick this houseguest is to direct friction (0..1), by archetype. A hothead clashes, a peacemaker almost never. */
export function temperOf(c: AgendaCharacter): number {
  return HOUSE_LIFE.temper[c.archetype] ?? 0.3;
}

/** ORW-324: the fold an action actually makes. Recruiting, pitching and promising build an ALLIANCE only with someone already allied; otherwise it is strategy talk. */
export function foldOf(kind: ActionKind, partner: EntityId | undefined, mates: readonly EntityId[]): InteractionType | undefined {
  const base = ACTIONS[kind].fold;
  if ((kind === "pitch" || kind === "recruit" || kind === "make-a-promise") && partner !== undefined && !mates.includes(partner)) return "strategy";
  return base;
}

const mannerOf = (emotional: number, kind: ActionKind): Manner => {
  const fam = ACTIONS[kind].family;
  if (fam === "attack") return emotional < 0.35 ? "angry" : "cold";
  if (kind === "prank" || kind === "game-of-cards" || kind === "flirt") return "playful";
  if (emotional < 0.3) return "nervous";
  return fam === "house-life" || fam === "romance" || kind === "comfort" ? "warm" : emotional < 0.45 ? "nervous" : "warm";
};

const MAIN_AIMS: ReadonlySet<GoalKind> = new Set<GoalKind>(["win-by-comps", "win-by-being-liked", "run-the-house", "reach-jury", "last-alliance-standing", "prove-not-a-floater"]);

/** Who is awake and not the holder, by room. */
function others(v: HourView): EntityId[] {
  return [...v.whereabouts.keys()].filter((p) => p !== v.owner).sort();
}
const roomOf = (v: HourView, p: EntityId): Room => v.whereabouts.get(p) ?? v.room;
const byScore = (xs: EntityId[], f: (p: EntityId) => number): EntityId[] => [...xs].sort((a, b) => f(b) - f(a) || a.localeCompare(b));

/** The next step for one goal: an action, with whom, about whom. Returns undefined when nothing useful can be done this hour. */
export function nextStepFor(goal: Goal, v: HourView, variant = 0): Omit<PlannedAction, "actor" | "manner" | "truthful" | "place"> & { place?: Room } | undefined {
  // A season-long aim is lived in many small ways, not one repeated move: `variant` (a 0..1 roll) picks among its fitting actions.
  const among = <T,>(xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(variant * xs.length))]!;
  const v2 = (variant * 7.31) % 1; // a second, independent-enough roll from the same draw
  const pool = others(v);
  const t = goal.target;
  const aff = (p: EntityId): number => v.affinity.get(p) ?? 0.4;
  const thr = (p: EntityId): number => v.threat.get(p) ?? 0.3;
  const voters = pool.filter((p) => p !== v.hoh && !v.nominees.includes(p) && p !== t);
  const pick = (k: ActionKind, partners: EntityId[], about?: EntityId) =>
    partners.length >= ACTIONS[k].partners.min ? { kind: k, with: partners.slice(0, Math.max(ACTIONS[k].partners.min, 1) || 0), goalId: goal.id, goalKind: goal.kind, ...(about ? { about } : {}) } : undefined;
  switch (goal.kind) {
    case "get-them-out": case "revenge": {
      if (!t) return undefined;
      // ORW-324: sharing a room with the person they want gone, a quick-tempered houseguest clashes with them directly (a rattled mood makes it likelier).
      if (roomOf(v, t) === v.room && pool.includes(t)) {
        const heat = temperOf(v.character) * (1 + Math.max(0, 0.5 - v.emotional)) * (goal.kind === "revenge" ? 1.3 : 1);
        if (variant < heat) return pick("confront", [t]);
      }
      const ears = byScore(voters, aff);
      // A campaign is many small moves: lobbying the HOH, but mostly working the house (stories, wedges, fishing), not one repeated pitch.
      if (v.nominees.includes(t)) return pick("flip-a-vote", ears, t);
      if (v.hoh && v.hoh !== v.owner && v2 < 0.3) return pick("campaign-against", [v.hoh], t);
      const k: ActionKind = among(goal.kind === "revenge" ? (["frame", "plant", "drive-a-wedge", "fish"] as const) : (["drive-a-wedge", "plant", "fish", "test-a-rumor"] as const));
      return pick(k, ears, t);
    }
    case "stay-safe": {
      if (v.hoh && v.hoh !== v.owner && !v.nominees.includes(v.owner)) return pick(aff(v.hoh) > 0.5 ? "check-in" : "make-a-promise", [v.hoh]);
      if (v.nominees.includes(v.owner)) {
        const swing = byScore(voters, (p) => aff(p) - thr(p));
        return pick(aff(swing[0] ?? "") > 0.55 ? "call-in-favor" : "beg", swing);
      }
      return { kind: "lie-low", with: [], goalId: goal.id, goalKind: goal.kind };
    }
    // ORW-324: winning someone over is mostly time spent with them; an explicit pitch is the occasional step, not every hour.
    case "pull-them-in": return t ? pick(among(["pitch", "check-in", "comfort", "tell-stories", "cook", "game-of-cards"] as const) === "pitch" ? (aff(t) > 0.7 ? "recruit" : "pitch") : among(["pitch", "check-in", "comfort", "tell-stories", "cook", "game-of-cards"] as const), [t]) : undefined;
    case "keep-them-safe": return t ? pick(v.hoh && v.hoh !== v.owner ? "lobby-for" : "count-votes", v.hoh && v.hoh !== v.owner ? [v.hoh] : byScore(voters, aff), t) : undefined;
    case "protect-my-person": return t ? pick(among(["check-in", "comfort", "tell-stories", "cook"] as const), [t]) : undefined;
    case "long-con": return t ? (v.nominees.includes(t) ? pick("flip-a-vote", byScore(voters, aff), t) : pick(among(["check-in", "comfort", "tell-stories", "game-of-cards"] as const), [t], t)) : undefined;
    case "find-out": return pick(t ? "fish" : "test-a-rumor", byScore(pool.filter((p) => p !== t), aff), t);
    case "win-power": return { kind: "study-for-comps", with: [], goalId: goal.id, goalKind: goal.kind };
    case "keep-my-secret": return undefined; // a secret is kept by what they DON'T do: it shapes speech (themes 2 and 4), not an hourly action
    case "last-alliance-standing": return v.mates.length ? pick(among(["split-roles", "check-in", "count-votes"] as const), byScore([...v.mates].filter((m) => pool.includes(m)), aff)) : undefined;
    case "run-the-house": return pick(among(["count-votes", "fish", "check-in", "pitch"] as const), byScore(pool, (p) => aff(p) + (variant > 0.5 ? -aff(p) * 0.5 : 0)));
    case "win-by-being-liked": return pick(among(["comfort", "tell-stories", "check-in", "cook"] as const), byScore(pool, (p) => -Math.abs(aff(p) - 0.5)));
    default: return undefined;
  }
}

/**
 * The ONE thing this houseguest does this hour. Order: a public reaction during a competition; otherwise the strongest goal's next step
 * when the holder's drive to pursue it beats the pull of ordinary life (habit, time of day, mood, a showmance); otherwise house life.
 * Purposeful actions go where the partner is (they walk there on purpose); house life happens in its usual room or where they are.
 */
export function chooseHourAction(v: HourView, seed: number): PlannedAction {
  const roll = (salt: string): number => agendaRoll(seed, v.owner, `hour:d${v.day}h${v.hour}:${salt}`);
  const pool = others(v);
  const avoid = new Set(v.avoid ?? []);
  const here = pool.filter((p) => roomOf(v, p) === v.room && !avoid.has(p));
  const finish = (a: Omit<PlannedAction, "actor" | "manner" | "truthful" | "place"> & { place?: Room }): PlannedAction => {
    const spec = ACTIONS[a.kind];
    const place = a.place ?? (a.with[0] !== undefined ? roomOf(v, a.with[0]) : spec.place ?? v.room);
    const lieBase = a.goalKind === "long-con" || a.kind === "frame" || a.kind === "plant" ? HOUSE_LIFE.schemingLieBoost : 0;
    const truthful = !spec.speech || roll("truth") < Math.max(0, v.candor - lieBase);
    const fold = foldOf(a.kind, a.with[0], v.mates);
    return { actor: v.owner, ...a, place, manner: mannerOf(v.emotional, a.kind), truthful, ...(fold && fold !== ACTIONS[a.kind].fold ? { fold } : {}) };
  };

  if (v.inCompetition) {
    const target = byScore(here.length ? here : pool, (p) => Math.abs((v.affinity.get(p) ?? 0.4) - 0.5))[0];
    if (!target) return finish({ kind: "sulk", with: [] });
    const fond = (v.affinity.get(target) ?? 0.4) >= 0.5;
    return finish({ kind: v.emotional < 0.35 ? "sulk" : fond ? "cheer" : "taunt", with: v.emotional < 0.35 ? [] : [target], place: v.room });
  }

  const goals = [...(v.agenda?.goals ?? [])].filter((g) => g.status === "active").sort((a, b) => b.commitment - a.commitment || a.id.localeCompare(b.id));
  const lifePull = HOUSE_LIFE.lifePull[v.timeOfDay] + (v.emotional > 0.6 ? HOUSE_LIFE.contentLifeBonus : 0);
  for (const g of goals) {
    // A season-long MAIN aim is a background pull; week goals and emergent season goals (revenge, a long con, a secret) are the pressing ones.
    const drive = g.commitment * HOUSE_LIFE.goalDrive * (MAIN_AIMS.has(g.kind) ? HOUSE_LIFE.mainAimDrive : 1);
    if (drive < lifePull * roll(`life:${g.id}`)) continue; // ordinary life wins over THIS goal this hour; a more pressing one may still win
    const step = nextStepFor(g, v, roll(`variant:${g.id}`));
    if (step) return finish(step);
  }

  // House life: a showmance partner nearby, a habit for this time of day, a low mood, or whoever is around.
  if (v.showmance && pool.includes(v.showmance) && roll("romance") < HOUSE_LIFE.romanceChance) return finish({ kind: roll("cuddle") < 0.5 ? "flirt" : "cuddle", with: [v.showmance] });
  // ORW-337 (spec 0146 lane 2): a house ritual pulls anyone free into its action at its time of day, gathering them where it happens (the same shape as a habit), and the scene carries its name.
  const ritual = v.rituals?.find((r) => r.timeOfDay === v.timeOfDay && roll(`ritual:${r.name}`) < HOUSE_LIFE.ritualPull);
  if (ritual) {
    const spot = ACTIONS[ritual.action].place;
    const company = spot ? pool.filter((p) => roomOf(v, p) === spot && !avoid.has(p)) : here;
    return finish({ kind: ritual.action, with: company.slice(0, ACTIONS[ritual.action].partners.max), ritual: ritual.name, ...(spot ? { place: spot } : {}) });
  }
  const habit = v.habits.find((h) => HABIT_ACTION[h].when.includes(v.timeOfDay) && roll(`habit:${h}`) < HOUSE_LIFE.habitChance);
  if (habit) {
    const k = HABIT_ACTION[habit].action;
    const spot = ACTIONS[k].place;
    const company = spot ? pool.filter((p) => roomOf(v, p) === spot && !avoid.has(p)) : here;
    const max = ACTIONS[k].partners.max;
    return finish({ kind: k, with: company.slice(0, max), ...(spot ? { place: spot } : {}) });
  }
  if (v.emotional < 0.3) {
    const friend = byScore(here, (p) => v.affinity.get(p) ?? 0)[0];
    return finish(friend && (v.affinity.get(friend) ?? 0) > 0.55 ? { kind: "homesick-talk", with: [friend] } : { kind: roll("vent") < 0.5 ? "vent-in-diary-room" : "mull", with: [] });
  }
  const partner = byScore(here, (p) => (v.affinity.get(p) ?? 0.4) + roll(`who:${p}`) * 0.3)[0];
  if (!partner) return finish({ kind: v.timeOfDay === "late-night" || v.timeOfDay === "night" ? "mull" : "nap", with: [] });
  // ORW-324: friction is not only between enemies. Mild dislike plus a short temper or a bad mood is enough for a chore fight.
  const dislike = Math.max(0, HOUSE_LIFE.frictionAffinity - (v.affinity.get(partner) ?? 0.4)) / HOUSE_LIFE.frictionAffinity;
  const friction = dislike > 0 && roll("friction") < HOUSE_LIFE.frictionChance * (0.5 + dislike) * (0.5 + temperOf(v.character)) * (1 + Math.max(0, 0.5 - v.emotional) * 2);
  // ORW-324: talking about whoever isn't in the room is half of Big Brother downtime (the house's ordinary gossip, not a scheme).
  const absent = [...v.threat.keys()].filter((p) => p !== partner && roomOf(v, p) !== v.room).sort((a, b) => (v.threat.get(b) ?? 0) - (v.threat.get(a) ?? 0) || a.localeCompare(b));
  if (!friction && absent.length > 0 && v.timeOfDay !== "late-night" && roll("gossip") < HOUSE_LIFE.gossipChance * (v.timeOfDay === "night" ? 0.6 : 1)) {
    return finish({ kind: "gossip", with: [partner], about: absent[Math.floor(roll("gossip-about") * Math.min(3, absent.length))]! });
  }
  const pickLife: ActionKind = friction ? "chore-fight"
    : v.timeOfDay === "late-night" ? (roll("late") < 0.6 ? "bed-talk" : "homesick-talk")
    : v.timeOfDay === "night" ? (["bed-talk", "tell-stories", "game-of-cards", "homesick-talk"] as const)[Math.floor(roll("night") * 4)]!
    : roll("prank") < HOUSE_LIFE.prankChance ? "prank" : "tell-stories";
  return finish({ kind: pickLife, with: [partner, ...(pickLife === "tell-stories" ? here.filter((p) => p !== partner).slice(0, 2) : [])] });
}

// --- Merging the hour into scenes -----------------------------------------------------------------------------------------------------

export interface HourScene {
  place: Room;
  /** Everyone taking part (actors and partners), sorted. */
  participants: EntityId[];
  /** Each actor's own action (one scene can hold two people with different purposes: one begs, the other bargains). */
  actions: PlannedAction[];
}

/**
 * Merge one hour's plans into scenes: actions in the same room that share a participant join one scene (a houseguest who is someone
 * else's partner is in that scene too). Solo actions stay their own scene. Deterministic order.
 */
export function assembleScenes(plans: readonly PlannedAction[]): HourScene[] {
  const scenes: HourScene[] = [];
  for (const p of [...plans].sort((a, b) => a.actor.localeCompare(b.actor))) {
    const people = [p.actor, ...p.with];
    const join = p.with.length === 0 ? undefined : scenes.find((s) => s.place === p.place && people.some((x) => s.participants.includes(x)));
    if (join) {
      join.actions.push(p);
      for (const x of people) if (!join.participants.includes(x)) join.participants.push(x);
      join.participants.sort();
    } else {
      scenes.push({ place: p.place, participants: [...new Set(people)].sort(), actions: [p] });
    }
  }
  return scenes;
}

/** ORW-315: the engine's one-line record of an action (ids, never names; hidden content until a pathway carries it). */
const VERB: Readonly<Record<ActionKind, string>> = {
  fish: "fished for information from", "test-a-rumor": "tested a rumor on", plant: "planted a story with", confirm: "confirmed a plan with",
  leak: "leaked something to", "keep-quiet": "kept quiet", pitch: "pitched an alliance to", recruit: "tried to recruit", "check-in": "checked in with",
  "count-votes": "counted votes with", "split-roles": "split up the plan with", "lobby-for": "lobbied", beg: "begged", bargain: "bargained with",
  "call-in-favor": "called in a favor with", "make-a-promise": "made a promise to", "lie-low": "laid low", "drive-a-wedge": "drove a wedge with",
  frame: "tried to frame someone to", "flip-a-vote": "worked to flip the vote of", "campaign-against": "campaigned to", confront: "confronted",
  gossip: "gossiped with", cook: "cooked with", "work-out": "worked out with", "do-chores": "did chores with", nap: "napped", prank: "pranked", comfort: "comforted",
  "chore-fight": "fought over chores with", "homesick-talk": "talked about home with", "bed-talk": "talked late in bed with",
  "game-of-cards": "played cards with", sunbathe: "sunbathed with", "tell-stories": "told stories with", flirt: "flirted with", cuddle: "cuddled with",
  mull: "mulled things over", "vent-in-diary-room": "vented in the Diary Room", "study-for-comps": "studied for comps", pray: "prayed",
  "talk-to-cameras": "talked to the cameras", cheer: "cheered on", taunt: "taunted", sulk: "sulked",
};
export function actionLine(p: PlannedAction): string {
  const who = p.with.length ? ` ${p.with.join(", ")}` : "";
  const about = p.about && !p.with.includes(p.about) ? (p.kind === "lobby-for" ? ` for ${p.about}` : ` about ${p.about}`) : "";
  return `${p.actor} ${VERB[p.kind]}${who}${about}`;
}
