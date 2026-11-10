import { getJson, postJson } from './http';
import type { GameState, HistoryRow, Pending, RosterEntry } from './types';

export async function fetchGameSession(): Promise<string | null> {
  const r = await getJson<{ sessionId: string | null }>('/api/orwell/game-session');
  return r.sessionId ?? null;
}

export async function fetchHistory(sessionId: string): Promise<HistoryRow[]> {
  const r = await getJson<{ history: HistoryRow[] }>(`/api/history/${encodeURIComponent(sessionId)}`);
  return r.history ?? [];
}

export function fetchState(signal?: AbortSignal): Promise<GameState> {
  return getJson<GameState>('/api/orwell/state', signal);
}

export async function fetchRoster(): Promise<RosterEntry[]> {
  const r = await getJson<{ roster: RosterEntry[] }>('/api/orwell/roster');
  return r.roster ?? [];
}

export async function fetchStreamStatus(sessionId: string): Promise<'streaming' | 'idle'> {
  const r = await getJson<{ status?: string }>(`/api/chat/stream_status/${encodeURIComponent(sessionId)}`);
  return r.status === 'streaming' ? 'streaming' : 'idle';
}

export interface DecisionPayload {
  kind: string;
  choice?: string[];
  use?: boolean;
  save?: string;
  replacement?: string;
  vote?: string;
  statement?: string;
  appeal?: string;
  intent?: string;
  confirmed?: boolean;
  idempotency_key?: string;
}

export const DECISION_TIMEOUT_MS = 30_000;

/** Submit with a bound (N-12): a server that never answers must not wedge Confirm. Retrying is safe (stable idempotency key). */
export function submitDecision(p: DecisionPayload, timeoutMs = DECISION_TIMEOUT_MS): Promise<{ beatSeq?: number }> {
  return Promise.race([
    postJson<{ beatSeq?: number }>('/api/orwell/decision', p),
    new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { timedOut: true })), timeoutMs)),
  ]);
}

/** Stable per-card key so a retried or double-tapped card is a verbatim replay on the server. */
export function decisionKey(p: Pending): string {
  return 'dec:' + p.kind + '|' + (p.options ?? []).map((o) => o.id).join(',') + '|' + (p.prompt ?? '');
}
