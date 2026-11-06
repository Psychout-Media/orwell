// Per-frame batching. Deltas arrive many times per frame; the store (and so React) is touched at most
// once per animation frame, with everything that arrived since the last frame in one chunk.

export interface Flush {
  reply: string;
  reasoning: string;
}

export interface Scheduler {
  request(cb: () => void): number;
  cancel(id: number): void;
}

const browserScheduler: Scheduler = {
  // rAF is paused in background tabs; fall back to a timer there so a hidden tab still catches up.
  request(cb) {
    if (typeof document !== 'undefined' && document.hidden) return window.setTimeout(cb, 250);
    return requestAnimationFrame(cb);
  },
  cancel(id) {
    cancelAnimationFrame(id);
    clearTimeout(id);
  },
};

export class FrameBatcher {
  private reply = '';
  private reasoning = '';
  private handle: number | null = null;

  constructor(private readonly sink: (f: Flush) => void, private readonly sched: Scheduler = browserScheduler) {}

  add(delta: string, thinking: boolean): void {
    if (thinking) this.reasoning += delta;
    else this.reply += delta;
    if (this.handle === null) this.handle = this.sched.request(() => this.flush());
  }

  /** Push everything pending now (used when the stream settles). */
  flush(): void {
    if (this.handle !== null) {
      this.sched.cancel(this.handle);
      this.handle = null;
    }
    if (!this.reply && !this.reasoning) return;
    const f = { reply: this.reply, reasoning: this.reasoning };
    this.reply = '';
    this.reasoning = '';
    this.sink(f);
  }

  dispose(): void {
    if (this.handle !== null) this.sched.cancel(this.handle);
    this.handle = null;
    this.reply = '';
    this.reasoning = '';
  }
}
