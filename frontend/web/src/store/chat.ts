// Chat orchestration: boot, send, resume. The only module that talks to the stream endpoints.
import { fetchGameSession, fetchHistory, fetchStreamStatus } from '../api/game';
import { ApiError, setUnauthorizedHandler } from '../api/http';
import { postTurn, resumeRun } from '../api/chatStream';
import { StreamController } from '../stream/controller';
import { useStore } from './gameStore';
import { rowsFromHistory } from './merge';
import { newClientMsgId, pendingFor, releaseSend, trackSend } from './outbox';
import type { ChatRow } from './types';
import { refreshNow } from './poller';

let active: AbortController | null = null;
let sending = false;

function sink() {
  const s = useStore.getState();
  return {
    beginStream: s.beginStream,
    appendStream: s.appendStream,
    setWorking: s.setWorking,
    adoptUserMessage: s.adoptUserMessage,
    commitStream: s.commitStream,
    setPending: s.setPending,
  };
}

async function reconcileFromServer(sessionId: string): Promise<Set<string>> {
  const rows = rowsFromHistory(await fetchHistory(sessionId));
  useStore.getState().reconcileRows(rows);
  return new Set(rows.map((r) => r.clientMsgId).filter((x): x is string => !!x));
}

/** Load the game: the canonical session, its history, then reconcile the outbox and any in-flight run. */
export async function bootstrap(): Promise<void> {
  const st = useStore.getState();
  setUnauthorizedHandler(() => useStore.getState().setAuth('loggedOut'));
  try {
    const sid = await fetchGameSession();
    st.setAuth('ok');
    if (!sid) {
      st.setBoot('noGame');
      return;
    }
    st.setSession(sid);
    const rows = rowsFromHistory(await fetchHistory(sid));
    st.setRows(rows);
    st.setBoot('ready');
    const have = new Set(rows.map((r) => r.clientMsgId).filter((x): x is string => !!x));
    await recoverAfterReload(sid, have);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return; // handler already flipped auth
    st.setBoot('error', e instanceof Error ? e.message : String(e));
  }
}

/** F1: a reload mid-turn. Re-attach to the server's run if it is still going; re-send outbox items the server never saw. */
async function recoverAfterReload(sessionId: string, serverCmids: Set<string>): Promise<void> {
  const todo = pendingFor(sessionId, serverCmids);
  let streaming = false;
  try {
    streaming = (await fetchStreamStatus(sessionId)) === 'streaming';
  } catch {
    streaming = false;
  }
  if (streaming) {
    await attachToRun(sessionId, 0, todo[0]?.clientMsgId ?? null);
    const have = await reconcileFromServer(sessionId);
    pendingFor(sessionId, have);
    return;
  }
  // No live run: anything in the outbox with no server row never landed. Re-send with the SAME clientMsgId
  // (the server dedups on it), one at a time, oldest first.
  for (const item of todo) {
    const row: ChatRow = { key: item.clientMsgId, id: null, seq: null, role: 'user', text: item.text, reasoning: '', clientMsgId: item.clientMsgId, moment: null, state: 'sending' };
    useStore.getState().addLocalRow(row);
    await runTurn(sessionId, item.text, item.clientMsgId);
  }
}

async function attachToRun(sessionId: string, fromSeq: number, clientMsgId: string | null): Promise<void> {
  const ctl = new StreamController(sink(), clientMsgId);
  const ac = new AbortController();
  active = ac;
  try {
    const ok = await resumeRun(sessionId, fromSeq, (ev, isErr) => ctl.handle(ev, isErr), ac.signal);
    if (!ok) ctl.abandon();
  } catch {
    ctl.abandon();
  } finally {
    ctl.finish();
    if (active === ac) active = null;
  }
}

async function runTurn(sessionId: string, text: string, clientMsgId: string): Promise<void> {
  const store = useStore.getState();
  const ctl = new StreamController(sink(), clientMsgId);
  const ac = new AbortController();
  active = ac;
  try {
    await postTurn({ sessionId, message: text, clientMsgId }, (ev, isErr) => ctl.handle(ev, isErr), ac.signal);
    if (ctl.outcome.failed) throw new ApiError(500, 'The turn failed');
    ctl.finish();
    releaseSend(clientMsgId);
  } catch (e) {
    ctl.abandon();
    const refused = e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
    if (refused) {
      // A client-visible refusal: no row was written. Drop the durable copy so a reload cannot resurrect it.
      releaseSend(clientMsgId);
      store.markFailed(clientMsgId);
      store.clearStream();
    } else {
      // Network drop mid-turn: keep the outbox entry. The server run continues; reconcile finds it.
      ctl.finish();
      store.markFailed(clientMsgId);
    }
  } finally {
    if (active === ac) active = null;
    try {
      const have = await reconcileFromServer(sessionId);
      pendingFor(sessionId, have);
    } catch {
      // history read failed; the next load reconciles
    }
    refreshNow();
  }
}

/** Send a player turn. Session-bound, idempotent on clientMsgId, reload-durable. */
export async function sendMessage(text: string): Promise<boolean> {
  const t = text.trim();
  const store = useStore.getState();
  const sid = store.sessionId;
  if (!t || !sid || sending || store.stream) return false;
  sending = true;
  const clientMsgId = newClientMsgId();
  trackSend({ clientMsgId, sessionId: sid, text: t, ts: Date.now() });
  store.addLocalRow({ key: clientMsgId, id: null, seq: null, role: 'user', text: t, reasoning: '', clientMsgId, moment: null, state: 'sending' });
  try {
    await runTurn(sid, t, clientMsgId);
  } finally {
    sending = false;
  }
  return true;
}

export function stopActive(): void {
  const sid = useStore.getState().sessionId;
  active?.abort();
  if (sid) void fetch(`/api/chat/stop/${encodeURIComponent(sid)}`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
}

export const _test = { reconcileFromServer };
