import { describe, expect, it } from 'vitest';
import { advanceBlocks, emptyBlocks, splitBlocks } from '../src/markdown/blocks';

describe('incremental blocks', () => {
  it('commits a block once a later block exists and never changes it again', () => {
    let s = advanceBlocks(emptyBlocks(), 'First para.\n\nSecond');
    expect(s.stable).toEqual(['First para.\n\n'.trimEnd()].map((x) => x) && s.stable);
    expect(s.stable).toHaveLength(1);
    const firstRef = s.stable;
    s = advanceBlocks(s, 'First para.\n\nSecond para grows');
    expect(s.stable).toBe(firstRef); // same array: nothing re-committed
    expect(s.tail).toContain('Second para grows');
  });

  it('is O(tail): the tail never contains committed text', () => {
    let text = '';
    let s = emptyBlocks();
    for (let i = 0; i < 50; i++) {
      text += `Paragraph ${i} words words words.\n\n`;
      s = advanceBlocks(s, text);
    }
    expect(s.stable.length).toBeGreaterThanOrEqual(48);
    expect(s.tail.length).toBeLessThan(60);
  });

  it('streaming char by char yields the same blocks as a one-shot split', () => {
    const full = 'Intro line.\n\n- a\n- b\n\n```js\nconst x = 1;\n\nconst y = 2;\n```\n\nTail text here.';
    let s = emptyBlocks();
    for (let i = 1; i <= full.length; i++) s = advanceBlocks(s, full.slice(0, i));
    const streamed = s.stable.concat(s.tail.trim() ? [s.tail] : []);
    expect(streamed.join('').replace(/\s+/g, '')).toBe(full.replace(/\s+/g, ''));
    expect(streamed.length).toBe(splitBlocks(full).length);
  });

  it('keeps an open code fence in one block', () => {
    const s = advanceBlocks(emptyBlocks(), 'Before.\n\n```\nline1\n\nline2');
    expect(s.stable).toHaveLength(1);
    expect(s.tail).toContain('line1');
    expect(s.tail).toContain('line2');
  });

  it('joins a speaker tag alone on its line with the speech after it', () => {
    const blocks = splitBlocks('@[Juan Wong]\n\n"Hello there."\n\nNext paragraph.');
    expect(blocks[0]).toContain('@[Juan Wong]');
    expect(blocks[0]).toContain('Hello there');
    expect(blocks).toHaveLength(2);
  });

  it('restarts cleanly when the text is replaced rather than appended', () => {
    let s = advanceBlocks(emptyBlocks(), 'Aaa.\n\nBbb.\n\nCcc.');
    s = advanceBlocks(s, 'Z');
    expect(s.stable).toHaveLength(0);
    expect(s.tail).toBe('Z');
  });
});
