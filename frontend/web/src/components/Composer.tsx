import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { sendMessage, stopActive } from '../store/chat';
import { useStore } from '../store/gameStore';
import styles from './Composer.module.css';

export function Composer() {
  const [text, setText] = useState('');
  const busy = useStore((s) => s.stream !== null);
  const ready = useStore((s) => s.sessionId !== null);
  const draft = useStore((s) => s.draft);
  const setDraft = useStore((s) => s.setDraft);

  // A refused send, or the cue after a decision, lands here. Never overwrite what the player is already typing.
  useEffect(() => {
    if (draft === null) return;
    setText((cur) => (cur.trim() ? cur : draft));
    setDraft(null);
  }, [draft, setDraft]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim() || busy || !ready) return;
    const t = text;
    setText('');
    void sendMessage(t).then((ok) => {
      if (!ok) setText(t);
    });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <form className={styles.form} onSubmit={submit}>
      <textarea
        className={styles.input}
        aria-label="Say or do something"
        placeholder="Say or do something…"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        disabled={!ready}
      />
      {busy ? (
        <button type="button" className={styles.btn} onClick={stopActive}>
          Stop
        </button>
      ) : (
        <button type="submit" className={styles.btn} disabled={!text.trim() || !ready} data-testid="send">
          Send
        </button>
      )}
    </form>
  );
}
