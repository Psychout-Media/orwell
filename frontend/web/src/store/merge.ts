import type { HistoryRow } from '../api/types';
import type { ChatRow } from './types';

/** Housekeeping prompts the engine injects as user turns; never the player's own words. */
export function isSkippableUserPrompt(text: string): boolean {
  const t = text.trim();
  return (
    t === 'Continue where you left off' ||
    t.startsWith('Your message was cut off.') ||
    t.startsWith('Your previous response was interrupted.') ||
    t.includes('[Instruction: Rewrite') ||
    t.includes('[Instruction: Explain') ||
    t.toLowerCase().startsWith('(production cue')
  );
}

function rowText(content: HistoryRow['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n').trim();
  return '';
}

/** Server history -> display rows. Drops tool/system rows, housekeeping prompts and empty replies. */
export function rowsFromHistory(history: HistoryRow[]): ChatRow[] {
  const out: ChatRow[] = [];
  history.forEach((h, i) => {
    if (h.role !== 'user' && h.role !== 'assistant') return;
    const raw = rowText(h.content);
    if (h.role === 'user' && isSkippableUserPrompt(raw)) return;
    // Raw text is kept: the renderer scrubs the WHOLE reply (inline <think>, machinery, OOC) before it is split into blocks.
    const text = raw.trim();
    if (!text) return; // never render an empty bubble
    const meta = h.metadata ?? {};
    const id = meta._db_id ?? null;
    const cmid = meta.client_msg_id ?? null;
    out.push({
      key: id ?? cmid ?? `h${i}`,
      id,
      seq: typeof meta._seq === 'number' ? meta._seq : null,
      role: h.role,
      text,
      reasoning: typeof meta.thinking === 'string' ? meta.thinking : '',
      clientMsgId: cmid,
      moment: typeof meta.game_moment === 'string' ? meta.game_moment : null,
      state: 'sent',
    });
  });
  return out.sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));
}

/**
 * Reconcile local rows with a fresh history read. Server rows are truth and are ordered by seq. A local
 * row still waiting on the server (sending/failed) survives, unless the server now has a row carrying
 * its clientMsgId, in which case the server row wins and nothing is doubled.
 */
export function mergeHistory(local: ChatRow[], server: ChatRow[]): ChatRow[] {
  const serverIds = new Set(server.map((r) => r.id).filter((x): x is string => !!x));
  const serverCmids = new Set(server.map((r) => r.clientMsgId).filter((x): x is string => !!x));
  const waiting = local.filter(
    (r) => r.state !== 'sent' && !(r.clientMsgId && serverCmids.has(r.clientMsgId)) && !(r.id && serverIds.has(r.id)),
  );
  return server.concat(waiting);
}
