import { useStore } from '../store/gameStore';
import { hueFor, initials } from '../markdown/speakers';
import styles from './RoomStrip.module.css';

function roomLabel(room: string): string {
  return room.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function RoomStrip() {
  const w = useStore((s) => s.game?.whereabouts);
  if (!w || !w.room) return null;
  return (
    <section className={styles.strip} aria-label="Who is in the room" data-testid="room-strip">
      <span className={styles.room}>{roomLabel(w.room)}</span>
      <ul className={styles.list}>
        {w.present.map((p) => (
          <li key={p.id} className={styles.person} title={p.name}>
            <span className={`ow-chip ow-hue-${hueFor(p.id) % 12}`} aria-hidden="true">
              {initials(p.name)}
            </span>
            <span>{p.name}</span>
          </li>
        ))}
        {w.present.length === 0 ? <li className={styles.empty}>Just you.</li> : null}
      </ul>
    </section>
  );
}
