import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendMessage } from '../src/store/chat';
import { initialState, useStore } from '../src/store/gameStore';
import { loadOutbox } from '../src/store/outbox';
import { setUnauthorizedHandler } from '../src/api/http';

function mockFetch(chatStatus: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).startsWith('/api/chat_stream')) return new Response('refused', { status: chatStatus });
      if (String(url).startsWith('/api/history/')) return new Response(JSON.stringify({ history: [] }), { status: 200 });
      return new Response('{}', { status: 200 });
    }),
  );
}

beforeEach(() => {
  sessionStorage.clear();
  useStore.setState({ ...initialState, sessionId: 'S1', boot: 'ready', auth: 'ok' });
  setUnauthorizedHandler(() => useStore.getState().setAuth('loggedOut'));
});
afterEach(() => vi.unstubAllGlobals());

describe('a refused send never loses the message', () => {
  it('401: stays in the outbox and on screen, and the app shows the sign-in screen', async () => {
    mockFetch(401);
    await sendMessage('I wave hello');
    const s = useStore.getState();
    expect(s.auth).toBe('loggedOut');
    expect(loadOutbox().map((i) => i.text)).toEqual(['I wave hello']);
    expect(s.rows.map((r) => [r.text, r.state])).toEqual([['I wave hello', 'failed']]);
  });

  it('409: stays in the outbox (the board moved; it is retried, not dropped)', async () => {
    mockFetch(409);
    await sendMessage('I wave hello');
    expect(loadOutbox()).toHaveLength(1);
    expect(useStore.getState().rows[0]?.state).toBe('failed');
  });

  it('413: released from the outbox, the bubble is taken back and the text returns to the composer', async () => {
    mockFetch(413);
    await sendMessage('a very long message');
    const s = useStore.getState();
    expect(loadOutbox()).toEqual([]);
    expect(s.rows).toEqual([]);
    expect(s.draft).toBe('a very long message');
  });
});
