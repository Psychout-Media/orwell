import { useEffect } from 'react';
import { Composer } from './components/Composer';
import { DecisionCard } from './components/DecisionCard';
import { LoggedOut } from './components/LoggedOut';
import { RoomStrip } from './components/RoomStrip';
import { StatusBar } from './components/StatusBar';
import { Transcript } from './components/Transcript';
import { bootstrap } from './store/chat';
import { useStore } from './store/gameStore';
import { startPolling, stopPolling } from './store/poller';
import styles from './App.module.css';

export function App() {
  const auth = useStore((s) => s.auth);
  const boot = useStore((s) => s.boot);
  const error = useStore((s) => s.bootError);

  useEffect(() => {
    void bootstrap();
    startPolling();
    return stopPolling;
  }, []);

  if (auth === 'loggedOut') return <LoggedOut />;
  if (boot === 'loading') return <main className="center-card">Loading your game…</main>;
  if (boot === 'noGame')
    return (
      <main className="center-card" data-testid="no-game">
        <h1>No game in progress</h1>
        <p>Start a new game in the classic UI, then come back here.</p>
        <p>
          <a className="btn-link" href="/">
            Open the classic UI
          </a>
        </p>
      </main>
    );
  if (boot === 'error')
    return (
      <main className="center-card" data-testid="boot-error">
        <h1>Could not load the game</h1>
        <p>{error}</p>
        <p>
          <button className="btn-link" onClick={() => window.location.reload()}>
            Try again
          </button>{' '}
          <a className="btn-link" href="/">
            Open the classic UI
          </a>
        </p>
      </main>
    );
  return (
    <div className={styles.shell}>
      <StatusBar />
      <RoomStrip />
      <Transcript />
      <DecisionCard />
      <Composer />
    </div>
  );
}
