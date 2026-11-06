// Turns parsed SSE events into store updates. Pure of any network code so it is unit-testable.
//
// Invariants (frontend/static/js/chat.js "Front-end client conventions"):
//  - Only non-thinking deltas feed the public reply. Reasoning has its own buffer and its own box.
//  - Deltas are batched: the store is written at most once per animation frame.
//  - The renderer only ever appends. A later "checked paragraph" event type can call `appendReply`
//    with a whole paragraph; nothing already shown is rewritten.
import type { Pending, StreamEvent } from '../api/types';
import { FrameBatcher, type Scheduler } from './frameBatcher';

export interface StreamSink {
  beginStream(clientMsgId: string | null): void;
  appendStream(reply: string, reasoning: string): void;
  setWorking(label: string | null): void;
  adoptUserMessage(clientMsgId: string, id: string | null, seq: number | null): void;
  commitStream(saved: { id: string | null; moment: string | null }): void;
  setPending(p: Pending | null): void;
}

export interface StreamOutcome {
  sawDone: boolean;
  sawSaved: boolean;
  failed: boolean;
  runId: string | null;
  /** Number of events handled; the resume cursor (`from_seq`) for a self-resume. */
  count: number;
}

const WORKING_LABEL = 'Working';

export class StreamController {
  readonly outcome: StreamOutcome = { sawDone: false, sawSaved: false, failed: false, runId: null, count: 0 };
  private readonly batcher: FrameBatcher;
  private saved: { id: string | null; moment: string | null } = { id: null, moment: null };

  constructor(private readonly sink: StreamSink, clientMsgId: string | null, sched?: Scheduler) {
    this.batcher = new FrameBatcher((f) => this.sink.appendStream(f.reply, f.reasoning), sched);
    this.sink.beginStream(clientMsgId);
  }

  /** Append a whole checked paragraph (future showrunner delivery). Goes through the same batcher. */
  appendReply(text: string): void {
    this.batcher.add(text, false);
  }

  handle(ev: StreamEvent | 'DONE', isErrorEvent = false): void {
    if (ev === 'DONE') {
      this.finish();
      return;
    }
    // run-started and canonical_session do not count toward the resume cursor (they do not replay).
    if (ev.type !== 'run-started' && ev.type !== 'canonical_session') this.outcome.count++;
    if (isErrorEvent || (typeof ev.status === 'number' && ev.status >= 400)) {
      this.outcome.failed = true;
      return;
    }
    if (typeof ev.delta === 'string' && ev.delta) {
      this.batcher.add(ev.delta, !!ev.thinking);
      return;
    }
    switch (ev.type) {
      case 'run-started':
        this.outcome.runId = ev.runId ?? null;
        break;
      case 'user_message':
        if (ev.clientMsgId) this.sink.adoptUserMessage(ev.clientMsgId, ev.id ?? null, typeof ev.seq === 'number' ? ev.seq : null);
        break;
      case 'message_saved':
        this.outcome.sawSaved = true;
        this.saved = { id: ev.id ?? null, moment: ev.moment ?? null };
        break;
      case 'orwell_pending':
        this.sink.setPending(ev.pending && ev.pending.kind ? ev.pending : null);
        break;
      case 'tool_start':
      case 'agent_step':
      case 'status':
        this.sink.setWorking(WORKING_LABEL);
        break;
      default:
        break;
    }
  }

  /** Settle: flush the last partial frame, then turn the live text into a stored row. */
  finish(): void {
    if (this.outcome.sawDone) return;
    this.outcome.sawDone = true;
    this.batcher.flush();
    this.sink.commitStream(this.saved);
  }

  /** Stop without committing (network drop). Keeps what was flushed on screen. */
  abandon(): void {
    this.batcher.flush();
  }
}
