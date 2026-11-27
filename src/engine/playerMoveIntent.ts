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
import { stripNonActs } from "./playerText";

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
  /\b(?:will|i'?ll|ill|later|maybe|perhaps|might|may|could|would|should|shall|if|when|once|after|before|until|unless|tomorrow|tonight|eventually|someday|soon|don'?t|do not|not|never|won'?t|can'?t|cannot|wouldn'?t|shouldn'?t|gonna|plan|planning|thinking|think|wonder|supposed|rather|instead|about to|going to go|how about|what about|why don'?t|in (?:an|a|one|two|few|\d+) (?:hour|hours|minute|minutes|min|mins|hr|hrs|day|days|while|bit)|at (?:\d+|noon|midnight|dinner|lunch|breakfast)(?:\s*(?:am|pm))?|every|each|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|all the time|sometimes|usually|always)\b/;
// A hedge AFTER the move that takes it back ("... but I can't", "... never mind", "... whichever is empty", "... or the lounge", "... but stop").
const TAKES_IT_BACK = /\b(?:but (?:i )?(?:can'?t|won'?t|cannot|don'?t|stop|then stop)|never ?mind|nvm|not really|just kidding|jk|whichever|or (?:to )?the|or (?:go|head|walk)|but stop|stopping|before i go)\b/;
const IF_TAIL = /,\s*(?:but\s+)?(?:only\s+)?(?:if|unless)\b/;
const QUESTION_START = /^(?:can|could|would|should|shall|may|do|does|did|is|are|am|will|what|where|why|how|who|which)\b/;

const LEAD_IN = /^(?:hey [a-z]+\b[,\s]*|(?:lol|lmao|haha|heh|oh|yeah|yep|sure|ok|okay|alright|all right|so|then|and|now|well|first|next|hey|um|uh|anyway|ok then|after that|with an? [a-z]+|right then|then)\b[,\s]*)+/;
const SUBJECT = /^(?:together,?\s+)?(?:(?:me|i)\s+and\s+[a-z]+\s+|(?:i|we)(?:'?m| am| are)?\s+|me\s+)/; // "im" typed without the apostrophe too
const INTENT = /^(?:(?:just|now|quickly|slowly|quietly|also|really|finally|then)\s+)*(?:(?:want to|wanna|need to|decide to|choose to|am)\s+)?(?:(?:just|now|quickly|slowly|quietly|then)\s+)*/;
const GO_VERB = /^(?:arrive at|get to|reach|pop (?:into|over to|in to)|swing by|come|comes|coming|drift|sneak|tiptoe|creep|stomp off|stomp|hurry|rush|race|jog|bolt|sprint|dash|storm off|storm|lead the way|exit|exits|exiting|enter|enters|entering|go|goes|head|heads|walk|walks|step|steps|move|moves|wander|wanders|stroll|strolls|run|runs|slip|slips|duck|ducks|retreat|retreats|going|heading|walking|stepping|moving|wandering|strolling|running|make my way|making my way)\b\s*/;
const TAKE_VERB = /^(?:take|bring|lead|walk|carry|guide)\s+me\b\s*/;
const LEAVE_VERB = /^(?:leave|leaves|leaving|exit|exits|exiting|get out of|getting out of|walk out of|walking out of|step out of|stepping out of|head out of|heading out of|go out of|going out of|go out from|walk out from)\b\s*/;
// Prepositions (and a few adverbs) between the verb and the destination.
const PREP = /^(?:(?:back|right|straight|over|down|up|out|on)\s+)*(?:(?:in\s*to|into|to|toward|towards|through|in|inside)\b\s*)?(?:(?:back|right|straight|over|down|up)\s+)*(?:(?:to|into)\s+)?/;
const ARTICLE = /^(?:the|my|our|your|this|that|a|an)\s+/;
// The destination phrase ends at the first of these joiners ("to the kitchen and say hi", "... to talk to X").
const PHRASE_END = /\s+(?:and|to|so|with|then|because|but|for|while|where|now|please|again|real quick|quickly|slowly|quietly|carefully|silently|alone|together|too|also|first|next|just)\b.*$/;

const INSIDE_WORDS = new Set(["inside", "in", "indoors", "back inside", "back in", "into the house", "inside the house", "in the house"]);
const OUTSIDE_WORDS = new Set(["outside", "outdoors", "out back", "outside the house", "out of the house"]); // ORW-1035: bare "out" ("go out", "heading out", "walk out") is no room

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

const TYPO_WORDS = ["kitchen", "hallway", "bathroom", "backyard", "bedroom", "lounge", "dining", "storage", "living", "garden", "landing"];
/** one edit or one swap of two neighbours */
function nearWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let d = 0, at = -1;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { d++; if (at < 0) at = i; }
    return d === 1 || (d === 2 && a[at] === b[at! + 1] && a[at! + 1] === b[at]);
  }
  const [lo, hi] = a.length < b.length ? [a, b] : [b, a];
  let i = 0; while (i < lo.length && lo[i] === hi[i]) i++;
  return lo.slice(i) === hi.slice(i + 1);
}
/** ORW-1008 (1036 typos): "teh", "goto", "go 2 the", "go too the", and a room word one slip away ("kithcen"). Words under 6 letters are never guessed at. */
function fixTypos(s: string): string {
  s = s.replace(/\bteh\b/g, "the").replace(/\bgoto\b/g, "go to").replace(/\b(go|head|heads|walk|move|step|run|going|heading|walking|come) (?:too|2|tp)\b/g, "$1 to");
  return s.replace(/\b[a-z]{6,}\b/g, (w) => TYPO_WORDS.includes(w) ? w : (TYPO_WORDS.find((t) => nearWord(w, t)) ?? w));
}

function clean(clause: string): string {
  let s = clause.replace(/[\u2018\u2019\u02BC]/g, "'").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[*_`~]+/g, " ").replace(/[^a-z0-9' -]+/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/\b(?:i'?d|i would) like to\b/g, "i want to").replace(/\bwould like to\b/g, "want to");
  s = fixTypos(s);
  s = s.replace(LEAD_IN, "").trim();
  return asNow(s);
}

/** A destination phrase -> a canonical room, or null when unsure/ambiguous. Strict about loose matches. */
const STUBS = /^(?:kit|hal|dia|liv|lou|sto|stor|din|dini|kitch)$/;
type Themed = ReadonlyArray<readonly [alias: string, room: Room]> | undefined;

function roomFromPhrase(phrase: string, current: Room | null, themed?: Themed): Room | null {
  let p = phrase.trim();
  if (p === "") return null;
  p = p.replace(PHRASE_END, "").trim().replace(ARTICLE, "").trim();
  if (p === "" || /^(?:bed|beds|room|sleep)$/.test(p)) return null; // "go to bed" is sleep; a bare "room" is no place
  if (/^(?:back|out|up|down|over|away|off|there|here|around|home|in|on|forward|ahead)$/.test(p)) return null; // ORW-1035: a direction word is no room ("step back", "go back", "walk out")
  if (STUBS.test(p)) return null; // ORW-1039: a houseguest's first name or a stub is no room ("Kit", "Hal", "Dia", "Liv", "Lou"): only a real room word counts as a destination
  if (p === "dr") return "diary-room"; // ORW-1082: the house's own shorthand
  if (/^(?:down\s*stairs|down\s+(?:the\s+)?stairs?)$/.test(p)) return current === "landing" ? "living-room" : current === "hoh-room" ? "landing" : null; // ORW-1035: down is a way out of the upper rooms only
  if (/^(?:up\s+(?:the\s+)?stairs?|(?:the\s+)?stairs?)$/.test(p)) return current === "landing" || current === "hoh-room" ? null : "landing";
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
function parseClauseHead(raw: string, current: Room | null, themed?: Themed): Room | null {
  const at = raw.indexOf(",");
  if (at > 0) { const head = parseClauseText(raw.slice(0, at), current, themed); if (head !== null) return head; }
  return parseClauseText(raw, current, themed);
}

/** ORW-1037: "No, the backyard" / "actually, the lounge" / "I mean the bathroom" after a move: the new room replaces the old one. */
const CORRECTION = /^(?:(?:no|nope|actually|wait|i mean|scratch that|sorry|oops|sike)\b[,.\s]*)+/;
function correctionRoom(piece: string, at: Room | null, themed?: Themed): Room | null {
  const c = clean(piece);
  const m = CORRECTION.exec(c);
  if (!m) return null;
  const rest = c.slice(m[0].length).replace(/^(?:(?:i )?(?:go|head|walk) )?(?:to |into )?/, "");
  return rest === "" ? null : roomFromPhrase(rest, at, themed);
}

const CANCEL_SEG = /^(?:(?:no\s+)?wait|actually\s+(?:no|never ?mind|forget it)|never ?mind|nvm|forget (?:it|that)|scratch that|on second thought)\b/;
const SEG_SPLIT = /(\s*[,;]\s*(?:and\s+)?(?:then\s+)?|\s+(?:and then|then|and)\s+)/;

/**
 * ORW-1037 / ORW-1040: a clause may hold several acts ("I smile and go to the kitchen", "I go to the kitchen, then the backyard", "I head to the kitchen; actually never mind"). The whole clause is read first (so
 * "take her to the backyard" keeps its person grammar), then each piece in order; the LAST piece that moves wins, a "never mind" takes the move back, and "then <room>" repeats the last go-verb with the new room.
 */
function parseClause(raw: string, current: Room | null, themed?: Themed): Room | null {
  const low = raw.toLowerCase();
  if (/\s\/\s|\w\/\w/.test(low)) return null; // "the kitchen / lounge": two rooms, no choice made
  if (IF_TAIL.test(low) || /,\s*but (?:i )?(?:can'?t|won'?t|cannot|don'?t)\b/.test(low)) return null; // "I go to the kitchen, if Dana's there" / "..., but I won't": a condition or a take-back, not a move
  const parts = raw.split(SEG_SPLIT);
  let result = parseClauseHead(raw, current, themed);
  if (parts.length > 1) {
    let lastVerb = "";
    let delim = "";
    let moved: Room | null = null;
    let cancelled = false;
    for (let i = 0; i < parts.length; i++) {
      const piece = parts[i]!;
      if (i % 2 === 1) { delim = piece; continue; }
      const t = piece.trim();
      if (t === "") continue;
      const fix: Room | null = result !== null ? correctionRoom(t, moved ?? current, themed) : null;
      if (fix !== null) { moved = fix; result = fix; continue; }
      if (CANCEL_SEG.test(clean(t))) { result = null; moved = null; cancelled = true; continue; }
      let r = parseClauseText(t, moved ?? current, themed);
      if (r === null && cancelled) { const bareRoom = roomFromPhrase(clean(t).replace(/^(?:to|into|the)\s+/, ""), current, themed); if (bareRoom !== null) r = bareRoom; } // "actually no, the backyard" / "scratch that, lounge"
      if (r === null && /then/.test(delim) && lastVerb !== "") {
        const c = clean(t).replace(/^(?:to|into|in to|back to|over to)\s+/, "");
        const room = roomFromPhrase(c, moved ?? current, themed);
        if (room !== null && /^(?:the |my |our |a |an )?[a-z' -]+$/.test(c)) r = room;
      }
      if (r !== null) { moved = r; result = r; const v = GO_VERB.exec(clean(t).replace(SUBJECT, "").replace(INTENT, "")); if (v) lastVerb = v[0]; }
    }
  }
  return result;
}

function parseClauseText(raw: string, current: Room | null, themed?: Themed): Room | null {
  if (/\?\s*$/.test(raw.trim())) return null;
  let s = clean(raw);
  if (s === "" || QUESTION_START.test(s) || NOT_A_MOVE.test(moveHead(s)) || TAKES_IT_BACK.test(s)) return null;
  let subjected = true;
  const lets = LETS.exec(s);
  if (lets) { // an invitation to go together: the player's own walk is the move ("let's go to the kitchen"); only a go-verb counts
    s = s.slice(lets[0].length);
    if (!GO_VERB.test(s)) return null;
  } else {
    subjected = SUBJECT.test(s);
    s = s.replace(SUBJECT, "");
    s = s.replace(INTENT, "");
  }

  // 0. the player walks WITH someone: "take her to the bathroom", "walk with her to the lounge" - the player's move to the room named.
  if (/^(?:come|comes|coming)\b/.test(s) && !subjected) return null; // "come to the kitchen" is said to somebody else
  const gv = GO_VERB.exec(s);
  const tp = TAKE_PERSON.exec(s) ?? (gv ? WITH_PERSON.exec(s.slice(gv[0].length)) : null);
  if (tp && tp[1] !== "me" && personPhrase(tp[1]!, current, themed)) {
    const to = roomFromPhrase(tp[2]!, current, themed);
    if (to !== null) return to;
  }

  // 0b. "I find Dana in the backyard" / "I see Kit in the kitchen": the player's own act of going to where they are, the room named.
  const fi = /^(?:find|finds|finding|visit|meet|look for)\s+([a-z][a-z' -]{0,28}?)\s+(?:in|inside|at)\s+(.+)$/.exec(s);
  if (fi && !/^(?:her|him|them|it|you|me|us|everyone|someone|somebody|anyone|(?:a|an|the|my|our|some)\s.*)$/.test(fi[1]!) && personPhrase(fi[1]!, current, themed, true)) { const to = roomFromPhrase(fi[2]!, current, themed); if (to !== null) return to; }

  // 0c. "I follow Dana to the kitchen" / "I follow her into the lounge": the player's own walk to the room named.
  const fo = /^(?:follow|follows|following)\s+(?!me\b|us\b)[a-z][a-z' -]{0,28}?\s+(?:back\s+)?(?:in\s*to|into|to|toward|towards)\s+(.+)$/.exec(s);
  if (fo) { const to = roomFromPhrase(fo[1]!, current, themed); if (to !== null) return to; }

  // 1. "leave the backyard" / "leave" + here: through the door the floor plan gives.
  let m = LEAVE_VERB.exec(s);
  if (m) {
    const via = /\s+(?:in\s*to|into|to|for|toward|towards)\s+(.+)$/.exec(s.slice(m[0].length)); // "I leave the kitchen for the backyard": the room named after the door is the move
    if (via) { const to = roomFromPhrase(via[1]!, current, themed); if (to !== null) return to; }
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
    const fr = FIND_IN_ROOM.exec(afterVerb.replace(/^(?:(?:back|right|straight|over|up)\s+)+/, ""));
    if (fr && personPhrase(fr[1]!, current, themed, /^(?:and\s+)?(?:find|look for|see|get)\b/.test(afterVerb.replace(/^(?:(?:back|right|straight|over|up)\s+)+/, "")))) { const to = roomFromPhrase(fr[2]!, current, themed); if (to !== null) return to; } // "go find <X> in the backyard": the room named
    if (/^down\s*stairs$|^down\s+(?:the\s+)?stairs?$/.test(bare)) return roomFromPhrase(bare, current, themed); // ORW-1035
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
  const unquoted = stripNonActs(text);
  const clauses = unquoted.match(/[^.!?;\n]+[.!?;\n]*/g) ?? [];
  return clauses.some((c) => c.trim() !== "" && ownBedClause(c));
}

/**
 * Read a player's message for a present-tense move of their OWN. Returns the destination room, or null
 * when there is no clear move (unsure parses never guess). When several clauses move, the LAST one wins
 * (it is where the player ends up). Quoted speech is ignored.
 */
// ORW-1082, settled by the movement rulings (the engine moves the player on their own stated move, 2026-11-15; a room's name alone moves nobody, 2026-11-26):
const SARCASM = /^\s*(?:oh,?\s+sure|yeah,?\s+right)\b[^]*\bbecause\s+that(?:'|\u2019)?s\b/i; // "oh sure, I'll just go to the kitchen, because that's helpful": mocking the idea is not going
const AND_GO_THERE = /\b(?:and|then)\s+(?:i\s+)?(?:then\s+)?(?:go|head|walk)\s+there\b/i;
const GO_SEE = /^(?:i\s+)?(?:go|head|walk|going|heading|walking)\s+(?:and\s+|to\s+)?see\s+the\s+([a-z][a-z -]{1,24})$/; // with "the": a bare "go see Pool" may be a person, so it is left to the person parser

/** "... and go there": "there" is the one room named earlier in the same message (quoted words included: "I'll meet you in the kitchen"). Two rooms named, or none: no guess. */
function roomNamedForThere(text: string, current: Room | null, themed?: Themed): Room | null {
  const m = AND_GO_THERE.exec(text);
  if (!m) return null;
  const rooms = new Set<Room>();
  for (const hit of text.slice(0, m.index).matchAll(/\b(?:to|in|into|at)\s+(?:the\s+)?([a-z]+(?:[ -](?:room|a|b|c))?)\b/gi)) {
    const r = roomFromPhrase(hit[1]!.toLowerCase(), current, themed);
    if (r !== null) rooms.add(r);
  }
  return rooms.size === 1 ? [...rooms][0]! : null;
}

export function parsePlayerMoveIntent(text: string, current: Room | null, themed?: Themed): Room | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  if (SARCASM.test(text)) return null;
  const unquoted = stripNonActs(text);
  const clauses = unquoted.match(/[^.!?;\n]+[.!?;\n]*/g) ?? [];
  let dest: Room | null = null;
  let at = current;
  for (const c of clauses) {
    if (c.trim() === "") continue;
    let cText = c;
    const fix: Room | null = dest !== null ? correctionRoom(c, at, themed) : null; // "No, the backyard." / "wait, no, the lounge" after a move
    const cm = fix === null ? CANCEL_SEG.exec(clean(c)) : null;
    if (dest !== null && cm) { // "actually never mind" after a move takes it back; "no wait, I head to the lounge" takes it back and says the new one
      dest = null; at = current;
      const rest = clean(c).slice(cm[0].length).replace(/^[,\s]+/, "");
      if (rest === "") continue;
      cText = rest;
    }
    const see = GO_SEE.exec(clean(cText)); // ORW-1082: "I go see the bathroom" (a room, not a person)
    const room: Room | null = fix ?? parseClause(cText, at, themed) ?? (see ? roomFromPhrase(see[1]!, at, themed) : null);
    if (room !== null) { dest = room; at = room; }
  }
  dest ??= roomNamedForThere(text, current, themed);
  return dest === current ? null : dest;
}

// ORW-559 - "go to <houseguest>": the same present-tense self-move grammar, but the destination phrase is a PERSON. The parser only
// extracts the phrase; the engine resolves it against who the player can legitimately see (never a hidden whereabouts).
const FIND_VERB = /^(?:try to find|trying to find|find|finds|finding|look for|looks for|looking for|seek out|seeking out|search for|searching for|track down|tracking down|locate|go find|go look for|go see|go and find)\b\s*/;

const FOLLOW_VERB = /^(?:follow|follows|following|trail|trails|trailing)\b\s*/;
const FOLLOW_TAIL = /\s+(?:inside|outside|indoors|back|in|out|into|to|and|then|wherever|where|so|with|through)\b.*$/;

function personFromClause(raw: string, current: Room | null, themed?: Themed): string | null {
  if (/\?\s*$/.test(raw.trim())) return null;
  let s = clean(raw);
  if (s === "" || QUESTION_START.test(s) || NOT_A_MOVE.test(moveHead(s))) return null;
  const letsP = LETS.exec(s);
  if (letsP) s = s.slice(letsP[0].length);
  else s = s.replace(SUBJECT, "").replace(INTENT, "");
  s = s.replace(/^(?:try to|trying to)\s+(?=find\b)/, "try to ");
  let rest: string | null = null;
  const f = FIND_VERB.exec(s);
  const fo = FOLLOW_VERB.exec(s); // ORW-926: "I follow <X> inside to wherever they went": walking after a person is a move to where that person is (when the player can see them)
  const tk = /^(?:take|bring|lead|walk|guide)\s+me\s+(?:over\s+)?to\s+(.+)$/.exec(s);
  if (f) rest = s.slice(f[0].length);
  else if (tk) rest = tk[1]!;
  else if (fo) rest = s.slice(fo[0].length).replace(FOLLOW_TAIL, "");
  else {
    const g = GO_VERB.exec(s);
    if (g) {
      const after = s.slice(g[0].length);
      rest = after.replace(/^(?:(?:back|right|straight|over|down|up|off)\s+)*(?:(?:in\s*to|into|to|toward|towards)\b\s*)?(?:(?:over)\s+)?(?:(?:to|and find|and look for|and see)\s+)?/, "");
    }
  }
  if (rest === null) return null;
  rest = rest.replace(/^(?:me\s+)?(?:to\s+)?/, "");
  const p = rest.replace(PHRASE_END, "").replace(/\s+(?:in|inside|at)\b.*$/, "").replace(/'s$/, "").trim(); // "go find Dana in the backyard": the person is Dana; "Dana's" is Dana
  const pre = rest.replace(/\s+(?:in|inside|at)\b.*$/, "");
  const andAt = /^(.+?)\s+and\s+([a-z' -]+)$/.exec(pre);
  if (andAt && andAt[2]!.trim().split(" ").length <= 2 && !/\b(?:put|offer|give|propose|pitch|show|let|invite|confront|apologi[sz]e|ask|tell|talk|say|see|find|look|grab|get|have|make|take|bring|go|head|walk|then|chat|check)\b/.test(andAt[2]!)) return null; // two people ("Dana and Jake"): no one to go to
  if (p === "" || !/^[a-z][a-z' -]*$/.test(p) || p.split(" ").length > 3) return null;
  if (roomFromPhrase(p, current, themed) !== null) return null; // a room word is a room, not a person
  return p;
}

/** The houseguest name phrase the player says they are going to / looking for, or null. LAST clause wins; quoted speech is ignored. */
export function parsePlayerPersonIntent(text: string, current: Room | null, themed?: Themed): string | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  const unquoted = stripNonActs(text);
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

/**
 * ORW-1003 (Ryne: walk with them, don't talk about it): a go with no named place. "walk over and say hi", "head over there", "go over to them" go to the houseguest or group last named; "I follow her/him/them"
 * goes after whoever just left. Only the FORM is read here (quoted speech ignored; hedged / negated / later clauses never count); the engine resolves who and where from public presence.
 */
const VAGUE_GO = /\b(?:walk|walks|head|heads|go|goes|step|steps|wander|wanders|move|moves|come|comes)\s+(?:on\s+)?(?:over(?:\s+there|\s+to\s+(?:them|him|her))?|there)\b/;
const FOLLOW_PRONOUN = /\b(?:follow|follows|trail|trails|go after|goes after|go with|goes with)\s+(her|him|them)\b/;
export type VagueGo = { kind: "over" } | { kind: "follow"; pronoun: "her" | "him" | "them" };
export function parseVagueGo(text: string): VagueGo | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  const unquoted = text.replace(/"[^"]*"/g, " ").replace(/\u201c[^\u201d]*\u201d/g, " ");
  let out: VagueGo | null = null;
  for (const c of unquoted.match(/[^.!?;\n]+[.!?;\n]*/g) ?? []) {
    if (/\?\s*$/.test(c.trim())) continue;
    const s = clean(c);
    if (s === "" || QUESTION_START.test(s) || NOT_A_MOVE.test(moveHead(s))) continue;
    const f = FOLLOW_PRONOUN.exec(s);
    if (f) { out = { kind: "follow", pronoun: f[1] as "her" | "him" | "them" }; continue; }
    if (VAGUE_GO.test(s)) out = { kind: "over" };
  }
  return out;
}

// ORW-934 - "look for X / find X / search the house for X / where is X": the player is SEARCHING for a houseguest. The parser only extracts the name phrase; the engine decides what the search can reveal (the
// route follows recorded sightings, never the hidden whereabouts) and the phrase must still match one active houseguest. Hedged or future phrasing ("maybe I'll look for", "later") is not a search.
const SEARCH_WHERE = /^(?:(?:and|so|ok|okay|hey|wait|um|well|now|hmm)\b[,\s]*)*where(?:'s| is| are| was| did| has)\s+(.+)$/;
const SEARCH_FIND = /(?:^|\s)(?:go\s+|and\s+|to\s+|try\s+to\s+|help\s+me\s+)?(?:find|look for|looking for|search for|searching for|search (?:the )?(?:whole |entire )?house for|searching (?:the )?(?:whole |entire )?house for|hunt for|hunting for|seek out|seeking out|track down|tracking down|locate)\s+(.+)$/;
const SEARCH_NOT_A_NAME = new Set(["he", "she", "they", "him", "her", "them", "it", "everyone", "everybody", "anyone", "anybody", "someone", "somebody", "no one", "nobody", "a", "an", "some", "the", "my", "out", "us", "you", "me", "something", "anything", "everything", "the others", "the rest", "answers", "a way", "the exit"]);
const SEARCH_TAIL = /\s+(?:go|goes|going|went|gone|get|got|disappear(?:ed)?|run off|ran off|end up|ended up|now|today|anywhere|right now|and|to|so|with|then|because|but|for|while|please|again|real quick|quickly|first|next|just|in the|in|at|on|until|before|after)\b.*$/;

export function parseSearchIntent(text: string, current: Room | null, themed?: Themed): string | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  const unquoted = text.replace(/"[^"]*"/g, " ").replace(/“[^”]*”/g, " ");
  const clauses = unquoted.match(/[^.!?;\n]+[.!?;\n]*/g) ?? [];
  let out: string | null = null;
  for (const c of clauses) {
    if (c.trim() === "") continue;
    let s = clean(c);
    if (s === "") continue;
    s = s.replace(LEAD_IN, "").replace(/^.*\buntil i\s+(?=find|locate)/, "i ");
    let rest: string | null = null;
    const w = SEARCH_WHERE.exec(s);
    if (w) rest = w[1]!;
    else {
      if (NOT_A_MOVE.test(moveHead(asNow(s))) || QUESTION_START.test(s)) continue;
      const f = SEARCH_FIND.exec(asNow(s));
      if (f) rest = f[1]!;
    }
    if (rest === null) continue;
    const p = rest.replace(/^(?:for\s+)/, "").replace(SEARCH_TAIL, "").trim();
    if (p === "" || SEARCH_NOT_A_NAME.has(p) || !/^[a-z][a-z' -]*$/.test(p) || p.split(" ").length > 3) continue;
    if (roomFromPhrase(p, current, themed) !== null) continue; // a room word is a room, not a person
    out = p;
  }
  return out;
}
