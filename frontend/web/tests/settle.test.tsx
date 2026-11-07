import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageView } from '../src/components/Message';
import { renderLive, renderReply } from '../src/markdown/render';
import { initialState, useStore } from '../src/store/gameStore';
import type { ChatRow } from '../src/store/types';

const visible = (blocks: string[]) => blocks.join('').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const secret = /user wants|privately|flip on|vote count/i;

beforeEach(() => {
  document.body.setAttribute('data-game-build', '1');
  useStore.setState({ ...initialState });
});

/** A turn that ends inside an open <think> (Stop, dropped connection, out of tokens) is committed as-is; render the stored row. */
function commitAndRender(buffer: string): { text: string; html: string } {
  const s = useStore.getState();
  s.beginStream('c-1');
  s.appendStream(buffer, '');
  s.commitStream({ id: 'a1', moment: null });
  const row = useStore.getState().rows[0];
  const text = row?.text ?? '';
  const html = renderToStaticMarkup(<MessageView row={row as ChatRow} />);
  return { text, html };
}

describe('a turn that ends inside an open <think> never shows the reasoning', () => {
  it('leading unclosed think (Stop pressed mid-think)', () => {
    const { text, html } = commitAndRender('<think>The user wants the vote count. Natalia privately told production she will flip on Marcus');
    expect(visible(renderReply(text).blocks)).toBe('');
    expect(html).not.toMatch(secret);
    expect(html).toBe(''); // no bubble at all, not an empty one
  });

  it('single-line open think', () => {
    const { text, html } = commitAndRender('<think>The user wants the vote count and Natalia will flip on Marcus');
    expect(visible(renderReply(text).blocks)).toBe('');
    expect(html).not.toMatch(secret);
  });

  it('text before the open think stays; the rest is hidden', () => {
    const { text, html } = commitAndRender('Natalia nods slowly.\n\n<think>The user wants the vote count');
    expect(visible(renderReply(text).blocks)).toBe('Natalia nods slowly.');
    expect(html).toContain('Natalia nods slowly.');
    expect(html).not.toMatch(secret);
  });

  it('a Gemma-style channel block that never closes', () => {
    const { text, html } = commitAndRender('<|channel>thought\nThe user wants the vote count, privately');
    expect(visible(renderReply(text).blocks)).toBe('');
    expect(html).not.toMatch(secret);
  });

  it('the settled render agrees with the last live frame (nothing appears at settle that was hidden live)', () => {
    const buf = 'Natalia nods.\n\n<think>The user wants the vote count';
    expect(visible(renderReply(buf).blocks)).toBe(visible(renderLive(buf).blocks));
  });

  it('a closed think still behaves as before', () => {
    expect(visible(renderReply('<think>The user wants it</think>The house is quiet.').blocks)).toBe('The house is quiet.');
  });
});

describe('reasoning-only rows render no empty bubble (reasoning box is off in the game build)', () => {
  it('a row with only channel reasoning renders nothing', () => {
    const row: ChatRow = { key: 'a', id: 'a', seq: 1, role: 'assistant', text: '<think>planning</think>', reasoning: 'planning from the channel', clientMsgId: null, moment: null, state: 'sent' };
    expect(renderToStaticMarkup(<MessageView row={row} />)).toBe('');
  });
});

describe('partial openers never flash as literal tag text', () => {
  it.each(['<think time="2.1', '<think ', '<thinking time=', '<|channel>', '<|channel>tho', '<|channel>thought', '<thi', '</thin'])('%s', (frag) => {
    expect(visible(renderLive(`Natalia nods. ${frag}`).blocks)).toBe('Natalia nods.');
  });
});

describe('a turn stopped exactly mid-tag commits no tag fragment', () => {
  it.each(['<t', '<thinking', '</thi', '<think time="2.', '<|channel>'])('%s', (frag) => {
    const { text, html } = commitAndRender(`Natalia nods slowly. ${frag}`);
    expect(visible(renderReply(text).blocks)).toBe('Natalia nods slowly.');
    expect(html).not.toContain('&lt;');
  });
});
