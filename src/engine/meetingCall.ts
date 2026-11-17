import { PLAYER, type EntityId } from "../domain/ids";
import type { SpokenClaimKind } from "./spokenClaims";

/**
 * Feature 0156 (theme 2, slice 7b, ORW-330) - the player calls a house meeting in their own words. PURE: text in, a call out; nothing is decided here.
 *
 * `parsePlayerMeetingCall(text, people)` recognises the player gathering the house ("I call a house meeting", "everyone, living room, we need to talk", "I want to say this in
 * front of everybody: ...") and, when they name one, pulls out the accused and ONE claim of the claims core's fixed set (`SPOKEN_CLAIM_KINDS`). The accused is the claim's subject.
 * Quoted speech is the player's own voice here (they shout it), so it is read; hedged, negated, conditional and question phrasing calls nothing. Whether the call is allowed
 * (`canCallMeeting`) and what happens (`holdHouseMeeting`) are the engine's.
 *
 * Claim forms (names are first or full names; "me" is the player, "us"/"everyone"/"you all" the house):
 *  - "X is going after / gunning for / targeting / putting up / nominating Y"  => going-after (X, Y);  "... targeting me|us|everyone" => targets-you (X) when it is the house, going-after (X, player) for "me"
 *  - "X voted (to evict | against) me|us|you"                                 => voted-to-evict-you (X)
 *  - "X and Y have a final two" / "X has a final two with Y"                 => final-two-with (X, Y)
 *  - "X is talking about Y behind their back" / "trash talking Y"            => talking-about (X, Y)
 *  - "X is lying (to Y)"                                                     => lying-about (X, Y?)
 */

export interface MeetingCallClaim { kind: SpokenClaimKind; subject: EntityId; object?: EntityId }
/** `accused` and `claim` appear together when the player named a claim; a bare call ("I call a house meeting") has neither. */
export interface PlayerMeetingCall { accused?: EntityId; claim?: MeetingCallClaim }

const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A clause that is not the player doing / saying it now: negated, conditional, hypothetical or asked. */
const HEDGE = /\b(?:won't|wont|will not|not going to|not gonna|don't|do not|dont|didn't|never|no way|if|maybe|perhaps|might|could|would|should|wish|wonder|wondering|thinking (?:about|of)|considering|what if|imagine|suppose|pretend|someday|one day|later|unless|whether)\b/;

const CALL = [
  /\b(?:i|we|let's|lets|i'll|ill|i'm going to|im going to|i am going to|i'm gonna|im gonna|gonna)\s+(?:(?:now|just|hereby|am|are|going to)\s+)*(?:call|calling|called|hold|holding|have|having|convene|convening|start|starting|gather|gathering)\s+(?:up\s+)?(?:a|an|the|this)?\s*(?:whole\s+)?(?:house\s+)?(?:meeting|powwow|pow wow|huddle)\b/,
  /\b(?:i|we)\s+(?:need|want)\s+(?:to\s+)?(?:a|an)?\s*(?:house|everyone|everybody|whole house)\s*(?:meeting|together|in the living room|gathered)\b/,
  /\b(?:house|whole house|everybody|everyone) meeting\b/,
  /\b(?:everyone|everybody|all of you|you guys|guys|house|whole house)\b.*\b(?:living room|come here|come in here|gather|get in here|over here|sit down|circle up|huddle up)\b/,
  /\b(?:living room|come here|gather round|gather around|circle up|huddle up)\b.*\b(?:everyone|everybody|all of you|you guys)\b/,
  /\b(?:we|i)\s+(?:all\s+)?need to talk\b/,
  /\bin front of (?:everybody|everyone|the whole house|the house|all of you)\b/,
];
/** "we need to talk" / "in front of everybody" alone are only a call when said to the house, not "we need to talk" to one person: they need a house word in the clause or a claim next to them. */
const HOUSE_WORD = /\b(?:everyone|everybody|all of you|you guys|guys|the house|whole house|house|living room|in front of)\b/;

interface Named { id: EntityId; at: number; end: number }
function namesIn(c: string, people: ReadonlyArray<{ id: EntityId; names: readonly string[] }>): Named[] {
  const out: Named[] = [];
  for (const p of people) {
    let best: Named | undefined;
    for (const raw of p.names) {
      const n = fold(raw).trim();
      if (n.length < 2) continue;
      const m = new RegExp(`\\b${esc(n)}\\b`).exec(c);
      if (m && (!best || m.index < best.at)) best = { id: p.id, at: m.index, end: m.index + m[0].length };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => a.at - b.at);
}

const HOUSE_OBJ = String.raw`(?:us|everyone|everybody|you all|all of us|all of you|the (?:whole )?house)`;
const ME = String.raw`(?:me|myself)`;

function claimOf(c: string, people: ReadonlyArray<{ id: EntityId; names: readonly string[] }>): MeetingCallClaim | null {
  const named = namesIn(c, people);
  const first = named[0];
  if (!first) return null;
  const after = c.slice(first.end);
  const second = named.find((n) => n.id !== first.id && n.at >= first.end);
  const PRE = String.raw`^\s*(?:and\s+\S+\s+)?(?:is|are|has been|have been|was|has|have|'s)?\s*`;
  // voted to evict me / us
  if (new RegExp(String.raw`^\s*(?:and\s+\S+\s+)?(?:voted|has voted|have voted|did vote)\s+(?:to evict|to get rid of|against|to send home)\s+(?:${ME}|you|${HOUSE_OBJ})\b`).test(after)) return { kind: "voted-to-evict-you", subject: first.id };
  // final two
  if (/\bfinal (?:2|two)\b/.test(after)) {
    if (second) return { kind: "final-two-with", subject: first.id, object: second.id };
    return null;
  }
  // going after / targeting
  const GOING = String.raw`(?:going after|coming after|gunning for|out for|targeting|after|putting up|putting on the block|nominating|backdooring|planning to evict|trying to evict|going to evict|trying to get out)`;
  if (new RegExp(`${PRE}${GOING}\\s+(?:${ME}|${HOUSE_OBJ}|you)\\b`).test(after)) {
    const toHouse = new RegExp(`${PRE}${GOING}\\s+(?:${HOUSE_OBJ}|you)\\b`).test(after);
    return toHouse ? { kind: "targets-you", subject: first.id } : { kind: "going-after", subject: first.id, object: PLAYER };
  }
  if (new RegExp(`${PRE}${GOING}\\b`).test(after)) {
    return second ? { kind: "going-after", subject: first.id, object: second.id } : null;
  }
  // talking about
  if (/\b(?:talking|talks|talked|trash talking|trashing|bad mouthing|badmouthing|gossiping|smack talking|running (?:their|his|her) mouth)\b/.test(after) && /\b(?:about|behind|on|smack about|smack on)\b/.test(after)) {
    if (/\b(?:about|on)\s+me\b|behind my back/.test(after) && !second) return { kind: "talking-about", subject: first.id, object: PLAYER };
    return second ? { kind: "talking-about", subject: first.id, object: second.id } : null;
  }
  // ORW-560: a broken word is a lie - "X told two people they were safe and then nominated them anyway", "X promised me safety and put me up", "X broke her word",
  // "X went back on the deal", "X is a liar", "X betrayed / backstabbed / double-crossed Y". Said about named people (the second name) or about "me".
  const PROMISED = /^\s*(?:and\s+\S+\s+)?(?:told|promised|swore|assured|gave)\b.*\b(?:safe|safety|protect|protected|keep (?:me|us|them|him|her) off|off the block|not (?:put|nominate|vote))\b.*\b(?:nominated|nominate|put (?:me|us|them|him|her|\S+) (?:up|on the block)|backdoored|voted (?:out|against|to evict)|evicted|turned on)\b/;
  const BROKE = /^\s*(?:and\s+\S+\s+)?(?:has |have )?(?:broke|broken|went back on|gone back on|reneged on)\s+(?:her|his|their|a|the|our|my)\s+(?:word|promise|deal)\b/;
  const LIAR = /^\s*(?:is|'s|was)\s+(?:a|such a|a total|a complete)\s+(?:liar|snake|backstabber|traitor|fraud)\b/;
  const BETRAYED = /^\s*(?:and\s+\S+\s+)?(?:betrayed|backstabbed|back stabbed|double crossed|double-crossed|sold out|screwed over|stabbed)\b/;
  if (PROMISED.test(after) || BROKE.test(after) || LIAR.test(after) || BETRAYED.test(after)) {
    if (second) return { kind: "lying-about", subject: first.id, object: second.id };
    if (/\b(?:me|myself)\b/.test(after)) return { kind: "lying-about", subject: first.id, object: PLAYER };
    return { kind: "lying-about", subject: first.id };
  }
  // lying
  if (/^\s*(?:is|has been|have been|was|'s|are)?\s*(?:lying|been lying|lied)\b/.test(after)) {
    if (/\bto\s+(?:me|myself)\b/.test(after) && !second) return { kind: "lying-about", subject: first.id, object: PLAYER };
    if (second) return { kind: "lying-about", subject: first.id, object: second.id };
    return { kind: "lying-about", subject: first.id };
  }
  return null;
}

/**
 * Read the player's message for a call to the house. Needs a call phrase in an unhedged clause; the LAST unhedged clause that names a claim wins (so a correction later in
 * the message holds). Returns null for anything that is not the player calling a meeting now.
 */
export function parsePlayerMeetingCall(text: string, people: ReadonlyArray<{ id: EntityId; names: readonly string[] }>): PlayerMeetingCall | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  const clauses = text.match(/[^.!;:\n?]+[.!;:\n?]*/g) ?? [];
  let called = false;
  let weakCall = false; // "we need to talk" / "in front of everybody": a call only beside a house word or a claim
  let claim: MeetingCallClaim | null = null;
  for (const raw of clauses) {
    const asked = /\?\s*$/.test(raw.trim());
    const c = ` ${fold(raw).replace(/[’]/g, "'").replace(/[^a-z0-9' -]+/g, " ").replace(/\s+/g, " ").trim()} `;
    if (HEDGE.test(c) || asked) continue;
    const hit = CALL.findIndex((r) => r.test(c));
    if (hit >= 0) {
      if (hit >= 5 && !HOUSE_WORD.test(c)) weakCall = true; else called = true;
    }
    const got = claimOf(c, people);
    if (got) claim = got;
  }
  if (!called && !(weakCall && claim) ) return null;
  return claim ? { accused: claim.subject, claim } : {};
}
