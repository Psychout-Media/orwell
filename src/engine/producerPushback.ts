import type { EntityId } from "../domain/ids";
import { pushbacks, type PlayerSaid, type PlayerDid } from "./production";

/**
 * THEME C slice C3 (ORW-669, spec 0210) - THE PRODUCER WHO PUSHES BACK. Pure, no I/O, no rng, no Vault handle.
 *
 * When the player is in their own Diary Room and their recorded PUBLIC acts contradict their recorded PUBLIC word (a promise to a houseguest, then an act against that
 * same houseguest), the narrator is handed the contradiction as FACTS and voices the producer's question itself. The engine writes no producer line. The contradiction is
 * computed from the player's own recorded record (`pushbacks` in the foundation), never from what the player typed in the Diary Room (the entry text never reaches the
 * engine's state: the visit sink takes none), never from a houseguest's hidden state, motive or ballot, and it changes no outcome and no relationship.
 */

/** A pushback as facts: who it concerned, what the player said in kind, what the player did, and roughly when (words, never a number). */
export interface PushbackFact { name: string; said: string; saidWhen: string; did: string; didWhen: string }
/** The block the narrator voices from. `register` is the producer's manner for the season (words). */
export interface PushbackView { register: string; facts: PushbackFact[] }

/** The kind of word the player gave, as a plain public fact about the player. */
const SAID_KIND: Readonly<Record<PlayerSaid["promise"], string>> = {
  safe: "told them they were safe with the player",
  "vote-with": "promised them the player's vote",
  "not-target": "told them the player was with them and would not go after them",
  deal: "made a deal with them that the player would not move against them",
};
/** The kind of act the player committed, as a plain public fact about the player. */
const DID_KIND: Readonly<Record<PlayerDid["act"], string>> = {
  nominated: "put them on the block",
  "voted-against": "voted to evict them",
  "named-replacement": "named them as the replacement nominee",
  "broke-deal": "broke that deal",
};

/** A week as a relative phrase: words only. */
export function whenWords(week: number, now: number): string {
  const ago = now - week;
  return ago <= 0 ? "this week" : ago === 1 ? "last week" : "some weeks back";
}

/** The pushback facts from the player's own said/did record (at most the foundation's cap, the most recent first). Deterministic. */
export function pushbackFacts(said: readonly PlayerSaid[], did: readonly PlayerDid[], nameOf: (id: EntityId) => string, now: number): PushbackFact[] {
  return pushbacks(said, did).map((p) => ({
    name: nameOf(p.said.to), said: SAID_KIND[p.said.promise], saidWhen: whenWords(p.said.week, now), did: DID_KIND[p.did.act], didWhen: whenWords(p.did.week, now),
  }));
}

/** The moment's pushback block: facts to voice, in the per-turn fragment, never the base prompt. */
export function renderPushbackLines(v: PushbackView | undefined): string[] {
  if (!v?.facts.length) return [];
  const rows = v.facts.map((f) => `${f.name}: ${f.saidWhen} the player ${f.said}; ${f.didWhen} the player ${f.did}`).join(" | ");
  return [`- PRODUCER PUSHBACK: the player is in the Diary Room and their own public record disagrees with their own word. The producer may ask them to walk through it: the producer's manner this season is ${v.register}; you author the producer's words yourself, from these facts and nothing else. The facts, one per houseguest: ${rows}. Raise only these, as a question and not a verdict; never raise anything the player did not say or do, and never a houseguest's private view or secret. The player answers in their own words or not at all; nothing changes because of it, and nobody in the house hears it.`];
}
