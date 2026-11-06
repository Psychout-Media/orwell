import { describe, expect, it, beforeEach } from 'vitest';
import { extractSpeakerTags, restoreSpeakerChips, setKnownNames } from '../src/markdown/speakers';
import { renderBlock, invalidateRenderCache } from '../src/markdown/render';

describe('speaker chips', () => {
  beforeEach(() => {
    setKnownNames([]);
    invalidateRenderCache();
  });

  it('turns a line-leading tag into a chip and keeps the name visible', () => {
    const html = renderBlock('@[Juan Wong] grins at the camera.');
    expect(html).toContain('ow-chip');
    expect(html).toContain('<strong class="ow-speaker-name">Juan Wong</strong>');
    expect(html).toContain('grins at the camera');
    expect(html).not.toContain('@[');
  });

  it('does not repeat the name when the narrator already wrote it after the tag', () => {
    const { chips } = extractSpeakerTags('@[Juan Wong] **Juan Wong** grins.');
    expect(chips[0]?.showName).toBe(false);
    const html = renderBlock('@[Juan Wong] **Juan Wong** grins.');
    const visible = html.replace(/<[^>]*>/g, '');
    expect((visible.match(/Juan Wong/g) ?? []).length).toBe(1);
  });

  it('keeps the colon a tag swallowed', () => {
    const html = renderBlock('@[Summer Mccann]: "Hi."');
    expect(html).toContain('Summer Mccann</strong>:');
  });

  it('never chips a tag inside a code fence', () => {
    const { chips, text } = extractSpeakerTags('```\n@[Juan Wong] hi\n```');
    expect(chips).toHaveLength(0);
    expect(text).toContain('@[Juan Wong]');
  });

  it('swallows a dangling partial tag at the end of a streaming buffer', () => {
    expect(extractSpeakerTags('Hello @[Jua').text).toBe('Hello ');
  });

  it('adds a face to a roster name written in bold, keeping the bold text', () => {
    setKnownNames(['Asher Reese']);
    const html = renderBlock('**Asher Reese** shrugs.');
    expect(html).toContain('ow-chip');
    expect(html).toContain('<strong>Asher Reese</strong>');
  });

  it('leaves bold text alone when it is not an exact roster name', () => {
    setKnownNames(['Asher Reese']);
    expect(renderBlock('**Warning** shrugs.')).not.toContain('ow-chip');
  });

  it('restoreSpeakerChips leaves html untouched with no chips', () => {
    expect(restoreSpeakerChips('<p>x</p>', [])).toBe('<p>x</p>');
  });

  it('strips raw npc ids and inline think tags from the public bubble', () => {
    const html = renderBlock('Hi npc:12 there <think>secret plan</think> friend');
    expect(html).not.toMatch(/npc:12/);
    expect(html).not.toContain('secret plan');
  });

  it('sanitises script and event-handler markup', () => {
    const html = renderBlock('<img src=x onerror=alert(1)> <script>alert(1)</script> ok');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
  });
});
