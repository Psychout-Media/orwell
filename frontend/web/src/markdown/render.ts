import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { extractSpeakerTags, restoreSpeakerChips } from './speakers';

marked.setOptions({ gfm: true, breaks: true });

const SANITIZE = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'a', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  ALLOWED_ATTR: ['href', 'class', 'title', 'aria-hidden', 'rel', 'target'],
  ALLOW_DATA_ATTR: false,
};

// Engine machinery that must never reach the public bubble (bare `npc:<id>` tokens).
const RAW_NPC_ID_RE = /\(?\bnpc:\d+\b\)?/g;
const INLINE_THINK_RE = /<(think|thinking|thought)(?:\s[^>]*)?>[\s\S]*?(?:<\/\1>|$)/gi;
const OOC_WHOLE_RE = /^\s*\(\(([\s\S]*)\)\)\s*$/;

/**
 * Last line of defence for the public bubble. Reasoning is separated by CHANNEL upstream (the stream
 * parser never puts it in the reply), but a model can still inline <think> tags in plain content, and
 * a tool result can echo a raw id. Neither may render.
 */
export function scrubPublic(text: string): string {
  return text.replace(INLINE_THINK_RE, '').replace(RAW_NPC_ID_RE, '');
}

/** Pull any inline <think> content out of a stored message so it can go to the reasoning box instead. */
export function splitInlineThinking(text: string): { reply: string; reasoning: string } {
  const parts: string[] = [];
  const reply = text.replace(INLINE_THINK_RE, (m) => {
    parts.push(m.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>$/, '').trim());
    return '';
  });
  return { reply, reasoning: parts.filter(Boolean).join('\n\n') };
}

let linkHookInstalled = false;
function ensureHooks(): void {
  if (linkHookInstalled) return;
  linkHookInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('rel', 'noopener noreferrer');
      node.setAttribute('target', '_blank');
    }
  });
}

const cache = new Map<string, string>();
const CACHE_MAX = 600;
let cacheVersion = 0;

/** Call when the roster names change so memoised blocks re-evaluate the bold-name fallback. */
export function invalidateRenderCache(): void {
  cacheVersion++;
  cache.clear();
}

/** Render ONE block of markdown to sanitised HTML. Pure and memoised by source text. */
export function renderBlock(src: string): string {
  const key = cacheVersion + '|' + src;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  ensureHooks();
  const clean = scrubPublic(src);
  const aside = OOC_WHOLE_RE.exec(clean);
  const body = aside ? (aside[1] ?? '') : clean;
  const { text, chips } = extractSpeakerTags(body);
  const parsed = marked.parse(text, { async: false }) as string;
  let html = restoreSpeakerChips(DOMPurify.sanitize(parsed, SANITIZE) as unknown as string, chips);
  if (aside) html = `<div class="ow-aside">${html}</div>`;
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next();
    if (!first.done) cache.delete(first.value);
  }
  cache.set(key, html);
  return html;
}
