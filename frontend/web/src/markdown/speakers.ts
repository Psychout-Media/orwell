// Speaker chips. Port of extractSpeakerTags / restoreSpeakerChips (frontend/static/js/markdown.js).
// Rule: a chip ALWAYS leaves the speaker's name visible. The `@[Name]` tag is machinery and is
// consumed, but the name is given back as visible text unless the narrator already wrote it next.

export interface SpeakerChip {
  id: string | null;
  name: string;
  showName: boolean;
  colon: boolean;
}

export interface ExtractResult {
  text: string;
  chips: SpeakerChip[];
}

const TAG_RE = /^([ \t]*)@\[([^\]\n]{1,80})\](?:\(npc:(\d+)\))?[ \t]*:?[ \t]*/gm;
const TRAILING_PARTIAL_RE = /@\[[^\]\n]{0,80}$/;
const BOLD_LINE_RE = /^([ \t]*)(\*\*([^*\n]{1,80}?)\*\*:?)/gm;
// Placeholders contain no markdown-significant characters (underscores would parse as emphasis).
const PH_OPEN = 'QQOWSPK';
const PH_CLOSE = 'QQ';
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

let knownNames = new Set<string>();

/** Exact (case-insensitive) roster names, used by the bold-name fallback. Fails closed when empty. */
export function setKnownNames(names: Iterable<string>): void {
  knownNames = new Set(Array.from(names, (n) => n.trim().toLowerCase()).filter(Boolean));
}

function codeLineSet(text: string): Set<number> {
  const lines = text.split('\n');
  const code = new Set<number>();
  let fenceChar = '';
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = FENCE_RE.exec(line);
    if (!fenceChar) {
      if (m && m[1]) {
        code.add(i);
        fenceChar = m[1][0] ?? '';
        fenceLen = m[1].length;
      } else if (/^(?: {4}|\t)/.test(line) && line.trim()) {
        code.add(i);
      }
      continue;
    }
    code.add(i);
    if (m && m[1] && m[1][0] === fenceChar && m[1].length >= fenceLen && line.slice(line.indexOf(m[1]) + m[1].length).trim() === '') {
      fenceChar = '';
      fenceLen = 0;
    }
  }
  return code;
}

function lineAt(str: string, offset: number): number {
  let n = 0;
  for (let i = 0; i < offset; i++) if (str.charCodeAt(i) === 10) n++;
  return n;
}

export function extractSpeakerTags(text: string): ExtractResult {
  if (!text) return { text, chips: [] };
  const chips: SpeakerChip[] = [];
  const src = String(text);
  const code = codeLineSet(src);
  let out = src.replace(TAG_RE, (...args: unknown[]) => {
    const m = args[0] as string;
    const lead = args[1] as string | undefined;
    const name = args[2] as string | undefined;
    const id = args[3] as string | undefined;
    const offset = args[4] as number;
    if (code.has(lineAt(src, offset))) return m;
    const nm = String(name ?? '').trim();
    if (!nm) return m;
    const after = src.slice(offset + m.length, offset + m.length + nm.length + 4).replace(/^[*_]+/, '').toLowerCase();
    chips.push({ id: id ? 'npc:' + id : null, name: nm, showName: !after.startsWith(nm.toLowerCase()), colon: /:[ \t]*$/.test(m) });
    return (lead ?? '') + PH_OPEN + (chips.length - 1) + PH_CLOSE + ' ';
  });
  out = out.replace(TRAILING_PARTIAL_RE, '');
  if (knownNames.size) {
    out = out.replace(BOLD_LINE_RE, (...args: unknown[]) => {
      const m = args[0] as string;
      const lead = args[1] as string | undefined;
      const boldRun = args[2] as string;
      const raw = args[3] as string | undefined;
      const offset = args[4] as number;
      if (codeLineSet(out).has(lineAt(out, offset))) return m;
      const nm = String(raw ?? '').trim().replace(/:$/, '').trim();
      if (!nm || !knownNames.has(nm.toLowerCase())) return m;
      // The bold run is kept; the name is already visible, so the chip adds only the face.
      chips.push({ id: null, name: nm, showName: false, colon: false });
      return (lead ?? '') + PH_OPEN + (chips.length - 1) + PH_CLOSE + ' ' + boldRun;
    });
  }
  // A tag alone on its line anchors forward onto the speech it introduces.
  out = out.replace(/(QQOWSPK\d+QQ)[ \t]*\n\s*(?=\S)/g, '$1 ');
  return { text: out, chips };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? '?';
  const b = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (a + b).toUpperCase();
}

export function hueFor(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

export function chipHtml(c: SpeakerChip): string {
  const hue = hueFor(c.id ?? c.name);
  const face = `<span class="ow-chip ow-hue-${hue % 12}" title="${escapeHtml(c.name)}" aria-hidden="true">${escapeHtml(initials(c.name))}</span>`;
  const label = c.showName ? `<strong class="ow-speaker-name">${escapeHtml(c.name)}</strong>${c.colon ? ':' : ''} ` : '';
  return face + label;
}

/** Swap the inert placeholders in rendered HTML for chips. A placeholder that leads a paragraph makes it a speaker line. */
export function restoreSpeakerChips(html: string, chips: SpeakerChip[]): string {
  if (!html || !chips.length) return html;
  const chipFor = (i: string): string => {
    const c = chips[Number(i)];
    return c ? chipHtml(c) : '';
  };
  let out = html.replace(/<p>(\s*)QQOWSPK(\d+)QQ[ \t]*/g, (_m, _ws: string, i: string) => `<p class="ow-speaker-line">${chipFor(i)}`);
  out = out.replace(/QQOWSPK(\d+)QQ[ \t]*/g, (_m, i: string) => chipFor(i));
  return out;
}
