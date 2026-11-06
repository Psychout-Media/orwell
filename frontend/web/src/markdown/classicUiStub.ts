// Stand-in for the classic ui.js, which markdown.js imports only for `esc` (HTML escaping).
const MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export default {
  esc(s: unknown): string {
    return String(s ?? '').replace(/[&<>"']/g, (c) => MAP[c] ?? c);
  },
};
