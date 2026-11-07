import { beforeEach, describe, expect, it } from 'vitest';
import { cleanReasoning, renderReply, setRoster } from '../src/markdown/render';

const visible = (html: string[]) => html.join('').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

beforeEach(() => {
  document.body.setAttribute('data-game-build', '1');
  setRoster([]);
});

describe('reasoning never reaches the public bubble (whole reply, then blocks)', () => {
  it('strips an inline <think> that spans a blank line, and routes it to the reasoning box', () => {
    const r = renderReply('Intro.\n\n<think>secret plan A\n\nsecret plan B npc:7 hides</think>\n\nVisible.');
    const text = visible(r.blocks);
    expect(text).toContain('Intro.');
    expect(text).toContain('Visible.');
    expect(text).not.toMatch(/secret|hides|plan/);
    expect(r.reasoning).toContain('secret plan B');
    expect(r.reasoning).not.toMatch(/npc:7/);
  });

  it('hides everything after an unclosed opener while the think is still streaming', () => {
    const r = renderReply('Intro.\n\n<think>secret plan A\n\nsecret plan B');
    expect(visible(r.blocks)).toBe('Intro.');
  });

  it('handles several think spans and a Gemma-style channel block', () => {
    const r = renderReply('<think>first thought, long enough to be a real block of reasoning</think>A.\n\n<think>two\n\nthree</think>B.');
    expect(visible(r.blocks)).toBe('A. B.');
    const g = renderReply('<|channel>thought\nhidden stuff\n\nmore<channel|>Shown.');
    expect(visible(g.blocks)).toBe('Shown.');
  });

  it('a reply that is only reasoning renders no bubble text at all', () => {
    expect(renderReply('<think>just planning</think>').blocks).toEqual([]);
  });

  it('reasoning box text loses raw engine ids and their trailing separators', () => {
    expect(cleanReasoning('npc:3 - Faith Willis is angry; npc:9: Quinn')).toBe('Faith Willis is angry; Quinn');
  });
});

describe('engine machinery is scrubbed from the public bubble (classic wall, same code)', () => {
  it('drops tool-process sentences', () => {
    const t = visible(renderReply('Natalia nods slowly.\n\nThe engine will call updateCasting.\n\nShe smiles.').blocks);
    expect(t).not.toMatch(/engine|updateCasting/i);
    expect(t).toContain('Natalia nods');
    expect(t).toContain('She smiles');
  });

  it('removes a planning preamble and raw npc ids from the body', () => {
    const t = visible(renderReply("Let me check the roster.\nnpc:4 - Cassandra Stout\n\nCassandra laughs at the joke.").blocks);
    expect(t).not.toMatch(/npc:|roster/i);
    expect(t).toContain('Cassandra laughs');
  });
});

describe('OOC asides', () => {
  it('renders a whole-message ((...)) wrap as a producer aside, without the parentheses', () => {
    const r = renderReply('((Quick word from production: we are pausing for a moment.))');
    expect(r.blocks.join('')).toContain('ooc-producer-aside');
    expect(visible(r.blocks)).not.toContain('((');
  });

  it('splits a leading ((...)) block from the in-character prose after it', () => {
    const r = renderReply('((Production note.))\n\nJuan shrugs.');
    expect(r.blocks.join('')).toContain('ooc-producer-aside');
    expect(visible(r.blocks)).toContain('Juan shrugs.');
    expect(visible(r.blocks)).not.toContain('))');
  });
});

describe('speaker chips (classic implementation)', () => {
  it('a tag becomes a chip and the name stays visible', () => {
    const r = renderReply('@[Juan Wong] leans on the island. "Big night."');
    const html = r.blocks.join('');
    expect(html).toContain('ow-speaker-chip');
    expect(visible(r.blocks)).toContain('Juan Wong');
    expect(html).not.toContain('@[');
  });

  it('does not repeat the name when the narrator wrote it right after the tag', () => {
    const t = visible(renderReply('@[Juan Wong] **Juan Wong** grins.').blocks);
    expect(t.match(/Juan Wong/g)?.length).toBe(1);
  });

  it('adds a face to a bold roster name only when it is an exact roster match', () => {
    setRoster([{ id: 'npc:5', name: 'Asher Reese' }]);
    expect(renderReply('**Asher Reese** shrugs.').blocks.join('')).toContain('ow-speaker-chip');
    expect(renderReply('**Warning** shrugs.').blocks.join('')).not.toContain('ow-speaker-chip');
  });

  it('never chips a tag inside a code fence', () => {
    expect(renderReply('```\n@[Juan Wong] hi\n```').blocks.join('')).not.toContain('ow-speaker-chip');
  });

  it('a chip placeholder cannot be forged from model text', () => {
    const html = renderReply('[link](http://example.com/QQOWSPK0QQ) and QQOWSPK0QQ').blocks.join('');
    expect(html).not.toContain('ow-speaker-chip');
  });
});

describe('sanitising', () => {
  it('removes scripts and event handlers', () => {
    const host = document.createElement('div');
    host.innerHTML = renderReply('<img src=x onerror=alert(1)> <script>alert(1)</script> [x](javascript:alert(1)) ok').blocks.join('');
    expect(host.querySelector('script, img')).toBeNull();
    expect(host.querySelector('[onerror]')).toBeNull();
    host.querySelectorAll('a').forEach((a) => expect(a.getAttribute('href') ?? '').not.toMatch(/^javascript:/i));
  });
  it('links open safely', () => {
    expect(renderReply('[x](https://example.com)').blocks.join('')).toMatch(/rel="noopener noreferrer"/);
  });
});

describe('block stability while streaming (what makes memoisation work)', () => {
  it('finished blocks keep the same HTML as the reply grows', () => {
    const full = 'First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph is gro';
    const a = renderReply(full.slice(0, 50)).blocks;
    const b = renderReply(full).blocks;
    expect(b.length).toBeGreaterThanOrEqual(2);
    expect(b[0]).toBe(a[0]);
  });
});

import { renderLive } from '../src/markdown/render';

/** Feed the text frame by frame (as the stream does) and return what was visible after each frame. */
function frames(full: string, step = 3): string[] {
  const out: string[] = [];
  for (let i = step; i < full.length + step; i += step) out.push(visible(renderLive(full.slice(0, i)).blocks));
  return out;
}

describe('live stream: reasoning never paints, frame by frame (and nothing shown is ever taken back)', () => {
  const secret = /user wants|vote count|privately|flip on|Thinking Process|plan the scene/i;

  function check(full: string, expectFinal: string) {
    const f = frames(full);
    for (const frame of f) expect(frame).not.toMatch(secret);
    // never taken back: every frame's text is a prefix-compatible growth of the previous one
    for (let i = 1; i < f.length; i++) {
      const prev = f[i - 1] ?? '';
      const cur = f[i] ?? '';
      expect(cur.startsWith(prev.slice(0, Math.max(0, prev.length - 4)))).toBe(true);
    }
    expect(f[f.length - 1]).toBe(expectFinal);
  }

  it('an unclosed LEADING <think> (multi-line) shows nothing until it closes', () => {
    check('<think>The user wants the vote count.\nNatalia privately told production she will flip on Marcus.\n\nMore planning.</think>\n\nThe house goes quiet.', 'The house goes quiet.');
  });

  it('a single-line open <think> shows nothing until it closes', () => {
    check('<think>The user wants the vote count and Natalia will flip on Marcus</think>The house goes quiet.', 'The house goes quiet.');
  });

  it('a plain "Thinking Process:" preamble shows nothing until a reply starts', () => {
    const full = 'Thinking Process: The user wants the vote count, so I should plan the scene first.\n\nHello everyone, the house goes quiet.';
    check(full, 'Hello everyone, the house goes quiet.');
    // not even the label ("Thi", "Thinking") flashes before the reply starts
    expect(frames(full).every((x) => !/^Th/.test(x))).toBe(true);
  });

  it('text before an unclosed opener stays visible; only the opener onward is hidden', () => {
    const r = renderLive('Natalia nods.\n\n<think>The user wants the vote count');
    expect(visible(r.blocks)).toBe('Natalia nods.');
    expect(r.reasoning).toContain('vote count');
  });

  it('a partial opener at the end of the buffer never flashes', () => {
    expect(visible(renderLive('Natalia nods. <thi').blocks)).toBe('Natalia nods.');
    expect(visible(renderLive('Natalia nods. </thin').blocks)).toBe('Natalia nods.');
  });

  it('<think></think> followed by thinking outside the tags stays hidden until the real closer', () => {
    expect(visible(renderLive('<think></think>\nThe user wants the vote count and more thoughts').blocks)).toBe('');
  });

  it('a normal reply streams through untouched', () => {
    const full = 'Juan shrugs.\n\nThe room hums with quiet tension.';
    const f = frames(full);
    expect(f[f.length - 1]).toBe('Juan shrugs. The room hums with quiet tension.');
  });
});
