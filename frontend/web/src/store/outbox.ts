// Reload-durable send outbox (CLAUDE.md "send outbox" invariants), per tab: sessionStorage, never
// localStorage (two tabs would double-send). An entry stays until a server row carrying its
// clientMsgId is observed. An entry only ever drains into ITS OWN session.

export interface OutboxItem {
  clientMsgId: string;
  sessionId: string;
  text: string;
  ts: number;
}

const KEY = 'orwell.play.outbox.v1';

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function defaultStore(): KV | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

export function loadOutbox(kv: KV | null = defaultStore()): OutboxItem[] {
  if (!kv) return [];
  try {
    const parsed: unknown = JSON.parse(kv.getItem(KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is OutboxItem =>
        !!x && typeof x === 'object' && typeof (x as OutboxItem).clientMsgId === 'string' && typeof (x as OutboxItem).sessionId === 'string' && typeof (x as OutboxItem).text === 'string',
    );
  } catch {
    return [];
  }
}

function save(items: OutboxItem[], kv: KV | null): void {
  if (!kv) return;
  try {
    kv.setItem(KEY, JSON.stringify(items));
  } catch {
    // Quota or private mode: the in-memory path still works, only reload-durability is lost.
  }
}

export function trackSend(item: OutboxItem, kv: KV | null = defaultStore()): OutboxItem[] {
  const cur = loadOutbox(kv);
  if (cur.some((c) => c.clientMsgId === item.clientMsgId)) return cur;
  const next = [...cur, item];
  save(next, kv);
  return next;
}

export function releaseSend(clientMsgId: string, kv: KV | null = defaultStore()): OutboxItem[] {
  const next = loadOutbox(kv).filter((c) => c.clientMsgId !== clientMsgId);
  save(next, kv);
  return next;
}

/** Items that belong to `sessionId` and have no matching server row yet. Confirmed items are released. */
export function pendingFor(sessionId: string, serverClientMsgIds: Set<string>, kv: KV | null = defaultStore()): OutboxItem[] {
  const all = loadOutbox(kv);
  const keep: OutboxItem[] = [];
  const todo: OutboxItem[] = [];
  for (const it of all) {
    if (it.sessionId === sessionId && serverClientMsgIds.has(it.clientMsgId)) continue; // delivered
    keep.push(it);
    if (it.sessionId === sessionId) todo.push(it);
  }
  if (keep.length !== all.length) save(keep, kv);
  return todo;
}

export function newClientMsgId(): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
  return 'c-' + rnd;
}
