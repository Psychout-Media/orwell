import type { GameState, Pending, RosterEntry } from '../api/types';

export type RowState = 'sent' | 'sending' | 'failed';

export interface ChatRow {
  /** Stable React key: the server id once known, else the clientMsgId. */
  key: string;
  id: string | null;
  seq: number | null;
  role: 'user' | 'assistant';
  /** Public text only. Reasoning never lives here. */
  text: string;
  /** Reasoning channel, shown only in its own collapsible. */
  reasoning: string;
  clientMsgId: string | null;
  moment: string | null;
  state: RowState;
}

export interface LiveStream {
  clientMsgId: string | null;
  /** Public reply text (non-thinking deltas only), appended once per frame. */
  reply: string;
  reasoning: string;
  /** Quiet production-beat label while a tool runs, e.g. "Working". */
  working: string | null;
}

export type AuthState = 'unknown' | 'ok' | 'loggedOut';
export type BootState = 'loading' | 'ready' | 'noGame' | 'error';

export interface PlayState {
  auth: AuthState;
  boot: BootState;
  bootError: string | null;
  sessionId: string | null;
  rows: ChatRow[];
  stream: LiveStream | null;
  // game slice (written only by the shared poller and the stream's orwell_pending event)
  game: GameState | null;
  roster: RosterEntry[];
  pending: Pending | null;
  pollHealthy: boolean;
  /** Text to put back in the composer (a refused send, or the cue after a decision). Consumed by the Composer. */
  draft: string | null;
}
