import { useState } from 'react';
import { decisionKey, submitDecision, type DecisionPayload } from '../api/game';
import type { Pending, PendingOption } from '../api/types';
import { useStore } from '../store/gameStore';
import { refreshNow } from '../store/poller';
import styles from './DecisionCard.module.css';

// Mirrors buildPayload / SINGLE_PICK_FIELD in frontend/static/js/orwellDecision.js.
const SINGLE_PICK_FIELD: Record<string, 'vote' | 'replacement'> = {
  'houseguests-choice': 'vote',
  'eviction-vote': 'vote',
  'tie-break': 'vote',
  'final-eviction': 'vote',
  'juror-vote': 'vote',
  'goodbye-message': 'vote',
  'exit-interview': 'vote',
  'spectator-choice': 'vote',
  'finale-interview': 'vote',
  'deal-offer': 'vote',
  replacement: 'replacement',
};
const COMP_INTENTS = ['compete', 'throw', 'play-safe'];
const WITH_TEXT = new Set(['goodbye-message', 'exit-interview', 'finale-interview', 'finale-statement', 'juror-question']);
const TEXT_ONLY = new Set(['finale-statement', 'juror-question']);
const HIGH_STAKES = new Set(['eviction-vote', 'final-eviction', 'juror-vote', 'nominations', 'replacement', 'tie-break', 'veto-decision', 'self-evict']);

export interface Selection {
  sel: string[];
  text: string;
}

export function pickCount(p: Pending): number {
  return p.kind === 'nominations' ? 2 : typeof p.pick === 'number' ? Math.max(1, p.pick) : 1;
}

export function optionsFor(p: Pending): Array<{ value: string; label: string }> {
  const k = p.kind;
  if (k === 'comp-intent' || k === 'comp-round') return COMP_INTENTS.map((i) => ({ value: i, label: i }));
  if (k === 'finale-answer') return (p.appeals ?? []).map((a) => ({ value: String(a), label: String(a) }));
  if (k === 'spectator-choice') {
    const labels: Record<string, string> = { skip: 'Skip ahead to the finale', watch: 'Keep watching (a condensed season)' };
    return (p.options ?? []).map((o) => ({ value: o.id, label: labels[o.id] ?? o.name ?? o.id }));
  }
  if (k === 'veto-decision') return [{ value: '__dont__', label: "Don't use the veto" }, ...(p.options ?? []).map((o: PendingOption) => ({ value: o.id, label: 'Save ' + (o.name ?? o.id) }))];
  if (k === 'secret-veto') return [{ value: '__play__', label: 'Play the secret veto' }, { value: '__hold__', label: 'Hold it' }];
  return (p.options ?? []).map((o) => ({ value: o.id, label: o.name ?? o.id }));
}

/** The wire payload for the current selection, or null while the selection is incomplete. */
export function buildPayload(p: Pending, s: Selection): DecisionPayload | null {
  const kind = p.kind;
  const { sel, text } = s;
  if (kind === 'nominations') return sel.length === 2 ? { kind, choice: sel } : null;
  if (TEXT_ONLY.has(kind)) return { kind, statement: text };
  if (kind === 'goodbye-message' || kind === 'exit-interview' || kind === 'finale-interview') return sel.length === 1 && sel[0] ? { kind, vote: sel[0], statement: text } : null;
  if (kind === 'finale-answer') return sel.length === 1 && sel[0] ? { kind, appeal: sel[0] } : null;
  if (kind === 'comp-intent' || kind === 'comp-round') return sel.length === 1 && sel[0] ? { kind, intent: sel[0] } : null;
  if (kind === 'self-evict') return { kind, confirmed: true };
  if (kind === 'veto-decision') {
    if (sel[0] === '__dont__') return { kind, use: false };
    return sel.length === 1 && sel[0] ? { kind, use: true, save: sel[0] } : null;
  }
  if (kind === 'secret-veto') return sel[0] === '__play__' ? { kind, use: true } : sel[0] === '__hold__' ? { kind, use: false } : null;
  const field = SINGLE_PICK_FIELD[kind];
  if (field && sel.length === 1 && sel[0]) return { kind, [field]: sel[0] };
  return null;
}

// Same cues as prefillCueFor in orwellDecision.js: offered (never auto-sent) after a decision so the narrator narrates the outcome.
const CUES: Record<string, string> = {
  nominations: "I've named my nominees — let's see the room when I say it out loud.",
  'veto-decision': "I've decided on the veto — time to make it official at the ceremony.",
  'finale-statement': "I've made my final case to the jury — let's see how it lands.",
  'juror-question': "I've decided what to ask — let's hear their answer.",
  'finale-answer': "I've cast my jury vote — let's see who takes it.",
  'goodbye-message': "I've recorded my goodbye message — let's see how the house reacts.",
  'exit-interview': "I've given my exit interview — that's my side of it.",
  'spectator-choice': "I've decided how to follow the rest of the season.",
  'finale-interview': "I've given my finale-night interview — that's my side of it.",
  'comp-intent': "I've set my approach for this competition — let's compete.",
  'comp-round': "I'm committing to this round — let's push on.",
  'self-evict': "I've made my choice to walk — let's see how the house takes it.",
};
export function prefillCueFor(kind: string): string {
  return CUES[kind] ?? "I've made my decision — let's see how the house takes it.";
}

/** Context the player must see before a binding choice: who, what offer, which round, what the jurors said. */
export function ContextBlock({ p }: { p: Pending }) {
  const rows: string[] = [];
  if (p.kind === 'juror-question' && p.finalist?.name) rows.push(`Asking: ${p.finalist.name}`);
  if (p.kind === 'goodbye-message' && p.evictee?.name) rows.push(`Saying goodbye: ${p.evictee.name}`);
  if (p.kind === 'comp-round' && typeof p.round === 'number' && p.round > 0) rows.push(`Round ${p.round}`);
  if (p.kind === 'deal-offer' && p.offer) {
    rows.push(`Offer from ${p.offer.from?.name ?? 'a houseguest'}${p.offer.kind ? ` (${p.offer.kind})` : ''}`);
    if (p.offer.terms) rows.push(p.offer.terms);
  }
  if (p.kind === 'juror-vote' && p.jurorBrief?.length) {
    rows.push('What the jurors told you:');
    p.jurorBrief.forEach((b) => rows.push(`${b.finalist?.name ?? ''} — ${(b.heard ?? []).join('; ')}`));
  }
  if (!rows.length) return null;
  return (
    <div className={styles.context} data-testid="decision-context" tabIndex={0} role="region" aria-label="decision details">
      {rows.map((r, i) => (
        <div key={i}>{r}</div>
      ))}
    </div>
  );
}

function title(p: Pending): string {
  const names: Record<string, string> = {
    nominations: 'Nominate two houseguests',
    'veto-decision': 'Use the veto?',
    'secret-veto': 'Secret veto',
    'eviction-vote': 'Cast your eviction vote',
    'comp-intent': 'Competition: set your approach',
    'comp-round': 'Competition round',
    'goodbye-message': 'Say your goodbye',
    'self-evict': 'Leave the game',
    'juror-vote': 'Cast your jury vote',
  };
  return names[p.kind] ?? p.kind.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function DecisionCard() {
  const pending = useStore((s) => s.pending);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  if (!pending || !pending.kind) return null;
  const key = decisionKey(pending);
  if (dismissedKey === key) return null;
  // `key` remounts the form whenever the engine's pending changes, so a stale selection never survives.
  return <Card key={key} pending={pending} onDismiss={() => setDismissedKey(key)} />;
}

function Card({ pending, onDismiss }: { pending: Pending; onDismiss: () => void }) {
  const [sel, setSel] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [err, setErr] = useState('');
  const pick = pickCount(pending);
  const opts = optionsFor(pending);
  const payload = buildPayload(pending, { sel, text });
  const risky = HIGH_STAKES.has(pending.kind);
  const single = pick === 1;

  const toggle = (v: string) =>
    setSel((cur) => {
      if (cur.includes(v)) return cur.filter((x) => x !== v);
      if (single) return [v];
      return cur.length >= pick ? cur : [...cur, v];
    });

  const setDraft = useStore((st) => st.setDraft);
  const confirm = async () => {
    if (!payload) return;
    setState('sending');
    try {
      await submitDecision({ ...payload, idempotency_key: decisionKey(pending) });
      setState('done');
      // The play continues in conversation: offer (never send) a cue so the narrator narrates the outcome.
      setDraft(prefillCueFor(pending.kind));
      refreshNow();
    } catch (e) {
      setState('error');
      const timedOut = !!(e && typeof e === 'object' && 'timedOut' in e);
      const msg = e instanceof Error ? e.message : '';
      setErr(
        timedOut
          ? 'That is taking too long. It may not have reached the house. Tap Confirm to try again (it is safe).'
          : /409/.test(msg)
            ? 'The board moved since this card appeared. Refreshing the latest state.'
            : /400/.test(msg)
              ? "That move isn't legal right now. Pick another, or decide in conversation."
              : "Connection problem. That didn't reach the house. Try again, or decide in conversation.",
      );
      refreshNow();
    }
  };

  if (state === 'done') {
    return (
      <section className={styles.card} data-testid="decision-card" data-done="true">
        <strong>Locked in.</strong>
      </section>
    );
  }
  return (
    <section className={`${styles.card} ${risky ? styles.risk : ''}`} data-testid="decision-card" data-kind={pending.kind} aria-label={title(pending)}>
      <div className={styles.head}>
        <strong>{title(pending)}</strong>
        {risky ? <span className={styles.badge}>Binding. No taking it back.</span> : null}
        <button type="button" className={styles.x} onClick={onDismiss} aria-label="Dismiss and decide in conversation instead">
          ×
        </button>
      </div>
      {pending.prompt ? <p className={styles.prompt}>{pending.prompt}</p> : null}
      <ContextBlock p={pending} />
      {pending.stillIn?.length ? <p className={styles.note}>Still in: {pending.stillIn.map((r) => r.name).join(', ')}</p> : null}
      <div className={styles.opts}>
        {opts.map((o) => (
          <button key={o.value} type="button" className={styles.opt} aria-pressed={sel.includes(o.value)} onClick={() => toggle(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
      {WITH_TEXT.has(pending.kind) ? (
        <textarea className={styles.text} rows={3} aria-label="Your words (optional)" placeholder="Your words (optional)…" value={text} onChange={(e) => setText(e.target.value)} />
      ) : null}
      <div className={styles.row}>
        <span className={styles.note}>{single ? 'Pick one, then confirm.' : `Pick ${pick}, then confirm.`}</span>
        <button type="button" className={styles.confirm} disabled={!payload || state === 'sending'} onClick={() => void confirm()} data-testid="decision-confirm">
          {state === 'sending' ? 'Locking in…' : 'Confirm'}
        </button>
      </div>
      {state === 'error' ? <p className={styles.err}>{err}</p> : null}
    </section>
  );
}
