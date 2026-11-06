// Wire shapes. Only the fields the new front end reads; see docs/design/fe-api-contract.md.

export interface HistoryRow {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
  metadata?: {
    _db_id?: string;
    _seq?: number;
    client_msg_id?: string;
    timestamp?: string;
    game_moment?: string;
    thinking?: string;
    [k: string]: unknown;
  };
}

export interface NamedRef {
  id: string;
  name: string;
}

export interface RosterEntry {
  id: string;
  name: string;
  status: string;
  isPlayer?: boolean;
  portrait?: string | null;
}

export interface PendingOption {
  id: string;
  name?: string;
}

export interface Pending {
  kind: string;
  prompt?: string;
  options?: PendingOption[];
  pick?: number;
  binding?: boolean;
  appeals?: string[];
  stillIn?: NamedRef[];
  round?: number;
  evictee?: NamedRef;
  finalist?: NamedRef;
  offer?: { from?: NamedRef; kind?: string; terms?: string };
  /** Informed-jury brief: what each finalist's jurors said. */
  jurorBrief?: Array<{ finalist?: NamedRef; heard?: string[] }>;
}

export interface Ceremony {
  hoh: NamedRef | string | null;
  nominees: Array<NamedRef | string>;
  veto: { holder: NamedRef | string | null; used: boolean };
}

export interface GameState {
  started: boolean;
  beatSeq?: number;
  week?: number;
  phase?: string;
  moment?: string;
  timeOfDay?: string;
  dayNumber?: number;
  pending?: Pending | null;
  ceremony?: Ceremony;
  whereabouts?: { room: string; present: NamedRef[] } | null;
  finished?: boolean;
  house?: Array<{ id: string; name: string; status: string }>;
  player?: { id: string; name: string };
}

/** One parsed SSE `data:` payload from /api/chat_stream or /api/chat/resume. */
export interface StreamEvent {
  type?: string;
  delta?: string;
  thinking?: boolean;
  id?: string;
  seq?: number;
  clientMsgId?: string;
  role?: string;
  content?: string;
  ts?: string;
  moment?: string;
  runId?: string;
  name?: string;
  stage?: string;
  tool?: string;
  pending?: Pending | null;
  status?: number;
  text?: string;
  error?: { message?: string };
}
