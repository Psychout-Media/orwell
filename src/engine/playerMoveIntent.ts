/**
 * ORW-419 - intent-first moves: resolve the PLAYER'S OWN move from the player's OWN words, in the engine,
 * BEFORE the narrator runs (Ryne: "the engine should move before the narrator").
 *
 * Pure, deterministic and Vault-free: it reads ONLY the player's message text (never the narration) and
 * the engine's own room data (`resolveRoom`, `HOUSE_ADJACENCY` in `src/domain/house.ts`). Unsure parses
 * return `null` - the FE keeps its post-reply move belt as the fallback, and the player's stated move
 * always wins over it.
 *
 * What counts as a move: a PRESENT-TENSE self-move ("I go to the kitchen", "head to the backyard", "walk
 * into the hallway", "take me to bedroom A", "I want to leave the backyard", "I go inside/outside"). What
 * does not: future / conditional / negated / hedged phrasing ("I'll go to the kitchen later", "maybe I
 * should go...", "don't go", questions) and anything inside quoted speech.
 */
import { HOUSE_ADJACENCY, areAdjacent, resolveRoom, type Room } from "../domain/house";

/**
 * The door map for "leave X" / "go inside" with no destination: the room the player steps into when they
 * walk OUT of `room`, taken from the floor plan (every entry is asserted adjacent by the unit tests).
 * The backyard opens onto the kitchen and the dining room (it is off to the side, not off the living room); the front door is in the living room;
 * the HOH room opens onto the landing, and the landing onto the living room (ORW-711).
 */
const EXIT_ROOM: ReadonlyMap<Room, Room> = new Map<Room, Room>([
  ["backyard", "kitchen"],
  ["kitchen", "living-room"],
  ["dining-room", "living-room"],
  ["living-room", "kitchen"],
  ["hallway", "living-room"],
  ["bedroom-a", "hallway"],
  ["bedroom-b", "hallway"],
  ["bedroom-c", "hallway"],
  ["bathroom", "living-room"],
  ["lounge", "living-room"],
  ["landing", "living-room"],
  ["hoh-room", "landing"],
  ["storage-room", "kitchen"],
  ["diary-room", "living-room"],
]);

/** The room you step into when you leave `room` (a floor-plan neighbour), or null for an unknown room. */
export function exitRoomFrom(room: Room | null | undefined): Room | null {
  if (!room) return null;
  const to = EXIT_ROOM.get(room);
  return to && areAdjacent(room, to) && (HOUSE_ADJACENCY.get(room) ?? []).includes(to) ? to : null;
}

// Hedged / future / conditional / negated / question markers - any one in a clause means "not a move now".
const NOT_A_MOVE =
  /\b(?:will|i'?ll|ill|later|maybe|perhaps|might|may|could|would|should|shall|if|when|once|after|before|until|unless|tomorrow|tonight|eventually|someday|soon|don'?t|do not|not|never|won'?t|can'?t|cannot|wouldn'?t|shouldn'?t|gonna|plan|planning|thinking|think|wonder|supposed|rather|instead|about to|going to go|how about|what about|why don'?t)\b/;
const QUESTION_START = /^(?:can|could|would|should|shall|may|do|does|did|is|are|am|will|what|where|why|how|who|which)\b/;

const LEAD_IN = /^(?:(?:ok|okay|alright|all right|so|then|and|now|well|first|next|hey|um|uh|anyway|ok then)\b[,\s]*)+/;
const SUBJECT = /^(?:i(?:'?m| am)?\s+|me\s+)/; // "im" typed without the apostrophe too
const INTENT = /^(?:(?:just|now|quickly|slowly|quietly|also|really|finally|then)\s+)*(?:(?:want to|wanna|need to|decide to|choose to|am)\s+)?(?:(?:just|now|quickly|slowly|quietly|then)\s+)*/;
const GO_VERB = /^(?:go|goes|head|heads|walk|walks|step|steps|move|moves|wander|wanders|stroll|strolls|run|runs|slip|slips|duck|ducks|retreat|retreats|going|heading|walking|stepping|moving|wandering|strolling|running|make my way|making my way)\b\s*/;
const TAKE_VERB = /^(?:take|bring|lead|walk|carry|guide)\s+me\b\s*/;
const LEAVE_VERB = /^(?:leave|leaves|leaving|exit|exits|exiting|get out of|getting out of|walk out of|walking out of|step out of|stepping out of|head out of|heading out of|go out of|going out of|go out from|walk out from)\b\s*/;
// Prepositions (and a few adverbs) between the verb and the destination.
const PREP = /^(?:(?:back|right|straight|over|down|up|out|on)\s+)*(?:(?:in\s*to|into|to|toward|towards|through|in|inside)\b\s*)?(?:(?:back|right|straight|over|down|up)\s+)*(?:(?:to|into)\s+)?/;
const ARTICLE = /^(?:the|my|our|your|this|that|a|an)\s+/;
// The destination phrase ends at the first of these joiners ("to the kitchen and say hi", "... to talk to X").
const PHRASE_END = /\s+(?:and|to|so|with|then|because|but|for|while|where|now|please|again|real quick|quickly|slowly|quietly|carefully|silently|alone|together|too|also|first|next|just)\b.*$/;

const INSIDE_WORDS = new Set(["inside", "in", "indoors", "back inside", "back in", "into the house", "inside the house", "in the house"]);
const OUTSIDE_WORDS = new Set(["outside", "out", "outdoors", "out back", "outside the house", "out of the house"]);

/** ORW-858 (716a): the part of a cleaned clause that STATES the move, up to the first joiner ("and", "then", "so", "but", a comma). A hedge, a negation or an "if" in what the player says
 *  AFTER the move ("I head to the bathroom and ask him if we can talk") is not a hedge about the move, so only the head is checked against NOT_A_MOVE. A hedge in the head ("maybe I go ...",
 *  "I wonder if I should go ...") still means no move. */
function moveHead(s: string): string {
  return s.split(/\s+(?:and|then|so|but)\s+|,\s*/)[0] ?? s;
}

// Live (Ryne: "I don't want to talk about going somewhere 3 messages in a row"): a clear wish to go now is a move. A leading future or lead-in form of a go-verb is read as the present ("I'm going to head to...",
// "I'll leave", "I get up and go...", "let me go...", "time to go..."). Only go/leave verbs: "I will take her to..." stays a plan, and a later-time word ("later", "tomorrow", "when...") still blocks below.
const NOW_FORMS = /^(?:(?:i(?:'m| am)?\s+)?(?:gonna|going to)|i'?ll|i will|(?:i\s+)?(?:get up|stand up|excuse myself) and|let me|(?:it'?s\s+)?time to)\s+(?=(?:just\s+|now\s+)?(?:go|head|walk|leave|move|step|wander|find|follow|make my way)\b)/;
const asNow = (s: string): string => s.replace(NOW_FORMS, "i ");

function clean(clause: string): string {
  let s = clause.replace(/[\u2018\u2019\u02BC]/g, "'").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[*_`~]+/g, " ").replace(/[^a-z0-9' -]+/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/\b(?:i'?d|i would) like to\b/g, "i want to").replace(/\bwould like to\b/g, "want to");
  s = s.replace(LEAD_IN, "").trim();
  return asNow(s);
}

/** A destination phrase -> a canonical room, or null when unsure/ambiguous. Strict about loose matches. */
type Themed = ReadonlyArray<readonly [alias: string, room: Room]> | undefined;

function roomFromPhrase(phrase: string, current: Room | null, themed?: Themed): Room | null {
  let p = phrase.trim();
  if (p === "") return null;
  p = p.replace(PHRASE_END, "").trim().replace(ARTICLE, "").trim();
  if (p === "" || /^(?:bed|beds|room|sleep)$/.test(p)) return null; // "go to bed" is sleep; a bare "room" is no place
  const res = resolveRoom(p, current, themed); // ORW-466: the season's themed room names resolve too
  if (res.kind !== "ok") return null;
  // resolveRoom is deliberately loose ("kit" -> kitchen); for a stated move require a real word, not a stub.
  if (p.replace(/[\s-]/g, "").length < 3) return null;
  return res.room;
}

// ORW-858 (716a remainder): the player's own move to a named room stated WITH a person: "I go find <X> in the backyard", "I take <X> to the bathroom", "I walk with <X> to the lounge", "let's go to the kitchen".
// The player's own present-tense act; the move is to the ROOM named. Whether the other person agrees to a private word stays with the talk-alone lever (askToTalkAlone), which this never calls or replaces.
const LETS = /^(?:let'?s|lets|let us)\s+(?:(?:just|now|quickly|all|go ahead and)\s+)*/;
const TAKE_PERSON = /^(?:take|bring|lead|walk|guide|escort)\s+([a-z][a-z' -]{0,28}?)\s+(?:back\s+|over\s+)?(?:in\s*to|into|to|toward|towards)\s+(.+)$/;
const WITH_PERSON = /^with\s+([a-z][a-z' -]{0,28}?)\s+(?:back\s+|over\s+)?(?:in\s*to|into|to|toward|towards)\s+(.+)$/;
const FIND_IN_ROOM = /^(?:(?:and\s+)?(?:find|look for|see|get)|to|over to)\s+([a-z][a-z' -]{0,28}?)\s+(?:in|inside|at)\s+(.+)$/;

/** A person phrase the move grammar accepts beside a room: 1-3 plain words, and not itself a room word. */
function personPhrase(p: string, current: Room | null, themed?: Themed, loose = false): boolean {
  const t = p.trim();
  return /^[a-z][a-z' -]*$/.test(t) && t.split(" ").length <= 3 && (loose || roomFromPhrase(t, current, themed) === null);
}

/** ORW-1008: a comma ends the move ("I want to go to the deep bedroom, come with me"): the part before the first comma is tried first, and only when it states no move is the whole clause read (commas dropped, as before). */
function parseClause(raw: string, current: Room | null, themed?: Themed): Room | null {
  const at = raw.indexOf(",");
  if (at > 0) { const head = parseClauseText(raw.slice(0, at), current, themed); if (head !== null) return head; }
  return parseClauseText(raw, current, themed);
}

function parseClauseText(raw: string, current: Room | null, themed?: Themed): Room | null {
  if (/\?\s*$/.test(raw.trim())) return null;
  let s = clean(raw);
  if (s === "" || QUESTION_START.test(s) || NOT_A_MOVE.test(moveHead(s))) return null;
  const lets = LETS.exec(s);
  if (lets) { // an invitation to go together: the player's own walk is the move ("let's go to the kitchen"); only a go-verb counts
    s = s.slice(lets[0].length);
    if (!GO_VERB.test(s)) return null;
  } else {
    s = s.replace(SUBJECT, "");
    s = s.replace(INTENT, "");
  }

  // 0. the player walks WITH someone: "take her to the bathroom", "walk with her to the lounge" - the player's move to the room named.
  const gv = GO_VERB.exec(s);
  const tp = TAKE_PERSON.exec(s) ?? (gv ? WITH_PERSON.exec(s.slice(gv[0].length)) : null);
  if (tp && tp[1] !== "me" && personPhrase(tp[1]!, current, themed)) {
    const to = roomFromPhrase(tp[2]!, current, themed);
    if (to !== null) return to;
  }

  // 1. "leave the backyard" / "leave" + here: through the door the floor plan gives.
  let m = LEAVE_VERB.exec(s);
  if (m) {
    const rest = s.slice(m[0].length).replace(PHRASE_END, "").trim().replace(ARTICLE, "").trim();
    if (rest === "" || /^(?:here|room|the room|this room)$/.test(rest)) return exitRoomFrom(current);
    const named = roomFromPhrase(rest, current, themed);
    // Only "leave the room you are in" is a clear exit; leaving a room you are not in is unsure.
    return named !== null && named === current ? exitRoomFrom(current) : null;
  }

  // 2. "take me to the kitchen".
  m = TAKE_VERB.exec(s);
  if (m) {
    const rest = s.slice(m[0].length).replace(PREP, "");
    return roomFromPhrase(rest, current, themed);
  }

  // 3. "go / head / walk ... [to] X", "go inside / outside".
  m = GO_VERB.exec(s);
  if (m) {
    const afterVerb = s.slice(m[0].length);
    const bare = afterVerb.replace(PHRASE_END, "").trim();
    // ORW-926: "go back inside TO THE LIVING ROOM", "go out TO THE HALLWAY": the player NAMED where they are going, so that room is the move; the bare in/out shortcut below is only for "go inside" / "go outside" with no destination.
    if (INSIDE_WORDS.has(bare) || OUTSIDE_WORDS.has(bare)) {
      const named = roomFromPhrase(afterVerb.replace(PREP, ""), current, themed);
      if (named !== null) return named;
    }
    if (INSIDE_WORDS.has(bare)) return current === "backyard" ? exitRoomFrom(current) : null;
    if (OUTSIDE_WORDS.has(bare)) return current === "backyard" ? null : "backyard";
    const fr = FIND_IN_ROOM.exec(afterVerb.replace(/^(?:(?:back|right|straight|over)\s+)+/, ""));
    if (fr && personPhrase(fr[1]!, current, themed, /^(?:and\s+)?(?:find|look for|see|get)\b/.test(afterVerb.replace(/^(?:(?:back|right|straight|over)\s+)+/, "")))) { const to = roomFromPhrase(fr[2]!, current, themed); if (to !== null) return to; } // "go find <X> in the backyard": the room named
    const rest = afterVerb.replace(PREP, "");
    return roomFromPhrase(rest, current, themed);
  }
  return null;
}

/** ORW-1008: "my bed" / "my room" is the player's own bed's room only as the DESTINATION of a go-verb ("go back to my bed"). A bare mention ("my bed is in the Palmetto room", "I'm in my room") is affiliation and never a move. */
const OWN_BED_DEST = /^(?:my|our) (?:own )?(?:bed|room|bedroom)$/;
function ownBedClause(raw: string): boolean {
  if (/\?\s*$/.test(raw.trim())) return false;
  let s = clean(raw);
  if (s === "" || QUESTION_START.test(s) || NOT_A_MOVE.test(moveHead(s))) return false;
  const lets = LETS.exec(s);
  if (lets) { s = s.slice(lets[0].length); if (!GO_VERB.test(s)) return false; }
  else s = s.replace(SUBJECT, "").replace(INTENT, "");
  const m = GO_VERB.exec(s) ?? TAKE_VERB.exec(s);
  if (!m) return false;
  const rest = s.slice(m[0].length).replace(PREP, "").replace(PHRASE_END, "").trim();
  return OWN_BED_DEST.test(rest);
}

/** ORW-1008: does the player's message go (now, in their own words, outside quotes) to their own bed or room? The engine then moves them to the bedroom they own a bed in. */
export function parsePlayerOwnBedMove(text: string): boolean {
  if (typeof text !== "string" || text.trim() === "") return false;
  const unquoted = text.replace(/"[^"]*"/g, " ").replace(/\u201c[^\u201d]*\u201d/g, " ");
  const clauses = unquoted.match(/[^.!?;\n]+[.!?;\n]*/g) ?? [];
  return clauses.some((c) => c.trim() !== "" && ownBedClause(c));
}

/**
 * Read a player's message for a present-tense move of their OWN. Returns the destination room, or null
 * when there is no clear move (unsure parses never guess). When several clauses move, the LAST one wins
 * (it is where the player ends up). Quoted speech is ignored.
 */
export function parsePlayerMoveIntent(text: string, current: Room | null, themed?: Themed): Room | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  const unquoted = text.replace(/"[^"]*"/g, " ").replace(/“[^”]*”/g, " ");
  const clauses = unquoted.match(/[^.!?;\n]+[.!?;\n]*/g) ?? [];
  let dest: Room | null = null;
  let at = current;
  for (const c of clauses) {
    if (c.trim() === "") continue;
    const room = parseClause(c, at, themed);
    if (room !== null) { dest = room; at = room; }
  }
  return dest;
}

// ORW-559 - "go to <houseguest>": the same present-tense self-move grammar, but the destination phrase is a PERSON. The parser only
// extracts the phrase; the engine resolves it against who the player can legitimately see (never a hidden whereabouts).
const FIND_VERB = /^(?:find|finds|finding|look for|looks for|looking for|seek out|seeking out|search for|searching for|track down|tracking down|locate|go find|go look for|go see|go and find)\b\s*/;

const FOLLOW_VERB = /^(?:follow|follows|following|trail|trails|trailing)\b\s*/;
const FOLLOW_TAIL = /\s+(?:inside|outside|indoors|back|in|out|into|to|and|then|wherever|where|so|with|through)\b.*$/;

function personFromClause(raw: string, current: Room | null, themed?: Themed): string | null {
  if (/\?\s*$/.test(raw.trim())) return null;
  let s = clean(raw);
  if (s === "" || QUESTION_START.test(s) || NOT_A_MOVE.test(moveHead(s))) return null;
  s = s.replace(SUBJECT, "").replace(INTENT, "");
  let rest: string | null = null;
  const f = FIND_VERB.exec(s);
  const fo = FOLLOW_VERB.exec(s); // ORW-926: "I follow <X> inside to wherever they went": walking after a person is a move to where that person is (when the player can see them)
  if (f) rest = s.slice(f[0].length);
  else if (fo) rest = s.slice(fo[0].length).replace(FOLLOW_TAIL, "");
  else {
    const g = GO_VERB.exec(s);
    if (g) {
      const after = s.slice(g[0].length);
      rest = after.replace(/^(?:(?:back|right|straight|over|down|up|off)\s+)*(?:(?:in\s*to|into|to|toward|towards)\b\s*)?(?:(?:over)\s+)?(?:(?:to|and find|and look for|and see)\s+)?/, "");
    }
  }
  if (rest === null) return null;
  const p = rest.replace(PHRASE_END, "").trim();
  if (p === "" || !/^[a-z][a-z' -]*$/.test(p) || p.split(" ").length > 3) return null;
  if (roomFromPhrase(p, current, themed) !== null) return null; // a room word is a room, not a person
  return p;
}

/** The houseguest name phrase the player says they are going to / looking for, or null. LAST clause wins; quoted speech is ignored. */
export function parsePlayerPersonIntent(text: string, current: Room | null, themed?: Themed): string | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  const unquoted = text.replace(/"[^"]*"/g, " ").replace(/\u201c[^\u201d]*\u201d/g, " ");
  const clauses = unquoted.match(/[^.!?;\n]+[.!?;\n]*/g) ?? [];
  let out: string | null = null;
  for (const c of clauses) { if (c.trim() === "") continue; const r = personFromClause(c, current, themed); if (r !== null) out = r; }
  return out;
}

/** Match a name phrase to ONE of the candidates by full name or first name (case/diacritic-insensitive); null when none or ambiguous. */
export function matchHouseguestName<T extends { name: string }>(phrase: string, candidates: readonly T[]): T | null {
  const norm = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 -]+/g, " ").replace(/\s+/g, " ").trim();
  const q = norm(phrase);
  if (q === "") return null;
  const hits = candidates.filter((c) => { const n = norm(c.name); return n === q || n.split(" ")[0] === q; });
  return hits.length === 1 ? hits[0]! : null;
}
