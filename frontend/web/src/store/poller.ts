// ONE shared reader for everything the HUD shows. Panels subscribe to the store; none fetches on its own.
// Cadence: BASE_MS while healthy, doubling to MAX_MS on failures, paused while the tab is hidden, and an
// immediate refresh (debounced) after a turn settles or a decision is submitted.
// Today this reads /api/orwell/state (status + room + pending in one request) and /api/orwell/roster only
// when the cast changes. The next iteration replaces the timer with server-pushed deltas
// (docs/design/fe-api-contract.md, "Live updates").
import { fetchRoster, fetchState } from '../api/game';
import { useStore } from './gameStore';
import { setRoster as setRenderRoster } from '../markdown/render';

export const BASE_MS = 20_000;
export const MAX_MS = 120_000;

let timer: number | null = null;
let failures = 0;
let inFlight = false;
let started = false;
let rosterSig = '';
let ac: AbortController | null = null;
let debounce: number | null = null;

export function nextDelay(fails: number): number {
  return Math.min(MAX_MS, BASE_MS * 2 ** Math.max(0, fails));
}

function castSig(house: Array<{ id: string; status: string }> | undefined): string {
  return (house ?? []).map((h) => `${h.id}:${h.status}`).join(',');
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  ac = new AbortController();
  const store = useStore.getState();
  try {
    const g = await fetchState(ac.signal);
    store.setGame(g);
    store.setPending(g.pending && g.pending.kind ? g.pending : null);
    failures = 0;
    store.setPollHealthy(true);
    const sig = castSig(g.house);
    if (sig && sig !== rosterSig) {
      rosterSig = sig;
      const roster = await fetchRoster();
      store.setRoster(roster);
      setRenderRoster(roster.filter((r) => !r.isPlayer));
    }
  } catch {
    failures++;
    store.setPollHealthy(false);
  } finally {
    inFlight = false;
    schedule();
  }
}

function schedule(): void {
  if (!started) return;
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  if (document.hidden) return; // a hidden tab polls nothing; visibilitychange resumes
  timer = window.setTimeout(() => void tick(), nextDelay(failures));
}

function onVisibility(): void {
  if (!document.hidden && started) void tick();
}

export function startPolling(): void {
  if (started) return;
  started = true;
  document.addEventListener('visibilitychange', onVisibility);
  void tick();
}

export function stopPolling(): void {
  started = false;
  if (timer !== null) window.clearTimeout(timer);
  if (debounce !== null) window.clearTimeout(debounce);
  timer = debounce = null;
  ac?.abort();
  document.removeEventListener('visibilitychange', onVisibility);
}

/** Coalesced "something changed" nudge (turn settled, decision submitted). */
export function refreshNow(): void {
  if (!started) return;
  if (debounce !== null) window.clearTimeout(debounce);
  debounce = window.setTimeout(() => {
    debounce = null;
    failures = 0;
    void tick();
  }, 250);
}
