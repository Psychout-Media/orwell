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
import { extractThinkingBlocks, gameBuildShowsThinkingAccordion, processWithThinking, squashOutsideCode } from '@classic/markdown.js';

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

/** Operator flag: the classic client hides the reasoning accordion with body.hide-thinking / data-hide-thinking. */
export function reasoningVisible(): boolean {
  return gameBuildShowsThinkingAccordion();
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
