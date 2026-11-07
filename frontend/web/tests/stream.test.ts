import { describe, expect, it, vi } from 'vitest';
import { FrameBatcher, type Scheduler } from '../src/stream/frameBatcher';
import { StreamController, type StreamSink } from '../src/stream/controller';
import { SseParser } from '../src/stream/sse';

function manualScheduler() {
  let cb: (() => void) | null = null;
  const sched: Scheduler = {
    request(f) {
      cb = f;
      return 1;
    },
    cancel() {
      cb = null;
    },
  };
  return { sched, frame: () => { const f = cb; cb = null; f?.(); }, pending: () => cb !== null };
}

function fakeSink() {
  const calls = { append: [] as Array<[string, string]>, commit: [] as Array<{ id: string | null; moment: string | null }>, adopt: [] as string[], pending: [] as unknown[], working: [] as Array<string | null> };
  const sink: StreamSink = {
    beginStream: vi.fn(),
    appendStream: (r, t) => calls.append.push([r, t]),
    setWorking: (l) => calls.working.push(l),
    adoptUserMessage: (c) => calls.adopt.push(c),
    commitStream: (s) => calls.commit.push(s),
    setPending: (p) => calls.pending.push(p),
  };
  return { sink, calls };
}

describe('FrameBatcher', () => {
  it('writes once per frame no matter how many deltas arrive', () => {
    const m = manualScheduler();
    const out: Array<[string, string]> = [];
    const b = new FrameBatcher((f) => out.push([f.reply, f.reasoning]), m.sched);
    for (let i = 0; i < 100; i++) b.add('x', false);
    b.add('think', true);
    expect(out).toHaveLength(0);
    m.frame();
    expect(out).toEqual([['x'.repeat(100), 'think']]);
    m.frame();
    expect(out).toHaveLength(1);
  });

  it('flush pushes the partial frame immediately', () => {
    const m = manualScheduler();
    const out: string[] = [];
    const b = new FrameBatcher((f) => out.push(f.reply), m.sched);
    b.add('abc', false);
    b.flush();
    expect(out).toEqual(['abc']);
    expect(m.pending()).toBe(false);
  });
});

describe('StreamController', () => {
  it('renders only non-thinking deltas into the reply; reasoning stays on its own channel', () => {
    const m = manualScheduler();
    const { sink, calls } = fakeSink();
    const c = new StreamController(sink, 'c-1', m.sched);
    c.handle({ delta: 'secret plan', thinking: true });
    c.handle({ delta: 'Hello ' });
    c.handle({ delta: 'world' });
    m.frame();
    expect(calls.append).toEqual([['Hello world', 'secret plan']]);
  });

  it('adopts the user row by clientMsgId and commits the saved id on settle', () => {
    const m = manualScheduler();
    const { sink, calls } = fakeSink();
    const c = new StreamController(sink, 'c-1', m.sched);
    c.handle({ type: 'user_message', id: 'u1', seq: 0, clientMsgId: 'c-1' });
    c.handle({ delta: 'Hi' });
    c.handle({ type: 'message_saved', id: 'a1', moment: 'Week 1 · Premiere' });
    c.handle('DONE');
    expect(calls.adopt).toEqual(['c-1']);
    expect(calls.append).toEqual([['Hi', '']]);
    expect(calls.commit).toEqual([{ id: 'a1', moment: 'Week 1 · Premiere' }]);
    expect(c.outcome.sawSaved).toBe(true);
  });

  it('finish is idempotent (a double [DONE] never commits twice)', () => {
    const { sink, calls } = fakeSink();
    const c = new StreamController(sink, null, manualScheduler().sched);
    c.handle('DONE');
    c.handle('DONE');
    expect(calls.commit).toHaveLength(1);
  });

  it('surfaces a pending decision pushed by the stream', () => {
    const { sink, calls } = fakeSink();
    const c = new StreamController(sink, null, manualScheduler().sched);
    c.handle({ type: 'orwell_pending', pending: { kind: 'nominations', options: [] } });
    expect(calls.pending).toEqual([{ kind: 'nominations', options: [] }]);
  });

  it('flags an error event and counts events for the resume cursor (run-started excluded)', () => {
    const { sink } = fakeSink();
    const c = new StreamController(sink, null, manualScheduler().sched);
    c.handle({ type: 'run-started', runId: 'r1' });
    c.handle({ delta: 'a' });
    c.handle({ delta: 'b' });
    expect(c.outcome.count).toBe(2);
    expect(c.outcome.runId).toBe('r1');
    c.handle({ text: 'boom' }, true);
    expect(c.outcome.failed).toBe(true);
  });
});

describe('SseParser', () => {
  it('handles payloads split across chunks and [DONE]', () => {
    const p = new SseParser();
    expect(p.push('data: {"delta":"He')).toEqual([]);
    const out = p.push('llo"}\n\ndata: [DONE]\n\n');
    expect(out).toEqual([
      { data: { delta: 'Hello' }, error: false },
      { data: 'DONE', error: false },
    ]);
  });

  it('marks the payload after `event: error`', () => {
    const p = new SseParser();
    expect(p.push('event: error\ndata: {"text":"x"}\n\n')).toEqual([{ data: { text: 'x' }, error: true }]);
  });
});
