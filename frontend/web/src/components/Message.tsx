import { memo, useMemo } from 'react';
import { renderLive, renderReply } from '../markdown/render';
import type { ChatRow } from '../store/types';
import { Blocks } from './Markdown';
import { ReasoningBox } from './ReasoningBox';
import styles from './Message.module.css';

function joinReasoning(...parts: string[]): string {
  return parts.filter((p) => p.trim()).join('\n\n');
}

export const MessageView = memo(function MessageView({ row }: { row: ChatRow }) {
  const mine = row.role === 'user';
  const rendered = useMemo(() => (mine ? null : renderReply(row.text)), [mine, row.text]);
  const reasoning = joinReasoning(row.reasoning, rendered?.reasoning ?? '');
  // A reply that scrubs down to nothing (all machinery) shows no bubble at all, never an empty one.
  if (!mine && rendered && rendered.blocks.length === 0 && !reasoning) return null;
  return (
    <article className={`${styles.msg} ${mine ? styles.mine : styles.theirs}`} data-testid={mine ? 'msg-user' : 'msg-ai'} data-state={row.state} data-id={row.id ?? ''}>
      {row.moment && !mine ? <div className={styles.moment}>{row.moment}</div> : null}
      {mine || (rendered && rendered.blocks.length > 0) ? (
        <div className={styles.body}>{mine ? <p className={styles.plain}>{row.text}</p> : <Blocks blocks={rendered?.blocks ?? []} />}</div>
      ) : null}
      {reasoning ? <ReasoningBox text={reasoning} /> : null}
      {row.state === 'failed' ? <div className={styles.failed}>Not delivered. It will be retried when you reload.</div> : null}
    </article>
  );
});

export function LiveMessage({ reply, reasoning, working }: { reply: string; reasoning: string; working: string | null }) {
  const rendered = useMemo(() => renderLive(reply), [reply]);
  const allReasoning = joinReasoning(reasoning, rendered.reasoning);
  const hasText = rendered.blocks.length > 0;
  return (
    <article className={`${styles.msg} ${styles.theirs}`} data-testid="msg-live" aria-busy="true">
      <div className={styles.body}>
        {hasText ? <Blocks blocks={rendered.blocks} /> : null}
        {!hasText ? <p className={styles.working}>{working ?? 'Thinking'}...</p> : null}
        {hasText && working ? <p className={styles.working}>{working}...</p> : null}
      </div>
      {allReasoning ? <ReasoningBox text={allReasoning} /> : null}
    </article>
  );
}
