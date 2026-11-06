// The public-bubble pipeline. Everything the classic client does to keep reasoning and engine machinery out of the
// player's transcript is done by the classic markdown.js itself (imported, not copied), on the WHOLE reply, and only then
// is the result split into top-level blocks for memoised rendering:
//
//   whole reply -> extractThinkingBlocks (multi-block <think>, unclosed opener, plain-text reasoning)
//               -> squashOutsideCode -> processWithThinking (game build: scrubReasoningPreamble, redactRawIds,
//                  scrubMachineryAsides, scrubRealWorldDeny, restated-reply collapse, OOC asides, speaker chips)
//               -> DOMPurify (defence in depth) -> top-level block strings
import './classicGuards';
import DOMPurify from 'dompurify';
import { extractThinkingBlocks, hasUnclosedThinkTag, processWithThinking, squashOutsideCode, startsWithReasoningPrefix } from '@classic/markdown.js';

export interface RenderedReply {
  /** Sanitised HTML, one string per top-level block, in order. Equal strings render identically (memoise on them). */
  blocks: string[];
  /** Reasoning that was inlined in the reply text (the stream's own reasoning channel is separate). */
  reasoning: string;
}

let rosterIds = new Map<string, string>();

/** Roster names for the classic bold-name speaker fallback (`window.orwellResolveHouseguestId`, same hook the classic page defines). */
export function setRoster(entries: Iterable<{ id: string; name: string }>): void {
  rosterIds = new Map(Array.from(entries, (e) => [e.name.trim().toLowerCase(), e.id] as [string, string]));
  (window as unknown as { orwellResolveHouseguestId?: (n: string) => string | null }).orwellResolveHouseguestId = (n: string) => rosterIds.get(String(n).trim().toLowerCase()) ?? null;
}

const RAW_ID_RE = /\bnpc:\d+\b[ \t]*(?:[-–—:(]\s*)?/gi;

/** Reasoning is allowed to discuss mechanics, but a bare engine id is never shown (same rule as the classic accordion). */
export function cleanReasoning(text: string): string {
  return text.replace(RAW_ID_RE, '').replace(/ {2,}/g, ' ').trim();
}

/**
 * The player never sees reasoning in the game build. The box exists only behind the classic admin escape hatch
 * (`data-show-thinking` on <body>), which nothing in /play sets.
 */
export function reasoningVisible(): boolean {
  return document.body.hasAttribute('data-show-thinking');
}

let hookInstalled = false;
function ensureHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('rel', 'noopener noreferrer');
      node.setAttribute('target', '_blank');
    }
  });
}

function toBlocks(html: string): string[] {
  const t = document.createElement('template');
  t.innerHTML = html;
  const out: string[] = [];
  t.content.childNodes.forEach((n) => {
    if (n.nodeType === 1) out.push((n as Element).outerHTML);
    else if (n.nodeType === 3 && n.textContent && n.textContent.trim()) out.push(`<p>${DOMPurify.sanitize(n.textContent)}</p>`);
  });
  return out;
}

/** Render a WHOLE reply (stored row or the live buffer so far). Pure for a given roster. */
export function renderReply(text: string): RenderedReply {
  if (!text || !text.trim()) return { blocks: [], reasoning: '' };
  ensureHook();
  const ex = extractThinkingBlocks(text);
  const reasoning = cleanReasoning(ex.thinkingBlocks.join('\n\n'));
  if (!ex.content) return { blocks: [], reasoning };
  const html = processWithThinking(squashOutsideCode(ex.content));
  const clean = DOMPurify.sanitize(html) as unknown as string;
  return { blocks: toBlocks(clean), reasoning };
}

// ── Live (still streaming) text ─────────────────────────────────────────────────────────────────────────────
// The settled-text extractor above is built for COMPLETE replies: for an unclosed leading <think> it assumes the model never
// closes it and shows the body as the reply. On a live buffer that would paint reasoning and then take it back at </think>.
// This guard is the port of the classic streaming state machine (chat.js "hasUnclosedThink"): while reasoning is open, render
// only what came before it, and nothing while a reasoning preamble has no reply after it.

const OPEN_RE = /<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>|<\|channel>thought/gi;
const CLOSE_RE = /<\/(?:think(?:ing)?|thought)>|<channel\|>/gi;
const REPLY_PREFIXES = ['Hey', 'Hi ', 'Hi!', 'Hello', 'Sure', 'Yes', 'No ', 'No,', 'Yo', 'OK', 'Here', 'Absolutely', 'Of course', 'Great', 'Alright', 'Thanks', 'Welcome', 'Good ', "I'm happy", "I'd be"];
const TAG_PREFIXES = ['<think', '<thinking', '<thought', '</think', '</thinking', '</thought', '<|channel>thought', '<channel|>', '<|channel>response'];

/** Drop a partial reasoning tag at the very end of the buffer (`<thi`), so it never flashes and then vanishes. */
function dropPartialTag(text: string): string {
  const i = text.lastIndexOf('<');
  if (i < 0 || text.indexOf('>', i) >= 0) return text;
  const frag = text.slice(i).toLowerCase();
  return TAG_PREFIXES.some((c) => c.startsWith(frag)) ? text.slice(0, i) : text;
}

/** Index of the first reasoning opener that has no closer yet, or -1. */
export function firstUnclosedOpener(text: string): number {
  const events: Array<{ at: number; open: boolean }> = [];
  for (const m of text.matchAll(OPEN_RE)) events.push({ at: m.index ?? 0, open: true });
  for (const m of text.matchAll(CLOSE_RE)) events.push({ at: m.index ?? 0, open: false });
  events.sort((a, b) => a.at - b.at);
  const stack: number[] = [];
  for (const e of events) {
    if (e.open) stack.push(e.at);
    else stack.shift(); // a closer ends the earliest open block (a trailing orphan closer is harmless)
  }
  return stack.length ? (stack[0] ?? -1) : -1;
}

const PREAMBLE_STARTS = ['thinking:', 'thinking process:', 'the user ', 'i need ', 'i should ', 'i will ', 'they are ', 'the question ', 'i can '];

function plainPreambleWaiting(text: string): boolean {
  const trimmed = text.trimStart();
  // Too short to tell yet whether this is the start of a reasoning preamble: hold, so a label never flashes and vanishes.
  const low = trimmed.toLowerCase();
  if (low.length > 0 && low.length < 18 && PREAMBLE_STARTS.some((c) => c.length > low.length && c.startsWith(low))) return true;
  if (!startsWithReasoningPrefix(trimmed)) return false;
  const lines = trimmed.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const l = (lines[i] ?? '').trim();
    if (l && REPLY_PREFIXES.some((rp) => l.startsWith(rp))) return false;
  }
  const inline = REPLY_PREFIXES.some((rp) => {
    const m = new RegExp('[.!?]\\s*' + rp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).exec(trimmed);
    return !!m && m.index > 20;
  });
  return !inline;
}

/** Render the live buffer. Reasoning that is still open (or a preamble with no reply yet) never reaches the bubble. */
export function renderLive(text: string): RenderedReply {
  if (!text || !text.trim()) return { blocks: [], reasoning: '' };
  const buf = dropPartialTag(text);
  if (hasUnclosedThinkTag(buf)) {
    const cut = firstUnclosedOpener(buf);
    const head = cut >= 0 ? buf.slice(0, cut) : '';
    const rest = cut >= 0 ? buf.slice(cut) : buf;
    const shown = head.trim() ? renderReply(head) : { blocks: [], reasoning: '' };
    const open = rest.replace(OPEN_RE, '').replace(CLOSE_RE, '');
    return { blocks: shown.blocks, reasoning: cleanReasoning([shown.reasoning, open].filter(Boolean).join('\n\n')) };
  }
  // `<think></think>` then text with no closer yet: the model is still thinking outside the tags.
  const emptyPair = /^\s*<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>\s*<\/(?:think(?:ing)?|thought)>/i.exec(buf);
  if (emptyPair) {
    const after = buf.slice(emptyPair[0].length);
    if (after.trim() && !/<\/(?:think(?:ing)?|thought)>|<channel\|>/i.test(after)) return { blocks: [], reasoning: cleanReasoning(after) };
  }
  if (!/<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>|<\|channel>thought/i.test(buf) && plainPreambleWaiting(buf)) {
    return { blocks: [], reasoning: cleanReasoning(buf) };
  }
  return renderReply(buf);
}
