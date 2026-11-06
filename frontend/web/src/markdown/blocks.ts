// Incremental block splitter. A streamed reply only ever grows, so every top-level block except the
// last is final the moment a later block exists: it is committed once and never re-parsed. Only the
// tail is re-lexed per frame, so the work per frame is O(tail), not O(whole reply).
import { marked } from 'marked';

const TAG_ONLY_RE = /^\s*@\[[^\]\n]{1,80}\]\s*:?\s*$/;

export interface BlockState {
  /** Finalised block sources, in order. Never change once pushed. */
  stable: string[];
  /** Offset into the full text where the live tail begins. */
  tailStart: number;
  /** Source of the live (still-growing) block, '' if none. */
  tail: string;
  /** Length of the full text last seen (to detect a non-append edit and reset). */
  seen: number;
}

export function emptyBlocks(): BlockState {
  return { stable: [], tailStart: 0, tail: '', seen: 0 };
}

/** Advance `prev` to cover `text`. Returns a new state; `stable` is reused (same array reference) when nothing was committed. */
export function advanceBlocks(prev: BlockState, text: string): BlockState {
  // Not an append of what we already saw (history swap, retry): start over.
  const base = text.length < prev.seen || prev.tailStart > text.length ? emptyBlocks() : prev;
  const rest = text.slice(base.tailStart);
  if (!rest) return { ...base, tail: '', seen: text.length };
  const tokens = marked.lexer(rest).filter((t) => t.type !== 'space' || t.raw.length > 0);
  // Drop a trailing 'space' token from the tail view but keep its length for offsets.
  let lastContent = tokens.length - 1;
  while (lastContent >= 0 && tokens[lastContent]?.type === 'space') lastContent--;
  if (lastContent <= 0) {
    return { stable: base.stable, tailStart: base.tailStart, tail: rest, seen: text.length };
  }
  const committed: string[] = [];
  let consumed = 0;
  let i = 0;
  while (i < lastContent) {
    const t = tokens[i];
    if (!t) break;
    if (t.type === 'space') {
      consumed += t.raw.length;
      i++;
      continue;
    }
    if (TAG_ONLY_RE.test(t.raw)) {
      // A speaker tag alone on its line belongs to the speech after it: merge with the next
      // content block, or wait if that block is still the live tail.
      let j = i + 1;
      while (j < tokens.length && tokens[j]?.type === 'space') j++;
      if (j >= lastContent) break;
      const nxt = tokens[j];
      if (!nxt) break;
      for (let k = i; k <= j; k++) consumed += tokens[k]?.raw.length ?? 0;
      committed.push(t.raw.trimEnd() + ' ' + nxt.raw);
      i = j + 1;
      continue;
    }
    consumed += t.raw.length;
    committed.push(t.raw);
    i++;
  }
  const newTailStart = base.tailStart + consumed;
  return {
    stable: committed.length ? base.stable.concat(committed) : base.stable,
    tailStart: newTailStart,
    tail: text.slice(newTailStart),
    seen: text.length,
  };
}

/** Whole-text convenience (history rows, tests): every block is final. */
export function splitBlocks(text: string): string[] {
  const s = advanceBlocks(emptyBlocks(), text);
  return s.tail.trim() ? s.stable.concat(s.tail) : s.stable;
}
