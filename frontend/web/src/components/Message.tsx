import { memo } from 'react';
import type { ChatRow } from '../store/types';
import { Markdown, StreamingMarkdown } from './Markdown';
import { ReasoningBox } from './ReasoningBox';
import styles from './Message.module.css';

export const MessageView = memo(function MessageView({ row }: { row: ChatRow }) {
  const mine = row.role === 'user';
  return (
    <article className={`${styles.msg} ${mine ? styles.mine : styles.theirs}`} data-testid={mine ? 'msg-user' : 'msg-ai'} data-state={row.state} data-id={row.id ?? ''}>
      {row.moment && !mine ? <div className={styles.moment}>{row.moment}</div> : null}
      <div className={styles.body}>{mine ? <p className={styles.plain}>{row.text}</p> : <Markdown text={row.text} />}</div>
      {row.reasoning ? <ReasoningBox text={row.reasoning} /> : null}
      {row.state === 'failed' ? <div className={styles.failed}>Not delivered. It will retry when you reload.</div> : null}
    </article>
  );
});

export function LiveMessage({ reply, reasoning, working }: { reply: string; reasoning: string; working: string | null }) {
  return (
    <article className={`${styles.msg} ${styles.theirs}`} data-testid="msg-live" aria-busy="true">
      <div className={styles.body}>
        <StreamingMarkdown text={reply} />
        {!reply && !reasoning ? <p className={styles.working}>{working ?? 'Thinking'}...</p> : null}
        {!reply && reasoning ? <p className={styles.working}>Thinking...</p> : null}
        {reply && working ? <p className={styles.working}>{working}...</p> : null}
      </div>
      {reasoning ? <ReasoningBox text={reasoning} /> : null}
    </article>
  );
}
