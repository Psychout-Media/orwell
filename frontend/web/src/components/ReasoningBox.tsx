import { memo } from 'react';
import { cleanReasoning, reasoningVisible } from '../markdown/render';
import styles from './Message.module.css';

/** Reasoning has its own channel and its own collapsed box. It is never part of the public bubble. */
export const ReasoningBox = memo(function ReasoningBox({ text }: { text: string }) {
  if (!reasoningVisible()) return null; // operator hid it (body.hide-thinking / data-hide-thinking)
  const clean = cleanReasoning(text);
  if (!clean) return null;
  return (
    <details className={styles.reasoning} data-testid="reasoning">
      <summary>Production notes</summary>
      <pre>{clean}</pre>
    </details>
  );
});
