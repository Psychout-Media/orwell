/**
 * #1800 — The Booth Has Receipts: deterministic contradiction extraction from the player's
 * own recorded record ONLY. Pure module: NO VaultStore, SoulProvider, RelationshipModel,
 * or hidden engine module handle. Structurally incapable of reading hidden state.
 *
 * Candidate classes:
 *   - divergent-commitment: multiple open final-two deals
 *   - target-vote-mismatch: stated target ≠ actual vote in the same week
 *   - dr-public-flip: Diary Room statement contradicts a later public statement
 */

import type { EntityId } from "../domain/ids";

/** A single receipt: a deterministic contradiction extracted from the player's own record. */
export interface Receipt {
  kind: "divergent-commitment" | "target-vote-mismatch" | "dr-public-flip";
  summary: string;
  sourceEventIds: string[];
}

/** Input to computePlayerReceipts — plain data only, never a Vault handle. */
export interface ReceiptsInput {
  player: EntityId;
  deals: Array<{
    id: string;
    kind: string;
    parties: readonly [EntityId, EntityId];
    terms: string;
    status: string;
    madeEventId?: string;
  }>;
  events: Array<{
    id: string;
    kind?: string;
    content: string;
    initiator?: string;
  }>;
  /** Public display names for entity ids (so a summary never prints a raw `npc:N` id). Optional. */
  names?: Record<string, string>;
  /**
   * The player's OWN eviction votes, one per week they voted, each with that week's nominees and the
   * player's own public statements made in the run-up to that vote (the adapter windows them between
   * evictions). Plain data only — the player's own ballot is the player's own knowledge.
   */
  votes?: Array<{
    voteEventId: string;
    votedFor: { id: string; name: string };
    nominees: Array<{ id: string; name: string }>;
    statements: Array<{ id: string; content: string }>;
  }>;
  diaryRoomStatements: Array<{
    id: string;
    content: string;
    ts: number;
    subject?: EntityId;
  }>;
  publicStatements: Array<{
    id: string;
    content: string;
    ts: number;
  }>;
}

/**
 * Compute deterministic contradiction receipts from the player's OWN record.
 * No LLM, no RNG — pure deterministic logic over plain input data.
 *
 * After collecting candidates, sorts them by kind priority:
 * divergent-commitment → target-vote-mismatch → dr-public-flip,
 * then by sourceEventIds length ascending (simplest first).
 */
export function computePlayerReceipts(input: ReceiptsInput): Receipt[] {
  const receipts: Receipt[] = [];

  // 1. divergent-commitment: open final-two deals where player is a party
  const finalTwoDeals = input.deals.filter(
    (d) => d.kind === "final-two" && d.status === "open" &&
      (d.parties[0] === input.player || d.parties[1] === input.player)
  );
  if (finalTwoDeals.length > 1) {
    const partnerNames = finalTwoDeals.map((d) => {
      const id = d.parties[0] === input.player ? d.parties[1] : d.parties[0];
      return input.names?.[id] ?? "a houseguest";
    });
    const sourceIds = finalTwoDeals
      .map((d) => d.madeEventId)
      .filter((id): id is string => id !== undefined);
    receipts.push({
      kind: "divergent-commitment",
      summary: `You promised final-two to ${partnerNames.length} different people: ${partnerNames.join(", ")}. Footage doesn't forget.`,
      sourceEventIds: sourceIds.length > 0 ? sourceIds : [finalTwoDeals[0]!.id],
    });
  }

  // 2. target-vote-mismatch: in the run-up to an eviction the player said they'd go after one nominee,
  // then cast their own vote to evict the OTHER. Built from the player's real ballot + their own words.
  for (const vote of input.votes ?? []) {
    for (const nominee of vote.nominees) {
      if (nominee.id === vote.votedFor.id) continue;
      const said = vote.statements.find((st) => statesTarget(st.content, nominee.name));
      if (!said) continue;
      receipts.push({
        kind: "target-vote-mismatch",
        summary: `You told someone you'd target ${nominee.name}, but when it came time to vote, you voted to evict ${vote.votedFor.name}.`,
        sourceEventIds: [said.id, vote.voteEventId],
      });
      break; // one receipt per vote
    }
  }

  // 3. dr-public-flip: DR statement content disagrees with public statement
  for (const dr of input.diaryRoomStatements) {
    // Find a public statement that contradicts this DR statement
    for (const pub of input.publicStatements) {
      if (pub.ts <= dr.ts) continue; // public statement must be AFTER the DR statement
      if (isContradictory(dr.content, pub.content)) {
        receipts.push({
          kind: "dr-public-flip",
          summary: `In the Diary Room you said something different about this than what you said publicly.`,
          sourceEventIds: [dr.id, pub.id],
        });
        break; // one flip per DR statement
      }
    }
  }

  // Sort: by kind priority, then sourceEventIds length ascending
  const kindOrder: Record<string, number> = {
    "divergent-commitment": 0,
    "target-vote-mismatch": 1,
    "dr-public-flip": 2,
  };
  receipts.sort((a, b) => {
    const ka = kindOrder[a.kind] ?? 99;
    const kb = kindOrder[b.kind] ?? 99;
    if (ka !== kb) return ka - kb;
    return a.sourceEventIds.length - b.sourceEventIds.length;
  });

  return receipts;
}

/**
 * Does `content` state an intent to go after `name`? Deterministic: the name appears (whole word,
 * case-insensitive) with a targeting phrase shortly before it ("target X", "vote X out", "get rid of X",
 * "send X home", "backdoor X" …). A mention without a targeting phrase is not a stated target.
 */
export function statesTarget(content: string, name: string): boolean {
  if (!content || !name) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRe = new RegExp(`\\b${esc}\\b`, "gi");
  const verb = /\b(target(?:ing)?|evict(?:ing)?|vote(?:d|ing)?\s+(?:out|against|to evict)|get(?:ting)?\s+rid\s+of|go(?:ing)?\s+after|take\s+out|backdoor(?:ing)?|send(?:ing)?|cut(?:ting)?)\b/i;
  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(content)) !== null) {
    const before = content.slice(Math.max(0, m.index - 40), m.index);
    const after = content.slice(m.index + m[0].length, m.index + m[0].length + 16);
    if (verb.test(before)) return true;
    if (/^\s+(?:out|home|gone)\b/i.test(after) && /\b(vote|get|send|want)\b/i.test(before)) return true;
  }
  return false;
}

/**
 * Simple contradiction detection: checks whether content of two statements
 * disagree on a specific claim (e.g., trust vs distrust, like vs dislike).
 * Deterministic word-list approach, no LLM.
 */
function isContradictory(a: string, b: string): boolean {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();

  // Contradictory word pairs
  const pairs: [string[], string[]][] = [
    [["trust", "believe", "confide", "loyal", "solid"], ["distrust", "doubt", "suspect", "suspicious", "untrustworthy", "liability"]],
    [["like", "fond", "enjoy", "love", "appreciate"], ["dislike", "hate", "annoy", "irritate", "resent", "despise"]],
    [["strong", "powerful", "threat", "dangerous", "formidable"], ["weak", "fragile", "harmless", "easy", "pushover"]],
  ];

  // Helper: check if text expresses a positive word (present and NOT negated)
  function expressedPositively(text: string, posWords: string[]): boolean {
    // Negation prefixes to check - must be a complete word/prefix before the positive word
    const negationPrefixes = ["don't ", "doesn't ", "didn't ", "not ", "never ", "won't ", "can't ", "isn't ", "aren't ", "no "];
    for (const w of posWords) {
      const idx = text.indexOf(w);
      if (idx >= 0) {
        // Check if negated by looking 30 chars before the match
        const start = Math.max(0, idx - 30);
        const before = text.slice(start, idx);
        const isNegated = negationPrefixes.some(neg => before.includes(neg));
        if (!isNegated) return true;
      }
    }
    return false;
  }

  // Helper: check if text contains any negative word directly
  function containsNegative(text: string, negWords: string[]): boolean {
    return negWords.some(w => text.includes(w));
  }

  // Helper: check if text has a positive word that IS negated (equivalent to expressing negativity)
  function containsNegatedPositive(text: string, posWords: string[]): boolean {
    const negPrefixes = ["don't ", "doesn't ", "didn't ", "not ", "never ", "won't ", "can't ", "isn't ", "aren't ", "no "];
    for (const w of posWords) {
      const idx = text.indexOf(w);
      if (idx >= 0) {
        const start = Math.max(0, idx - 30);
        const before = text.slice(start, idx);
        if (negPrefixes.some(neg => before.includes(neg))) return true;
      }
    }
    return false;
  }

  for (const [posWords, negWords] of pairs) {
    const aPos = expressedPositively(aLower, posWords);
    const aNeg = containsNegative(aLower, negWords);
    const bPos = expressedPositively(bLower, posWords);
    const bNeg = containsNegative(bLower, negWords);

    const aNegPos = containsNegatedPositive(aLower, posWords);
    const bNegPos = containsNegatedPositive(bLower, posWords);

    // Contradiction: a is positive and b is negative, OR a is negative and b is positive
    // OR a is positively expressed and b has a negated-positive, OR a has negated-positive and b is positive
    if ((aPos && bNeg) || (aNeg && bPos) || (aPos && bNegPos) || (aNegPos && bPos)) return true;
  }

  return false;
}
