import { useStore } from '../store/gameStore';
import { refName, statusView } from './format';
import styles from './StatusBar.module.css';

export function StatusBar() {
  const game = useStore((s) => s.game);
  const healthy = useStore((s) => s.pollHealthy);
  const v = statusView(game);
  const hoh = refName(game?.ceremony?.hoh);
  const noms = (game?.ceremony?.nominees ?? []).map(refName).filter((x): x is string => !!x);
  const chips = [v.week, v.day, v.timeOfDay, v.phase].filter((x): x is string => !!x);
  return (
    <header className={styles.bar} data-testid="status-bar">
      <strong className={styles.brand}>Orwell</strong>
      <div className={styles.chips}>
        {chips.map((c) => (
          <span key={c} className={styles.chip}>
            {c}
          </span>
        ))}
        {hoh ? <span className={styles.chip}>HOH: {hoh}</span> : null}
        {noms.length ? <span className={styles.chip}>On the block: {noms.join(', ')}</span> : null}
      </div>
      {!healthy ? <span className={styles.stale}>Reconnecting…</span> : null}
      <a className={styles.link} href="/">
        Full classic UI
      </a>
    </header>
  );
}
