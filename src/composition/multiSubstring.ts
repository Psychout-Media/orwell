/**
 * ORW-832: which of many patterns occur in one text, in ONE pass over the text. The integrity checkpoint's vault-leak sweep asked `patterns.some((p) => text.includes(p))`: one scan of the whole player view per hidden line,
 * so a full re-scan cost (hidden lines x view length), and both grow with the season (the per-message cost of a long season grew about forty-fold). This returns exactly the patterns for which `text.includes(p)` is true
 * (code-unit substrings, empty patterns never match). Method: every pattern is filed under a 32-bit hash of its first K code units (K = the shortest pattern's length, at most 16); one rolling hash runs along the text, and a
 * pattern is only compared at the places where the window's hash is filed, so the answer is exact (a hash clash costs one failed comparison, never a wrong answer). Linear in the text plus the patterns. Pure: no I/O.
 */
export function patternsFoundIn(text: string, patterns: Iterable<string>): Set<string> {
  const found = new Set<string>();
  const unique = new Set<string>();
  let k = 16;
  for (const p of patterns) if (p) { unique.add(p); if (p.length < k) k = p.length; }
  if (unique.size === 0 || text.length < k) return found;
  const B = 0x9e3779b1 | 0;
  let top = 1; // B^(k-1): the weight of the code unit that leaves the window
  for (let i = 1; i < k; i++) top = Math.imul(top, B);
  const filed = new Map<number, string[]>();
  for (const p of unique) {
    let h = 0;
    for (let i = 0; i < k; i++) h = (Math.imul(h, B) + p.charCodeAt(i)) | 0;
    const list = filed.get(h);
    if (list) list.push(p); else filed.set(h, [p]);
  }
  let h = 0;
  for (let i = 0; i < k; i++) h = (Math.imul(h, B) + text.charCodeAt(i)) | 0;
  for (let at = 0; ; at++) {
    const list = filed.get(h);
    if (list) for (const p of list) if (!found.has(p) && text.startsWith(p, at)) found.add(p);
    if (at + k >= text.length) break;
    h = (Math.imul((h - Math.imul(text.charCodeAt(at), top)) | 0, B) + text.charCodeAt(at + k)) | 0;
  }
  return found;
}
