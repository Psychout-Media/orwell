// streamingSegmenter.js
//
// Pure logic for incremental ("block-at-a-time") streaming markdown rendering.
//
// While an assistant message streams in, re-rendering the whole accumulated
// markdown on every token is wasteful (O(N^2)) and recreates DOM nodes, which
// makes code-block hover buttons flicker. The fix is to FREEZE the leading part
// of the message that can no longer change, and only re-render the growing tail.
//
// This module answers the one hard question that makes freezing safe:
//
//     Given the full markdown received so far, how many leading characters can
//     be finalized without changing the rendered output?
//
// The contract callers rely on (`render` is the canonical markdown renderer):
//
//     const n = splitFinalized(text, render);
//     render(text.slice(0, n)) + render(text.slice(n))  ===  render(text)
//
// The module is intentionally DOM-free and renderer-agnostic so it can be unit
// tested in isolation and reused for any markdown renderer with no long-range
// cross-block dependencies (no reference-style links / footnotes).
//
// Known limitations (both bounded by the same mitigation):
//   - cutIsRenderSafe proves only PRESENT-tense equivalence. If the renderer pairs
//     an inline delimiter across a blank line (e.g. markdown.js will turn
//     `*a\n\nb*` into emphasis spanning two paragraphs), a block frozen before the
//     closing delimiter arrives can disagree with the final full render.
//   - afterClosedFence boundaries are trusted without the equivalence check, so a
//     fence the real renderer parses differently (e.g. a stray 4-backtick line) can
//     be mis-detected as a close.
//   Both only occur for input the renderer itself handles oddly, and both are
//   transient: chat.js re-renders the finished message from source, so the settled
//   output is always canonical.

// A fenced-code delimiter line: up to 3 leading spaces, then >=3 backticks or
// tildes, then an optional info string.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Scan `text` starting at `fromOffset` — which MUST be at top level (callers only
 * ever advance to a finalized boundary, never into a fence) — and collect the
 * candidate cut points.
 *
 * @returns {{ boundaries: Array<{offset:number, afterClosedFence:boolean}>, inFence:boolean }}
 *   - A blank-line run at top level yields a boundary at the start of the next
 *     non-blank line (`afterClosedFence: false`).
 *   - A fence close yields a boundary just past the closing fence line
 *     (`afterClosedFence: true`) — such a cut is unconditionally safe, since
 *     nothing can ever merge into a completed code block.
 */
function findBoundaries(text, fromOffset) {
  const boundaries = [];
  const n = text.length;
  let inFence = false;
  let fenceMarker = '';
  let i = fromOffset;

  while (i < n) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl === -1 ? n : nl;
    const afterNl = nl === -1 ? n : nl + 1;
    const line = text.slice(i, lineEnd);
    const fence = line.match(FENCE_RE);

    if (fence) {
      const marker = fence[1];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (
        marker[0] === fenceMarker[0] &&
        marker.length >= fenceMarker.length &&
        fence[2].trim() === '' // a closing fence carries no info string
      ) {
        inFence = false;
        fenceMarker = '';
        boundaries.push({ offset: afterNl, afterClosedFence: true });
      }
      i = afterNl;
    } else if (!inFence && line.trim() === '') {
      // Consume the entire run of blank lines; the boundary is the start of the
      // next non-blank line so the finalized side owns the separator and the tail
      // starts clean.
      let j = afterNl;
      while (j < n) {
        const nl2 = text.indexOf('\n', j);
        const lineEnd2 = nl2 === -1 ? n : nl2;
        if (text.slice(j, lineEnd2).trim() !== '') break;
        if (nl2 === -1) {
          j = n;
          break;
        }
        j = nl2 + 1;
      }
      boundaries.push({ offset: j, afterClosedFence: false });
      i = j;
    } else {
      i = afterNl;
    }
  }

  return { boundaries, inFence };
}

/**
 * Does cutting between `before` and `after` leave the rendered output unchanged?
 * This is the self-verifying safety check: it directly compares rendering the two
 * sides separately against rendering them joined, so constructs that span the cut
 * (loose lists, setext headings, lazy blockquote continuations, tables) are caught
 * with no hand-coded grammar rules.
 *
 * Renderer non-determinism (e.g. mermaid ids seeded with Date.now()) can only make
 * this return a false negative, never a false positive — so the bias is always
 * toward under-finalizing, which is the safe direction.
 */
function cutIsRenderSafe(before, after, render) {
  // ORW-156: the renderer joins blocks with a blank-line separator ("<p>A</p>\n\n<p>B</p>") but the two
  // separate renders concatenate with none, so the old strict equality was false for ordinary prose and
  // NOTHING ever froze (committedLen stayed 0; every delta re-rendered the whole reply). Whitespace BETWEEN
  // block tags is presentation-inert, so compare with it collapsed. Real merge hazards (a loose list, a
  // lazy continuation, an indented block) still change the tags/text and still fail the check.
  const renderedAfter = render(after);
  // A block that renders to nothing (a scrubbed operator line, say) cannot show the piece before it what comes next (the stream renderer
  // decides a speech hand-off from the block after a frozen piece), so the cut before it waits for the cut after it.
  if (!renderedAfter.trim()) return false;
  return normalizeBlockGaps(render(before) + renderedAfter) === normalizeBlockGaps(render(before + after));
}

// Only the whitespace AFTER a closing block tag (or an <hr>) is presentation-inert; inline whitespace (`</em> <strong>`) is content and is kept.
function normalizeBlockGaps(html) {
  return html.replace(/(<\/(?:p|ul|ol|li|pre|blockquote|div|table|h[1-6])>|<hr\s*\/?>)\s+(?=<)/g, '$1').trim();
}

// A `((production aside))` (or an inline `<think>`) renders as ONE unit with its position in the whole reply: the game-build scrub, the
// whole-message OOC wrap and the inline-aside extraction (which moves an aside bubble to the END of the prose) all see the whole reply. A
// frozen piece is rendered once, alone. So nothing is frozen past an aside marker, and the cut just before the block that holds one is
// refused too (the tail would start with the aside and render it ahead of the prose that follows it). From there the reply stays in the
// live tail until it settles: the pre-ORW-156 behaviour, for the rare reply that has an aside. A completed code fence after the marker is
// covered as well (the fence branch used to skip this check). One regex pass over the unfrozen text per call (O(tail)).
//
// Speech (a `@[Name]` speaker line and the paragraphs that continue it) does NOT stop freezing: the stream renderer gives each piece its
// speech context instead (see streamingRenderer.js), and F-6's restatement collapse latches the whole-reply render (markdown.js).
const ASIDE_MARKER_RE = /\(\(|\)\)|<\/?think/i;
function firstAsideMarker(text, from) {
  const m = ASIDE_MARKER_RE.exec(from > 0 ? text.slice(from) : text);
  return m ? from + m.index : -1;
}

/**
 * Return how many leading characters of `text` can be safely finalized, scanning
 * forward from `committedLen` (the amount already finalized).
 *
 * Guarantees `render(text.slice(0, n)) + render(text.slice(n)) === render(text)`
 * (modulo inter-block whitespace), and `committedLen <= n <= text.length`. Never
 * cuts past, or just before, an aside or an inline <think> (see above).
 *
 * `memo` (optional Map, owned by one stream renderer) remembers each boundary's verdict by offset so a
 * boundary is proven ONCE, not on every delta (the per-token work stays O(new text)). With a memo, a prose
 * boundary is only judged once the block AFTER it is complete (a later boundary exists): the verdict then
 * depends on the text alone, never on how much of that block had arrived. So two windows that received the
 * same text in different chunks freeze at exactly the same places (ship gate F5), and the stream renderer
 * can pass that complete block on as the frozen piece's look-ahead. The cost is one more block in the live
 * tail. Without a memo every call re-proves on whatever has arrived (the old behaviour).
 *
 * @param {string} text       Full markdown accumulated so far.
 * @param {(src:string)=>string} render  Canonical markdown renderer (the stream renderer passes its structure-only cut-check render).
 * @param {number} [committedLen=0]  Characters already finalized (always a prior boundary).
 * @param {Map<number, boolean>} [memo]
 * @returns {number}
 */
export function splitFinalized(text, render, committedLen = 0, memo = null) {
  const { boundaries } = findBoundaries(text, committedLen);
  const asideAt = firstAsideMarker(text, committedLen);

  let best = committedLen;
  let segStart = committedLen;

  for (let k = 0; k < boundaries.length; k++) {
    const { offset } = boundaries[k];
    const blockEnd = k + 1 < boundaries.length ? boundaries[k + 1].offset : text.length; // end of the block AFTER this cut
    if (asideAt !== -1 && asideAt < blockEnd) break; // never freeze past, or just before, an aside / <think> (see above)

    // Every cut, including the one just past a completed code fence, needs a following block to compare against (the last block must
    // stay live, it can still grow) and must be render-equivalent locally. ORW-156: the fence cut used to be taken unconditionally. That
    // is safe for markdown, but the game-build render has position-dependent scrubs (the leading reasoning-preamble scrub drops a line
    // that STARTS the text), so the piece after an unchecked fence cut could hide a line the whole-reply render shows, and a window that
    // froze the fence and the next block in one piece showed it (two windows disagreeing, ship gate F5).
    const hasLater = k + 1 < boundaries.length;
    const after = text.slice(offset, blockEnd);
    let safe;
    if (memo && memo.has(offset)) {
      safe = memo.get(offset);
    } else if (after.trim() === '') {
      safe = false;
    } else if (memo && !hasLater) {
      break; // the block after this cut is still arriving: judge it once it is complete (see above)
    } else {
      safe = cutIsRenderSafe(text.slice(segStart, offset), after, render);
      if (memo) memo.set(offset, safe);
    }
    if (safe) best = offset;
    // The next cut compares against the block after this one; if that block is only blank lines (a fence's trailing blank line), keep
    // comparing against the last real block so the check still sees what precedes the next cut.
    if (after.trim() !== '') segStart = offset;
  }

  return best;
}

/**
 * The end of the block that starts at `offset` (the next cut point after it, or the end of the text). The stream renderer uses it to
 * hand a frozen piece the block that follows it as its look-ahead.
 *
 * @param {string} text
 * @param {number} offset  The start of a block (a cut point returned by splitFinalized).
 * @returns {number}
 */
export function blockEndAt(text, offset) {
  const { boundaries } = findBoundaries(text, offset);
  for (const b of boundaries) if (b.offset > offset) return b.offset;
  return text.length;
}

/**
 * If `text` begins with a fenced-code opener whose fence never closes, describe it
 * so the renderer can stream the code in append-mode instead of re-rendering it.
 * Returns `{ lang, contentStart }` (contentStart = offset of the first code char),
 * or null when `text` does not start with a still-open fence.
 *
 * The opener line must be complete (terminated by a newline) so the info string /
 * language is known before append-mode begins.
 */
export function describeOpenFence(text) {
  const open = text.match(/^( {0,3})(`{3,}|~{3,})([^\n]*)\n/);
  if (!open) return null;
  const marker = open[2];
  const contentStart = open[0].length;

  for (let i = contentStart; i < text.length; ) {
    const nl = text.indexOf('\n', i);
    const line = text.slice(i, nl === -1 ? text.length : nl);
    const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === marker[0] && close[1].length >= marker.length) {
      return null; // the fence closes — let the normal finalize path handle it
    }
    if (nl === -1) break;
    i = nl + 1;
  }

  const lang = (open[3] || '').trim().split(/\s+/)[0] || '';
  return { lang, contentStart };
}
