/**
 * Pure id/slug humanization for PLAYER-FACING prose. No I/O — just string/regex work — so it lives
 * in the domain and is importable by BOTH the engine adapters (the NPC-voicing path) AND the outward
 * services/surfaces (the player's own reads), without either crossing the Vault-Wall arch boundary
 * (`src/domain/**` is dependency-free and importable everywhere; `src/adapters/**` is not — audit
 * R4-03 / C-01). The adapter module `src/adapters/engine/humanize.ts` now re-exports from here.
 *
 * Two transforms, both Vault-free (they only tidy machine tokens the engine interpolated into
 * otherwise-public prose — names are public roster facts, slugs are internal plumbing):
 *   - `humanizeIds`  : raw entity ids (`player` / `npc:3`) → public houseguest names.
 *   - `tidyPathwaySlugs` : neutralize internal pathway/diffusion slugs that should never appear in
 *                          player-facing text (`overheard:offscreen:alliance:1:594987875`, a gossip
 *                          drift suffix like ` · more or less#754`).
 */

/**
 * Turn raw loop-event prose (which interpolates entity ids like `player` / `npc:3`) into
 * player-facing text by substituting each id with its public name.
 *
 * Audit A8: the player's id is the bare English word `player` (`domain/ids.ts`), so a naive
 * `string.split(id).join(name)` mangles the ordinary words "player"/"players" that appear in
 * beat prose — the live repro was *"the veto Quinn Vales are drawn … the final Quinn Vale"*.
 * The cure is to replace each id only as a WHOLE TOKEN: an id is bounded by characters that
 * cannot be part of an id (id chars are word chars plus `:`), so "players" (a word char follows
 * the `player` token) is never touched, while a genuine `player` / `npc:3` reference is.
 *
 * Longest ids first so a short id can never clobber part of a longer one (e.g. `npc:1` inside
 * `npc:15`) — redundant with the token boundary, kept as defence in depth.
 */
export function humanizeIds(content: string, entities: ReadonlyArray<{ id: string; name: string }>): string {
  return makeIdHumanizer(entities)(content);
}

/**
 * A bare-word id (e.g. the player's `player`) collides with an ordinary English word, so resolving it
 * blindly mangles dictionary prose (audit #845: a deep-profile goal "outlast every player" became
 * "outlast every <name>"). The whole-token boundary already protects the PLURAL ("players"), but the
 * SINGULAR dictionary word is spelled identically to the id. The reliable discriminator: an engine-
 * interpolated id is never preceded by an English DETERMINER — beat prose interpolates a bare
 * `${player}` ("player wins…", "the vote is read: player"), never "the player" / "every player".
 * So a bare-word id directly following a determiner is the ordinary word and is left alone.
 */
const DETERMINERS: ReadonlySet<string> = new Set([
  "a", "an", "the", "every", "each", "this", "that", "these", "those", "my", "your", "his", "her",
  "its", "our", "their", "no", "any", "some", "one", "another", "per", "which", "whichever", "many",
  "few", "several", "both", "either", "neither", "all",
]);
/**
 * #927 — the FUNCTION WORDS that legitimately INTRODUCE a person reference in engine beat prose: the
 * small, closed set of verbs/prepositions/conjunctions the season loop interpolates a bare `${player}`
 * directly after ("…evicts player", "…nominates A and player", "votes for player", "wins over player",
 * "uses the veto on player"). A genuine engine-interpolated person id is preceded ONLY by a sentence
 * boundary (nothing) or one of these; it is NEVER the HEAD of a compound noun. The dictionary word
 * "player" in a vocation / strategy phrase ("poker player", "social player", "the strongest player")
 * is preceded by a CONTENT modifier (an adjective/noun) — which is, by construction, NOT in this set.
 * So a bare-word id whose preceding word is a real word that is NEITHER a boundary NOR an introducer is
 * the common noun and is left alone (this widens the #845 determiner-only guard, which let "poker
 * player" through). English's function-word vocabulary is finite and stable, so this set is durable;
 * a NEW beat template that interpolates the bare player id after a novel verb must add that verb here
 * (the humanize unit test, covering BOTH "evicts player" → resolves and "poker player" → not, is the
 * guard). The whole-token boundary still protects the plural "players" independently.
 */
const ID_INTRODUCERS: ReadonlySet<string> = new Set([
  // beat verbs that take a PERSON object (from src/engine/liveSeason.ts content templates:
  // "evicts ${evictee}", "nominates ${a} and ${b}", "votes for ${voted}", "saves ${x}", …).
  "evict", "evicts", "evicted", "evicting", "name", "names", "named", "nominate", "nominates",
  "nominated", "nominating", "vote", "votes", "voted", "save", "saves", "saved", "beat", "beats",
  "join", "joins", "tell", "tells", "told",
  // prepositions / conjunctions that directly precede a person reference in beat prose
  // ("votes for X", "uses the veto on X", "wins over X", "A and B", "X with/without/against Y").
  "for", "on", "over", "to", "with", "without", "against", "and", "or", "nor",
  // the staged-vote reading "the vote is read: player" — `precedingWord` lands on "read".
  "read",
]);
/** Is this id a plain alphabetic word (no `:`), i.e. dictionary-collision-prone (the `player` case)? */
function isBareWordId(id: string): boolean {
  return /^[a-z]+$/i.test(id);
}
/** The word immediately before `offset` in `content`, lowercased — "" if at the start. */
function precedingWord(content: string, offset: number): string {
  const before = content.slice(0, offset);
  const m = /([A-Za-z]+)[^A-Za-z]*$/.exec(before);
  return m ? m[1]!.toLowerCase() : "";
}
/**
 * #927/#845 — should a matched BARE-WORD id (the `player` collision) be left as the ordinary English
 * word rather than resolved to a name? Yes when the preceding word marks it as a common noun:
 *   - it directly follows an English DETERMINER ("every player", "a player", "this player" — #845); OR
 *   - it follows ANY other real content word that is NOT a function-word introducer ("poker player",
 *     "social player", "the strongest player" — #927: the head of a compound noun).
 * It is resolved (a genuine person id) only at a clause boundary (no preceding word) or directly after
 * a known ID_INTRODUCER (a beat verb / preposition / conjunction). Colon-bearing ids never reach here.
 */
function bareWordIdIsCommonNoun(content: string, offset: number): boolean {
  const prev = precedingWord(content, offset);
  if (prev === "") return false;            // clause/content start → a genuine interpolated person id
  // ORW-916: a list comma or a sentence/clause stop between the previous word and the id ("npc:7, player fall behind", "5 remain. player quietly slips out") makes the id a list item or a sentence opener, not the head of a compound
  // noun: the previous word belongs to ANOTHER phrase. Without this the player's own place in a round line was left as the raw word "player".
  const gap = /[A-Za-z]+([^A-Za-z]*)$/.exec(content.slice(0, offset));
  if (gap && /[,;.!?\n]/.test(gap[1]!)) return false;
  if (DETERMINERS.has(prev)) return true;   // "the/a/every player" → the ordinary word (#845)
  return !ID_INTRODUCERS.has(prev);         // a content modifier ("poker player") → common noun (#927)
}

/**
 * Build a REUSABLE id→name substituter for a fixed roster. The matcher compiles ONCE (a single
 * alternation regex over all ids) and then applies to many strings — the hot player-projection path
 * cleans the whole growing event log per commit, so re-compiling 16 per-id regexes per event was a
 * dominant per-season cost (CPU-profiled). The output is byte-identical to the prior per-id loop:
 *
 *   - longest id first in the alternation ⇒ a short id can never match inside a longer one
 *     (`npc:1` never clobbers `npc:15`) — the same guarantee the prior longest-first sort gave;
 *   - the same `(?<![\w:]) … (?![\w:])` whole-token boundary, so the word "players" is never touched;
 *   - one left-to-right scan with non-overlapping matches reproduces the sequential `replace` result —
 *     names carry no id tokens, so an earlier substitution can never create a new match (same as before).
 *
 * #845/#927: a bare-word id (the `player` collision) is ADDITIONALLY required to read as a genuine
 * person reference — at a clause boundary or directly after a known function-word introducer (a beat
 * verb / preposition / conjunction). A bare id that follows a DETERMINER ("every player" — #845) or
 * any other CONTENT modifier ("poker player" / "social player" — #927, the head of a compound noun) is
 * the ordinary word and is left alone. So a real id token ("player wins…", "the vote is read: player",
 * "npc:1 evicts player") still resolves while a dictionary phrase never does. Colon-bearing ids
 * (`npc:3`) are unaffected — they never collide with a word — so common content is byte-identical.
 */
export function makeIdHumanizer(
  entities: ReadonlyArray<{ id: string; name: string }>,
): (content: string) => string {
  if (entities.length === 0) return (content) => content;
  const byId = new Map<string, string>();
  for (const e of entities) byId.set(e.id, e.name);
  // Longest id first so the alternation prefers the longer token at any position (matches the prior sort).
  const alternation = [...entities]
    .sort((a, b) => b.id.length - a.id.length)
    .map((e) => e.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const re = new RegExp(`(?<![\\w:])(?:${alternation})(?![\\w:])`, "g");
  return (content) =>
    content.replace(re, (m, offset: number) => {
      // A bare-word id used as a common noun (after a determiner OR a content modifier) is the
      // ordinary English word — skip it ("every player" #845; "poker player" #927).
      if (isBareWordId(m) && bareWordIdIsCommonNoun(content, offset)) return m;
      return byId.get(m) ?? m;
    });
}

/**
 * Neutralize internal pathway/diffusion SLUGS that must never reach player-facing prose. These are
 * machine tokens the knowledge/gossip layer interpolates into a pathway or (when a slug is built
 * into content) into the content itself — not anything the player should read raw (audit R4-03):
 *
 *  - colon-delimited pathway slugs that survived into content, e.g. `overheard:offscreen:alliance:1:594987875`
 *    — collapsed to a calm prose gloss ("something they half-overheard").
 *  - the gossip drift suffix `distort()` appends, ` · more or less#754` — dropped (it is bookkeeping
 *    for diffusion provenance, not narration).
 *
 * Pure and idempotent; runs AFTER `humanizeIds` (so any ids inside a slug are gone first).
 *
 * #844 — robust to two breadcrumb-scrub strandings, independent of call order: an OPTIONAL leading
 * colon run before the keyword is consumed too (so an upstream pass that stripped the keyword's
 * sibling can't leave a dangling `via :…`), and the leftover-colon sweep at the end drops any orphan
 * `:token` machine fragment a partial slug left behind. Idempotent under repeated application.
 */
/**
 * PV2 (#997) — a GRADED, decaying vocabulary for how clearly a surfaced belief landed, from its [0,1]
 * confidence. The overhear/gossip layer (presence.ts / gossip.ts) already computes a real, decaying
 * confidence (per-hop decay, the partial-overhear discount), but the surfacing PREFIX rendered it flat
 * ("muffled" every time, and a brittle scrub even gutted the source word to "(, muffled)"). This maps
 * the confidence to a clarity word so a season's surfacings READ as graded — a near-certain whisper
 * ("clearly") vs. a third-hand, half-decayed rumor ("barely"). Pure, Vault-free (a word, never a
 * number), and bounded: out-of-range input clamps. The thresholds are coarse on purpose (this is
 * texture, not telemetry).
 */
export function confidenceWord(confidence: number): string {
  const c = Math.max(0, Math.min(1, confidence));
  if (c >= 0.75) return "clearly";
  if (c >= 0.55) return "mostly";
  if (c >= 0.4) return "muffled";
  if (c >= 0.25) return "faintly";
  return "barely";
}

/**
 * #1789 — map gossip FACT chain HOP count to a provenance WORD for the player-facing texture.
 * The word reflects chain length ONLY (how many mouths it passed through), NEVER which NPCs are
 * in the chain. hops < 2 returns an empty string (the rendered prefix is absent — the fact did
 * not diffuse far enough). Bounded: out-of-range input clamps via Math.max + Math.floor.
 */
export function provenanceWord(hops: number): string {
  const h = Math.max(0, Math.floor(hops));
  if (h < 2) return "";
  if (h === 2) return "second-hand";
  if (h === 3) return "third-hand";
  return "everyone's saying";
}

/**
 * PV2 (#997) — render the OVERHEAR surfacing prefix from real belief state instead of the flat literal.
 * The presence layer stores an overhear as `(overheard, muffled) <fragment>…` — `(overheard, muffled)`
 * is a MACHINE SENTINEL kept byte-stable so the knowledge layer's content-lineage anchor
 * (`InMemoryKnowledgeService.normalizeContent` strips exactly that literal) still recovers the clean
 * fragment. At DISPLAY time we upgrade the sentinel to a graded, never-empty source clause:
 *   - the SOURCE word `overheard` is always preserved (so a row never renders as `(, …)` — the #997
 *     regression where a bare-keyword strip gutted it); and
 *   - the flat `muffled` becomes a clarity word GRADED by how much of the scene was caught (the
 *     fragment length is the in-content clarity proxy the render can see — a longer caught fragment
 *     was heard more clearly), so a season's overhears read as varied, not one repeated "muffled".
 * Pure and idempotent: only the literal sentinel is rewritten; an already-graded prefix or any other
 * text is left untouched.
 */
export function humanizeOverhearPrefix(content: string): string {
  return content.replace(/\(overheard,\s*muffled\)\s*([^]*?)(…|$)/, (_m, frag: string, tail: string) => {
    // Clarity proxy: how much of the scene was caught. The presence overhear keeps ~60% of the source
    // (PRESENCE.overhearFraction) then truncates with an ellipsis; a longer caught fragment ⇒ a clearer
    // catch. Map the caught length to a confidence band, then to a clarity word. Coarse on purpose.
    const caught = frag.trim();
    const conf = caught.length >= 80 ? 0.75 : caught.length >= 45 ? 0.55 : caught.length >= 22 ? 0.4 : 0.25;
    return `(overheard, ${confidenceWord(conf)}) ${caught}${tail}`;
  });
}

export function tidyPathwaySlugs(content: string): string {
  let out = humanizeOverhearPrefix(content);
  // The gossip drift marker: " · <drift phrase>#<digits>" (from src/engine/gossip.ts `distort`).
  out = out.replace(/\s*·\s*[^·#]*#\d+/g, "");
  // A bare pathway slug that leaked into content: `overheard:…`/`offscreen:…`/`told-by:…`/`gossip:…`
  // followed by colon-joined machine tokens. Consume any leading-colon run (`:*`) too — a stranded
  // colon from an upstream keyword strip would otherwise survive as `via :…`. Replace with a gloss.
  out = out.replace(
    /:*\b(?:overheard|offscreen|told-by|gossip|surfaced)(?::[\w:-]+)+/gi,
    "something they half-overheard",
  );
  // Mop up an ORPHAN machine fragment a partial upstream strip left: a colon-led run of machine
  // tokens (`:evt:surface:42`) that no longer has its keyword prefix. Never matches ordinary prose
  // (a leading `:` then colon-joined `[\w-]` tokens is not natural text), so it can only catch slug
  // debris. Leaves real time/score colons (`9:30`, `2:1`) alone — those are not colon-LED.
  out = out.replace(/(?:^|\s):[\w-]+(?::[\w-]+)+/g, "");
  return out.trimEnd();
}

/** Humanize ids AND tidy pathway slugs in one pass — the player-facing content scrub. */
export function humanizeForPlayer(
  content: string,
  entities: ReadonlyArray<{ id: string; name: string }>,
): string {
  return makeForPlayerScrub(entities)(content);
}

/**
 * A REUSABLE player-facing content scrub for a fixed roster (`humanizeIds` then `tidyPathwaySlugs`).
 * Compile once, apply to many strings — the visible-state projection scrubs the whole event log per
 * read, so the id matcher must not recompile per event. Byte-identical to `humanizeForPlayer` per call.
 */
export function makeForPlayerScrub(
  entities: ReadonlyArray<{ id: string; name: string }>,
): (content: string) => string {
  const humanize = makeIdHumanizer(entities);
  return (content) => tidyPathwaySlugs(humanize(content));
}

/**
 * The post-season retrospective scrub (0048 — the Wall's ONE sanctioned reveal). The unsealed hidden
 * story may carry content the everyday player-facing scrub never has to handle: a COMPOUND machine id
 * (`thread:npc:8:0`) that hides an `npc:N` inside it (the whole-token `humanizeIds` deliberately skips
 * it — `npc:8` is not a whole token there), a bare `thread:…` identifier, and the thread machine slugs
 * (`[dormant]`, `surfaces via: gossip-diffused`, `goal-demands-move`, …). This scrub is for THAT surface
 * only: it resolves every id even inside a compound token, then drops/translates the remaining machine
 * scaffolding. Pure / Vault-free (names are public roster facts; slugs are internal plumbing). Idempotent.
 */
export function humanizeForRetrospective(
  content: string,
  entities: ReadonlyArray<{ id: string; name: string }>,
): string {
  let out = content;
  // 1) TRANSLATE the machine scaffolding (audit slugs + serializer labels) into readable prose FIRST —
  //    before any id resolution. Doing the labels first matters: a label like `day-1 read of player:`
  //    contains the bare word `player`, and resolving that id first would corrupt the label so it could
  //    never be matched. Each `…:` label becomes a natural clause; lifecycle/trigger/pathway slugs go.
  out = out
    // story-thread serialization
    .replace(/\bstory-thread\s*/g, "")
    .replace(/\[dormant\]/g, "(never surfaced)")
    .replace(/\[active\]/g, "(in play)")
    .replace(/\[surfaced\]/g, "(came out)")
    .replace(/\[resolved\]/g, "(played out)")
    .replace(/\[expired\]/g, "(passed)")
    .replace(/\bpremise:\s*/g, "")
    .replace(/\bsecret\s*—\s*/g, "secretly ")
    .replace(/\bweakness\s*—\s*/g, "a blind spot — ")
    .replace(/\btrue goal\s*—\s*/g, "their real game — ")
    .replace(/\btrigger:\s*/g, "")
    .replace(/\((?:on-block|nominated-twice|cornered-socially|house-tightens|goal-demands-move)\)/g, "")
    .replace(/\bsurfaces via:[^\n]*/g, "")
    // Strip the BARE thread-pathway keywords (the `surfaces via:` comma-list members) — but NOT when one
    // is the PREFIX of a colon-pathway slug (`overheard:offscreen:…`): the `(?!:)` guard leaves that slug
    // whole so the pathway collapse below glosses it cleanly, instead of stranding a dangling `:` (#844).
    // The `surfaces via:` comma-list is already removed WHOLE by the line above (`[^\n]*` eats the clause to
    // end-of-line), so a bare list member never reaches here trailed by a `,`. The only remaining `keyword,`
    // shape is the human-readable overhear PREFIX `(overheard, muffled) …` (presence.ts) — the added `,` in
    // the guard spares that display word so it is not gutted to `(, muffled)` (#997), with no regression to
    // the keyword strip.
    .replace(/\b(?:gossip-diffused|told-by-confidant|overheard|witnessed)\b(?![:,])/g, "")
    // deep-profile serialization (`deep-profile <id> | secrets: … | true-goals: … | weakness: … |
    // day-1 read of player: …`). The `day-1 read of player:` label is translated BEFORE the `player`
    // id is resolved, and the leading `deep-profile` tag is dropped (the resolved NAME leads the line).
    .replace(/\bday-1 read of player:\s*/g, "their day-one read of you — ")
    .replace(/\bdeep-profile\s+/g, "")
    .replace(/\bsecrets:\s*/g, "secretly — ")
    .replace(/\btrue-goals:\s*/g, "their real game — ")
    .replace(/\bweakness:\s*/g, "their blind spot — ")
    .replace(/\s*\|\s*/g, "; ");
  // 1b) COLLAPSE colon-pathway slugs to a calm gloss BEFORE id resolution (#844). A breadcrumb pathway
  //     like `told-by:npc:5` must be glossed while its embedded id is still a RAW token (`npc:5`) — if it
  //     resolved to a name first ("told-by:Tom Garner"), the slug regex would stop at the space and strand
  //     the surname ("…half-overheard Garner"). Collapsing first is order-robust and leaves no orphan.
  out = tidyPathwaySlugs(out);
  // 2) RESOLVE every entity id to a name.
  if (entities.length > 0) {
    const byId = new Map(entities.map((e) => [e.id, e.name] as const));
    // The retrospective unseals HIDDEN scenes (which exclude the player) + AUTHORED deep-profile prose
    // (secrets/goals/weakness), where the bare word "player" is an ordinary COMMON NOUN — the live repro
    // (#845): a goal "outlast every player" became "outlast every <name>". The player's day-1 read label
    // is already translated to "you" above, so the player's bare-word id is NEVER a legitimate subject
    // here. So id resolution is restricted to COLON-BEARING ids (`npc:3`, `thread:npc:3:0`) only — those
    // never collide with a word. Bare-word ids (`player`) are deliberately left as prose.
    const structuredEntities = entities.filter((e) => e.id.includes(":"));
    const structuredAlt = structuredEntities
      .sort((a, b) => b.id.length - a.id.length)
      .map((e) => e.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    out = humanizeIds(out, structuredEntities); // whole-token pass over colon-bearing ids only — never `player`
    if (structuredAlt) {
      // The COMPOUND machine thread identifier `thread:<npc>:<index>` is not player-readable, but it NAMES
      // a houseguest — RESOLVE the embedded id to that name and DROP the rest of the id.
      const idRe = new RegExp(`(?:${structuredAlt})`);
      out = out.replace(/\bthread:[\w:-]+/g, (tok) => {
        const m = idRe.exec(tok);
        return m ? (byId.get(m[0]) ?? "") : "";
      });
      // Any structured id still embedded in another machine token (e.g. a `deep-profile npc:3` lead).
      out = out.replace(new RegExp(`(?:${structuredAlt})`, "g"), (m) => byId.get(m) ?? m);
    }
  } else {
    // No roster to resolve against — still strip the un-player-readable bare thread identifier.
    out = out.replace(/\bthread:[\w:-]+/g, "");
  }
  // 3) The everyday pathway-slug tidy (gossip drift suffix, leaked colon-pathways), then collapse the
  //    whitespace the drops left behind.
  out = tidyPathwaySlugs(out);
  return out.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " — ").replace(/\s+([.,])/g, "$1").trim();
}

/**
 * A player-friendly label for a knowledge PATHWAY slug (audit R4-03): the raw pathway is internal
 * plumbing — `told-by:npc:3`, `overheard:offscreen:alliance:1:594987875`, `witnessed`, … — that
 * must never appear verbatim in a player-facing log. Maps the slug's KIND to calm prose and names
 * the teller (when the pathway carries one and the roster resolves it). Pure / Vault-free.
 */
export function pathwayLabel(
  pathway: string,
  entities: ReadonlyArray<{ id: string; name: string }>,
): string {
  const told = /^told-by:(.+)$/.exec(pathway);
  if (told) {
    const teller = entities.find((e) => e.id === told[1]);
    return teller ? `told by ${teller.name}` : "told by a houseguest";
  }
  if (/^overheard\b/.test(pathway)) return "overheard";
  if (/^diary-room\b/.test(pathway)) return "diary room";
  if (/^witnessed\b/.test(pathway)) return "saw it yourself";
  if (/^(gossip|origin|surfaced)\b/.test(pathway)) return "word around the house";
  // Any other slug shape: strip embedded ids/slug noise and fall back to a generic source.
  const scrubbed = humanizeForPlayer(pathway, entities);
  return /[:#]/.test(scrubbed) || scrubbed === pathway ? "around the house" : scrubbed;
}
