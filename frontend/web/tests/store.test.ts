import { beforeEach, describe, expect, it } from 'vitest';
import { initialState, useStore } from '../src/store/gameStore';
import { isSkippableUserPrompt, mergeHistory, rowsFromHistory } from '../src/store/merge';
import { loadOutbox, pendingFor, releaseSend, trackSend, type KV } from '../src/store/outbox';
import { nextDelay } from '../src/store/poller';
import { buildPayload } from '../src/components/DecisionCard';
import { statusView } from '../src/components/format';

function memKv(): KV {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

beforeEach(() => useStore.setState({ ...initialState }));

describe('history rows', () => {
  it('orders by seq, drops housekeeping prompts, empty replies and non-chat roles', () => {
    const rows = rowsFromHistory([
      { role: 'assistant', content: 'Second', metadata: { _db_id: 'b', _seq: 1 } },
      { role: 'user', content: 'First', metadata: { _db_id: 'a', _seq: 0, client_msg_id: 'c-1' } },
      { role: 'user', content: 'Continue where you left off', metadata: { _seq: 2 } },
      { role: 'assistant', content: '   ', metadata: { _seq: 3 } },
      { role: 'tool', content: 'x', metadata: { _seq: 4 } },
    ]);
    expect(rows.map((r) => r.text)).toEqual(['First', 'Second']);
    expect(rows[0]?.clientMsgId).toBe('c-1');
  });

  it('keeps the raw reply; the renderer scrubs the whole reply before splitting it into blocks', () => {
    const [row] = rowsFromHistory([{ role: 'assistant', content: '<think>plan</think>Hello', metadata: { _seq: 0, thinking: 'channel reasoning' } }]);
    expect(row?.text).toBe('<think>plan</think>Hello');
    expect(row?.reasoning).toBe('channel reasoning');
  });

  it('recognises housekeeping prompts', () => {
    expect(isSkippableUserPrompt('(Production cue: x)')).toBe(true);
    expect(isSkippableUserPrompt('I wave.')).toBe(false);
  });
});

describe('mergeHistory (no lost or doubled messages)', () => {
  const sending = { key: 'c-9', id: null, seq: null, role: 'user' as const, text: 'hi', reasoning: '', clientMsgId: 'c-9', moment: null, state: 'sending' as const };

  it('keeps a still-unsent local row after the server rows', () => {
    const server = rowsFromHistory([{ role: 'user', content: 'old', metadata: { _db_id: 'a', _seq: 0 } }]);
    expect(mergeHistory([sending], server).map((r) => r.text)).toEqual(['old', 'hi']);
  });

  it('does not double a local row once the server row carries its clientMsgId', () => {
    const server = rowsFromHistory([{ role: 'user', content: 'hi', metadata: { _db_id: 'a', _seq: 0, client_msg_id: 'c-9' } }]);
    const merged = mergeHistory([sending], server);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe('a');
  });
});

describe('store actions', () => {
  it('adoptUserMessage marks the optimistic row sent and re-keys it', () => {
    const s = useStore.getState();
    s.addLocalRow({ key: 'c-1', id: null, seq: null, role: 'user', text: 'hi', reasoning: '', clientMsgId: 'c-1', moment: null, state: 'sending' });
    s.addLocalRow({ key: 'c-1', id: null, seq: null, role: 'user', text: 'hi', reasoning: '', clientMsgId: 'c-1', moment: null, state: 'sending' });
    expect(useStore.getState().rows).toHaveLength(1);
    s.adoptUserMessage('c-1', 'srv-1', 4);
    const r = useStore.getState().rows[0];
    expect(r).toMatchObject({ id: 'srv-1', seq: 4, key: 'srv-1', state: 'sent' });
  });

  it('streams reply and reasoning separately and commits only the public text to a row', () => {
    const s = useStore.getState();
    s.beginStream('c-1');
    s.appendStream('Hello ', 'private ');
    s.appendStream('world', 'thoughts');
    expect(useStore.getState().stream).toMatchObject({ reply: 'Hello world', reasoning: 'private thoughts' });
    s.commitStream({ id: 'a1', moment: null });
    const st = useStore.getState();
    expect(st.stream).toBeNull();
    expect(st.rows[0]?.text).toBe('Hello world');
    expect(st.rows[0]?.reasoning).toBe('private thoughts');
  });

  it('never commits an empty bubble', () => {
    const s = useStore.getState();
    s.beginStream(null);
    s.commitStream({ id: 'a1', moment: null });
    expect(useStore.getState().rows).toHaveLength(0);
  });
});

describe('outbox', () => {
  it('survives a reload, drains only into its own session, and releases on delivery', () => {
    const kv = memKv();
    trackSend({ clientMsgId: 'c-1', sessionId: 'S1', text: 'a', ts: 1 }, kv);
    trackSend({ clientMsgId: 'c-2', sessionId: 'S2', text: 'b', ts: 2 }, kv);
    trackSend({ clientMsgId: 'c-1', sessionId: 'S1', text: 'a', ts: 1 }, kv); // idempotent
    expect(loadOutbox(kv)).toHaveLength(2);
    expect(pendingFor('S1', new Set(), kv).map((i) => i.clientMsgId)).toEqual(['c-1']);
    // the server now has c-1: it is released, c-2 (another session) is untouched
    expect(pendingFor('S1', new Set(['c-1']), kv)).toEqual([]);
    expect(loadOutbox(kv).map((i) => i.clientMsgId)).toEqual(['c-2']);
    releaseSend('c-2', kv);
    expect(loadOutbox(kv)).toEqual([]);
  });
});

describe('poller backoff', () => {
  it('doubles per failure and caps', () => {
    expect(nextDelay(0)).toBe(20_000);
    expect(nextDelay(1)).toBe(40_000);
    expect(nextDelay(10)).toBe(120_000);
  });
});

describe('decision payloads match the classic client', () => {
  it('nominations need exactly two', () => {
    const p = { kind: 'nominations' };
    expect(buildPayload(p, { sel: ['a'], text: '' })).toBeNull();
    expect(buildPayload(p, { sel: ['a', 'b'], text: '' })).toEqual({ kind: 'nominations', choice: ['a', 'b'] });
  });
  it('veto: use with a save, or decline', () => {
    const p = { kind: 'veto-decision' };
    expect(buildPayload(p, { sel: ['npc:3'], text: '' })).toEqual({ kind: 'veto-decision', use: true, save: 'npc:3' });
    expect(buildPayload(p, { sel: ['__dont__'], text: '' })).toEqual({ kind: 'veto-decision', use: false });
  });
  it('eviction vote rides `vote`; comp intent rides `intent`; goodbye carries tone and words', () => {
    expect(buildPayload({ kind: 'eviction-vote' }, { sel: ['npc:2'], text: '' })).toEqual({ kind: 'eviction-vote', vote: 'npc:2' });
    expect(buildPayload({ kind: 'comp-intent' }, { sel: ['compete'], text: '' })).toEqual({ kind: 'comp-intent', intent: 'compete' });
    expect(buildPayload({ kind: 'goodbye-message' }, { sel: ['warm'], text: 'bye' })).toEqual({ kind: 'goodbye-message', vote: 'warm', statement: 'bye' });
  });
});

describe('status bar view', () => {
  it('shows week, day, time of day and phase when present', () => {
    expect(statusView({ started: true, week: 2, dayNumber: 9, timeOfDay: 'late-night', phase: 'eviction-night' })).toEqual({ week: 'Week 2', day: 'Day 9', timeOfDay: 'Late Night', phase: 'Eviction Night' });
  });
  it('is empty before a game starts', () => {
    expect(statusView({ started: false })).toEqual({ day: null, timeOfDay: null, phase: null, week: null });
  });
});

describe('decision cards show what the player must see', () => {
  it('has a cue for each kind and a generic fallback', async () => {
    const { prefillCueFor } = await import('../src/components/DecisionCard');
    expect(prefillCueFor('nominations')).toMatch(/named my nominees/);
    expect(prefillCueFor('something-new')).toMatch(/made my decision/);
  });
});
