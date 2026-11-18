/**
 * ORW-566 part d / spec 0183 - the retrospective's `groupLife`: the season's alliances and close-pair habits as FACTS, after the crown only.
 * PURE: the CALLER (`GameSessionAdapter.seasonRetrospective`) runs it behind the finished gate (the 0048 sanctioned unsealing, the same door as `yourEdit`),
 * so before the crown nothing exists. Names only (never an id), weeks as plain integers, never a measure. The narrator voices the group live from these facts;
 * `line` is only the composed offline floor (names, the group's name, the room, the weeks), no dealt pool and no list.
 */
export interface GroupLifeRow {
  kind: "alliance" | "pair";
  /** The group's secret name when it had one (sealed or floor), else the name it went by. Absent for a pair with no authored name. */
  name?: string;
  /** What the house was told it was called, when that differs from `name`. */
  knownAs?: string;
  members: string[];
  /** The player was one of the members. */
  youWere: boolean;
  spot?: string;
  ritual?: string;
  signal?: string;
  insideJoke?: string;
  formedWeek?: number;
  endedWeek?: number;
  /** A plain phrase for why it ended; absent while it still stood. */
  endedHow?: string;
  /** The player knew of it while the season ran. */
  youKnew: boolean;
}
export interface GroupLifeEntry extends GroupLifeRow { line: string }
export interface GroupLifeView { groups: GroupLifeEntry[] }

const list = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The offline floor line, composed from the names, the group's name, the room and the weeks only. */
export function groupLifeLine(r: GroupLifeRow): string {
  const who = list(r.members);
  const lead = r.kind === "alliance"
    ? `${who} stood together${r.name ? ` as ${r.name}` : ""}`
    : `${who} kept a habit of their own${r.spot ? ` in ${r.spot}` : ""}${r.name ? `, which they called ${r.name}` : ""}`;
  const formed = r.formedWeek !== undefined ? ` from week ${r.formedWeek}` : "";
  const end = r.endedWeek !== undefined ? `; it ended in week ${r.endedWeek}${r.endedHow ? `, as ${r.endedHow}` : ""}` : "";
  return `${lead}${formed}${end}${r.youKnew ? "" : ", and you never knew"}.`;
}

/** Deterministic: by formed week (unknown last), then the first member's name, then the name. Absent when the season held no group. */
export function buildGroupLife(rows: readonly GroupLifeRow[]): GroupLifeView | undefined {
  if (rows.length === 0) return undefined;
  const groups = rows.map((r) => ({ ...r, line: groupLifeLine(r) }));
  groups.sort((a, b) => (a.formedWeek ?? 1e9) - (b.formedWeek ?? 1e9) || a.members.join("|").localeCompare(b.members.join("|")) || (a.name ?? "").localeCompare(b.name ?? ""));
  return { groups };
}
