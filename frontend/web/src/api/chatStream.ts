import { SseParser } from '../stream/sse';
import { ApiError, } from './http';
import type { StreamEvent } from './types';

export type StreamHandler = (ev: StreamEvent | 'DONE', isErrorEvent: boolean) => void;

async function readSse(res: Response, onEvent: StreamHandler, signal: AbortSignal): Promise<void> {
  if (!res.body) throw new ApiError(res.status, 'No response body');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) return;
      for (const item of parser.push(dec.decode(value, { stream: true }))) {
        onEvent(item.data, item.error);
        if (item.data === 'DONE') {
          try {
            await reader.cancel();
          } catch {
            // already closed
          }
          return;
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

export interface SendArgs {
  sessionId: string;
  message: string;
  clientMsgId: string;
}

/** POST /api/chat_stream exactly as the vanilla client does (FormData, same field names, tz headers). */
export async function postTurn(a: SendArgs, onEvent: StreamHandler, signal: AbortSignal): Promise<void> {
  const fd = new FormData();
  fd.append('message', a.message);
  fd.append('session', a.sessionId);
  fd.append('client_msg_id', a.clientMsgId);
  fd.append('mode', 'agent');
  const tzName = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      return '';
    }
  })();
  const res = await fetch('/api/chat_stream', {
    method: 'POST',
    body: fd,
    credentials: 'same-origin',
    headers: { 'X-Tz-Offset': String(-new Date().getTimezoneOffset()), 'X-Tz-Name': tzName },
    signal,
  });
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  await readSse(res, onEvent, signal);
}

/** GET /api/chat/resume/{id}?from_seq= : re-attach to a run the server is still buffering. */
export async function resumeRun(sessionId: string, fromSeq: number, onEvent: StreamHandler, signal: AbortSignal): Promise<boolean> {
  const res = await fetch(`/api/chat/resume/${encodeURIComponent(sessionId)}?from_seq=${fromSeq}`, { credentials: 'same-origin', signal });
  if (!res.ok) return false;
  await readSse(res, onEvent, signal);
  return true;
}
