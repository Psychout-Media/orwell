/**
 * PAT-2 (#1989) — the checks behind feature 0023's "the opinion change is invisible" scenario, kept in a
 * dependency-free support module so a Vitest positive control (tests/unit/bddRelationshipLeakChecks.test.ts)
 * drives the SAME functions the BDD steps do (a check that is never seen to fail proves nothing).
 *
 * Two layers:
 *  1. PROSE (backstop): a relationship VALUE bound to a trust/affinity/threat label, or a sentence stating the
 *     opinion changed. Both are clause-bounded so the plain words ("can I trust you?", a speech tell "makes a
 *     threat sound like small talk", the moment prompt's "form opinions as it unfolds") do not trip them.
 *  2. STRUCTURE (the strong check): a recursive walk of the structured player projections that fails on ANY
 *     numeric value under a key that names a relationship quantity.
 */

/**
 * A relationship label bound to a number. trust/affinity/threat: "trust 7", "trust level 7/10", "threat (8)",
 * "affinity of 0.4", "trust +0.2", "trust: 0.8", `"trust":0.8`. opinion/relationship (stricter, since "in my
 * opinion 3 of them" / "a relationship of 3 years" are plain words): the label + a value marker and a number
 * ("opinion: 7", `"relationship":0.4`, "opinion (7)", "opinion level 7"), or a bare decimal / fraction ("opinion of 0.4", "relationship 7/10").
 */
export const RELATIONSHIP_VALUE_PROSE = new RegExp(
  [
    "\\b(?:trust|affinity|threat)\\b\\W{0,3}(?:level|score|of|is)?\\W{0,3}[+-]?\\d",
    "\\b(?:opinion|relationship)s?\\b(?:\\s+(?:level|score|value|rating)\\W{0,3}|[\"']?\\s*[:=(]\\s*|\\s+\\()[+-]?\\d",
    "\\b(?:opinion|relationship)s?(?:\\s+(?:of|is))?\\s+[+-]?(?:\\d+\\.\\d+|\\d+\\/\\d+)",
  ].join("|"),
  "i",
);

const CHANGE = "chang\\w*|shift\\w*|improv\\w*|drop\\w*|rose|fell|sour\\w*|soften\\w*|warm(?:ed|s)?|cool(?:ed|s)?|turn(?:ed|s)?|grown|grew|worse\\w*|better";

/** A gap that stays inside ONE clause: no sentence end, comma, semicolon, colon or newline. */
const GAP = "[^.,;:!?\\n]";

/** A sentence stating the houseguest's opinion of the player changed. Every gap is `GAP` so a match stays inside one clause. */
export const OPINION_CHANGED_PROSE = new RegExp(
  [
    // "her opinion of you has soured", "opinions shifted"
    `\\bopinions?\\b${GAP}{0,40}\\b(?:${CHANGE})\\b`,
    // "her feelings toward you have cooled", "his attitude about you turned"
    `\\b(?:feelings?|attitude|regard|view|stance|impression)\\b${GAP}{0,30}\\b(?:of|toward|towards|about|for)\\b${GAP}{0,15}\\byou\\b${GAP}{0,30}\\b(?:${CHANGE})\\b`,
    // "her trust in you dropped", "her relationship with you changed", "the bond between you has soured"
    `\\b(?:trust|affinity|relationship|rapport|bond)\\b${GAP}{0,30}\\b(?:in|with|for|toward|towards|of|between)\\b${GAP}{0,15}\\byou\\b${GAP}{0,30}\\b(?:${CHANGE})\\b`,
    // "your relationship with her changed", "your trust has grown"
    `\\byour (?:relationship|bond|rapport|trust|affinity)\\b${GAP}{0,30}\\b(?:${CHANGE})\\b`,
    `\\bfeels?\\b${GAP}{0,30}\\babout you`,
    `\\bchanged\\b${GAP}{0,30}\\btoward\\b`,
    // "thinks less of you", "thinks a little more of you"
    `\\bthinks?\\b${GAP}{0,20}\\b(?:less|more)\\b${GAP}{0,10}\\bof you\\b`,
    // "no longer trusts you", "no longer likes you"
    "\\bno longer (?:trusts?|likes?|respects?|fears?|favou?rs?) you\\b",
    // "likes you more", "trusts you less"
    "\\b(?:likes?|trusts?|respects?|fears?|distrusts?) you (?:a (?:bit|little|lot) )?(?:more|less)\\b",
  ].join("|"),
  "i",
);

/**
 * Keys that name a relationship quantity (/trust|affinity|threat|opinion|relationship|edge/i). `edge` is matched
 * only as a word / camel hump ("edge", "relEdge", "npc_edge"), NOT inside "knowledge" or "pledge".
 */
export const isRelationshipKey = (k: string): boolean =>
  /trust|affinity|threat|opinion|relationship/i.test(k) || /(?:^|[^A-Za-z])[Ee]dge|[a-z]Edge/.test(k);

/**
 * The ENGINE-GENERATED part of a moment prompt, for the prose backstop: `systemPrompt` with only the FIXED
 * instruction pieces (`fixed`: the base game-master prompt + the moment's beat fragment) cut out, so the
 * dynamic context (game context, world context, story facts, freshly surfaced facts) IS still swept, plus
 * `hardConstraints`. A fixed piece that is not found verbatim is not removed (so a drifted template fails
 * loudly on its own plain words rather than silently hiding the dynamic text).
 */
export function generatedPromptText(mp: { systemPrompt: string; hardConstraints?: string }, fixed: string[]): string {
  let text = mp.systemPrompt;
  for (const f of fixed) if (f) text = text.split(f).join("\n");
  return [text, mp.hardConstraints ?? ""].join("\n---\n");
}

export function assertNoRelationshipValueProse(text: string, where = "player-facing prose"): void {
  const m = RELATIONSHIP_VALUE_PROSE.exec(text);
  if (m) throw new Error(`relationship value in ${where}: ...${excerpt(text, m.index)}...`);
}

export function assertNoOpinionChangedProse(text: string, where = "player-facing prose"): void {
  const m = OPINION_CHANGED_PROSE.exec(text);
  if (m) throw new Error(`statement that an opinion changed in ${where}: ...${excerpt(text, m.index)}...`);
}

const excerpt = (text: string, at: number): string => text.slice(Math.max(0, at - 20), at + 80).replace(/\s+/g, " ");

/**
 * Recursively walk a structured projection and return the path of every numeric value (a number, or a
 * numeric string) that sits UNDER a key matching RELATIONSHIP_KEY — directly or at any depth below it.
 */
/** A numeric string in any common form: "7", "+0.5", ".5", "5.", "1e-3", "-2.5E+4". */
const NUMERIC_STRING = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/;

export function numericRelationshipLeaks(value: unknown, path: string[] = [], underKey = false): string[] {
  if (typeof value === "number") return underKey ? [`${path.join(".")}=${value}`] : [];
  if (typeof value === "string") return underKey && NUMERIC_STRING.test(value) ? [`${path.join(".")}="${value}"`] : [];
  if (value === null || typeof value !== "object") return [];
  const out: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...numericRelationshipLeaks(v, [...path, String(i)], underKey)));
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out.push(...numericRelationshipLeaks(v, [...path, k], underKey || isRelationshipKey(k)));
  }
  return out;
}

export function assertNoNumericRelationshipFields(projections: Record<string, unknown>): void {
  const leaks = Object.entries(projections).flatMap(([name, p]) => numericRelationshipLeaks(p, [name]));
  if (leaks.length) throw new Error(`numeric relationship value(s) in a structured player projection: ${leaks.slice(0, 5).join(", ")}`);
}
