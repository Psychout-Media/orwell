/**
 * ORW-1053: which way a houseguest named in a deal's spoken terms points. "Vote to keep Valentina" and "I won't put Valentina up" PROTECT her; "we both vote Lorenzo out" and "send Lorenzo home" TARGET him.
 * Read per clause (split at punctuation, "but" and "and"); a keep / negation word in the clause wins over a vote-out word, and a name with neither is protected (the old reading). Pure; no rng.
 */
const KEEP_RE = /\b(?:keep\w*|sav(?:e|es|ed|ing)|protect\w*|safe|stay\w*|not|never|won'?t|don'?t|wouldn'?t|no one|nobody|got (?:your|his|her|their) back|have (?:your|his|her|their) back)\b/i;
const OUT_RE = /\b(?:vot(?:e|es|ed|ing)\b(?:\s+\w+){0,3}?\s+(?:out|off|against|to evict|evict)|evict\w*|send(?:s|ing)?\b(?:\s+\w+){0,2}\s+home|go(?:es|ing)? home|target\w*|go(?:ing)? after|come after|backdoor\w*|get(?:ting)? rid of|tak(?:e|ing) out|nominat\w*|put(?:s|ting)?\b(?:\s+\w+){0,2}\s+up)\b/i;

export type NamedPolarity = "protect" | "evict";

/** The polarity of the clause of `terms` that holds `at` (an index into `terms`). */
export function polarityAt(terms: string, at: number): NamedPolarity {
  let start = 0;
  let end = terms.length;
  const delim = /[.,;!?]|\bbut\b|\band\b/gi;
  for (let m = delim.exec(terms); m; m = delim.exec(terms)) {
    if (m.index + m[0].length <= at) start = m.index + m[0].length;
    else if (m.index >= at) { end = m.index; break; }
  }
  const clause = terms.slice(start, end);
  if (KEEP_RE.test(clause)) return "protect";
  return OUT_RE.test(clause) ? "evict" : "protect";
}
