import { useLayoutEffect, useRef } from 'react';
import { useStore } from '../store/gameStore';
import { LiveMessage, MessageView } from './Message';
import styles from './Transcript.module.css';

const STICK_PX = 80;

export function Transcript() {
  const rows = useStore((s) => s.rows);
  const stream = useStore((s) => s.stream);
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [rows, stream]);

  return (
    <div className={styles.scroll} ref={ref} onScroll={onScroll} role="log" aria-live="polite" aria-label="Story" data-testid="transcript">
      <div className={styles.inner}>
        {rows.map((r) => (
          <MessageView key={r.key} row={r} />
        ))}
        {stream ? <LiveMessage reply={stream.reply} reasoning={stream.reasoning} working={stream.working} /> : null}
      </div>
    </div>
  );
}
