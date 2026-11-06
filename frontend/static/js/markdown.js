// static/js/markdown.js

/**
 * Markdown rendering and content processing utilities
 */

import uiModule from './ui.js';
import { splitTableRow } from './markdown/tableRow.js';
import { frameBatched, liveAddedElements } from './frameBatch.js';
import { replaceEmojiShortcodes, hasEmojiShortcode } from './emojiShortcodes.js';

var escapeHtml = uiModule.esc;

function safeLinkUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (url.startsWith('#')) {
    return /^#[A-Za-z0-9_-]*$/.test(url) ? url : '';
  }
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch (_) {
    return '';
  }
  return '';
}

function linkHtml(text, url) {
  const safeUrl = safeLinkUrl(url);
  const safeText = escapeHtml(text);
  if (!safeUrl) return safeText;
  if (safeUrl.startsWith('#')) {
    return `<a href="${safeUrl}" class="chat-link">${safeText}</a>`;
  }
  return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${safeText}</a>`;
}

/**
 * Sanitize the raw-HTML fragments that mdToHtml deliberately preserves from
 * the source text — <details> blocks (collapsible agent output) and <a> tags
 * (emitted by the markdown link pass). Those fragments are later restored
 * verbatim into innerHTML, so without scrubbing them a model — or any content
 * routed through here — could smuggle in an `<img onerror=...>`, an
 * `<a href="javascript:...">`, an `onmouseover=` handler, etc. and execute
 * script in the authenticated page (DOM XSS).
 *
 * Parsing into a <template> is inert: assigning to template.innerHTML neither
 * fetches resources nor runs scripts, so we can walk the resulting tree,
 * drop script-capable elements, and strip event-handler attributes and
 * dangerous URL schemes before the (now safe) fragment is handed back.
 */
const _ALLOWED_HTML_BAD_TAGS = new Set([
  'SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META',
  'STYLE', 'BASE', 'FORM', 'NOSCRIPT', 'TEMPLATE',
  // Foreign-content roots. SVG/MathML have their own parser rules and are a
  // classic mutation-XSS vehicle — e.g. an SVG-namespaced <script>, whose
  // `tagName` is the lower-case 'script' and would slip a name check that
  // assumed HTML's upper-casing. They aren't needed in the <details>/<a>
  // fragments we preserve, so drop the whole subtree.
  'SVG', 'MATH',
]);
const _ALLOWED_HTML_URL_ATTRS = new Set([
  'href', 'src', 'srcset', 'xlink:href', 'action', 'formaction', 'background', 'poster',
]);

function _compactUrlSchemeValue(value) {
  return String(value || '').replace(/[\u0000-\u0020\u007f-\u009f]+/g, '').toLowerCase();
}

function _isDangerousUrl(value) {
  return /^(javascript|vbscript|data):/.test(_compactUrlSchemeValue(value));
}

function _isDangerousSrcset(value) {
  return String(value || '').split(',').some(candidate => _isDangerousUrl(candidate));
}

function _cleanAllowedHtmlOnce(htmlString) {
  const tpl = document.createElement('template');
  tpl.innerHTML = htmlString;
  for (const el of Array.from(tpl.content.querySelectorAll('*'))) {
    // Upper-case the tag for comparison: HTML tagNames are upper-case, but
    // SVG/MathML elements preserve their original (lower/camel) case, so a
    // raw `Set.has(el.tagName)` would miss e.g. a namespaced <script>.
    if (_ALLOWED_HTML_BAD_TAGS.has(el.tagName.toUpperCase())) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      // Drop every inline event handler (onerror, onclick, onmouseover, ...)
      // and srcdoc (a frame-less script vector).
      if (name.startsWith('on') || name === 'srcdoc') {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'style') {
        const value = _compactUrlSchemeValue(attr.value);
        if (/javascript:|vbscript:|data:|expression\(/.test(value)) {
          el.removeAttribute(attr.name);
        }
        continue;
      }
      // Neutralize javascript:/vbscript:/data: in URL-bearing attributes.
      // Strip control/space chars first so e.g. "java\tscript:" can't slip by.
      if (_ALLOWED_HTML_URL_ATTRS.has(name)) {
        if (name === 'srcset' ? _isDangerousSrcset(attr.value) : _isDangerousUrl(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }
    }
  }
  return tpl.innerHTML;
}

function sanitizeAllowedHtml(html) {
  const raw = String(html == null ? '' : html);
  // Non-browser context (e.g. a future SSR/Node import): fail closed by
  // escaping rather than trusting the markup.
  if (typeof document === 'undefined') return escapeHtml(raw);

  // Sanitize to a fixpoint. Re-parsing the serialized output can mutate the
  // tree (the basis of mutation-XSS), so re-clean until it stops changing.
  let out = raw;
  for (let i = 0; i < 4; i++) {
    const next = _cleanAllowedHtmlOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Check if text has unclosed think tag
 */
export function hasUnclosedThinkTag(text) {
  text = text || '';
  const openCount =
    (text.match(/<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>/gi) || []).length
    + (text.match(/<\|channel>thought/gi) || []).length;
  const closeCount =
    (text.match(/<\/(?:think(?:ing)?|thought)>/gi) || []).length
    + (text.match(/<channel\|>/gi) || []).length;
  return openCount > closeCount;
}

export function startsWithReasoningPrefix(text) {
  return /^\s*(?:thinking(?:\s+process)?\s*:|the user |i need |i should |i will |they are |the question |i can )/i.test(text || '');
}

// L6b — plain-content reasoning leak (game build only). The model emits its
// planning as NORMAL assistant text (not a <think> block, so the think-strip
// passes miss it): operator/planning openers ("Let me…", "Looking at the
// roster", "The game state shows…", "I need to…", "I should…") and raw engine
// ids ("npc:1 - Faith Willis"). These leak engine machinery + the cast roster.
//
// A line is a reasoning/planning line when it opens with one of those operator
// phrases OR contains a raw `npc:<digits>` id (the engine's entity handle — it
// must never reach the player verbatim; the narration uses the houseguest's
// name). We drop a CONTIGUOUS run of such lines from the START of the content
// (the planning preamble), then return whatever narration follows. If the whole
// block is preamble, we return '' so the leak renders as nothing — fail-open to
// hiding (immersion is the priority). Operates on raw text BEFORE markdown.
// The application-itself meta-leak (audit 2026-06-26): the model mirrors a player's OOC software
// complaint into the fiction ("the front end is having a day", "the app froze"). Narrow alternation
// (no bare "front"/"app"/"site") so ordinary in-character prose stays untouched.
// #989 — "let me" is NOT a reasoning marker on its own: legitimate producer/GM narration opens
// with it ("Let me log that.", "Let me show you the bedroom.", "Let me give you one piece of
// advice."). A leading "let me" line is a reasoning line only when the verb that follows is a
// reasoning/meta verb ("think/check/see/look/verify/review/analyze/re-read/rewind/figure/plan/
// stay in character/…" — thinking-aloud shapes that never occur in in-character BB narration).
// Tool-PROCESS "let me" clauses ("let me call advanceGame", "let me record this interaction") are
// the SENTENCE-level scrub's jurisdiction (_MACHINERY_ASIDE_RE below), which drops only the
// offending sentence instead of the whole line. Narrow lookaheads keep social uses of the meta
// verbs alive ("let me see you out", "let me check on the others").
const _REASONING_LINE_RE = /^\s*(?:let me\s+(?:now\s+|first\s+|then\s+|also\s+|just\s+|quickly\s+)?(?:think|see(?!\s+you\b)|look|check(?!\s+(?:on|in)\b)|verify|confirm|review|analy[sz]e|assess|recall|reconsider|re-?read|re-?check|double-?check|make sure|rewind|start over|try (?:that\s+)?again|figure|parse|plan|draft|work (?:out|through)|map out|sort out|stay in character|get back in(?:to)? character)\b|looking at\b|the game state\b|i need\b|i should\b|i'll\b|i will\b|i can\b|i'm going to\b|first,? i\b|now,? i\b|the (?:roster|cast|state) (?:shows|is)\b|let's (?:see|stay)\b|okay,? (?:so|let)\b|alright,? (?:so|let)\b|so,? i\b|based on the\b|front[\s-]?end\b|the app\b|this (?:app|website|site)\b)/i;
const _RAW_NPC_ID_RE = /\bnpc:\d+\b/i;

export function scrubReasoningPreamble(text) {
  if (!text) return text;
  const lines = String(text).split('\n');
  let start = 0;
  // Skip a contiguous leading run of reasoning/planning lines (blank lines
  // inside the run are tolerated so a paragraph break doesn't end the scrub).
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { start = i + 1; continue; }
    if (_REASONING_LINE_RE.test(line) || _RAW_NPC_ID_RE.test(line)) {
      start = i + 1;
      continue;
    }
    break;
  }
  if (start === 0) return text;            // nothing scrubbed
  const rest = lines.slice(start).join('\n').replace(/^\s+/, '');
  return rest;
}

// NARR-10 (whole-body pass — game build). scrubReasoningPreamble is a *preamble*
// stripper by design: it only drops a CONTIGUOUS LEADING run, so an operator-aside
// line or a raw `npc:<id>` token that appears AFTER narration starts is never
// reached and leaks verbatim into the public bubble. This is the missing whole-body
// pass: it (a) drops any standalone line that is a pure operator/planning line
// (anywhere in the body, not just the top) and (b) redacts any raw `npc:\d+` engine
// id wherever it appears, including mid-sentence. HIGH-PRECISION — a line is only
// dropped when it OPENS with an operator phrase AND carries no quoted dialogue (a
// leading/embedded quote means it's NPC speech), so ordinary in-character prose is
// never touched. The redaction strips the bare id token (and a trailing `-`/`:`/`(`
// separator) so the houseguest's name the engine usually appends survives clean.
const _RAW_NPC_ID_GLOBAL_RE = /\bnpc:\d+\b[ \t]*(?:[-–—:(]\s*)?/gi;

// NARR-9: the OOC-aside wrap markers (mirror orwellOocAside.detectOocAside's
// contract — a WHOLE-message `((...))` wrap, or a leading `ooc:` prefix). Kept
// here as the single render engine both the live and reload paths funnel through.
const _OOC_WHOLE_WRAP_RE = /^\s*\(\(([\s\S]*?)\)\)\s*$/;
const _OOC_LEADING_PREFIX_RE = /^\s*ooc\s*:\s*/i;
// Malformed-wrap salvage (audit 2026-06-26): the model sometimes opens a reply with a `((…))`
// fragment and then continues in UNWRAPPED prose ("((Hey — you're through…)) The house is…").
// That is neither a whole-message wrap nor in-room dialogue, so the literal markers used to render
// verbatim beside the prose. When (and only when) a reply STARTS with a complete `((…))` fragment
// that is immediately followed by more non-wrapped text, strip the stray markers from that leading
// fragment and let the reply render as plain prose. Conservative: anchored to the start, requires a
// closing `))` on the SAME leading fragment, and never fires on a true whole-message wrap (handled
// above) — so balanced ((asides)) and ordinary prose are untouched.
const _OOC_LEADING_FRAGMENT_RE = /^\s*\(\(([\s\S]*?)\)\)\s*(?=\S)/;
function _salvageLeadingOocFragment(reply) {
  if (!reply || _OOC_WHOLE_WRAP_RE.test(reply)) return reply;
  return reply.replace(_OOC_LEADING_FRAGMENT_RE, (_m, inner) => (inner ? inner.trim() + ' ' : ''));
}

// #970: a SINGLE model turn may carry a leading OUT-OF-CHARACTER `((...))` block AND, after a line
// break, un-parenthesized IN-CHARACTER prose ("((You're safe this week.))\n\nThe living room hums…").
// The momentPrompts contract is "never both", so this is a model slip — but when it happens the
// renderer must SEGMENT it into TWO bubbles: a styled producer-aside bubble for the `((...))` block,
// then the trailing prose as its OWN NORMAL in-character bubble (NOT wrapped in the aside class). The
// old behavior marked the WHOLE remaining turn as an aside (_OOC_LEADING_PREFIX path) or crammed both
// into one bubble.
//
// Returns { aside, prose }: `aside` is the OOC inner text (markers stripped) ONLY when the reply
// STARTS with a COMPLETE `((...))` block that is FOLLOWED by non-empty, non-parenthesized trailing
// prose; `prose` is that trailing text. Otherwise `aside` is null and `prose` is the reply unchanged.
//
// Conservative by design — it fires ONLY on a clear leading complete block + real trailing prose:
//   · a true WHOLE-message wrap (the entire reply is `((...))`) returns { aside:null } here so the
//     caller's whole-wrap rule keeps it a SINGLE aside bubble (no regression);
//   · a reply with no leading `((` returns { aside:null } and renders byte-identically to today;
//   · the trailing remainder must itself be real prose (a non-empty tail that is NOT just another
//     `((...))` wrap), so an empty / whitespace-only / re-wrapped tail does not trigger the split.
const _OOC_LEADING_BLOCK_RE = /^\s*\(\(([\s\S]*?)\)\)([\s\S]*)$/;
function _segmentLeadingOocAside(reply) {
  if (!reply) return { aside: null, prose: reply };
  // A genuine whole-message wrap is the caller's job (single aside bubble) — never split it.
  if (_OOC_WHOLE_WRAP_RE.test(reply)) return { aside: null, prose: reply };
  const m = reply.match(_OOC_LEADING_BLOCK_RE);
  if (!m) return { aside: null, prose: reply };
  const aside = (m[1] || '').trim();
  const prose = (m[2] || '').trim();
  // Need BOTH a meaningful aside AND real trailing prose to justify two bubbles. A trailing remainder
  // that is itself just another `((...))` wrap is not in-character prose — leave it for the existing
  // salvage/whole-wrap rules rather than emitting it as a normal bubble.
  if (!aside || !prose || _OOC_WHOLE_WRAP_RE.test(prose)) return { aside: null, prose: reply };
  return { aside, prose };
}

// F-6 / N-9 (playtest blockers): an OUT-OF-CHARACTER `((...))` aside is only ever handled above when it LEADS the reply or wraps the WHOLE
// message. Anything else - an aside glued to the end of a quote, or in the middle of prose (the stacked rounds of one turn join with no
// separator, so round 2's opening `((...))` lands mid-bubble) - used to render with literal `((` / `))` markers inside the in-character bubble.
// Pull every remaining balanced `((...))` block OUT of the prose (they render as producer-aside bubbles after it) and drop any leftover
// unbalanced marker token. Pure. No aside present => the reply comes back byte-identical.
const _OOC_INLINE_RE = /\(\(([\s\S]*?)\)\)/g;
function _extractInlineOocAsides(reply) {
  if (!reply || (reply.indexOf('((') < 0 && reply.indexOf('))') < 0)) return { prose: reply, asides: [] };
  const asides = [];
  let prose = String(reply).replace(_OOC_INLINE_RE, (_m, inner) => {
    const a = (inner || '').trim();
    if (a) asides.push(a);
    return '';
  });
  // stray markers (an unbalanced open/close) never render - but only strip `))` when an opener `((` is actually present in the text, so
  // ordinary prose like "(quietly (very))" keeps its parens.
  if (reply.indexOf('((') >= 0) prose = prose.replace(/\(\(|\)\)/g, '');
  if (prose === reply) return { prose: reply, asides };
  prose = prose.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { prose, asides };
}

// F-6 (the DOUBLED reply): the anti-stale release valve / other mid-turn re-prompts can make the model answer the SAME question twice in one
// turn; the rounds stack into one bubble. A later `@[Name] ...` block that restates an earlier block by the SAME speaker - mostly covered (>= ~35% of its 8-word runs) by
// the earlier block - is the second rendition: drop it AND its untagged continuation paragraphs (the player already read the first). Paragraphs that are genuinely new are kept; blocks by
// other speakers, and text with no speaker blocks, are never touched. Pure; no restatement => the text is returned unchanged.
const _rrWords = (s) => s.toLowerCase().replace(/@\[[^\]]*\]/g, ' ').replace(/[^a-z0-9']+/g, ' ').trim().split(' ').filter(Boolean);
const _rrShingles = (w, n) => { const out = new Set(); for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' ')); return out; };
const _rrSpeakerOf = (p) => { const m = /^\s*@\[([^\]]+)\]/.exec(p); return m ? m[1].trim().toLowerCase() : null; };
// A restatement is a SUBSTANTIAL duplication: at least ~a third of this block's 8-word runs were already shown by the same speaker. One
// shared phrase in an otherwise new paragraph is NOT a restatement (the new content is kept).
const _rrRestated = (prior, sh) => {
  if (!prior || !sh.size) return false;
  let hit = 0;
  for (const s of sh) { if (prior.has(s)) hit++; }
  return hit / sh.size >= 0.35;
};
function _collapseRestatedReply(text) {
  if (!text || text.indexOf('@[') < 0) return text;
  const paras = String(text).split(/\n{2,}/);
  const seen = new Map();            // speaker -> Set of 8-word shingles already shown
  const kept = [];
  let dropped = false, skipping = false;
  for (const p of paras) {
    const sp = _rrSpeakerOf(p);
    if (!sp) { if (skipping) continue; kept.push(p); continue; }   // untagged continuation of a dropped block goes with it
    const sh = _rrShingles(_rrWords(p), 8);
    const prior = seen.get(sp);
    if (_rrRestated(prior, sh)) { dropped = true; skipping = true; continue; }
    skipping = false;
    const acc = prior || new Set();
    sh.forEach((s) => acc.add(s));
    seen.set(sp, acc);
    kept.push(p);
  }
  return dropped ? kept.join('\n\n') : text;
}

// ORW-156: the streaming renderer freezes finished paragraphs and renders the live tail on its own, so the tail cannot see the earlier
// paragraphs F-6's collapse needs (a later `@[Name]` block that restates an earlier block by the same speaker is dropped). This watch answers
// "would the whole-reply render collapse a restatement here?" for a growing, append-only text, folding each finished paragraph in ONCE (the
// per-call work is O(new text)). It mirrors _collapseRestatedReply exactly (same helpers); the still-growing last paragraph is checked but
// not folded in. Once it says yes it stays yes: the caller renders the whole reply (the pre-ORW-156 path) for the rest of that stream, which
// is always correct. A false yes only costs speed. Only the game build collapses restatements, so elsewhere it always says no.
export function createRestatementWatch() {
  const seen = new Map();
  let scanned = 0;   // text before this offset is whole paragraphs already folded into `seen`
  let prefix = '';   // text.slice(0, scanned) at the previous call (append-only check)
  let hit = false;
  const restates = (p, commit) => {
    const sp = _rrSpeakerOf(p);
    if (!sp) return false;
    const sh = _rrShingles(_rrWords(p), 8);
    if (_rrRestated(seen.get(sp), sh)) return true;
    if (commit) { const acc = seen.get(sp) || new Set(); sh.forEach((s) => acc.add(s)); seen.set(sp, acc); }
    return false;
  };
  return function wouldCollapse(text) {
    if (hit) return true;
    if (!text || text.indexOf('@[') < 0 || !gameBuildSuppressesThinking()) return false;
    if (scanned > text.length || text.slice(0, scanned) !== prefix) { seen.clear(); scanned = 0; }   // not an extension: start over
    const sep = /\n{2,}/g;
    sep.lastIndex = scanned;
    let m;
    while ((m = sep.exec(text)) !== null) {
      if (restates(text.slice(scanned, m.index), true)) { hit = true; return true; }
      scanned = m.index + m[0].length;
    }
    prefix = text.slice(0, scanned);
    if (restates(text.slice(scanned), false)) { hit = true; return true; }
    return false;
  };
}

export function redactRawIds(text) {
  if (!text) return text;
  const lines = String(text).split('\n');
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && _REASONING_LINE_RE.test(line) && !/["“]/.test(trimmed)) continue;
    kept.push(line);
  }
  // Redact any raw engine id token left in the body (keeps the trailing name).
  return kept.join('\n').replace(_RAW_NPC_ID_GLOBAL_RE, '');
}

// #1047 — tool-name / operator-aside SENTENCE scrub (game build, body only).
// The preamble + whole-body LINE passes above only drop a STANDALONE line that
// OPENS with an operator phrase. But during eviction narration the model leaked
// its tool-process talk MID-PARAGRAPH, as one clause inside otherwise-clean
// prose — "Let me call advanceGame and see what surfaces", "Let me advance the
// game", "let me walk through it". A line that mixes that clause with real
// narration is never line-dropped, so it reached the public bubble verbatim.
// This is the missing SENTENCE-level pass (mirrors the FE Python _scrub_game_leak
// in src/agent_loop.py): split the body into sentences and drop only the
// sentences that are operator/tool asides, keeping every other sentence (and its
// delimiter) byte-identical. HIGH-PRECISION — the markers (raw engine tool names,
// "let me <tool-verb>…", "advance/move/push the game", "let me walk through it")
// never occur in real in-character BB narration, so ordinary scene prose, NPC
// dialogue, and legitimate first-person in-character lines are untouched. This is
// the tactical scrub for #1047; the structural channel-split fix is tracked
// separately (Wave 3 / the retire-the-regex roadmap).
const _GAME_TOOL_WORDS = [
  'advanceGame', 'recordInteraction', 'submitDecision', 'runCompetition',
  'resolveCompetition', 'getGameState', 'gameStatus', 'markHouseguestMet',
  'updateCasting', 'createCharacter', 'surfaceInformationTo', 'npcVoice',
  'whereabouts', 'socialRead', 'makeDeal', 'getVisibleStateFor', 'moveTo',
  // ADV2-3 — the quarantined DEBUG-only Vault-unseal tool (mandate #2 / CLAUDE.md): it must
  // never even be NAMED to the player, so it gets the same raw-identifier treatment as every
  // other engine tool above.
  'producerVault',
];
// FEDEEP-3 — a machinery NOUN ("the engine/system/model/front end") only reads as an operator
// aside when it is the SUBJECT of an operator/status verb ("the engine will…", "the model
// decided…", "the system tallies…", "the front end ate…"). A bare noun match over-fired on
// ordinary in-fiction prose that merely contains the substring — "gaming the system" (the noun is
// the OBJECT of "gaming", not the subject of a following verb) and "the model houseguest" (a
// contestant archetype; "model" is followed by a noun, not a verb) both read as real leaks under
// the old bare-noun match but are legitimate narration. Requiring an operator verb immediately
// after the noun phrase keeps the real leak patterns (below) while sparing that prose.
const _MACHINERY_NOUN_VERBS = 'decided|decides|deciding|says?|said|thinks?|thought|knows?|knew|'
  + 'handles?|handled|tracks?|tracked|manages?|managed|controls?|controlled|determines?|determined|'
  + 'calculates?|calculated|tallies|tallied|is|was|were|will|would|has|had|does|did|can|could|'
  + 'ate|froze|crashed|glitche[ds]?|broke|breaks|hung|stalled|lagged|failed|fails|choked|reset|acts?|acted';
// A sentence is a machinery aside when it mentions a raw engine tool name
// ANYWHERE, OR names backstage machinery (Vault/God-Mode/admin/developer-console — ADV2-3, word
// parity with the Python _GAME_LEAK_SENTENCE_RE in src/agent_loop.py), OR carries a first-person
// operator/tool-process clause. The operator clause requires an operator VERB after the opener
// (so legitimate in-character first-person prose — "Let me show you the bedroom", "I can see the
// kitchen" — is never matched): "let me (call|advance|run|check|record|walk through|…)…",
// "I'll/I should/I need to … (record|advance|call|…)", "advance/move/push the
// game". "walk through it/this" is included (the #1047 "let me walk through it").

// ── Real-world denylist (#1784 F9) — structural defense ────────────────────
// PARITY-LOCKED with the Python _REAL_HOST_SURNAMES / _REAL_NETWORKS / _SEASON_CONTINUITY_RE.
// The narrator must NEVER name a real host, network, or real-season continuity.
// "Big Brother" is ALLOWED — it is the product's own name.
const _REAL_HOST_SURNAMES = ['Chen', 'Grodner'];
const _REAL_NETWORKS = ['CBS', 'Fox', 'ABC', 'NBC', 'MTV', 'Bravo', 'Netflix', 'Hulu'];
const _REAL_WORLD_DENY_RE = new RegExp(
  '\\b(?:' + _REAL_HOST_SURNAMES.join('|') + ')\\b'
  + '|\\b(?:' + _REAL_NETWORKS.join('|') + ')\\b'
  + '|\\bSeason\\s+\\d+\\b'
  + '|\\bBB\\s?\\d+\\b',
  'i'
);
const _MACHINERY_ASIDE_RE = new RegExp(
  '\\b(?:' + _GAME_TOOL_WORDS.join('|') + ')\\b'
  // #1109(a)/FEDEEP-3 — machinery NOUNS that never appear in in-character BB narration (parity
  // with the Python _GAME_LEAK_SENTENCE_RE in src/agent_loop.py): "the engine/system/model" + the
  // app the player runs us on ("the front end", "the app", "this app/website/site"). Narrowed to
  // require an operator-verb context (see _MACHINERY_NOUN_VERBS above) so the JS body scrub
  // catches a mid-paragraph fourth-wall leak without over-matching ordinary prose.
  + '|\\bthe (?:engine|system|model|front[\\s-]?end)\\b\\s+(?:' + _MACHINERY_NOUN_VERBS + ')\\b'
  + '|\\bthe app\\b|\\bthis (?:app|website|site)\\b'
  // ADV2-3 — Vault/God-Mode/admin/developer-console word parity with the Python scrub: these
  // backstage-machinery nouns must never reach the player, defense-in-depth alongside the
  // momentPrompts refusal instruction and the Python-side _GAME_LEAK_SENTENCE_RE.
  + '|\\bgod[\\s-]?mode\\b|\\bthe vault\\b|\\bproducer\'?s? vault\\b'
  + '|\\badmin(?:istrator)?[\\s-]+(?:panel|surface|console|mode|controls?|tools?)\\b'
  + '|\\bdeveloper (?:controls?|mode|console|tools?)\\b'
  // #1740 (F7 audit) — these subject-agnostic machinery phrasings have been in the Python-side
  // _GAME_LEAK_SENTENCE_RE (src/agent_loop.py) all along but were MISSING here, so a leak using
  // any of them sailed straight through the RENDER-LAYER scrub untouched — the actual wall (the
  // momentPrompts "NEVER NAME THE MACHINERY" ban is framing, not enforcement; this scrub is the
  // wall). No first-person subject is required for any of these — closed-set UI/board-machinery
  // nouns never occur in in-character BB narration no matter who the "speaker" is.
  + '|\\bcomp-intent\\b|\\bpending (?:decision|binding)\\b|\\bbinding (?:choice|decision)\\b'
  + '|\\b(?:decision|choice) (?:card|cards|button|buttons)\\b|\\btool call\\b|\\bjumped ahead\\b|\\bnarratively\\b'
  + '|\\brecord (?:this|the|that) (?:interaction|scene)\\b'
  // third-person player reference — momentPrompts requires "you", never "the player"/"the user"
  // (parity with the Python pattern's own trailing alternation).
  + '|\\bthe (?:player|user)\\b(?:,?\\s+\\w+,)?\\s+(?:has|is|was|will|\'ll|wants|said|finished|just|now|needs|should)\\b'
  // #989 (+ #1369 review) — the AMBIGUOUS operator verbs over-fired on legitimate narration:
  // bare "log/note" ate "Let me log that.", bare "check" ate "Let me check on the others.",
  // bare "run" ate "Let me run to the door.". Those four are machinery only when followed by an
  // ENGINE object noun ("log this interaction", "check the game state", "run the command",
  // "run the game"); the unambiguous tool-process verbs stay bare. The verb lists are
  // PARITY-LOCKED, branch for branch, with the Python _GAME_LEAK_SENTENCE_RE in
  // src/agent_loop.py — tests/test_989_letme_narration_scrub.py drives BOTH scrubs over the
  // same cases and fails on any behavioral drift.
  + '|\\blet me\\s+(?:now\\s+|first\\s+|then\\s+|also\\s+|just\\s+)?'
    + '(?:call|advance|record|resolve|use|pull|fetch|place|see what|'
    + 'walk through|re-?read|re-?check|reconsider'
    + '|run(?=\\s+(?:th(?:e|is|at)\\s+)?(?:game|competition|comp|command|tool|check|numbers|state)s?\\b)'
    + '|check(?=\\s+(?:th(?:e|is|at)\\s+)?(?:game|state|engine|roster|board|status|pending|interaction|event|beat|decision|vote)s?\\b)'
    + '|(?:log|note)(?=\\s+(?:down\\s+)?(?:th(?:e|is|at)\\s+)?'
      + '(?:interaction|event|scene|beat|consequence|decision|vote|state|move)s?\\b))\\b'
  + '|\\bi(?:\'ll|\'d| will| should| need to| have to| am going to| must| can)\\s+'
    + '(?:now\\s+|first\\s+|then\\s+|also\\s+|just\\s+)?'
    + '(?:call|advance|record|resolve|use|pull|fetch|present|place|'
    + 'walk through|re-?read|re-?check|reconsider'
    + '|run(?=\\s+(?:th(?:e|is|at)\\s+)?(?:game|competition|comp|command|tool|check|numbers|state)s?\\b)'
    + '|check(?=\\s+(?:th(?:e|is|at)\\s+)?(?:game|state|engine|roster|board|status|pending|interaction|event|beat|decision|vote)s?\\b)'
    + '|(?:log|note)(?=\\s+(?:down\\s+)?(?:th(?:e|is|at)\\s+)?'
      + '(?:interaction|event|scene|beat|consequence|decision|vote|state|move)s?\\b))\\b'
  // #1740 (F7 audit) — reasoning-off GLM-4.7 narrated its own tool-planning in the PRESENT tense
  // with no modal at all ("I check the game state now", not "I'll check…"), which the two "i"
  // branches above never catch (both require a leading modal). This is a JS-only widening (the
  // Python-side scrub has the same gap, but this render layer is THE wall — see the comment at
  // the top of this block) restricted to the four ALREADY object-noun-gated ambiguous verbs, so
  // it inherits their exact false-positive protection ("I check on the others." / "I run to the
  // door." still survive — no engine object follows) rather than bare-matching every verb.
  + '|\\bi\\s+(?:now\\s+|first\\s+|then\\s+|also\\s+|just\\s+)?'
    + '(?:run(?=\\s+(?:th(?:e|is|at)\\s+)?(?:game|competition|comp|command|tool|check|numbers|state)s?\\b)'
    + '|check(?=\\s+(?:th(?:e|is|at)\\s+)?(?:game|state|engine|roster|board|status|pending|interaction|event|beat|decision|vote)s?\\b)'
    + '|(?:log|note)(?=\\s+(?:down\\s+)?(?:th(?:e|is|at)\\s+)?'
      + '(?:interaction|event|scene|beat|consequence|decision|vote|state|move)s?\\b))\\b'
  + '|\\b(?:advance|move|push) the game\\b',
  'i',
);

// ADV2-4 — a dropped mid-run sentence can leave an orphaned `((`/`))` producer-aside delimiter
// behind (the OPEN and its CLOSE landed in different sentences, and only one of the two sentences
// was scrubbed as a machinery aside). scrubMachineryAsides is a pure sentence filter+join with no
// paren-awareness, so the stray marker would otherwise render literally in the public bubble. When
// the `((` / `))` counts disagree after the scrub, strip every literal delimiter rather than guess
// which one orphaned — the enclosed prose (if any) survives, just without the aside markup.
function _rebalanceParenAsides(text) {
  if (!text) return text;
  const opens = (text.match(/\(\(/g) || []).length;
  const closes = (text.match(/\)\)/g) || []).length;
  if (opens === closes) return text;
  return text.replace(/\(\(|\)\)/g, '');
}

export function scrubMachineryAsides(text) {
  if (!text) return text;
  // Split keeping the sentence/line delimiter with each part so kept prose is
  // byte-identical. A leading quote means the sentence is NPC speech, not an
  // operator aside — protect it (mirrors redactRawIds' quoted-dialogue guard).
  //
  // #1740 (F7 audit) — the trailing `(?![.!?])` keeps a RUN of terminal punctuation ("...", "?!",
  // "!!!") glued to the sentence it closes instead of splitting after every individual character.
  // Without it, an ellipsis-separated leak like "I call `getGameState`... `whereabouts`..." split
  // into a machinery fragment PLUS several bare "." fragments; the bare dots matched no machinery
  // pattern, so they survived the filter and the player saw a literal "......" trail where the
  // dropped tool names used to be — itself a broken, telling artifact. Gluing the whole punctuation
  // run to its sentence means the ENTIRE unit (words + trailing "...") drops together, leaving no
  // debris. A legitimate dramatic-pause ellipsis is unaffected either way (nothing in it is dropped,
  // so it rejoins byte-identically regardless of how many pieces it was split into).
  const parts = String(text).split(/(?<=[.!?\n])(?![.!?])/);
  const kept = parts.filter((part) => {
    const trimmed = part.trim();
    if (!trimmed) return true;
    if (/^["“]/.test(trimmed)) return true;
    return !_MACHINERY_ASIDE_RE.test(part);
  });
  // Collapse any double-space / stray blank-run left by a dropped mid-paragraph
  // sentence so the surrounding prose reads clean (never merges across lines).
  const joined = kept.join('').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n');
  return _rebalanceParenAsides(joined);
}

/**
 * Real-world denylist scrub (#1784 F9) — structural defense.
 * Drops sentences that name a real host, network, or real-season continuity.
 * "Big Brother" is ALLOWED — the product's own name.
 * Behavior: SCRUB-AND-CONTINUE (drops the offending sentence, keeps the rest).
 * PARITY-LOCKED with Python _scrub_game_leak's denylist block.
 */
export function scrubRealWorldDeny(text) {
  if (!text) return text;
  const parts = text.split(/(?<=[.!?\n])/);
  return parts.filter(p => {
    // Real host surnames — word-boundary check so "chen" in "kitchen" never matches
    for (const host of _REAL_HOST_SURNAMES) {
      const rx = new RegExp('\\b' + host + '\\b', 'i');
      if (rx.test(p)) return false;
    }
    // Real network names — word-boundary check
    for (const net of _REAL_NETWORKS) {
      const rx = new RegExp('\\b' + net + '\\b', 'i');
      if (rx.test(p)) return false;
    }
    // Season continuity
    if (_REAL_WORLD_DENY_RE.test(p)) return false;
    return true;
  }).join('');
}

export function normalizeThinkingMarkup(text) {
  if (!text) return text;
  let normalized = text;
  normalized = normalized.replace(/<thought(\s+[^>]*)?>/gi, (_m, attrs = '') => `<think${attrs || ''}>`);
  normalized = normalized.replace(/<\/thought>/gi, '</think>');
  normalized = normalized.replace(/<\|channel>thought\s*\n?([\s\S]*?)<channel\|>\s*/gi, (_m, content = '') => {
    const thought = String(content || '').trim();
    return thought ? `<think>${thought}</think>\n` : '';
  });
  normalized = normalized.replace(/<\|channel>response\s*\n?([\s\S]*?)<channel\|>/gi, (_m, content = '') => content || '');
  normalized = normalized.replace(/<\|channel>response\s*\n?/gi, '');
  normalized = normalized.replace(/<channel\|>/gi, '');
  return normalized;
}

function normalizePlainThinking(text) {
  if (!text) return text;
  text = normalizeThinkingMarkup(text);
  if (/<think/i.test(text)) return text;

  const trimmed = text.trimStart();
  if (!startsWithReasoningPrefix(trimmed)) return text;

  const replyStarts = [
    'Hey', 'Hi ', 'Hi!', 'Hello', 'Sure', 'Yes', 'No ', 'No,', 'Yo', 'OK',
    'Here', 'Absolutely', 'Of course', 'Great', 'Alright', 'Thanks', 'Welcome',
    'Good ', "I'm happy", "I'd be"
  ];
  const prefixRegex = /^(thinking(?:\s+process)?\s*:)\s*/i;
  const escapedReplyStarts = replyStarts.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const boundaryRegex = new RegExp(
    `^([\\s\\S]*?)(\\n\\n(?=${escapedReplyStarts.join('|')}|I |What|Let|This |As ))[\\s\\S]*$`,
    'i'
  );
  const boundaryMatch = boundaryRegex.exec(trimmed);

  if (boundaryMatch) {
    const thinkBlock = boundaryMatch[1].replace(prefixRegex, '').trim();
    const reply = trimmed.slice(boundaryMatch[1].length).trimStart();
    if (thinkBlock && reply) return `<think>${thinkBlock}</think>\n\n${reply}`;
  }

  const lines = trimmed.split('\n');
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (replyStarts.some((prefix) => line.startsWith(prefix))) {
      const thinkBlock = lines.slice(0, index).join('\n').replace(prefixRegex, '').trim();
      const reply = lines.slice(index).join('\n').trim();
      if (thinkBlock && reply) return `<think>${thinkBlock}</think>\n${reply}`;
    }
  }

  const withoutPrefix = trimmed.replace(prefixRegex, '');
  for (const prefix of replyStarts) {
    const rx = new RegExp(`[.!?]\\s*(${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`);
    const match = rx.exec(withoutPrefix);
    if (match && match.index > 20) {
      const thinkBlock = withoutPrefix.slice(0, match.index + 1).trim();
      const reply = withoutPrefix.slice(match.index + 1).trim();
      if (thinkBlock && reply) return `<think>${thinkBlock}</think>\n${reply}`;
    }
  }

  return text;
}

/**
 * Extract all complete thinking blocks and remaining content
 */
export function extractThinkingBlocks(text) {
  // Handle malformed patterns: <think></think>\n...actual thinking...\n</think>
  // Some models emit an empty <think></think> then put thinking text outside,
  // closed by a second orphaned </think>.
  let normalized = normalizePlainThinking(text);
  // Collapse <think>short</think>...real thinking...</think> into one block
  // Models sometimes emit a trivial first block then continue thinking outside tags
  normalized = normalized.replace(/<think(?:ing)?(?:\s+[^>]*)?>.{0,30}<\/think(?:ing)?>\s*([\s\S]*?)<\/think(?:ing)?>/gi, (m, content) => {
    return '<think>' + content.trim() + '</think>';
  });

  // Merge consecutive <think> blocks (some models split thinking across multiple tags)
  normalized = normalized.replace(/<\/think(?:ing)?>\s*<think(?:ing)?(?:\s+[^>]*)?>/gi, '\n\n');

  // Extract thinking time attribute if present
  const timeMatch = normalized.match(/<think(?:ing)?\s+time="([\d.]+)"/i);
  const thinkingTime = timeMatch ? timeMatch[1] : null;
  // Strip time attribute for content extraction
  normalized = normalized.replace(/<think(?:ing)?\s+time="[\d.]+"/gi, '<think');

  const thinkRegex = /<think(?:ing)?(?:\s+[^>]*)?>([\s\S]*?)<\/think(?:ing)?>/gi;
  const thinkingBlocks = [];
  let match;

  // Extract all complete thinking blocks
  while ((match = thinkRegex.exec(normalized)) !== null) {
    const content = match[1].trim();
    if (content) thinkingBlocks.push(content);
  }

  // Remove all complete <think>/<thinking> blocks
  let cleanContent = normalized.replace(thinkRegex, '');

  // If there's an unclosed tag, decide between two cases:
  // (a) Stray opener at the very start with no real reply before it — typical
  //     of quantized models (MiniMax-AWQ) that emit a literal `<think>` token
  //     at the start of every reply without ever closing it. Strip just the
  //     opener and keep the body as the reply, otherwise the bubble looks
  //     blank on reload (the body was being treated as collapsed thinking).
  // (b) Cut-off mid-generation — there's already real reply text before the
  //     opener. Drop from the tag onward as before (it's truncated thinking).
  if (hasUnclosedThinkTag(normalized)) {
    const gemmaThoughtStart = cleanContent.search(/<\|channel>thought/i);
    if (gemmaThoughtStart >= 0) {
      const leakedThought = cleanContent
        .slice(gemmaThoughtStart)
        .replace(/^<\|channel>thought\s*\n?/i, '')
        .trim();
      if (gemmaThoughtStart === 0 && leakedThought) thinkingBlocks.push(leakedThought);
      cleanContent = cleanContent.slice(0, gemmaThoughtStart);
    } else {
      const strayOpener = cleanContent.match(/^\s*<think(?:ing)?(?:\s+[^>]*)?>([\s\S]*)$/i);
      if (strayOpener) {
        cleanContent = strayOpener[1];
      } else {
        cleanContent = cleanContent.replace(/<think(?:ing)?(?:\s+[^>]*)?>[\s\S]*$/gi, '');
      }
    }
  }

  // Handle orphaned </think> with no opening tag — text before it is leaked thinking
  const orphanMatch = cleanContent.match(/^([\s\S]+?)<\/think(?:ing)?>/i);
  if (orphanMatch && orphanMatch[1].trim()) {
    thinkingBlocks.push(orphanMatch[1].trim());
    cleanContent = cleanContent.slice(orphanMatch[0].length);
  }

  // Strip any remaining orphaned closing tags
  cleanContent = cleanContent.replace(/<\/think(?:ing)?>/gi, '');

  // Merge all thinking blocks into one — no reason to show multiple dropdowns
  const mergedBlocks = thinkingBlocks.length > 1
    ? [thinkingBlocks.join('\n\n')]
    : thinkingBlocks;

  return {
    thinkingBlocks: mergedBlocks,
    content: cleanContent.trim(),
    thinkingTime,
  };
}

/**
 * Create a collapsible thinking section
 */
function createThinkingSection(thinkingContent, index = 0, thinkingTime = null) {
  const id = `thinking-${Date.now()}-${index}`;
  const timeHtml = thinkingTime ? `<span class="thinking-timer" style="font-size:11px;opacity:0.4;font-variant-numeric:tabular-nums;">${thinkingTime}s</span>` : '';
  // M2-7 — diegetic rename in the game build: the reasoning accordion reads as the show's
  // "Production notes" (matching the beat-chip register in orwellToolBeats.js), never the debug
  // "View thinking process". Admin/operator (non-game) surfaces keep the technical wording.
  const label = _inGameBuild() ? 'Production notes' : 'View thinking process';
  return `
    <div class="thinking-section">
      <div class="thinking-header" data-thinking-id="${id}" role="button" tabindex="0" aria-expanded="false" aria-controls="${id}">
        <div class="thinking-header-left">
          <span>${label}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          ${timeHtml}
          <span class="thinking-toggle" id="${id}-toggle"></span>
        </div>
      </div>
      <div class="thinking-content" id="${id}">
        <div class="thinking-content-inner">
          ${mdToHtml(thinkingContent)}
        </div>
      </div>
    </div>
  `;
}

/**
 * Process text and render with thinking sections
 */
// ── Emoji → monochrome SVG (OpenMoji-black via same-origin /api/emoji proxy) ──
// Replace colorful system/Twemoji emoji with single-color line icons tinted to
// the surrounding text color (project rule: never colorful emoji). Operates on
// rendered HTML: only touches text outside tags and skips <code>/<pre>.
const _EMOJI_RE = /\p{Extended_Pictographic}/u;
const _emojiSeg = (typeof Intl !== 'undefined' && Intl.Segmenter)
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

function _emojiCodepoints(emoji) {
  // Twemoji filename rule: strip U+FE0F unless the sequence has a ZWJ (U+200D).
  const s = emoji.indexOf('‍') >= 0 ? emoji : emoji.replace(/️/g, '');
  const cps = [];
  for (const ch of s) { const c = ch.codePointAt(0); if (c) cps.push(c.toString(16)); }
  return cps.join('-');
}
function _emojiImg(emoji) {
  const code = _emojiCodepoints(emoji);
  if (!code) return emoji;
  // Monochrome line icon: the OpenMoji black SVG is used as a CSS mask filled
  // with the surrounding text color (currentColor), so emoji render as a single
  // theme-tinted line glyph — never colorful (project rule). If the proxy can't
  // supply the glyph it returns a transparent SVG, so the mask shows nothing.
  return `<span class="emoji" role="img" aria-label="${emoji}" style="--em:url('/api/emoji/${code}.svg')"></span>`;
}
function _svgifyText(text) {
  if (!_emojiSeg) return text;
  let out = '';
  for (const { segment } of _emojiSeg.segment(text)) {
    out += _EMOJI_RE.test(segment) ? _emojiImg(segment) : segment;
  }
  return out;
}
/** When "Text-only Emojis" is on, keep Unicode in HTML so deEmojify() can strip them. */
function _useSvgEmoji() {
  return typeof document === 'undefined' || !document.body?.classList.contains('text-emojis');
}

// `opts.shortcodes` (default true) controls the issue-#345 `:name:` → emoji
// expansion. Chat passes it through as true; document/email body renderers pass
// false so author-typed `:shortcode:` text stays literal (see mdToHtml callers).
// The Unicode-emoji → monochrome-SVG pass always runs regardless, so a real 😀
// in a document still renders as the themed line icon as it always has.
export function svgifyEmoji(html, opts) {
  if (!_useSvgEmoji() || !html) return html;
  const allowShortcodes = !opts || opts.shortcodes !== false;
  // Two reasons to walk the HTML: real Unicode emoji to turn into SVG icons,
  // or `:shortcode:` text the model emitted instead of an emoji (issue #345).
  const hasUnicode = _EMOJI_RE.test(html);
  const hasShortcode = allowShortcodes && hasEmojiShortcode(html);
  if (!hasUnicode && !hasShortcode) return html;
  const parts = html.split(/(<[^>]*>)/);   // odd indices = tags
  let codeDepth = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const t = parts[i].toLowerCase();
      if (/^<(pre|code)[\s>]/.test(t)) codeDepth++;
      else if (/^<\/(pre|code)\s*>/.test(t)) codeDepth = Math.max(0, codeDepth - 1);
      continue;
    }
    if (codeDepth !== 0) continue;
    let seg = parts[i];
    // Expand shortcodes to Unicode first, then both they and any pre-existing
    // Unicode emoji get rendered as the same monochrome line icons below.
    if (hasShortcode) seg = replaceEmojiShortcodes(seg);
    if (_EMOJI_RE.test(seg)) seg = _svgifyText(seg);
    parts[i] = seg;
  }
  return parts.join('');
}
/**
 * Generic collapsible section that reuses the thinking-dropdown styling and its
 * delegated toggle (any `.thinking-header[data-thinking-id]`). The label drives
 * the "View <label>" / "Hide <label>" text via data-label. Used e.g. for the
 * vision-model image description on a user's photo message.
 */
export function createCollapsible(contentMarkdown, label = 'details') {
  const id = `collapse-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const safeLabel = escapeHtml(label);
  return `
    <div class="thinking-section">
      <div class="thinking-header" data-thinking-id="${id}" role="button" tabindex="0" aria-expanded="false" aria-controls="${id}">
        <div class="thinking-header-left"><span data-label="${safeLabel}">View ${safeLabel}</span></div>
        <div style="display:flex;align-items:center;gap:6px;"><span class="thinking-toggle" id="${id}-toggle"></span></div>
      </div>
      <div class="thinking-content" id="${id}"><div class="thinking-content-inner">${mdToHtml(contentMarkdown)}</div></div>
    </div>`;
}

/**
 * Game build — the player-facing bubble must carry ONLY the in-character
 * narration: never the model's reasoning, drafts, or self-corrections ("let me
 * rewind that"). Historically the game build dropped reasoning entirely; the
 * owner ruling (2026-06-20) is to bring it BACK as a condensed, default-collapsed
 * "Thinking" accordion — debug-viewable now, hidden by default — while the public
 * bubble stays clean. Reasoning carries no Vault/secret state (the model only
 * ever receives Vault-free context), so showing it collapsed for debug is safe.
 *
 * Two gates:
 *   - gameBuildShowsThinkingAccordion() — render the collapsed accordion (the
 *     default in the game build). The legacy `body.hide-thinking` /
 *     `data-hide-thinking` operator opt-out fully suppresses it (CSS also hides
 *     `body.hide-thinking .thinking-section`).
 *   - gameBuildSuppressesThinking() — whether to SCRUB reasoning OUT of the
 *     public reply text. This stays TRUE for the game build regardless of the
 *     accordion: reasoning that bled into plain content is routed to the
 *     accordion / dropped, never rendered as narration. `data-show-thinking`
 *     (admin) keeps the old "show everything inline" behavior off the game path.
 */
function _inGameBuild() {
  try {
    return typeof document !== 'undefined' && !!document.body &&
      document.body.hasAttribute('data-game-build');
  } catch (_) {
    return false;
  }
}

export function gameBuildSuppressesThinking() {
  try {
    if (!_inGameBuild()) return false;
    // Admin-only escape hatch: explicitly opt back in to seeing reasoning inline
    // (the legacy non-game render path, reasoning interleaved with the reply).
    if (document.body.hasAttribute('data-show-thinking')) return false;
    return true;
  } catch (_) {
    // Fail closed (to scrubbing) — never leak reasoning because a check threw.
    return true;
  }
}

/**
 * Should the game build render the model's reasoning in a collapsed "Thinking"
 * accordion (separate from the clean public bubble)? Default ON in the game
 * build; an operator may hide it with `body.hide-thinking` /
 * `data-hide-thinking`. Fail-closed to HIDING the accordion if a check throws.
 */
export function gameBuildShowsThinkingAccordion() {
  try {
    if (!_inGameBuild()) return false;
    if (document.body.classList.contains('hide-thinking')) return false;
    if (document.body.hasAttribute('data-hide-thinking')) return false;
    return true;
  } catch (_) {
    return false;
  }
}

// FEDEEP-2 — chat.js caches the MERGED stream buffer (`accumulated`, deltas from BOTH the reply
// and reasoning channels) into `holder.dataset.raw` and hands it to `addAITTSButton` for read-
// aloud, so a reasoning/machinery leak that bled into plain content (the exact L6b/NARR-10/#1047
// leaks `processWithThinking`'s public-reply branch already scrubs) would otherwise be persisted
// verbatim into the DOM cache and be read aloud — even though the rendered bubble stays clean.
// Runs the SAME reply-side scrub chain `processWithThinking` applies to the public bubble
// (scrubReasoningPreamble → redactRawIds → scrubMachineryAsides). Game build only: outside it,
// `processWithThinking` never scrubs the reply either, so `dataset.raw`/TTS legitimately keep the
// full merged text (debug/general-assistant builds), and a well-formed `<think>` block's own
// content is untouched by these line/sentence-level passes (they only match operator-phrase
// lines/sentences, never the tag markers themselves).
export function scrubMachineryForPersistence(text) {
  if (!text) return text;
  if (!gameBuildSuppressesThinking()) return text;
  let cleaned = String(text);
  cleaned = (scrubReasoningPreamble(cleaned) || '').trim();
  cleaned = (redactRawIds(cleaned) || '').trim();
  cleaned = (scrubMachineryAsides(cleaned) || '').trim();
  cleaned = (scrubRealWorldDeny(cleaned) || '').trim();
  return cleaned;
}

// ── M3-2 · Speaker-attributed dialogue (the microformat) ──────────────────────────────
//
// This INVERTS the raw-id scrub above. Today the ONLY way a houseguest's engine handle can
// appear in narration is the bare `npc:<id>` token, which is machinery and is redacted
// (redactRawIds). M3-2 adds a SANCTIONED, well-formed speaker tag the narrator may emit to
// attribute a spoken line to a houseguest — the interface turns it into that person's face
// (an OrwellMonogram chip) in the bubble gutter beside the line. Malformed / unsanctioned raw
// ids still scrub exactly as before; this is purely additive to the scrub layer.
//
// THE MICROFORMAT (see the momentPrompts speaker-tag instruction): a LINE-LEADING
//   @[Full Name]
// — an at-sign, the houseguest's EXACT public roster name in square brackets — immediately
// followed by their words on the same line. Design properties:
//   · Vault-free: it carries only the PUBLIC name the player already sees (never a raw id,
//     never hidden state), so the chip is keyed by public identity alone.
//   · Markdown-safe: it has no `(...)`, so the markdown link pass never touches it; and we
//     extract it to an inert `___OWSPK_N___` placeholder BEFORE any markdown/scrub pass and
//     restore the chip AFTER mdToHtml, so no transform can mangle it.
//   · Streaming-safe: only a COMPLETE `@[…]` transforms. A tag split across chunks arrives as a
//     trailing partial (`@[Fai`) which is swallowed until it completes — fail open, no flash of
//     raw markup, no broken chip.
//   · Fail-open: an untransformed tag (mid-line, a non-game build, the reasoning accordion)
//     degrades to the plain houseguest name in mdToHtml (never a dead link, never literal
//     brackets); absent tags render exactly as today's prose.
//
// The BODY channel only: extraction/restore run inside processWithThinking's public-reply
// branch (and the mdToHtml degrade is universal) — the reasoning channel is never touched.

// A COMPLETE, line-leading sanctioned tag. `m` flag so `^` is per line; the name is 1..80
// visible chars (no `]`/newline). An optional `(npc:<id>)` id-bearing form is tolerated for
// robustness (a caller/tool that already holds the id gets an exact cross-surface hue match),
// but the narrator is instructed to use the name-only form.
const _SPEAKER_TAG_RE = /^([ \t]*)@\[([^\]\n]{1,80})\](?:\(npc:(\d+)\))?[ \t]*:?[ \t]*/gm;
// A trailing INCOMPLETE tag at the very end of the (streaming) buffer: `@[` with no closing
// `]` yet. A complete `@[Name]` always carries a `]`, so this only ever matches a partial.
const _SPEAKER_TRAILING_PARTIAL_RE = /@\[[^\]\n]{0,80}$/;

// #1638 fallback — the narrator makes the `@[Name]` tag OPTIONAL and in real play reliably
// writes its own house style instead: a line-leading BOLD name — `**Full Name** does
// something.` / `**Full Name:** "quote"` — with no sanctioned tag at all, so the chip
// machinery above never fires. This recognizes that natural pattern too, but stays
// deliberately narrow: it is a STYLING addition, never a rewrite (ADR 0005 — normalizing
// creative prose is out of bounds). Unlike `_SPEAKER_TAG_RE`, which consumes the tag
// syntax entirely (it IS machinery, not prose), this only ever PREPENDS a placeholder ahead
// of the bold run — the `**Name**`/`**Name:**` text the model wrote is never touched, so the
// visible sentence is byte-identical apart from the added gutter chip. `m` flag so `^` is
// per line, matching `_SPEAKER_TAG_RE`'s anchor; the inner name is captured separately from
// an optional trailing colon (inside OR outside the closing `**`) purely for the roster-match
// check below — group 2 (`boldRun`) is what actually gets kept in the output, verbatim. NO
// trailing `[ \t]*` here (unlike `_SPEAKER_TAG_RE`, which deliberately swallows the tag's
// trailing whitespace because the tag itself is discarded) — the whitespace AFTER the bold
// run is real prose (the space before "leans against the counter…") and must stay in the
// unmatched remainder untouched, or it silently vanishes from the rendered sentence.
const _SPEAKER_BOLD_LINE_RE = /^([ \t]*)(\*\*([^*\n]{1,80}?)\*\*:?)/gm;

function _speakerInitials(name) {
  try {
    if (typeof window !== 'undefined' && window.OrwellMonogram && window.OrwellMonogram.initialsFor) {
      return window.OrwellMonogram.initialsFor(name);
    }
  } catch (_) { /* fall through to the local computation */ }
  const w = String(name || '?').trim().split(/\s+/).filter(Boolean);
  let ini = '?';
  if (w.length === 1) ini = w[0].slice(0, 2).toUpperCase();
  else if (w.length > 1) ini = (w[0][0] + w[w.length - 1][0]).toUpperCase();
  return ini.replace(/[&<>"']/g, '').trim() || '?';
}

// The monogram SEED. Prefer an explicit id (id-bearing form). Otherwise, if the page exposes a
// name→id resolver (the cast roster), use the real houseguest id so the chip's tile matches
// that person's face on every other surface (cast window, decision cards). Absent both — the
// isolated render-contract test, or before the roster loads — the public NAME is a stable,
// deterministic seed. Never throws.
function _resolveSpeakerSeed(id, name) {
  if (id) return id;
  try {
    if (typeof window !== 'undefined' && typeof window.orwellResolveHouseguestId === 'function') {
      const r = window.orwellResolveHouseguestId(name);
      if (r) return r;
    }
  } catch (_) { /* seed by name */ }
  return name;
}

// #1638 — is `name` an EXACT (case/whitespace-insensitive) live-roster houseguest name? Reuses
// the SAME `window.orwellResolveHouseguestId` roster resolver `_resolveSpeakerSeed` already
// calls for the sanctioned-tag path (see orwellMonogram.js's `cardFor`, which looks the trimmed
// lower-cased name up in the roster cache — no fuzzy/partial matching). Deliberately
// conservative: absent a roster (headless, cold cache, no game) this always fails closed
// (returns false), so the natural-bold-name fallback below never fires without a real,
// confirmed roster match — a plain `**bold**` that happens not to be a houseguest's name
// renders exactly as it always has. Never throws.
function _isKnownRosterName(name) {
  try {
    if (typeof window !== 'undefined' && typeof window.orwellResolveHouseguestId === 'function') {
      return !!window.orwellResolveHouseguestId(name);
    }
  } catch (_) { /* fail closed — not a confirmed roster name */ }
  return false;
}

// The gutter-chip CSS, injected once (mirrors OrwellMonogram.ensureCss). No-op headless.
function ensureSpeakerCss() {
  try {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.getElementById('ow-speaker-css')) return;
    const s = document.createElement('style');
    s.id = 'ow-speaker-css';
    s.textContent =
      // ORW-141 — the speaker line is ordinary flowing text indented past a gutter, with the
      // chip absolutely positioned IN that gutter. It must NOT be a flex container: as one,
      // every text run and every inline element of the paragraph (<em>, <strong>, a link)
      // became its own flex item, i.e. its own side-by-side column, and a short italic word
      // was squeezed into a sliver ("as / se / ssi / ng") — seen live in the 11-06 playtest.
      // The gutter width matches .ow-speaker-cont below (chip width + .5rem).
      '.ow-speaker-line{position:relative;padding-left:calc(1.7em + .5rem);min-height:1.84em;}' +
      '.ow-speaker-line>.ow-speaker-chip{position:absolute;left:0;top:.14em;}' +
      // ORW-140 — the visible name that follows a consumed @[Name] tag's chip.
      '.ow-speaker-name{font-weight:700;}' +
      '.ow-speaker-chip{flex:0 0 auto;display:inline-flex;width:1.7em;height:1.7em;' +
        'border-radius:50%;overflow:hidden;position:relative;vertical-align:middle;' +
        'box-shadow:0 1px 2px rgba(0,0,0,.35);}' +
      '.ow-speaker-chip .ow-mono-face{width:100%;height:100%;}' +
      '.ow-speaker-chip-ini{display:flex;align-items:center;justify-content:center;' +
        'width:100%;height:100%;font:800 .62em/1 system-ui,-apple-system,sans-serif;' +
        'background:#274a54;color:#e6f2f5;letter-spacing:-.02em;}' +
      // #1323 — a multi-paragraph speech: every sibling <p> that continues the same speaker's
      // line (no re-tag needed — see _extendSpeakerContinuations) gets the SAME left padding as
      // the dialogue column beside the gutter chip (chip width + the flex gap), so the whole
      // speech reads as one person talking instead of just its opening line.
      '.ow-speaker-cont{padding-left:calc(1.7em + .5rem);}';
    (document.head || document.documentElement).appendChild(s);
  } catch (_) { /* CSS is a nicety; never let it break the render */ }
}

// The chip HTML for one speaker. OWN-8: portraits are PRIMARY — the chip resolves the
// houseguest's REAL persisted portrait from the kit's shared roster cache (#1324, keyed by the
// seed: the sanctioned id form, or the name resolved to an id via orwellResolveHouseguestId)
// and renders the designed OrwellMonogram tile only as the no-photo fallback; falls back to a
// monochrome initials tile headless / when the kit is absent so the chip never blanks.
// Vault-free: keyed by public id/name only; the portrait is the same public roster ref every
// cast surface renders. Evicted keeps the L16 grayscale rule; photos take the kit's tight
// face-weighted small-avatar crop (ow-mono-crop).
function _speakerChipHtml(id, name) {
  const nm = String(name || '').trim();
  const safe = escapeHtml(nm || '?');
  let face = '';
  try {
    if (typeof window !== 'undefined' && window.OrwellMonogram && window.OrwellMonogram.svg) {
      // svg() (unlike face()) does NOT inject the monogram CSS, and the `.ow-mono-face
      // .ow-mono-svg` sizing rules live there — on a fresh transcript where no cast/decision
      // surface has loaded it yet, the SVG would render unsized. Ensure it here.
      if (typeof window.OrwellMonogram.ensureCss === 'function') window.OrwellMonogram.ensureCss();
      const seed = _resolveSpeakerSeed(id, nm);
      const cached = (typeof window.OrwellMonogram.portraitFor === 'function')
        ? window.OrwellMonogram.portraitFor(seed) : null;
      if (cached && cached.portrait) {
        const ev = cached.status === 'evicted' ? ' ow-mono-evicted' : '';
        face = `<span class="ow-mono-face ow-mono-crop${ev}">`
          + `<img src="${escapeHtml(String(cached.portrait))}" alt="" loading="lazy"></span>`;
      } else {
        face = `<span class="ow-mono-face">${window.OrwellMonogram.svg({ id: seed, name: nm })}</span>`;
      }
    }
  } catch (_) { face = ''; }
  if (!face) face = `<span class="ow-speaker-chip-ini">${escapeHtml(_speakerInitials(nm))}</span>`;
  const idAttr = id ? ` data-hg-id="${escapeHtml(String(id))}"` : '';
  return `<span class="ow-speaker-chip"${idAttr} data-hg-name="${safe}" title="${safe}" `
    + `aria-label="${safe}" role="img">${face}</span>`;
}

// CodeRabbit fix: the speaker pass below runs on RAW markdown (before mdToHtml extracts fenced
// blocks — see the file-header note above), so a roster name inside a ```fenced``` or 4-space/
// tab-INDENTED code line (an example transcript, a quoted format sample) could otherwise get
// chip-ified and corrupt the eventual `<pre><code>` render. Builds the set of zero-based line
// indices that fall inside either kind of code region so both speaker passes below can skip
// them, preserving detection in ordinary prose. A lone fence line toggling state counts as code
// itself (never a speaker line). A plain ``` (no lang) or ~~~ fence both count, mirroring common
// Markdown practice even though mdToHtml's own fence-extraction only handles backticks.
const _CODE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

// CodeRabbit follow-up: delimiter-AWARE, per CommonMark's actual closing rule — a fence only
// closes on a marker using the SAME character with a run length >= the OPENING run's length. A
// naive "any ``` or ~~~ line toggles" reading (the prior shape here) closes early on a tilde
// marker quoted INSIDE a backtick fence (or a ``` example quoted inside a ```` fence), resuming
// speaker extraction while still genuinely inside the code block.
function _codeLineIndices(text) {
  const lines = String(text).split('\n');
  const codeLines = new Set();
  let inFence = false;
  let fenceChar = null;
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = _CODE_FENCE_RE.exec(lines[i]);
    if (!inFence) {
      if (m) {
        codeLines.add(i);
        fenceChar = m[1][0];
        fenceLen = m[1].length;
        inFence = true;
        continue;
      }
      if (/^(?: {4}|\t)/.test(lines[i]) && lines[i].trim()) codeLines.add(i);
      continue;
    }
    // Inside a fence: every line counts as code, including a would-be marker that doesn't
    // qualify to close it (retain the opening delimiter + run length; close only on the SAME
    // character with an equal-or-longer run, followed by NOTHING but whitespace — per
    // CommonMark a CLOSING fence takes no info string, so "```js" inside an open block is a
    // quoted example, not a close; treating it as one would resume speaker extraction while
    // still genuinely inside the code block).
    codeLines.add(i);
    if (m && m[1][0] === fenceChar && m[1].length >= fenceLen
        && lines[i].slice(lines[i].indexOf(m[1]) + m[1].length).trim() === '') {
      inFence = false;
      fenceChar = null;
      fenceLen = 0;
    }
  }
  return codeLines;
}

// The zero-based line index containing a given character offset into `str` (counts `\n` up to
// offset). Used to test a regex match's position against `_codeLineIndices` above.
function _lineIndexAtOffset(str, offset) {
  let idx = 0;
  for (let i = 0; i < offset; i++) if (str.charCodeAt(i) === 10) idx++;
  return idx;
}

// Extract every complete, line-leading sanctioned speaker tag, replacing it with an inert
// `___OWSPK_N___` placeholder (so downstream scrubs + mdToHtml can't mangle it) and returning
// the parsed {id, name} chips in order. Also swallows a trailing INCOMPLETE tag so a tag split
// across stream chunks never flashes raw markup (fail open until it completes). Pure.
export function extractSpeakerTags(text) {
  if (!text) return { text: text, chips: [] };
  const chips = [];
  const codeLines = _codeLineIndices(text);
  const src = String(text);
  let out = src.replace(_SPEAKER_TAG_RE, (_m, lead, name, id, offset) => {
    if (codeLines.has(_lineIndexAtOffset(text, offset))) return _m;  // fenced/indented code — never chip-ify
    const nm = String(name || '').trim();
    if (!nm) return _m;                    // `@[]` — not a real speaker; leave it for the scrub
    const i = chips.length;
    // ORW-140 — the tag is machinery and is consumed, but the NAME is not: narrators use the tag
    // as the sentence's subject ("@[Natalia Reed] stands near the memory wall…"), so swallowing
    // it left subject-less sentences ("stands near the memory wall…"). Owner ruling (Kevin,
    // 11-06): complete sentences in all cases. restoreSpeakerChips renders the name as visible
    // text after the chip (`showName`), unless the narrator already wrote the name right after
    // the tag (e.g. `@[Name] **Name** grins`), and keeps a `:` the tag swallowed (`colon`).
    const after = src.slice(offset + _m.length, offset + _m.length + nm.length + 4)
      .replace(/^[*_]+/, '').toLowerCase();
    chips.push({
      id: id ? 'npc:' + id : null,
      name: nm,
      showName: !after.startsWith(nm.toLowerCase()),
      colon: /:[ \t]*$/.test(_m),
    });
    return (lead || '') + '___OWSPK_' + i + '___ ';
  });
  // A dangling partial tag at the very end of a streaming buffer renders as nothing until the
  // next delta closes it. (A complete tag was already replaced above, so this is only a partial.)
  out = out.replace(_SPEAKER_TRAILING_PARTIAL_RE, '');
  // #1638 — SECOND pass, over text with sanctioned tags already swallowed above: a
  // line-leading BOLD houseguest name in the model's own natural house style
  // (`**Full Name** does something.` / `**Full Name:** "quote"`) instead of the sanctioned
  // `@[Name]` tag. Exact live-roster match only (`_isKnownRosterName` — never fuzzy, never
  // partial, and fails closed with no roster loaded), line-leading only (the same `^`/`m`
  // anchor as `_SPEAKER_TAG_RE`, so a mid-sentence bold mention never matches), and the
  // placeholder is INSERTED ahead of the bold run rather than consuming it — the `**Name**`/
  // `**Name:**` markdown the model wrote is kept byte-for-byte, so this only ever ADDS a
  // gutter chip and never rewrites/normalizes the prose (ADR 0005). A line already replaced
  // by the sanctioned-tag pass above starts with a placeholder, not `**`, so it can never
  // double-match here — the two paths are mutually exclusive per line.
  out = out.replace(_SPEAKER_BOLD_LINE_RE, (m, lead, boldRun, nameRaw, offset) => {
    if (codeLines.has(_lineIndexAtOffset(out, offset))) return m;  // fenced/indented code — never chip-ify
    const nm = String(nameRaw || '').trim().replace(/:$/, '').trim();
    if (!nm || !_isKnownRosterName(nm)) return m; // not a confirmed roster name — untouched
    const i = chips.length;
    chips.push({ id: null, name: nm });
    return (lead || '') + '___OWSPK_' + i + '___ ' + boldRun;
  });
  // OWN-8b — anchor a DETACHED attribution to its speech. The narrator sometimes emits the tag
  // ALONE on its own line (a blank line between the tag and the quote, or the tag trailing the
  // quote); mdToHtml then wraps the lone placeholder as its own paragraph and the face chip
  // rendered as a disc floating BETWEEN prose blocks instead of in the speech's gutter. Join a
  // tag-only line FORWARD onto the next non-empty line (the speech it introduces); a tag-only
  // line at the very END anchors BACKWARD, leading the paragraph it attributes. A tag with
  // same-line dialogue (the sanctioned form — placeholder followed by text, not a newline) is
  // untouched, so every existing render is byte-identical.
  out = out.replace(/(___OWSPK_\d+___)[ \t]*\n\s*(?=\S)/g, '$1 ');
  out = out.replace(/(^|\n)([^\n]*\S[^\n]*)\n\s*(___OWSPK_\d+___)[ \t]*$/g,
    (_m, brk, prev, ph) => brk + ph + ' ' + prev);
  return { text: out, chips };
}

// Void/self-closing elements a top-level scan may meet — no matching close tag to hunt for.
const _SPEAKER_SCAN_VOID_TAGS = new Set(['hr', 'br', 'img', 'input', 'meta', 'link']);

// #1323 — a lightweight, non-recursive top-level block scanner over an HTML string. It does NOT
// parse the document tree; it only needs to answer, in order, "is the next top-level thing a
// <p> (and does it already carry ow-speaker-line), or is it something else (a list, blockquote,
// heading, rule, table, code block…)?" so restoreSpeakerChips can extend the gutter treatment to
// a run of sibling <p>s without ever descending into e.g. a blockquote's OWN inner <p>s (which
// are opaque relative to this pass — treated as one "other" block). Fails open: an unbalanced/
// unrecognized tag just consumes to the end of the string as a single "other" block, which can
// only ever under-apply the continuation treatment, never mis-attribute one speaker's chip to
// another's text.
function _scanTopLevelBlocks(html) {
  const nodes = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const wsMatch = /^\s+/.exec(html.slice(i));
    if (wsMatch) { i += wsMatch[0].length; continue; }
    const tagMatch = /^<([a-zA-Z][\w-]*)\b[^>]*>/.exec(html.slice(i));
    if (!tagMatch) {
      // Stray non-whitespace text with no leading tag (rare from mdToHtml output) — opaque, so
      // it still correctly breaks a continuation run. Consume to the next '<' or end of string.
      const rest = html.slice(i);
      const nextLt = rest.indexOf('<', 1);
      nodes.push({ kind: 'other' });
      i += (nextLt === -1 ? rest.length : nextLt);
      continue;
    }
    const tagName = tagMatch[1].toLowerCase();
    const openTag = tagMatch[0];
    const openStart = i;
    const openEnd = i + openTag.length;
    if (_SPEAKER_SCAN_VOID_TAGS.has(tagName) || openTag.endsWith('/>')) {
      nodes.push({ kind: 'other' });
      i = openEnd;
      continue;
    }
    const closeIdx = html.toLowerCase().indexOf('</' + tagName, openEnd);
    const blockEnd = closeIdx === -1 ? n : (html.indexOf('>', closeIdx) + 1);
    if (tagName === 'p') {
      nodes.push({
        kind: 'p',
        openStart,
        openEnd,
        isSpeakerLine: /class\s*=\s*"[^"]*\bow-speaker-line\b[^"]*"/.test(openTag),
      });
    } else {
      nodes.push({ kind: 'other' });
    }
    i = blockEnd > openStart ? blockEnd : openEnd; // safety against zero-progress
  }
  return nodes;
}

// #1323 — the root cause: the narrator tags only the FIRST line of a speaker's speech (by
// design — see momentPrompts.ts's SPEAKER TAGS rule, "ONE tag per line" bounds a single line's
// tag, it does not require re-tagging every line of a continued quote). This extends the gutter
// indent from an ow-speaker-line <p> to the run of immediately-following sibling <p>s so a
// multi-paragraph speech reads as one person talking, not just its opening line.
//
// The run stops at, and does NOT cross:
//   · another ow-speaker-line <p> (a new speaker's tag) — with one exception: the single
//     untagged <p> immediately adjacent to that new tag is EXCLUDED from the run. Design
//     choice: a plain paragraph that hands off directly into the next speaker's tag reads as
//     narration BETWEEN speeches (e.g. "Across the room, Marcus scoffs." right before
//     @[Marcus Chen] speaks) rather than a continuation of the speaker before it, so it renders
//     flush-left/unindented like ordinary narration.
//   · any non-<p> top-level block (a list, blockquote, heading, rule, table, code block…) — the
//     indent deliberately does not reach into those; they degrade gracefully by rendering
//     unindented, exactly as before this fix.
//   · the end of the message.
// Idempotent: only ow-speaker-line <p>s (already carrying the placeholder-derived class) start a
// run, and a continuation <p> is only ever marked, never re-scanned as a fresh start — a second
// pass over already-processed HTML finds the same speaker lines and produces the same runs.
//
// ORW-156 `ctx` (streaming only; omitted everywhere else, which is the unchanged behaviour): the streaming renderer renders a reply in
// pieces (frozen paragraphs + the live tail), so a speech can cross a piece boundary. `ctx.runOpen` says a speech is still open where this
// piece starts (its leading untagged <p>s continue it); `ctx.handOff` says the block right after this piece is a NEW speaker line (so a run
// reaching this piece's end is stopped there, and its last paragraph is the hand-off). `ctx.runOpenAtEnd` is set to whether a speech is
// open at this piece's end, for the next piece. Each piece then carries exactly the classes the whole-reply render gives it.
function _extendSpeakerContinuations(html, ctx) {
  const nodes = _scanTopLevelBlocks(html);
  const handOffAtEnd = !!(ctx && ctx.handOff);
  const markRun = (start) => {
    const run = [];
    let j = start;
    while (j < nodes.length && nodes[j].kind === 'p' && !nodes[j].isSpeakerLine) {
      run.push(j);
      j++;
    }
    const stoppedByNewSpeaker = j < nodes.length ? (nodes[j].kind === 'p' && nodes[j].isSpeakerLine) : handOffAtEnd;
    if (stoppedByNewSpeaker && run.length) run.pop(); // the hand-off paragraph stays unindented
    for (const k of run) nodes[k].continuation = true;
  };
  if (ctx && ctx.runOpen) markRun(0); // a speech carried in from the frozen text before this piece
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].kind !== 'p' || !nodes[i].isSpeakerLine) continue;
    markRun(i + 1);
  }
  if (ctx) {
    let open = !!ctx.runOpen;
    for (const node of nodes) {
      if (node.kind !== 'p') open = false;
      else if (node.isSpeakerLine) open = true;
    }
    ctx.runOpenAtEnd = open;
  }
  let out = html;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.kind === 'p' && node.continuation) {
      out = out.slice(0, node.openStart) + '<p class="ow-speaker-cont">' + out.slice(node.openEnd);
    }
  }
  return out;
}

// Restore `___OWSPK_N___` placeholders (from extractSpeakerTags) into face chips in a rendered
// HTML string. A placeholder that mdToHtml wrapped as its own paragraph becomes a flex speaker
// line (chip in the gutter, dialogue beside it), and the treatment extends to the rest of that
// same speech (see _extendSpeakerContinuations); any other leftover placeholder gets an inline
// chip. Pure apart from the one-time CSS injection.
//
// ORW-156 `ctx` (streaming only; see _extendSpeakerContinuations): `{ runs: 'skip' }` renders WITHOUT the continuation pass (the streaming
// cut check compares structure; the speech classes are given to each piece through the context instead); `{ runOpen, handOff }` renders
// one piece of a reply in its speech context and reports `runOpenAtEnd`. No `ctx` = the unchanged whole-reply render.
export function restoreSpeakerChips(html, chips, ctx) {
  const sctx = ctx && typeof ctx === 'object' && ctx.runs !== 'skip' ? ctx : null;
  if (!html || !chips || !chips.length) {
    // no speaker line in this piece, but a speech carried in from the frozen text before it still continues into its paragraphs
    if (sctx) {
      if (html && sctx.runOpen) return _extendSpeakerContinuations(html, sctx);
      sctx.runOpenAtEnd = !html && !!sctx.runOpen;
    }
    return html;
  }
  ensureSpeakerCss();
  const chipFor = (i) => {
    const c = chips[+i];
    if (!c) return '';
    // ORW-140 — a consumed sanctioned tag gives its name back as visible text after the chip,
    // so the sentence it started stays complete. Bold-name-pass chips (#1638) never set
    // showName: their `**Name**` is still in the prose.
    const label = c.showName
      ? `<strong class="ow-speaker-name">${escapeHtml(String(c.name || '').trim())}</strong>${c.colon ? ':' : ''} `
      : '';
    return _speakerChipHtml(c.id, c.name) + label;
  };
  let out = String(html).replace(
    /<p>(\s*)___OWSPK_(\d+)___[ \t]*/g,
    (_m, _ws, i) => `<p class="ow-speaker-line">${chipFor(i)}`);
  if (!(ctx && typeof ctx === 'object' && ctx.runs === 'skip')) out = _extendSpeakerContinuations(out, sctx);
  // Fallback: any placeholder mdToHtml did NOT wrap in its own <p> (a list item, an inline
  // position) gets a bare inline chip so the tag never renders as raw text.
  out = out.replace(/___OWSPK_(\d+)___[ \t]*/g, (_m, i) => chipFor(i));
  return out;
}

// ORW-156 `ctx` (optional; only the streaming renderer passes it, every other caller renders the whole reply exactly as before):
//   { runs: 'skip' }                 render without the speech-continuation pass (the streaming cut check compares structure only);
//   { runOpen, lookahead }           render one PIECE of a reply in its speech context: `runOpen` = a speech is open where this piece starts,
//                                    `lookahead` = the complete block right after it ('' = the piece ends the text). Sets `ctx.runOpenAtEnd`.
export function processWithThinking(text, ctx) {
  const sctx = ctx && typeof ctx === 'object' && ctx.runs !== 'skip' ? ctx : null;
  if (sctx) {
    // the piece's last speech paragraph is a hand-off exactly when the next block starts a new speaker line
    sctx.handOff = !!sctx.lookahead && /^\s*<p class="ow-speaker-line"/.test(processWithThinking(sctx.lookahead, { runs: 'skip' }));
    sctx.runOpenAtEnd = !!sctx.runOpen; // nothing below renders a speaker paragraph: the speech state passes through unchanged
  }
  const { thinkingBlocks, content, thinkingTime } = extractThinkingBlocks(text);

  // Game build: the public bubble shows ONLY the clean reply; the reasoning goes
  // to a separate, default-collapsed accordion (or is dropped if the operator
  // hid it). Either way, scrub any reasoning that bled into plain CONTENT so no
  // reasoning/draft/"rewind" text ever reaches the public bubble.
  if (gameBuildSuppressesThinking()) {
    let reply = content;
    // M3-2: pull any sanctioned line-leading speaker tags (`@[Name]`) OUT to inert
    // `___OWSPK_N___` placeholders FIRST — before scrubReasoningPreamble / redactRawIds,
    // which key on `npc:<id>` and would otherwise mangle a tag's optional id (and could drop
    // a leading tagged line as a "reasoning" line). The chips are restored on the rendered
    // HTML below. A bare/malformed raw id is untouched here and still scrubs as today.
    let spk = { text: reply, chips: [] };
    if (reply) {
      // F-6: drop a second rendition of the same speaker's answer BEFORE the tags become inert chips.
      reply = _collapseRestatedReply(reply);
      spk = extractSpeakerTags(reply);
      reply = spk.text;
      const stripped = normalizePlainThinking(reply);
      if (/<think/i.test(stripped)) {
        reply = (extractThinkingBlocks(stripped).content || '').trim();
      }
      // L6b belt-and-suspenders: even a FINAL narration round can carry a
      // plain-content reasoning preamble (operator openers / raw npc:<id> ids)
      // that never got tagged as thinking — scrub it before render so engine
      // machinery + the cast roster never reach the player.
      reply = (scrubReasoningPreamble(reply) || '').trim();
      // NARR-10: the preamble scrub only catches a LEADING run. A mid-body
      // operator aside or a raw npc:<id> echoed from a tool result survives it,
      // so run the whole-body pass too (drop standalone operator lines anywhere,
      // redact raw ids everywhere). Belt-and-suspenders, content channel only.
      reply = (redactRawIds(reply) || '').trim();
      // #1047: the line passes above only drop a STANDALONE operator line. A
      // tool-process clause MID-PARAGRAPH ("Let me call advanceGame and see what
      // surfaces", "Let me advance the game", "let me walk through it") rides
      // inside otherwise-clean prose and survives them — run the sentence-level
      // machinery-aside scrub so it never reaches the public bubble.
      reply = (scrubMachineryAsides(reply) || '').trim();
      reply = (scrubRealWorldDeny(reply) || '').trim();
    }
    // NARR-9: the GM marks an OUT-OF-CHARACTER answer by wrapping its WHOLE reply
    // in `((...))` (the momentPrompts contract). The reload renderer reclassifies
    // it (chatRenderer detectOocAside) but the LIVE stream did not, so the player
    // read literal double-parens mid-turn. Detect the full wrap here — the single
    // render engine both paths share — strip the markers, and emit the reply inside
    // a styled producer-aside wrapper so it reads as a quiet word to production, not
    // a spoken-in-room line. Only a WHOLE-message wrap qualifies (never a heuristic
    // guess on free narration); mirrors orwellOocAside.detectOocAside's contract.
    let oocAside = false;
    // #970: a single turn that LEADS with a complete `((...))` OOC block and then carries
    // un-parenthesized in-character prose must render as TWO bubbles — a styled producer-aside for
    // the block, then the prose as its own NORMAL bubble. Try that split FIRST; if it fires, `reply`
    // becomes the trailing prose (rendered normally) and `leadingAsideText` holds the aside content.
    // A true whole-message wrap returns no split (aside:null) and falls through to the whole-wrap
    // rule below, so it stays a SINGLE aside bubble (no regression).
    let leadingAsideText = null;
    if (reply) {
      const seg = _segmentLeadingOocAside(reply);
      if (seg.aside) { leadingAsideText = seg.aside; reply = seg.prose; }
    }
    if (reply && !leadingAsideText) {
      const m = reply.match(_OOC_WHOLE_WRAP_RE);
      if (m && (m[1] || '').trim()) { reply = m[1].trim(); oocAside = true; }
      else if (_OOC_LEADING_PREFIX_RE.test(reply)) {
        reply = reply.replace(_OOC_LEADING_PREFIX_RE, '').trim();
        oocAside = true;
      } else {
        // Salvage a malformed leading `((…))` fragment followed by unwrapped prose so the
        // stray markers never render verbatim (renders as plain producer prose, not an aside).
        reply = _salvageLeadingOocFragment(reply);
      }
    }
    // F-6 / N-9: any balanced `((...))` still inside the prose (mid-reply or glued to the end of a quote) is an out-of-character aside that
    // leaked into the in-character bubble: pull it out (it renders as its own producer-aside bubble AFTER the prose) and drop stray markers.
    let inlineAsides = [];
    if (reply && !oocAside) {
      const ex = _extractInlineOocAsides(reply);
      reply = ex.prose;
      inlineAsides = ex.asides;
    }
    // Prepend the reasoning accordion (collapsed by default), then the clean
    // reply. The accordion is debug-only chrome; it never touches the reply text.
    //
    // B6: the accordion holds the model's PRIVATE chain-of-thought, already walled from the
    // fiction body (the public reply above is what gets the full reasoning/machinery scrub).
    // It is opt-in, default-collapsed debug chrome and is deliberately ALLOWED to discuss
    // mechanics — the P1 owner ruling keeps it, and the reasoning/public split (browser_smoke)
    // is what proves lever/'rewind' talk stays OUT of the bubble but IS held here. So we must
    // NOT run the line-dropping / sentence-dropping body scrubs (redactRawIds /
    // scrubMachineryAsides) on it — those would empty a mechanics-heavy reasoning block and
    // vanish the accordion entirely. The ONE surgical cleanup that is safe (never empties
    // content) is redacting a bare `npc:<id>` engine token to nothing so the raw id doesn't
    // show; the human-readable name the engine usually appends survives. Pure token replace —
    // no line/sentence dropping.
    let gbHtml = '';
    if (gameBuildShowsThinkingAccordion()) {
      thinkingBlocks.forEach((block, index) => {
        if (!block || !block.trim()) return;
        const cleanedBlock = block.replace(_RAW_NPC_ID_GLOBAL_RE, '');
        if (cleanedBlock.trim()) gbHtml += createThinkingSection(cleanedBlock, index, thinkingTime);
      });
    }
    // #970: emit the leading OOC block as its OWN styled aside bubble, THEN the in-character prose
    // as a separate normal bubble below it. Both halves go through mdToHtml (the prose already ran
    // the machinery/reasoning scrubs above), so reasoning can never reach either public bubble.
    if (leadingAsideText) {
      // M3-2: restore any speaker chips extracted from inside the leading OOC block too, so a
      // `___OWSPK_N___` placeholder can never surface literally in the aside bubble. No-op when
      // the aside carried no tags.
      gbHtml += `<div class="ooc-producer-aside">${restoreSpeakerChips(mdToHtml(leadingAsideText), spk.chips)}</div>`;
    }
    if (reply) {
      // M3-2: restore the extracted speaker tags into face chips on the rendered HTML — a
      // `___OWSPK_N___` placeholder mdToHtml wrapped as its own paragraph becomes a flex
      // speaker line (chip in the gutter beside the dialogue). No-op when there were no tags.
      const replyHtml = restoreSpeakerChips(mdToHtml(reply), spk.chips, ctx);
      gbHtml += oocAside ? `<div class="ooc-producer-aside">${replyHtml}</div>` : replyHtml;
    }
    for (const a of inlineAsides) {
      gbHtml += `<div class="ooc-producer-aside">${restoreSpeakerChips(mdToHtml(a), spk.chips)}</div>`;
    }
    return _useSvgEmoji() ? svgifyEmoji(gbHtml) : gbHtml;
  }

  let html = '';

  // Add thinking sections (collapsed by default)
  thinkingBlocks.forEach((block, index) => {
    html += createThinkingSection(block, index, thinkingTime);
  });

  // Add the actual content
  if (content) {
    html += mdToHtml(content);
  }

  return _useSvgEmoji() ? svgifyEmoji(html) : html;
}

/**
 * Convert markdown to HTML
 */
export function mdToHtml(src, opts) {
  const allowedHtmlBlocks = [];
  const codeBlocks = [];
  const mermaidBlocks = [];
  let s = (src ?? '');

  // Extract fenced code blocks before any markdown/HTML preservation passes.
  // Otherwise placeholders from the allowed-HTML sanitizer (e.g.
  // ___ALLOWED_HTML_0___) can leak into quoted HTML/JS samples, because the
  // placeholder gets captured as literal code content and never restored inside
  // the final <pre><code> block.
  s = s.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    const cleaned = code
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/^\s*\n+/, '')
      .replace(/\n+\s*$/g, '');

    // Mermaid diagrams: render as diagram instead of code block
    if (lang && lang.toLowerCase() === 'mermaid') {
      const mermaidId = 'mermaid-' + Date.now() + '-' + mermaidBlocks.length;
      const raw = cleaned.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const placeholder = `___MERMAID_BLOCK_${mermaidBlocks.length}___`;
      mermaidBlocks.push(`<div class="mermaid-container"><pre class="mermaid" id="${mermaidId}">${escapeHtml(raw)}</pre></div>`);
      return placeholder;
    }

    const escaped = cleaned.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const placeholder = `___CODE_BLOCK_${codeBlocks.length}___`;

    const langClass = lang ? ` class="language-${lang}"` : '';
    const runnableLangs = ['python','py','javascript','js','html','bash','sh','shell','zsh'];
    // B6: "Run code" (a live Pyodide/server-shell executor) and "Edit code" are inherited
    // workspace tooling — Big Brother never runs your Python for you. Neither belongs on
    // ANY fenced code block a player might see (their own pasted snippet, a quoted aside,
    // narration text with a fence), so both are dropped outright in the game build; only
    // the harmless copy-code affordance below stays.
    const runBtn = (!_inGameBuild() && lang && runnableLangs.includes(lang.toLowerCase()))
      ? `<button type="button" class="run-code" data-code="${escapeHtml(escaped)}" data-lang="${lang}" title="Run code"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>`
      : '';
    const editBtn = _inGameBuild()
      ? ''
      : `<button type="button" class="edit-code" title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`;
    codeBlocks.push(`<pre><code${langClass} data-lang="${lang || ''}">${escapeHtml(escaped)}</code>${runBtn}${editBtn}<button type="button" class="copy-code" data-code="${escapeHtml(escaped)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></pre>`);

    return placeholder;
  });

  // Repair common ways the agent mangles the entity-anchor convention
  // (`[Name](#kind-<id>)`). Models reliably get the single-link case
  // right but slip into other formats when listing many in a table.
  // These regexes upgrade the broken forms to proper markdown links so
  // the standard `[text](url)` handler below picks them up.
  const ANCHOR_KIND = '(?:session|document|note|image|email|event|task|skill|research)';
  // Case A: `[Name] [#kind-id]` — agent put the URL in brackets, often
  // in a table cell next to the label. Pair them.
  s = s.replace(
    new RegExp(`\\[([^\\]\\n]+?)\\]\\s*\\[#(${ANCHOR_KIND}-[A-Za-z0-9_-]+)\\]`, 'g'),
    '[$1](#$2)',
  );
  // Case B: bare `[#kind-id]` with no preceding label — give it a
  // generic "→ open" link text so it still renders as a button.
  s = s.replace(
    new RegExp(`\\[#(${ANCHOR_KIND}-[A-Za-z0-9_-]+)\\]`, 'g'),
    '[→ open](#$1)',
  );
  // Case C: bare `#kind-id` in plain text — only when it's word-
  // boundary delimited and NOT already inside a markdown link or
  // anchor syntax. Use a lookbehind for `](` or `[` to skip those.
  s = s.replace(
    new RegExp(`(^|[^\\[(])#(${ANCHOR_KIND}-[A-Za-z0-9_-]+)\\b`, 'g'),
    '$1[#$2](#$2)',
  );

  // Feature 0051 — inline cast portraits / generated images. Upgrade markdown image
  // syntax ![alt](url) to a real <img> ONLY for SAME-ORIGIN, app-served image paths
  // (the portrait route + the generated-image route). This is the augment-not-replace
  // hook: when the game master introduces the cast it can drop ![Name](/api/orwell/
  // portrait/<id>) and the face renders in the transcript. The path allowlist keeps it
  // from being a general image-injection vector; a non-matching ![..](..) falls through
  // to the link handler below (becomes a plain link), so play is unaffected when absent.
  // <img> survives the HTML sanitizer (onerror stripped, dangerous schemes neutralized).
  s = s.replace(/!\[([^\]]*)\]\((\/api\/(?:orwell\/portrait|generated-image)\/[A-Za-z0-9_./-]+)\)/g,
    (match, alt, url) => {
      const a = escapeHtml(alt || 'Houseguest');
      const u = escapeHtml(url);
      return `<img class="orwell-portrait-inline" src="${u}" alt="${a}" title="${a}" loading="lazy" `
        + `style="max-width:160px;border-radius:10px;border:1px solid var(--border,#355a66);margin:.25rem .35rem .25rem 0;vertical-align:middle">`;
    });

  // M3-2 fail-open: a sanctioned speaker tag `@[Name]` is promoted to a face chip UPSTREAM
  // (processWithThinking's game-build branch, before this runs). Any speaker tag that reaches
  // raw markdown here instead — a tag NOT at a line start, a non-game build, or the reasoning
  // accordion — degrades to the plain houseguest name (never literal brackets, never a dead
  // `npc:` link). The name-only `@[Name]` (no following `(`) collapses to the bare name; the
  // id-bearing `@[Name](npc:3)` sheds its `@` so the link handler below renders just `Name`.
  s = s.replace(/@\[([^\]\n]{1,80})\](?!\()/g, '$1');
  s = s.replace(/@(\[[^\]\n]{1,80}\]\(npc:\d+\))/g, '$1');

  // Convert markdown links [text](url) to clickable links
  // Internal #hash links navigate in-page; external links open in new tab
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    return linkHtml(text, url);
  });

  // Autolink bare URLs (http/https). Skips URLs already inside <a> tags
  // (placed by markdown link replacement above) and URLs in backticks.
  s = s.replace(
    /(^|[\s(<])(https?:\/\/[^\s<>"'`\]]+[^\s<>"'`\].,;:!?])/g,
    (match, prefix, url) => `${prefix}${linkHtml(url, url)}`
  );

  // Autolink scheme-less domains the model often emits as plain text
  // (e.g. "techcrunch.com/ai", "perplexity.ai", "www.wired.com"). The TLD
  // allowlist keeps it from matching file names / versions ("package.json",
  // "node.js", "v1.2.3"); the required start/[\s(<] prefix means domains
  // already inside an http link (preceded by "//") or an email ("@") are
  // skipped. Require the TLD to end at a real domain boundary so dotted code
  // identifiers like `sklearn.metrics` do not link `sklearn.me` and leave
  // placeholder fragments in the remaining text.
  s = s.replace(
    /(^|[\s(<])((?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|ai|co|dev|app|gov|edu|news|info|tech|xyz|me)(?=$|[\/\s<>"'`\]).,;:!?])(?:\/[^\s<>"'`\])]*)?)/gi,
    (match, prefix, domain) => {
      const trail = (domain.match(/[.,;:!?)]+$/) || [''])[0];
      const core = trail ? domain.slice(0, -trail.length) : domain;
      return `${prefix}${linkHtml(core, 'https://' + core)}${trail}`;
    }
  );

  // Extract <details>...</details> blocks and replace with placeholders
  // Default to open so agent output is visible
  s = s.replace(/<details>([\s\S]*?)<\/details>/gi, (match) => {
    const placeholder = `___ALLOWED_HTML_${allowedHtmlBlocks.length}___`;
    allowedHtmlBlocks.push(sanitizeAllowedHtml(match.replace(/<details>/i, '<details open>')));
    return placeholder;
  });

  // ALSO preserve <a> tags the same way (they're now in the HTML from markdown conversion)
  s = s.replace(/<a\s+[^>]*>.*?<\/a>/gi, (match) => {
    const placeholder = `___ALLOWED_HTML_${allowedHtmlBlocks.length}___`;
    allowedHtmlBlocks.push(sanitizeAllowedHtml(match));
    return placeholder;
  });

  // Preserve the inline cast-portrait <img> we emitted above (feature 0051) the same way,
  // so the next line's blanket escape doesn't turn it back into text. Sanitized like the
  // other preserved fragments (onerror stripped, scheme-checked); the src was already
  // pinned to the same-origin portrait/generated-image routes by the upgrade regex.
  s = s.replace(/<img class="orwell-portrait-inline"[^>]*>/gi, (match) => {
    const placeholder = `___ALLOWED_HTML_${allowedHtmlBlocks.length}___`;
    allowedHtmlBlocks.push(sanitizeAllowedHtml(match));
    return placeholder;
  });

  // Now escape everything else
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  s = s.replace(/\n{3,}/g, '\n\n');

  // KaTeX math rendering (after code blocks are extracted, so math in code is safe)
  const mathBlocks = [];
  if (window.katex) {
    // Display math: \[ ... \]  — GPT-style delimiter (gpt-5.x, Claude, etc.).
    // Handle before $$/$ so all common delimiters render.
    s = s.replace(/\\\[([\s\S]*?)\\\]/g, (match, math) => {
      try {
        const raw = math.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const placeholder = `___MATH_BLOCK_${mathBlocks.length}___`;
        mathBlocks.push(katex.renderToString(raw.trim(), { displayMode: true, throwOnError: false }));
        return placeholder;
      } catch (e) { return match; }
    });
    // Inline math: \( ... \)  — GPT-style inline delimiter. Single-line only
    // ([^\n]) so a stray escaped paren in prose can't swallow across lines.
    s = s.replace(/\\\(([^\n]*?)\\\)/g, (match, math) => {
      try {
        const raw = math.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const placeholder = `___MATH_BLOCK_${mathBlocks.length}___`;
        mathBlocks.push(katex.renderToString(raw.trim(), { displayMode: false, throwOnError: false }));
        return placeholder;
      } catch (e) { return match; }
    });
    // Display math: $$...$$
    s = s.replace(/\$\$([\s\S]*?)\$\$/g, (match, math) => {
      try {
        const raw = math.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const placeholder = `___MATH_BLOCK_${mathBlocks.length}___`;
        mathBlocks.push(katex.renderToString(raw.trim(), { displayMode: true, throwOnError: false }));
        return placeholder;
      } catch (e) { return match; }
    });
    // Inline math: $...$  (not preceded/followed by $ or digit, not spanning multiple lines)
    s = s.replace(/(?<!\$)\$(?!\$)([^\$\n]+?)\$(?!\$)/g, (match, math) => {
      try {
        const raw = math.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const placeholder = `___MATH_BLOCK_${mathBlocks.length}___`;
        mathBlocks.push(katex.renderToString(raw.trim(), { displayMode: false, throwOnError: false }));
        return placeholder;
      } catch (e) { return match; }
    });
  }

  // Handle pipe tables
  s = s.replace(/(?:^|\n)([^\n]*\|[^\n]*\|[^\n]*)(?:\n([^\n]*\|[^\n]*\|[^\n]*))*/g, (table) => {
    if (table.includes('___CODE_BLOCK_') || table.includes('___ALLOWED_HTML_')) return table;

    const rows = table.trim().split('\n');
    if (rows.length < 2) return table;

    let html = '<table style="border-collapse: collapse; width: 100%; margin: 10px 0;">';

    rows.forEach((row, idx) => {
      if (idx === 1 && /^[\s|:\-]+$/.test(row)) {
        html += '<tbody>';
        return;
      }
      const cells = splitTableRow(row);
      if (cells.length === 0) return;

      html += '<tr>';

      cells.forEach(cell => {
        const tag = idx === 0 ? 'th' : 'td';
        html += `<${tag} style="padding: 8px; text-align: left; border-bottom: 1px solid var(--border);">${cell.trim()}</${tag}>`;
      });

      html += '</tr>';
    });

    html += '</tbody></table>';
    return html;
  });

  // Inline code (but not placeholders)
  s = s.replace(/`([^`]+?)`/g, (match, code) => {
    if (code.startsWith('___CODE_BLOCK_') || code.startsWith('___ALLOWED_HTML_')) return match;
    return `<code>${code}</code>`;
  });

  // Horizontal rules (must come before bold/italic to avoid * conflicts)
  s = s.replace(/^(?:---|\*\*\*|___)\s*$/gm, '<hr>');

  // Bold, italic, strikethrough
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Headers
  s = s.replace(/^###### (.*)$/gm, '<h6>$1</h6>')
       .replace(/^##### (.*)$/gm, '<h5>$1</h5>')
       .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
       .replace(/^### (.*)$/gm, '<h3>$1</h3>')
       .replace(/^## (.*)$/gm, '<h2>$1</h2>')
       .replace(/^# (.*)$/gm, '<h1>$1</h1>');

  // Ordered lists (1. 2. 3. etc.)
  s = s.replace(/^(\d+)\. (.*)$/gm, '<oli>$2</oli>');
  s = s.replace(/(?:^|\n)(<oli>[\s\S]*?)(?=\n(?!<oli>)|$)/g, m => `<ol>${m.trim().replace(/<\/?oli>/g, (t) => t === '<oli>' ? '<li>' : '</li>')}</ol>`);

  // GitHub-style task lists (- [ ] / - [x]) → checkbox items. Must run before
  // the generic unordered-list rule so the "- " prefix isn't consumed first.
  // Emits <uli> (with a class) so the unordered-list wrapper below treats it
  // as a list item. Used by plan mode: plan + progress render as a checklist.
  s = s.replace(/^(?:- |\* )\[([ xX])\] (.*)$/gm, (_m, mark, text) => {
    const done = mark.toLowerCase() === 'x';
    return `<uli class="task-item${done ? ' task-done' : ''}"><span class="task-check" aria-hidden="true"></span><span class="task-text">${text}</span></uli>`;
  });

  // Unordered lists. <uli> may carry attributes (task-item class), so the
  // wrapper preserves them when converting <uli ...> → <li ...>.
  s = s.replace(/^(?:- |\* )(.*)$/gm, '<uli>$1</uli>');
  s = s.replace(/(^|\n)((?:<uli\b[^>]*>[^\n]*<\/uli>(?:\n|$))+)/g, (_, prefix, block) =>
    `${prefix}<ul>${block.trim().replace(/<uli\b([^>]*)>/g, '<li$1>').replace(/<\/uli>/g, '</li>')}</ul>`);

  // Blockquotes
  s = s.replace(/^&gt; (.*)$/gm, '<bq>$1</bq>');
  s = s.replace(/(?:^|\n)(<bq>[\s\S]*?)(?=\n(?!<bq>)|$)/g, m =>
    `<blockquote>${m.trim().replace(/<\/?bq>/g, (t) => t === '<bq>' ? '<p>' : '</p>')}</blockquote>`);

  // Paragraphs - but NOT for code block placeholders or allowed HTML
  s = s.replace(/^(?!<h\d|<ul>|<ol>|<li|<oli>|<\/li>|<pre>|<blockquote>|<bq>|<hr>|___CODE_BLOCK_|___ALLOWED_HTML_|___MATH_BLOCK_|___MERMAID_BLOCK_)([^\n]+)$/gm, '<p>$1</p>');

  // Line breaks within paragraphs
  s = s.replace(/<p>([\s\S]*?)<\/p>/g, (match, content) => {
    if (content.includes('___CODE_BLOCK_') || content.includes('___ALLOWED_HTML_') || content.includes('___MATH_BLOCK_') || content.includes('___MERMAID_BLOCK_')) return match;
    const withLineBreaks = content.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');
    return `<p>${withLineBreaks}</p>`;
  });

  // Remove empty paragraphs
  s = s.replace(/<p><\/p>/g, '');

  // CRITICAL: Restore allowed HTML blocks first
  allowedHtmlBlocks.forEach((block, index) => {
    s = s.replace(`___ALLOWED_HTML_${index}___`, block);
  });

  // Restore math blocks
  mathBlocks.forEach((block, index) => {
    s = s.replace(`___MATH_BLOCK_${index}___`, block);
  });

  // Restore mermaid diagram blocks
  mermaidBlocks.forEach((block, index) => {
    s = s.replace(`___MERMAID_BLOCK_${index}___`, block);
  });

  // CRITICAL: Restore code blocks at the end
  codeBlocks.forEach((block, index) => {
    s = s.replace(`___CODE_BLOCK_${index}___`, block);
  });

  return _useSvgEmoji() ? svgifyEmoji(s, opts) : s;
}

/**
 * Reduce excessive whitespace outside of code blocks
 */
export function squashOutsideCode(s) {
  if (!s) return "";
  const parts = String(s).split(/```/);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
  }
  return parts.join('```');
}

/**
 * Render content that may be text or array of content blocks
 */
export function renderContent(content) {
  if (Array.isArray(content)) {
    const texts = [];
    for (const blk of content) {
      if (blk.type === 'text') texts.push(blk.text);
      else if (blk.type === 'image_url') texts.push('[image]');
    }
    return texts.join('\n');
  }
  return content;
}

/**
 * Initialize any unprocessed Mermaid diagrams in a container (or whole document)
 */
export function renderMermaid(container) {
  if (!window.mermaid) return;
  initMermaid();
  const target = container || document;
  const pending = target.querySelectorAll('pre.mermaid:not([data-processed])');
  if (pending.length === 0) return;
  try {
    window.mermaid.run({ nodes: pending });
  } catch (e) {
    console.warn('Mermaid render error:', e);
  }
}

/**
 * A59 (R2 slice, no behaviour change): the ONE place that merges a reply/reasoning pair back into the canonical `<think>`-wrapped source that `processWithThinking` renders into the
 * Thinking accordion + clean body. Three call sites used to build this string by hand (the live primary stream, the observer/mirror stream, the history reload); they must stay identical
 * or live-vs-reload render drift returns. `timeMs` adds the persisted `time="N"` attribute (reload path). `always` keeps a whitespace-only reasoning block (the reload path's old behaviour).
 */
export function composeThinkSource(reasoning, reply, timeMs, always) {
  const r = reasoning == null ? '' : String(reasoning);
  if (!(always ? r : r.trim())) return reply;
  return '<think' + (timeMs ? ` time="${timeMs}"` : '') + '>' + r + '</think>\n\n' + reply;
}

const markdownModule = {
  escapeHtml,
  mdToHtml,
  squashOutsideCode,
  renderContent,
  processWithThinking,
  gameBuildSuppressesThinking,
  gameBuildShowsThinkingAccordion,
  createCollapsible,
  hasUnclosedThinkTag,
  extractThinkingBlocks,
  normalizeThinkingMarkup,
  startsWithReasoningPrefix,
  scrubReasoningPreamble,
  redactRawIds,
  scrubMachineryAsides,
  scrubMachineryForPersistence,
  composeThinkSource,
  extractSpeakerTags,
  restoreSpeakerChips,
  createRestatementWatch,
  renderMermaid
};

export default markdownModule;

// Mermaid is loaded async so it cannot delay the app shell.
function initMermaid() {
  if (!window.mermaid || window.__orwellMermaidReady) return;
  window.mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
  window.__orwellMermaidReady = true;
}
window.orwellInitMermaid = initMermaid;
initMermaid();

// Persist which thinking sections were expanded across page refreshes.
// IDs are render-generated (Date.now-based) so we key by a stable hash of
// the inner text content instead — same content reproduces the same hash on
// reload. LocalStorage holds a Set of expanded hashes; we observe the chat
// history and re-expand matching sections as they're inserted.
const THINK_EXPANDED_KEY = 'orwell-thinking-expanded';
function _loadExpandedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(THINK_EXPANDED_KEY) || '[]')); }
  catch { return new Set(); }
}
function _saveExpandedSet(set) {
  try {
    const arr = [...set];
    // Bound storage growth — keep the most recent 200 entries.
    if (arr.length > 200) arr.splice(0, arr.length - 200);
    localStorage.setItem(THINK_EXPANDED_KEY, JSON.stringify(arr));
  } catch {}
}
function _hashThinkingContent(el) {
  if (!el) return '';
  const text = (el.textContent || '').trim();
  if (!text) return '';
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return String(h);
}
function _setThinkingExpanded(content, toggle, header, expanded) {
  if (!content || !toggle) return;
  content.classList.toggle('expanded', expanded);
  toggle.classList.toggle('expanded', expanded);
  const label_el = header?.querySelector('.thinking-header-left span');
  if (label_el) {
    const label = label_el.dataset.label || 'thinking process';
    label_el.textContent = expanded ? `Hide ${label}` : `View ${label}`;
  }
  if (header) {
    header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
}

// Delegated click handler for thinking toggle (CSP-safe, no inline onclick)
document.addEventListener('click', function(e) {
  const header = e.target.closest('.thinking-header[data-thinking-id]');
  if (!header) return;
  const id = header.dataset.thinkingId;
  const content = document.getElementById(id);
  const toggle = document.getElementById(id + '-toggle');
  if (!content || !toggle) return;

  const willExpand = !content.classList.contains('expanded');
  _setThinkingExpanded(content, toggle, header, willExpand);

  // Persist by content hash so the choice survives a refresh.
  const hash = _hashThinkingContent(content);
  if (!hash) return;
  const set = _loadExpandedSet();
  if (willExpand) set.add(hash);
  else set.delete(hash);
  _saveExpandedSet(set);
});

// Keyboard handler: Enter/Space on thinking header triggers toggle (R-A11Y-1)
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  const header = e.target.closest('.thinking-header[data-thinking-id]');
  if (!header) return;
  e.preventDefault();
  header.click();
});

// Watch the chat history; whenever a thinking section appears, expand it if
// its hash matches one the user previously expanded.
(function _watchThinking() {
  if (window._thinkingWatcherWired) return;
  window._thinkingWatcherWired = true;
  const _apply = (root) => {
    if (!root || !root.querySelectorAll) return;
    const sections = root.matches?.('.thinking-section')
      ? [root]
      : [...root.querySelectorAll('.thinking-section')];
    if (!sections.length) return;
    const set = _loadExpandedSet();
    if (!set.size) return;
    for (const sec of sections) {
      const content = sec.querySelector('.thinking-content');
      if (!content) continue;
      if (content.classList.contains('expanded')) continue;
      const hash = _hashThinkingContent(content);
      if (!hash || !set.has(hash)) continue;
      const header = sec.querySelector('.thinking-header[data-thinking-id]');
      const id = header?.dataset.thinkingId;
      const toggle = id ? document.getElementById(id + '-toggle') : null;
      _setThinkingExpanded(content, toggle, header, true);
    }
  };
  const start = () => {
    const root = document.body;
    if (!root) return;
    _apply(root);
    // ORW-157: once per frame over the nodes still attached (a streamed reply replaces its tail every token).
    new MutationObserver(frameBatched((mutations) => {
      for (const node of liveAddedElements(mutations)) _apply(node);
    })).observe(root, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
