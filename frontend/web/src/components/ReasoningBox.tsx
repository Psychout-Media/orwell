import { memo } from 'react';
import styles from './Message.module.css';

/** Reasoning has its own channel and its own collapsed box. It is never part of the public bubble. */
export const ReasoningBox = memo(function ReasoningBox({ text }: { text: string }) {
  return (
    <details className={styles.reasoning} data-testid="reasoning">
      <summary>Production notes</summary>
      <pre>{text}</pre>
    </details>
  );
});
