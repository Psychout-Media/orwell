// ORW-156 harness: drives the REAL streamingRenderer.js / streamingSegmenter.js / markdown.js under Node with a
// tiny fake DOM (opaque HTML chunks) and counts markdown renders. argv[2] = dir holding a copy of static/js with
// the ui.js import stubbed. Prints one JSON line.
const dir = process.argv[2];
const noop = () => {};
class N {
  constructor(t) { this.nodeType = t; this.parentNode = null; this.childNodes = []; this.style = {}; }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() { if (!this.parentNode) return null; const a = this.parentNode.childNodes; return a[a.indexOf(this) + 1] || null; }
  remove() { if (this.parentNode) { const a = this.parentNode.childNodes; a.splice(a.indexOf(this), 1); this.parentNode = null; } }
  appendChild(c) { c.remove(); c.parentNode = this; this.childNodes.push(c); return c; }
  insertBefore(c, ref) { c.remove(); c.parentNode = this; const i = ref ? this.childNodes.indexOf(ref) : -1; if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c); return c; }
  set innerHTML(h) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; if (h) { const t = new N(1); t.html = h; this.appendChild(t); } }
  get innerHTML() { return this.childNodes.map((c) => c.html || (c.data !== undefined ? c.data : c.childNodes.length ? c.innerHTML : '')).join(''); }
  appendData(d) { this.data += d; }
  set textContent(v) { this.innerHTML = v || ''; }
  get textContent() { return this.childNodes.map((c) => (c.html ? c.html.replace(/<[^>]*>/g, '') : c.data !== undefined ? c.data : c.textContent)).join(''); }
  querySelectorAll() { return []; }
  get content() { return { querySelectorAll: () => [] }; }
}
globalThis.window = globalThis;
globalThis.addEventListener = noop;
globalThis.NodeFilter = { SHOW_TEXT: 4 };
globalThis.document = {
  readyState: 'complete', addEventListener: noop, body: { hasAttribute: (n) => n === 'data-game-build', classList: { contains: () => false } },
  getElementById: () => null, querySelector: () => null,
  createElement: () => new N(1), createComment: () => new N(8), createTextNode: (d) => { const n = new N(3); n.data = d; return n; }, createTreeWalker: () => ({ nextNode: () => false }),
};
globalThis.localStorage = { getItem: () => null, setItem: noop };
globalThis.MutationObserver = class { observe() {} };

const md = await import(dir + '/markdown.js');
const { createStreamRenderer } = await import(dir + '/streamingRenderer.js');
// the render chat.js hands the stream renderer: it forwards the renderer's speech context (ORW-156); called without one it is the canonical
// whole-reply render every comparison below uses as the expected output
const baseRender = (t, ctx) => md.processWithThinking(md.squashOutsideCode(t), ctx);
// ...and the renderer options chat.js passes (the F-6 restatement watch latches the whole-reply render)
const rendererOpts = (render) => ({ render, hljs: null, needsFullRender: md.createRestatementWatch() });
const gaps = (h) => h.replace(/>\s+</g, '><').trim();

const SENT = ['The kitchen hums with low voices. ', 'Someone laughs near the sink. ', 'A door opens and closes again. ', 'Footsteps cross the living room. '];
function prose(chars) { let t = ''; let i = 0; while (t.length < chars) { t += SENT[i % 4]; if (i % 4 === 3) t += '\n\n'; i++; } return t.trimEnd(); }

function run(text, step) {
  let calls = 0; let chars = 0;
  const render = (t, ctx) => { calls++; chars += t.length; return baseRender(t, ctx); };
  const el = new N(1);
  const r = createStreamRenderer(el, rendererOpts(render));
  let deltas = 0;
  for (let n = step; n < text.length + step; n += step) { r.update(text.slice(0, Math.min(n, text.length))); deltas++; }
  const beforeFinalizeBlocks = el.childNodes.filter((c) => c.html).length;
  r.finalize();
  return { calls, chars, deltas, frozenBlocksBeforeFinalize: beforeFinalizeBlocks, html: el.innerHTML };
}

const out = { cases: {} };
for (const n of [2000, 8000]) { const t = prose(n); const x = run(t, 4); out[`prose${n}`] = { calls: x.calls, chars: x.chars, deltas: x.deltas, len: t.length, parity: gaps(x.html) === gaps(baseRender(t)) }; }
// the game's usual reply: speaker lines (`@[Name]`), each continued by narration; it must stream as cheaply as prose (no restatement here)
const SPEAKERS = ['Maya Ortiz', 'Marcus Chen', 'Dana Wells'];
// every line is new (a number in every 8-word run), so nothing here is a restatement and the stream never needs the whole-reply render
const say = (i) => `I counted ${i + 2} votes and ${i + 9} promises, and ${3 * i + 4} of them were lies told before ${i + 1} tonight.`;
function speech(chars) { let t = ''; let i = 0; while (t.length < chars) { t += `@[${SPEAKERS[i % 3]}] "${say(i)}"\n\n` + SENT[i % 4] + SENT[(i + 1) % 4] + '\n\n' + SENT[(i + 2) % 4] + '\n\n'; i++; } return t.trimEnd(); }
for (const n of [2000, 8000]) { const t = speech(n); const x = run(t, 4); out[`speech${n}`] = { calls: x.calls, chars: x.chars, deltas: x.deltas, len: t.length, parity: gaps(x.html) === gaps(baseRender(t)) }; }

let degraded = 0;
const realErr = console.error;
console.error = (...a) => { if (String(a[0]).includes('falling back')) degraded++; realErr(...a); };
const MIXED = [
  'Opening line with **bold** and *italic* words.\n\nSecond paragraph, calm.\n\n- first item\n- second item\n\n- a loose third item\n\n',
  'Here is the end.\n\n> a quote\n> continues\n\nLast paragraph here.',
].join('');
const m = run(MIXED, 3);
out.cases.mixed = { parity: gaps(m.html) === gaps(baseRender(MIXED)), got: gaps(m.html).slice(0, 200), want: gaps(baseRender(MIXED)).slice(0, 200) };

// a fenced code block streams in append-mode and freezes without ever latching the full-render fallback
const FENCED = 'Before the code.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter the code, one more line.\n\nLast paragraph here.';
const f = run(FENCED, 3);
out.cases.fenced = { degraded, hasCode: f.html.includes('const b = 2;'), hasAfter: f.html.includes('one more line') };
// a loose list must NOT freeze across the blank line (the cut would change the rendering)
const seg = await import(dir + '/streamingSegmenter.js');
// a renderer that MERGES across the blank line (a loose list) must veto the cut, whatever the real renderer does
const mergingRender = (t) => ((t.match(/- /g) || []).length >= 2 ? '<ul class="loose">' + t.trim() + '</ul>' : '<ul>' + t.trim() + '</ul>');
const LIST = '- a\n\n- b\n\n- c';
out.looseListCommitted = seg.splitFinalized(LIST, mergingRender, 0, new Map());
const PROSE2 = 'One paragraph here.\n\nTwo paragraph here.\n\nThree is the live tail';
out.proseCommitted = seg.splitFinalized(PROSE2, baseRender, 0, new Map());
out.proseSplitAt = PROSE2.indexOf('Two');
// a cut is judged once the block after it is COMPLETE (a later cut exists), never on a half-arrived block
out.proseCommittedHalf = seg.splitFinalized(PROSE2 + ' now.\nmore', baseRender, 0, new Map());
out.proseCommittedLater = seg.splitFinalized(PROSE2 + ' now.\nmore\n\nFour', baseRender, 0, new Map());
out.proseSplitLater = PROSE2.indexOf('Three');

// ---- scrub safety: whatever a frozen block shows must be a PREFIX of what the final render shows (a frozen block can never be un-shown) ----
function frozenPrefixes(text, step) {
  const el = new N(1);
  const r = createStreamRenderer(el, rendererOpts(baseRender));
  const bad = [];
  const finalHtml = gaps(baseRender(text));
  for (let n = step; n < text.length + step; n += step) {
    r.update(text.slice(0, Math.min(n, text.length)));
    const frozen = [];
    for (const c of el.childNodes) { if (c.nodeType === 8) break; frozen.push(c.html || ''); }
    const f = gaps(frozen.join(''));
    if (f && !finalHtml.startsWith(f)) { bad.push({ at: n, frozen: f.slice(-120) }); break; }
  }
  r.finalize();
  return { bad, parity: gaps(el.innerHTML) === finalHtml };
}
const SCRUB_CASES = {
  asideSpanningBlocks: 'The kitchen is quiet.\n\n((Production: the first part of a long aside.\n\nthe second part continues here.\n\nand the third part ends it.)) \n\nSomeone laughs near the sink.\n\nA door opens.',
  npcIdLine: 'The kitchen is quiet.\n\nnpc:3 walks over and says hello.\n\nSomeone laughs near the sink.\n\nA door opens.',
  operatorAsideMiddle: 'The kitchen is quiet.\n\nLet me call advanceGame and see what surfaces.\n\nSomeone laughs near the sink.\n\nA door opens and closes.',
  operatorAsideStandalone: 'The kitchen is quiet.\n\nI should check the tool results before answering.\n\nSomeone laughs near the sink.\n\nA door opens and closes.',
};
out.scrub = {};
for (const [k, t] of Object.entries(SCRUB_CASES)) out.scrub[k] = frozenPrefixes(t, 3);
const fin = (t) => baseRender(t);
out.scrubActive = { npc: !fin(SCRUB_CASES.npcIdLine).includes('npc:3'), op: !fin(SCRUB_CASES.operatorAsideMiddle).includes('advanceGame'), aside: !fin(SCRUB_CASES.asideSpanningBlocks).includes('second part continues') || fin(SCRUB_CASES.asideSpanningBlocks).includes('ooc') };

// ---- speech (game build): a speaker line's indent run and F-6's restatement collapse depend on OTHER paragraphs of the reply ----------
// The live DOM must equal a full render of the same text at EVERY step (what the pre-ORW-156 full re-render showed), and a window that
// joins late (one update with all the text so far) must paint the same DOM as one that streamed it delta by delta (ship gate F5).
function liveEqualsFull(text, step) {
  const el = new N(1);
  const r = createStreamRenderer(el, rendererOpts(baseRender));
  let frozenMax = 0;
  for (let n = step; n < text.length + step; n += step) {
    const cur = text.slice(0, Math.min(n, text.length));
    r.update(cur);
    let frozen = 0;
    for (const c of el.childNodes) { if (c.nodeType === 8) break; frozen++; }
    frozenMax = Math.max(frozenMax, frozen);
    const got = gaps(el.innerHTML); const want = gaps(baseRender(cur));
    if (got !== want) return { at: n, got: got.slice(-200), want: want.slice(-200), frozenMax };
  }
  return { at: null, frozenMax };
}
function lateJoinMatches(text, step) {
  const bad = [];
  for (const cut of [Math.floor(text.length / 3), Math.floor((2 * text.length) / 3), text.length]) {
    const cur = text.slice(0, cut);
    const s = new N(1); const rs = createStreamRenderer(s, rendererOpts(baseRender));
    for (let n = step; n < cur.length + step; n += step) rs.update(cur.slice(0, Math.min(n, cur.length)));   // the sender, delta by delta
    const b = new N(1); const rb = createStreamRenderer(b, rendererOpts(baseRender));
    rb.update(cur);                                                                                          // a mirror joining now
    if (gaps(s.innerHTML) !== gaps(b.innerHTML)) bad.push({ cut, sender: gaps(s.innerHTML).slice(-160), mirror: gaps(b.innerHTML).slice(-160) });
  }
  return bad;
}
const LINE = 'I have been thinking about the vote all night and I keep landing on the same name every time';
const SPEECH_CASES = {
  // a speaker line, then untagged paragraphs: every one is indented as the same speech (`ow-speaker-cont`)
  continuation: 'The kitchen is quiet this morning.\n\nThe coffee maker gurgles.\n\n@[Maya Ortiz] "Hey, you are up early."\n\nShe pours a second mug and slides it across the counter.\n\n"Could not sleep either?"\n\nThe fridge hums behind her.\n\nShe waits for an answer.',
  // the paragraph that hands off to the next speaker is NOT indented
  handOff: '@[Maya Ortiz] "Hey."\n\nShe pours coffee.\n\nAcross the room, Marcus scoffs.\n\n@[Marcus Chen] "Morning, sunshine."\n\nHe grins.\n\nNobody laughs.',
  // F-6 (Greptile on #2260): the same speaker restating an earlier block is dropped by the full render, so it must never show live
  restated: `The kitchen is quiet.\n\n@[Maya Ortiz] "${LINE}."\n\nThe dishwasher clicks over to its rinse cycle.\n\n@[Maya Ortiz] "${LINE}."\n\nShe sets her mug down.\n\nThe room goes still.`,
  // an aside opened on one line and closed on the next: whether the cut BEFORE its block is safe changes as the block arrives
  asideMultiLine: 'The kitchen is quiet.\n\nSomeone laughs near the sink.\n\n((Production: a note that opens here\nand closes on this line.)) The narration goes on.\n\nA door opens.\n\nThe end.',
};
out.speech = {};
for (const [k, t] of Object.entries(SPEECH_CASES)) out.speech[k] = { live: liveEqualsFull(t, 3), lateJoin: lateJoinMatches(t, 3) };
// non-vacuity: the settled render really does collapse the restatement (the quote appears once), and really does indent continuations
out.speechQuoteCountSettled = baseRender(SPEECH_CASES.restated).split('the same name every time').length - 1;
out.speechContIndented = baseRender(SPEECH_CASES.continuation).includes('ow-speaker-cont');
// an aside marker also stops a completed code fence from freezing (the fence branch used to skip the aside check)
const ASIDE_FENCE = 'Intro line.\n\n((Production: an aside that opens here\n\n```\ncode inside\n```\n\nand closes later.)) Then the tail.\n\nMore.';
out.asideFenceCommitted = seg.splitFinalized(ASIDE_FENCE, baseRender, 0, new Map());
out.asideAt = ASIDE_FENCE.indexOf('((');
// ---- random game replies (fixed seed): two windows paint the same DOM at EVERY step, and the stream settles to the full render ---------
// A window that joins at any moment (one update with everything so far) must match the window that streamed it; this is what ship gate
// F5 needs from the renderer, whatever mix of speech, narration, lists, quotes, headings, code fences and scrubbed lines a reply has.
{
  let seed = 156; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; const pick = (a) => a[Math.floor(rnd() * a.length)];
  let u = 0; const fresh = () => `line ${++u} with ${u * 7} new words for ${u + 3} people`;
  const PIECES = [
    () => `@[${pick(SPEAKERS)}] "${fresh()}."`, () => `@[${pick(SPEAKERS)}] "${LINE}."`, () => `@[${pick(SPEAKERS)}]`,
    () => `She ${fresh()}.`, () => `The kitchen ${fresh()}.\nIt goes on ${fresh()}.`, () => `"${fresh()}," he says.`,
    () => `- item ${fresh()}\n- another ${fresh()}`, () => `> quoted ${fresh()}`, () => `## A heading ${u}`,
    () => 'Let me call advanceGame and see what surfaces.', () => `npc:3 ${fresh()}.`, () => '```\ncode ' + fresh() + '\n```',
  ];
  let stepMismatch = 0; let endMismatch = 0; let cases = 0; let firstBad = null;
  for (let n = 0; n < 30; n++) {
    const parts = []; const k = 3 + Math.floor(rnd() * 6); for (let i = 0; i < k; i++) parts.push(pick(PIECES)());
    const text = parts.join('\n\n'); const step = 1 + Math.floor(rnd() * 5); cases++;
    const a = new N(1); const ra = createStreamRenderer(a, rendererOpts(baseRender));
    for (let i = step; i < text.length + step; i += step) {
      const cur = text.slice(0, Math.min(i, text.length)); ra.update(cur);
      const b = new N(1); createStreamRenderer(b, rendererOpts(baseRender)).update(cur);
      if (gaps(a.innerHTML) !== gaps(b.innerHTML)) { stepMismatch++; if (!firstBad) firstBad = { text, at: i, a: gaps(a.innerHTML).slice(-160), b: gaps(b.innerHTML).slice(-160) }; break; }
    }
    // a reply whose LAST line is a bare `@[Name]` tag is the one known exception: markdown.js anchors such a trailing tag backward onto the
    // line before it, which can move the hand-off one paragraph back after that paragraph froze; both windows still agree, and the settled
    // re-render (chat.js rebuilds the finished message from source) corrects the indent
    const bareTagEnd = /(^|\n)[ \t]*@\[[^\]\n]*\][ \t]*$/.test(text);
    if (!bareTagEnd && gaps(a.innerHTML) !== gaps(baseRender(text))) { endMismatch++; if (!firstBad) firstBad = { text, end: true, a: gaps(a.innerHTML).slice(-160), want: gaps(baseRender(text)).slice(-160) }; }
  }
  out.random = { cases, stepMismatch, endMismatch, firstBad };
}
// ---- the restatement watch makes exactly F-6's decision (markdown.js keeps the rules in two places: _collapseRestatedReply stays
// self-contained, and createRestatementWatch is its incremental twin). Extract the real function from the source and compare. -------------
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(dir + '/markdown.js', 'utf8');
  const at = src.indexOf('function _collapseRestatedReply(text) {');
  const collapse = new Function(src.slice(at, src.indexOf('\n}\n', at) + 2) + '\nreturn _collapseRestatedReply;')();
  let seed = 4242; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; const pick = (a) => a[Math.floor(rnd() * a.length)];
  const LINES = [LINE, 'You heard what happened in the kitchen last night and what she said about the plan', 'I am not putting my name on that plan until I see the numbers for myself'];
  let u = 0;
  const para = () => (rnd() < 0.6
    ? `@[${pick(SPEAKERS)}] "${rnd() < 0.75 ? pick(LINES) : `fresh line ${++u} with ${u * 3} words and ${u + 5} more`}."`
    : `She ${rnd() < 0.3 ? 'nods.' : `turns away for the ${++u}th time.`}`);
  let whole = 0; let prefix = 0; let falseNeg = 0; let collapsing = 0; const N = 150;
  for (let n = 0; n < N; n++) {
    const ps = []; const k = 2 + Math.floor(rnd() * 6); for (let i = 0; i < k; i++) ps.push(para());
    const text = ps.join('\n\n');
    const expect = collapse(text) !== text; if (expect) collapsing++;
    if (md.createRestatementWatch()(text) !== expect) whole++;                    // the same verdict on the whole text
    const w = md.createRestatementWatch();                                        // ...and at every paragraph-aligned prefix
    for (let i = 1; i <= ps.length; i++) { const pre = ps.slice(0, i).join('\n\n') + (i < ps.length ? '\n\n' : ''); if (w(pre) !== (collapse(pre) !== pre)) { prefix++; break; } }
    // random-size deltas: never miss a collapse (an early yes only costs speed)
    const wd = md.createRestatementWatch(); let said = false;
    for (let i = 1 + Math.floor(rnd() * 7); i < text.length + 7; i += 1 + Math.floor(rnd() * 7)) said = wd(text.slice(0, Math.min(i, text.length))) || said;
    if (expect && !said) falseNeg++;
  }
  out.watch = { cases: N, collapsing, whole, prefix, falseNeg };
}
console.log(JSON.stringify(out));
