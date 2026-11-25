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
import { TERRITORY } from "./territory";
import { PLAYER } from "../domain/ids";
import type { EntityId } from "../domain/ids";
import type { Room } from "../domain/house";
import type { InteractionType } from "./relationshipConstants";
import type { TimeOfDay } from "./timeOfDay";
import type { Agenda, AgendaCharacter, Goal, GoalKind } from "./agenda";
import { agendaRoll } from "./agenda";
import { ATTRACTION_LIFE } from "./attractionLife";
import { seekPull } from "./attraction";
import { CULTURE_CANDOR_SHIFT, HOUSE_LIFE, type HouseCulture, type Habit } from "./houseLifeConstants";
import { composeFloorRoutine, ROUTINES, type Routine } from "./routines";
import { isStressed, routineKey, routineNow } from "./routineLife";
import { TIME_OF_DAY_ORDER } from "./timeOfDay";
import { HOUSE_ROOMS } from "../domain/house";

// --- The action library --------------------------------------------------------------------------------------------------------------

export type ActionFamily = "information" | "alliances" | "safety" | "attack" | "house-life" | "romance" | "alone";
export type ActionKind =
  // information
  | "fish" | "test-a-rumor" | "plant" | "confirm" | "leak"
  // alliances
  | "pitch" | "recruit" | "check-in" | "count-votes" | "split-roles" | "lobby-for"
  // safety
  | "beg" | "bargain" | "call-in-favor" | "make-a-promise" | "lie-low"
  // attack
  | "drive-a-wedge" | "frame" | "flip-a-vote" | "campaign-against" | "confront"
  // house life
  | "gossip" | "debrief" | "cook" | "work-out" | "do-chores" | "nap" | "prank" | "comfort" | "chore-fight" | "homesick-talk" | "bed-talk" | "game-of-cards" | "sunbathe" | "tell-stories"
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
  // ORW-566 (spec 0183): a close pair's private debrief at their own spot after a ceremony. Folds like any bonding scene (same magnitude class), so it never distorts an edge.
  debrief: { family: "house-life", partners: { min: 1, max: 1 }, fold: "bonding", speech: true },
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

/** ORW-651 (0209): where a routine of this act happens when the act has no usual place of its own: the shared rooms (never a bedroom, the HOH room or the diary room, which are someone's own or private). */
const ROUTINE_ROOMS: readonly Room[] = HOUSE_ROOMS.filter((r) => !r.startsWith("bedroom") && r !== "hoh-room" && r !== "diary-room");
/** The acts a habit can be: ordinary life done alone or in company (never strategy, never a competition reaction, never the private diary room). Derived from the action library, not listed. */
const ROUTINE_ACTIONS: readonly ActionKind[] = (Object.keys(ACTIONS) as ActionKind[]).filter((k) => {
  const a = ACTIONS[k];
  // done alone or in company, or a shared pastime with a usual place that needs someone there (a clash is never a habit)
  return (a.family === "house-life" || a.family === "alone") && (a.partners.min === 0 || a.place !== undefined) && !a.publicOnly && a.place !== "diary-room" && a.fold !== "conflict";
});

/**
 * ORW-651 (0209): the engine's floor routines for a houseguest: two to four, each composed from a time of day (distinct), a place, an act, a company and a strength, every part its own keyed roll
 * (`agendaRoll`, a local hash: no shared rng). The archetype's lean (the same data that leaned the old habit draw) doubles the weight of the acts it leans to; the act's own usual place wins over a rolled one.
 * When the cast-authoring write-back lands routines they replace these; until then this stands in (and says `floor`).
 */
export function floorRoutinesFor(c: AgendaCharacter, owner: EntityId, seed: number): Routine[] {
  const lean = (HOUSE_LIFE.habitLean[c.archetype] ?? []).map((h) => HABIT_ACTION[h].action);
  const { min, max } = ROUTINES.perPerson;
  const count = min + Math.min(max - min, Math.floor(agendaRoll(seed, owner, "routine-count") * (max - min + 1)));
  // which acts: each act's own keyed roll, the archetype's lean adding a bonus (the old habit draw's shape), the top `count`; so the acts are distinct
  const acts = [...ROUTINE_ACTIONS].map((k) => ({ k, w: (lean.includes(k) ? HOUSE_LIFE.habitLeanBonus : 0) + agendaRoll(seed, owner, `routine-act:${k}`) }))
    .sort((a, b) => b.w - a.w || a.k.localeCompare(b.k)).slice(0, count).map((x) => x.k);
  return acts.map((k, i) => {
    // when: a time the act naturally belongs to (the times the old habits kept it); an act with none is kept at a time of day when the house is up
    const natural = [...new Set(Object.values(HABIT_ACTION).filter((h) => h.action === k).flatMap((h) => h.when))];
    const slots = natural.length ? natural : TIME_OF_DAY_ORDER.filter((t) => t !== "late-night");
    const r = composeFloorRoutine({ slots, rooms: ROUTINE_ROOMS, actions: [k] }, {
      slot: agendaRoll(seed, owner, `routine-slot:${i}`), place: agendaRoll(seed, owner, `routine-place:${i}`), action: 0,
      company: agendaRoll(seed, owner, `routine-company:${i}`), strength: 0,
    });
    const spec = ACTIONS[k];
    // an act that can be shared is not kept alone on the floor (a houseguest who does it alone is the authored case); the floor keeps a routine firmly (0.9 to 1: the pull itself is capped at 0.7)
    return { ...r, place: spec.place ?? r.place, company: spec.partners.max > 0 && r.company === "alone" ? (agendaRoll(seed, owner, `routine-who:${i}`) < 0.6 ? "whoever" : "a-regular") : r.company, strength: 0.9 + 0.1 * agendaRoll(seed, owner, `routine-strength:${i}`) };
  });
}

/** ORW-651 (0209): a save (or a cast-authoring pass) that wrote the old named habits keeps them: each becomes a routine at one of its own times, doing its own act, so no authored habit thins. */
export function routinesFromHabits(habits: readonly Habit[], owner: EntityId, seed: number): Routine[] {
  return habits.map((h, i) => {
    const { action, when } = HABIT_ACTION[h];
    const slot = when[Math.min(when.length - 1, Math.floor(agendaRoll(seed, owner, `routine-habit-slot:${i}`) * when.length))]!;
    const place = ACTIONS[action].place ?? ROUTINE_ROOMS[Math.min(ROUTINE_ROOMS.length - 1, Math.floor(agendaRoll(seed, owner, `routine-habit-place:${i}`) * ROUTINE_ROOMS.length))]!;
    return { slot, place, action, company: "whoever" as const, strength: HOUSE_LIFE.habitChance, source: "authored" as const };
  });
}

// --- Choosing an action ---------------------------------------------------------------------------------------------------------------

/** Everything the holder can see this hour, from their own view. */
export interface HourView {
  owner: EntityId;
  character: AgendaCharacter;
  agenda: Agenda | undefined;
  /** ORW-625: the step each goal's stored plan says is next (goal id -> step). A goal with a plan takes ITS step, waiting for the partner, instead of re-rolling the hour. Absent = byte-identical. */
  plans?: ReadonlyMap<string, PlanStep>;
  habits: readonly Habit[];
  /** ORW-651 (0209): this houseguest's routines. Present = the routine pull replaces the habit pull for the hour; absent = the habit branch, byte-identical. */
  routines?: readonly Routine[];
  /** Soul emotional state 0..1 (0.5 calm). */
  emotional: number;
  /** Where they are now. */
  room: Room;
  /** Awake houseguests and where they are (the holder's eyes: the presence model). Includes the player if awake. */
  whereabouts: ReadonlyMap<EntityId, Room>;
  /** The holder's affinity and threat reads (0..1). */
  affinity: ReadonlyMap<EntityId, number>;
  /** ORW-622 (mixed relationships): the holder's grudge strand toward each houseguest (0..1), from the bond record. Rubs at dinner even when they are warm. Absent = byte-identical. */
  rivalry?: ReadonlyMap<EntityId, number>;
  threat: ReadonlyMap<EntityId, number>;
  /** Alliance mates now. */
  mates: readonly EntityId[];
  /** This week's HOH and nominees (public board). */
  hoh?: EntityId;
  nominees: readonly EntityId[];
  /** A showmance partner, if any (the relationship model's emergent label, read by the caller). */
  showmance?: EntityId;
  /** 0207 A1 (ORW-658; played games, `ORWELL_SHOWMANCES`): the holder's PRIVATE attraction toward each person now (only people they are drawn to; 0..1; the player included when drawn). Moves only who they seek out
   *  and sit near, never shown. `flirtable`: those of them a flirt may start with (orientation-plausible both ways, nobody else's partner). Absent = byte-identical. */
  attract?: ReadonlyMap<EntityId, number>;
  flirtable?: ReadonlySet<EntityId>;
  timeOfDay: TimeOfDay;
  day: number;
  hour: number;
  /** ORW-581 (Fable T1-14): which stretch of this same game hour this is (0 or absent = the first). More than one off-screen tick can land in one hour (a beat that covered
   *  hours, a nap, a hang-out); the hour's rolls key on it so a second stretch rolls fresh dice instead of replaying the first one's choices. */
  repeat?: number;
  /** True while a competition is running: public reactions only. */
  inCompetition: boolean;
  /** ORW-656 (after the buzzer): the crown has just landed (the beat is still the one right after the comp) and `winner` holds it. Everyone reacts to the RESULT in public while they share the winner's room: congratulate (sincere or not, by candor), cold shoulder, sulk; the winner celebrates with whoever they are fondest of. Absent = byte-identical. */
  afterBuzzer?: { winner: EntityId };
  /** ORW-466 slice 4 (assigned beds): the room they sleep in (the HOH room for the HOH), their roommates and the one who shares their double. All absent in a game without beds (headless,
   *  calibration), which keeps that game's house life exactly as before. */
  bedroom?: Room;
  roommates?: readonly EntityId[];
  bedPartner?: EntityId;
  /** ORW-561 (spec 0176 part 2): awake houseguests who share the holder's top room (territory). Absent = no pull = byte-identical. */
  kindred?: ReadonlySet<EntityId>;
  /** ORW-329: people they avoid in free time (an ex from before the show). A goal step may still seek them out. */
  avoid?: readonly EntityId[];
  /** The candor of the holder's speech (from REASONS candor tables, passed by the caller), 0..1. */
  candor: number;
  /** ORW-337: this season's authored house rituals (spec 0146 lane 2); absent when the model wrote none (or the write-back has not landed). */
  rituals?: ReadonlyArray<{ timeOfDay: TimeOfDay; action: ActionKind; name: string }>;
  /** ORW-551 (spec 0168 slice 2): the season's house culture as multipliers on the baseline of gossip / conflict / flirting / lying. Absent = all exactly 1 = byte-identical. */
  culture?: HouseCulture;
  /** ORW-566 (spec 0183): the close pairs this houseguest keeps a debrief spot with, ONLY in the hours after a ceremony (the caller builds it; absent = byte-identical). `key` is the pair's stable key. */
  pairHabits?: ReadonlyArray<{ with: EntityId; room: Room; key: string }>;
  /** 0173 (Theme 3 slice 11): the court. The new HOH is sought out: `pull` is this houseguest's per-hour chance of going to them, `danger` when they are on the block or the HOH reads them as a threat. Absent = byte-identical. */
  court?: { pull: number; danger: boolean };
  /** ORW-590 (Fable T2-7): how much a listener is worth lying to FOR a goal aimed at `target` (0 = not a swing voter; the caller builds it from the listener's own read of the target, their credulity and a keyed rotation). Absent = the old best-friend-first order, byte-identical. */
  swing?: (listener: EntityId, target: EntityId) => number;
  /** ORW-620 (night owls): present only when the late-night mode is on in a played game. `playerUp`: the player is still awake, so an awake houseguest may seek THEM out (through the desire clock's own approach path); absent = byte-identical. */
  nightOwl?: { playerUp: boolean };
}

/** ORW-590: how a goal's audience is ranked once a swing read is supplied. A swing voter always outranks a non-swing one; the bond is only a small tiebreak. */
export const LIE_AUDIENCE = {
  /** A listener whose own read of the target leans less than this (0..1) is "on the fence". */
  minPivot: 0.4,
  /** Someone already in the planter's alliance is already on side: worth less to work on. */
  allyDiscount: 0.5,
  /** The planter is in the room with them. */
  sameRoom: 1.2,
  /** The bond's weight in the order (a tiebreak: it can never lift a non-swing voter above a swing one). */
  bondTiebreak: 0.02,
  /** Weight on credulity (0.5 + credulity). */
  credulityBase: 0.5,
  /** Hourly rotation spread so the same person is not worked every hour. */
  rotation: 0.25,
} as const;

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
  /** ORW-566: the pair key of the private habit this scene is (engine-only; the caller stamps it on the event). */
  habit?: string;
  /** ORW-324: the interaction type this action folds through (defaults to the action's own; pitching someone not yet an ally is strategy talk, not an alliance). */
  fold?: InteractionType;
  /** 0173: this step is the houseguest seeking out the HOH (the court). Engine-only. */
  court?: boolean;
  /** ORW-651: the key of the routine this step is (engine-only; the caller counts the player's sightings of it). */
  routine?: string;
  /** ORW-620: this step is a late-night talk among the awake few (the caller stamps it on the event; engine-only). */
  nightOwl?: boolean;
  /** 0207 A1: this step is a houseguest seeking out someone they are drawn to (engine-only; when that someone is the player it is an approach through the desire clock's own path). */
  drawn?: boolean;
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

/**
 * ORW-625 (Ryne approved 2026-11-17, Fable idea #2) - PLANS THAT LAST LONGER THAN AN HOUR. A goal's next step used to be re-rolled every game hour, so nobody worked a
 * plan across a day. Now the first hour a goal acts, a short plan is formed from it (`formPlan`: the steps it would take, fixed once), stored, and carried across hours and
 * days: each hour the goal takes its plan's next step, waiting for that step's partner if they are not here; it is dropped only for a reason (the goal ends, a partner
 * leaves the game, or it stalls). So a player can notice someone working on a person over days. Pure here; the adapter stores and advances the plan.
 */
export interface PlanStep { kind: ActionKind; with: EntityId[]; about?: EntityId }
export const GOAL_PLAN = {
  /** How many steps a plan holds (formed once, from the goal's own fitting actions). */
  steps: 3,
  /** A plan with no step taken for this many days is dropped as stalled (a fresh one forms the next time the goal acts). */
  stallDays: 2,
} as const;
/** Form a plan for a goal: the step it takes now, then the next ones it would take, each from its own fixed variant (no re-roll later). Steps with no partner reachable now are kept as they are (they wait). */
export function formPlan(goal: Goal, v: HourView, first: PlanStep, variantOf: (k: number) => number): PlanStep[] {
  const steps: PlanStep[] = [first];
  for (let k = 1; steps.length < GOAL_PLAN.steps && k < GOAL_PLAN.steps * 4; k++) {
    const s = nextStepFor(goal, v, variantOf(k));
    if (!s) continue;
    const step: PlanStep = { kind: s.kind, with: [...s.with], ...(s.about ? { about: s.about } : {}) };
    const last = steps[steps.length - 1]!;
    if (last.kind === step.kind && last.with.join() === step.with.join()) continue; // a plan is a sequence, not the same move three times
    steps.push(step);
  }
  return steps;
}
/** The plan's step as an action for this hour, if its partner(s) are reachable now; undefined = wait (the plan keeps its place). */
export function planStepNow(step: PlanStep, goal: Goal, v: HourView): (Omit<PlannedAction, "actor" | "manner" | "truthful" | "place"> & { place?: Room }) | undefined {
  const pool = others(v);
  if (!step.with.every((p) => pool.includes(p))) return undefined;
  return { kind: step.kind, with: [...step.with], goalId: goal.id, goalKind: goal.kind, ...(step.about ? { about: step.about } : {}) };
}

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
  // ORW-572 (Fable T1-3, Ryne: "sleep means no scheming"): a step only ever names a partner who is in the hour view (awake and reachable); a named HOH or target who is asleep or away is dropped, and a step that then lacks its partner is not taken.
  const pick = (k: ActionKind, partners: EntityId[], about?: EntityId) => {
    const here = partners.filter((p) => pool.includes(p));
    return here.length >= ACTIONS[k].partners.min ? { kind: k, with: here.slice(0, Math.max(ACTIONS[k].partners.min, 1) || 0), goalId: goal.id, goalKind: goal.kind, ...(about ? { about } : {}) } : undefined;
  };
  // ORW-590: the people worth working on for this goal: swing voters first (by how undecided and how credulous they are, whether the planter can reach them), the bond only a small tiebreak.
  // No swing read supplied, or nobody on the fence: the old best-friend-first order.
  const earsFor = (target: EntityId | undefined): EntityId[] => {
    const sw = v.swing;
    if (!sw || !target || !voters.some((p) => sw(p, target) > 0)) return byScore(voters, aff);
    const mine = new Set(v.mates);
    return byScore(voters, (p) => {
      const s = sw(p, target);
      return s > 0 ? s * (mine.has(p) ? LIE_AUDIENCE.allyDiscount : 1) * (roomOf(v, p) === v.room ? LIE_AUDIENCE.sameRoom : 1) + LIE_AUDIENCE.bondTiebreak * aff(p) : LIE_AUDIENCE.bondTiebreak * aff(p) - 1;
    });
  };
  switch (goal.kind) {
    case "get-them-out": case "revenge": {
      if (!t) return undefined;
      // ORW-324: sharing a room with the person they want gone, a quick-tempered houseguest clashes with them directly (a rattled mood makes it likelier).
      if (roomOf(v, t) === v.room && pool.includes(t)) {
        const hot = HOUSE_LIFE.hotConfront * Math.max(0, Math.min(1, (goal.commitment - HOUSE_LIFE.hotGoal) / (1 - HOUSE_LIFE.hotGoal))); // ORW-353: a hot goal confronts whatever the temper
        const heat = Math.min(1, temperOf(v.character) * (1 + Math.max(0, 0.5 - v.emotional)) * (goal.kind === "revenge" ? 1.3 : 1) + hot);
        if (variant < heat) return pick("confront", [t]);
      }
      const ears = earsFor(t);
      // A campaign is many small moves: lobbying the HOH, but mostly working the house (stories, wedges, fishing), not one repeated pitch.
      if (v.nominees.includes(t)) return pick("flip-a-vote", ears, t);
      if (v.hoh && v.hoh !== v.owner && v2 < 0.3) return pick("campaign-against", [v.hoh], t);
      const k: ActionKind = among(goal.kind === "revenge" ? (["frame", "plant", "drive-a-wedge", "fish"] as const) : (["drive-a-wedge", "plant", "fish", "test-a-rumor", "count-votes", "leak"] as const));
      return pick(k, ears, t);
    }
    case "stay-safe": {
      if (v.hoh && v.hoh !== v.owner && !v.nominees.includes(v.owner)) return pick(aff(v.hoh) > 0.5 ? "check-in" : "make-a-promise", [v.hoh]);
      if (v.nominees.includes(v.owner)) {
        const swing = byScore(voters, (p) => aff(p) - thr(p));
        const a0 = aff(swing[0] ?? ""); // ORW-580: warm enough to call in a favor; lukewarm (not yet cold) enough to trade for the vote; cold enough to beg
        return pick(a0 > 0.55 ? "call-in-favor" : a0 >= HOUSE_LIFE.frictionAffinity ? "bargain" : "beg", swing);
      }
      return { kind: "lie-low", with: [], goalId: goal.id, goalKind: goal.kind };
    }
    // ORW-324: winning someone over is mostly time spent with them; an explicit pitch is the occasional step, not every hour.
    case "pull-them-in": return t ? pick(among(["pitch", "check-in", "comfort", "tell-stories", "cook", "game-of-cards"] as const) === "pitch" ? (aff(t) > 0.7 ? "recruit" : "pitch") : among(["pitch", "check-in", "comfort", "tell-stories", "cook", "game-of-cards"] as const), [t]) : undefined;
    case "keep-them-safe": return t ? pick(v.hoh && v.hoh !== v.owner ? "lobby-for" : "count-votes", v.hoh && v.hoh !== v.owner ? [v.hoh] : byScore(voters, aff), t) : undefined;
    case "protect-my-person": return t ? pick(among(["check-in", "comfort", "tell-stories", "cook"] as const), [t]) : undefined;
    case "long-con": return t ? (v.nominees.includes(t) ? pick("flip-a-vote", earsFor(t), t) : pick(among(["check-in", "comfort", "tell-stories", "game-of-cards"] as const), [t], t)) : undefined;
    case "find-out": return pick(t ? "fish" : "test-a-rumor", byScore(pool.filter((p) => p !== t), aff), t);
    case "win-power": return { kind: "study-for-comps", with: [], goalId: goal.id, goalKind: goal.kind };
    case "keep-my-secret": return undefined; // a secret is kept by what they DON'T do: it shapes speech (themes 2 and 4), not an hourly action
    case "last-alliance-standing": return v.mates.length ? pick(among(["split-roles", "check-in", "count-votes", "confirm"] as const), byScore([...v.mates].filter((m) => pool.includes(m)), aff)) : undefined;
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
  const hourKey = `d${v.day}h${v.hour}${v.repeat ? `r${v.repeat}` : ""}`; // ORW-581: the first stretch of an hour keys exactly as before; a repeat gets its own dice
  const roll = (salt: string): number => agendaRoll(seed, v.owner, `hour:${hourKey}:${salt}`);
  const pool = others(v);
  const cul = v.culture;
  const cGossip = cul?.gossip ?? 1, cFlirt = cul?.flirting ?? 1, cLie = cul?.lying ?? 1;
  const cConflict = 1 / (cul?.conflict ?? 1); // a threshold: a lean that says "more conflict" is below 1, so it RAISES the chance
  const avoid = new Set(v.avoid ?? []);
  const here = pool.filter((p) => roomOf(v, p) === v.room && !avoid.has(p));
  const finish = (a: Omit<PlannedAction, "actor" | "manner" | "truthful" | "place"> & { place?: Room }): PlannedAction => {
    const spec = ACTIONS[a.kind];
    const place = a.place ?? (a.with[0] !== undefined ? roomOf(v, a.with[0]) : spec.place ?? v.room);
    const lieBase = a.goalKind === "long-con" || a.kind === "frame" || a.kind === "plant" ? HOUSE_LIFE.schemingLieBoost * cLie : 0;
    const candor = cul ? Math.max(0, Math.min(1, v.candor - (cLie - 1) * CULTURE_CANDOR_SHIFT)) : v.candor; // the culture shifts the speaker's own candor additively; their own term stays
    const truthful = !spec.speech || roll("truth") < Math.max(0, candor - lieBase);
    const fold = foldOf(a.kind, a.with[0], v.mates);
    return { actor: v.owner, ...a, place, manner: mannerOf(v.emotional, a.kind), truthful, ...(fold && fold !== ACTIONS[a.kind].fold ? { fold } : {}) };
  };

  if (v.inCompetition) {
    const target = byScore(here.length ? here : pool, (p) => Math.abs((v.affinity.get(p) ?? 0.4) - 0.5))[0];
    if (!target) return finish({ kind: "sulk", with: [] });
    const fond = (v.affinity.get(target) ?? 0.4) >= 0.5;
    return finish({ kind: v.emotional < 0.35 ? "sulk" : fond ? "cheer" : "taunt", with: v.emotional < 0.35 ? [] : [target], place: v.room });
  }

  // ORW-656: right after the buzzer, the people in the winner's room react to the result (a keyed roll, no shared draw). Out of the winner's room: ordinary hours.
  if (v.afterBuzzer && roll("buzzer") < HOUSE_LIFE.afterBuzzerChance) {
    const w = v.afterBuzzer.winner;
    if (v.owner === w) {
      const mine = byScore(here, (p) => v.affinity.get(p) ?? 0.4)[0];
      if (mine) return finish({ kind: "cheer", with: [mine], place: v.room }); // the winner celebrates with the one they are fondest of
    } else if (here.includes(w)) {
      const fond = (v.affinity.get(w) ?? 0.4) >= 0.5;
      if (v.emotional < 0.35) return finish({ kind: "sulk", with: [] });
      return finish({ kind: fond ? "cheer" : (v.threat.get(w) ?? 0.3) >= 0.5 ? "taunt" : "sulk", with: fond || (v.threat.get(w) ?? 0.3) >= 0.5 ? [w] : [], place: v.room }); // a cold shoulder is a sulk or a barb
    }
  }

  // A goal that never acts in an hour (keep-my-secret: a secret is kept by what they DON'T do) does not compete for the hour, so it must not count toward the goal-hour ceiling either
  // (cubic on #2627: counting it pushed secret holders' `reach` over the ceiling and cost them goal hours their acting goals had earned).
  const goals = [...(v.agenda?.goals ?? [])].filter((g) => g.status === "active" && g.kind !== "keep-my-secret").sort((a, b) => b.commitment - a.commitment || a.id.localeCompare(b.id));
  const lifePull = HOUSE_LIFE.lifePull[v.timeOfDay] + (v.emotional > 0.6 ? HOUSE_LIFE.contentLifeBonus : 0);
  // ORW-350: ordinary life keeps its share however pressing the goals get. Each goal beats ordinary life this hour with chance drive / lifePull (capped at 1), so SOME goal does with 1 minus the product of the misses: it
  // climbs toward 1 as commitments rise and goals pile up (week 2: get-them-out about 0.85 each), and the house stopped living. Above the ceiling, ONE seeded roll sends the hour back to ordinary life, so the hours spent on goals
  // top out at the ceiling; below it (the early game) nothing changes, byte for byte.
  const reach = 1 - goals.reduce((miss, g) => miss * (1 - Math.min(1, (g.commitment * HOUSE_LIFE.goalDrive * (MAIN_AIMS.has(g.kind) ? HOUSE_LIFE.mainAimDrive : 1)) / Math.max(1e-9, lifePull))), 1);
  const lifeHour = reach > HOUSE_LIFE.goalHourCeiling && roll("goalhour") >= HOUSE_LIFE.goalHourCeiling / reach;
  // ORW-350 step 2: WHICH goal gets the hour is a seeded, drive-weighted draw, not "the strongest first": strongest-first handed every goal hour to the single most committed goal (get-them-out, about 0.85 by week 2, which is almost all
  // gossip), so a houseguest's bonds, friends and power-seeking never had an hour. A weighted shuffle (seeded per goal and hour) spreads the goal hours over what they hold, in proportion to how hard each pulls.
  const driveOf = (g: Goal): number => Math.max(1e-6, g.commitment * HOUSE_LIFE.goalDrive * (MAIN_AIMS.has(g.kind) ? HOUSE_LIFE.mainAimDrive : 1));
  const ordered = [...goals].sort((a, b) => Math.pow(roll(`pick:${b.id}`), 1 / driveOf(b)) - Math.pow(roll(`pick:${a.id}`), 1 / driveOf(a)) || a.id.localeCompare(b.id));
  for (const g of lifeHour ? [] : ordered) {
    // A season-long MAIN aim is a background pull; week goals and emergent season goals (revenge, a long con, a secret) are the pressing ones.
    const drive = g.commitment * HOUSE_LIFE.goalDrive * (MAIN_AIMS.has(g.kind) ? HOUSE_LIFE.mainAimDrive : 1);
    if (drive < lifePull * roll(`life:${g.id}`)) continue; // ordinary life wins over THIS goal this hour; a more pressing one may still win
    // ORW-625: a goal with a stored plan takes the plan's next step (and waits for its partner if they are not reachable this hour: no re-roll).
    const planned = v.plans?.get(g.id);
    const step = planned ? planStepNow(planned, g, v) : nextStepFor(g, v, roll(`variant:${g.id}`));
    if (step) return finish(step);
  }

  // 0173: the court. After their own goals, a houseguest seeks out the sitting HOH (the ones in danger far more often); the HOH room is where they go. A keyed roll only (no shared draw).
  if (v.court && v.hoh && v.hoh !== v.owner && pool.includes(v.hoh) && !avoid.has(v.hoh) && roll("court") < v.court.pull) {
    return { ...finish({ kind: v.court.danger ? "beg" : "check-in", with: [v.hoh] }), court: true };
  }

  // 0207 A1 (ORW-658): attraction is real and private. The person they are most drawn to pulls them: a seeded, attraction-scaled chance each free hour to seek that person out (a flirt or a cuddle where one may start,
  // otherwise a check-in). Keyed rolls only (no shared draw); a goal hour above has already had its say, and a seeded showmance below keeps its own rule. Absent `attract` = this block is skipped.
  if (v.attract && !v.showmance) {
    const drawn = [...v.attract.entries()].filter(([p, a]) => a > 0 && pool.includes(p) && !avoid.has(p)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const top = drawn[0];
    // ORW-892: someone they are drawn to is ALREADY in the room, a flirt may start with them and the attraction is real (at least `flirtAtLeast`): the chance of a flirt or a cuddle is the romance chance scaled by the attraction up to `flirtFullAt` (a keyed
    // roll, no shared draw). It used to be reached only through the seek roll below (seekChance x attraction, about 6% at 0.2) AND then a second roll, so outside the seeded showmances no flirt was ever played (0 in an
    // 800-message season); the attraction the house felt never showed. The seek below still sends them toward a person who is not here.
    const here = drawn.find(([p, a]) => v.flirtable?.has(p) === true && a >= ATTRACTION_LIFE.flirtAtLeast && p !== PLAYER && roomOf(v, p) === v.room); // the person they are most drawn to among those in the room
    if (here && roll("attract-flirt") < HOUSE_LIFE.romanceChance * cFlirt * Math.min(1, here[1] / ATTRACTION_LIFE.flirtFullAt)) {
      return { ...finish({ kind: roll("attract-kind") < 0.5 ? "flirt" : "cuddle", with: [here[0]] }), drawn: true };
    }
    if (top && roll("attract-seek") < ATTRACTION_LIFE.seekChance * top[1]) {
      const [who] = top;
      return { ...finish({ kind: "check-in", with: [who] }), drawn: true };
    }
  }

  // House life: a showmance partner nearby, a habit for this time of day, a low mood, or whoever is around.
  if (v.showmance && pool.includes(v.showmance) && roll("romance") < HOUSE_LIFE.romanceChance * cFlirt) return finish({ kind: roll("cuddle") < 0.5 ? "flirt" : "cuddle", with: [v.showmance] });
  // ORW-566 (spec 0183): a close pair keeps a private debrief at their own spot in the hours after a ceremony. Keyed roll only (no shared draw); the partner must ALREADY be at the spot (only the actor moves,
  // review of #2850) or it falls through to ordinary life; the meetings dial scales how often.
  if (v.pairHabits?.length) {
    const mine = v.pairHabits.filter((h) => pool.includes(h.with) && roomOf(v, h.with) === h.room && !avoid.has(h.with)).sort((a, b) => a.key.localeCompare(b.key));
    const h = mine.find((x) => agendaRoll(seed, v.owner, `habit-pair:${x.key}:${hourKey}`) < HOUSE_LIFE.pairHabitPull * (cul?.meetings ?? 1));
    if (h) return finish({ kind: "debrief", with: [h.with], place: h.room, habit: h.key });
  }
  // ORW-337 (spec 0146 lane 2): a house ritual pulls anyone free into its action at its time of day, gathering them where it happens (the same shape as a habit), and the scene carries its name.
  // ORW-507 (#2611): ONE ritual per time of day is chosen first (the seeded-first match, so two rituals sharing a time never double the 0.3 pull), then rolled; a ritual with nobody to share it
  // (its action needs a partner, or it has none to record: a solo ritual leaves no event) falls through to ordinary life instead of silently eating the hour.
  const ritual = v.rituals?.filter((r) => r.timeOfDay === v.timeOfDay).sort((a, b) => roll(`ritualpick:${a.name}`) - roll(`ritualpick:${b.name}`) || a.name.localeCompare(b.name))[0];
  if (ritual && roll(`ritual:${ritual.name}`) < HOUSE_LIFE.ritualPull) {
    const spot = ACTIONS[ritual.action].place;
    const company = (spot ? pool.filter((p) => roomOf(v, p) === spot && !avoid.has(p)) : here).slice(0, ACTIONS[ritual.action].partners.max);
    if (company.length >= Math.max(1, ACTIONS[ritual.action].partners.min)) {
      return finish({ kind: ritual.action, with: company, ritual: ritual.name, ...(spot ? { place: spot } : {}) });
    }
  }
  if (v.routines) {
    // ORW-651 (0209): the routine pull. One keyed roll per routine (no shared draw); weaker when stressed. They go to the routine's place (only the actor moves) and take its act; company is whoever is ALREADY there.
    const r = routineNow(v.routines, v.timeOfDay, isStressed(v.emotional, v.nominees.includes(v.owner)), (k) => roll(`routine:${k}`));
    if (r) {
      const k = r.action as ActionKind;
      const spot = k === "nap" && v.bedroom ? v.bedroom : r.place;
      const there = pool.filter((p) => roomOf(v, p) === spot && !avoid.has(p));
      const regular = byScore(pool.filter((p) => !avoid.has(p)), (p) => v.affinity.get(p) ?? 0.4)[0];
      const company = r.company === "alone" ? [] : r.company === "a-regular" ? (regular !== undefined && there.includes(regular) ? [regular] : there) : there; // a regular is the closest bond if they are there, else whoever is
      // a pastime that needs company and finds none falls through to ordinary life (the same as a ritual with nobody to share it)
      if (company.length >= ACTIONS[k].partners.min) return { ...finish({ kind: k, with: company.slice(0, ACTIONS[k].partners.max), place: spot }), routine: routineKey(r) };
    }
  }
  const habit = v.routines ? undefined : v.habits.find((h) => HABIT_ACTION[h].when.includes(v.timeOfDay) && roll(`habit:${h}`) < HOUSE_LIFE.habitChance);
  if (habit) {
    const k = HABIT_ACTION[habit].action;
    // ORW-466 slice 4: a night owl's bed talk is with their roommates, in their own bedroom; a napper naps in their own bed.
    const ownBed = v.bedroom && (k === "bed-talk" || k === "nap") ? v.bedroom : undefined;
    const spot = ownBed ?? ACTIONS[k].place;
    // (review of #2850) company is whoever is already in that room - only the actor moves, so a roommate elsewhere is never pulled in
    const company = ownBed ? (k === "nap" ? [] : (v.roommates ?? []).filter((p) => pool.includes(p) && roomOf(v, p) === ownBed && !avoid.has(p))) : spot ? pool.filter((p) => roomOf(v, p) === spot && !avoid.has(p)) : here;
    const max = ACTIONS[k].partners.max;
    return finish({ kind: k, with: company.slice(0, max), ...(spot ? { place: spot } : {}) });
  }
  // ORW-620 (night owls, Ryne approved 2026-11-17): in the night hours the few who are still UP gather and talk. Only the awake are in `pool` (a sleeper never schemes, ORW-572), the partner is whoever
  // is up (the player too when they are), and the talk is built from the holder's own state: a pressing goal's step, a clash with someone they rub wrong, a confession when low, otherwise bonding. A keyed roll
  // only (no shared draw); a seeded, bounded pull replaces an ordinary free hour, never a goal hour.
  if (v.nightOwl && (v.timeOfDay === "night" || v.timeOfDay === "late-night") && pool.length > 0 && pool.length <= HOUSE_LIFE.nightOwlMaxOthers
      && roll("owl") < HOUSE_LIFE.nightOwlPull * (v.timeOfDay === "late-night" ? HOUSE_LIFE.nightOwlLateScale : 1)) {
    const company = (p: EntityId): number => pool.filter((q) => q !== p && roomOf(v, q) === roomOf(v, p)).length;
    const candidates = pool.filter((p) => !avoid.has(p) && (p !== PLAYER || v.nightOwl!.playerUp));
    const buddy = byScore(candidates.length ? candidates : [], (p) => (v.affinity.get(p) ?? 0.4) + roll(`owl-who:${p}`) * 0.3 + company(p) * HOUSE_LIFE.nightOwlGatherLean + (roomOf(v, p) === v.room ? 0.1 : 0))[0];
    const withPlayer = (kind: ActionKind, partner: EntityId): PlannedAction => ({ ...finish({ kind, with: [partner] }), nightOwl: true });
    if (buddy) {
      // scheming: a goal they are driven by whose step lands on someone awake (the step only names the awake)
      for (const g of ordered) {
        if (g.commitment * 0.8 <= roll(`owl-goal:${g.id}`)) continue;
        const step = nextStepFor(g, v, roll(`variant:${g.id}`));
        if (step && step.with.length > 0 && (v.nightOwl.playerUp || !step.with.includes(PLAYER))) return { ...finish(step), nightOwl: true };
      }
      const aff = v.affinity.get(buddy) ?? 0.4;
      const sore = Math.max(Math.max(0, HOUSE_LIFE.frictionAffinity - aff) / HOUSE_LIFE.frictionAffinity, v.rivalry?.get(buddy) ?? 0);
      // a fight: dislike, a short temper and a low mood (the same friction shape as ordinary life, but the small hours rub raw)
      if (sore > 0 && roll("owl-fight") < HOUSE_LIFE.frictionChance * cConflict * (0.5 + sore) * (0.5 + temperOf(v.character)) * (1 + Math.max(0, 0.5 - v.emotional) * 2)) return withPlayer("confront", buddy);
      if (v.emotional < HOUSE_LIFE.nightOwlConfessMood) return withPlayer("homesick-talk", buddy);
      // bonding, and the room fills: another awake houseguest already in their room joins (a trio)
      const joiners = pool.filter((q) => q !== buddy && !avoid.has(q) && q !== PLAYER && roomOf(v, q) === roomOf(v, buddy)).slice(0, 1);
      return { ...finish({ kind: roll("owl-bond") < 0.5 ? "bed-talk" : "tell-stories", with: [buddy, ...joiners] }), nightOwl: true };
    }
  }
  if (v.emotional < 0.3) {
    const friend = byScore(here, (p) => v.affinity.get(p) ?? 0)[0];
    return finish(friend && (v.affinity.get(friend) ?? 0) > 0.55 ? { kind: "homesick-talk", with: [friend] } : { kind: roll("vent") < 0.5 ? "vent-in-diary-room" : "mull", with: [] });
  }
  // ORW-466 slice 4 (roommate life): at night the house drifts back to the bedrooms. A free houseguest with an awake roommate often ends the day with them in their own room, their double-bed
  // partner most of all: late-night bed talk, or a squabble when the two rub each other wrong (the same friction rule as anywhere). Who sleeps where was the houseguest's own choice on move-in day.
  if (v.bedroom && (v.timeOfDay === "night" || v.timeOfDay === "late-night")) {
    // review of #2850: only roommates already in the bedroom (only the actor moves this hour; one place at a time)
    const roomies = (v.roommates ?? []).filter((p) => pool.includes(p) && roomOf(v, p) === v.bedroom && !avoid.has(p));
    if (roomies.length > 0 && roll("roommate") < HOUSE_LIFE.roommateNightPull) {
      const mate = v.bedPartner && roomies.includes(v.bedPartner) && roll("bedmate") < HOUSE_LIFE.bedPartnerPull
        ? v.bedPartner
        : byScore(roomies, (p) => (v.affinity.get(p) ?? 0.4) + roll(`roomie:${p}`) * 0.3)[0]!;
      const sore = Math.max(Math.max(0, HOUSE_LIFE.frictionAffinity - (v.affinity.get(mate) ?? 0.4)) / HOUSE_LIFE.frictionAffinity, v.rivalry?.get(mate) ?? 0); // ORW-622: a grudge strand rubs too
      const rub = sore > 0 && roll("roomie-friction") < HOUSE_LIFE.frictionChance * cConflict * (0.5 + sore) * (0.5 + temperOf(v.character)) * (1 + Math.max(0, 0.5 - v.emotional) * 2);
      return finish({ kind: rub ? "chore-fight" : v.timeOfDay === "late-night" || roll("roomie-talk") < 0.7 ? "bed-talk" : "homesick-talk", with: [mate], place: v.bedroom });
    }
  }
  const partner = byScore(here, (p) => (v.affinity.get(p) ?? 0.4) + roll(`who:${p}`) * 0.3 + (v.kindred?.has(p) ? TERRITORY.PARTNER_PULL : 0) + (v.attract ? seekPull(v.attract.get(p) ?? 0) : 0))[0]; // ORW-561: a mild pull toward people who share your top room (no extra draw)
  if (!partner) return finish({ kind: v.timeOfDay === "late-night" || v.timeOfDay === "night" ? "mull" : "nap", with: [], ...(v.bedroom && v.timeOfDay !== "late-night" && v.timeOfDay !== "night" ? { place: v.bedroom } : {}) });
  // ORW-324: friction is not only between enemies. Mild dislike plus a short temper or a bad mood is enough for a chore fight.
  // ORW-622: a grudge strand rubs at dinner even with someone they are warm toward (a pact can still protect them at the vote).
  const dislike = Math.max(Math.max(0, HOUSE_LIFE.frictionAffinity - (v.affinity.get(partner) ?? 0.4)) / HOUSE_LIFE.frictionAffinity, v.rivalry?.get(partner) ?? 0);
  const friction = dislike > 0 && roll("friction") < HOUSE_LIFE.frictionChance * cConflict * (0.5 + dislike) * (0.5 + temperOf(v.character)) * (1 + Math.max(0, 0.5 - v.emotional) * 2);
  // ORW-324: talking about whoever isn't in the room is half of Big Brother downtime (the house's ordinary gossip, not a scheme).
  const absent = [...v.threat.keys()].filter((p) => p !== partner && roomOf(v, p) !== v.room).sort((a, b) => (v.threat.get(b) ?? 0) - (v.threat.get(a) ?? 0) || a.localeCompare(b));
  if (!friction && absent.length > 0 && v.timeOfDay !== "late-night" && roll("gossip") < HOUSE_LIFE.gossipChance * cGossip * (v.timeOfDay === "night" ? 0.6 : 1)) {
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
  leak: "leaked something to", pitch: "pitched an alliance to", recruit: "tried to recruit", "check-in": "checked in with",
  "count-votes": "counted votes with", "split-roles": "split up the plan with", "lobby-for": "lobbied", beg: "begged", bargain: "bargained with",
  "call-in-favor": "called in a favor with", "make-a-promise": "made a promise to", "lie-low": "laid low", "drive-a-wedge": "drove a wedge with",
  frame: "tried to frame someone to", "flip-a-vote": "worked to flip the vote of", "campaign-against": "campaigned to", confront: "confronted",
  gossip: "gossiped with", debrief: "debriefed with", cook: "cooked with", "work-out": "worked out with", "do-chores": "did chores with", nap: "napped", prank: "pranked", comfort: "comforted",
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

/**
 * ORW-579 (Fable T1-12c): what a LISTENER through a wall could take from a hidden scene - a voice, and (for a clash or a plain house-life or romance act, which are heard as themselves)
 * the act - never the engine's own label for why (a pitch, a frame, a betrayal, an alliance). It is the leading words of the engine line cut BEFORE the label, never a fixed share of the
 * line (a share of that line carries the label), so it stays a real fragment of the source (the knowledge service anchors an overhear on content lineage). Ids in, ids out.
 */
export function overheardLine(e: { initiator: EntityId; type: string; content: string; houseLife?: { action: string } }): string {
  const spec = e.houseLife ? ACTIONS[e.houseLife.action as ActionKind] : undefined;
  const act = spec ? (spec.fold === "conflict" || spec.family === "house-life" || spec.family === "romance" ? VERB[e.houseLife!.action as ActionKind] : undefined) : e.type === "conflict" ? "clashed with" : undefined;
  const lead = act ? `${e.initiator} ${act}` : e.initiator;
  return e.content.startsWith(lead) ? lead : e.initiator;
}

/**
 * ORW-621 (0198): what the player SEES of a step taken in their own room - the act and the manner, never why. A goal step (a pitch, a plant, a flip, a plea) shows as
 * the plain act of having a word with someone; a house-life or romance act, and a clash, show as themselves. The subject of a rumor, the goal and the truth of what was
 * said never appear. The words are the existing action vocabulary (`VERB`); `name` turns an id into the name the player knows.
 */
export function roomActLine(p: Pick<PlannedAction, "actor" | "kind" | "with" | "manner">, name: (id: EntityId) => string): string {
  const spec = ACTIONS[p.kind];
  const shown: ActionKind = spec.fold === "conflict" || spec.family === "house-life" || spec.family === "romance" ? p.kind : "check-in";
  const who = p.with.length ? ` ${p.with.map(name).join(", ")}` : "";
  return `${name(p.actor)} ${VERB[shown]}${who} (${p.manner})`;
}
