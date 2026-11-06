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
