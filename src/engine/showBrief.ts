/**
 * The SHOW BRIEF, v1 skeleton (Showrunner memory Part A; design K6 §3). One engine-built block the front end
 * appends as a TERMINAL system message, after the transcript, so the cached prompt prefix is untouched. It tells
 * the narrator, in a fixed order, what is true right now from the player's point of view:
 *
 *   header   the precedence rule (the brief wins over the chat)
 *   1. NOW   where the player is, who is HERE, who is in view, explicit absences (NOT HERE), who is out of view
 *   2. CHANGED SINCE YOUR LAST TURN   moves the player could see since the previous brief, and the clock
 *   3. WHAT YOU ESTABLISHED   what is built into this room (the house map, v0 pending C1), and how the last
 *            scene ended (the last lines the player saw)
 *
 * Only the sections that need no Ryne content are here: no producer's note, no rules wording, no story-so-far,
 * no threads, no callbacks, no speaker cards (those follow later). Pure and deterministic: the same view and
 * request give the same bytes. Vault-free by construction: it reads ONLY the player-visible `GameStateView`
 * (whereabouts is eyeshot-scoped; a closed door stays opaque) plus the FE's echoes, which are re-validated and
 * used only to say what changed and whom to state absent; every name printed comes from the engine's roster.
 */
import type { EntityId } from "../domain/ids";
import { HOUSE_ROOMS, type Room } from "../domain/house";
import { fixturesForBrief, roomPhrase } from "../domain/houseFixtures";
import type { BriefSeenState, GameStateView, ShowBriefReq, ShowBriefView } from "../ports/GameSession";
import { neutralizeForPrompt } from "./castingIntake";

/** The quoted tail of the last scene is capped (about 40 words). */
export const BRIEF_LAST_SHOWN_MAX_CHARS = 320;
/** At most this many asked-about houseguests get an explicit absence line. */
export const BRIEF_ABSENCES_MAX = 6;
/** A change line names at most this many people, then "and N more". */
export const BRIEF_NAMES_PER_LINE = 8;

/** The OPEN THREADS section holds at most this many lines. */
export const BRIEF_THREADS_MAX = 6;

/**
 * ORW-223 slice 2: the "5. OPEN THREADS" section from pre-built, Vault-free "kind: status" lines (the adapter builds
 * them from state the player already knows). Capped, de-duplicated, deterministic; undefined when empty so a quiet
 * game's brief is byte-identical to before.
 */
export function openThreadsSection(lines: readonly string[] | undefined): string | undefined {
  const clean = [...new Set((lines ?? []).map((l) => neutralizeForPrompt(l, 120)).filter((l) => l.length > 0))].slice(0, BRIEF_THREADS_MAX);
  if (!clean.length) return undefined;
  return ["5. OPEN THREADS (kind and status only; nothing here is a fact beyond that)", ...clean.map((l) => `- ${l}`)].join("\n");
}

/** K6 §3.3 rule 9: the token estimate is chars / 4.1. */
export function estimateBriefTokens(text: string): number {
  return Math.ceil(text.length / 4.1);
}

const EVENT_LABEL: Readonly<Record<string, string>> = {
  "hoh-competition": "the HOH competition",
  "veto-draw": "the veto player draw",
  "veto-competition": "the veto competition",
  "nominations": "the nomination ceremony",
  "veto-ceremony": "the veto ceremony",
  "eviction": "the eviction",
  "champagne-circle": "the champagne toast",
  "premiere-entrances": "the premiere entrances",
};

const isRoom = (r: unknown): r is Room => typeof r === "string" && (HOUSE_ROOMS as readonly string[]).includes(r);
const roomOrder = (r: string): number => (HOUSE_ROOMS as readonly string[]).indexOf(r);
/** Stable person order: npc:N by number, anything else after, by string. */
const idOrder = (a: EntityId, b: EntityId): number => {
  const na = /^npc:(\d+)$/.exec(a)?.[1];
  const nb = /^npc:(\d+)$/.exec(b)?.[1];
  if (na !== undefined && nb !== undefined) return Number(na) - Number(nb);
  if (na !== undefined) return -1;
  if (nb !== undefined) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};
const room = (r: string): string => roomPhrase(r as Room);
const tenure = (n: number): string => (n <= 0 ? "just arrived" : n === 1 ? "1 turn" : `${n} turns`);
const ago = (n: number): string => (n <= 0 ? "just now" : n === 1 ? "1 turn ago" : `${n} turns ago`);

/** "A, B and C". Change lines cap at `BRIEF_NAMES_PER_LINE` ("..., and 3 more"); standing lines (`cap: false`) never do. */
function nameList(names: readonly string[], cap = true): string {
  const shown = cap ? names.slice(0, BRIEF_NAMES_PER_LINE) : [...names];
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** A change line's items, capped like `nameList`: "a, b, ... and 3 more". */
function capped(items: readonly string[]): string {
  const rest = items.length - BRIEF_NAMES_PER_LINE;
  return rest > 0 ? `${items.slice(0, BRIEF_NAMES_PER_LINE).join(", ")} and ${rest} more` : items.join(", ");
}

/** Validate an FE echo of a previous brief's `seen` state. Anything malformed is treated as absent. */
export function parseSeenState(raw: unknown, known: ReadonlySet<EntityId>): BriefSeenState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  if (s.v !== 1 || typeof s.beatSeq !== "number" || !isRoom(s.room)) return undefined;
  const ids = (x: unknown): EntityId[] | undefined =>
    Array.isArray(x) && x.every((i) => typeof i === "string" && known.has(i)) ? [...new Set(x as EntityId[])].sort(idOrder) : undefined;
  const here = ids(s.here);
  if (!here || !Array.isArray(s.inView)) return undefined;
  const inView: BriefSeenState["inView"] = [];
  for (const v of s.inView) {
    if (!v || typeof v !== "object" || !isRoom((v as { room?: unknown }).room)) return undefined;
    const vIds = ids((v as { ids?: unknown }).ids);
    if (!vIds) return undefined;
    inView.push({ room: (v as { room: Room }).room, ids: vIds });
  }
  const clock = typeof s.clock === "string" && s.clock.length <= 40 ? s.clock : undefined;
  return { v: 1, beatSeq: s.beatSeq, ...(clock ? { clock } : {}), room: s.room, here, inView };
}

/** The last lines the player saw, made prompt-safe: asides removed, one line, capped. Undefined when empty. */
export function cleanLastShown(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const noAsides = raw.replace(/\(\([\s\S]*?\)\)/g, " ");
  const flat = neutralizeForPrompt(noAsides, BRIEF_LAST_SHOWN_MAX_CHARS);
  return flat.length ? flat : undefined;
}

/**
 * Build the brief for this turn, or `undefined` when there is nothing to brief (pre-game, the player out of the
 * house, no whereabouts). `req` carries only the FE's optional echoes; the facts come from `view`.
 */
export function buildShowBrief(view: GameStateView, req: ShowBriefReq = {}, canonSection?: (room: Room) => string | undefined, threadLines?: readonly string[]): ShowBriefView | undefined {
  if (!view.started || !view.player) return undefined;
  const wa = view.whereabouts;
  if (!wa || !isRoom(wa.room)) return undefined;
  const me = view.player.id;

  // ── what the player can see now (the engine's own Vault-free projection) ──
  const nameOf = new Map<EntityId, string>();
  for (const h of view.house) nameOf.set(h.id, neutralizeForPrompt(h.name, 60));
  const statusOf = new Map(view.house.map((h) => [h.id, h.status] as const));
  const name = (id: EntityId): string => nameOf.get(id) ?? "someone";
  const tenureOf = new Map(wa.companions.map((c) => [c.id, c.turnsHere] as const));
  const hereIds = [...new Set(wa.present.map((p) => p.id))].filter((id) => id !== me && nameOf.has(id)).sort(idOrder);
  const hereSet = new Set(hereIds);
  const inView = wa.nearby
    .filter((n) => isRoom(n.room))
    .map((n) => ({ room: n.room as Room, ids: [...new Set(n.present.map((p) => p.id))].filter((id) => nameOf.has(id) && !hereSet.has(id)).sort(idOrder) }))
    .sort((a, b) => roomOrder(a.room) - roomOrder(b.room));
  const visible = new Map<EntityId, string>();
  for (const id of hereIds) visible.set(id, wa.room);
  for (const v of inView) for (const id of v.ids) if (!visible.has(id)) visible.set(id, v.room);
  const asleep = [...new Set((view.asleep ?? []).map((a) => a.id))].filter((id) => nameOf.has(id) && !visible.has(id)).sort(idOrder);
  const asleepSet = new Set(asleep);
  const trackedOf = new Map(wa.tracked.filter((t) => isRoom(t.room)).map((t) => [t.id, t] as const));
  const active = view.house.filter((h) => h.status === "active" && h.id !== me).map((h) => h.id);

  const known = new Set(nameOf.keys());
  const seen = parseSeenState(req.seen, known);
  const lastShown = cleanLastShown(req.lastShown);

  // ── 1. NOW ──
  const now: string[] = ["1. NOW"];
  if (typeof view.clockLabel === "string" && view.clockLabel) now.push(`It is ${neutralizeForPrompt(view.clockLabel, 40)}.`);
  now.push(`You are in ${room(wa.room)} (${tenure(wa.turnsHere)}${wa.turnsHere > 0 ? " here" : ""}).`);
  const ev = wa.houseEvent ? EVENT_LABEL[wa.houseEvent.kind] : undefined;
  if (ev) now.push(`The house is gathered here for ${ev}.`);
  // During a whole-house event everyone is gathered and the engine reports no tenure, so none is printed.
  now.push(hereIds.length
    ? `HERE with you: ${hereIds.map((id) => (wa.houseEvent ? name(id) : `${name(id)} (${tenure(tenureOf.get(id) ?? 0)})`)).join(", ")}.`
    : "Nobody else is here.");
  if (inView.length) {
    now.push(`In view: ${inView.map((v) => `${room(v.room)}: ${v.ids.length ? nameList(v.ids.map(name), false) : "nobody"}`).join("; ")}.`);
  } else if (!wa.houseEvent) {
    now.push("You cannot see into any other room from here.");
  }

  // Explicit absences (K6 §3.3 rule 7): the people the player could plausibly ask about. The FE names the ones
  // in the player's message and the last scene; the engine adds whoever was with the player at the last brief.
  const departed = seen ? seen.here.filter((id) => !hereSet.has(id) && id !== me) : [];
  const asked = Array.isArray(req.askedAbout) ? req.askedAbout.filter((id): id is EntityId => typeof id === "string" && known.has(id) && id !== me) : [];
  const absent = [...new Set([...departed, ...asked])].filter((id) => !hereSet.has(id)).sort(idOrder).slice(0, BRIEF_ABSENCES_MAX);
  const absentSet = new Set(absent);
  const absenceLine = (id: EntityId): string => {
    const st = statusOf.get(id);
    if (st === "jury" || st === "evicted") return `${name(id)} is no longer in the house.`;
    if (asleepSet.has(id)) return `${name(id)} is NOT here; ${name(id)} has turned in for the night.`;
    const at = visible.get(id);
    if (at) return `${name(id)} is NOT here; ${name(id)} is in ${room(at)}.`;
    const t = trackedOf.get(id);
    if (t) return `${name(id)} is NOT here; you last saw ${name(id)} head into ${room(t.room)} ${ago(t.sinceTurns)}${t.stale ? " (that sighting is stale)" : ""}.`;
    return `${name(id)} is NOT here, and you cannot see where ${name(id)} is.`;
  };
  if (absent.length) now.push(`NOT HERE: ${absent.map(absenceLine).join(" ")}`);
  if (asleep.length) now.push(`Turned in for the night: ${nameList(asleep.map(name), false)}.`);
  const unseen = active.filter((id) => !visible.has(id) && !asleepSet.has(id) && !absentSet.has(id)).sort(idOrder);
  if (unseen.length) {
    now.push(wa.houseEvent?.kind === "premiere-entrances"
      ? `Not in the house yet: ${nameList(unseen.map(name), false)}.`
      : `Not in view (you cannot see where they are): ${nameList(unseen.map(name), false)}.`);
  }

  // ── 2. CHANGED SINCE YOUR LAST TURN (since the previous brief this conversation served) ──
  const changed: string[] = ["2. CHANGED SINCE YOUR LAST TURN"];
  if (!seen) {
    changed.push("Unknown: this is the first brief of this conversation. Trust section 1.");
  } else {
    const before = new Map<EntityId, string>();
    for (const id of seen.here) before.set(id, seen.room);
    for (const v of seen.inView) for (const id of v.ids) if (!before.has(id)) before.set(id, v.room);
    const byPlace = (ids: EntityId[], where: (id: EntityId) => string) =>
      ids.sort((a, b) => roomOrder(where(a)) - roomOrder(where(b)) || idOrder(a, b));
    if (seen.room !== wa.room) changed.push(`- You moved from ${room(seen.room)} to ${room(wa.room)}.`);
    const arrived = hereIds.filter((id) => !seen.here.includes(id));
    if (arrived.length) changed.push(`- Now here with you: ${nameList(arrived.map(name))}.`);
    const left = byPlace(seen.here.filter((id) => !hereSet.has(id) && known.has(id)), (id) => visible.get(id) ?? "~");
    if (left.length) {
      changed.push(`- No longer with you: ${capped(left.map((id) => {
        const at = visible.get(id);
        return `${name(id)} (${at ? `now in ${room(at)}` : statusOf.get(id) !== "active" ? "no longer in the house" : asleepSet.has(id) ? "turned in" : "out of view"})`;
      }))}.`);
    }
    const movedInView = byPlace([...visible.keys()].filter((id) => !hereSet.has(id) && before.has(id) && !seen.here.includes(id) && before.get(id) !== visible.get(id)), (id) => visible.get(id)!);
    if (movedInView.length) changed.push(`- Moved within view: ${capped(movedInView.map((id) => `${name(id)} from ${room(before.get(id)!)} to ${room(visible.get(id)!)}`))}.`);
    const newlyInView = byPlace([...visible.keys()].filter((id) => !hereSet.has(id) && !before.has(id)), (id) => visible.get(id)!);
    if (newlyInView.length) changed.push(`- Now in view: ${capped(newlyInView.map((id) => `${name(id)} (in ${room(visible.get(id)!)})`))}.`);
    const goneFromView = byPlace([...before.keys()].filter((id) => !visible.has(id) && !seen.here.includes(id) && known.has(id)), (id) => before.get(id)!);
    if (goneFromView.length) changed.push(`- Out of view now: ${capped(goneFromView.map((id) => `${name(id)} (was in ${room(before.get(id)!)})`))}.`);
    if (seen.clock && view.clockLabel && seen.clock !== view.clockLabel) {
      changed.push(`- Clock: ${neutralizeForPrompt(seen.clock, 40)} -> ${neutralizeForPrompt(view.clockLabel, 40)}.`);
    }
    if (changed.length === 1) changed.push("Nothing you could see has changed.");
  }

  // ── 3. WHAT YOU ESTABLISHED ──
  const established: string[] = ["3. WHAT YOU ESTABLISHED"];
  const fixtures = fixturesForBrief(wa.room);
  if (fixtures) established.push(fixtures);
  established.push(lastShown
    ? `HOW THE LAST SCENE ENDED (the last lines the player saw, quoted from the chat; sections 1 and 2 win if they disagree):\n> ${lastShown}`
    : "HOW THE LAST SCENE ENDED: not available (a fresh conversation).");

  const header = [
    "SHOW BRIEF. Built by the engine for this turn from what the player can see; it is the truth about the show right now.",
    "If it disagrees with the chat above, THE BRIEF WINS. The headings below always come in this order.",
  ].join("\n");
  const sections: Array<{ id: "header" | "now" | "changed" | "established" | "canon" | "threads"; text: string }> = [
    { id: "header" as const, text: header },
    { id: "now" as const, text: now.join("\n") },
    { id: "changed" as const, text: changed.join("\n") },
    { id: "established" as const, text: established.join("\n") },
  ];
  // 4. CANON (ORW-223): what the narration already established about THIS room, only when something is recorded.
  const canon = canonSection?.(wa.room);
  if (canon) sections.push({ id: "canon" as const, text: canon });
  // 5. OPEN THREADS (ORW-223 slice 2): kind and status only, only when something is in motion.
  const threads = openThreadsSection(threadLines);
  if (threads) sections.push({ id: "threads" as const, text: threads });
  const text = sections.map((s) => s.text).join("\n\n");
  const nextSeen: BriefSeenState = {
    v: 1,
    beatSeq: view.beatSeq,
    ...(typeof view.clockLabel === "string" && view.clockLabel ? { clock: view.clockLabel } : {}),
    room: wa.room,
    here: hereIds,
    inView: inView.map((v) => ({ room: v.room, ids: v.ids })),
  };
  return {
    text,
    seen: nextSeen,
    beatSeq: view.beatSeq,
    tokens: estimateBriefTokens(text),
    sections: sections.map((s) => ({ id: s.id, tokens: estimateBriefTokens(s.text) })),
  };
}
