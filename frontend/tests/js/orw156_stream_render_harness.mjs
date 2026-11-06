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
  readyState: 'complete', addEventListener: noop, body: { hasAttribute: () => true, classList: { contains: () => false } },
  getElementById: () => null, querySelector: () => null,
  createElement: () => new N(1), createComment: () => new N(8), createTextNode: (d) => { const n = new N(3); n.data = d; return n; }, createTreeWalker: () => ({ nextNode: () => false }),
};
globalThis.localStorage = { getItem: () => null, setItem: noop };
globalThis.MutationObserver = class { observe() {} };

const md = await import(dir + '/markdown.js');
const { createStreamRenderer } = await import(dir + '/streamingRenderer.js');
const baseRender = (t) => md.processWithThinking(md.squashOutsideCode(t));
const gaps = (h) => h.replace(/>\s+</g, '><').trim();

const SENT = ['The kitchen hums with low voices. ', 'Someone laughs near the sink. ', 'A door opens and closes again. ', 'Footsteps cross the living room. '];
function prose(chars) { let t = ''; let i = 0; while (t.length < chars) { t += SENT[i % 4]; if (i % 4 === 3) t += '\n\n'; i++; } return t.trimEnd(); }

function run(text, step) {
  let calls = 0; let chars = 0;
  const render = (t) => { calls++; chars += t.length; return baseRender(t); };
  const el = new N(1);
  const r = createStreamRenderer(el, { render, hljs: null });
  let deltas = 0;
  for (let n = step; n < text.length + step; n += step) { r.update(text.slice(0, Math.min(n, text.length))); deltas++; }
  const beforeFinalizeBlocks = el.childNodes.filter((c) => c.html).length;
  r.finalize();
  return { calls, chars, deltas, frozenBlocksBeforeFinalize: beforeFinalizeBlocks, html: el.innerHTML };
}

const out = { cases: {} };
for (const n of [2000, 8000]) { const t = prose(n); const x = run(t, 4); out[`prose${n}`] = { calls: x.calls, chars: x.chars, deltas: x.deltas, len: t.length, parity: gaps(x.html) === gaps(baseRender(t)) }; }

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
// once the next block's first line is complete, the boundary before it is judged and frozen
out.proseCommittedLater = seg.splitFinalized(PROSE2 + ' now.\nmore', baseRender, 0, new Map());
out.proseSplitLater = PROSE2.indexOf('Three');
console.log(JSON.stringify(out));
