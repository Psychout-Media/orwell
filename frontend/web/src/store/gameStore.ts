// The one game store. Slices and who writes them:
//   auth, boot, sessionId, rows   <- chat/bootstrap + chat/send (actions below)
//   stream                        <- the stream controller only (one write per animation frame)
//   game, roster, pending, poll   <- the shared poller only (plus `orwell_pending` from the stream)
// Components read slices through selectors and never fetch on their own.
import { create } from 'zustand';
import type { GameState, Pending, RosterEntry } from '../api/types';
import type { AuthState, BootState, ChatRow, PlayState } from './types';
import { mergeHistory } from './merge';

export interface PlayActions {
  setAuth(a: AuthState): void;
  setBoot(b: BootState, error?: string | null): void;
  setSession(id: string | null): void;
  setRows(rows: ChatRow[]): void;
  reconcileRows(server: ChatRow[]): void;
  addLocalRow(row: ChatRow): void;
  adoptUserMessage(clientMsgId: string, id: string | null, seq: number | null): void;
  markFailed(clientMsgId: string): void;
  markSending(clientMsgId: string): void;
  beginStream(clientMsgId: string | null): void;
  appendStream(reply: string, reasoning: string): void;
  setWorking(label: string | null): void;
  /** Turn the live stream into a stored assistant row (the stream text is kept, never taken back). */
  commitStream(saved: { id: string | null; moment: string | null }): void;
  clearStream(): void;
  setGame(g: GameState): void;
  setRoster(r: RosterEntry[]): void;
  setPending(p: Pending | null): void;
  setPollHealthy(ok: boolean): void;
  removeRow(clientMsgId: string): void;
  setDraft(text: string | null): void;
}

export const initialState: PlayState = {
  auth: 'unknown',
  boot: 'loading',
  bootError: null,
  sessionId: null,
  rows: [],
  stream: null,
  game: null,
  roster: [],
  pending: null,
  pollHealthy: true,
  draft: null,
};

export const useStore = create<PlayState & PlayActions>()((set, get) => ({
  ...initialState,
  setAuth: (auth) => set({ auth }),
  setBoot: (boot, error = null) => set({ boot, bootError: error }),
  setSession: (sessionId) => set({ sessionId }),
  setRows: (rows) => set({ rows }),
  reconcileRows: (server) => set((s) => ({ rows: mergeHistory(s.rows, server) })),
  addLocalRow: (row) => set((s) => (s.rows.some((r) => r.clientMsgId && r.clientMsgId === row.clientMsgId && r.role === row.role) ? s : { rows: [...s.rows, row] })),
  adoptUserMessage: (clientMsgId, id, seq) =>
    set((s) => ({
      rows: s.rows.map((r) => (r.clientMsgId === clientMsgId && r.role === 'user' ? { ...r, id: id ?? r.id, seq: seq ?? r.seq, key: id ?? r.key, state: 'sent' as const } : r)),
    })),
  markFailed: (clientMsgId) => set((s) => ({ rows: s.rows.map((r) => (r.clientMsgId === clientMsgId && r.role === 'user' ? { ...r, state: 'failed' as const } : r)) })),
  markSending: (clientMsgId) => set((s) => ({ rows: s.rows.map((r) => (r.clientMsgId === clientMsgId && r.role === 'user' ? { ...r, state: 'sending' as const } : r)) })),
  beginStream: (clientMsgId) => set({ stream: { clientMsgId, reply: '', reasoning: '', working: null } }),
  appendStream: (reply, reasoning) =>
    set((s) => {
      const cur = s.stream ?? { clientMsgId: null, reply: '', reasoning: '', working: null };
      return { stream: { ...cur, reply: cur.reply + reply, reasoning: cur.reasoning + reasoning, working: reply ? null : cur.working } };
    }),
  setWorking: (working) => set((s) => (s.stream ? { stream: { ...s.stream, working } } : s)),
  commitStream: (saved) => {
    const st = get().stream;
    if (!st) return;
    const text = st.reply.trim();
    if (!text && !st.reasoning.trim()) {
      set({ stream: null });
      return;
    }
    const row: ChatRow = {
      key: saved.id ?? `live-${Date.now()}`,
      id: saved.id,
      seq: null,
      role: 'assistant',
      text,
      reasoning: st.reasoning,
      clientMsgId: null,
      moment: saved.moment,
      state: 'sent',
    };
    set((s) => ({ stream: null, rows: s.rows.some((r) => r.id && r.id === row.id) || !text ? s.rows : [...s.rows, row] }));
  },
  clearStream: () => set({ stream: null }),
  setGame: (game) => set({ game }),
  setRoster: (roster) => set({ roster }),
  setPending: (pending) => set({ pending }),
  setPollHealthy: (pollHealthy) => set({ pollHealthy }),
  removeRow: (clientMsgId) => set((s) => ({ rows: s.rows.filter((r) => !(r.clientMsgId === clientMsgId && r.role === 'user')) })),
  setDraft: (draft) => set({ draft }),
}));
