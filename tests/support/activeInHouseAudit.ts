import { playSeason } from "./whatFired/player";

/**
 * ORW-1084 / ORW-1085 / ORW-1086: the audit-A7 invariant, as a reader over a PLAYED season. It writes no engine state: it wraps the event store's `record` with a pass-through that reads the
 * live eviction order AT THE MOMENT each event is recorded, and flags each event that lets a houseguest who has already left the house act or witness in it.
 * Not house-social events, so skipped: the public broadcast (`house-event`, the `season:` record), the departure beats (eviction, exit, goodbye), the diary room, and the finale night (the jury is in the room). A battle-back returnee leaves the eviction order
 * the moment they return, so they count as a houseguest again from then on.
 */
export type HitKind = "juror-with-active" | "pre-jury-evictee" | "out-player-with-house";
export interface Hit { seed: number; msg: number; id: string; type: string; kind: HitKind; who: string[]; content: string }
export interface AuditRow { seed: number; finished: boolean; messages: number; events: number; jurorWithActive: number; preJuryEvictee: number; outPlayer: number; hits: Hit[] }

const SKIP_TYPE = /evict|exit|goodbye|finale|diary|confessional|jury|vote|ceremony|reveal|crown|winner|spectator|farewell|retrospective/i;
const DEPARTURE = /goodbye message|exit interview|leaves the house/;

export async function auditSeason(seed: number, opts: { survive?: boolean; maxMessages?: number; user?: string; setup?: (sess: any) => void } = {}): Promise<AuditRow> {
  const hits: Hit[] = [];
  const row: AuditRow = { seed, finished: false, messages: 0, events: 0, jurorWithActive: 0, preJuryEvictee: 0, outPlayer: 0, hits };
  let wrapped = false;
  let msgNow = 0;
  const rec = await playSeason({
    seed, user: opts.user ?? `a7-${seed}`, survive: opts.survive ?? false, maxMessages: opts.maxMessages ?? 4000,
    ...(opts.setup ? { setup: opts.setup } : {}),
    watch: ({ sess, engine, msg }) => {
      msgNow = msg;
      if (wrapped) return false;
      wrapped = true;
      const store = engine.events;
      const original = store.record.bind(store);
      store.record = (e: any): any => {
        row.events++;
        try {
          const order: string[] = sess.live?.evictionOrder ?? [];
          const start: number = sess.juryStartIndex();
          const evictee: string | undefined = sess.live?.evictee;
          const departing = (id: string): boolean => id === evictee && !(sess.live?.weekDigests ?? []).some((d: any) => d.evictee === id); // the evictee on their own eviction night is still part of that beat
          const playerId: string = sess.house.player.id;
          const finaleNight = sess.live?.finished === true || ["final-eviction", "finale", "finale-reveal", "finale-result", "complete"].includes(String(sess.live?.beat));
          if (!finaleNight && !SKIP_TYPE.test(String(e.type)) && e.type !== "house-event" && !String(e.id).startsWith("season:") && !DEPARTURE.test(String(e.content))) {
            const members: string[] = [...new Set<string>([e.initiator, ...(e.witnessSet ?? [])])];
            const outNpc = members.filter((i) => i !== playerId && order.indexOf(i) >= 0 && !departing(i));
            const preJury = outNpc.filter((i) => order.indexOf(i) < start);
            const jurors = outNpc.filter((i) => order.indexOf(i) >= start);
            const housemates = members.filter((i) => i !== playerId && (order.indexOf(i) < 0 || departing(i)));
            const playerOut = members.includes(playerId) && order.includes(playerId) && !departing(playerId);
            let kind: HitKind | undefined;
            if (preJury.length) kind = "pre-jury-evictee";
            else if (jurors.length && housemates.length) kind = "juror-with-active";
            else if (playerOut && housemates.length) kind = "out-player-with-house";
            if (kind && process.env.A7_STACK && e.type === "gossip") console.log("AUDIT-STACK", e.id, new Error().stack?.split("\n").slice(2, 9).join(" | "));
            if (kind) {
              if (kind === "pre-jury-evictee") row.preJuryEvictee++; else if (kind === "juror-with-active") row.jurorWithActive++; else row.outPlayer++;
              if (hits.length < 600) hits.push({ seed, msg: msgNow, id: String(e.id), type: String(e.type), kind, who: [...outNpc, ...(playerOut ? [playerId] : [])], content: String(e.content).slice(0, 90) });
            }
          }
        } catch { /* a read must never change the game */ }
        return original(e);
      };
      return false;
    },
  });
  row.finished = rec.finished; row.messages = rec.messages;
  return row;
}
